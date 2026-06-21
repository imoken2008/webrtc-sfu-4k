'use strict';

import { Device } from 'mediasoup-client';
import { io } from 'socket.io-client';

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const joinSection    = $('join-section');
const confSection    = $('conf-section');
const roomInput      = $('room-id');
const nameInput      = $('display-name');
const joinBtn        = $('join-btn');
const joinStatus     = $('join-status');
const connIndicator  = $('conn-indicator');
const connLabel      = $('conn-label');
const videoGrid      = $('video-grid');
const localVideo     = $('local-video');
const localName      = $('local-name');
const localRes       = $('local-res');
const confStatus     = $('conf-status');
const confRoomLabel  = $('conf-room');
const muteBtn          = $('mute-btn');
const videoBtn         = $('video-btn');
const cameraSelect     = $('camera-select');
const leaveBtn         = $('leave-btn');
const participantCnt = $('participant-count');

// ─── State ────────────────────────────────────────────────────────────────────

/** @type {import('mediasoup-client').Device} */
let device;
let roomId, displayName;

/** @type {import('mediasoup-client').types.Transport} */
let sendTransport, recvTransport;

/** @type {MediaStream} */
let localStream;

/** @type {import('mediasoup-client').types.Producer} */
let audioProducer, videoProducer;


const peers     = new Map(); // peerId → { displayName, stream }
const consumers = new Map(); // consumerId → { consumer, peerId }

// ─── Pose Tracking ────────────────────────────────────────────────────────────
// MoveNet LIGHTNING でボディポーズを検出し、スプリング物理で吹き出しを追随させる

let poseDetector = null;
let emotionReady = false;
let objectDetector = null;
let sceneModel = null;
let transcriptionRec = null;
let bandwidthTimer = null;
let lastBwStats = { sendBytes: 0, recvBytes: 0, time: 0 };
let lastQualityStats = { limitReason: null, frameWidth: 0, frameHeight: 0, fps: 0, nackCount: 0, upKbps: 0 };
const faceTrackers = new Map(); // videoId → { canvas, stop }

const EMOTION_EMOJI = { neutral:'😐', happy:'😊', sad:'😢', angry:'😠', fearful:'😨', disgusted:'🤢', surprised:'😮' };
const EMOTION_JP   = { neutral:'無表情', happy:'笑顔', sad:'悲しい', angry:'怒り', fearful:'恐怖', disgusted:'嫌悪', surprised:'驚き' };

// 会議シーンで出やすいものに絞って検知コストを削減
const OBJ_EMOJI = {
  laptop:'💻', 'cell phone':'📱', keyboard:'⌨️', mouse:'🖱️',
  book:'📚', cup:'☕', bottle:'🍼', chair:'🪑',
  tv:'📺', remote:'📻', backpack:'🎒', cat:'🐱', dog:'🐶',
};
const OBJ_JP = {
  laptop:'ノートPC', 'cell phone':'スマホ', keyboard:'キーボード', mouse:'マウス',
  book:'本', cup:'カップ', bottle:'ボトル', chair:'イス',
  tv:'テレビ', remote:'リモコン', backpack:'リュック', cat:'猫', dog:'犬',
};
const SCENE_JP = {
  'notebook computer':'ノートPC', 'desktop computer':'デスクトップPC', laptop:'ノートPC',
  monitor:'モニター', television:'テレビ', keyboard:'キーボード', 'computer keyboard':'キーボード',
  mouse:'マウス', 'computer mouse':'マウス', microphone:'マイク', headphones:'ヘッドフォン',
  'coffee mug':'マグカップ', 'coffee cup':'コーヒーカップ', cup:'カップ', bottle:'ボトル',
  book:'本', bookcase:'本棚', bookshelf:'本棚', chair:'イス', desk:'机',
  table:'テーブル', office:'オフィス', window:'窓', wall:'壁', ceiling:'天井',
  floor:'床', person:'人', cat:'猫', dog:'犬', camera:'カメラ',
  whiteboard:'ホワイトボード', projector:'プロジェクター',
};

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function initFaceDetection() {
  const notify = () => {
    for (const [id, { canvas }] of faceTrackers) {
      const vid = document.getElementById(id);
      if (vid && !canvas.parentElement) vid.parentElement?.appendChild(canvas);
    }
  };
  try {
    await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.21.0/dist/tf.min.js');
    await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow-models/pose-detection@2.1.3/dist/pose-detection.min.js');
    await window.tf.ready();
    poseDetector = await window.poseDetection.createDetector(
      window.poseDetection.SupportedModels.MoveNet,
      { modelType: window.poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING },
    );
    console.log('[pose] MoveNet LIGHTNING ready');
    notify();
  } catch (e) {
    console.warn('[pose] MoveNet failed, falling back to BlazeFace:', e.message);
    try {
      await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@3.21.0/dist/tf.min.js');
      await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow-models/blazeface@0.1.0/dist/blazeface.min.js');
      poseDetector = { _blazeface: true, model: await window.blazeface.load() };
      console.log('[pose] BlazeFace fallback ready');
      notify();
    } catch (e2) {
      console.warn('[pose] all detectors failed:', e2.message);
    }
  }
}

