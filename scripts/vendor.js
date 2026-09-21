// scripts/vendor.js — copies the handful of third-party runtime files the
// pages load out of node_modules into src/vendor/.
//
// Tauri serves the frontend from a plain directory (build.frontendDist in
// tauri.conf.json) and bundles exactly that directory into the app, so the
// old "../node_modules/…" script paths can't work in a packaged build. This
// is the allow-list of what actually ships; everything else in node_modules
// stays out. It runs automatically before `tauri dev` and `tauri build`
// (beforeDevCommand / beforeBuildCommand), and src/vendor/ is gitignored.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'src', 'vendor');

const FILES = {
  'jquery/dist/jquery.min.js':                 'jquery.min.js',
  'mathquill/build/mathquill.min.js':          'mathquill.min.js',
  'mathquill/build/mathquill.css':             'mathquill.css',
  // The only Symbola format Chromium and WebKit pick from mathquill.css's
  // @font-face list; the other five formats it ships are never fetched.
  'mathquill/build/font/Symbola.woff2':        'font/Symbola.woff2',
  // Loaded lazily by bridge.js on the first PNG export.
  'mathjax/es5/tex-svg.js':                    'tex-svg.js'
};

for (const [from, to] of Object.entries(FILES)) {
  const src = path.join(root, 'node_modules', from);
  const dst = path.join(out, to);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}
console.log(`vendored ${Object.keys(FILES).length} files into src/vendor/`);
