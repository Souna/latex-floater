// src/capture.js — renders one LaTeX string into this off-screen window and
// reports its true rendered size back to main.js, which resizes this
// (invisible) window to fit before screenshotting it. See copyPng() in
// app.js for why PNG export needs this instead of just capturing the real
// app window directly.

const MQ = MathQuill.getInterface(2);
const mfEl = document.getElementById('mf');
const mf = MQ.MathField(mfEl);

window.captureBridge.onRender(async ({ latex, fontSize }) => {
  mf.latex(latex);
  mfEl.style.fontSize = (fontSize || 32) + 'px';

  // Two rAF ticks so Chromium has laid out and painted the new content
  // before we measure it.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  const rect = mfEl.getBoundingClientRect();
  window.captureBridge.reportSize({ width: rect.width, height: rect.height });
});