function startFaceTracker(videoEl, wrapEl, name) {
  const id = videoEl.id;
  stopFaceTracker(id);

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:3;';
  wrapEl.appendChild(canvas);

  let running = true;
  let spr = null; // スプリング状態 { cx, cy, vx, vy }
  let lastSeen = 0;
  const K = 0.18, DAMP = 0.72;

  // 感情スコアを右上パネルに表示（2秒ごと）
  async function detectEmotion() {
    if (!running || !emotionReady || videoEl.readyState < 2) return;
    try {
      const result = await window.faceapi
        .detectSingleFace(videoEl, new window.faceapi.TinyFaceDetectorOptions({ inputSize: 128, scoreThreshold: 0.35 }))
        .withFaceExpressions();
      const emotionEl = wrapEl.querySelector('.emotion-overlay');
      if (result?.expressions && emotionEl) {
        const entries = Object.entries(result.expressions).sort((a, b) => b[1] - a[1]);
        emotionEl.innerHTML = entries.map(([emo, score]) => {
          const pct = Math.round(score * 100);
          return `<div class="emo-row">
            <span class="emo-lbl">${EMOTION_EMOJI[emo] ?? ''} ${EMOTION_JP[emo] ?? emo}</span>
            <span class="emo-pct">${pct}%</span>
            <div class="emo-bar-bg"><div class="emo-bar" style="width:${pct}%"></div></div>
          </div>`;
        }).join('');
      }
    } catch (_) {}
  }
  const emotionTimer = setInterval(detectEmotion, 4000);
  detectEmotion();

  // 物体検出: canvas 吹き出し用に配列へ格納（3秒ごと、人は除外、複数インスタンス対応）
  let detectedObjects = [];
  async function detectObjects() {
    if (!running || !objectDetector || videoEl.readyState < 2) return;
    try {
      const preds = await objectDetector.detect(videoEl);
      detectedObjects = preds
        .filter(p => p.score > 0.6 && p.class !== 'person' && p.class in OBJ_EMOJI)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
    } catch (_) {}
  }
  const objectTimer = setInterval(detectObjects, 8000);
  detectObjects();

  // 位置トラッキング: 200ms ごと
  async function loop() {
    if (!running) return;

    const dw = wrapEl.offsetWidth, dh = wrapEl.offsetHeight;
    if (canvas.width !== dw) canvas.width = dw;
    if (canvas.height !== dh) canvas.height = dh;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, dw, dh);

    if (poseDetector && videoEl.readyState >= 2 && videoEl.videoWidth > 0 && dw > 0) {
      try {
        const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
        const scale = Math.max(dw / vw, dh / vh);
        const ox = (dw - vw * scale) / 2, oy = (dh - vh * scale) / 2;

        let rawCx = null, rawCy = null;

        if (poseDetector._blazeface) {
          const preds = await poseDetector.model.estimateFaces(videoEl, false);
          if (preds.length > 0) {
            const p = preds[0];
            rawCx = ((p.topLeft[0] + p.bottomRight[0]) / 2) * scale + ox;
            rawCy = p.topLeft[1] * scale + oy;
          }
        } else {
          const poses = await poseDetector.estimatePoses(videoEl);
          if (poses.length > 0) {
            const kp = poses[0].keypoints;
            const nose = kp[0], leftEar = kp[3], rightEar = kp[4];
            if (nose.score > 0.25) {
              const earY = ((leftEar.score  > 0.2 ? leftEar.y  : nose.y) +
                            (rightEar.score > 0.2 ? rightEar.y : nose.y)) / 2;
              const headH = Math.max(Math.abs(nose.y - earY) * 2.8, 20 / scale);
              rawCx = nose.x * scale + ox;
              rawCy = (nose.y - headH) * scale + oy;
            }
          }
        }

        if (rawCx !== null) {
          if (!spr) {
            spr = { cx: rawCx, cy: rawCy, vx: 0, vy: 0 };
          } else {
            spr.vx += (rawCx - spr.cx) * K;
            spr.vy += (rawCy - spr.cy) * K;
            spr.vx *= DAMP;
            spr.vy *= DAMP;
            spr.cx += spr.vx;
            spr.cy += spr.vy;
          }
          lastSeen = Date.now();
        }

        if (spr && Date.now() - lastSeen < 1500) {
          const age = Date.now() - lastSeen;
          ctx.globalAlpha = age < 800 ? 1 : 1 - (age - 800) / 700;
          drawBubble(ctx, spr.cx, spr.cy, name);
          ctx.globalAlpha = 1;
        }
      } catch (_) {}
    }

    // 物体吹き出し（COCO-SSD bbox → canvas 座標変換して描画）
    if (detectedObjects.length > 0 && videoEl.readyState >= 2 && videoEl.videoWidth > 0 && dw > 0) {
      const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
      const scale = Math.max(dw / vw, dh / vh);
      const ox = (dw - vw * scale) / 2, oy = (dh - vh * scale) / 2;
      for (const obj of detectedObjects) {
        const [bx, by, bww] = obj.bbox;
        const ocx = (bx + bww / 2) * scale + ox;
        const ocy = by * scale + oy;
        drawBubble(ctx, ocx, ocy,
          `${OBJ_EMOJI[obj.class] ?? '📦'} ${OBJ_JP[obj.class] ?? obj.class} ${Math.round(obj.score * 100)}%`,
          'rgba(255,140,0,0.93)');
      }
    }

    if (running) setTimeout(() => { if (running) requestAnimationFrame(loop); }, 500);
  }

  // シーン分類（MobileNet 1000クラス）: 4秒ごと
  async function detectScene() {
    if (!running || !sceneModel || videoEl.readyState < 2) return;
    try {
      const preds = await sceneModel.classify(videoEl, 5);
      const sceneEl = wrapEl.querySelector('.scene-overlay');
      if (sceneEl) {
        sceneEl.innerHTML = preds
          .filter(p => p.probability > 0.08)
          .slice(0, 3)
          .map(p => { const en = p.className.split(',')[0].trim().toLowerCase(); return `<span class="scene-chip">🔍 ${SCENE_JP[en] ?? en} ${Math.round(p.probability * 100)}%</span>`; })
          .join('');
      }
    } catch (_) {}
  }
  const sceneTimer = setInterval(detectScene, 4000);
  detectScene();

  requestAnimationFrame(loop);
  faceTrackers.set(id, { canvas, stop: () => { running = false; clearInterval(emotionTimer); clearInterval(objectTimer); clearInterval(sceneTimer); } });
}

