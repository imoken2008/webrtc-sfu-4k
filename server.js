'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');
const { spawn } = require('child_process');

// ─── Configuration ───────────────────────────────────────────────────────────

const IS_PROD    = process.env.NODE_ENV === 'production';
const PORT       = parseInt(process.env.PORT    || (IS_PROD ? '8080' : '3443'), 10);
const RTC_PORT   = parseInt(process.env.RTC_PORT || '10000', 10);
// 映像を送る側（getUserMedia を使うページ）向けの HTTPS 待受。
// 0 を指定すると HTTPS を立てない。
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '8443', 10);
const ANNOUNCED_IP = process.env.ANNOUNCED_IP || (() => {
  // Auto-detect first non-loopback global IP from OS interfaces
  const os = require('os');
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface) {
      if (!addr.internal && addr.family === 'IPv6' && !addr.address.startsWith('fe80') && !addr.address.startsWith('fd')) {
        return addr.address;
      }
    }
  }
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface) {
      if (!addr.internal && addr.family === 'IPv4') return addr.address;
    }
  }
  return '127.0.0.1';
})();

// STUN servers for ICE candidate gathering
// NOTE: TURN servers require a separate paid/hosted service for IPv4↔IPv6 relay.
// Users on IPv6 networks (common in Japan) can connect directly without TURN.
// LAN環境では外部STUNは不要（外部STUNがICE gatheringを遅延させ不安定化を招く）
const IS_LAN_IP = !ANNOUNCED_IP.includes(':') && (
  ANNOUNCED_IP.startsWith('192.168.') ||
  ANNOUNCED_IP.startsWith('10.')      ||
  ANNOUNCED_IP.startsWith('172.')
);
const ICE_SERVERS = IS_LAN_IP ? [] : [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.nextcloud.com:443' },
];

console.log(`[config] IS_PROD=${IS_PROD}  PORT=${PORT}  RTC_PORT=${RTC_PORT}  ANNOUNCED_IP=${ANNOUNCED_IP}`);

const MEDIA_CODECS = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    parameters: { minptime: 10, useinbandfec: 1 },
  },
  {
    kind: 'video',
    mimeType: 'video/VP9',
    clockRate: 90000,
    parameters: { 'profile-id': 0 },
  },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      // 42e034 = Constrained Baseline / Level 5.2。
      //
      // プロファイルは Baseline から動かしてはいけない。ブラウザが受信可能と
      // 宣言する H264 は Constrained Baseline だけのことが多く（実測: Chrome は
      // 42e01f のみ）、High(640034) を宣言すると router.canConsume() が false に
      // なって「接続はできるが映像が出ない」状態になる。
      //
      // レベルだけ 3.1→5.2 に上げてある。3.1 は規格上 1280x720@30 までで、
      // それ以上の解像度を流すと宣言と実体が食い違う。
      // level-asymmetry-allowed=1 なので、42e01f しか宣言しない相手とも
      // レベル差を許容して consume できる（実測で確認済み）。
      'profile-level-id': '42e034',
      'level-asymmetry-allowed': 1,
    },
  },
  {
    kind: 'video',
    mimeType: 'video/AV1',
    clockRate: 90000,
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
  },
];

// ─── State ────────────────────────────────────────────────────────────────────

let worker;
let webRtcServer;
const rooms = new Map();
let workerRestartInProgress = false;
let io; // Socket.IO instance — assigned after server creation

// ─── mediasoup ────────────────────────────────────────────────────────────────

async function restartWorker(reason) {
  if (workerRestartInProgress) return;
  workerRestartInProgress = true;
  console.error(`[mediasoup] Worker restart triggered: ${reason}`);

  for (const id of [...rooms.keys()]) {
    try { rooms.get(id)?.router.close(); } catch (_) {}
    rooms.delete(id);
  }
  webRtcServer = null;

  try {
    await createWorker();
    console.log('[mediasoup] Worker restarted successfully');
    // 全クライアントに再接続を促す
    if (io) io.emit('workerRestart');
  } catch (e) {
    console.error('[mediasoup] Restart failed:', e);
    process.exit(1);
  } finally {
    workerRestartInProgress = false;
  }
}

