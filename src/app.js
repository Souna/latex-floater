// src/app.js — renderer-side logic.
//
// Responsibilities:
//   1. Mirror the math-field's current value into the "TeX" source bar.
//   2. Handle the two copy actions (LaTeX / PNG).
//   3. Handle pin / minimize / close / clear / history / theme / opacity / font size.
//   4. Keyboard shortcuts: Ctrl+Enter copy, Ctrl+Backspace/Esc clear,
//      Alt+Up/Down history, Ctrl+-/= or Ctrl+scroll font size, Tab always
//      stays inside the field.
//
// MathQuill is used instead of MathLive specifically to match Symbolab's
// cursor behavior: the caret stays inside a superscript/subscript/fraction
// until you press Tab or right-arrow past the end, rather than exiting after
// one character. This is MathQuill's native default.

// ---------------------------------------------------------------------------
// Initialize MathQuill.
//
// spaceBehavesLikeTab keeps the caret inside the current structure (super-
// script, fraction, etc.) until the user explicitly presses Tab or navigates
// out — this is the Symbolab cursor feel the MathLive version lacked.
// ---------------------------------------------------------------------------

const MQ = MathQuill.getInterface(2);
const mqEl = document.getElementById('mf');

// ---------------------------------------------------------------------------
// History — last 20 expressions, navigated with Alt+Up / Alt+Down.
// ---------------------------------------------------------------------------

const HISTORY_MAX = 20;

function loadHistory() {
  try { return JSON.parse(localStorage.getItem('history') || '[]'); }
  catch { return []; }
}

function saveToHistory(latex) {
  if (!latex.trim()) return;
  const history = loadHistory();
  if (history[0] === latex) return;   // don't duplicate consecutive entries
  history.unshift(latex);
  localStorage.setItem('history', JSON.stringify(history.slice(0, HISTORY_MAX)));
}

let historyIndex = -1;   // -1 = current unsaved draft
let historyDraft = '';   // saved draft when user starts navigating
let navigating   = false; // prevents edit handler from resetting historyIndex mid-navigate

function navigateHistory(direction) {
  const history = loadHistory();
  if (history.length === 0) return;

  if (direction === 'up') {
    if (historyIndex === -1) historyDraft = mf.latex();
    if (historyIndex < history.length - 1) historyIndex++;
  } else {
    if (historyIndex === -1) return;
    historyIndex--;
  }

  navigating = true;
  mf.latex(historyIndex === -1 ? historyDraft : history[historyIndex]);
  navigating = false;
  updateSource();
}

const mf = MQ.MathField(mqEl, {
  spaceBehavesLikeTab: true,
  // Without this, MathQuill lets a typed '|' close whatever bracket is
  // currently open (since '|' is a valid closer for interval notation like
  // "(0,1]"). That's what broke "ln(|y|)": the '|' after '(' was consumed as
  // the paren's closer instead of opening its own abs-value pair. Restricting
  // mismatched brackets makes '|' only pair with another '|'.
  restrictMismatchedBrackets: true,
  autoCommands: 'pi theta phi alpha beta gamma delta epsilon zeta eta iota kappa lambda mu nu xi rho sigma tau upsilon chi psi omega infty sqrt',
  autoOperatorNames: 'sin cos tan cot sec csc sinh cosh tanh arcsin arccos arctan log ln det lim',
  handlers: {
    edit: () => {
      if (!navigating) historyIndex = -1;
      updateSource();
    }
  }
});

// ---------------------------------------------------------------------------
// Mirror the math-field value into the TeX source bar.
// ---------------------------------------------------------------------------

const sourceOut = document.getElementById('source-out');

function updateSource() {
  sourceOut.textContent = mf.latex() || '';
}

// ---------------------------------------------------------------------------
// Copy actions.
// ---------------------------------------------------------------------------

const statusEl = document.getElementById('status');
let statusTimer = null;