function stopFaceTracker(id) {
  const t = faceTrackers.get(id);
  if (!t) return;
  t.stop();
  t.canvas.remove();
  faceTrackers.delete(id);
}

function stopAllFaceTrackers() {
  for (const id of [...faceTrackers.keys()]) stopFaceTracker(id);
}

function drawBubble(ctx, cx, topY, text, color = 'rgba(108,99,255,0.93)') {
  const pad = 12, fs = 20, r = 10;
  const bh = pad * 2 + fs;

  ctx.save();
  ctx.font = `700 ${fs}px -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif`;
  const tw = ctx.measureText(text).width;
  const bw = tw + pad * 2;
  const cw = ctx.canvas.width;
  const bx = Math.max(4, Math.min(cx - bw / 2, cw - bw - 4));
  const by = Math.max(4, topY - bh - 12);

  ctx.shadowColor = 'rgba(0,0,0,0.4)';
  ctx.shadowBlur = 12;
  ctx.fillStyle = color;
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(bx, by, bw, bh, r);
  } else {
    ctx.moveTo(bx + r, by);
    ctx.lineTo(bx + bw - r, by); ctx.arcTo(bx + bw, by, bx + bw, by + r, r);
    ctx.lineTo(bx + bw, by + bh - r); ctx.arcTo(bx + bw, by + bh, bx + bw - r, by + bh, r);
    ctx.lineTo(bx + r, by + bh); ctx.arcTo(bx, by + bh, bx, by + bh - r, r);
    ctx.lineTo(bx, by + r); ctx.arcTo(bx, by, bx + r, by, r);
    ctx.closePath();
  }
  ctx.fill();

  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.moveTo(cx - 8, by + bh);
  ctx.lineTo(cx + 8, by + bh);
  ctx.lineTo(cx, by + bh + 11);
  ctx.closePath();
  ctx.fill();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  ctx.fillText(text, bx + bw / 2, by + bh / 2);
  ctx.restore();
}

async function initEmotionDetection() {
  try {
    // face-api.js@0.22.2 は UMD バンドルで TF.js を内包 → window.faceapi を安定して露出
    await loadScript('https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js');
    const MODEL = 'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/weights';
    await Promise.all([
      window.faceapi.nets.tinyFaceDetector.loadFromUri(MODEL),
      window.faceapi.nets.faceExpressionNet.loadFromUri(MODEL),
    ]);
    emotionReady = true;
    console.log('[emotion] face-api ready');
  } catch (e) {
    console.warn('[emotion] face-api failed:', e.message);
  }
}

async function initObjectDetection() {
  try {
    await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.2/dist/coco-ssd.min.js');
    objectDetector = await window.cocoSsd.load();
    console.log('[objects] COCO-SSD ready');
  } catch (e) {
    console.warn('[objects] COCO-SSD failed:', e.message);
  }
}

async function initSceneDetection() {
  // 処理負荷が高いため無効化
}

// モデルを順次ロード（メモリ節約）。MobileNetは最後に遅延ロード
initEmotionDetection().catch(() => {});
initFaceDetection()
  .then(() => initObjectDetection())
  .then(() => new Promise(r => setTimeout(r, 5000))) // 5秒待ってからMobileNet
  .then(() => initSceneDetection())
  .catch(() => {});

// ─── Socket setup ─────────────────────────────────────────────────────────────

const socket = io({ secure: true });

let inConference = false; // true while in a conference room
let keepaliveTimer = null;

function startKeepalive() {
  stopKeepalive();
  const ping = () => fetch('/ping?t=' + Date.now(), { cache: 'no-store' }).catch(() => {});
  ping(); // immediate first ping
  keepaliveTimer = setInterval(ping, 30000); // every 30s — keeps fly.io machine alive
}

function stopKeepalive() {
  if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
}

socket.on('connect', () => {
  setConnected(true);
  console.log('[socket] connected:', socket.id);
  if (inConference) {
    console.log('[socket] reconnected while in conference — rejoining...');
    setConfStatus('再接続中...');
    rejoin().catch((e) => console.error('[rejoin]', e));
  }
});

socket.on('disconnect', (reason) => {
  setConnected(false);
  console.warn('[socket] disconnected:', reason);
  if (inConference) {
    setConfStatus('接続切れ — 再接続中...');
    cleanupTransports();
  }
});

socket.on('connect_error', (err) => {
  setConnected(false);
  console.error('[socket] connect_error:', err.message);
});

function setConnected(ok) {
  if (!connIndicator || !connLabel) return;
  connIndicator.className = 'dot ' + (ok ? 'green' : 'red');
  connLabel.textContent   = ok ? 'サーバー接続中' : 'サーバー未接続';
  if (joinBtn) joinBtn.disabled = !ok;
}