async function createWorker() {
  worker = await mediasoup.createWorker({ logLevel: 'warn' });

  worker.on('died', (err) => restartWorker(`died event: ${err?.message ?? 'unknown'}`));

  // died イベントが発火しないケース（OOM kill等）を補足するヘルスチェック
  const healthTimer = setInterval(async () => {
    if (worker.closed) {
      clearInterval(healthTimer);
      restartWorker('health check: worker.closed=true');
    }
  }, 5000);
  worker.once('died', () => clearInterval(healthTimer));

  // IPv6 announced address → listen on :: , IPv4 → 0.0.0.0
  const rtcListenIp = ANNOUNCED_IP.includes(':') ? '::' : '0.0.0.0';

  // Single WebRtcServer → only ONE port needed (UDP + TCP)
  webRtcServer = await worker.createWebRtcServer({
    listenInfos: [
      { protocol: 'udp', ip: rtcListenIp, announcedAddress: ANNOUNCED_IP, port: RTC_PORT },
      { protocol: 'tcp', ip: rtcListenIp, announcedAddress: ANNOUNCED_IP, port: RTC_PORT },
    ],
  });

  console.log(`[mediasoup] Worker pid=${worker.pid}  WebRtcServer port=${RTC_PORT} (udp+tcp)`);
  return worker;
}

async function getOrCreateRoom(roomId) {
  // Worker が死んでいたら再起動を待つ
  if (worker.closed) {
    await restartWorker('getOrCreateRoom: worker was closed');
  }
  if (!rooms.has(roomId)) {
    const router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });
    // ingests: PlainTransport 経由で外部から流し込まれた producer（カメラ等）。
    // peer と違いソケットに紐づかないので、視聴者が全員抜けても部屋を消してはならない。
    rooms.set(roomId, { router, peers: new Map(), ingests: new Map() });
    console.log(`[room] created: ${roomId}`);
  }
  return rooms.get(roomId);
}

// ─── HTTP / HTTPS server ──────────────────────────────────────────────────────

