# Jetson → SFU カメラ送出

Jetson の USB カメラ映像を、NVENC でハードウェア H.264 エンコードして
SFU ハブ (`sfu-hub.local`) へ RTP で送り込む。ダッシュボードの参加者
グリッドに1タイルとして並ぶ。

Jetson 側に Node / mediasoup は不要。ハブの `POST /api/ingest/start` で
送り先 (ip/port/payloadType/ssrc) を貰い、GStreamer で投げるだけ。

## 導入

```bash
# 追加パッケージ不要（JetPack標準の python3 と GStreamer だけで動く）
cp stream_to_sfu.py ~/
chmod +x ~/stream_to_sfu.py

# 手動で試す
~/stream_to_sfu.py

# 常駐化
sudo cp jetson-sfu.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now jetson-sfu
journalctl -u jetson-sfu -f
```

## 調整

環境変数で変えられる（systemd unit の Environment= を編集）。

| 変数 | 既定 | メモ |
|---|---|---|
| `CAM_DEVICE` | `/dev/video0` | `v4l2-ctl --list-devices` で確認 |
| `CAM_WIDTH`/`CAM_HEIGHT` | 1280x720 | |
| `CAM_FPS` | 30 | |
| `CAM_BITRATE` | 4000000 | **ハブが Pi 3 = 100Mbps 有線**。視聴者数ぶん出ていくので上げすぎない |

## 落とし穴

- `insert-sps-pps=1` と `config-interval=1` は必須。これが無いと後から入った
  視聴者が SPS/PPS を受け取れず、映像が出ない
- エンコーダのプロファイルは ingest API が返す `profileLevelId` から自動決定する。
  直書きしてはいけない（router 側を変更したとき `unsupported codec` で壊れる）
- ハブを再起動すると PlainTransport が消える。`Restart=always` で
  ingest 要求からやり直させている


## 実機での知見 (Jetson Xavier NX / JetPack 5.0.2)

- **argv の渡し方**: `gst_parse_launchv` は argv の1要素を1トークンとして扱う。
  `"v4l2src device=X io-mode=2"` のようにスペース入り文字列を1要素で渡すと
  `erroneous pipeline: syntax error` になる。単語ごとに分割して渡すこと
- **USB が全滅したとき**: ポートが無反応になり抜き差ししてもカーネルが
  何も検出しなくなることがある。再起動せずに直せる:
  ```
  sudo sh -c 'echo 3610000.xhci > /sys/bus/platform/drivers/tegra-xusb/unbind'
  sudo sh -c 'echo 3610000.xhci > /sys/bus/platform/drivers/tegra-xusb/bind'
  ```
- **カメラは USB 3.0 側に挿す**。ハブ多段(4段)にぶら下げると給電が不安定で
  繰り返し切断される

## Cam Link 4K (HDMIキャプチャ) を使う場合

Cam Link 4K は **3840x2160@30 の raw のみ**を出す（MJPEG も低解像度も選べない）。
そのため:

- `videoconvert` を通さないこと。4K の CPU 変換は全く間に合わない。
  raw は `nvvidconv` が直接受けられる
- `OUT_WIDTH`/`OUT_HEIGHT` でハードウェア縮小してから送出する。
  4K のまま送ると、ハブ(Pi 3 / 100Mbps)が視聴者数ぶんを捌けない

```
CAM_DEVICE=/dev/video0 CAM_WIDTH=3840 CAM_HEIGHT=2160 CAM_FPS=30 \
OUT_WIDTH=1920 OUT_HEIGHT=1080 CAM_BITRATE=6000000 ./stream_to_sfu.py
```

HDMI ソースが繋がっていないとキャプチャに失敗する。

## systemd の落とし穴

`Environment=` にスペースを含む値を書くときは**クォートが必須**。
`Environment=SFU_DISPLAY_NAME=Cam Link 4K` は "Cam" で切れる。
`Environment="SFU_DISPLAY_NAME=Cam Link 4K"` と書くこと。

## H.264 プロファイルは Baseline から動かさない（実測）