// Start disconnected until socket connects
setConnected(false);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function emitAsync(event, data, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    if (!socket.connected) {
      return reject(new Error('サーバーに接続できていません'));
    }
    const timer = setTimeout(() => {
      reject(new Error(`タイムアウト: ${event} の応答がありませんでした`));
    }, timeoutMs);

    socket.emit(event, data, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

function setJoinStatus(msg, isError = false) {
  if (!joinStatus) return;
  joinStatus.textContent = msg;
  joinStatus.style.color = isError ? '#e74c3c' : '#888';
}

function setConfStatus(msg) {
  if (confStatus) confStatus.textContent = msg;
}

function updateParticipantCount() {
  if (participantCnt) participantCnt.textContent = `参加者 ${peers.size + 1}人`;
}

// ─── Join ─────────────────────────────────────────────────────────────────────

async function join() {
  // Secure context check
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
    setJoinStatus('HTTPS または localhost からアクセスしてください（カメラには安全な接続が必要です）', true);
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    setJoinStatus('このブラウザはカメラ/マイクにアクセスできません（HTTPSが必要）', true);
    return;
  }

  roomId      = roomInput.value.trim()  || 'room-001';
  displayName = nameInput.value.trim()  || `User-${Math.floor(Math.random() * 9999)}`;

  joinBtn.disabled = true;
  setJoinStatus('カメラ・マイクを取得中...');

  try {
    // 1. Local stream (4K → 1080p fallback)
    localStream = await getLocalStream();
    localVideo.srcObject = localStream;
    localName.textContent = displayName + ' (あなた)';
    await populateCameraSelect();

    const vt = localStream.getVideoTracks()[0];
    if (vt) {
      const s = vt.getSettings();
      localRes.textContent = `${s.width ?? '?'}×${s.height ?? '?'} ${Math.round(s.frameRate ?? 0)}fps`;
    }

    // 2. Join room
    setJoinStatus('サーバーに参加リクエストを送信中...');
    const joinRes = await emitAsync('join', { roomId, displayName });
    if (joinRes.error) throw new Error('join エラー: ' + joinRes.error);

    const { routerRtpCapabilities, existingProducers, iceServers } = joinRes;

    // 3. Load mediasoup Device
    setJoinStatus('WebRTC デバイスを初期化中...');
    device = new Device();
    await device.load({ routerRtpCapabilities });

    // 4. Create transports (with TURN servers for NAT/IPv6 fallback)
    setJoinStatus('トランスポートを確立中...');
    await createSendTransport(iceServers);
    await createRecvTransport(iceServers);

    // 5. Produce
    setJoinStatus('メディアを送信中...');
    await produceMedia();

    // 6. Consume existing producers
    for (const p of existingProducers) {
      await consumeProducer(p).catch((e) => console.warn('consume existing failed:', e));
    }

    // 7. Switch UI
    inConference = true;
    startKeepalive();
    startTranscription();
    lastBwStats = { sendBytes: 0, recvBytes: 0, time: 0 };
    lastQualityStats = { limitReason: null, frameWidth: 0, frameHeight: 0, fps: 0, nackCount: 0, upKbps: 0 };
    bandwidthTimer = setInterval(updateBandwidth, 3000);
    joinSection.classList.add('hidden');
    confSection.classList.remove('hidden');
    confRoomLabel.textContent = `ルーム: ${roomId}`;

    const hasVideo = localStream.getVideoTracks().length > 0;
    if (hasVideo) {
      setConfStatus('接続中...');
    } else {
      const err = window._cameraError;
      setConfStatus(`⚠ カメラ不可 (${err?.name ?? '—'}): ${err?.hint ?? 'カメラを確認してください'} — [カメラ再試行]ボタンを押してください`);
      localRes.textContent = 'マイクのみ';
      $('video-btn').textContent = 'カメラ再試行';
      $('video-btn').style.borderColor = '#e74c3c';
      $('video-btn').style.color = '#e74c3c';
    }
    updateParticipantCount();

  } catch (err) {
    console.error('Join error:', err);
    setJoinStatus('エラー: ' + err.message, true);
    joinBtn.disabled = !socket.connected;
  }
}

async function getLocalStream() {
  // Log available devices for diagnosis
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter(d => d.kind === 'videoinput');
    const mics = devices.filter(d => d.kind === 'audioinput');
    console.log(`[devices] cameras: ${cams.length}, mics: ${mics.length}`, cams.map(d => d.label || d.deviceId));
  } catch (e) {
    console.warn('[devices] enumerateDevices failed:', e.message);
  }

  const audio = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    sampleRate: { ideal: 48000 },
    channelCount: { ideal: 2 },
  };

  const videoProfiles = [
    { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },  // HD start (低負荷)
    { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
    true,  // absolute minimum: any camera at any resolution
  ];

  let lastErr;
  for (const video of videoProfiles) {
    try {
      return await navigator.mediaDevices.getUserMedia({ video, audio });
    } catch (e) {
      lastErr = e;
      console.warn(`[camera] profile failed (${JSON.stringify(video)}):`, e.name, e.message);
      if (e.name === 'NotAllowedError') throw e; // Permission denied – no point retrying
    }
  }

  // Audio-only fallback
  try {
    const errName = lastErr?.name ?? '不明';
    const hint = errName === 'NotAllowedError'   ? 'ブラウザのカメラ許可を確認してください' :
                 errName === 'NotReadableError'   ? 'カメラが他のアプリ(Zoom等)で使用中の可能性があります' :
                 errName === 'NotFoundError'      ? 'カメラデバイスが見つかりません' :
                 errName === 'OverconstrainedError' ? 'カメラの解像度設定に対応していません' :
                 'カメラにアクセスできません';
    console.warn('[camera] Falling back to audio only. Error:', errName, lastErr?.message);
    setJoinStatus(`⚠ カメラ不可 (${errName}): ${hint}`);
    window._cameraError = { name: errName, hint };
    return await navigator.mediaDevices.getUserMedia({ video: false, audio });
  } catch (_) {
    throw lastErr ?? new Error('カメラ・マイクにアクセスできません');
  }
}

// ─── Transports ───────────────────────────────────────────────────────────────

