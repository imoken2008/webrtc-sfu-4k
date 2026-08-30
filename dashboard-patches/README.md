# ダッシュボードへの追加パッチ

秘書ダッシュボード（Pi 5 の `~/projects/personal-ai-secretary/`）に足した機能。
本体は別リポジトリなので、ここには追記部分だけを置いている。

## タイルの全画面表示（fullscreen.js / fullscreen.css）

グリッドのタイルをクリック/タップで**余白のない全画面**にする。

### 環境ごとに使う API が違う

| 環境 | 使う API | 挙動 |
|---|---|---|
| デスクトップ / Android | 要素の Fullscreen API | 要素を全画面にし、中の video を敷き詰める |
| **iOS / iPadOS** | `video.webkitEnterFullscreen()` | ネイティブプレイヤー。**外部モニタ接続時はモニタ全体**で再生される |

**iOS Safari には要素の Fullscreen API が無い**（video 要素の
`webkitEnterFullscreen` のみ）。iPad から外部モニタへ出すとき、通常の
ミラーリングでは iPad の画面比率のまま映るので上下左右に黒帯が出るが、
video のネイティブ全画面ならモニタ全体を使う。そのため iOS だけ分岐する。

iPadOS 13+ は UA が Mac を名乗るので、`maxTouchPoints` で判定している。

### 表示のはめ方

既定は `object-fit: cover`（余白なしで敷き詰め、端は切れる）。
全画面中の「⛶ 全体表示」ボタンで `contain`（端まで見えるが余白が出る）に
切り替えられる。タッチ端末はホバーが無いので、画面に触れると3秒だけ
ボタンが出る。

### 実測

```
画面     : 1920x1080
タイル   : 1920x1080  ← 完全一致
映像領域 : 1920x1080  ← 余白なし
```