function createServer(app) {
  if (IS_PROD) {
    // Production: fly.io handles TLS, use plain HTTP
    return require('http').createServer(app);
  }
  // Local dev: self-signed HTTPS (required for camera access)
  return require('https').createServer({
    key:  fs.readFileSync(path.join(__dirname, 'ssl', 'key.pem')),
    cert: fs.readFileSync(path.join(__dirname, 'ssl', 'cert.pem')),
  }, app);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  await createWorker();

  const app = express();
  app.use(express.json());
  app.get('/ping', (_req, res) => res.json({ ok: true }));
  app.get('/health', (_req, res) => {
    const workerAlive = worker && !worker.closed;
    res.status(workerAlive ? 200 : 503).json({ ok: workerAlive, workerPid: worker?.pid ?? null });
  });

  // ─── Bot API ───────────────────────────────────────────────────────────────
  const botProcesses = new Map(); // roomId → ChildProcess

  app.post('/api/bot/join', (req, res) => {
    const { roomId } = req.body;
    if (!roomId) return res.status(400).json({ error: 'roomId required' });
    if (botProcesses.has(roomId)) return res.json({ ok: true, status: 'already_running' });

    const proto = IS_PROD ? 'http' : 'https';
    const botEnv = {
      ...process.env,
      ROOM_ID:      roomId,
      SERVER_URL:   `${proto}://localhost:${PORT}`,
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    };

    const bot = spawn(process.execPath, [path.join(__dirname, 'bot', 'index.js')], {
      env: botEnv, stdio: 'inherit',
    });

    botProcesses.set(roomId, bot);
    bot.on('exit', () => botProcesses.delete(roomId));

    console.log(`[bot] spawned for room "${roomId}" pid=${bot.pid}`);
    res.json({ ok: true, status: 'started', pid: bot.pid });
  });

  app.post('/api/bot/leave', (req, res) => {
    const { roomId } = req.body;
    const bot = botProcesses.get(roomId);
    if (!bot) return res.json({ ok: true, status: 'not_running' });
    bot.kill('SIGTERM');
    res.json({ ok: true, status: 'stopped' });
  });

  app.get('/api/bot/status/:roomId', (req, res) => {
    res.json({ running: botProcesses.has(req.params.roomId) });
  });

  // ─── Camera ingest API (PlainTransport) ────────────────────────────────────
  // 外部（秘書ダッシュボードの Flask + ffmpeg）から H.264 RTP を受け取り、
  // 部屋の producer として全視聴者へ SFU 配信する。ブラウザを介さないので
  // カメラ実機を持つホストが producer になれる。

  async function stopIngest(roomId, name) {
    const room = rooms.get(roomId);
    const ing = room?.ingests.get(name);
    if (!ing) return false;
    try { ing.producer.close(); } catch (_) {}
    try { ing.transport.close(); } catch (_) {}
    room.ingests.delete(name);
    if (io) io.to(roomId).emit('producerClosed', { producerId: ing.producer.id });
    console.log(`[ingest] stopped: ${roomId}/${name}`);
    return true;
  }

  app.post('/api/ingest/start', async (req, res) => {
    try {
      const {
        roomId      = 'secretary-cam',
        name        = 'webcam',
        displayName = 'Webカメラ',
        payloadType: reqPt,
        ssrc        = 22222222,
      } = req.body || {};

      // 再実行は「張り直し」として扱う（ffmpeg 再起動時に呼ばれる）
      await stopIngest(roomId, name);

      const room = await getOrCreateRoom(roomId);

      // comedia: true → 送信元の IP/ポートを最初に届いた RTP から学習する。
      // これにより Flask 側は送信ポートを固定する必要がなく、NAT も気にしなくてよい。
      const transport = await room.router.createPlainTransport({
        listenInfo: { protocol: 'udp', ip: '0.0.0.0', announcedAddress: ANNOUNCED_IP },
        rtcpMux: true,
        comedia: true,
      });

      // router が実際に持っている H264 の定義をそのまま使う。
      // ここにパラメータを直書きすると、router 側の profile-level-id を
      // 変更したときに produce が "unsupported codec" で落ちる。
      // 複数の H264 が宣言されている場合、ingest は解像度制約の緩い方
      // （プロファイルが高い方）を選ぶ。4K を Baseline で送るとブラウザの
      // HWデコーダが受け付けず黒画面になるため。
      const h264s = room.router.rtpCapabilities.codecs.filter(
        (c) => c.mimeType.toLowerCase() === 'video/h264'
      );
      const rank = (c) => {
        const pli = String(c.parameters?.['profile-level-id'] ?? '');
        return pli.startsWith('64') ? 3 : pli.startsWith('4d') ? 2 : 1;
      };
      const routerH264 = h264s.sort((a, b) => rank(b) - rank(a))[0];
      if (!routerH264) throw new Error('router が H264 を持っていません');

      // payloadType は router が割り当てた値に合わせる。ずれると produce が弾かれる。
      const payloadType = reqPt ?? routerH264.preferredPayloadType ?? 102;

      const producer = await transport.produce({
        kind: 'video',
        rtpParameters: {
          mid: name,
          codecs: [{
            mimeType:    'video/H264',
            payloadType,
            clockRate:   90000,
            parameters: {
              ...routerH264.parameters,
              'packetization-mode':      1,
              'level-asymmetry-allowed': 1,
            },
            // PLI/FIR を有効にしておかないと、後から参加した視聴者が
            // 次の IDR まで真っ黒のままになる
            rtcpFeedback: [
              { type: 'nack' },
              { type: 'nack', parameter: 'pli' },
              { type: 'ccm',  parameter: 'fir' },
            ],
          }],
          encodings: [{ ssrc }],
        },
        appData: { source: 'ingest', name },
      });

      room.ingests.set(name, { transport, producer, displayName });

      producer.observer.once('close', () => room.ingests.delete(name));

      // 既に部屋にいる視聴者へ即通知（join 済みのブラウザが再読込なしで映る）
      if (io) {
        io.to(roomId).emit('newProducer', {
          producerId:  producer.id,
          peerId:      `ingest:${name}`,
          displayName,
          kind:        'video',
          source:      'ingest',
        });
      }

      const info = {
        ok: true,
        roomId, name,
        producerId: producer.id,
        // ffmpeg / GStreamer の送り先
        ip:   ANNOUNCED_IP,
        port: transport.tuple.localPort,
        payloadType, ssrc,
        // 送信側のエンコーダはこのプロファイルに合わせること。
        // 42e01f=Constrained Baseline 3.1 / 640034=High 5.2
        profileLevelId: routerH264.parameters?.['profile-level-id'] ?? null,
      };
      console.log(`[ingest] started: ${roomId}/${name} → udp/${info.port} pt=${payloadType} ssrc=${ssrc}`);
      res.json(info);
    } catch (err) {
      console.error('[ingest/start]', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/ingest/stop', async (req, res) => {
    const { roomId = 'secretary-cam', name = 'webcam' } = req.body || {};
    const stopped = await stopIngest(roomId, name);
    res.json({ ok: true, stopped });
  });

  app.get('/api/ingest/status', (_req, res) => {
    const out = [];
    for (const [roomId, room] of rooms) {
      for (const [name, ing] of room.ingests) {
        out.push({
          roomId, name,
          displayName: ing.displayName,
          producerId:  ing.producer.id,
          port:        ing.transport.tuple.localPort,
          // comedia なので、RTP が届くまで remote は null のまま
          receiving:   Boolean(ing.transport.tuple.remoteIp),
          paused:      ing.producer.paused,
          viewers:     room.peers.size,
        });
      }
    }
    res.json({ ok: true, ingests: out });
  });

  app.use(express.static(path.join(__dirname, 'public')));

  const server = createServer(app);
  io = new Server(server, {
    cors: { origin: '*' },
    pingTimeout: 60000,
    pingInterval: 10000,
  });

  io.on('connection', (socket) => {
    console.log(`[socket] connected: ${socket.id}`);

    let roomId = null;
    let peer   = null;

    socket.on('disconnect', (reason) => {
      console.log(`[disconnect] ${peer?.displayName ?? socket.id}: ${reason}`);
      if (!roomId || !peer) return;
      const room = rooms.get(roomId);
      if (!room) return;
      for (const t of peer.transports.values()) t.close();
      room.peers.delete(socket.id);
      socket.to(roomId).emit('peerLeft', { peerId: socket.id });
      // カメラ等の ingest がある部屋は、視聴者がゼロになっても維持する。
      // ここで router を閉じると ffmpeg からの RTP 流入先が消え、再接続のたびに
      // Flask 側の配信を張り直す羽目になる。
      if (room.peers.size === 0 && room.ingests.size === 0) {
        room.router.close();
        rooms.delete(roomId);
        console.log(`[room] removed: ${roomId}`);
      }
    });

    // ── join ────────────────────────────────────────────────────────────────

    socket.on('join', async ({ roomId: rid, displayName }, cb) => {
      try {
        roomId = rid;
        const room = await getOrCreateRoom(roomId);

        peer = {
          id: socket.id,
          displayName: displayName || `User-${socket.id.slice(0, 4)}`,
          transports: new Map(),
          producers: new Map(),
          consumers: new Map(),
        };
        room.peers.set(socket.id, peer);
        socket.join(roomId);

        const existingProducers = [];
        for (const [pid, p] of room.peers) {
          if (pid === socket.id) continue;
          for (const [producerId, producer] of p.producers) {
            existingProducers.push({ producerId, peerId: pid, displayName: p.displayName, kind: producer.kind });
          }
        }
        // ingest（カメラ等）はソケットを持たないので peers ループでは拾えない。
        // これを足さないと、後から入った視聴者にカメラ映像が見えない。
        for (const [name, ing] of room.ingests) {
          existingProducers.push({
            producerId: ing.producer.id,
            peerId: `ingest:${name}`,
            displayName: ing.displayName,
            kind: ing.producer.kind,
            source: 'ingest',
          });
        }

        console.log(`[join] "${peer.displayName}" → room "${roomId}"`);
        cb({ routerRtpCapabilities: room.router.rtpCapabilities, existingProducers, iceServers: ICE_SERVERS });
      } catch (err) {
        console.error('[join]', err);
        cb({ error: err.message });
      }
    });

    // ── createTransport ──────────────────────────────────────────────────────

    socket.on('createTransport', async ({ direction }, cb) => {
      try {
        const transport = await rooms.get(roomId).router.createWebRtcTransport({
          webRtcServer,
          appData: { direction },
          // REMBフィードバックを有効化してクライアントの送信帯域を輻輳制御させる
          maxIncomingBitrate: 25_000_000,
          initialAvailableOutgoingBitrate: 5_000_000,
        });
        transport.on('icestatechange',  (s) => console.log(`[ICE:${peer.displayName}:${direction}] ${s}`));
        transport.on('dtlsstatechange', (s) => {
          console.log(`[DTLS:${peer.displayName}:${direction}] ${s}`);
          if (s === 'closed') transport.close();
        });
        peer.transports.set(transport.id, transport);

        cb({
          id: transport.id,
          iceParameters:  transport.iceParameters,
          iceCandidates:  transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        });
      } catch (err) {
        console.error('[createTransport]', err);
        if (err.message?.includes('Channel closed')) {
          restartWorker('createTransport: Channel closed');
        }
        cb({ error: err.message });
      }
    });

    // ── connectTransport ─────────────────────────────────────────────────────

    socket.on('connectTransport', async ({ transportId, dtlsParameters }, cb) => {
      try {
        await peer.transports.get(transportId).connect({ dtlsParameters });
        cb({});
      } catch (err) {
        cb({ error: err.message });
      }
    });

    // ── produce ──────────────────────────────────────────────────────────────

    socket.on('produce', async ({ transportId, kind, rtpParameters, appData }, cb) => {
      try {
        const producer = await peer.transports.get(transportId).produce({ kind, rtpParameters, appData });
        peer.producers.set(producer.id, producer);
        producer.on('transportclose', () => peer.producers.delete(producer.id));

        socket.to(roomId).emit('newProducer', {
          producerId: producer.id,
          peerId: socket.id,
          displayName: peer.displayName,
          kind: producer.kind,
        });

        console.log(`[produce] ${peer.displayName} ${kind} (${producer.rtpParameters.codecs[0]?.mimeType})`);
        cb({ id: producer.id });
      } catch (err) {
        console.error('[produce]', err);
        cb({ error: err.message });
      }
    });

    // ── consume ──────────────────────────────────────────────────────────────

    socket.on('consume', async ({ producerId, rtpCapabilities, transportId }, cb) => {
      try {
        const room = rooms.get(roomId);
        if (!room.router.canConsume({ producerId, rtpCapabilities }))
          return cb({ error: 'canConsume=false' });

        const transport = peer.transports.get(transportId);
        if (!transport) return cb({ error: 'recv transport not found' });

        const consumer = await transport.consume({ producerId, rtpCapabilities, paused: true });
        peer.consumers.set(consumer.id, consumer);
        consumer.on('transportclose', () => peer.consumers.delete(consumer.id));
        consumer.on('producerclose', () => {
          peer.consumers.delete(consumer.id);
          socket.emit('consumerClosed', { consumerId: consumer.id });
        });

        cb({ id: consumer.id, producerId, kind: consumer.kind, rtpParameters: consumer.rtpParameters });
      } catch (err) {
        console.error('[consume]', err);
        cb({ error: err.message });
      }
    });

    // ── resumeConsumer ───────────────────────────────────────────────────────

    socket.on('resumeConsumer', async ({ consumerId }, cb) => {
      try {
        const c = peer.consumers.get(consumerId);
        if (c) await c.resume();
        cb({});
      } catch (err) { cb({ error: err.message }); }
    });

    // ── pauseProducer / resumeProducer ───────────────────────────────────────

    socket.on('pauseProducer', async ({ producerId }, cb) => {
      try {
        const p = peer.producers.get(producerId);
        if (p) await p.pause();
        socket.to(roomId).emit('producerPaused', { producerId, peerId: socket.id });
        cb({});
      } catch (err) { cb({ error: err.message }); }
    });

    socket.on('resumeProducer', async ({ producerId }, cb) => {
      try {
        const p = peer.producers.get(producerId);
        if (p) await p.resume();
        socket.to(roomId).emit('producerResumed', { producerId, peerId: socket.id });
        cb({});
      } catch (err) { cb({ error: err.message }); }
    });

    socket.on('transcript', ({ text }, cb) => {
      try {
        socket.to(roomId).emit('transcript', { peerId: socket.id, displayName: peer?.displayName, text });
        cb?.({});
      } catch (err) { cb?.({ error: err.message }); }
    });
  });

  server.listen(PORT, () => {
    const proto = IS_PROD ? 'http' : 'https';
    console.log(`\nReady: ${proto}://localhost:${PORT}\n`);
  });

  // ── HTTPS を併設 ───────────────────────────────────────────────────────────
  // 映像を「送る」側は getUserMedia を使うため secure context が必須で、
  // 平文 HTTP の LAN アドレスではブラウザに拒否される。一方で受信専用の
  // ダッシュボードは HTTP のままで動く（RTCPeerConnection は secure context 不要）。
  // どちらも成立させるため、同じ mediasoup / socket.io を HTTPS でも待ち受ける。
  if (IS_PROD && HTTPS_PORT) {
    const keyPath  = path.join(__dirname, 'ssl', 'key.pem');
    const certPath = path.join(__dirname, 'ssl', 'cert.pem');
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
      const httpsServer = require('https').createServer({
        key:  fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath),
      }, app);
      io.attach(httpsServer, { cors: { origin: '*' } });
      httpsServer.listen(HTTPS_PORT, () => {
        console.log(`Ready (https): https://localhost:${HTTPS_PORT}  ← 映像を送る側はこちら\n`);
      });
    } else {
      console.warn(`[https] 証明書が無いため HTTPS は無効: ${keyPath}`);
    }
  }
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