function flashStatus(msg, type = 'success') {
  statusEl.textContent = msg;
  statusEl.classList.remove('is-success', 'is-error');
  statusEl.classList.add('is-visible', type === 'error' ? 'is-error' : 'is-success');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => statusEl.classList.remove('is-visible'), 1400);
}

async function copyLatex() {
  const latex = mf.latex() || '';
  if (!latex.trim()) return flashStatus('empty — nothing to copy', 'error');
  await window.floater.copyText(latex);
  saveToHistory(latex);
  flashStatus(`copied LaTeX (${latex.length} chars)`);
}

// PNG export: window.floater.renderPng (bridge.js) rasterises the LaTeX
// in-page via MathJax's SVG output and hands back a PNG data URL, which
// copyImage ships to the native clipboard. The export is always
// white-background/dark-text regardless of the app theme, since the image
// isn't meant to carry the UI's colours.
async function copyPng() {
  const latex = mf.latex() || '';
  if (!latex.trim()) return flashStatus('empty — nothing to copy', 'error');
  try {
    const dataUrl = await window.floater.renderPng(latex, fontSize);
    const ok = await window.floater.copyImage(dataUrl);
    flashStatus(ok ? 'copied PNG' : 'PNG copy failed', ok ? 'success' : 'error');
  } catch (e) {
    console.error(e);
    flashStatus('PNG export failed', 'error');
  }
}

document.getElementById('copy-latex').addEventListener('click', copyLatex);
document.getElementById('copy-png').addEventListener('click', copyPng);

// ---------------------------------------------------------------------------
// Window chrome buttons.
// ---------------------------------------------------------------------------

const pinBtn = document.getElementById('btn-pin');

function applyPinState(isPinned) {
  pinBtn.classList.toggle('is-active', isPinned);
  pinBtn.title = isPinned ? 'Unpin (always on top: ON)' : 'Pin (always on top: OFF)';
}

pinBtn.addEventListener('click', async () => {
  applyPinState(await window.floater.togglePin());
});

// The button used to be hardcoded "active" in the HTML regardless of the
// real state, which is restored from last session's settings on launch —
// so it could show pinned when the window actually wasn't (and vice versa),
// making the pin button look like it did the opposite of what you clicked.
window.floater.getPinState().then(applyPinState);

document.getElementById('btn-minimize').addEventListener('click', () => window.floater.minimize());
document.getElementById('btn-close').addEventListener('click', () => window.floater.close());

// Clear button + Esc shortcut. Auto-copies current expression before clearing.
const clearField = async () => {
  const latex = mf.latex() || '';
  if (latex.trim()) {
    await window.floater.copyText(latex);
    saveToHistory(latex);
    flashStatus('copied & cleared');
  }
  mf.latex('');
  updateSource();
  mf.focus();
};
document.getElementById('btn-clear').addEventListener('click', clearField);

// The math field is a 40px strip vertically centred in a much taller editor
// area. Clicking the empty space around it used to move focus to <body>,
// after which typing went nowhere until the user found the strip. Treat a
// click anywhere in the editor box as a click into the field.
document.querySelector('.editor').addEventListener('mousedown', (e) => {
  if (mqEl.contains(e.target) || e.target.closest('#btn-clear')) return;
  e.preventDefault();
  mf.focus();
  mf.moveToRightEnd();
});

// ---------------------------------------------------------------------------
// Shorthand substitution.
//
// When the user types a word from this map and then presses Space, we delete
// the typed letters and replace them with the LaTeX symbol. This runs in the
// capture phase so we intercept Space before MathQuill does — necessary because
// spaceBehavesLikeTab would otherwise consume the Space before we see it.
//
// Lowercase Greek letters are deliberately NOT in this map. MathQuill's own
// autoCommands (configured above) already turn "pi", "theta", "alpha", ...
// into the symbol the instant the last letter is typed, so by the time Space
// arrives there are no letters left to replace. An earlier version listed
// them here anyway and kept its own tally of letters typed, then sent that
// many Backspaces on Space — the first deleted the already-substituted
// symbol and the rest ate whatever came before it, so "x+pi " came out as
// "x\pi". Only put words here that MathQuill won't substitute by itself.
// ---------------------------------------------------------------------------

