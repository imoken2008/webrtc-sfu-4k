#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.local/node/bin:$PATH"

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# Check SSL certs exist
if [[ ! -f ssl/key.pem || ! -f ssl/cert.pem ]]; then
  echo "SSL証明書が見つかりません。先に setup.sh を実行してください。"
  exit 1
fi

# Check bundle exists
if [[ ! -f public/bundle.js ]]; then
  echo "クライアントバンドルを生成中..."
  node build.js
fi

# IPv4 LAN IPを優先して取得（WebRTCのICE候補に使用）
LAN_IP=$(ip -4 addr show scope global | grep -oP '(?<=inet )\d+\.\d+\.\d+\.\d+' | grep -v '^172\.' | head -1)
LAN_IP="${LAN_IP:-$(hostname -I 2>/dev/null | awk '{print $1}')}"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " 4K WebRTC SFU を起動します"
echo ""
echo " アクセス URL:"
echo "   https://localhost:3443"
echo "   https://${LAN_IP:-?}:3443  (LAN)"
echo ""
echo " 初回アクセス時はブラウザで"
echo " 「詳細設定」→「安全でないサイトへ進む」"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

exec env ANNOUNCED_IP="${LAN_IP}" node server.js
