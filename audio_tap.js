'use strict';
/**
 * 音声タップ
 *
 * SFU の本流（producer → consumer）には一切手を触れず、同じ producer から
 * もう1本 consumer を生やして ffmpeg に渡し、音を「解析するだけ」する。
 * 解析結果は Socket.io の別ルートで受信側へ配る。
 *
 * なぜこの形か:
 *   ハブでデコード → 補正 → 再エンコードして流し直す構成にすると、本流に
 *   数十msの遅延と再エンコードの劣化が乗る。タップなら本流は素通しのまま
 *   なので、遅延も音質も一切変わらない。補正そのものは受信側が当てる。
 */
const dgram = require('dgram');
const { spawn } = require('child_process');

// 解析用に使う UDP ポートの範囲（WebRTC の 10000 番とぶつけない）
const PORT_MIN = parseInt(process.env.TAP_PORT_MIN || '41000', 10);
const PORT_MAX = parseInt(process.env.TAP_PORT_MAX || '41999', 10);
// 解析結果を送る間隔の下限(ms)。ebur128 は 100ms ごとに吐くので間引く。
const EMIT_INTERVAL = parseInt(process.env.TAP_EMIT_INTERVAL || '1000', 10);
// 受信側に狙わせる音量(LUFS)。放送は -23、配信は -16 あたりが定番で、
// 会話の聞き取りやすさ重視ならこのくらい。
const TARGET_LUFS = parseFloat(process.env.TAP_TARGET_LUFS || '-20');
// 一度に足してよいゲインの上限(dB)。青天井にすると無音時に暗騒音を持ち上げる。
const MAX_GAIN_DB = parseFloat(process.env.TAP_MAX_GAIN_DB || '24');
// 「話しているときの音量」を何秒ぶんの履歴から拾うか
const HISTORY_SEC = parseInt(process.env.TAP_HISTORY_SEC || '30', 10);
// その履歴の何割目を話者の音量とみなすか。上澄みだけ見ると咳や物音に
// 引っ張られるので、8割目あたりが素直。
const SPEECH_PERCENTILE = parseFloat(process.env.TAP_SPEECH_PERCENTILE || '0.8');
// 暗騒音からこの差がなければ「誰も話していない」と判断してゲインを当てない
const MIN_SNR_DB = parseFloat(process.env.TAP_MIN_SNR_DB || '8');

function freePort() {
  // 空いている UDP ポートを1つ見つける。ffmpeg が bind するまでの間に
  // 奪われる可能性は残るが、専用ハブなので実害はない。
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    const tryPort = () => {
      const p = PORT_MIN + Math.floor(Math.random() * (PORT_MAX - PORT_MIN));
      s.once('error', tryPort);
      s.bind(p, '127.0.0.1', () => {
        const port = s.address().port;
        s.close(() => resolve(port));
      });
    };
    tryPort();
    setTimeout(() => reject(new Error('空きポートが見つからない')), 3000);
  });
}

function buildSdp(port, codec) {
  const ch = codec.channels || 2;
  return [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=tap',
    'c=IN IP4 127.0.0.1',
    't=0 0',
    `m=audio ${port} RTP/AVP ${codec.payloadType}`,
    `a=rtpmap:${codec.payloadType} opus/${codec.clockRate}/${ch}`,
    `a=fmtp:${codec.payloadType} sprop-stereo=${ch > 1 ? 1 : 0}`,
    'a=recvonly',
    '',
  ].join('\n');
}

class AudioTap {
  constructor({ router, producer, roomId, peerId, displayName, onAnalysis }) {
    Object.assign(this, { router, producer, roomId, peerId, displayName, onAnalysis });
    this.closed = false;
    this.lastEmit = 0;
    // ffmpeg の出力は行が分割されて届くので自前で組み直す
    this.buf = '';
    this.latest = {};
    // 直近の短時間音量の履歴。「話しているときの音量」を取り出すのに使う。
    this.history = [];
  }

  async start() {
    const port = await freePort();
    this.transport = await this.router.createPlainTransport({
      listenIp: { ip: '127.0.0.1' },
      rtcpMux: true,
      comedia: false,
    });
    await this.transport.connect({ ip: '127.0.0.1', port });

    this.consumer = await this.transport.consume({
      producerId: this.producer.id,
      rtpCapabilities: this.router.rtpCapabilities,
      paused: false,
    });

    const codec = this.consumer.rtpParameters.codecs[0];
    this.spawnFfmpeg(port, codec);

    // 元の producer が消えたらタップも畳む
    this.producer.observer.once('close', () => this.close());
    console.log(`[tap] 開始 ${this.displayName} (${this.peerId}) → 127.0.0.1:${port}`);
  }

  spawnFfmpeg(port, codec) {
    const args = [
      '-hide_banner', '-loglevel', 'info', '-nostdin',
      '-protocol_whitelist', 'pipe,udp,rtp',
      // 遅れて届いたパケットを待たない。解析なので取りこぼしてよい。
      '-fflags', 'nobuffer', '-flags', 'low_delay',
      '-f', 'sdp', '-i', 'pipe:0',
      // astats = 暗騒音の推定値、ebur128 = 人の耳に近い重み付けの音量計。
      // どちらも音を素通しするので1本に繋げてよい。
      // framelog は info にすること。verbose にすると -loglevel verbose まで
      // 上げない限り1行も出力されず、動いているのに何も取れない。
      '-filter_complex',
      '[0:a]astats=metadata=1:reset=48,' +
      'ametadata=mode=print:key=lavfi.astats.Overall.Noise_floor:file=-,' +
      'ebur128=peak=true:framelog=info[out]',
      '-map', '[out]', '-f', 'null', '-',
    ];
    this.proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdin.write(buildSdp(port, codec));
    this.proc.stdin.end();

    const onData = (chunk) => this.consume(chunk.toString());
    this.proc.stdout.on('data', onData);
    this.proc.stderr.on('data', onData);
    this.proc.on('exit', (code) => {
      if (this.closed) return;
      console.warn(`[tap] ffmpeg が終了 (${this.displayName}, code=${code})`);
    });
  }

