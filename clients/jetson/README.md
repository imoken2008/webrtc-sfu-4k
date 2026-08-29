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