function logIceState(label, pc) {
  if (!pc) return;
  console.log(`[ICE:${label}] ice=${pc.iceConnectionState} conn=${pc.connectionState} gather=${pc.iceGatheringState}`);
}

async function createSendTransport(iceServers) {
  const params = await emitAsync('createTransport', { direction: 'send' });
  if (params.error) throw new Error('sendTransport: ' + params.error);
  console.log('[send] iceCandidates:', JSON.stringify(params.iceCandidates?.map(c => c.protocol+':'+c.address+':'+c.port)));

  sendTransport = device.createSendTransport({ ...params, iceServers });

  sendTransport.on('connect', async ({ dtlsParameters }, cb, eb) => {
    try {
      const res = await emitAsync('connectTransport', { transportId: sendTransport.id, dtlsParameters });
      res?.error ? eb(new Error(res.error)) : cb();
    } catch (e) { eb(e); }
  });

  sendTransport.on('produce', async ({ kind, rtpParameters, appData }, cb, eb) => {
    try {
      const res = await emitAsync('produce', { transportId: sendTransport.id, kind, rtpParameters, appData });
      res?.error ? eb(new Error(res.error)) : cb({ id: res.id });
    } catch (e) { eb(e); }
  });

  sendTransport.on('connectionstatechange', (s) => {
    console.log('[send transport] state:', s);
    if (s === 'failed') {
      console.error('[send transport] ICE failed — IPv6 connectivity required');
      setConfStatus('⚠ 送信ICE失敗 — IPv6ネットワークが必要な可能性があります');
      sendTransport.close();
    } else if (s === 'connected') {
      setConfStatus('接続済み ✓');
    } else {
      setConfStatus('送信: ' + s);
    }
  });
}

async function createRecvTransport(iceServers) {
  const params = await emitAsync('createTransport', { direction: 'recv' });
  if (params.error) throw new Error('recvTransport: ' + params.error);
  console.log('[recv] iceCandidates:', JSON.stringify(params.iceCandidates?.map(c => c.protocol+':'+c.address+':'+c.port)));

  recvTransport = device.createRecvTransport({ ...params, iceServers });

  recvTransport.on('connect', async ({ dtlsParameters }, cb, eb) => {
    try {
      const res = await emitAsync('connectTransport', { transportId: recvTransport.id, dtlsParameters });
      res?.error ? eb(new Error(res.error)) : cb();
    } catch (e) { eb(e); }
  });

  recvTransport.on('connectionstatechange', (s) => {
    console.log('[recv transport] state:', s);
    if (s === 'failed') {
      console.error('[recv transport] ICE failed — IPv6 connectivity required');
      setConfStatus('⚠ 受信ICE失敗 — 相手の映像を受け取れません (IPv6が必要な可能性)');
      recvTransport.close();
    }
  });
}

// ─── Cleanup and Rejoin (for reconnection after server restart) ───────────────

function cleanupTransports() {
  stopAllFaceTrackers();
  try { sendTransport?.close(); } catch (_) {}
  try { recvTransport?.close(); } catch (_) {}
  sendTransport = recvTransport = null;
  audioProducer = videoProducer = null;
  for (const { consumer } of consumers.values()) {
    try { consumer.close(); } catch (_) {}
  }
  consumers.clear();
  for (const peerId of peers.keys()) removePeer(peerId);
}

async function rejoin() {
  if (!inConference || !roomId || !displayName) return;
  cleanupTransports();

  try {
    // Re-use existing local stream if still alive
    if (!localStream || localStream.getTracks().some(t => t.readyState === 'ended')) {
      localStream = await getLocalStream();
      localVideo.srcObject = localStream;
    }

    const joinRes = await emitAsync('join', { roomId, displayName });
    if (joinRes.error) throw new Error('rejoin エラー: ' + joinRes.error);
    const { routerRtpCapabilities, existingProducers, iceServers } = joinRes;

    device = new Device();
    await device.load({ routerRtpCapabilities });

    await createSendTransport(iceServers);
    await createRecvTransport(iceServers);
    await produceMedia();
    for (const p of existingProducers) {
      await consumeProducer(p).catch((e) => console.warn('consume after rejoin failed:', e));
    }

    setConfStatus('再接続済み ✓');
    updateParticipantCount();
    console.log('[rejoin] complete');
  } catch (err) {
    console.error('[rejoin] failed:', err);
    setConfStatus('再接続失敗: ' + err.message);
  }
}

// ─── Produce ──────────────────────────────────────────────────────────────────

async function produceMedia() {
  const audioTrack = localStream.getAudioTracks()[0];
  if (audioTrack) {
    audioProducer = await sendTransport.produce({
      track: audioTrack,
      codecOptions: { opusStereo: true, opusDtx: true, opusFec: true },
    });
  }

  const videoTrack = localStream.getVideoTracks()[0];
  if (videoTrack) {
    videoProducer = await sendTransport.produce({
      track: videoTrack,
      encodings: [{ maxBitrate: 5_000_000 }],
      codecOptions: {
        videoGoogleStartBitrate: 500,   // 500kbps スタート → GCCが徐々にランプアップ
        videoGoogleMaxBitrate: 5000,    // HD上限 5Mbps
        videoGoogleMinBitrate: 100,
      },
    });

    const codec = videoProducer.rtpParameters.codecs[0]?.mimeType?.split('/')[1] ?? '?';
    localRes.textContent += ` | ${codec.toUpperCase()}`;
    setConfStatus('接続済み · ' + codec.toUpperCase());
  }
}

// ─── Consume ──────────────────────────────────────────────────────────────────

