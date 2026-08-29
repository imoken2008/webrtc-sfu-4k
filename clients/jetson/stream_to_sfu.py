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
import subprocess
import sys
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

# router の profile-level-id → nvv4l2h264enc の profile 値
# 42=Constrained Baseline, 4d=Main, 64=High
ENC_PROFILE = {"42": (0, "Constrained Baseline"), "4d": (2, "Main"), "64": (4, "High")}


def log(msg):
    print(f"[stream-to-sfu] {msg}", flush=True)


def post_json(url, payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode())


def camera_supports_mjpeg(dev):
    """gst-device-monitor で対応フォーマットを見る（v4l2-ctl の代わり）"""
    try:
        out = subprocess.run(["gst-device-monitor-1.0", "Video/Source"],
                             capture_output=True, text=True, timeout=20).stdout
    except Exception as e:
        log(f"デバイス情報の取得に失敗（rawとして扱う）: {e}")
        return False
    # 対象デバイスのブロックだけを見る
    blocks = out.split("Device found:")
    for b in blocks:
        if dev in b:
            return "image/jpeg" in b
    return "image/jpeg" in out


def main():
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
    log(f"入力: {'MJPEG' if mjpeg else 'raw'} {WIDTH}x{HEIGHT}@{FPS}")

    if mjpeg:
        src = [f"v4l2src device={DEV} io-mode=2", "!",
               f"image/jpeg,width={WIDTH},height={HEIGHT},framerate={FPS}/1", "!",
               "jpegdec", "!", "videoconvert"]
    else:
        src = [f"v4l2src device={DEV} io-mode=2", "!",
               f"video/x-raw,width={WIDTH},height={HEIGHT},framerate={FPS}/1", "!",
               "videoconvert"]

    gop = FPS * 2
    pipeline = src + [
        "!", "nvvidconv",
        "!", "video/x-raw(memory:NVMM),format=NV12",
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
    os.execvp(cmd[0], cmd)


if __name__ == "__main__":
    main()
