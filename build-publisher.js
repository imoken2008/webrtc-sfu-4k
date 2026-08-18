'use strict';
/** BRIO 送出ページのバンドル（Pi 5 の localhost で配信する自己完結 JS）。 */
const esbuild = require('esbuild');
esbuild.build({
  entryPoints: ['src/publisher.js'],
  bundle: true,
  outfile: 'public-publisher/bundle.js',
  platform: 'browser',
  target: ['chrome100'],
  minify: true,
}).then(() => console.log('publisher bundle → public-publisher/bundle.js'))
  .catch((e) => { console.error(e); process.exit(1); });
