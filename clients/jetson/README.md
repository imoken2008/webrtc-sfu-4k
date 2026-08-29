# Jetson → SFU カメラ送出

Jetson の USB カメラ映像を、NVENC でハードウェア H.264 エンコードして
SFU ハブ (`sfu-hub.local`) へ RTP で送り込む。ダッシュボードの参加者
グリッドに1タイルとして並ぶ。

Jetson 側に Node / mediasoup は不要。ハブの `POST /api/ingest/start` で
送り先 (ip/port/payloadType/ssrc) を貰い、GStreamer で投げるだけ。

## 導入

```bash
sudo apt-get update && sudo apt-get install -y jq v4l-utils
mkdir -p ~/jetson-sfu && cp stream-to-sfu.sh ~/jetson-sfu/
chmod +x ~/jetson-sfu/stream-to-sfu.sh

# 手動で試す
~/jetson-sfu/stream-to-sfu.sh

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
