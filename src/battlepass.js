// src/battlepass.js — the battle pass. Yes, in a LaTeX editor.
//
// A friend asked for it, so it exists, and it's built properly. Writing
// LaTeX earns XP: every committed expression (copied or cleared — the same
// moment it enters the history) is worth a few points plus more for length
// and for structure, so a nested integral pays better than "x". Repeating
// the expression you just committed pays nothing, which is all the
// anti-farming this needs. XP fills fifty levels; every fifth level unlocks
// a theme (themes.js), with 10, 20, 30 and 40 being the unusual ones and 50
// being Gold; every other level pays LaTeX coins, which are a number in the
// titlebar and nothing more, for now.
//
// This file owns the XP rules, the level maths, the track UI (a horizontal
// path in a collapsible strip at the very bottom of the window, below the
// action row, in the same style as the graph's bar), the theme picker
// dropdown in the titlebar, and the coin count. Persistent state is one number: total XP in localStorage — levels,
// coins and unlocks all derive from it, so nothing can drift.

(function () {
  'use strict';

  const MAX_LEVEL = 50;
  const THEME_LEVELS = { 5: 'slate', 10: 'nebula', 15: 'forest', 20: 'synthwave', 25: 'sepia',
                         30: 'blueprint', 35: 'rose', 40: 'terminal', 45: 'ocean', 50: 'gold' };
  const UNIQUE_LEVELS = new Set([10, 20, 30, 40]);
  const PASS_HEIGHT = 156;      // expanded track height, css px (matches .pass__track-wrap)
  const PASS_ROOM = 60;         // history to keep visible when the pass grows the window

  // XP needed to go from level L to L+1: 16,250 in total, so roughly 300
  // typical formulas to reach 50 — a few weeks of real use, not an evening.
  const xpToNext = (L) => 80 + 10 * L;

  function rewardFor(level) {
    const theme = THEME_LEVELS[level];
    if (theme) return { type: 'theme', id: theme, unique: UNIQUE_LEVELS.has(level), gold: level === MAX_LEVEL };
    return { type: 'coins', amount: 20 + level };
  }

  // ------------------------------------------------------------- XP rules

  const STRUCTURE_XP = [
    [/\\int|\\sum|\\prod/g, 15],
    [/\\frac/g, 8],
    [/\\sqrt/g, 6],
    [/\\left/g, 3],
    [/[\^_]/g, 2],
    [/\\(alpha|beta|gamma|delta|epsilon|zeta|eta|theta|iota|kappa|lambda|mu|nu|xi|pi|rho|sigma|tau|upsilon|phi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega)\b/g, 3]
  ];

  function xpFor(latex) {
    const s = latex.trim();
    if (!s) return 0;
    let xp = 10 + 2 * Math.min(s.length, 150);
    for (const [re, bonus] of STRUCTURE_XP) xp += (s.match(re) || []).length * bonus;
    return Math.min(400, xp);
  }

  // ---------------------------------------------------------------- state

  let xp = parseInt(localStorage.getItem('bpXp') || '0', 10) || 0;
  let lastAwarded = localStorage.getItem('bpLast') || '';
  let open = localStorage.getItem('bpOpen') === 'true';
  let grown = parseInt(localStorage.getItem('bpGrown') || '0', 10) || 0;

  function levelInfo() {
    let level = 1, into = xp;
    while (level < MAX_LEVEL && into >= xpToNext(level)) { into -= xpToNext(level); level++; }
    return { level, into, need: level < MAX_LEVEL ? xpToNext(level) : 0 };
  }

  function coins() {
    const { level } = levelInfo();
    let total = 0;
    for (let L = 2; L <= level; L++) { const r = rewardFor(L); if (r.type === 'coins') total += r.amount; }
    return total;
  }

  function themeLevel(id) {
    for (const [L, t] of Object.entries(THEME_LEVELS)) if (t === id) return Number(L);
    return 0;   // Dark and Light: always available
  }
  const isUnlocked = (id) => themeLevel(id) <= levelInfo().level;

  // ------------------------------------------------------------ elements

  const panel     = document.getElementById('pass');
  const bar       = panel.querySelector('.pass__bar');
  const levelEl   = document.getElementById('pass-level');
  const xpEl      = document.getElementById('pass-xp');
  const fillEl    = document.getElementById('pass-xpfill');
  const gainEl    = document.getElementById('pass-gain');
  const toggleBtn = document.getElementById('pass-toggle');
  const trackWrap = document.getElementById('pass-track-wrap');
  const track     = document.getElementById('pass-track');
  const coinEl    = document.getElementById('coin-count');
  const paletteBtn = document.getElementById('btn-palette');
  const menu      = document.getElementById('theme-menu');
  const editorEl  = document.querySelector('.editor');

  // -------------------------------------------------------------- track

  const nodes = [];

  function buildTrack() {
    track.textContent = '';
    for (let L = 1; L <= MAX_LEVEL; L++) {
      const node = document.createElement('button');
      node.type = 'button';
      node.className = 'pass__node';
      node.dataset.level = L;
      const reward = L === 1 ? null : rewardFor(L);
      let icon = '', label = 'Start';
      if (reward && reward.type === 'theme') {
        const theme = window.Themes.THEMES[reward.id];
        node.classList.add('is-theme');
        if (reward.unique) node.classList.add('is-unique');
        if (reward.gold) node.classList.add('is-gold');
        icon = `<span class="pass__swatch" style="--swatch:${theme.vars.accent}; --swatch-bg:${theme.vars.bg}"></span>`;
        label = theme.name;
        node.title = `Level ${L}: the ${theme.name} theme` + (theme.blurb ? ` — ${theme.blurb}` : '');
      } else if (reward) {
        icon = coinSvg();
        label = `${reward.amount}`;
        node.title = `Level ${L}: ${reward.amount} LaTeX coins`;
      } else {
        node.title = 'Level 1';
      }
      node.innerHTML = `<span class="pass__reward">${icon}</span><span class="pass__dot">${L}</span><span class="pass__label">${label}</span>`;
      track.appendChild(node);
      nodes.push(node);
    }
    const fill = document.createElement('div');
    fill.className = 'pass__fill';
    fill.id = 'pass-fill';
    track.appendChild(fill);
  }

  function coinSvg() {
    return '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="var(--accent)" stroke="var(--accent-hover)"/><text x="8" y="11.2" text-anchor="middle" font-size="8.5" font-family="IBM Plex Mono, monospace" font-weight="600" fill="var(--bg)">L</text></svg>';
  }

  // Clicking an unlocked theme on the track applies it; anything else just
  // shows its title.
  track.addEventListener('click', (e) => {
    const node = e.target.closest('.pass__node');
    if (!node) return;
    const L = Number(node.dataset.level);
    const reward = L === 1 ? null : rewardFor(L);
    if (reward && reward.type === 'theme' && L <= levelInfo().level) window.Themes.apply(reward.id);
  });

  // ------------------------------------------------------------- render

  const FILL_MS = 300;   // matches the .pass__xpfill transition in styles.css
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function setFill(pct, animate = true) {
    fillEl.style.transition = animate ? '' : 'none';
    fillEl.style.width = pct + '%';
    if (!animate) { void fillEl.offsetWidth; fillEl.style.transition = ''; }
  }
  const currentFillPct = () => { const { level, into, need } = levelInfo(); return level < MAX_LEVEL ? (into / need) * 100 : 100; };

  // A level-up plays as a progression rather than a jump: the bar fills to
  // the end, the label ticks over, the bar snaps to empty without animating,
  // then rises to the new value — once per level gained.
  async function animateLevelUps(fromLevel, toLevel) {
    for (let L = fromLevel; L < toLevel; L++) {
      setFill(100);
      await wait(FILL_MS + 40);
      levelEl.textContent = `Level ${L + 1}`;
      setFill(0, false);
      await wait(30);
    }
    setFill(currentFillPct());
  }

  function render(withFill = true) {
    const { level, into, need } = levelInfo();
    levelEl.textContent = `Level ${level}`;
    xpEl.textContent = level < MAX_LEVEL ? `${into} / ${need} XP` : `${xp} XP · maxed`;
    if (withFill) setFill(currentFillPct());
    coinEl.textContent = coins();

    nodes.forEach((node, i) => {
      const L = i + 1;
      node.classList.toggle('is-done', L <= level);
      node.classList.toggle('is-current', L === level);
    });
    // Progress line: through every reached node, plus the fraction toward the next.
    const fraction = level < MAX_LEVEL ? into / need : 0;
    const pct = ((level - 1 + fraction) / (MAX_LEVEL - 1)) * 100;
    const fill = document.getElementById('pass-fill');
    if (fill) fill.style.width = `calc(${pct}% )`;

    renderMenu();
  }

  let gainTimer = 0;
  function showGain(text) {
    gainEl.textContent = text;
    gainEl.hidden = false;
    gainEl.classList.remove('is-pop');
    void gainEl.offsetWidth;   // restart the animation
    gainEl.classList.add('is-pop');
    clearTimeout(gainTimer);
    gainTimer = setTimeout(() => { gainEl.hidden = true; }, 1600);
  }

  // ------------------------------------------------------------- award

  function award(latex) {
    const gain = xpFor(latex);
    if (gain === 0 || latex === lastAwarded) return;
    lastAwarded = latex;
    localStorage.setItem('bpLast', lastAwarded);
    const before = levelInfo().level;
    xp += gain;
    localStorage.setItem('bpXp', xp);
    const after = levelInfo().level;
    if (after > before) {
      render(false);
      levelEl.textContent = `Level ${before}`;   // the label ticks over as the bar plays
      animateLevelUps(before, after);
    } else {
      render();
    }
    showGain(`+${gain} XP`);
    for (let L = before + 1; L <= after; L++) {
      const r = rewardFor(L);
      const what = r.type === 'theme' ? `unlocked the ${window.Themes.THEMES[r.id].name} theme` : `+${r.amount} LaTeX coins`;
      if (typeof flashStatus === 'function') flashStatus(`Level ${L}! ${what}`);
      panel.classList.remove('is-levelup');
      void panel.offsetWidth;
      panel.classList.add('is-levelup');
    }
    if (after > before && open) scrollToCurrent();
  }

  // --------------------------------------------------- expand / collapse

  function applyLayout(isOpen) {
    panel.classList.toggle('is-collapsed', !isOpen);
    trackWrap.hidden = !isOpen;
    toggleBtn.title = isOpen ? 'Collapse battle pass' : 'Expand battle pass';
  }

  function scrollToCurrent() {
    const node = nodes[levelInfo().level - 1];
    if (node) trackWrap.scrollLeft = node.offsetLeft - trackWrap.clientWidth / 2 + node.offsetWidth / 2;
  }

  // The track's height comes out of the editor area (the history box, in
  // practice). Like the graph, if the editor can't spare it the window grows
  // by the shortfall, which is given back on collapse; and while the track
  // is open the window's minimum height includes it (updateMinHeight in
  // app.js), so it can't be shrunk out of view.
  async function setOpen(isOpen) {
    open = isOpen;
    localStorage.setItem('bpOpen', isOpen);
    applyLayout(isOpen);
    if (isOpen) {
      let others = 0;
      for (const el of editorEl.children) {
        if (el.classList.contains('editor__history')) continue;
        others += el.offsetHeight + 8;
      }
      const spare = editorEl.clientHeight - 16 - others;   // what the history box has now
      const need = PASS_HEIGHT - (spare - PASS_ROOM);
      if (need > 0) {
        grown += need;
        localStorage.setItem('bpGrown', grown);
        await window.floater.resizeBy(need);
      }
      scrollToCurrent();
    } else if (grown > 0) {
      const delta = grown;
      grown = 0;
      localStorage.setItem('bpGrown', 0);
      await window.floater.resizeBy(-delta);
    }
    if (window.updateMinHeight) await window.updateMinHeight();
  }

  toggleBtn.addEventListener('click', () => setOpen(!open));

  // --------------------------------------------------------- theme menu

  function renderMenu() {
    const { THEMES } = window.Themes;
    const current = window.Themes.current();
    menu.textContent = '';
    for (const [id, theme] of Object.entries(THEMES)) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'menu__item';
      // Not data-theme: styles.css keys the palettes on that attribute (on
      // <html>), and an item carrying data-theme="light" would paint itself
      // with the light palette's dark text on the dark menu.
      item.dataset.id = id;
      const unlocked = isUnlocked(id);
      const level = themeLevel(id);
      item.disabled = !unlocked;
      item.classList.toggle('is-current', id === current);
      const swatch = theme.vars ? `--swatch:${theme.vars.accent}; --swatch-bg:${theme.vars.bg}`
                                : (id === 'light' ? '--swatch:#a86e24; --swatch-bg:#f4f2ed' : '--swatch:#d4a45c; --swatch-bg:#12131a');
      item.innerHTML = `<span class="pass__swatch" style="${swatch}"></span><span class="menu__name">${theme.name}</span>` +
        (unlocked ? (id === current ? '<span class="menu__tag">current</span>' : '')
                  : `<span class="menu__tag menu__tag--lock">Lv ${level}</span>`);
      if (theme.blurb) item.title = theme.blurb;
      menu.appendChild(item);
    }
  }

  function openMenu() {
    renderMenu();
    const r = paletteBtn.getBoundingClientRect();
    menu.hidden = false;
    menu.style.top = (r.bottom + 4) + 'px';
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
  }
  function closeMenu() { menu.hidden = true; }

  paletteBtn.addEventListener('click', (e) => { e.stopPropagation(); if (menu.hidden) openMenu(); else closeMenu(); });
  menu.addEventListener('click', (e) => {
    const item = e.target.closest('.menu__item');
    if (!item || item.disabled) return;
    window.Themes.apply(item.dataset.id);
    closeMenu();
  });
  document.addEventListener('mousedown', (e) => { if (!menu.hidden && !menu.contains(e.target) && e.target !== paletteBtn) closeMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { closeMenu(); e.stopPropagation(); } }, true);
  document.addEventListener('themechange', renderMenu);

  // --------------------------------------------------------------- boot

  buildTrack();
  render();
  applyLayout(open);
  if (open) setOpen(true);

  window.BattlePass = { award, xpFor, levelInfo, coins, isUnlocked, setOpen, isOpen: () => open, trackHeight: PASS_HEIGHT };
})();
