// src/graph.js — the grapher panel: a Desmos-style plot of the expression
// currently in the field.
//
// Everything here is plain <canvas> 2D. A plotting library was considered
// and rejected: the ones that exist (function-plot, Plotly, …) are hundreds
// of kilobytes, want their own expression syntax rather than LaTeX, and
// bring a DOM/SVG model that fights the "one small always-on-top window"
// design. What this app needs is small: a grid with sensible tick steps, one
// curve, pan, zoom, and a handful of labelled points. That is ~450 lines.
//
// The view is a centre point in math coordinates plus a uniform pixels-per-
// unit scale, so the aspect ratio is always 1:1 like Desmos' default —
// circles look like circles. Redraws are coalesced onto one animation frame.
//
// Curves come in three kinds from LatexMath.compileEquation:
//   'y'         y = f(x): sampled once per pixel column, the path broken
//               wherever a sample is non-finite or jumps further than the
//               whole view (an asymptote, e.g. tan).
//   'x'         x = g(y): the same, per pixel row.
//   'implicit'  F(x, y) = 0: marching squares over a coarse grid, which is
//               what makes x² + y² = 4 draw as a circle.
//
// "Meaningful points" are found numerically on the visible range only, and
// re-found on every pan/zoom: sign changes of f refined by bisection give
// x-intercepts, local minima of |f| that reach ~0 give tangential zeros like
// x² at the origin, sign changes of the finite-difference slope refined by
// golden-section search give maxima and minima, f(0) gives the y-intercept.
// Implicit curves get their axis intercepts via the same 1-D machinery along
// each axis; extrema and self-intersections of implicit curves are not
// attempted (see CLAUDE.md, "Open threads").