async function consumeProducer({ producerId, peerId, displayName: peerName, kind }) {
  const params = await emitAsync('consume', {
    producerId,
    rtpCapabilities: device.rtpCapabilities,
    transportId: recvTransport.id,
  });

  if (params.error) throw new Error('consume: ' + params.error);

  const consumer = await recvTransport.consume({
    id: params.id,
    producerId: params.producerId,
    kind: params.kind,
    rtpParameters: params.rtpParameters,
  });

  consumers.set(consumer.id, { consumer, peerId });

  await emitAsync('resumeConsumer', { consumerId: consumer.id });

  // Add peer UI if new
  if (!peers.has(peerId)) {
    peers.set(peerId, { displayName: peerName, stream: new MediaStream() });
    renderPeer(peerId, peerName);
    updateParticipantCount();
  }

  peers.get(peerId).stream.addTrack(consumer.track);

  const videoEl = $(`video-${peerId}`);
  if (videoEl) {
    videoEl.srcObject = peers.get(peerId).stream;
    if (kind === 'video') {
      videoEl.addEventListener('loadedmetadata', () => {
        const el = $(`res-${peerId}`);
        if (el && videoEl.videoWidth) el.textContent = `${videoEl.videoWidth}×${videoEl.videoHeight}`;
      });
      videoEl.addEventListener('play', () => {
        const wrap = $(`peer-${peerId}`);
        if (wrap) startFaceTracker(videoEl, wrap, peerName);
      }, { once: true });
    }
  }

  consumer.on('trackended', () => {
    consumers.delete(consumer.id);
    if (![...consumers.values()].some((c) => c.peerId === peerId)) removePeer(peerId);
  });
}

// ─── Peer UI ──────────────────────────────────────────────────────────────────

function renderPeer(peerId, peerName) {
  const div = document.createElement('div');
  div.className = 'video-wrap';
  div.id = `peer-${peerId}`;
  div.innerHTML = `
    <video id="video-${peerId}" autoplay playsinline></video>
    <div class="name-tag">${escapeHtml(peerName)}</div>
    <div class="res-tag" id="res-${peerId}">接続中...</div>
    <div class="emotion-overlay"></div>
    <div class="scene-overlay"></div>
    <div class="subtitle" id="sub-${peerId}"></div>`;
  videoGrid.appendChild(div);
}

function removePeer(peerId) {
  stopFaceTracker(`video-${peerId}`);
  $(`peer-${peerId}`)?.remove();
  peers.delete(peerId);
  updateParticipantCount();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ─── 文字起こし (Web Speech API) ──────────────────────────────────────────────

function startTranscription() {
  stopTranscription();
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = navigator.language || 'ja-JP';
  let lastFinal = '';
  const mySubEl = $('my-subtitle');
  rec.onresult = (e) => {
    let final = '', interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) final += e.results[i][0].transcript;
      else interim += e.results[i][0].transcript;
    }
    const text = (final || interim).trim();
    if (!text) return;
    if (mySubEl) {
      mySubEl.textContent = text;
      mySubEl.style.opacity = '1';
      clearTimeout(mySubEl._t);
      mySubEl._t = setTimeout(() => { mySubEl.style.opacity = '0'; }, 3000);
    }
    if (final && final !== lastFinal) {
      lastFinal = final;
      emitAsync('transcript', { text: final.trim() }, 5000).catch(() => {});
    }
  };
  rec.onerror = (e) => { if (e.error !== 'no-speech') console.warn('[transcript]', e.error); };
  rec.onend = () => { if (inConference && transcriptionRec === rec) { try { rec.start(); } catch (_) {} } };
  try { rec.start(); transcriptionRec = rec; } catch (_) {}
}

function stopTranscription() {
  if (transcriptionRec) { try { transcriptionRec.stop(); } catch (_) {} transcriptionRec = null; }
}

// ─── 帯域幅モニタリング ────────────────────────────────────────────────────────

function fmtKbps(kbps) {
  return kbps >= 1000 ? (kbps / 1000).toFixed(1) + 'Mbps' : kbps + 'kbps';
}

function showQualityLog(direction, message) {
  const log = document.getElementById('quality-log');
  if (!log) return;
  const time = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const el = document.createElement('div');
  el.className = `quality-msg ${direction}`;
  el.textContent = `${time}　${message}`;
  log.prepend(el);
  setTimeout(() => el.remove(), 9500);
}

const LIMIT_REASON_JP = {
  bandwidth: '帯域不足',
  cpu:       'CPU負荷',
  other:     'その他の制約',
};

