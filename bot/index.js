'use strict';

const { io }       = require('socket.io-client');
const Anthropic    = require('@anthropic-ai/sdk');

const SERVER_URL   = process.env.SERVER_URL   || 'https://localhost:3443';
const ROOM_ID      = process.env.ROOM_ID      || 'main';
const BOT_NAME     = process.env.BOT_NAME     || '🤖 AIファシリテーター';
const MAX_HISTORY  = 20;
const DEBOUNCE_MS  = 2000; // 発言が止まってから応答

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const history = [];
let debounceTimer = null;
const pending = []; // debounce中に溜まった発言

// 開発環境の自己署名証明書を許可
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const socket = io(SERVER_URL, { rejectUnauthorized: false });

socket.on('connect', () => {
  console.log(`[bot] connected: ${socket.id}`);
  socket.emit('join', { roomId: ROOM_ID, displayName: BOT_NAME }, (res) => {
    if (res?.error) { console.error('[bot] join error:', res.error); return; }
    console.log(`[bot] joined room: ${ROOM_ID}`);
    setTimeout(() => {
      socket.emit('transcript', { text: 'こんにちは！AIファシリテーターです。会議を始めましょう。何でも話しかけてください。' }, () => {});
    }, 500);
  });
});

socket.on('disconnect', (reason) => console.log('[bot] disconnected:', reason));

socket.on('transcript', async ({ peerId, displayName, text }) => {
  if (!text?.trim()) return;
  const label = displayName || peerId;
  pending.push(`${label}: ${text}`);
  console.log(`[bot] received: ${label}: ${text}`);

  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => respond(), DEBOUNCE_MS);
});

async function respond() {
  if (pending.length === 0) return;

  const combined = pending.splice(0).join('\n');
  history.push({ role: 'user', content: combined });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);

  try {
    const res = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: [
        'あなたはビデオ会議のAIファシリテーターです。',
        '参加者の発言を受けて、会議を前進させる一言を日本語で返してください。',
        '・発言は1〜2文で簡潔に。',
        '・質問・まとめ・次のアジェンダ提案など、会話を促す内容が望ましい。',
        '・発言者の名前は繰り返さなくてよい。',
      ].join('\n'),
      messages: history,
    });

    const reply = res.content[0]?.text ?? '';
    if (!reply) return;

    history.push({ role: 'assistant', content: reply });
    console.log(`[bot] respond: ${reply}`);
    socket.emit('transcript', { text: reply }, () => {});
  } catch (e) {
    console.error('[bot] Anthropic error:', e.message);
  }
}

process.on('SIGINT',  () => { socket.disconnect(); process.exit(0); });
process.on('SIGTERM', () => { socket.disconnect(); process.exit(0); });
