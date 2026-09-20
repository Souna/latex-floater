// src/bridge.js — the renderer's only contact with the native side.
//
// Under Electron this role was played by preload.js, which exposed
// window.floater over a contextBridge. Tauri injects a window.__TAURI__
// global instead (withGlobalTauri in tauri.conf.json), so this file builds
// the same window.floater object on top of it. app.js is written against
// window.floater and doesn't know or care which shell it's running in —
// keep it that way: anything shell-specific belongs here, not there.
//
// Three things are genuinely native and go through Rust commands (lib.rs):
// clipboard text, clipboard image, window opacity. Window chrome (pin,
// minimize, close, drag, focus events) uses Tauri's window API directly.
// PNG export, which Electron did by screenshotting a hidden window, is done
// entirely in this page now — see renderLatexToPng at the bottom.

const { invoke } = window.__TAURI__.core;
const appWindow = window.__TAURI__.window.getCurrentWindow();

// Pin state lives here in localStorage rather than in a native settings
// file: the window is declared always-on-top in tauri.conf.json, and the
// saved preference is re-applied on boot below, so the two never disagree.
let pinned = localStorage.getItem('pinned') !== 'false';

window.floater = {
  copyText: (text) => invoke('copy_text', { text: text ?? '' }),

  copyImage: async (dataUrl) => {
    const prefix = 'data:image/png;base64,';
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix)) return false;
    await invoke('copy_image', { pngBase64: dataUrl.slice(prefix.length) });
    return true;
  },

  togglePin: async () => {
    pinned = !pinned;
    localStorage.setItem('pinned', pinned);
    await appWindow.setAlwaysOnTop(pinned);
    return pinned;
  },
  getPinState: async () => pinned,

  minimize: () => appWindow.minimize(),
  close:    () => appWindow.close(),

  setOpacity: (value) => invoke('set_opacity', { value }),

  onFocus: (cb) => appWindow.onFocusChanged(({ payload: focused }) => { if (focused) cb(); }),

  renderPng: (latex, fontSize) => renderLatexToPng(latex, fontSize),

  platform: navigator.platform
};

appWindow.setAlwaysOnTop(pinned);

// WebView2 and WKWebView both offer a browser context menu (Reload, Inspect…)
// on right-click. Electron had none and nothing in this UI wants one.
document.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------------------------------------------------------------------------
// PNG export.
//
// Tauri has no equivalent of Electron's capturePage(), and screenshotting
// the live MathQuill DOM from inside the page (foreignObject tricks) is
// unreliable in WKWebView on macOS. So the PNG is produced by a second
// renderer that emits pure SVG paths: MathJax's SVG output. Paths, not
// fonts, means the SVG is self-contained and draws identically into a
// <canvas> on every platform — and it happens to look better than the
// on-screen MathQuill rendering, since it uses real TeX glyphs.
//
// MathJax is 2 MB of JavaScript, so it's loaded lazily on the first PNG
// export rather than at startup; the app's instant-availability promise
// (see the font comment in styles.css) is about the editor, not the export.
// ---------------------------------------------------------------------------

let mathJaxReady = null;

function loadMathJax() {
  if (mathJaxReady) return mathJaxReady;
  mathJaxReady = new Promise((resolve, reject) => {
    window.MathJax = {
      startup: { typeset: false },
      // 'none' inlines every glyph path into each SVG instead of sharing a
      // document-level <defs> cache — required for the SVG to stand alone
      // as an image source.
      svg: { fontCache: 'none' },
      tex: { packages: ['base', 'ams'] }
    };
    const script = document.createElement('script');
    script.src = 'vendor/tex-svg.js';
    script.onload = () => window.MathJax.startup.promise.then(resolve, reject);
    script.onerror = () => reject(new Error('MathJax failed to load'));
    document.head.appendChild(script);
  });
  return mathJaxReady;
}

// Rasterises `latex` and resolves to a "data:image/png;base64,…" URL, the
// same contract renderPng had under Electron. fontSize is the editor's
// current px size; the export is rendered at that size times SCALE so it
// stays crisp when pasted into something that displays it 1:1 on a HiDPI
// screen or scales it up.
const PNG_SCALE = 2;
const PNG_PADDING = 16;

async function renderLatexToPng(latex, fontSize) {
  await loadMathJax();

  // MathJax sizes its SVG in ex units relative to the surrounding font, so
  // measure it in the document at the requested font size to get pixels.
  const container = window.MathJax.tex2svg(latex, { display: true });
  container.style.cssText = `position:absolute; left:-100000px; top:0; font-size:${fontSize}px; visibility:hidden;`;
  document.body.appendChild(container);
  const svg = container.querySelector('svg');
  const rect = svg.getBoundingClientRect();
  container.remove();

  const width  = Math.ceil(rect.width);
  const height = Math.ceil(rect.height);
  svg.setAttribute('width',  `${width * PNG_SCALE}px`);
  svg.setAttribute('height', `${height * PNG_SCALE}px`);
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svg.removeAttribute('style');
  svg.setAttribute('style', 'color:#111111');

  const markup = new XMLSerializer().serializeToString(svg);
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error('SVG rasterisation failed'));
    image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
  });

  const canvas = document.createElement('canvas');
  canvas.width  = (width  + PNG_PADDING * 2) * PNG_SCALE;
  canvas.height = (height + PNG_PADDING * 2) * PNG_SCALE;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, PNG_PADDING * PNG_SCALE, PNG_PADDING * PNG_SCALE);
  return canvas.toDataURL('image/png');
}
