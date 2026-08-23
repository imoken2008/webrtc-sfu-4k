'use strict';
/**
 * 秘書ダッシュボード用 SFU 受信クライアント
 *
 * ビルド: node build-dashboard.js
 *   → personal-ai-secretary/static/js/sfu_client.js
 *
 * 部屋に送られてきた映像を「参加者ごと」に束ねて UI へ渡す。
 * 1つの MediaStream に全トラックを突っ込むと <video> は最初の1本しか
 * 再生しないため、peer 単位で MediaStream を分ける必要がある。
 *
 * 受信と送出で secure context の要否が違う点に注意:
 *   - 受信(consume)  … RTCPeerConnection のみ。平文HTTPのページでも動く
 *   - 送出(publish)  … getUserMedia が必要。https:// でしか許可されない
 * そのため publish() は canPublish() で明示的に前提を確認してから動く。
 */

const { Device } = require('mediasoup-client');
const { io } = require('socket.io-client');

const DEFAULTS = {
  hubUrl: 'http://sfu-hub.local:8080',   // DHCP で IP が変わるため mDNS 名で固定
  roomId: 'secretary-cam',
  displayName: 'dashboard',
};

class SecretaryCam {
  constructor() {
    this.socket = null;
    this.device = null;
    this.recvTransport = null;

    // producerId → { consumer, peerId }
    this.consumers = new Map();
    // peerId → { stream, displayName, isIngest, producerIds:Set }
    this.peers = new Map();

    // 送出側（自分のカメラ）
    this.sendTransport = null;
    this.localStream = null;
    this.localProducers = [];

    this.opts = { ...DEFAULTS };
    this.onStatus = () => {};
    this.onPeerUpdate = () => {};
    this.onPeerRemove = () => {};
    this.state = 'idle';
  }

  _setState(state, detail) {
    this.state = state;
    try { this.onStatus(state, detail); } catch (_) {}
    console.log(`[sfu] ${state}${detail ? ': ' + detail : ''}`);
  }

