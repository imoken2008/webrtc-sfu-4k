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
 * 受信専用（getUserMedia を呼ばない）なので、ダッシュボードが平文 HTTP で
 * 開かれていても動く。RTCPeerConnection は secure context 必須ではない。
 */

const { Device } = require('mediasoup-client');
const { io } = require('socket.io-client');

const DEFAULTS = {
  hubUrl: 'http://192.168.0.9:8080',
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

  getPeers() { return [...this.peers.values()]; }

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
