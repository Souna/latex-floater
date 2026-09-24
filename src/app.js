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
// History — last 20 expressions of THIS session, navigated with Alt+Up / Alt+Down.
//
// Deliberately in memory only: it starts empty at every launch and is gone
// when the app closes. It used to live in localStorage, which showed the
// previous sessions' expressions on the next launch. (Named sessionHistory
// because a top-level `history` would collide with window.history.)
// ---------------------------------------------------------------------------

const HISTORY_MAX = 20;
const sessionHistory = [];

function saveToHistory(latex) {
  if (!latex.trim()) return;
  if (sessionHistory[0] === latex) return;   // don't duplicate consecutive entries
  sessionHistory.unshift(latex);
  sessionHistory.length = Math.min(sessionHistory.length, HISTORY_MAX);
  renderHistory();
  // The battle pass counts exactly what the history does: a committed expression.
  window.BattlePass.award(latex);
}

let historyIndex = -1;   // -1 = current unsaved draft
let historyDraft = '';   // saved draft when user starts navigating
let navigating   = false; // prevents edit handler from resetting historyIndex mid-navigate

// Loads history entry `index` into the field (-1 restores the draft the user
// was typing before they started browsing). Shared by Alt+Up/Down and by
// clicking an entry in the visible stack.
function showHistoryEntry(index) {
  if (historyIndex === -1 && index !== -1) historyDraft = mf.latex();
  historyIndex = index;

  navigating = true;
  mf.latex(index === -1 ? historyDraft : sessionHistory[index]);
  navigating = false;
  updateSource();
  markActiveHistory();
  mf.focus();
  mf.moveToRightEnd();
}

function navigateHistory(direction) {
  if (sessionHistory.length === 0) return;
  if (direction === 'up') {
    if (historyIndex < sessionHistory.length - 1) showHistoryEntry(historyIndex + 1);
  } else if (historyIndex !== -1) {
    showHistoryEntry(historyIndex - 1);
  }
}

const mf = MQ.MathField(mqEl, {
  spaceBehavesLikeTab: true,
  // Without this, MathQuill lets a typed '|' close whatever bracket is
  // currently open (since '|' is a valid closer for interval notation like
  // "(0,1]"). That's what broke "ln(|y|)": the '|' after '(' was consumed as
  // the paren's closer instead of opening its own abs-value pair. Restricting
  // mismatched brackets makes '|' only pair with another '|'.
  restrictMismatchedBrackets: true,
  autoCommands: 'pi theta phi alpha beta gamma delta epsilon zeta eta iota kappa lambda mu nu xi rho sigma tau upsilon chi psi omega infty sqrt int sum prod',
  autoOperatorNames: 'sin cos tan cot sec csc sinh cosh tanh arcsin arccos arctan log ln det lim',
  handlers: {
    edit: () => {
      if (!navigating && historyIndex !== -1) { historyIndex = -1; markActiveHistory(); }
      updateSource();
    }
  }
});

// ---------------------------------------------------------------------------
// The history panel.
//
// Every committed expression (copied or cleared) is rendered as static math
// in a side panel (#history, styled and positioned in styles.css as a
// pop-out that slides in over the editor's right edge rather than living in
// the field's own layout), newest nearest the toggle, each older one a
// little dimmer. Clicking one loads it into the field; Alt+Up/Down walks the
// same list and highlights where it is, whether or not the panel is
// currently slid out. The stack is rebuilt in full whenever history changes
// — at most 20 small static renders, cheap enough that incremental DOM
// surgery isn't worth its complexity.
// ---------------------------------------------------------------------------

const historyBox  = document.getElementById('history');
const historyList = document.getElementById('history-list');

function historyOpacity(index) {
  return Math.max(0.2, 0.65 - index * 0.09);
}

function renderHistory() {
  historyList.textContent = '';
  // Oldest first in the DOM so the newest ends up at the bottom of the
  // panel, nearest the toggle that opens it.
  for (let i = sessionHistory.length - 1; i >= 0; i--) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'history__item';
    item.dataset.index = i;
    item.title = 'Load into the editor';
    item.style.opacity = historyOpacity(i);
    if (i === historyIndex) item.classList.add('is-active');
    const math = document.createElement('span');
    item.appendChild(math);
    MQ.StaticMath(math).latex(sessionHistory[i]);
    historyList.appendChild(item);
  }
  historyBox.scrollTop = historyBox.scrollHeight;
}

