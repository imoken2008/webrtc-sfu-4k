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

## mDNS は有線だけ広告させる

Pi 5 は有線と無線の両方を持つため、既定では **avahi が両方を広告し
`pi5.local` の解決先が揺れる**（実測: .16(無線) を返したり .10(有線) を返したり）。
SFU が広告する ANNOUNCED_IP は有線なので、名前で引くとシグナリングとメディアが
別経路になりうる。

`/etc/avahi/avahi-daemon.conf`:
```
allow-interfaces=eth0
```
`sudo systemctl restart avahi-daemon` で反映。以後 `pi5.local` は常に有線 IP。

**注意**: 有線を抜くと `pi5.local` が引けなくなる。無線運用に戻すときは
この行を `allow-interfaces=eth0,wlan0` にするか、コメントアウトする。

## ダッシュボードとハブを同一オリジンに統合（証明書1枚で済ませる）

従来はダッシュボード(5443)とハブ(8443)が**別オリジン**だったため、自己署名
証明書をブラウザに**2回**承認させる必要があった。片方でも未承認だと
socket.io の接続だけが黙って失敗し、**ページは出るが映像が来ない**という
分かりにくい壊れ方をする（実際にこれで長時間はまった）。

```
[sfu] error: ハブに接続できません (websocket error)
→ 画面は「まだ誰もカメラを送っていません」のまま
```

nginx で TLS を1箇所に集約して解決する。

```
https://pi5.local:5443
   ├─ /socket.io/   → ハブ 127.0.0.1:8080（WebSocket 中継）
   ├─ /api/ingest/  → ハブ 127.0.0.1:8080
   ├─ /health       → ハブ 127.0.0.1:8080
   └─ /             → ダッシュボード 127.0.0.1:5000
```

**ダッシュボード自身は socket.io を使っていない**ので `/socket.io/` が空いており、
クライアントを改修せずに済む（`SFU_HUB_HTTPS_URL=https://pi5.local:5443` を
指すだけでよい）。

### 手順

1. Flask 側の HTTPS を止めて 5443 を空ける（`ssl/cert.pem` `ssl/key.pem` を退避。
   app.py は証明書が無ければ HTTPS を立てない）
2. `nginx-dashboard.conf` を `/etc/nginx/sites-available/dashboard` に置いて有効化
3. `ai-secretary.service.d/sfu.conf` で `SFU_HUB_HTTPS_URL=https://pi5.local:5443`

WebSocket は `proxy_read_timeout 3600s` と `proxy_buffering off` が必須。
無いと無通信で切られる。

### 検証

Chrome の `--ignore-certificate-errors-spki-list` で **5443 の証明書だけを信頼**
させた状態（＝実際の利用条件）で、`live 2人/2トラック`・両タイルの描画を確認。

## カクつきの原因は UDP 受信バッファ溢れだった（実測で特定）

4K キャプチャ(Cam Link)の映像だけが定期的にカクつき、**複数の視聴ブラウザで
同時に**発生していた。= 受信側ではなく配信側かハブで欠落している。

### 切り分けの経過

| 疑ったもの | 実測結果 | 判定 |
|---|---|---|
| USB 帯域の競合 | 2台同時でも 30.00fps / URBエラー0 | ❌ シロ |
| Jetson の負荷 | CPU 20〜50% / NVENC余裕 / 温度47℃ | ❌ シロ |
| ネットワーク品質 | BRIO は同一経路でロス0 | ❌ シロ |
| **UDP 受信バッファ** | **RcvbufErrors +233/90秒** | ✅ **真因** |

Cam Link だけが該当したのは、**4K 由来の映像はディテールが多く I フレームが
巨大**になり、一気に届いてソケットの受信バッファを溢れさせるため。BRIO の
1080p 由来はフレームが小さく収まっていた。

### 対処

Linux 既定の `rmem_max` は **212992 (208KB)** しかない。32MB へ拡張する。

`/etc/sysctl.d/99-sfu-udp.conf`（ハブ側）:
```
net.core.rmem_max = 33554432
net.core.rmem_default = 16777216
net.core.netdev_max_backlog = 5000
```
送信側(Jetson)も `wmem_max` を同様に拡張する。`sysctl -p` 後に
**サービスの再起動が必要**（ソケットは生成時のサイズを引き継ぐため）。

### 効果（90秒の実測）

| | 修正前 | 修正後 |
|---|---|---|
| パケットロス | 732 | **0** |
| NACK | 393 | **0** |
| PLI | 31 | **0** |
| RcvbufErrors | 233 | **0** |

### 計測方法

ハブに `/api/ingest/stats` を追加してある（producer/transport の実測値）。
`watch_stats.py` で時系列に追える。`packetsLost` と `pliCount` の増加が
そのままカクつきに対応する。
