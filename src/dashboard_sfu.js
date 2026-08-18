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
