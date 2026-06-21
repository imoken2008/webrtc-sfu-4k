'use strict';
const esbuild = require('esbuild');

esbuild.build({
  entryPoints: ['src/client.js'],
  bundle: true,
  outfile: 'public/bundle.js',
  platform: 'browser',
  target: ['chrome90', 'firefox90'],
  minify: true,
}).then(() => console.log('Client bundle built → public/bundle.js'))
  .catch((e) => { console.error(e); process.exit(1); });
