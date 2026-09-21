// src/themes.js — the app's colour themes and how one is applied.
//
// "Dark" and "Light" are the two built-in themes and live entirely in
// styles.css (the :root block and [data-theme="light"]). Everything else
// here is a reward from the battle pass (battlepass.js): a full set of the
// same CSS variables, written inline onto <html> when chosen so it overrides
// the stylesheet, plus a data-theme attribute so styles.css can add a
// flourish or two for the unusual ones (Nebula's glow, Terminal's
// monospace, Gold's shimmer). Keeping every theme to the one variable set
// means nothing else in the app — the grapher included, which reads the
// variables through getComputedStyle — needs to know themes exist.
//
// Public surface (window.Themes): THEMES, current(), apply(id), toggleBase().

(function () {
  'use strict';

  const VARS = ['bg', 'bg-raise', 'bg-hover', 'bg-sink', 'bg-bar', 'border', 'border-strong',
                'fg', 'fg-dim', 'fg-faint', 'accent', 'accent-soft', 'accent-hover',
                'danger', 'danger-bg', 'success'];

  // Palette entries are in VARS order. `base` says which of the two built-in
  // looks a theme resembles, so the sun/moon toggle knows which way to flip.
  const palette = (list) => Object.fromEntries(VARS.map((k, i) => [k, list[i]]));

  const THEMES = {
    dark:  { name: 'Dark',  base: 'dark',  vars: null },
    light: { name: 'Light', base: 'light', vars: null },

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

  const root = document.documentElement;
  let currentId = 'dark';

  function apply(id) {
    const theme = THEMES[id] || THEMES.dark;
    if (!THEMES[id]) id = 'dark';
    currentId = id;
    root.setAttribute('data-theme', id);
    for (const key of VARS) {
      if (theme.vars) root.style.setProperty('--' + key, theme.vars[key]);
      else root.style.removeProperty('--' + key);
    }
    localStorage.setItem('theme', id);
    document.dispatchEvent(new CustomEvent('themechange', { detail: { id } }));
  }

  // The sun/moon button: from any dark-ish theme go to Light, from any
  // light-ish theme go to Dark.
  function toggleBase() {
    apply(THEMES[currentId].base === 'dark' ? 'light' : 'dark');
  }

  window.Themes = { THEMES, VARS, current: () => currentId, apply, toggleBase };
})();
