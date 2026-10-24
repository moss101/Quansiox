'use strict';
/** Renderer build — esbuild bundles (work over file://).
 *  - assets/app.js    → the main window
 *  - assets/panel.js  → the floating desktop companion window
 */
const esbuild = require('esbuild');
const path = require('node:path');

const root = path.join(__dirname, '..');
const common = {
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: !process.env.QUANSIOX_DEBUG,
  jsx: 'automatic',
  loader: {},
  logLevel: 'info',
};

const targets = [
  {
    entryPoints: [path.join(root, 'src/renderer-src/main.jsx')],
    outfile: path.join(root, 'src/renderer/assets/app.js'),
  },
  {
    entryPoints: [path.join(root, 'src/renderer-src/panel.jsx')],
    outfile: path.join(root, 'src/renderer/assets/panel.js'),
  },
];

Promise.all(targets.map((t) => esbuild.build({ ...common, ...t })))
  .then(() => {
    for (const t of targets) console.log(`renderer built → ${path.relative(root, t.outfile)}`);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
