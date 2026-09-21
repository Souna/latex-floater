// src/themes.js — the app's colour themes and how one is applied.
//
// Every theme has a dark and a light mode, and the sun/moon button switches
// mode within the current theme. "Default" is the built-in look and lives
// entirely in styles.css (the :root block and html[data-theme="light"]).
// Every other theme is a battle-pass reward (battlepass.js) authored here
// as one full set of the same CSS variables, in whichever mode suits it;
// the other mode is derived on demand in HSL — every hue kept, lightness
// remapped so backgrounds go pale and text goes dark (or the reverse) and
// accents stay legible. Inverting the colour space would have wrecked the
// hues; this keeps Nebula purple in daylight. A chosen palette is written
// inline onto <html> so it overrides the stylesheet, alongside data-theme
// and data-mode attributes for the handful of flourishes in styles.css.
// Nothing else in the app needs to know themes exist: the grapher reads
// the variables through getComputedStyle.
//
// Public surface (window.Themes): THEMES, current(), mode(), apply(id, mode),
// toggleMode(), varsFor(id, mode).

(function () {
  'use strict';

  const VARS = ['bg', 'bg-raise', 'bg-hover', 'bg-sink', 'bg-bar', 'border', 'border-strong',
                'fg', 'fg-dim', 'fg-faint', 'accent', 'accent-soft', 'accent-hover',
                'danger', 'danger-bg', 'success'];

  // Palette entries are in VARS order. `base` is the mode the palette was
  // authored in; the other mode is derived.
  const palette = (list) => Object.fromEntries(VARS.map((k, i) => [k, list[i]]));

  const THEMES = {
    default: { name: 'Default', base: 'dark', vars: null },

    slate: { name: 'Slate', base: 'dark', blurb: 'Cool and quiet.', vars: palette([
      '#161a22', '#1e2430', '#29303f', '#10131a', '#12151c', '#2a3140', '#3a4356',
      '#e3e8f0', '#8d97a8', '#5c667a', '#7aa2f7', 'rgba(122,162,247,0.16)', '#93b4ff',
      '#f7768e', '#3a2230', '#9ece6a']) },

    nebula: { name: 'Nebula', base: 'dark', blurb: 'Deep space, faintly glowing.', vars: palette([
      '#14101f', '#1d1730', '#2a2144', '#0e0b17', '#110d1b', '#2d2447', '#3f3462',
      '#ece6ff', '#a596c9', '#6b5f8f', '#d97bff', 'rgba(217,123,255,0.18)', '#e79dff',
      '#ff6b8b', '#3d1f2e', '#7ee8a2']) },

    forest: { name: 'Forest', base: 'dark', blurb: 'Moss on dark stone.', vars: palette([
      '#121a14', '#18241b', '#223126', '#0d130f', '#0f1611', '#24332a', '#34493b',
      '#e2ece4', '#8faa96', '#5d7563', '#7fc98a', 'rgba(127,201,138,0.16)', '#9adca3',
      '#e57373', '#3a2222', '#a5d6a7']) },

    synthwave: { name: 'Synthwave', base: 'dark', blurb: 'Neon on violet. Sunglasses optional.', vars: palette([
      '#1a0f2e', '#251642', '#33205a', '#120a20', '#150c26', '#3a2566', '#52358c',
      '#f5eaff', '#b89fdc', '#7a5ea6', '#ff4fd8', 'rgba(255,79,216,0.2)', '#ff7ae3',
      '#ff5c7a', '#40182b', '#4ff0e0']) },

    sepia: { name: 'Sepia', base: 'light', blurb: 'Old paper, warm ink.', vars: palette([
      '#f3ead8', '#fbf5e8', '#e8dcc4', '#ece1cb', '#e6d9c0', '#d3c3a5', '#b8a585',
      '#3d2f1e', '#7a6a52', '#a4957c', '#a2622a', 'rgba(162,98,42,0.14)', '#b8732f',
      '#b23a3a', '#f5dcdc', '#4d7c3a']) },

    blueprint: { name: 'Blueprint', base: 'dark', blurb: 'White lines on drafting blue.', vars: palette([
      '#0f2d5c', '#153a73', '#1d4886', '#0b234a', '#0c2650', '#24508f', '#3567ad',
      '#eaf2ff', '#a9c1e6', '#6f8fbf', '#ffffff', 'rgba(255,255,255,0.16)', '#dfe9ff',
      '#ff8080', '#4a2440', '#8ff0b0']) },

    rose: { name: 'Rose', base: 'light', blurb: 'Soft pink, sharp accent.', vars: palette([
      '#fbeff3', '#fff8fa', '#f3dfe6', '#f5e6ec', '#f1dde5', '#e0c3cf', '#c9a0b1',
      '#3a2530', '#7d5f6c', '#a8929c', '#c2456f', 'rgba(194,69,111,0.14)', '#d3577f',
      '#b23a3a', '#f8dada', '#3f8a5a']) },

    terminal: { name: 'Terminal', base: 'dark', blurb: 'Green phosphor. Type louder.', vars: palette([
      '#050805', '#0a120a', '#102010', '#030503', '#040704', '#123812', '#1d5a1d',
      '#b8ffb8', '#58c058', '#2e7a2e', '#33ff66', 'rgba(51,255,102,0.16)', '#66ff88',
      '#ff5555', '#3a1010', '#33ff66']) },

    ocean: { name: 'Ocean', base: 'dark', blurb: 'Deep teal, slow tide.', vars: palette([
      '#0c1a24', '#112633', '#183546', '#081219', '#0a151d', '#1b3746', '#27515f',
      '#dcf0f7', '#86b0c0', '#517686', '#3fc1c9', 'rgba(63,193,201,0.16)', '#63d3da',
      '#ff7b7b', '#3a1e26', '#7fdc9a']) },

    gold: { name: 'Gold', base: 'dark', blurb: 'You wrote a lot of LaTeX.', vars: palette([
      '#121008', '#1c1809', '#2a230c', '#0c0a05', '#0f0d06', '#3a3010', '#5a4a18',
      '#fff3d0', '#c9b27a', '#86743f', '#f5c542', 'rgba(245,197,66,0.18)', '#ffd76a',
      '#ff6b6b', '#3d1f1f', '#b5e36b']) }
  };

  // ------------------------------------------------------ colour maths

  function parse(color) {
    let r, g, b;
    const hex = color.match(/^#([0-9a-f]{6})$/i);
    const rgba = color.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (hex) { const n = parseInt(hex[1], 16); r = n >> 16; g = (n >> 8) & 255; b = n & 255; }
    else if (rgba) { r = +rgba[1]; g = +rgba[2]; b = +rgba[3]; }
    else return { h: 0, s: 0, l: 0.5 };
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return { h: h / 6, s, l };
  }

  function hsl(h, s, l) {
    const f = (n) => {
      const k = (n + h * 12) % 12;
      const a = s * Math.min(l, 1 - l);
      const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      return Math.round(v * 255).toString(16).padStart(2, '0');
    };
    return '#' + f(0) + f(8) + f(4);
  }

  function rgba(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`;
  }

  // The other mode of an authored palette: the same hues with lightness
  // remapped. Surfaces take the background's hue (desaturated a little so a
  // pale tint doesn't turn garish), text takes the foreground's, and the
  // accent, danger and success colours keep theirs but move to a lightness
  // that reads against the new surfaces.
  function derive(vars, toMode) {
    const bg = parse(vars.bg), fg = parse(vars.fg), ac = parse(vars.accent);
    const dg = parse(vars.danger), sc = parse(vars.success);
    const bs = Math.min(bg.s, 0.3);
    const S = (l) => hsl(bg.h, bs, l);
    const T = (l, s) => hsl(fg.h, Math.min(fg.s, s), l);
    if (toMode === 'light') {
      const al = Math.min(ac.l, 0.42);
      const accent = hsl(ac.h, ac.s, al);
      return {
        bg: S(0.96), 'bg-raise': S(0.995), 'bg-hover': S(0.91), 'bg-sink': S(0.93), 'bg-bar': S(0.90),
        border: S(0.82), 'border-strong': S(0.70),
        fg: T(0.12, 0.4), 'fg-dim': T(0.40, 0.3), 'fg-faint': T(0.58, 0.25),
        accent, 'accent-soft': rgba(accent, 0.14), 'accent-hover': hsl(ac.h, ac.s, al + 0.08),
        danger: hsl(dg.h, dg.s, 0.42), 'danger-bg': hsl(dg.h, 0.6, 0.92), success: hsl(sc.h, sc.s, 0.32)
      };
    }
    const al = Math.max(ac.l, 0.6);
    const accent = hsl(ac.h, ac.s, al);
    return {
      bg: S(0.09), 'bg-raise': S(0.13), 'bg-hover': S(0.18), 'bg-sink': S(0.06), 'bg-bar': S(0.07),
      border: S(0.20), 'border-strong': S(0.30),
      fg: T(0.90, 0.4), 'fg-dim': T(0.60, 0.3), 'fg-faint': T(0.42, 0.25),
      accent, 'accent-soft': rgba(accent, 0.16), 'accent-hover': hsl(ac.h, ac.s, Math.min(al + 0.08, 0.9)),
      danger: hsl(dg.h, dg.s, 0.65), 'danger-bg': hsl(dg.h, 0.35, 0.18), success: hsl(sc.h, sc.s, 0.65)
    };
  }

  const derived = new Map();
  function varsFor(id, mode) {
    const theme = THEMES[id];
    if (!theme || !theme.vars) return null;
    if (theme.base === mode) return theme.vars;
    const key = id + ':' + mode;
    if (!derived.has(key)) derived.set(key, derive(theme.vars, mode));
    return derived.get(key);
  }

  // ---------------------------------------------------------- applying

  const root = document.documentElement;
  let currentId = 'default';
  let currentMode = 'dark';

  function apply(id, mode) {
    if (!THEMES[id]) id = 'default';
    if (mode !== 'light' && mode !== 'dark') mode = currentMode;
    currentId = id;
    currentMode = mode;
    // Default is entirely stylesheet-driven: data-theme picks the block.
    root.setAttribute('data-theme', id === 'default' ? mode : id);
    root.setAttribute('data-mode', mode);
    const vars = varsFor(id, mode);
    for (const key of VARS) {
      if (vars) root.style.setProperty('--' + key, vars[key]);
      else root.style.removeProperty('--' + key);
    }
    localStorage.setItem('theme', id);
    localStorage.setItem('themeMode', mode);
    document.dispatchEvent(new CustomEvent('themechange', { detail: { id, mode } }));
  }

  function toggleMode() {
    apply(currentId, currentMode === 'dark' ? 'light' : 'dark');
  }
  window.Themes = { THEMES, VARS, current: () => currentId, mode: () => currentMode, apply, toggleMode, varsFor };
})();