  _emit(event, data) {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error('socket なし'));
      this.socket.emit(event, data, (res) => {
        if (res && res.error) reject(new Error(res.error));
        else resolve(res);
      });
    });
  }

  async start(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.onStatus = this.opts.onStatus || (() => {});
    this.onPeerUpdate = this.opts.onPeerUpdate || (() => {});
    this.onPeerRemove = this.opts.onPeerRemove || (() => {});

    this._setState('connecting', this.opts.hubUrl);
    this._ensureStatsOverlay();

    this.socket = io(this.opts.hubUrl, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 10000,
    });

    this.socket.on('connect_error', (e) => this._setState('error', `ハブに接続できません (${e.message})`));

    this.socket.on('disconnect', (reason) => {
      this._setState('disconnected', reason);
      this._teardownMedia();
    });

    this.socket.on('connect', () => this._join().catch((e) => this._setState('error', e.message)));

    this.socket.on('workerRestart', () => {
      this._teardownMedia();
      this._join().catch((e) => this._setState('error', e.message));
    });

    // 誰かが映像/音声を送り始めた
    this.socket.on('newProducer', (p) => {
      this._consume(p).catch((e) => console.warn('[sfu] consume 失敗:', e.message));
    });

    // 送出停止・退出
    this.socket.on('producerClosed', ({ producerId }) => this._removeProducer(producerId));
    this.socket.on('consumerClosed', ({ consumerId }) => {
      for (const [pid, c] of this.consumers) {
        if (c.consumer.id === consumerId) { this._removeProducer(pid); return; }
      }
    });
    this.socket.on('peerLeft', ({ peerId }) => this._removePeer(peerId));
  }

  async _join() {
    const { routerRtpCapabilities, existingProducers } = await this._emit('join', {
      roomId: this.opts.roomId,
      displayName: this.opts.displayName,
    });

    // Device は load 済みのものを使い回せないので join のたびに作る
    this.device = new Device();
    await this.device.load({ routerRtpCapabilities });

    const params = await this._emit('createTransport', { direction: 'recv' });
    this.recvTransport = this.device.createRecvTransport(params);

    this.recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
      this._emit('connectTransport', { transportId: this.recvTransport.id, dtlsParameters })
        .then(callback).catch(errback);
    });

    this.recvTransport.on('connectionstatechange', (s) => {
      if (s === 'connected') this._setState('live');
      else if (s === 'failed' || s === 'disconnected') this._setState('error', `ICE ${s}`);
    });

    this._setState('joined', `producer ${existingProducers.length} 件`);

    for (const p of existingProducers) {
      await this._consume(p).catch((e) => console.warn('[sfu] consume 失敗:', e.message));
    }

    if (existingProducers.length === 0) this._setState('waiting', '映像待ち');
  }

  async _consume({ producerId, peerId, displayName, kind, source }) {
    if (!this.recvTransport || this.consumers.has(producerId)) return;

    const params = await this._emit('consume', {
      producerId,
      rtpCapabilities: this.device.rtpCapabilities,
      transportId: this.recvTransport.id,
    });

    const consumer = await this.recvTransport.consume({
      id: params.id,
      producerId: params.producerId,
      kind: params.kind,
      rtpParameters: params.rtpParameters,
    });

    this.consumers.set(producerId, { consumer, peerId });

    // peer 単位で MediaStream を作る。映像と音声が別 producer で来るので、
    // 同じ peer のトラックは同じ stream にまとめないと音がズレる。
    let peer = this.peers.get(peerId);
    if (!peer) {
      peer = {
        peerId,
        displayName: displayName || peerId,
        isIngest: source === 'ingest' || String(peerId).startsWith('ingest:'),
        stream: new MediaStream(),
        producerIds: new Set(),
        hasAudio: false,
      };
      this.peers.set(peerId, peer);
    }
    peer.stream.addTrack(consumer.track);
    peer.producerIds.add(producerId);
    if (consumer.kind === 'audio') peer.hasAudio = true;

    // consume は paused で作られるので、UI へ渡してから再開する
    this.onPeerUpdate(peer);
    await this._emit('resumeConsumer', { consumerId: consumer.id });

    this._setState('live', `${this.peers.size} 人 / ${this.consumers.size} トラック`);
  }

  _removeProducer(producerId) {
    const entry = this.consumers.get(producerId);
    if (!entry) return;
    const { consumer, peerId } = entry;

    const peer = this.peers.get(peerId);
    if (peer) {
      try { peer.stream.removeTrack(consumer.track); } catch (_) {}
      peer.producerIds.delete(producerId);
    }
    try { consumer.close(); } catch (_) {}
    this.consumers.delete(producerId);

    // その peer のトラックが全部消えたらタイルごと片付ける
    if (peer && peer.producerIds.size === 0) {
      this.peers.delete(peerId);
      this.onPeerRemove(peerId);
    } else if (peer) {
      this.onPeerUpdate(peer);
    }

    if (this.peers.size === 0) this._setState('waiting', '映像待ち');
  }

  _removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    for (const producerId of [...peer.producerIds]) {
      const entry = this.consumers.get(producerId);
      if (entry) { try { entry.consumer.close(); } catch (_) {} }
      this.consumers.delete(producerId);
    }
    this.peers.delete(peerId);
    this.onPeerRemove(peerId);
    if (this.peers.size === 0) this._setState('waiting', '映像待ち');
  }

  _teardownMedia() {
    // 切断時は送出も畳む（カメラを掴んだままにしない）
    for (const p of this.localProducers || []) { try { p.close(); } catch (_) {} }
    this.localProducers = [];
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }
    try { this.sendTransport?.close(); } catch (_) {}
    this.sendTransport = null;

    for (const { consumer } of this.consumers.values()) {
      try { consumer.close(); } catch (_) {}
    }
    this.consumers.clear();
    for (const peerId of [...this.peers.keys()]) this.onPeerRemove(peerId);
    this.peers.clear();
    try { this.recvTransport?.close(); } catch (_) {}
    this.recvTransport = null;
    this.device = null;
  }

  stop() {
    this._teardownMedia();
    try { this.socket?.disconnect(); } catch (_) {}
    this.socket = null;
    this._setState('idle');
  }

  // ─── 送出（参加者が自分のカメラを部屋へ出す） ───────────────────────────
  //
  // getUserMedia はブラウザが secure context でしか許可しない。平文HTTPの
  // LANアドレスで開かれている場合はここで明示的に弾き、理由を返す。

  canPublish() {
    return Boolean(
      window.isSecureContext &&
      navigator.mediaDevices &&
      navigator.mediaDevices.getUserMedia
    );
  }

  async publish({ video = true, audio = true,
                  width, height, frameRate = 30, deviceId,
                  maxBitrate, codecMime } = {}) {
    if (this.localStream) return this.localStream;      // 二重送出を防ぐ
    if (!this.canPublish()) {
      throw new Error(
        'このページは安全な接続ではないため、ブラウザがカメラを許可しません。' +
        'https:// で開き直してください'
      );
    }
    if (!this.device || !this.socket?.connected) {
      throw new Error('SFUハブに接続していません');
    }

    const videoConstraints = video ? {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      width:     { ideal: width  ?? 1280 },
      height:    { ideal: height ?? 720 },
      frameRate: { ideal: frameRate },
    } : false;
    const stream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
      audio: audio ? { echoCancellation: true, noiseSuppression: true } : false,
    });

    // 送信用トランスポートは受信用とは別に張る必要がある
    if (!this.sendTransport) {
      const params = await this._emit('createTransport', { direction: 'send' });
      this.sendTransport = this.device.createSendTransport(params);

      this.sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
        this._emit('connectTransport', { transportId: this.sendTransport.id, dtlsParameters })
          .then(callback).catch(errback);
      });

      // produce は「トラックを載せた瞬間」にサーバへ登録しに行く
      this.sendTransport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
        this._emit('produce', { transportId: this.sendTransport.id, kind, rtpParameters, appData })
          .then((res) => callback({ id: res.id })).catch(errback);
      });

      this.sendTransport.on('connectionstatechange', (s) => {
        if (s === 'failed') this._setState('error', '送出のICEに失敗しました');
      });
    }

    this.localStream = stream;
    this.localProducers = this.localProducers || [];

    for (const track of stream.getTracks()) {
      const produceParams = { track };
      if (track.kind === 'video') {
        const s = track.getSettings();
        const w = s.width || width || 1280;
        // Pi 5 は HW エンコーダ非搭載でソフト符号化。解像度に応じてビットレート上限を設定
        const bitrate = maxBitrate ??
          (w >= 3840 ? 20_000_000 : w >= 1920 ? 6_000_000 : 2_500_000);
        produceParams.encodings   = [{ maxBitrate: bitrate }];
        produceParams.codecOptions = { videoGoogleStartBitrate: 1000 };
        if (codecMime && this.device) {
          const codec = this.device.rtpCapabilities.codecs.find(
            (c) => c.kind === 'video' &&
                   c.mimeType.toLowerCase() === codecMime.toLowerCase());
          if (codec) produceParams.codec = codec;
        }
      }
      const producer = await this.sendTransport.produce(produceParams);
      this.localProducers.push(producer);
    }

    this._setState('publishing', `${stream.getTracks().length} トラック送出中`);
    return stream;
  }

  async unpublish() {
    for (const p of this.localProducers || []) {
      try { p.close(); } catch (_) {}
    }
    this.localProducers = [];

    if (this.localStream) {
      // トラックを止めないとカメラのLEDが点いたままになる
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }

    try { this.sendTransport?.close(); } catch (_) {}
    this.sendTransport = null;

    this._setState(this.peers.size > 0 ? 'live' : 'waiting', '送出を停止しました');
  }

  isPublishing() { return Boolean(this.localStream); }

  getPeers() { return [...this.peers.values()]; }

  // ── カメラ映像タイルごとの統計バッジ（各 <video> の右上に小さく表示）──
  // 解像度と FPS は SFU サーバ側では取れない（mediasoup は復号しない）ため、
  // ブラウザの RTCRtpSender/Receiver.getStats() から取得し、対応する映像の
  // 右上へ「解像度 fps 帯域」を重ねて表示する。
  _ensureStatsOverlay() {
    if (this._statsTimer) return;
    if (typeof document === 'undefined') return;
    this._statsPrev = this._statsPrev || {};
    this._statsTimer = setInterval(() => this._renderPerTileStats(), 1500);
  }

  async _collectStreamStats() {
    const rows = [];
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    this._statsPrev = this._statsPrev || {};
    const scan = async (getStats, dir, streamObj, id) => {
      let report;
      try { report = await getStats(); } catch (_) { return; }
      report.forEach((r) => {
        if (r.type !== 'outbound-rtp' && r.type !== 'inbound-rtp') return;
        if (r.isRemote) return;
        const kind = r.kind || r.mediaType;
        const bytes = (r.bytesSent != null ? r.bytesSent : r.bytesReceived) || 0;
        const key = dir + '|' + id + '|' + kind;
        const prev = this._statsPrev[key];
        let kbps = 0;
        if (prev && now > prev.t) kbps = Math.round((bytes - prev.bytes) * 8 / (now - prev.t));
        this._statsPrev[key] = { bytes, t: now };
        rows.push({
          stream: streamObj, dir, kind,
          w: r.frameWidth || null,
          h: r.frameHeight || null,
          fps: (r.framesPerSecond != null) ? Math.round(r.framesPerSecond) : null,
          kbps: kbps < 0 ? 0 : kbps,
        });
      });
    };
    for (const p of (this.localProducers || [])) {
      await scan(() => p.getStats(), 'send', this.localStream, p.id);
    }
    for (const [pid, c] of this.consumers) {
      const peer = this.peers.get(c.peerId);
      await scan(() => c.consumer.getStats(), 'recv', peer && peer.stream, pid);
    }
    return rows;
  }

  _findVideoFor(stream) {
    if (!stream || typeof document === 'undefined') return null;
    const vids = document.querySelectorAll('video');
    for (const v of vids) { if (v.srcObject === stream) return v; }
    return null;
  }

  _badgeFor(video) {
    const parent = video.parentElement || video;
    let badge = parent.querySelector(':scope > .sfu-tile-stat');
    if (!badge) {
      try {
        const cs = getComputedStyle(parent);
        if (cs.position === 'static') parent.style.position = 'relative';
      } catch (_) {}
      badge = document.createElement('div');
      badge.className = 'sfu-tile-stat';
      badge.style.cssText =
        'position:absolute;top:4px;right:4px;z-index:10;pointer-events:none;' +
        'font:10px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;color:#fff;' +
        'background:rgba(0,0,0,.58);border-radius:5px;padding:1px 6px;white-space:nowrap;' +
        'letter-spacing:.2px;text-shadow:0 1px 1px rgba(0,0,0,.6);';
      parent.appendChild(badge);
    }
    return badge;
  }

  async _renderPerTileStats() {
    const rows = await this._collectStreamStats();
    const byStream = new Map();
    for (const r of rows) {
      if (!r.stream) continue;
      let g = byStream.get(r.stream);
      if (!g) { g = { w: null, h: null, fps: null, vKbps: 0, aKbps: 0 }; byStream.set(r.stream, g); }
      if (r.kind === 'video') { g.w = r.w; g.h = r.h; g.fps = r.fps; g.vKbps = r.kbps; }
      else { g.aKbps += r.kbps; }
    }
    for (const [stream, g] of byStream) {
      const v = this._findVideoFor(stream);
      if (!v) continue;
      this._makeMaximizable(v);
      const badge = this._badgeFor(v);
      const total = (g.vKbps || 0) + (g.aKbps || 0);
      const res = (g.w && g.h) ? (g.w + '×' + g.h) : '–';
      const fps = (g.fps != null) ? (' ' + g.fps + 'fps') : '';
      const bw = total >= 1000 ? (total / 1000).toFixed(1) + 'Mbps' : total + 'kbps';
      badge.textContent = res + fps + '  ' + bw;
    }
  }

  // ── カメラ映像タイルのクリック最大化 ────────────────────────────────
  _makeMaximizable(video) {
    if (!video || video.dataset.sfuMax === '1') return;
    video.dataset.sfuMax = '1';
    video.style.cursor = 'zoom-in';
    if (!video.title) video.title = 'クリックで最大化';
    video.addEventListener('click', () => this._openMaximize(video.srcObject));
  }

  _openMaximize(stream) {
    if (!stream || typeof document === 'undefined') return;
    this._closeMaximize();
    const ov = document.createElement('div');
    ov.id = 'sfu-max-overlay';
    ov.style.cssText =
      'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.92);' +
      'display:flex;align-items:center;justify-content:center;cursor:zoom-out;';
    const v = document.createElement('video');
    v.autoplay = true; v.playsInline = true; v.muted = true; // 音は元タイルから鳴らす（二重音防止）
    v.srcObject = stream;
    v.style.cssText =
      'max-width:96vw;max-height:92vh;width:auto;height:auto;object-fit:contain;' +
      'border-radius:6px;box-shadow:0 10px 44px rgba(0,0,0,.6);background:#000;';
    const close = document.createElement('div');
    close.textContent = '✕';
    close.style.cssText =
      'position:absolute;top:12px;right:18px;color:#fff;font:600 24px/1 system-ui,sans-serif;' +
      'cursor:pointer;opacity:.85;text-shadow:0 1px 3px rgba(0,0,0,.7);';
    close.onclick = (e) => { e.stopPropagation(); this._closeMaximize(); };
    ov.appendChild(v);
    ov.appendChild(close);
    ov.addEventListener('click', () => this._closeMaximize()); // 背景/映像クリックで閉じる
    document.body.appendChild(ov);
    if (v.play) { try { v.play(); } catch (_) {} }
    if (!this._maxEsc) {
      this._maxEsc = (e) => { if (e.key === 'Escape') this._closeMaximize(); };
      document.addEventListener('keydown', this._maxEsc);
    }
  }

  _closeMaximize() {
    if (typeof document === 'undefined') return;
    const ov = document.getElementById('sfu-max-overlay');
    if (ov) {
      const v = ov.querySelector('video');
      if (v) v.srcObject = null;
      ov.remove();
    }
  }

  getStats() {
    return {
      state: this.state,
      hubUrl: this.opts.hubUrl,
      roomId: this.opts.roomId,
      peers: this.peers.size,
      tracks: this.consumers.size,
      connected: Boolean(this.socket?.connected),
    };
  }
}

window.SecretaryCam = new SecretaryCam();
