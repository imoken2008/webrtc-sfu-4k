#!/usr/bin/env bash
# Jetson (Xavier NX) の USB カメラ映像を SFU ハブへ H.264 RTP で送出する。
#
#   USBカメラ → (MJPEG) → NVDEC/CPUデコード → NVENC (nvv4l2h264enc)
#            → RTP/UDP → mediasoup PlainTransport(comedia) → 全視聴者へ WebRTC
#
# ハブ側に Node も mediasoup も追加不要。ingest API で送り先を貰って投げるだけ。
set -euo pipefail

HUB="${SFU_HUB_URL:-http://sfu-hub.local:8080}"
ROOM="${SFU_ROOM_ID:-secretary-cam}"
NAME="${SFU_INGEST_NAME:-jetson}"
DISPLAY_NAME="${SFU_DISPLAY_NAME:-Jetson Xavier NX}"

DEV="${CAM_DEVICE:-/dev/video0}"
W="${CAM_WIDTH:-1280}"
H="${CAM_HEIGHT:-720}"
FPS="${CAM_FPS:-30}"
# Pi3 ハブの Ethernet が 100Mbps 上限で、視聴者数ぶん出ていく。
# ここを上げるとハブ側の帯域が先に飽和する。
BITRATE="${CAM_BITRATE:-4000000}"

log() { echo "[$(date +%H:%M:%S)] $*"; }

command -v jq >/dev/null || { echo "jq が必要です: sudo apt-get install -y jq"; exit 1; }
[ -e "$DEV" ] || { echo "カメラが見つかりません: $DEV"; exit 1; }

log "ingest を要求: $HUB (room=$ROOM name=$NAME)"
RESP=$(curl -sS --max-time 10 -X POST "$HUB/api/ingest/start" \
  -H 'Content-Type: application/json' \
  -d "{\"roomId\":\"$ROOM\",\"name\":\"$NAME\",\"displayName\":\"$DISPLAY_NAME\"}")

echo "$RESP" | jq -e '.ok' >/dev/null || { echo "ingest 失敗: $RESP"; exit 1; }

IP=$(echo "$RESP"   | jq -r '.ip')
PORT=$(echo "$RESP" | jq -r '.port')
PT=$(echo "$RESP"   | jq -r '.payloadType')
SSRC=$(echo "$RESP" | jq -r '.ssrc')
PLI=$(echo "$RESP"  | jq -r '.profileLevelId // "42e01f"')

# エンコーダのプロファイルは router の宣言に合わせる。ここがずれると
# produce が "unsupported codec" で弾かれる（実際に一度それで壊れた）。
# nvv4l2h264enc: 0=Baseline 2=Main 4=High
case "$PLI" in
  42*) ENC_PROFILE=0; PROFILE_NAME="Constrained Baseline" ;;
  4d*) ENC_PROFILE=2; PROFILE_NAME="Main" ;;
  64*) ENC_PROFILE=4; PROFILE_NAME="High" ;;
  *)   ENC_PROFILE=0; PROFILE_NAME="Baseline(既定)" ;;
esac
log "送り先: $IP:$PORT  pt=$PT ssrc=$SSRC"
log "プロファイル: $PLI → $PROFILE_NAME (nvv4l2h264enc profile=$ENC_PROFILE)"

# カメラが MJPEG を出すか生の YUY2 かで前段が変わるので自動判定する
if v4l2-ctl -d "$DEV" --list-formats 2>/dev/null | grep -qi "MJPG"; then
  log "入力: MJPEG ${W}x${H}@${FPS}"
  SRC="v4l2src device=$DEV io-mode=2 ! image/jpeg,width=$W,height=$H,framerate=$FPS/1 ! jpegdec ! videoconvert"
else
  log "入力: raw(YUY2) ${W}x${H}@${FPS}"
  SRC="v4l2src device=$DEV io-mode=2 ! video/x-raw,width=$W,height=$H,framerate=$FPS/1 ! videoconvert"
fi

# profile は上で router の宣言から決めている。直書きしてはいけない。
# insert-sps-pps=1 が無いと、後から入った視聴者が SPS/PPS を受け取れず映らない。
exec gst-launch-1.0 -e \
  $SRC \
  ! nvvidconv \
  ! 'video/x-raw(memory:NVMM),format=NV12' \
  ! nvv4l2h264enc \
      bitrate="$BITRATE" \
      profile="$ENC_PROFILE" \
      insert-sps-pps=1 \
      iframeinterval="$((FPS * 2))" \
      idrinterval="$((FPS * 2))" \
      maxperf-enable=1 \
      preset-level=1 \
      control-rate=1 \
  ! h264parse \
  ! rtph264pay pt="$PT" ssrc="$SSRC" config-interval=1 mtu=1200 \
  ! udpsink host="$IP" port="$PORT" sync=false async=false