// Slide the panel in/out. It starts hidden every launch (like the battle
// pass track, the choice isn't remembered) and, being an overlay
// (styles.css), never affects the field's position or the graph/battle-pass
// window-growth maths either way. Alt+Up/Down still work while it's hidden.
const historyToggle = document.getElementById('history-toggle');

function setHistoryShown(shown) {
  historyBox.classList.toggle('is-hidden', !shown);
  historyToggle.classList.toggle('is-active', shown);
  historyToggle.title = shown ? 'Hide history' : 'Show history';
}

historyToggle.addEventListener('click', () => {
  setHistoryShown(historyBox.classList.contains('is-hidden'));
  mf.focus();
});
setHistoryShown(false);

function markActiveHistory() {
  for (const item of historyList.children) {
    item.classList.toggle('is-active', Number(item.dataset.index) === historyIndex);
  }
}

historyList.addEventListener('click', (e) => {
  const item = e.target.closest('.history__item');
  if (item) showHistoryEntry(Number(item.dataset.index));
});

// ---------------------------------------------------------------------------
// Mirror the math-field value into the TeX source bar.
// ---------------------------------------------------------------------------

const sourceOut = document.getElementById('source-out');

function updateSource() {
  const latex = mf.latex() || '';
  sourceOut.textContent = latex;
  updateResult(latex);
  if (graphOpen) window.Grapher.setLatex(latex);
}

// ---------------------------------------------------------------------------
// Result readout.
//
// If what's in the field is a closed expression — no "=", no free x or y —
// its value is shown at the bottom right of the field ("= -2" for a
// definite integral), the way Desmos does. LatexMath.evaluate does the work:
// arithmetic, functions, constants, and numerically evaluated \int, \sum
// and \prod. Anything that doesn't parse, or isn't a closed value, simply
// shows nothing; the graph bar is where parse errors are reported.
// ---------------------------------------------------------------------------

const resultEl = document.getElementById('result');

function formatResult(v) {
  if (!Number.isFinite(v)) return v > 0 ? '∞' : v < 0 ? '-∞' : 'undefined';
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e12 || a < 1e-6)) return v.toExponential(6).replace(/\.?0+e/, 'e');
  // Ten significant digits, which turns the numerical -2.0000000000004 of
  // an integral back into -2, without hiding genuine digits of sqrt(2).
  return String(parseFloat(v.toPrecision(10)));
}

