#!/usr/bin/env bash
set -euo pipefail

# Node.js path — adjust if your node is elsewhere
export PATH="$HOME/.local/node/bin:$PATH"

if ! command -v node &>/dev/null; then
  echo "ERROR: node が見つかりません。~/.local/node/bin/node を確認してください。"
  exit 1
fi

echo "=== 4K WebRTC SFU セットアップ ==="
echo "Node: $(node --version)  npm: $(npm --version)"
echo ""

# ── 1. SSL 自己署名証明書 ────────────────────────────────────────────────────

echo "[1/3] SSL 証明書を生成中..."
mkdir -p ssl

LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
LAN_IP="${LAN_IP:-127.0.0.1}"

openssl req -x509 -newkey rsa:2048 \
  -keyout ssl/key.pem -out ssl/cert.pem \
  -days 365 -nodes \
  -subj "/CN=localhost" \
  -addext "subjectAltName=IP:127.0.0.1,IP:${LAN_IP},DNS:localhost" \
  2>/dev/null

echo "    完了 (LAN IP: ${LAN_IP})"

# ── 2. npm install ────────────────────────────────────────────────────────────

echo "[2/3] 依存パッケージをインストール中..."
npm install

# ── 3. クライアントバンドル ────────────────────────────────────────────────────

echo "[3/3] クライアントをバンドル中..."
node build.js

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " セットアップ完了！"
echo ""
echo " 起動:"
echo "   export PATH=\"\$HOME/.local/node/bin:\$PATH\""
echo "   node server.js"
echo ""
echo " アクセス:"
echo "   ローカル: https://localhost:3443"
echo "   LAN:      https://${LAN_IP}:3443"
echo ""
echo " ※ 自己署名証明書のため、初回は"
echo "   「詳細設定」→「安全でないサイトへ進む」を選択"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
