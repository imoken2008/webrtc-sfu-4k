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

## ハブの参照は必ず mDNS 名で

`pi5.local` を使うこと。IP 直書きは禁止。

- Pi 5 は有線(eth0)と無線(wlan0)で別々の IP を持つ。**LAN ケーブルを挿した瞬間に
  IP が変わる**ため、直書きは追従できない
- DHCP のリース変更でも壊れる
- 自己署名証明書の SAN に `pi5` / `pi5.local` を入れてあるので、HTTPS でも
  名前でアクセスできる

参照箇所:
- ダッシュボード: `personal-ai-secretary/core/sfu_publisher.py` の `SFU_HUB_URL`
- Jetson: `/etc/systemd/system/jetson-sfu.service` の `Environment=SFU_HUB_URL`

## HTTPS を使うときは証明書を2つ承認する

ダッシュボードを HTTPS(5443) で開くと、ハブへの接続も HTTPS(8443) になる。
**それぞれ別オリジンなので、両方を一度ずつ承認しないと黒画面になる**。

1. `https://pi5.local:8443/health` ← ハブ
2. `https://<dashboard>:5443/dashboard` ← ダッシュボード

承認済みなら HTTP 版と同じく 4K が描画される（実測確認済み）。

## 有線化の結果（2026-08-30）

LAN ケーブルを挿すと **eth0 が 1000Mbps full duplex** で上がる（Pi 3 の 10倍）。
`start.sh` が自動で eth0 を ANNOUNCED_IP に選ぶので、**サービス再起動だけで切替**。

```
[sfu-hub start] ANNOUNCED_IP=192.168.0.10 (有線 1000Mbps)
```

**Pi 5 は有線と無線で別 IP を持ち、mDNS は両方を広告する**。
`pi5.local` の解決結果は呼び出しごとに揺れる（実測: Jetson は .10、Flask は .16 を得た）。
シグナリングとメディアで別経路になるのを避けるため、**ハブ自身を権威にする**:

- `/health` が `announcedIp` を返す
- ダッシュボードはそれを最優先で使い、取れなければ通常の名前解決へフォールバック

## ハブ再起動時の自動復帰

ハブを再起動すると PlainTransport が消えるが、**UDP 送出は fire-and-forget なので
gst-launch は気づかず送り続ける**（プロセスが終了しないため systemd の
`Restart=always` も効かない）。

`stream_to_sfu.py` が `HEALTH_INTERVAL`（既定20秒）ごとに
`/api/ingest/status` を見て、自分の ingest が消えていたら終了 → systemd が
再起動 → ingest を張り直す。実測でハブ再起動から40秒以内に復帰を確認。