const SHORTHANDS = {
  // Custom (no matching LaTeX command name)
  'inf':     '\\infty',
  // Greek uppercase — no MathQuill autoCommand covers these.
  'Gamma':   '\\Gamma',   'Delta':   '\\Delta',   'Theta':   '\\Theta',
  'Lambda':  '\\Lambda',  'Xi':      '\\Xi',      'Pi':      '\\Pi',
  'Sigma':   '\\Sigma',   'Upsilon': '\\Upsilon', 'Phi':     '\\Phi',
  'Psi':     '\\Psi',     'Omega':   '\\Omega',
};

// The word to substitute is read back from MathQuill's own node list at the
// moment Space is pressed, rather than from a running tally of keystrokes.
// A keystroke tally can't tell when the caret moved (mouse click, history
// navigation, an autoCommand collapsing letters into one symbol) and would
// then delete the wrong number of things. Walking left from the caret over
// plain-letter nodes always reflects exactly what is about to be replaced.
// `ctrlSeq === letter` is the same test MathQuill uses internally to skip
// letters already absorbed into an operator name like "sin". The `-1` index
// is MathQuill's L constant (left sibling); the chain ends with a falsy 0.
function wordLeftOfCaret() {
  const cursor = mf.__controller.cursor;
  let word = '';
  for (let node = cursor[-1]; node && node.letter && node.ctrlSeq === node.letter; node = node[-1]) {
    word = node.letter + word;
  }
  return word;
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts + shorthand detection (capture phase).
//   Ctrl+Enter → Copy LaTeX
//   Esc        → Clear field
//   Space      → Substitute shorthand if the word left of the caret matches
// ---------------------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  // Global shortcuts first. Use Cmd on Mac, Ctrl on Windows/Linux.
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === 'Enter')        { e.preventDefault(); copyLatex(); return; }
  if (mod && e.key === 'c') {
    // If MathQuill has an active selection, let it handle Ctrl+C natively so
    // only the highlighted portion is copied. If nothing is selected, capture
    // the event ourselves and copy the entire expression.
    const hasSel = !!(mf.__controller && mf.__controller.cursor.selection);
    if (!hasSel) { e.preventDefault(); e.stopPropagation(); copyLatex(); }
    return;
  }
  if (e.key === 'Escape')              { e.preventDefault(); clearField(); return; }
  if (e.altKey && e.key === 'ArrowUp')   { e.preventDefault(); navigateHistory('up');   return; }
  if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); navigateHistory('down'); return; }

  // Ctrl+Backspace used to fall through to MathQuill's default handling,
  // which just deletes one character like a plain Backspace. Route it to the
  // same "wipe the whole expression" behavior as Esc.
  if (mod && e.key === 'Backspace') { e.preventDefault(); clearField(); return; }

  // Mirror the A-/A+ buttons so font size can be scaled from the keyboard too.
  if (mod && (e.key === '-' || e.key === '_')) { e.preventDefault(); decreaseFontSize(); return; }
  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); increaseFontSize(); return; }

  // MathQuill treats Tab as "leave the current block" (e.g. numerator ->
  // denominator); once there's nowhere left to go, it stops handling the key
  // and the browser's default tab-to-next-focusable-element kicks in,
  // sending focus to whatever's next in the DOM (the clear button). Keep Tab
  // scoped to the math field always by feeding it to MathQuill as a no-op
  // when there's nothing to navigate to, instead of letting it escape.
  if (!mod && !e.altKey && e.key === 'Tab') {
    e.preventDefault();
    mf.keystroke(e.shiftKey ? 'Shift-Tab' : 'Tab');
    return;
  }

  // Shorthand substitution on Space (see SHORTHANDS above). Only when the
  // math field itself has focus — a Space while a button is focused is the
  // button's to handle, not ours.
  if (e.key === ' ' && !e.ctrlKey && !e.metaKey && !e.altKey && mqEl.contains(document.activeElement)) {
    const word = wordLeftOfCaret();
    const cmd = SHORTHANDS[word];
    if (cmd) {
      e.preventDefault();
      e.stopPropagation();
      for (let i = 0; i < word.length; i++) mf.keystroke('Backspace');
      mf.cmd(cmd);
      updateSource();
    }
  }
}, true); // capture phase — fires before MathQuill's internal handlers