function updateResult(latex) {
  let text = '';
  try {
    const v = window.LatexMath.evaluate(latex);
    if (v !== null && !Number.isNaN(v)) text = '= ' + formatResult(v);
  } catch {
    // Not a closed expression, or not parseable: no readout.
  }
  resultEl.textContent = text;
  resultEl.hidden = !text;
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
  if (mqEl.contains(e.target) || e.target.closest('#btn-clear, .history__item, .graph, .pass')) return;
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
  // same "wipe the whole expression" behavior as Esc. stopPropagation matters
  // here for the same reason it does on Tab just below: this listener is on
  // document in the capture phase, so without it the same keydown goes on to
  // reach MathQuill's own handler on the field afterward and gets handled a
  // second time — harmless here today (backspacing an already-empty field is
  // a no-op) but the same latent double-handling bug, so closed off too.
  if (mod && e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); clearField(); return; }

  // Mirror the A-/A+ buttons so font size can be scaled from the keyboard too.
  if (mod && (e.key === '-' || e.key === '_')) { e.preventDefault(); decreaseFontSize(); return; }
  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); increaseFontSize(); return; }

  // MathQuill treats Tab as "go one block right if it exists, else escape
  // right" — e.g. numerator -> denominator, then out of the fraction — which
  // is exactly what we want, so mf.keystroke() below just delegates to it.
  // But without stopPropagation, this capture-phase listener doesn't stop
  // the same keydown from also reaching MathQuill's own handler on the field
  // afterward: it fires there too and moves a second block over, so Tab at
  // the end of a numerator skipped the denominator and landed after the
  // whole fraction (confirmed directly — MathQuill's own Tab handling was
  // never wrong, this listener was just triggering it twice). Also still
  // needed for its original purpose: once there's nowhere left to go,
  // MathQuill stops handling Tab and the browser's default
  // tab-to-next-focusable-element kicks in, sending focus to whatever's next
  // in the DOM (the clear button) — mf.keystroke() as a no-op there keeps
  // Tab scoped to the math field always.
  if (!mod && !e.altKey && e.key === 'Tab') {
    e.preventDefault();
    e.stopPropagation();
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
// Grapher panel.
//
// The graph's bar sits under the field permanently; its chevron expands the
// plot below it. Collapsed, the field and bar sit at the top of the editor
// area (history is a side panel now, not part of this layout — see
// styles.css); expanded, the plot takes the rest of the editor's height.
// The plot needs real height to be useful and the default window is short,
// so expanding grows the window by whatever the editor area is missing, and
// collapsing gives that back — graphPreGrowBounds is the window's exact
// {y, height} from just before it grew, remembered in localStorage
// alongside the open state so a relaunch that restores the (taller) window
// with the graph open still knows what to restore on collapse. graph.js
// owns everything inside the panel; this is just the plumbing around it.
// ---------------------------------------------------------------------------

const GRAPH_HEIGHT = 220;   // comfortable plot height the window is grown to provide
const GRAPH_MIN = 120;      // must match .graph's min-height in styles.css

const graphPanel  = document.getElementById('graph');
const graphWrap   = document.getElementById('graph-canvas-wrap');
const graphToggle = document.getElementById('graph-toggle');
const graphReset  = document.getElementById('graph-reset');
const graphStatus = document.getElementById('graph-status');
const editorEl    = document.querySelector('.editor');
const editorRow   = document.querySelector('.editor__row');

let graphOpen = localStorage.getItem('graphOpen') === 'true';

// {y, height} the window had just before the graph last grew it, or null if
// it isn't currently grown — see restoreBounds() in bridge.js for why this
// is a remembered absolute snapshot rather than a delta to reverse.
let graphPreGrowBounds = JSON.parse(localStorage.getItem('graphPreGrowBounds') || 'null');

// Everything visual about expanded vs collapsed, with no window resizing.
function applyGraphLayout(open) {
  graphPanel.classList.toggle('is-collapsed', !open);
  graphWrap.hidden = !open;
  graphReset.hidden = !open;
  graphToggle.title = open ? 'Collapse graph' : 'Expand graph';
  if (!open) graphStatus.textContent = 'Graph';
  graphStatus.classList.toggle('is-error', false);
}

// Grows the window until the editor area can hold the plot at its minimum
// height. Normally runs once, when the graph is first expanded; it also
// runs at boot when the graph was left open, which is a no-op when the
// window-state plugin has restored the grown window, and a rescue when it
// hasn't (a crash, or the app killed before the plugin could save). Only
// snapshots graphPreGrowBounds the first time (while it's still null) —
// growing further on a later call (the editor area turned out to need even
// more room) must not overwrite the original pre-grow size.
//
// Asks for exactly GRAPH_HEIGHT, not double it — an earlier version doubled
// it for the same reason battlepass.js briefly had PASS_ROOM: history used
// to live in the editor's own flex stack and shared its spare height
// equally with the graph, so growing enough for a comfortable plot meant
// growing enough for two. History is an absolutely-positioned overlay now
// (see the history panel comment above) and doesn't compete for that space
// at all, so the graph gets all of the editor's spare height to itself —
// doubling this would just over-grow the window and enforce a taller
// minimum than the plot actually needs, the same bug PASS_ROOM had, just
// not visible here the same way since the graph is flex:1 and simply
// absorbs whatever extra room it's given as a bigger plot, rather than
// leaving it as an unclaimed gap the way the pass's fixed-height track did.
async function ensureGraphRoom() {
  const available = editorEl.clientHeight - editorRow.offsetHeight - 16 - 8;
  const need = GRAPH_HEIGHT - available;
  if (need <= 0) return;
  if (!graphPreGrowBounds) {
    graphPreGrowBounds = await window.floater.getBounds();
    localStorage.setItem('graphPreGrowBounds', JSON.stringify(graphPreGrowBounds));
  }
  await window.floater.resizeBy(need);
}

// The window may not be shrunk below what the open panels need. With the
// graph expanded that is the plot at its minimum, plus the field row and
// everything outside the editor area ("chrome", which includes the battle
// pass track when that is open); otherwise the panel would overflow the
// editor area and hide the bars below it. With only the battle pass open it
// is the normal minimum plus the track. Both panels call this when they
// toggle.
function updateMinHeight() {
  const pass = window.BattlePass;
  let min = 280 + (pass.isOpen() ? pass.trackHeight : 0);
  if (graphOpen) {
    const chrome = window.innerHeight - editorEl.clientHeight;
    min = Math.max(min, chrome + editorRow.offsetHeight + 24 + GRAPH_MIN);
  }
  return window.floater.setMinHeight(Math.ceil(min));
}
window.updateMinHeight = updateMinHeight;

async function setGraphOpen(open) {
  graphOpen = open;
  localStorage.setItem('graphOpen', open);
  applyGraphLayout(open);

  if (open) {
    await ensureGraphRoom();
    await updateMinHeight();
    window.Grapher.refresh();
    window.Grapher.setLatex(mf.latex() || '');
  } else {
    await updateMinHeight();
    if (graphPreGrowBounds) {
      await window.floater.restoreBounds(graphPreGrowBounds);
      graphPreGrowBounds = null;
      localStorage.removeItem('graphPreGrowBounds');
    }
  }
  mf.focus();
}

// The whole bar toggles the panel, not just the chevron — except the reset
// button, which keeps its own single-purpose click. graphToggle itself is
// inside the bar, so a click or keyboard-Enter on it still reaches this
// listener via bubbling; it doesn't need (or have) a handler of its own.
document.querySelector('.graph__bar').addEventListener('click', (e) => {
  if (e.target.closest('#graph-reset')) return;
  setGraphOpen(!graphOpen);
});

// ---------------------------------------------------------------------------
// Themes. The palettes and the mechanics of applying one live in themes.js;
// the battle pass (battlepass.js) decides which are unlocked and owns the
// paint-brush dropdown. Here: the sun/moon toggle, its icon, and the
// grapher redraw a theme change needs.
// ---------------------------------------------------------------------------

const iconSun  = document.getElementById('icon-sun');
const iconMoon = document.getElementById('icon-moon');

document.addEventListener('themechange', ({ detail }) => {
  const isLight = detail.mode === 'light';
  iconSun.style.display  = isLight ? 'none'  : '';
  iconMoon.style.display = isLight ? ''      : 'none';
  window.Grapher.redraw();
});

{
  // Older builds stored 'dark' / 'light' as the theme itself; those are now
  // the two modes of Default.
  let saved = localStorage.getItem('theme') || 'default';
  let mode = localStorage.getItem('themeMode') || 'dark';
  if (saved === 'dark' || saved === 'light') { mode = saved; saved = 'default'; }
  window.Themes.apply(window.BattlePass.isUnlocked(saved) ? saved : 'default', mode);
}

document.getElementById('btn-theme').addEventListener('click', () => {
  window.Themes.toggleMode();
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
  // History entries follow the field's size but stay a step smaller, so the
  // live input is always the largest thing in the stack.
  historyList.style.fontSize = Math.round(fontSize * 0.85) + 'px';
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
// Restore the panel. The window-state plugin normally brings back the
// taller window, so ensureGraphRoom() finds nothing to do; graphPreGrowBounds
// (loaded from localStorage above) remembers what to restore on collapse
// either way.
applyGraphLayout(graphOpen);
if (graphOpen) {
  ensureGraphRoom().then(updateMinHeight).then(() => {
    window.Grapher.refresh();
    window.Grapher.setLatex(mf.latex() || '');
  });
} else {
  updateMinHeight();
}
setTimeout(() => mf.focus(), 50);

// Re-focus the math field whenever the app window comes back into focus.
window.floater.onFocus(() => mf.focus());