(function () {
  'use strict';

  const panel    = document.getElementById('graph');
  const wrap     = document.getElementById('graph-canvas-wrap');
  const canvas   = document.getElementById('graph-canvas');
  const tip      = document.getElementById('graph-tip');
  const statusEl = document.getElementById('graph-status');
  const ctx      = canvas.getContext('2d');

  const DEFAULT_SCALE = 40;      // px per unit on first open
  const MIN_SCALE = 1e-7, MAX_SCALE = 1e9;
  const SAMPLES = 600;           // for point-finding along the visible range
  const CELL = 3;                // marching-squares cell, css px
  const HOVER_RADIUS = 10;       // px, for snapping to a point of interest
  const TRACE_RADIUS = 14;       // px, for tracing along the curve
  const MAX_POINTS = 120;

  const view = { cx: 0, cy: 0, scale: DEFAULT_SCALE };
  let curve = null;       // { kind, f, label } or null
  let errorText = '';
  let points = [];        // [{ x, y, kind }]
  let hover = null;       // { x, y, kind } | null
  let width = 0, height = 0, dpr = 1;
  let frame = 0;
  let pendingLatex = null, latexTimer = 0;

  // ------------------------------------------------------------ helpers

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const toPx = (x, y) => [width / 2 + (x - view.cx) * view.scale, height / 2 - (y - view.cy) * view.scale];
  const fromPx = (px, py) => [view.cx + (px - width / 2) / view.scale, view.cy - (py - height / 2) / view.scale];

  function visibleRange() {
    const [x0, y1] = fromPx(0, 0);
    const [x1, y0] = fromPx(width, height);
    return { x0, x1, y0, y1 };
  }

  // Grid step: the 1-2-5 sequence, chosen so major lines sit ~70px apart.
  function niceStep(minUnits) {
    const exp = Math.pow(10, Math.floor(Math.log10(minUnits)));
    for (const m of [1, 2, 5, 10]) if (m * exp >= minUnits) return m * exp;
    return 10 * exp;
  }

  function fmt(v) {
    if (!Number.isFinite(v)) return String(v);
    if (Math.abs(v) < 1e-12) return '0';
    const a = Math.abs(v);
    if (a >= 1e6 || a < 1e-4) return v.toExponential(3).replace(/\.?0+e/, 'e');
    return String(parseFloat(v.toPrecision(6)));
  }

  function fmtTick(v, step) {
    if (Math.abs(v) < step / 1e6) return '0';
    if (step >= 1e6 || step < 1e-4) return v.toExponential(1).replace(/\.?0+e/, 'e');
    const decimals = Math.max(0, -Math.floor(Math.log10(step)));
    return v.toFixed(decimals);
  }

  // --------------------------------------------------------- resizing

  function resize() {
    const rect = wrap.getBoundingClientRect();
    width = Math.max(1, Math.round(rect.width));
    height = Math.max(1, Math.round(rect.height));
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    schedule();
  }
  new ResizeObserver(resize).observe(wrap);

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; draw(); });
  }

  // ------------------------------------------------------------ drawing

  function draw() {
    if (panel.hidden || width === 0) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = css('--bg-sink');
    ctx.fillRect(0, 0, width, height);
    drawGrid();
    if (curve) {
      findPoints();
      drawCurve();
      drawPoints();
    }
  }

  function drawGrid() {
    const { x0, x1, y0, y1 } = visibleRange();
    const major = niceStep(70 / view.scale);
    const minor = major / (String(major)[0] === '2' ? 4 : 5);
    const gridMinor = css('--border');
    const gridMajor = css('--border-strong');
    const axis = css('--fg-dim');
    const label = css('--fg-faint');

    ctx.lineWidth = 1;
    const lines = (step, color) => {
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) {
        const px = Math.round(toPx(x, 0)[0]) + 0.5;
        ctx.moveTo(px, 0); ctx.lineTo(px, height);
      }
      for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) {
        const py = Math.round(toPx(0, y)[1]) + 0.5;
        ctx.moveTo(0, py); ctx.lineTo(width, py);
      }
      ctx.stroke();
    };
    lines(minor, gridMinor);
    lines(major, gridMajor);

    // Axes, and the tick labels hugging them (or the nearest edge when an
    // axis is scrolled out of view, so the numbers never disappear).
    const [ox, oy] = toPx(0, 0);
    ctx.strokeStyle = axis;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (ox >= 0 && ox <= width) { ctx.moveTo(ox, 0); ctx.lineTo(ox, height); }
    if (oy >= 0 && oy <= height) { ctx.moveTo(0, oy); ctx.lineTo(width, oy); }
    ctx.stroke();

    ctx.fillStyle = label;
    ctx.font = '10.5px "IBM Plex Mono", ui-monospace, monospace';
    const labelY = Math.min(Math.max(oy, 4), height - 14);
    const labelX = Math.min(Math.max(ox, 4), width - 4);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let x = Math.ceil(x0 / major) * major; x <= x1; x += major) {
      if (Math.abs(x) < major / 1e6) continue;
      ctx.fillText(fmtTick(x, major), toPx(x, 0)[0], labelY + 3);
    }
    ctx.textAlign = ox > width - 40 ? 'right' : 'left';
    ctx.textBaseline = 'middle';
    const dx = ox > width - 40 ? -4 : 4;
    for (let y = Math.ceil(y0 / major) * major; y <= y1; y += major) {
      if (Math.abs(y) < major / 1e6) continue;
      ctx.fillText(fmtTick(y, major), labelX + dx, toPx(0, y)[1]);
    }
  }

  function drawCurve() {
    ctx.strokeStyle = css('--accent');
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if (curve.kind === 'y') tracePath((px) => { const x = fromPx(px, 0)[0]; return [px, toPx(0, curve.f(x))[1]]; }, width);
    else if (curve.kind === 'x') tracePath((py) => { const y = fromPx(0, py)[1]; return [toPx(curve.f(y), 0)[0], py]; }, height);
    else marchingSquares();
    ctx.stroke();
  }

  // Walks one pixel at a time along the sampled axis, breaking the path at
  // non-finite values and at jumps bigger than the whole canvas (asymptotes).
  function tracePath(sample, length) {
    const limit = Math.max(width, height) * 4;
    let pen = false, prev = null;
    for (let i = 0; i <= length; i++) {
      const [px, py] = sample(i);
      const ok = Number.isFinite(px) && Number.isFinite(py);
      if (!ok) { pen = false; prev = null; continue; }
      const cx = Math.max(-1e5, Math.min(1e5, px)), cy = Math.max(-1e5, Math.min(1e5, py));
      if (pen && prev && (Math.abs(cx - prev[0]) > limit || Math.abs(cy - prev[1]) > limit)) pen = false;
      if (pen) ctx.lineTo(cx, cy); else ctx.moveTo(cx, cy);
      pen = true;
      prev = [cx, cy];
    }
  }

  function marchingSquares() {
    const cols = Math.ceil(width / CELL) + 1, rows = Math.ceil(height / CELL) + 1;
    const vals = new Float64Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const [x, y] = fromPx(c * CELL, r * CELL);
        vals[r * cols + c] = curve.f(x, y);
      }
    }
    const lerp = (a, b, va, vb) => a + (b - a) * (va / (va - vb));
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const tl = vals[r * cols + c], tr = vals[r * cols + c + 1];
        const bl = vals[(r + 1) * cols + c], br = vals[(r + 1) * cols + c + 1];
        if (![tl, tr, bl, br].every(Number.isFinite)) continue;
        const idx = (tl > 0 ? 8 : 0) | (tr > 0 ? 4 : 0) | (br > 0 ? 2 : 0) | (bl > 0 ? 1 : 0);
        if (idx === 0 || idx === 15) continue;
        const x0 = c * CELL, y0 = r * CELL, x1 = x0 + CELL, y1 = y0 + CELL;
        const top    = [lerp(x0, x1, tl, tr), y0];
        const bottom = [lerp(x0, x1, bl, br), y1];
        const left   = [x0, lerp(y0, y1, tl, bl)];
        const right  = [x1, lerp(y0, y1, tr, br)];
        const seg = (a, b) => { ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); };
        switch (idx) {
          case 1: case 14: seg(left, bottom); break;
          case 2: case 13: seg(bottom, right); break;
          case 3: case 12: seg(left, right); break;
          case 4: case 11: seg(top, right); break;
          case 5:          seg(top, left); seg(bottom, right); break;
          case 6: case 9:  seg(top, bottom); break;
          case 7: case 8:  seg(top, left); break;
          case 10:         seg(top, right); seg(left, bottom); break;
        }
      }
    }
  }

  function drawPoints() {
    const fg = css('--fg'), accent = css('--accent'), bg = css('--bg-sink');
    for (const p of points) {
      const [px, py] = toPx(p.x, p.y);
      const active = hover === p;
      ctx.beginPath();
      ctx.arc(px, py, active ? 5.5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = active ? accent : bg;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = active ? fg : accent;
      ctx.stroke();
    }
    if (hover && hover.kind === 'trace') {
      const [px, py] = toPx(hover.x, hover.y);
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();
    }
  }

  // ------------------------------------------------------ point finding

  function findPoints() {
    const { x0, x1, y0, y1 } = visibleRange();
    const found = [];
    // Numerical refinement lands within ~1e-8 of a flat minimum's true x
    // (the limit of resolving f differences in double precision), so a
    // coordinate that is negligible at the current zoom is snapped to 0
    // rather than shown as 1.05e-8.
    const tol = Math.max(x1 - x0, y1 - y0) * 1e-7;
    const push = (x, y, kind) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      if (Math.abs(x) < tol) x = 0;
      if (Math.abs(y) < tol) y = 0;
      if (x < x0 || x > x1 || y < y0 || y > y1) return;
      const [px, py] = toPx(x, y);
      if (found.some((q) => Math.hypot(q.px - px, q.py - py) < 3)) return;
      found.push({ x, y, kind, px, py });
    };

    if (curve.kind === 'y') {
      const f = curve.f;
      const a = analyze(f, x0, x1, y1 - y0);
      for (const t of a.zeros) push(t, 0, 'x-intercept');
      for (const e of a.extrema) push(e.t, e.v, e.kind);
      if (x0 <= 0 && 0 <= x1) push(0, f(0), 'y-intercept');
    } else if (curve.kind === 'x') {
      const g = curve.f;
      const a = analyze(g, y0, y1, x1 - x0);
      for (const t of a.zeros) push(0, t, 'y-intercept');
      for (const e of a.extrema) push(e.v, e.t, e.kind === 'maximum' ? 'rightmost' : 'leftmost');
      if (y0 <= 0 && 0 <= y1) push(g(0), 0, 'x-intercept');
    } else {
      const F = curve.f;
      for (const t of analyze((x) => F(x, 0), x0, x1, y1 - y0).zeros) push(t, 0, 'x-intercept');
      for (const t of analyze((y) => F(0, y), y0, y1, x1 - x0).zeros) push(0, t, 'y-intercept');
    }
    points = found.slice(0, MAX_POINTS).map(({ x, y, kind }) => ({ x, y, kind }));
    if (hover && hover.kind !== 'trace') hover = points.find((p) => p.x === hover.x && p.y === hover.y) || null;
  }

  // One-dimensional analysis of f over [a, b]: zeros and extrema.
  function analyze(f, a, b, range) {
    const zeros = [], extrema = [];
    const h = (b - a) / SAMPLES;
    const t = new Float64Array(SAMPLES + 1), v = new Float64Array(SAMPLES + 1);
    for (let i = 0; i <= SAMPLES; i++) { t[i] = a + i * h; v[i] = f(t[i]); }
    const big = Math.max(1, Math.abs(range)) * 1e6;

    for (let i = 0; i < SAMPLES; i++) {
      const v0 = v[i], v1 = v[i + 1];
      if (!Number.isFinite(v0) || !Number.isFinite(v1)) continue;
      if (v0 === 0) { zeros.push(t[i]); continue; }
      if ((v0 < 0) !== (v1 < 0)) {
        const root = bisect(f, t[i], t[i + 1]);
        // A sign flip across an asymptote (1/x, tan) bisects to a huge value; a
        // real crossing bisects to ~0.
        if (Math.abs(f(root)) < 1e-7 * Math.max(1, Math.abs(v0), Math.abs(v1))) zeros.push(root);
      }
    }
    for (let i = 1; i < SAMPLES; i++) {
      const p = v[i - 1], c = v[i], n = v[i + 1];
      if (![p, c, n].every(Number.isFinite) || Math.abs(c) > big) continue;
      const d1 = c - p, d2 = n - c;
      if (d1 * d2 < 0) {
        const isMax = d1 > 0;
        const tt = golden(f, t[i - 1], t[i + 1], isMax);
        const vv = f(tt);
        if (!Number.isFinite(vv)) continue;
        // A tangential zero (x² at 0) shows up as a minimum of |f| that actually reaches 0.
        if (Math.abs(vv) < 1e-9 * Math.max(1, Math.abs(range))) { zeros.push(tt); continue; }
        extrema.push({ t: tt, v: vv, kind: isMax ? 'maximum' : 'minimum' });
      } else if (c !== 0 && Math.abs(c) <= Math.abs(p) && Math.abs(c) <= Math.abs(n) && (p < 0) === (n < 0)) {
        // |f| dips toward zero without crossing: check whether it touches.
        const tt = golden((s) => Math.abs(f(s)), t[i - 1], t[i + 1], false);
        if (Math.abs(f(tt)) < 1e-9 * Math.max(1, Math.abs(range))) zeros.push(tt);
      }
    }
    return { zeros, extrema };
  }

  function bisect(f, lo, hi) {
    let flo = f(lo);
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2, fm = f(mid);
      if (fm === 0) return mid;
      if ((fm < 0) === (flo < 0)) { lo = mid; flo = fm; } else hi = mid;
    }
    return (lo + hi) / 2;
  }

  function golden(f, lo, hi, findMax) {
    const g = (Math.sqrt(5) - 1) / 2;
    let c = hi - g * (hi - lo), d = lo + g * (hi - lo);
    let fc = f(c), fd = f(d);
    for (let i = 0; i < 60; i++) {
      const pickLeft = findMax ? fc > fd : fc < fd;
      if (pickLeft) { hi = d; d = c; fd = fc; c = hi - g * (hi - lo); fc = f(c); }
      else          { lo = c; c = d; fc = fd; d = lo + g * (hi - lo); fd = f(d); }
    }
    return (lo + hi) / 2;
  }

  // ------------------------------------------------------- interaction

  let dragging = null;

  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = { px: e.clientX, py: e.clientY, cx: view.cx, cy: view.cy };
    wrap.classList.add('is-dragging');
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    view.cx = dragging.cx - (e.clientX - dragging.px) / view.scale;
    view.cy = dragging.cy + (e.clientY - dragging.py) / view.scale;
    schedule();
  });
  window.addEventListener('mouseup', () => { dragging = null; wrap.classList.remove('is-dragging'); });

  // Zoom about the cursor, so the point under the mouse stays put. Stops
  // propagation so app.js's Ctrl+wheel font-size handler doesn't also fire.
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const [mx, my] = fromPx(px, py);
    const factor = Math.pow(1.0015, -e.deltaY);
    view.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
    const [nx, ny] = fromPx(px, py);
    view.cx += mx - nx;
    view.cy += my - ny;
    schedule();
  }, { passive: false });

  canvas.addEventListener('dblclick', () => resetView());

  canvas.addEventListener('mousemove', (e) => {
    if (dragging || !curve) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    let best = null, bestD = HOVER_RADIUS;
    for (const p of points) {
      const [qx, qy] = toPx(p.x, p.y);
      const d = Math.hypot(qx - px, qy - py);
      if (d < bestD) { best = p; bestD = d; }
    }
    if (!best) {
      // Trace along the curve itself.
      if (curve.kind === 'y') {
        const x = fromPx(px, 0)[0], y = curve.f(x);
        if (Number.isFinite(y) && Math.abs(toPx(0, y)[1] - py) < TRACE_RADIUS) best = { x, y, kind: 'trace' };
      } else if (curve.kind === 'x') {
        const y = fromPx(0, py)[1], x = curve.f(y);
        if (Number.isFinite(x) && Math.abs(toPx(x, 0)[0] - px) < TRACE_RADIUS) best = { x, y, kind: 'trace' };
      }
    }
    setHover(best, px, py);
  });
  canvas.addEventListener('mouseleave', () => setHover(null));

  function setHover(p, px, py) {
    const changed = (p === null) !== (hover === null) || (p && hover && (p.x !== hover.x || p.y !== hover.y));
    hover = p;
    if (!p) { tip.hidden = true; if (changed) schedule(); return; }
    tip.hidden = false;
    tip.textContent = (p.kind === 'trace' ? '' : p.kind + '  ') + `(${fmt(p.x)}, ${fmt(p.y)})`;
    const flipX = px > width - 150;
    tip.style.left = (flipX ? px - 12 : px + 12) + 'px';
    tip.style.top = (py - 10) + 'px';
    tip.style.transform = flipX ? 'translateX(-100%)' : '';
    if (changed || p.kind === 'trace') schedule();
  }

  function resetView() {
    view.cx = 0; view.cy = 0; view.scale = DEFAULT_SCALE;
    schedule();
  }

  document.getElementById('graph-reset').addEventListener('click', resetView);

  // ------------------------------------------------------- public API

  function setLatex(latex) {
    pendingLatex = latex;
    clearTimeout(latexTimer);
    // Recompile a beat after the last keystroke, not on every one.
    latexTimer = setTimeout(applyLatex, 60);
  }

  function applyLatex() {
    const latex = pendingLatex;
    if (!latex || !latex.trim()) {
      curve = null; errorText = ''; points = []; hover = null;
    } else {
      try {
        curve = window.LatexMath.compileEquation(latex);
        errorText = '';
      } catch (err) {
        curve = null; points = []; hover = null;
        errorText = err.message;
      }
    }
    statusEl.textContent = errorText || (curve ? describe(curve) : 'Type an expression to graph it');
    statusEl.classList.toggle('is-error', !!errorText);
    tip.hidden = true;
    schedule();
  }

  function describe(c) {
    if (c.kind === 'y') return 'y = f(x)';
    if (c.kind === 'x') return 'x = g(y)';
    return 'implicit curve';
  }

  window.Grapher = {
    setLatex,
    redraw: schedule,
    resetView,
    refresh() { resize(); }
  };
})();
