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
//   'y'         y = f(x): sampled four times per pixel column, the path
//               broken wherever a sample is non-finite or jumps further than
//               the whole view (an asymptote, e.g. tan). Where the function
//               stops being defined — the feet of √(sin x)'s arches — the
//               exact edge is found by bisection and the path drawn to it,
//               so arches touch the axis instead of stopping a sample short.
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
// each axis, and their other features from the marching-squares output
// itself: the segments are chained into polylines, whose local extremes in
// x and y are candidates for leftmost/rightmost/highest/lowest points, and
// whose loose ends (plus "saddle" cells where two segments cross a cell)
// are candidates for self-intersections. Each candidate is then polished
// with a 2-D Newton iteration — on {F = 0, ∂F/∂x = 0} for a horizontal
// tangent, {F = 0, ∂F/∂y = 0} for a vertical one, {∂F/∂x = 0, ∂F/∂y = 0}
// for a crossing — and kept only if it converges nearby and actually lies
// on the curve, which is what separates a true crossing from two branches
// merely passing close together.

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
  const MAX_POINTS = 400;
  const OVERSAMPLE = 4;          // samples per pixel when tracing explicit curves

  const view = { cx: 0, cy: 0, scale: DEFAULT_SCALE };
  let curve = null;       // { kind, f, label } or null
  let errorText = '';
  let points = [];        // [{ x, y, kind }]
  let hover = null;       // { x, y, kind } | null
  let implicit = null;    // { segs, saddles } from the last marching-squares pass
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
    if (wrap.hidden || width === 0) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = css('--bg-sink');
    ctx.fillRect(0, 0, width, height);
    drawGrid();
    if (curve) {
      implicit = curve.kind === 'implicit' ? marchingSquares() : null;
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
    else for (const s of implicit.segs) { ctx.moveTo(s[0], s[1]); ctx.lineTo(s[2], s[3]); }
    ctx.stroke();
  }

  // Walks along the sampled axis a fraction of a pixel at a time, breaking
  // the path at non-finite values and at jumps bigger than the whole canvas
  // (asymptotes). Each time the function crosses between defined and
  // undefined, the boundary is located by bisection and the path is drawn
  // right up to it, so a curve that ends at its domain edge (a √ hitting
  // zero) visibly reaches that point rather than stopping a sample short.
  function tracePath(sampleAt, length) {
    const limit = Math.max(width, height) * 4;
    const finite = (p) => Number.isFinite(p[0]) && Number.isFinite(p[1]);
    const edge = (goodT, badT) => {
      for (let i = 0; i < 30; i++) {
        const mid = (goodT + badT) / 2;
        if (finite(sampleAt(mid))) goodT = mid; else badT = mid;
      }
      return sampleAt(goodT);
    };
    let pen = false, prev = null, prevT = null, prevOk = false;
    const plot = (p) => {
      const cx = Math.max(-1e5, Math.min(1e5, p[0])), cy = Math.max(-1e5, Math.min(1e5, p[1]));
      if (pen && prev && (Math.abs(cx - prev[0]) > limit || Math.abs(cy - prev[1]) > limit)) pen = false;
      if (pen) ctx.lineTo(cx, cy); else ctx.moveTo(cx, cy);
      pen = true;
      prev = [cx, cy];
    };
    const step = 1 / OVERSAMPLE;
    for (let t = 0; t <= length; t += step) {
      const p = sampleAt(t);
      const ok = finite(p);
      if (ok && !prevOk && prevT !== null) { pen = false; plot(edge(t, prevT)); }
      if (!ok && prevOk) { plot(edge(prevT, t)); pen = false; prev = null; }
      if (ok) plot(p);
      prevOk = ok;
      prevT = t;
    }
  }

  // Returns the curve as pixel-space segments [x0, y0, x1, y1], plus the
  // centres of "saddle" cells (all four corner signs alternating), which
  // are where two branches cross a single cell.
  function marchingSquares() {
    const segs = [], saddles = [];
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
        const seg = (a, b) => segs.push([a[0], a[1], b[0], b[1]]);
        if (idx === 5 || idx === 10) saddles.push([(x0 + x1) / 2, (y0 + y1) / 2]);
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
    return { segs, saddles };
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
    if (trace) {
      const [px, py] = toPx(trace.x, trace.y);
      ctx.beginPath();
      ctx.arc(px, py, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = fg;
      ctx.stroke();
    }
  }

  // ------------------------------------------------------ point finding

  function findPoints() {
    const { x0, x1, y0, y1 } = visibleRange();
    const found = [];
    // Numerical refinement lands within ~1e-8 of a flat minimum's true x
    // (the limit of resolving f differences in double precision), so a
    // coordinate that is smaller than a thousandth of a pixel at the current
    // zoom is snapped to 0 rather than shown as 1.05e-8.
    const tol = Math.max(x1 - x0, y1 - y0) / Math.max(width, height) * 1e-3;   // a thousandth of a pixel
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
      // Crossings first so an extremum candidate that converges onto a
      // crossing (where the tangent conditions hold too) is deduped away.
      for (const p of implicitFeatures()) push(p.x, p.y, p.kind);
      for (const t of analyze((x) => F(x, 0), x0, x1, y1 - y0).zeros) push(t, 0, 'x-intercept');
      for (const t of analyze((y) => F(0, y), y0, y1, x1 - x0).zeros) push(0, t, 'y-intercept');
    }
    points = found.slice(0, MAX_POINTS).map(({ x, y, kind }) => ({ x, y, kind }));
    if (hover) hover = points.find((p) => p.x === hover.x && p.y === hover.y) || null;
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
      // A domain edge (defined on one side, not the other) is a zero when
      // the function reaches 0 there, as at each foot of √(sin x)'s arches.
      if (Number.isFinite(v0) !== Number.isFinite(v1)) {
        let good = Number.isFinite(v0) ? t[i] : t[i + 1], bad = Number.isFinite(v0) ? t[i + 1] : t[i];
        for (let k = 0; k < 60; k++) { const mid = (good + bad) / 2; if (Number.isFinite(f(mid))) good = mid; else bad = mid; }
        if (Math.abs(f(good)) < 1e-6 * Math.max(1, Math.abs(range))) zeros.push(good);
        continue;
      }
      if (!Number.isFinite(v0) || !Number.isFinite(v1)) continue;
      // An exact zero counts only if isolated: a curve that runs along the
      // axis (F identically 0 there) would otherwise mark every sample.
      if (v0 === 0) { if (v1 !== 0 && (i === 0 || v[i - 1] !== 0)) zeros.push(t[i]); continue; }
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

  // ------------------------------------------ implicit-curve features

  // Chains marching-squares segments into polylines by matching endpoints.
  // Adjacent cells interpolate a shared edge from the same two node values,
  // so their endpoints coincide exactly; the key rounds to 1/4 px anyway.
  function chainSegments(segs) {
    const key = (x, y) => Math.round(x * 4) + ',' + Math.round(y * 4);
    const ends = new Map();
    segs.forEach((s, i) => {
      for (const k of [key(s[0], s[1]), key(s[2], s[3])]) {
        if (!ends.has(k)) ends.set(k, []);
        ends.get(k).push(i);
      }
    });
    const used = new Uint8Array(segs.length);
    const walk = (px, py) => {
      const pts = [];
      for (;;) {
        pts.push([px, py]);
        const next = (ends.get(key(px, py)) || []).find((j) => !used[j]);
        if (next === undefined) return pts;
        used[next] = 1;
        const s = segs[next];
        if (key(s[0], s[1]) === key(px, py)) { px = s[2]; py = s[3]; } else { px = s[0]; py = s[1]; }
      }
    };
    const chains = [];
    for (let i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      used[i] = 1;
      const forward = walk(segs[i][2], segs[i][3]);
      const backward = walk(segs[i][0], segs[i][1]);
      chains.push(backward.reverse().concat(forward));
    }
    return chains;
  }

  function implicitFeatures() {
    const F = curve.f;
    const out = [];
    if (!implicit || implicit.segs.length === 0) return out;
    const unit = 1 / view.scale;          // math units per pixel
    const cell = CELL * unit;
    const near = 3 * cell;                // how far a refinement may wander
    const h = cell * 0.01;                // differentiation step (small: its O(h²) error shifts where Newton lands)
    const Fx = (x, y) => (F(x + h, y) - F(x - h, y)) / (2 * h);
    const Fy = (x, y) => (F(x, y + h) - F(x, y - h)) / (2 * h);
    // |F| a couple of cells away, as the yardstick for "F is zero here".
    const scaleAt = (x, y) => Math.max(Math.abs(F(x + 2 * cell, y)), Math.abs(F(x - 2 * cell, y)),
                                       Math.abs(F(x, y + 2 * cell)), Math.abs(F(x, y - 2 * cell)), 1e-300);
    const onCurve = (p) => Number.isFinite(F(p[0], p[1])) && Math.abs(F(p[0], p[1])) < 1e-5 * scaleAt(p[0], p[1]);
    const closeTo = (p, x, y) => Math.hypot(p[0] - x, p[1] - y) < near;

    const chains = chainSegments(implicit.segs).map((c) => c.map(([px, py]) => fromPx(px, py)));

    // Self-intersections: from saddle cells and from chain ends that stop
    // in the interior (a crossing splits the marching-squares output into
    // chains that end near it).
    const edge = 2 * CELL;
    const interior = (px, py) => px > edge && px < width - edge && py > edge && py < height - edge;
    const crossingSeeds = implicit.saddles.map(([px, py]) => fromPx(px, py));
    for (const c of chainSegments(implicit.segs)) {
      const a = c[0], b = c[c.length - 1];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1) continue;       // closed loop
      if (interior(a[0], a[1])) crossingSeeds.push(fromPx(a[0], a[1]));
      if (interior(b[0], b[1])) crossingSeeds.push(fromPx(b[0], b[1]));
    }
    const crossings = [];
    const tryCrossing = (sx, sy) => {
      const p = newton2((x, y) => [Fx(x, y), Fy(x, y)], sx, sy, cell);
      if (!p || !closeTo(p, sx, sy) || !onCurve(p)) return false;
      crossings.push({ x: p[0], y: p[1], kind: 'self-intersection' });
      return true;
    };
    for (const [sx, sy] of crossingSeeds) tryCrossing(sx, sy);

    // Extremes of each chain in y (horizontal tangent) and x (vertical).
    const W = 3;
    for (const c of chains) {
      const n = c.length;
      if (n < 2 * W + 1) continue;
      const closed = Math.hypot(c[0][0] - c[n - 1][0], c[0][1] - c[n - 1][1]) < cell * 0.5;
      const m = closed ? n - 1 : n;
      const at = (i) => closed ? c[((i % m) + m) % m] : c[i];
      for (let i = 0; i < m; i++) {
        if (!closed && (i < W || i >= n - W)) continue;
        const p = at(i);
        let maxY = true, minY = true, maxX = true, minX = true;
        for (let d = 1; d <= W; d++) {
          const a = at(i - d), b = at(i + d);
          if (!(p[1] >= a[1] && p[1] >= b[1])) maxY = false;
          if (!(p[1] <= a[1] && p[1] <= b[1])) minY = false;
          if (!(p[0] >= a[0] && p[0] >= b[0])) maxX = false;
          if (!(p[0] <= a[0] && p[0] <= b[0])) minX = false;
        }
        const strictY = at(i - W)[1] !== p[1] || at(i + W)[1] !== p[1];
        const strictX = at(i - W)[0] !== p[0] || at(i + W)[0] !== p[0];
        const isTip = ((maxY || minY) && strictY) || ((maxX || minX) && strictX);
        // Two lobes meeting at a crossing (a lemniscate's waist) come out of
        // marching squares as two closed loops whose tips sit on the crossing,
        // with no loose end or saddle cell to seed from — and the tangent
        // conditions hold at a crossing too, so a tip would otherwise be
        // reported as an extremum. Try the crossing search from every tip first.
        if (isTip && tryCrossing(p[0], p[1])) continue;
        if ((maxY || minY) && strictY) {
          const q = newton2((x, y) => [F(x, y), Fx(x, y)], p[0], p[1], cell);
          if (q && closeTo(q, p[0], p[1]) && onCurve(q)) out.push({ x: q[0], y: q[1], kind: maxY ? 'maximum' : 'minimum' });
        }
        if ((maxX || minX) && strictX) {
          const q = newton2((x, y) => [F(x, y), Fy(x, y)], p[0], p[1], cell);
          if (q && closeTo(q, p[0], p[1]) && onCurve(q)) out.push({ x: q[0], y: q[1], kind: maxX ? 'rightmost' : 'leftmost' });
        }
      }
    }
    // Crossings first: a tip that converged onto one is deduped away by push().
    return crossings.concat(out);
  }

  // Newton's method on a 2-D system G(x, y) = [0, 0] with a numerical
  // Jacobian. Returns the converged point or null.
  function newton2(G, x, y, step) {
    const h = step * 0.1;
    for (let it = 0; it < 30; it++) {
      const [g1, g2] = G(x, y);
      const [a1, a2] = G(x + h, y), [b1, b2] = G(x - h, y);
      const [c1, c2] = G(x, y + h), [d1, d2] = G(x, y - h);
      const j11 = (a1 - b1) / (2 * h), j12 = (c1 - d1) / (2 * h);
      const j21 = (a2 - b2) / (2 * h), j22 = (c2 - d2) / (2 * h);
      const det = j11 * j22 - j12 * j21;
      if (!Number.isFinite(det) || det === 0) return null;
      const dx = (g1 * j22 - g2 * j12) / det, dy = (j11 * g2 - j21 * g1) / det;
      x -= dx; y -= dy;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      if (Math.hypot(dx, dy) < step * 1e-8) return [x, y];
    }
    return [x, y];
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
  //
  // Hovering only reveals points of interest. The curve itself is read by
  // clicking on it, Desmos-style: a click within TRACE_RADIUS of the curve
  // places a trace point there and shows its coordinates; holding the
  // button and dragging slides the point along the curve; the point stays
  // until the next click elsewhere or a new expression. A press anywhere
  // else starts a pan.

  let dragging = null;   // { px, py, cx, cy } while panning
  let tracing = false;   // button held after a click on the curve
  let trace = null;      // { x, y } the placed trace point, if any

  const localPos = (e) => {
    const rect = canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  function poiNear(px, py) {
    let best = null, bestD = HOVER_RADIUS;
    for (const p of points) {
      const [qx, qy] = toPx(p.x, p.y);
      const d = Math.hypot(qx - px, qy - py);
      if (d < bestD) { best = p; bestD = d; }
    }
    return best;
  }

  // The point on the curve for a mouse position: for y = f(x) the point at
  // that x, for x = g(y) the point at that y, for an implicit curve the
  // nearest point on any marching-squares segment. With a radius, null is
  // returned when the curve is further away than that (used to decide
  // whether a press is a click on the curve); without one, the nearest
  // point is always returned (used while dragging the trace point).
  function curvePointFor(px, py, radius) {
    if (!curve) return null;
    if (curve.kind === 'y') {
      const x = fromPx(px, 0)[0], y = curve.f(x);
      if (!Number.isFinite(y)) return null;
      if (radius !== undefined && Math.abs(toPx(0, y)[1] - py) > radius) return null;
      return { x, y };
    }
    if (curve.kind === 'x') {
      const y = fromPx(0, py)[1], x = curve.f(y);
      if (!Number.isFinite(x)) return null;
      if (radius !== undefined && Math.abs(toPx(x, 0)[0] - px) > radius) return null;
      return { x, y };
    }
    if (!implicit) return null;
    let best = null, bestD = radius === undefined ? Infinity : radius;
    for (const [ax, ay, bx, by] of implicit.segs) {
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      const qx = ax + t * dx, qy = ay + t * dy;
      const d = Math.hypot(qx - px, qy - py);
      if (d < bestD) { bestD = d; best = [qx, qy]; }
    }
    if (!best) return null;
    const [x, y] = fromPx(best[0], best[1]);
    return { x, y };
  }

  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const [px, py] = localPos(e);
    if (poiNear(px, py)) return;                       // a point of interest: hover already shows it
    const cp = curvePointFor(px, py, TRACE_RADIUS);
    if (cp) {
      tracing = true;
      trace = cp;
      updateTip();
      schedule();
      return;
    }
    if (trace) { trace = null; updateTip(); schedule(); }
    dragging = { px: e.clientX, py: e.clientY, cx: view.cx, cy: view.cy };
    wrap.classList.add('is-dragging');
  });

  window.addEventListener('mousemove', (e) => {
    if (tracing) {
      const [px, py] = localPos(e);
      const cp = curvePointFor(px, py);
      if (cp) { trace = cp; updateTip(); schedule(); }
      return;
    }
    if (!dragging) return;
    view.cx = dragging.cx - (e.clientX - dragging.px) / view.scale;
    view.cy = dragging.cy + (e.clientY - dragging.py) / view.scale;
    schedule();
  });

  window.addEventListener('mouseup', () => {
    tracing = false;
    dragging = null;
    wrap.classList.remove('is-dragging');
  });

  // Zoom about the cursor, so the point under the mouse stays put. Stops
  // propagation so app.js's Ctrl+wheel font-size handler doesn't also fire.
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const [px, py] = localPos(e);
    const [mx, my] = fromPx(px, py);
    const factor = Math.pow(1.0015, -e.deltaY);
    view.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
    const [nx, ny] = fromPx(px, py);
    view.cx += mx - nx;
    view.cy += my - ny;
    updateTip();
    schedule();
  }, { passive: false });

  canvas.addEventListener('dblclick', () => resetView());

  canvas.addEventListener('mousemove', (e) => {
    if (dragging || tracing || !curve) return;
    const [px, py] = localPos(e);
    const p = poiNear(px, py);
    if (p !== hover) { hover = p; updateTip(); schedule(); }
  });
  canvas.addEventListener('mouseleave', () => {
    if (hover) { hover = null; updateTip(); schedule(); }
  });

  // The tooltip shows the hovered point of interest if there is one, else
  // the trace point, anchored beside the point itself rather than the mouse.
  function updateTip() {
    const p = hover || trace;
    if (!p) { tip.hidden = true; return; }
    const [px, py] = toPx(p.x, p.y);
    tip.hidden = false;
    tip.textContent = (p.kind ? p.kind + '  ' : '') + `(${fmt(p.x)}, ${fmt(p.y)})`;
    const flipX = px > width - 150;
    tip.style.left = (flipX ? px - 12 : px + 12) + 'px';
    tip.style.top = (py - 10) + 'px';
    tip.style.transform = flipX ? 'translateX(-100%)' : '';
  }


  function resetView() {
    view.cx = 0; view.cy = 0; view.scale = DEFAULT_SCALE;
    updateTip();
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
      curve = null; errorText = ''; points = []; hover = null; trace = null;
    } else {
      try {
        curve = window.LatexMath.compileEquation(latex);
        errorText = '';
        trace = null;
      } catch (err) {
        curve = null; points = []; hover = null; trace = null;
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
