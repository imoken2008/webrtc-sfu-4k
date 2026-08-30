// ─── 📺 タイルの全画面表示 ────────────────────────────────────────────────
//
// 要件: 余白のない「本当の全画面」。iPad から外部モニタへ出すときも
// モニタ全体を使いたい。
//
// 環境ごとに使える API が違う:
//   - デスクトップ/Android : 要素の Fullscreen API。中の video を敷き詰める
//   - iOS Safari           : 要素の Fullscreen API が無い。video 要素の
//                            webkitEnterFullscreen だけが使える。これは
//                            ネイティブプレイヤーを起動し、外部モニタ接続時は
//                            モニタ全体で再生される（ミラーリングの黒帯が出ない）
// そのため iOS だけは video を直接全画面にする。

function sfuIsIOS() {
    // iPadOS 13+ は UA が Mac を名乗るので、タッチ有無で判定する
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
           (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function sfuFullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function sfuEnterFullscreen(tile) {
    const video = tile.querySelector('video');
    if (!video) return;

    if (sfuIsIOS() && typeof video.webkitEnterFullscreen === 'function') {
        // iOS: ネイティブプレイヤー。外部モニタがあればモニタ全体で再生される
        video.webkitEnterFullscreen();
        return;
    }

    tile.classList.add('is-fullscreen');
    const req = tile.requestFullscreen || tile.webkitRequestFullscreen ||
                tile.msRequestFullscreen;
    if (req) {
        // navigationUI:hide でブラウザのUIを極力隠す
        Promise.resolve(req.call(tile, { navigationUI: 'hide' })).catch(() => {
            // Fullscreen API が拒否された場合も CSS 側で画面いっぱいにはなる
        });
    }
    // 画面の向きを映像に合わせられる端末では横に固定する
    if (screen.orientation && screen.orientation.lock) {
        screen.orientation.lock('landscape').catch(() => {});
    }
}

function sfuExitFullscreen(tile) {
    if (sfuFullscreenElement()) {
        (document.exitFullscreen || document.webkitExitFullscreen ||
         document.msExitFullscreen).call(document);
    }
    if (tile) tile.classList.remove('is-fullscreen');
    if (screen.orientation && screen.orientation.unlock) {
        try { screen.orientation.unlock(); } catch (e) {}
    }
}

function sfuToggleFullscreen(tile) {
    if (!tile) return;
    if (tile.classList.contains('is-fullscreen') || sfuFullscreenElement() === tile) {
        sfuExitFullscreen(tile);
    } else {
        sfuEnterFullscreen(tile);
    }
}

// 全画面中の操作ボタン（表示のはめ方を切り替える／閉じる）
function sfuAddFullscreenControls(tile) {
    if (tile.querySelector('.sfu-fs-controls')) return;
    const box = document.createElement('div');
    box.className = 'sfu-fs-controls';

    const fit = document.createElement('button');
    fit.textContent = '⛶ 全体表示';
    fit.title = '端が切れないように収める（余白が出ます）';
    fit.onclick = (e) => {
        e.stopPropagation();
        const contain = tile.classList.toggle('fit-contain');
        fit.textContent = contain ? '⛶ 画面いっぱい' : '⛶ 全体表示';
    };

    const close = document.createElement('button');
    close.textContent = '✕ 閉じる';
    close.onclick = (e) => { e.stopPropagation(); sfuExitFullscreen(tile); };

    box.appendChild(fit);
    box.appendChild(close);
    tile.appendChild(box);

    // タッチ端末はホバーが無いので、触れたら一定時間だけ出す
    tile.addEventListener('touchstart', () => {
        box.classList.add('is-visible');
        clearTimeout(box._t);
        box._t = setTimeout(() => box.classList.remove('is-visible'), 3000);
    }, { passive: true });
}

// タイルに全画面操作を仕込む。renderSfuPeer がタイルを作るたびに呼ばれる。
function sfuMakeTileFullscreenable(tile) {
    if (!tile || tile._fsReady) return;
    tile._fsReady = true;
    tile.style.cursor = 'zoom-in';
    tile.title = 'クリック/タップで全画面';
    tile.addEventListener('click', (e) => {
        if (e.target.closest('.sfu-fs-controls, .sfu-tile__audio')) return;
        sfuToggleFullscreen(tile);
    });
    sfuAddFullscreenControls(tile);
}

// 全画面が外部要因（Escキー等）で解除されたときの後始末
for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) {
    document.addEventListener(ev, () => {
        if (!sfuFullscreenElement()) {
            document.querySelectorAll('.sfu-tile.is-fullscreen')
                .forEach((t) => t.classList.remove('is-fullscreen'));
        }
    });
}

// 既存タイルと、以後追加されるタイルの両方に適用する
(function sfuWatchTiles() {
    const apply = () => document.querySelectorAll('#sfu-grid .sfu-tile')
        .forEach(sfuMakeTileFullscreenable);
    apply();
    const grid = document.getElementById('sfu-grid');
    if (grid) new MutationObserver(apply).observe(grid, { childList: true });
    else document.addEventListener('DOMContentLoaded', () => {
        const g = document.getElementById('sfu-grid');
        if (g) new MutationObserver(apply).observe(g, { childList: true });
        apply();
    });
})();
