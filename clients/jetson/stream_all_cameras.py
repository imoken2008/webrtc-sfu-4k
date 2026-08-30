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
import signal
import subprocess
import sys
import time

BY_ID = "/dev/v4l/by-id"
SCAN_INTERVAL = int(os.environ.get("SCAN_INTERVAL", "15"))
STREAMER = os.environ.get("STREAMER", os.path.expanduser("~/stream_to_sfu.py"))

# 映像として使える形式。GREY は赤外センサなので配信対象から外す。
USABLE_FORMATS = ("MJPG", "YUYV", "NV12", "UYVY", "YU12", "H264")

# 送出解像度の上限。これを超える入力はハードウェアで縮小する。
MAX_OUT_W = int(os.environ.get("MAX_OUT_WIDTH", "1920"))
MAX_OUT_H = int(os.environ.get("MAX_OUT_HEIGHT", "1080"))
BITRATE = os.environ.get("CAM_BITRATE", "6000000")
FPS = os.environ.get("CAM_FPS", "30")


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


def main():
    running = {}

    def shutdown(*_):
        for s in running.values():
            s.stop()
        sys.exit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    log(f"監視開始（{SCAN_INTERVAL}秒間隔 / 送出上限 {MAX_OUT_W}x{MAX_OUT_H} @ {BITRATE}bps）")
    while True:
        cams = discover()

        for name in list(running):
            if name not in cams:
                running.pop(name).stop()          # カメラが抜かれた
            elif not running[name].alive():
                log(f"再起動: {name}")
                running.pop(name)                  # 落ちたので次のループで起動し直す

        for name, info in cams.items():
            if name not in running:
                running[name] = Streamer(name, info)

        if not cams:
            log("カメラが1台も見つからない")
        time.sleep(SCAN_INTERVAL)


if __name__ == "__main__":
    main()
