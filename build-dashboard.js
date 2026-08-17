'use strict';
/**
 * 秘書ダッシュボード用 SFU 受信クライアントのバンドル。
 * 出力先が別プロジェクト（personal-ai-secretary）なのは、mediasoup-client を
 * 抱えているのがこちらのリポジトリだけのため。
 */
const esbuild = require('esbuild');
const path = require('path');

const OUT = path.resolve(
  __dirname,
  '../personal-ai-secretary/static/js/sfu_client.js'
);

esbuild.build({
  entryPoints: ['src/dashboard_sfu.js'],
  bundle: true,
  outfile: OUT,
  platform: 'browser',
  target: ['chrome90', 'firefox90'],
  minify: true,
}).then(() => console.log(`Dashboard SFU bundle built → ${OUT}`))
  .catch((e) => { console.error(e); process.exit(1); });