  consume(text) {
    this.buf += text;
    const lines = this.buf.split('\n');
    this.buf = lines.pop();
    for (const line of lines) this.parse(line);
  }

  parse(line) {
    // ebur128: "t: 12.3  M: -28.1 S: -27.9 I: -30.0 LUFS ... TPK: -12.0 -12.0 dBFS"
    const m = line.match(/M:\s*(-?[\d.]+|-inf)\s+S:\s*(-?[\d.]+|-inf)\s+I:\s*(-?[\d.]+|-inf)/);
    if (m) {
      const num = (v) => (v === '-inf' ? -99 : parseFloat(v));
      this.latest.momentary = num(m[1]);
      this.latest.shortTerm = num(m[2]);
      this.latest.integrated = num(m[3]);
      // FTPK = そのフレームの真のピーク。TPK は開始からの最大値なので
      // 増える一方で、頭を押さえる判断には使えない。
      // また /TPK:/ は FTPK: にも当たってしまうので前を固定する。
      const tpk = line.match(/FTPK:\s*(-?[\d.]+|-inf)(?:\s+(-?[\d.]+|-inf))?/);
      if (tpk) {
        const v = [tpk[1], tpk[2]].filter(Boolean)
          .map((x) => (x === '-inf' ? -99 : parseFloat(x)));
        this.latest.truePeak = Math.max(...v);
      }
      this.maybeEmit();
      return;
    }
    // astats の暗騒音
    const nf = line.match(/Noise_floor=(-?[\d.]+)/);
    if (nf) this.latest.noiseFloor = parseFloat(nf[1]);
  }

  maybeEmit() {
    const now = Date.now();
    if (now - this.lastEmit < EMIT_INTERVAL) return;
    this.lastEmit = now;

    const s = this.latest;

    // 瞬間の音量からゲインを決めると、黙っている間に暗騒音を目一杯
    // 持ち上げてしまう（無音ほど「もっと上げろ」と言うため）。
    // 直近 HISTORY_SEC 秒の上位を「話しているときの音量」とみなし、
    // そこから逆算する。こうすると値が落ち着き、息継ぎでも揺れない。
    if (s.shortTerm != null && s.shortTerm > -99) {
      this.history.push({ lufs: s.shortTerm, peak: s.truePeak ?? -99, at: now });
      const cutoff = now - HISTORY_SEC * 1000;
      while (this.history.length && this.history[0].at < cutoff) this.history.shift();
    }

    let speechLufs = null;
    let windowPeak = -99;
    if (this.history.length >= 5) {
      const sorted = this.history.map((h) => h.lufs).sort((a, b) => a - b);
      speechLufs = sorted[Math.floor(sorted.length * SPEECH_PERCENTILE)];
      windowPeak = Math.max(...this.history.map((h) => h.peak));
    }

    let gainDb = 0;
    // 上位が暗騒音に近いなら、そもそも誰も話していない。触らない。
    const aboveNoise = (speechLufs != null && s.noiseFloor != null)
      ? speechLufs - s.noiseFloor : null;
    if (speechLufs != null && (aboveNoise == null || aboveNoise > MIN_SNR_DB)) {
      gainDb = Math.max(0, Math.min(MAX_GAIN_DB, TARGET_LUFS - speechLufs));
      // 持ち上げた結果が振り切れないところまで戻す
      if (windowPeak > -99) gainDb = Math.min(gainDb, Math.max(0, -1 - windowPeak));
    }
    const snr = (speechLufs != null && s.noiseFloor != null)
      ? +(speechLufs - s.noiseFloor).toFixed(1) : null;

    this.onAnalysis({
      roomId: this.roomId,
      producerId: this.producer.id,
      peerId: this.peerId,
      displayName: this.displayName,
      momentary: s.momentary ?? null,
      shortTerm: s.shortTerm ?? null,
      integrated: s.integrated ?? null,
      truePeak: s.truePeak ?? null,
      noiseFloor: s.noiseFloor ?? null,
      speechLufs: speechLufs != null ? +speechLufs.toFixed(1) : null,
      snr,
      // 受信側にそのまま渡せる推奨値
      recommend: { gainDb: +gainDb.toFixed(1), highpassHz: 90 },
      at: now,
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.consumer && this.consumer.close(); } catch (_) {}
    try { this.transport && this.transport.close(); } catch (_) {}
    if (this.proc) {
      try { this.proc.kill('SIGTERM'); } catch (_) {}
      // 落ちなければ確実に止める
      setTimeout(() => { try { this.proc.kill('SIGKILL'); } catch (_) {} }, 3000).unref();
    }
    console.log(`[tap] 終了 ${this.displayName} (${this.peerId})`);
  }
}

module.exports = { AudioTap };