async function updateBandwidth() {
  if (!inConference) return;

  let sendBytes = 0, recvBytes = 0;
  let limitReason = 'none', frameWidth = 0, frameHeight = 0, fps = 0, nackCount = 0;

  try {
    if (sendTransport && !sendTransport.closed) {
      const stats = await sendTransport.getStats();
      for (const s of stats.values()) {
        if (s.type === 'outbound-rtp') {
          sendBytes += (s.bytesSent ?? 0);
          if (s.kind === 'video') {
            limitReason  = s.qualityLimitationReason ?? 'none';
            frameWidth   = s.frameWidth   ?? 0;
            frameHeight  = s.frameHeight  ?? 0;
            fps          = Math.round(s.framesPerSecond ?? 0);
            nackCount    = s.nackCount    ?? 0;
          }
        }
      }
    }
  } catch (_) {}
  try {
    if (recvTransport && !recvTransport.closed) {
      const stats = await recvTransport.getStats();
      for (const s of stats.values()) {
        if (s.type === 'inbound-rtp') recvBytes += (s.bytesReceived ?? 0);
      }
    }
  } catch (_) {}

  const now = Date.now();
  const bwEl = $('bandwidth');
  let upKbps = 0;

  if (lastBwStats.time > 0) {
    const dt = (now - lastBwStats.time) / 1000;
    if (dt > 0.1) {
      upKbps = Math.round((sendBytes - lastBwStats.sendBytes) * 8 / dt / 1000);
      const down = Math.round((recvBytes - lastBwStats.recvBytes) * 8 / dt / 1000);
      if (bwEl) bwEl.textContent = `↑${fmtKbps(upKbps)} ↓${fmtKbps(down)}`;
    }
  }
  lastBwStats = { sendBytes, recvBytes, time: now };

  // ── 品質変化の理由を通知 ──────────────────────────────────────────────
  const prev = lastQualityStats;

  // 品質制限理由が変わった（初回 null → 何か は通知しない）
  if (prev.limitReason !== null && limitReason !== prev.limitReason) {
    if (limitReason === 'bandwidth') {
      showQualityLog('down', `📉 帯域不足のため映像品質を自動で下げています（GCC が輻輳を検出）`);
    } else if (limitReason === 'cpu') {
      showQualityLog('down', `⚙️ CPU負荷が高いため映像品質を自動で下げています`);
    } else if (limitReason === 'other') {
      showQualityLog('down', `⚠️ エンコーダーの制約により映像品質を下げています`);
    } else if (limitReason === 'none' && prev.limitReason !== 'none') {
      showQualityLog('up', `📈 ネットワークが安定しました（品質制限を解除）`);
    }
  }

  // 解像度が変わった
  if (frameWidth > 0 && prev.frameWidth > 0 && frameWidth !== prev.frameWidth) {
    const dir = frameWidth < prev.frameWidth ? 'down' : 'up';
    const arrow = dir === 'down' ? '📉' : '📈';
    const reason = limitReason === 'bandwidth' ? '（帯域不足）'
                 : limitReason === 'cpu'       ? '（CPU負荷）'
                 : '';
    showQualityLog(dir, `${arrow} 解像度が ${prev.frameWidth}×${prev.frameHeight} → ${frameWidth}×${frameHeight} に変更されました${reason}`);
  }

  // フレームレートが 5fps 以上変化した
  if (fps > 0 && prev.fps > 0 && Math.abs(fps - prev.fps) >= 5) {
    const dir = fps < prev.fps ? 'down' : 'up';
    const arrow = dir === 'down' ? '📉' : '📈';
    showQualityLog(dir, `${arrow} フレームレートが ${prev.fps}fps → ${fps}fps に変化しました`);
  }

  // NACK が3秒で 10件超（パケットロス増加）
  if (prev.nackCount > 0 && nackCount - prev.nackCount > 10) {
    showQualityLog('down', `⚠️ パケット再送要求が増加しています（+${nackCount - prev.nackCount}件）— ネットワーク輻輳の可能性`);
  }

  // 送信帯域が 40% 以上変化（かつ絶対値が 100kbps 超）
  if (upKbps > 0 && prev.upKbps > 100) {
    const ratio = upKbps / prev.upKbps;
    if (ratio < 0.6) {
      const reason = limitReason === 'bandwidth' ? '（GCC が帯域制限を検出）' : '';
      showQualityLog('down', `📉 送信帯域が ${fmtKbps(prev.upKbps)} → ${fmtKbps(upKbps)} に減少しました${reason}`);
    } else if (ratio > 1.6) {
      showQualityLog('up', `📈 送信帯域が ${fmtKbps(prev.upKbps)} → ${fmtKbps(upKbps)} に増加しました`);
    }
  }

  lastQualityStats = { limitReason, frameWidth, frameHeight, fps, nackCount, upKbps };
}

// ─── Socket events ────────────────────────────────────────────────────────────

socket.on('newProducer', (data) => {
  consumeProducer(data).catch((e) => console.warn('[newProducer] consume failed:', e));
});

socket.on('workerRestart', () => {
  console.warn('[server] Worker restarted — rejoining automatically');
  if (!inConference) return;
  setConfStatus('⚠ サーバー再起動中… 自動再接続します');
  cleanupTransports();
  setTimeout(() => rejoin().catch((e) => {
    console.error('[rejoin after workerRestart]', e);
    setConfStatus('⚠ 再接続失敗 — ページをリロードしてください');
  }), 2000);
});

socket.on('peerLeft', ({ peerId }) => {
  for (const [cid, { consumer, peerId: pid }] of consumers) {
    if (pid === peerId) { consumer.close(); consumers.delete(cid); }
  }
  removePeer(peerId);
});

socket.on('consumerClosed', ({ consumerId }) => {
  const e = consumers.get(consumerId);
  if (!e) return;
  e.consumer.close();
  consumers.delete(consumerId);
  if (![...consumers.values()].some((c) => c.peerId === e.peerId)) removePeer(e.peerId);
});

socket.on('producerPaused', ({ peerId }) => {
  $(`peer-${peerId}`)?.classList.add('paused');
});

socket.on('producerResumed', ({ peerId }) => {
  $(`peer-${peerId}`)?.classList.remove('paused');
});

socket.on('transcript', ({ peerId, text }) => {
  const subEl = $(`sub-${peerId}`);
  if (!subEl) return;
  subEl.textContent = text;
  subEl.style.opacity = '1';
  clearTimeout(subEl._t);
  subEl._t = setTimeout(() => { subEl.style.opacity = '0'; }, 4000);
});

// ─── Controls ─────────────────────────────────────────────────────────────────

