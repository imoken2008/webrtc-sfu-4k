'use strict';
/**
 * BRIO 送出ページ（Raspberry Pi 5 上で http://localhost で開く前提）
 *
 * 秘書ダッシュボードの SFU ハブ(room: secretary-cam)へ、Pi 5 に挿した
 * Logitech BRIO の映像を publish する。ダッシュボードは受信専用なので、
 * カメラを部屋へ「出す」役をこのページが担う。
 *
 * getUserMedia はセキュアコンテキスト必須 → localhost 例外を使うため、
 * 必ず Pi 5 実機の Chromium で http://localhost:PORT/ として開くこと。
 * 平文の LAN アドレス(192.168.x)で開くとカメラが取れない。
 *
 * URL パラメータ:
 *   ?res=720|1080|4k     送出解像度（既定 720）
 *   ?hub=http://host:port SFU ハブ URL（既定 http://sfu-hub.local:8080）
 *   ?codec=video/H264     コーデック強制（未指定なら自動。4Kは H264/VP9 推奨）
 *   ?audio=0             音声を送らない
 */
require('./dashboard_sfu.js');           // window.SecretaryCam を生成
const cam = window.SecretaryCam;

const RES = { '720': [1280, 720], '1080': [1920, 1080], '4k': [3840, 2160] };
const q = new URLSearchParams(location.search);
const resKey = (q.get('res') || '720').toLowerCase();
const [W, H] = RES[resKey] || RES['720'];
const HUB = q.get('hub') || 'http://sfu-hub.local:8080';
const CODEC = q.get('codec') || undefined;
const WITH_AUDIO = q.get('audio') !== '0';

const $ = (id) => document.getElementById(id);
const setStatus = (t) => { $('status').textContent = t; };
const log = (t) => {
  const el = $('log');
  el.textContent = `[${new Date().toLocaleTimeString()}] ${t}\n` + el.textContent;
};

let lastBytes = 0, lastTs = 0;

async function statsLoop() {
  const prod = (cam.localProducers || []).find(
    (p) => p.track && p.track.kind === 'video');
  if (prod && !prod.closed) {
    try {
      const report = await prod.getStats();
      report.forEach((r) => {
        if (r.type === 'outbound-rtp' && r.kind === 'video') {
          const now = r.timestamp;
          let kbps = 0;
          if (lastTs) kbps = Math.round((r.bytesSent - lastBytes) * 8 / (now - lastTs));
          lastBytes = r.bytesSent; lastTs = now;
          const fps = r.framesPerSecond != null ? Math.round(r.framesPerSecond) : '?';
          const enc = r.encoderImplementation || '?';
          $('stats').textContent =
            `送出 ${r.frameWidth || '?'}×${r.frameHeight || '?'}  ` +
            `${fps}fps  ${kbps} kbps  encoder=${enc}  ` +
            `送信フレーム=${r.framesSent ?? '?'}  ` +
            `品質制限=${r.qualityLimitationReason || 'none'}`;
        }
      });
    } catch (_) {}
  }
  setTimeout(statsLoop, 1000);
}

async function main() {
  $('info').textContent = `解像度=${resKey}(${W}×${H})  hub=${HUB}  codec=${CODEC || '自動'}  audio=${WITH_AUDIO}`;
  if (!cam.canPublish()) {
    setStatus('❌ セキュアコンテキストではありません');
    log('このページを http://localhost で開いていますか？ LAN アドレスだと getUserMedia が拒否されます。');
    return;
  }
  try {
    setStatus('ハブへ接続中…');
    await cam.start({
      hubUrl: HUB,
      roomId: 'secretary-cam',
      displayName: 'brio-pi5',
      onStatus: (st, d) => log(`sfu: ${st}${d ? ' — ' + d : ''}`),
    });
    setStatus('カメラ取得＆送出中…');
    const stream = await cam.publish({
      video: true, audio: WITH_AUDIO,
      width: W, height: H, frameRate: 30,
      codecMime: CODEC,
    });
    $('preview').srcObject = stream;
    const vt = stream.getVideoTracks()[0];
    const s = vt.getSettings();
    setStatus(`✅ 送出中: ${s.width}×${s.height}@${Math.round(s.frameRate || 0)}fps`);
    log(`publish 成功: ${s.width}×${s.height}@${Math.round(s.frameRate || 0)} deviceId=${(s.deviceId || '').slice(0, 8)}`);
    statsLoop();
  } catch (e) {
    setStatus('❌ ' + e.message);
    log('エラー: ' + (e.stack || e.message));
  }
}

document.addEventListener('DOMContentLoaded', main);
