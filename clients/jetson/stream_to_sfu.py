#!/usr/bin/env python3
"""Jetson の USB カメラ映像を SFU ハブへ H.264 RTP で送出する。

  USBカメラ → (MJPEG/raw 自動判定) → NVENC (nvv4l2h264enc)
           → RTP/UDP → mediasoup PlainTransport(comedia) → 全視聴者へ WebRTC

JetPack 標準の python3 と GStreamer だけで動く（jq / curl / v4l-utils 不要）。
追加パッケージが要らないので sudo も不要。
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request

HUB   = os.environ.get("SFU_HUB_URL", "http://sfu-hub.local:8080").rstrip("/")
ROOM  = os.environ.get("SFU_ROOM_ID", "secretary-cam")
NAME  = os.environ.get("SFU_INGEST_NAME", "jetson")
DISP  = os.environ.get("SFU_DISPLAY_NAME", "Jetson Xavier NX")

DEV     = os.environ.get("CAM_DEVICE", "/dev/video0")
WIDTH   = int(os.environ.get("CAM_WIDTH", "1280"))
HEIGHT  = int(os.environ.get("CAM_HEIGHT", "720"))
FPS     = int(os.environ.get("CAM_FPS", "30"))
# ハブ(Pi 3)の Ethernet が 100Mbps 上限で、視聴者数ぶん出ていく。
# ここを上げるとハブ側の帯域が先に飽和する。
BITRATE = int(os.environ.get("CAM_BITRATE", "4000000"))
# 送出解像度。未指定ならキャプチャ解像度のまま。
# Cam Link のようにキャプチャが4K固定の機器では、ここで縮小して
# ハブ(Pi 3 / 100Mbps)の帯域に見合ったサイズにする。
OUT_W = int(os.environ.get("OUT_WIDTH", str(WIDTH)))
OUT_H = int(os.environ.get("OUT_HEIGHT", str(HEIGHT)))
# raw のピクセル形式（機器が NV12 と I420 の両方を出す場合の指定）
RAW_FMT = os.environ.get("CAM_RAW_FORMAT", "NV12")

# router の profile-level-id → nvv4l2h264enc の profile 値
# 42=Constrained Baseline, 4d=Main, 64=High
ENC_PROFILE = {"42": (0, "Constrained Baseline"), "4d": (2, "Main"), "64": (4, "High")}

# ハブ側の ingest 生存確認の間隔（秒）
HEALTH_INTERVAL = int(os.environ.get("HEALTH_INTERVAL", "20"))


def ingest_alive() -> bool:
    """ハブに自分の ingest がまだ登録されているか"""
    try:
        with urllib.request.urlopen(f"{HUB}/api/ingest/status", timeout=6) as r:
            data = json.loads(r.read().decode())
        return any(x.get("name") == NAME and x.get("roomId") == ROOM
                   for x in data.get("ingests", []))
    except Exception:
        # ハブに繋がらない時は「消えた」と判断して張り直させる
        return False


def log(msg):
    print(f"[stream-to-sfu] {msg}", flush=True)


def post_json(url, payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode())


def camera_supports_mjpeg(dev):
    """対象デバイスが MJPEG を出せるかを判定する。

    gst-device-monitor の出力は "Device found:" 区切りだが、その中で
    device.path が caps より後に来るため、区切りで分割して判定すると
    別デバイスの caps を読んでしまう（実際に Cam Link を MJPEG と誤判定し、
    ネゴシエーションに失敗して配信が止まった）。

    v4l2-ctl があればそれで直接引く。無ければ device.path の直前までを
    そのデバイスのブロックとみなして判定する。
    """
    real = os.path.realpath(dev)

    if shutil.which("v4l2-ctl"):
        try:
            out = subprocess.run(["v4l2-ctl", "-d", real, "--list-formats"],
                                 capture_output=True, text=True, timeout=15).stdout
            return "MJPG" in out.upper()
        except Exception as e:
            log(f"v4l2-ctl での判定に失敗、gst で代替する: {e}")

    try:
        out = subprocess.run(["gst-device-monitor-1.0", "Video/Source"],
                             capture_output=True, text=True, timeout=25).stdout
    except Exception as e:
        log(f"デバイス情報の取得に失敗（rawとして扱う）: {e}")
        return False

    # device.path 行を見つけ、そこから直前の "Device found:" までを遡って
    # そのデバイスのブロックとする
    lines = out.splitlines()
    for i, line in enumerate(lines):
        if "device.path" in line and (real in line or dev in line):
            start = 0
            for j in range(i, -1, -1):
                if "Device found:" in lines[j]:
                    start = j
                    break
            return any("image/jpeg" in l for l in lines[start:i + 1])
    return False


def main() -> int:
    if not os.path.exists(DEV):
        log(f"カメラが見つかりません: {DEV}")
        sys.exit(1)

    log(f"ingest を要求: {HUB} (room={ROOM} name={NAME})")
    res = post_json(f"{HUB}/api/ingest/start",
                    {"roomId": ROOM, "name": NAME, "displayName": DISP})
    if not res.get("ok"):
        log(f"ingest 失敗: {res}")
        sys.exit(1)

    ip, port = res["ip"], res["port"]
    pt, ssrc = res["payloadType"], res["ssrc"]
    pli = str(res.get("profileLevelId") or "42e01f")
    prof_val, prof_name = ENC_PROFILE.get(pli[:2].lower(), (0, "Baseline(既定)"))

    log(f"送り先: {ip}:{port}  pt={pt} ssrc={ssrc}")
    log(f"プロファイル: {pli} → {prof_name} (profile={prof_val})")

    mjpeg = camera_supports_mjpeg(DEV)
    scale = "" if (OUT_W, OUT_H) == (WIDTH, HEIGHT) else f" → {OUT_W}x{OUT_H} に縮小"
    log(f"入力: {'MJPEG' if mjpeg else 'raw ' + RAW_FMT} {WIDTH}x{HEIGHT}@{FPS}{scale}")

    if mjpeg:
        # MJPEG はデコード後に videoconvert が要る
        src = [f"v4l2src device={DEV} io-mode=2", "!",
               f"image/jpeg,width={WIDTH},height={HEIGHT},framerate={FPS}/1", "!",
               "jpegdec", "!", "videoconvert"]
    else:
        # raw は nvvidconv が直接受けられる。4K で videoconvert を挟むと
        # CPU 変換になって全く間に合わないので通さないこと。
        src = [f"v4l2src device={DEV} io-mode=2", "!",
               f"video/x-raw,format={RAW_FMT},width={WIDTH},height={HEIGHT},framerate={FPS}/1"]

    gop = FPS * 2
    pipeline = src + [
        "!", "nvvidconv",
        "!", f"video/x-raw(memory:NVMM),format=NV12,width={OUT_W},height={OUT_H}",
        "!", "nvv4l2h264enc",
        f"bitrate={BITRATE}",
        f"profile={prof_val}",
        # これが無いと後から入った視聴者が SPS/PPS を受け取れず映像が出ない
        "insert-sps-pps=1",
        f"iframeinterval={gop}", f"idrinterval={gop}",
        "maxperf-enable=1", "preset-level=1", "control-rate=1",
        "!", "h264parse",
        "!", f"rtph264pay pt={pt} ssrc={ssrc} config-interval=1 mtu=1200",
        "!", f"udpsink host={ip} port={port} sync=false async=false",
    ]

    # gst_parse_launchv は argv の1要素を1トークンとして扱うため、
    # スペースを含む要素をそのまま渡すと "syntax error" になる。
    # 単語ごとに分割してから渡すこと。
    flat = [tok for part in pipeline for tok in part.split(" ") if tok]
    cmd = ["gst-launch-1.0", "-e"] + flat
    log("起動: " + " ".join(cmd))

    # ハブが再起動すると PlainTransport が消えるが、UDP 送出は fire-and-forget
    # なので gst-launch は何も気づかず送り続ける（プロセスが終了しないので
    # systemd の Restart=always も効かない）。ingest が生きているか定期的に
    # 確認し、消えていたら自分から終了して再登録させる。
    proc = subprocess.Popen(cmd)
    try:
        while True:
            time.sleep(HEALTH_INTERVAL)
            if proc.poll() is not None:
                log(f"gst-launch が終了 (rc={proc.returncode})")
                return proc.returncode
            if not ingest_alive():
                log("ハブ側の ingest が消えたので再登録する")
                proc.terminate()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
                return 1
    except KeyboardInterrupt:
        proc.terminate()
        return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
