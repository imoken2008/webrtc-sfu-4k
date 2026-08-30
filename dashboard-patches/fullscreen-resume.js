// ─── iOS: ネイティブ全画面から戻ったときに映像が止まる問題への対処 ──────────
//
// iOS の video.webkitEnterFullscreen() はネイティブプレイヤーを起動する。
// そこから戻ると、インライン再生に復帰せず一時停止のまま固まることがある。
// MediaStream を srcObject にしている場合は特に、play() を呼び直すだけでは
// 描画が再開しないことがあるため、ストリームを付け直して確実に復帰させる。

function sfuResumeVideo(video, why) {
    if (!video) return;
    const stream = video.srcObject;

    const tryPlay = () => video.play().catch((e) => {
        console.warn('[sfu] 復帰再生に失敗:', e.message);
    });

    tryPlay();

    // 少し待っても止まったままなら、ストリームを付け直す。
    // iOS はネイティブプレイヤーから戻った直後に描画が再開しないことがある。
    setTimeout(() => {
        const stalled = video.paused || video.readyState < 2;
        if (stalled && stream) {
            console.log(`[sfu] ${why}: 映像が止まっているのでストリームを付け直す`);
            video.srcObject = null;
            video.srcObject = stream;
            video.muted = video.muted;   // iOS はミュート状態を維持しないことがある
            tryPlay();
        }
    }, 500);
}

function sfuWireVideoFullscreenRecovery(tile) {
    const video = tile && tile.querySelector('video');
    if (!video || video._fsRecoveryReady) return;
    video._fsRecoveryReady = true;

    // iOS のネイティブ全画面の開始/終了
    video.addEventListener('webkitbeginfullscreen', () => {
        // 全画面に入る側では何もしない（ネイティブプレイヤーが再生を持つ）
    });
    video.addEventListener('webkitendfullscreen', () => {
        tile.classList.remove('is-fullscreen');
        sfuResumeVideo(video, 'iOS全画面から復帰');
    });

    // 一時停止されたら再開する。ユーザーが止めたわけではない
    // （ライブ映像なので一時停止に意味がない）
    video.addEventListener('pause', () => {
        if (document.hidden) return;      // タブが裏なら放置してよい
        setTimeout(() => {
            if (video.paused && !document.hidden) sfuResumeVideo(video, '一時停止からの復帰');
        }, 300);
    });

    // タブに戻ってきたときも止まっていれば戻す
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && video.paused) sfuResumeVideo(video, 'タブ復帰');
    });
}

// 全画面解除（デスクトップ側の API）でも同様に復帰させる
for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) {
    document.addEventListener(ev, () => {
        if (document.fullscreenElement || document.webkitFullscreenElement) return;
        document.querySelectorAll('#sfu-grid .sfu-tile video')
            .forEach((v) => { if (v.paused) sfuResumeVideo(v, '全画面解除'); });
    });
}

// タイルが作られるたびに復帰処理を仕込む
(function sfuWatchTilesForRecovery() {
    const apply = () => document.querySelectorAll('#sfu-grid .sfu-tile')
        .forEach(sfuWireVideoFullscreenRecovery);
    apply();
    const grid = document.getElementById('sfu-grid');
    if (grid) new MutationObserver(apply).observe(grid, { childList: true, subtree: true });
    else document.addEventListener('DOMContentLoaded', () => {
        const g = document.getElementById('sfu-grid');
        if (g) new MutationObserver(apply).observe(g, { childList: true, subtree: true });
        apply();
    });
})();
