'use strict';
/**
 * 秘書ダッシュボード用 SFU 受信クライアント
 *
 * ビルド: node build-dashboard.js
 *   → personal-ai-secretary/static/js/sfu_client.js
 *
 * 役割は「見るだけ」。カメラは Flask 側が PlainTransport でハブへ流し込んでいるので、
 * このクライアントは producer を consume して <video> に貼るだけでよい。
 * getUserMedia を呼ばないので、ダッシュボードが平文 HTTP で開かれていても動く
 * （RTCPeerConnection は secure context 必須ではない）。
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
    this.consumers = new Map();
    this.videoEl = null;
    this.stream = null;
    this.opts = { ...DEFAULTS };
    this.onStatus = () => {};
    this.state = 'idle';
    this.stopped = true;
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
    this.videoEl = this.opts.videoEl || document.getElementById('camera-view-video');
    this.onStatus = this.opts.onStatus || (() => {});
    this.stopped = false;

    this._setState('connecting', this.opts.hubUrl);

    this.socket = io(this.opts.hubUrl, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 10000,
    });

    this.socket.on('connect_error', (e) => {
      this._setState('error', `ハブに接続できません (${e.message})`);
    });

    this.socket.on('disconnect', (reason) => {
      this._setState('disconnected', reason);
      this._teardownMedia();
    });

    // 再接続時・ワーカー再起動時は join からやり直す
    this.socket.on('connect', () => this._join().catch((e) => this._setState('error', e.message)));
    this.socket.on('workerRestart', () => {
      this._teardownMedia();
      this._join().catch((e) => this._setState('error', e.message));
    });

    // カメラ送出が（再）開始されたとき
    this.socket.on('newProducer', ({ producerId }) => {
      this._consume(producerId).catch((e) => this._setState('error', e.message));
    });

    this.socket.on('producerClosed', ({ producerId }) => this._removeByProducer(producerId));
    this.socket.on('consumerClosed', ({ consumerId }) => this._removeConsumer(consumerId));
  }

  async _join() {
    const { routerRtpCapabilities, existingProducers } = await this._emit('join', {
      roomId: this.opts.roomId,
      displayName: this.opts.displayName,
    });

    // Device は使い回せないので join のたびに作る
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
      if (p.kind === 'video') await this._consume(p.producerId);
    }

    if (existingProducers.length === 0) {
      this._setState('waiting', 'カメラ送出待ち');
    }
  }

  async _consume(producerId) {
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

    this.consumers.set(producerId, consumer);

    if (!this.stream) this.stream = new MediaStream();
    this.stream.addTrack(consumer.track);

    if (this.videoEl) {
      this.videoEl.srcObject = this.stream;
      // 自動再生を確実にするため muted + playsinline は HTML 側で指定済み
      this.videoEl.play().catch((e) => console.warn('[sfu] 自動再生に失敗:', e.message));
    }

    // consume は paused で作られるので、貼り付けてから再開する
    await this._emit('resumeConsumer', { consumerId: consumer.id });
    this._setState('live', `${params.kind} 受信中`);
  }

  _removeByProducer(producerId) {
    const c = this.consumers.get(producerId);
    if (!c) return;
    this._detachTrack(c);
    this.consumers.delete(producerId);
    this._setState('waiting', 'カメラ送出が停止しました');
  }

  _removeConsumer(consumerId) {
    for (const [pid, c] of this.consumers) {
      if (c.id === consumerId) { this._removeByProducer(pid); return; }
    }
  }

  _detachTrack(consumer) {
    try {
      if (this.stream) this.stream.removeTrack(consumer.track);
      consumer.close();
    } catch (_) {}
  }

  _teardownMedia() {
    for (const c of this.consumers.values()) this._detachTrack(c);
    this.consumers.clear();
    try { this.recvTransport?.close(); } catch (_) {}
    this.recvTransport = null;
    this.device = null;
    this.stream = null;
    if (this.videoEl) this.videoEl.srcObject = null;
  }

  stop() {
    this.stopped = true;
    this._teardownMedia();
    try { this.socket?.disconnect(); } catch (_) {}
    this.socket = null;
    this._setState('idle');
  }

  getStats() {
    return {
      state: this.state,
      hubUrl: this.opts.hubUrl,
      roomId: this.opts.roomId,
      consumers: this.consumers.size,
      connected: Boolean(this.socket?.connected),
    };
  }
}

window.SecretaryCam = new SecretaryCam();
