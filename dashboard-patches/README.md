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

## 全画面から戻ると映像が止まる問題（fullscreen-resume.js）

iPad で全画面を抜けると映像が固まる、という報告への対処。

### 原因

iOS の `video.webkitEnterFullscreen()` はネイティブプレイヤーを起動する。
そこから戻るときにインライン再生へ復帰せず、**一時停止のまま固まる**ことがある。
`srcObject` に MediaStream を入れている場合は特に、`play()` を呼び直すだけでは
描画が再開しないことがある。

### 対処

`webkitendfullscreen` を拾って復帰させる。二段構えにしてある:

1. まず `play()` を呼ぶ
2. 500ms 後にまだ `paused` か `readyState < 2` なら、**srcObject を付け直す**
   （`null` を入れてから同じ MediaStream を再代入）

あわせて次も拾う:

- `pause` イベント — ライブ映像に一時停止は無意味なので自動で再開する
  （タブが裏にあるときは除く）
- `visibilitychange` — タブに戻ったときに止まっていれば再開
- `fullscreenchange` / `webkitfullscreenchange` — デスクトップ側の全画面解除

### 検証

iOS 実機は手元に無いため、**同じ復帰経路を通る「強制一時停止」で確認**した:

```
強制停止直後 : paused=True  t=32.4
3秒後        : paused=False t=34.4   → 自動復帰
再生位置     : 34.4 → 37.7           → フリーズしていない
```

`webkitendfullscreen` 自体の発火は iPad 実機での確認が必要。
