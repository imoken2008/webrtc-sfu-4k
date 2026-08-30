#!/usr/bin/env python3
"""接続されている全カメラを検出し、それぞれを SFU ハブへ配信する supervisor。

カメラごとに stream_to_sfu.py を1本ずつ起動し、ダッシュボードのグリッドに
台数ぶんのタイルを並べる。抜き差しは定期スキャンで検知し、増えたら起動、
消えたら停止する。

1台のカメラが複数の /dev/videoN を持つ点に注意（実測）:
  BRIO    index0=YUYV/MJPG/NV12(本命)  index2=GREY(赤外)  index1,3=メタデータ
  CamLink index0=NV12(本命)            index1=メタデータ
そのため by-id のプレフィクスで物理カメラを束ね、映像として使えるノードを
1つだけ選ぶ。GREY のみのノード（Windows Hello 用の赤外センサ等）は除外する。
"""
import os
import re
import select
import signal
import subprocess
import sys
import time

BY_ID = "/dev/v4l/by-id"
# 保険としての再スキャン間隔。udev イベントで即座に反応するので、
# ここは「イベントを取りこぼした場合の最後の砦」でしかない。
SCAN_INTERVAL = int(os.environ.get("SCAN_INTERVAL", "300"))
STREAMER = os.environ.get("STREAMER", os.path.expanduser("~/stream_to_sfu.py"))

# 映像として使える形式。GREY は赤外センサなので配信対象から外す。
USABLE_FORMATS = ("MJPG", "YUYV", "NV12", "UYVY", "YU12", "H264")

# 送出解像度の上限。これを超える入力はハードウェアで縮小する。
MAX_OUT_W = int(os.environ.get("MAX_OUT_WIDTH", "1920"))
MAX_OUT_H = int(os.environ.get("MAX_OUT_HEIGHT", "1080"))
BITRATE = os.environ.get("CAM_BITRATE", "6000000")
FPS = os.environ.get("CAM_FPS", "30")
# 落ちたストリーマを拾い直すまでの待ち。カメラ再接続直後は
# デバイスの準備が終わっておらず、すぐ再試行しても また落ちる。
RETRY_DELAY = int(os.environ.get("RETRY_DELAY", "5"))
# 死活監視の間隔（udev イベントが無くてもこの間隔で見に行く）
HEALTH_POLL = int(os.environ.get("HEALTH_POLL", "5"))


def log(msg):
    print(f"[all-cameras] {msg}", flush=True)


def run(cmd, timeout=15):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout
    except Exception:
        return ""


def node_formats(dev):
    """そのノードが出せる (形式, [(w,h)]) を返す"""
    out = run(["v4l2-ctl", "-d", dev, "--list-formats-ext"])
    formats, cur = {}, None
    for line in out.splitlines():
        m = re.search(r"\[\d+\]:\s*'([A-Z0-9 ]{4})'", line)
        if m:
            cur = m.group(1).strip()
            formats[cur] = []
            continue
        m = re.search(r"Size:\s*Discrete\s+(\d+)x(\d+)", line)
        if m and cur:
            formats[cur].append((int(m.group(1)), int(m.group(2))))
    return formats


def card_name(dev):
    out = run(["v4l2-ctl", "-d", dev, "--all"])
    m = re.search(r"Card type\s*:\s*(.+)", out)
    return m.group(1).strip() if m else os.path.basename(dev)


def discover():
    """物理カメラごとに、配信に使うノードと設定を1つ決める"""
    if not os.path.isdir(BY_ID):
        return {}

    groups = {}
    for link in sorted(os.listdir(BY_ID)):
        m = re.match(r"(.+)-video-index(\d+)$", link)
        if not m:
            continue
        groups.setdefault(m.group(1), []).append(
            (int(m.group(2)), os.path.join(BY_ID, link))
        )

    cams = {}
    for prefix, nodes in groups.items():
        for _idx, link in sorted(nodes):
            real = os.path.realpath(link)
            fmts = node_formats(real)
            usable = {f: s for f, s in fmts.items() if f in USABLE_FORMATS and s}
            if not usable:
                continue  # メタデータ専用や GREY のみのノードは飛ばす

            # MJPEG があれば優先（USB帯域が軽い）。無ければ raw。
            fmt = "MJPG" if "MJPG" in usable else sorted(usable)[0]
            sizes = sorted(usable[fmt], key=lambda wh: wh[0] * wh[1], reverse=True)

            # 上限以下で最大のものを取り込む。全部が上限超えなら最小を取って縮小する。
            fit = [s for s in sizes if s[0] <= MAX_OUT_W and s[1] <= MAX_OUT_H]
            cap_w, cap_h = fit[0] if fit else sizes[-1]
            out_w = min(cap_w, MAX_OUT_W)
            out_h = min(cap_h, MAX_OUT_H)

            name = re.sub(r"[^a-zA-Z0-9]+", "-", prefix).strip("-").lower()[:40]
            cams[name] = {
                "link": link,
                "display": card_name(real),
                "cap": (cap_w, cap_h),
                "out": (out_w, out_h),
                "fmt": fmt,
            }
            break  # この物理カメラは1ノードだけ使う
    return cams