Chrome が**受信可能と宣言する H264 は `42e01f` (Constrained Baseline) のみ**だった。
router に High (640034) を宣言すると `router.canConsume()` が false になり、
**socket接続もjoinも成功するのに映像だけ出ない**という分かりにくい壊れ方をする。

```
[sfu] joined producer 1 件
[sfu] consume 失敗: canConsume=false     ← これが出たらプロファイル不一致
```

正しくは **Baseline のままレベルだけ上げる**: `42e034` = Constrained Baseline / Level 5.2。
`level-asymmetry-allowed=1` があるので、`42e01f` しか宣言しない相手ともレベル差を
許容して consume できる（実測で確認済み）。

## 受信側の切り分け方

推測せず、実ブラウザで観測すること。

```python
# Chrome を Playwright から起動（executable_path で system Chrome を使う）
# ※ HeadlessChrome の UA だと mediasoup-client が
#   "UnsupportedError: device not supported" を投げるので UA を偽装する
ctx = b.new_context(user_agent="...Chrome/151.0.0.0 Safari/537.36")
ctx.add_init_script("window.__logs=[]; ...console をフック...")
pg.evaluate("() => window.SecretaryCam.device.rtpCapabilities")  # 受信可能コーデック
pg.evaluate("() => window.SecretaryCam.getStats()")              # state/peers/tracks
```

## デバイスパスは by-id を使う

`/dev/videoN` の番号は USB 再列挙で入れ替わる（実際に Cam Link が video0→video1 に
ずれて配信が止まった）。シリアル番号ベースの固定パスを使うこと:

```
/dev/v4l/by-id/usb-Elgato_Cam_Link_4K_XXXXXXXXXXX-video-index0
```

`index1` はメタデータ用で映像は取れない。`index0` を使う。

## nvv4l2h264enc の assertion は無害

`gst_buffer_resize_range: assertion 'bufmax >= bufoffs + offset + size' failed` が
毎秒数回出るが、**解像度に関係なく出る**（1080p でも 4K でも同じ回数）NVIDIA
プラグインのノイズで、映像は正常に流れる。切り分けた結果:

| 構成 | assertion |
|---|---|
| キャプチャのみ | 0 |
| +nvvidconv | 0 |
| +NVENC (4K) | 401 |
| +NVENC (1080p) | 403 |

## リソース監視 (jtop)

```
sudo pip3 install -U jetson-stats
sudo jtop --install-service
sudo groupadd jtop && sudo usermod -aG jtop $USER   # 自動作成されない
sudo systemctl restart jtop
jtop
```
NVENC/NVDEC/VIC の稼働状況が見える。GPU(GR3D) が 0% のまま NVENC が
499MHz で回っていれば、専用ハードウェアでエンコードできている証拠。

## フォーマット判定は v4l2-ctl で（gst-device-monitor の落とし穴）

`gst-device-monitor-1.0` の出力は `Device found:` 区切りだが、**その中で
`device.path` が caps より後に出る**。区切りで分割して「対象パスを含む
ブロックの caps」を見ると、**別デバイスの caps を読んでしまう**。

実際に、BRIO(MJPEG対応) と Cam Link(rawのみ) を同時接続した状態で
Cam Link を MJPEG と誤判定し、`image/jpeg` を要求するパイプラインを組んで
ネゴシエーションに失敗、`receiving=False` で配信が止まった。

対処: `v4l2-ctl -d <実体パス> --list-formats` で直接引く。無い場合は
device.path 行から遡って直前の `Device found:` までをそのデバイスの
ブロックとみなす。

```
$ v4l2-ctl -d /dev/video4 --list-formats   # Cam Link
NV12
$ v4l2-ctl -d /dev/video0 --list-formats   # BRIO
MJPG NV12 YUYV
```

## by-id パスの効果（実例）

カメラを挿し直したら Cam Link は `/dev/video1` → `/dev/video4` に動いたが、
`by-id` の固定パスを使っていたため**設定変更なしで追従**した。

## 全カメラを自動配信する

