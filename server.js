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
      'profile-level-id': '640034',
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
    rooms.set(roomId, { router, peers: new Map() });
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

  app.use(express.static(path.join(__dirname, 'public')));

  const server = createServer(app);
  io = new Server(server, {
    cors: { origin: '*' },
    pingTimeout: 60000,
    pingInterval: 30000,
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
      if (room.peers.size === 0) {
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
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
