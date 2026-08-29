#!/usr/bin/env bash
# SFU ハブ起動ラッパー（Pi 5）。
# mediasoup が ICE candidate として広告する IP を決める。
# 有線(eth0)にキャリアがあれば必ず有線を優先する。Pi 5 の eth0 はギガビットで、
# 無線より安定して速い。ケーブルが刺さっていなければ無線にフォールバック。
set -euo pipefail

pick_ip() {
  if [ "$(cat /sys/class/net/eth0/carrier 2>/dev/null || echo 0)" = "1" ]; then
    local e
    e="$(ip -4 -o addr show eth0 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)"
    if [ -n "$e" ]; then echo "$e"; return; fi
  fi
  local d
  d="$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
  if [ -n "$d" ]; then echo "$d"; return; fi
  hostname -I | awk '{print $1}'
}

IP="$(pick_ip)"
LINK="無線"
if [ "$(cat /sys/class/net/eth0/carrier 2>/dev/null || echo 0)" = "1" ] \
   && ip -4 -o addr show eth0 2>/dev/null | grep -q "$IP"; then
  LINK="有線 $(cat /sys/class/net/eth0/speed 2>/dev/null)Mbps"
fi

export ANNOUNCED_IP="$IP"
echo "[sfu-hub start] ANNOUNCED_IP=$ANNOUNCED_IP ($LINK) $(date -Is)"
exec /usr/bin/node server.js