`stream_all_cameras.py` が接続中の全カメラを検出し、1台につき
`stream_to_sfu.py` を1本起動する。ダッシュボードのグリッドに台数ぶんの
タイルが並ぶ。抜き差しは **udev のイベントで即座に**検知して起動/停止する
（`udevadm monitor --subsystem-match=video4linux`）。`SCAN_INTERVAL`
（既定300秒）はイベントを取りこぼした場合の保険でしかない。

### 1台のカメラが複数ノードを持つ点に注意（実測）

```
BRIO    index0=YUYV/MJPG/NV12(本命)  index2=GREY(赤外)  index1,3=メタデータ
CamLink index0=NV12(本命)            index1=メタデータ
```

by-id のプレフィクスで物理カメラを束ね、`USABLE_FORMATS` に含まれる形式を
持つノードを1つだけ選ぶ。**GREY のみのノードは赤外センサ**（Windows Hello 用）
なので配信対象から外す。

### 形式と解像度の決め方

- MJPEG があれば優先（USB帯域が軽い）。無ければ raw
- `MAX_OUT_WIDTH`/`MAX_OUT_HEIGHT`（既定 1920x1080）以下で最大の解像度を取り込む。
  全部が上限超えなら最小を取り込んで VIC で縮小する（Cam Link は 4K しか
  出さないのでこの経路になる）

### 実測の検出結果

```
Logicool BRIO : MJPG 1920x1080 → 1920x1080
Cam Link 4K   : NV12 3840x2160 → 1920x1080
```

## 抜き差しの検知は udev イベント駆動

ポーリングだと最大 `SCAN_INTERVAL` 秒の遅れが出るため、
`udevadm monitor --udev --subsystem-match=video4linux` を購読して
カーネルからの通知で即座に反応する。

- イベント直後はデバイスノードが揃っていないことがあるので 1.5 秒待ってから
  再スキャンし、連続して届くイベントはまとめて1回に畳む
- `udevadm` が無い環境では自動的にポーリングのみへフォールバックする
- `select` のタイムアウトに保険の再スキャン期限を使うので、イベントが
  来なくても最終的には追従する

実地試験（USB を `unbind`/`bind` して確認）:
```
切り離し → 6秒以内に検知して停止
再接続   → 10秒以内に検知して配信再開
```

## 落ちたストリーマの拾い直し

カメラ再接続の直後はデバイスの準備が間に合わず、gst が
`not-negotiated (-4)` で落ちることがある。udev イベントだけに頼ると
**次のイベントが来るまでそのカメラは止まったまま**になる（実際に発生）。

`HEALTH_POLL`（既定5秒）ごとに子プロセスの生死を見て、落ちていれば
`RETRY_DELAY` 待ってから起動し直す。

## 4K で配信する

```
Environment=MAX_OUT_WIDTH=3840
Environment=MAX_OUT_HEIGHT=2160
Environment=CAM_BITRATE=15000000
```

**先に UDP 受信バッファを拡張しておくこと**（`99-sfu-udp.conf`）。既定の
208KB では 4K の I フレームを受けきれない。実測したフレームサイズ:

| 送出解像度 | 平均 | 最大 | 208KB超のフレーム |
|---|---|---|---|
| 1080p (4K取込) | 25KB | **290KB** | 6/635 |
| 1080p (BRIO) | 25KB | 90KB | 0/617 |

**平均は同じでも最大が3倍違う**。溢れるのは瞬間最大値だけが原因。

### 4K×2台の実測（90秒）

```
Cam Link 4K  : 15.0Mbps  score=10  loss=0  NACK=0
Logicool BRIO:  7.5Mbps  score=10  loss=0  NACK=0
Pi5 RcvbufErrors: +0
Jetson: CPU 20-60% / NVENC 499MHz / VIC 75% / 47℃ / 6.4W
ブラウザ: 両タイルとも 3840x2160 で描画
```

USB は 4K×2台（Cam Link 非圧縮 + BRIO MJPEG）でも URB エラーがほぼ出ない。
