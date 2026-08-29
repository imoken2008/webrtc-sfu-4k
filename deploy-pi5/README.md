# SFU ハブを Raspberry Pi 5 で動かす

## なぜ Pi 5 か（実測）

Pi 3 Model B をハブにすると、**高ビットレートで映像がブラウザに出ない**。
同じ Jetson・同じブラウザで、ハブだけを差し替えた比較:

| ハブ | 4K@15Mbps | 1080p@8Mbps | 1080p@3Mbps |
|---|---|---|---|
| Pi 3 Model B | ❌ デコード不可 | ❌ | ✅ |
| **Pi 5** | **✅ 映る** | ✅ | ✅ |

Pi 3 の Ethernet は **USB2 接続の 100Mbps**（`smsc95xx`）で、中継で詰まる。
ブラウザのデコード能力の問題ではない（同じブラウザが Pi 5 経由なら 4K を再生できる）。

## 構築手順

```bash
# Node 22 が必須（mediasoup は engines: node>=22。Ubuntu 24.04 の既定は 18 で
# "SyntaxError: Unexpected token 'with'" になる）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

mkdir -p ~/sfu-hub/{public,ssl} && cd ~/sfu-hub
# server.js, public/, package.json を配置
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout ssl/key.pem -out ssl/cert.pem -subj "/CN=pi5-sfu" \
  -addext "subjectAltName=IP:192.168.0.16,DNS:pi5,DNS:pi5.local,DNS:localhost"
npm install --omit=dev     # arm64 のビルド済み worker が降りてくる

sudo cp sfu-hub.service /etc/systemd/system/
sudo systemctl enable --now sfu-hub
```

## 有線化

Pi 5 の eth0 はギガビット。`start.sh` は eth0 にキャリアがあれば必ずそちらを
ANNOUNCED_IP に選ぶので、**LAN ケーブルを挿して再起動するだけ**で切り替わる。
現状は eth0 が DOWN で無線(wlan0)運用。