class Streamer:
    def __init__(self, name, info):
        self.name, self.info = name, info
        env = dict(os.environ)
        env.update({
            "CAM_DEVICE": info["link"],
            "CAM_WIDTH": str(info["cap"][0]),
            "CAM_HEIGHT": str(info["cap"][1]),
            "OUT_WIDTH": str(info["out"][0]),
            "OUT_HEIGHT": str(info["out"][1]),
            "CAM_FPS": FPS,
            "CAM_BITRATE": BITRATE,
            "SFU_INGEST_NAME": name,
            "SFU_DISPLAY_NAME": info["display"],
        })
        cw, ch = info["cap"]
        ow, oh = info["out"]
        scale = "" if (cw, ch) == (ow, oh) else f" → {ow}x{oh}"
        log(f"起動: {info['display']} [{name}] {info['fmt']} {cw}x{ch}{scale}")
        self.proc = subprocess.Popen([sys.executable, STREAMER], env=env)

    def alive(self):
        return self.proc.poll() is None

    def stop(self):
        log(f"停止: {self.info['display']} [{self.name}]")
        try:
            self.proc.terminate()
            self.proc.wait(timeout=10)
        except Exception:
            try:
                self.proc.kill()
            except Exception:
                pass


def udev_monitor():
    """udev の video4linux イベントを待ち受ける。

    ポーリングだと最大 SCAN_INTERVAL 秒の遅れが出るので、カーネルからの
    通知で即座に反応する。udevadm が使えない環境では None を返し、
    呼び出し側がポーリングのみにフォールバックする。
    """
    try:
        return subprocess.Popen(
            ["udevadm", "monitor", "--udev", "--subsystem-match=video4linux"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1,
        )
    except FileNotFoundError:
        log("udevadm が無いためポーリングのみで動作する")
        return None


def reconcile(running):
    """検出結果と起動中のプロセスを突き合わせる"""
    cams = discover()

    for name in list(running):
        if name not in cams:
            running.pop(name).stop()               # カメラが抜かれた
        elif not running[name].alive():
            # 落ちたものはこの場で起動し直す。次の udev イベントを待つと
            # 何も起きないまま止まったままになる（実際にそうなった）。
            log(f"落ちていたので起動し直す: {name}")
            running.pop(name)

    for name, info in cams.items():
        if name not in running:
            running[name] = Streamer(name, info)
    return cams


def main():
    running = {}
    mon = udev_monitor()

    def shutdown(*_):
        for s in running.values():
            s.stop()
        if mon:
            mon.terminate()
        sys.exit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    mode = "udev イベント駆動" if mon else "ポーリングのみ"
    log(f"監視開始（{mode} / 保険の再スキャン {SCAN_INTERVAL}秒 / "
        f"送出上限 {MAX_OUT_W}x{MAX_OUT_H} @ {BITRATE}bps）")

    cams = reconcile(running)
    if not cams:
        log("カメラが1台も見つからない")

    last_scan = time.time()
    while True:
        triggered = False

        if mon:
            # イベントが来るまで待つ。保険の再スキャン時刻までをタイムアウトにする。
            # 死活監視を回すため、待ち時間は長くても HEALTH_POLL に抑える
            remain = min(HEALTH_POLL,
                         max(1.0, SCAN_INTERVAL - (time.time() - last_scan)))
            r, _, _ = select.select([mon.stdout], [], [], remain)
            if r:
                line = mon.stdout.readline()
                if not line:                       # udevadm が死んだ
                    log("udev 監視が止まったので再起動する")
                    mon = udev_monitor()
                    continue
                if "video4linux" in line:
                    # add/remove の直後はデバイスノードが揃っていないことがあるので
                    # 少し待ってから、連続イベントをまとめて処理する
                    time.sleep(1.5)
                    while select.select([mon.stdout], [], [], 0.5)[0]:
                        if not mon.stdout.readline():
                            break
                    log(f"udev: {line.split()[-1] if line.split() else line.strip()}")
                    triggered = True
        else:
            time.sleep(min(5, SCAN_INTERVAL))

        # 落ちたストリーマがあれば、イベントを待たずに拾い直す。
        # カメラ再接続の直後はデバイスの準備が間に合わず
        # "not-negotiated" で落ちることがあるため、ここが無いと
        # そのカメラだけ止まったままになる。
        dead = [n for n, st in running.items() if not st.alive()]
        if dead:
            log(f"停止中のストリーマを検出: {', '.join(dead)}")
            time.sleep(RETRY_DELAY)
            triggered = True

        if triggered or (time.time() - last_scan) >= SCAN_INTERVAL:
            reconcile(running)
            last_scan = time.time()


if __name__ == "__main__":
    main()