muteBtn.addEventListener('click', async () => {
  if (!audioProducer) return;
  if (audioProducer.paused) {
    audioProducer.resume();
    await emitAsync('resumeProducer', { producerId: audioProducer.id }).catch(() => {});
    muteBtn.textContent = 'マイクOFF';
    muteBtn.classList.remove('active');
  } else {
    audioProducer.pause();
    await emitAsync('pauseProducer', { producerId: audioProducer.id }).catch(() => {});
    muteBtn.textContent = 'マイクON';
    muteBtn.classList.add('active');
  }
});

videoBtn.addEventListener('click', async () => {
  // If no video producer exists, try to start camera now
  if (!videoProducer) {
    videoBtn.disabled = true;
    videoBtn.textContent = '取得中...';
    try {
      const videoStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      });
      const track = videoStream.getVideoTracks()[0];
      // Replace local video display
      if (localStream) {
        localStream.addTrack(track);
      } else {
        localStream = new MediaStream([track]);
      }
      localVideo.srcObject = localStream;
      const s = track.getSettings();
      localRes.textContent = `${s.width ?? '?'}×${s.height ?? '?'} ${Math.round(s.frameRate ?? 0)}fps`;
      // Produce video
      if (sendTransport && !sendTransport.closed) {
        videoProducer = await sendTransport.produce({
          track,
          encodings: [{ maxBitrate: 5_000_000 }],
          codecOptions: { videoGoogleStartBitrate: 500, videoGoogleMaxBitrate: 5000, videoGoogleMinBitrate: 100 },
        });
        const codec = videoProducer.rtpParameters.codecs[0]?.mimeType?.split('/')[1] ?? '?';
        localRes.textContent += ` | ${codec.toUpperCase()}`;
        setConfStatus('接続済み ✓ (カメラ追加成功)');
      }
      videoBtn.textContent = 'カメラOFF';
      videoBtn.style.borderColor = '';
      videoBtn.style.color = '';
      window._cameraError = null;
    } catch (e) {
      const hint = e.name === 'NotAllowedError'  ? '許可を確認' :
                   e.name === 'NotReadableError'  ? '他アプリを終了して再試行' :
                   e.name === 'NotFoundError'     ? 'カメラ未検出' : e.name;
      setConfStatus(`⚠ カメラ再試行失敗 (${hint}) — 他のアプリを閉じてから押してください`);
      videoBtn.textContent = 'カメラ再試行';
    } finally {
      videoBtn.disabled = false;
    }
    return;
  }

  if (videoProducer.paused) {
    videoProducer.resume();
    await emitAsync('resumeProducer', { producerId: videoProducer.id }).catch(() => {});
    videoBtn.textContent = 'カメラOFF';
    videoBtn.classList.remove('active');
    $('local-wrap')?.classList.remove('paused');
  } else {
    videoProducer.pause();
    await emitAsync('pauseProducer', { producerId: videoProducer.id }).catch(() => {});
    videoBtn.textContent = 'カメラON';
    videoBtn.classList.add('active');
    $('local-wrap')?.classList.add('paused');
  }
});

async function populateCameraSelect() {
  if (!cameraSelect) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter(d => d.kind === 'videoinput');
    const currentId = localStream?.getVideoTracks()[0]?.getSettings().deviceId;

    cameraSelect.innerHTML = '';
    if (cameras.length === 0) {
      const opt = document.createElement('option');
      opt.textContent = 'カメラなし';
      cameraSelect.appendChild(opt);
      cameraSelect.disabled = true;
      return;
    }

    cameras.forEach((cam, i) => {
      const opt = document.createElement('option');
      opt.value = cam.deviceId;
      opt.textContent = cam.label || `カメラ ${i + 1}`;
      if (cam.deviceId === currentId) opt.selected = true;
      cameraSelect.appendChild(opt);
    });
    cameraSelect.disabled = cameras.length <= 1;
  } catch (e) {
    console.warn('[camera-select] enumerateDevices failed:', e.message);
  }
}

navigator.mediaDevices?.addEventListener('devicechange', () => {
  if (inConference) populateCameraSelect();
});

cameraSelect.addEventListener('change', async () => {
  if (!videoProducer || videoProducer.closed) return;
  const deviceId = cameraSelect.value;
  cameraSelect.disabled = true;

  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    });
    const newTrack = newStream.getVideoTracks()[0];

    localStream.getVideoTracks().forEach(t => { t.stop(); localStream.removeTrack(t); });
    localStream.addTrack(newTrack);
    localVideo.srcObject = localStream;

    await videoProducer.replaceTrack({ track: newTrack });

    const s = newTrack.getSettings();
    localRes.textContent = `${s.width ?? '?'}×${s.height ?? '?'} ${Math.round(s.frameRate ?? 0)}fps`;
  } catch (e) {
    console.warn('[camera-switch]', e.name, e.message);
    setConfStatus(`⚠ カメラ切替失敗 (${e.name})`);
    await populateCameraSelect();
  } finally {
    cameraSelect.disabled = false;
  }
});

leaveBtn.addEventListener('click', () => {
  inConference = false;
  stopKeepalive();
  stopTranscription();
  if (bandwidthTimer) { clearInterval(bandwidthTimer); bandwidthTimer = null; }
  const bwEl = $('bandwidth');
  if (bwEl) bwEl.textContent = '';
  cleanupTransports();
  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;

  videoGrid.innerHTML = '';
  confSection.classList.add('hidden');
  joinSection.classList.remove('hidden');
  setJoinStatus('');
  joinBtn.disabled = !socket.connected;
});

// ─── Entry ────────────────────────────────────────────────────────────────────

joinBtn.addEventListener('click', join);
roomInput.addEventListener('keypress', (e) => e.key === 'Enter' && join());
nameInput.addEventListener('keypress', (e) => e.key === 'Enter' && join());