// Ctrl+scroll also scales the font, mirroring the A-/A+ buttons and the
// Ctrl+-/Ctrl+= shortcuts above. Must be non-passive so we can stop the
// browser's own page-zoom gesture from firing instead.
document.addEventListener('wheel', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  if (e.deltaY < 0) increaseFontSize(); else decreaseFontSize();
}, { passive: false });

// ---------------------------------------------------------------------------
// Light / dark theme toggle.
// ---------------------------------------------------------------------------

const iconSun  = document.getElementById('icon-sun');
const iconMoon = document.getElementById('icon-moon');

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const isLight = theme === 'light';
  iconSun.style.display  = isLight ? 'none'  : '';
  iconMoon.style.display = isLight ? ''      : 'none';
  localStorage.setItem('theme', theme);
}

applyTheme(localStorage.getItem('theme') || 'dark');

document.getElementById('btn-theme').addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  applyTheme(next);
  mf.focus();
});

// Click the TeX source bar to copy LaTeX instantly.
document.querySelector('.source').addEventListener('click', async () => {
  const latex = mf.latex() || '';
  if (!latex.trim()) return flashStatus('empty — nothing to copy', 'error');
  await window.floater.copyText(latex);
  saveToHistory(latex);
  flashStatus('copied LaTeX');
});

// ---------------------------------------------------------------------------
// Opacity slider.
// ---------------------------------------------------------------------------

const opacitySlider = document.getElementById('opacity-slider');
opacitySlider.value = Math.round((parseFloat(localStorage.getItem('opacity') || '1')) * 100);

opacitySlider.addEventListener('input', () => {
  const value = opacitySlider.value / 100;
  window.floater.setOpacity(value);
  localStorage.setItem('opacity', value);
});

// ---------------------------------------------------------------------------
// Font size controls.
// ---------------------------------------------------------------------------

const FONT_MIN = 12;
const FONT_MAX = 48;
const FONT_STEP = 2;
const FONT_DEFAULT = 18;

let fontSize = parseInt(localStorage.getItem('fontSize') || FONT_DEFAULT, 10);

function applyFontSize() {
  mqEl.style.fontSize = fontSize + 'px';
  localStorage.setItem('fontSize', fontSize);
}

// Shared by the A-/A+ buttons, the Ctrl+-/Ctrl+= shortcuts, and Ctrl+scroll.
function increaseFontSize() {
  if (fontSize < FONT_MAX) { fontSize += FONT_STEP; applyFontSize(); }
  mf.focus();
}
function decreaseFontSize() {
  if (fontSize > FONT_MIN) { fontSize -= FONT_STEP; applyFontSize(); }
  mf.focus();
}

document.getElementById('btn-font-inc').addEventListener('click', increaseFontSize);
document.getElementById('btn-font-dec').addEventListener('click', decreaseFontSize);

// ---------------------------------------------------------------------------
// Boot.
// ---------------------------------------------------------------------------

applyFontSize();
window.floater.setOpacity(parseFloat(localStorage.getItem('opacity') || '1'));
updateSource();
setTimeout(() => mf.focus(), 50);

// Re-focus the math field whenever the app window comes back into focus.
window.floater.onFocus(() => mf.focus());
