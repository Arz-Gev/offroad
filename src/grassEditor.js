import { QUALITY } from './render/quality.js';
import { evalCurve } from './world/grass.js';
import './grassEditor.css';

// The grass editor: Custom grass and bushes, a panel over the running game (opened from Graphics → Grass and
// bushes), dragged by its title. Everything goes through the settings, so the game follows live and keeps it.
// The grass is three curves over the distance (density, height, width; gGrassCurve, see world/grass.js):
// drag the points (Ctrl / Cmd + drag moves the whole curve up or down), double-click to add or remove one
// (right-click removes too), drag the dashed line to move where the grass ends. The preset row is the
// Grass and bushes preset itself; editing a level copies it into Custom first.

const LEVELS = [['off', 'Off'], ['low', 'Low'], ['medium', 'Med'], ['high', 'High'], ['ultra', 'Ultra'], ['custom', 'Custom']];
const XMAX = 300, XT = [0, 10, 25, 50, 100, 200, 300], XT_LIN = [0, 50, 100, 150, 200, 250, 300];
const rnd = v => (v >= 10 ? Math.round(v) : v >= 1 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100);
const GRAPHS = [
  // log: a log axis in the Log view; linMax / linTicks: the axis in the Lin view
  { key: 'density', label: 'Density', unit: '/m²', min: 0.3, max: 300, log: true, ticks: [1, 10, 100], minor: [3, 30, 300], linMax: 150, linTicks: [0, 50, 100, 150] },
  { key: 'height', label: 'Height', unit: ' cm', min: 5, max: 400, log: true, ticks: [10, 30, 100, 300], linMax: 400, linTicks: [0, 100, 200, 300, 400] },
  { key: 'width', label: 'Width', unit: ' cm', min: 1, max: 200, log: true, ticks: [1, 3, 10, 30, 100], linMax: 200, linTicks: [0, 50, 100, 150, 200] },
];
// bushes: [setting, label, min, max, log scale] (the ranges of settings.js RANGES)
const BUSH = [['gBushes', 'Density', 0.05, 3, true], ['gBushHeight', 'Size', 1.1, 3.5, false], ['gBushDist', 'Distance', 1, 4.8, false]];
const STEPS = 1000;
const toPos = (f, v) => Math.round(STEPS * (f[4] ? Math.log(v / f[2]) / Math.log(f[3] / f[2]) : (v - f[2]) / (f[3] - f[2])));
const fromPos = (f, p) => rnd(f[4] ? f[2] * (f[3] / f[2]) ** (p / STEPS) : f[2] + (f[3] - f[2]) * p / STEPS);
const clone = o => JSON.parse(JSON.stringify(o));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// api: { settings, grass, renderer }
export function createGrassEditor(api) {
  const { settings } = api;
  const silent = { silent: true };
  // the curves on screen: the level's, or the player's own (also shown while the grass is off)
  const curve = () => QUALITY[settings.get('gVeg')]?.grassCurve || settings.get('gGrassCurve');
  // change the curves: a copy of what is shown, so editing a level starts Custom from it (main.js switches the preset)
  const edit = fn => { const c = clone(curve()); fn(c); settings.set('gGrassCurve', c, silent); return c; };

  const el = document.createElement('div');
  el.className = 'gedit';
  el.hidden = true;
  el.innerHTML = `
    <div class="ge-head"><b>Grass and bushes</b><span class="ge-stats"></span><button type="button" class="ge-x" data-act="close" title="Close" aria-label="Close"></button></div>
    <div class="ge-body">
      <div class="ge-bar">
        <div class="ge-seg ge-levels">${LEVELS.map(([v, l]) => `<button type="button" data-level="${v}">${l}</button>`).join('')}</div>
      </div>
      <div class="ge-bar">
        <div class="ge-seg"><button type="button" data-scale="lin">Lin</button><button type="button" data-scale="log">Log</button></div>
        <label class="ge-check"><input type="checkbox" data-act="smooth"> Smooth</label>
        <span class="ge-help" title="Drag the points. Ctrl / Cmd + drag: move the whole curve up or down. Double-click: add or remove a point (right-click removes too). Drag the dashed line: where the grass ends. Editing a preset turns it into Custom.">?</span>
      </div>
      ${GRAPHS.map(g => `<canvas class="ge-graph" data-g="${g.key}"></canvas>`).join('')}
      <div class="ge-bush">
        <b>Bushes</b>
        ${BUSH.map(f => `
        <div class="ge-row" data-f="${f[0]}"><span>${f[1]}</span><input type="range" min="0" max="${STEPS}" step="1" aria-label="Bush ${f[1].toLowerCase()}"><output></output></div>`).join('')}
      </div>
    </div>`;
  document.body.appendChild(el);

  // ------------------------------------------------------------------ graphs
  const PAD = { l: 34, r: 8, t: 16, b: 16 };
  // Log view: √distance across (room for the near metres), log values up; Lin view: both plain
  const lay = cv => {
    const W = cv.clientWidth, H = cv.clientHeight, w = W - PAD.l - PAD.r, h = H - PAD.t - PAD.b, lin = !!curve().lin;
    return { W, H, w, h, lin,
      X: d => PAD.l + (lin ? clamp(d, 0, XMAX) / XMAX : Math.sqrt(clamp(d, 0, XMAX) / XMAX)) * w,
      D: px => { const f = clamp((px - PAD.l) / w, 0, 1); return XMAX * (lin ? f : f * f); } };
  };
  const yMap = (G, L) => {
    const log = G.log && !L.lin, min = log ? G.min : 0, max = G.log && L.lin ? G.linMax : G.max;
    return { log, ticks: G.log && L.lin ? G.linTicks : G.ticks,
      Y: v => PAD.t + L.h * (1 - (log ? Math.log(Math.max(v, min) / min) / Math.log(max / min) : (v - min) / (max - min))),
      V: py => { const f = clamp(1 - (py - PAD.t) / L.h, 0, 1); return log ? min * (max / min) ** f : min + (max - min) * f; } };
  };
  const fmtV = (G, v) => `${rnd(v)}${G.unit}`;
  const hover = {};   // per graph: { i } hovered point, or { d } cursor distance, or { end: true }
  let drag = null;

  function draw(G) {
    const cv = el.querySelector(`[data-g="${G.key}"]`), dpr = window.devicePixelRatio || 1, L = lay(cv), ym = yMap(G, L), { Y } = ym;
    if (!L.W) return;
    if (cv.width !== Math.round(L.W * dpr)) { cv.width = Math.round(L.W * dpr); cv.height = Math.round(L.H * dpr); }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, L.W, L.H);
    const c = curve(), pts = c[G.key], end = c.end;
    ctx.font = '10px ui-monospace, Menlo, monospace';
    // grid and axes
    ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.fillStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = 1;
    ctx.textAlign = 'center';
    for (const d of L.lin ? XT_LIN : XT) { const x = Math.round(L.X(d)) + 0.5; ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, PAD.t + L.h); ctx.stroke(); ctx.fillText(d, x, L.H - 4); }
    ctx.textAlign = 'right';
    for (const t of ym.ticks) { const y = Math.round(Y(t)) + 0.5; ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(PAD.l + L.w, y); ctx.stroke(); ctx.fillText(t, PAD.l - 4, y + 3); }
    ctx.strokeStyle = 'rgba(255,255,255,0.035)';
    for (const t of ym.log ? G.minor || [] : []) { const y = Math.round(Y(t)) + 0.5; ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(PAD.l + L.w, y); ctx.stroke(); }
    ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.font = '600 11px system-ui, sans-serif';
    ctx.fillText(`${G.label}, ${G.unit.trim()}`, PAD.l, 11);
    // no grass past the end
    const xe = L.X(end);
    ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.fillRect(xe, PAD.t, PAD.l + L.w - xe, L.h);
    ctx.strokeStyle = '#ffb347'; ctx.lineWidth = 2; ctx.beginPath();
    for (let x = PAD.l; x <= PAD.l + L.w; x += 2) { const y = Y(evalCurve(pts, L.D(x), c.smooth, G.log, !!c.lin)); x === PAD.l ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
    ctx.stroke();
    // the end of the grass
    ctx.strokeStyle = hover[G.key]?.end || drag?.end ? '#fff' : 'rgba(255,179,71,0.8)'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(xe, PAD.t); ctx.lineTo(xe, PAD.t + L.h); ctx.stroke(); ctx.setLineDash([]);
    // points
    pts.forEach(([d, y], i) => {
      const on = (hover[G.key]?.i === i) || (drag?.g === G && drag.i === i);
      ctx.beginPath(); ctx.arc(L.X(d), Y(y), on ? 5.5 : 4, 0, Math.PI * 2);
      ctx.fillStyle = on ? '#fff' : '#ffb347'; ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1; ctx.stroke();
    });
    // readout: the point under the mouse, the end line, or the curve at the cursor
    const hv = drag?.g === G ? drag : hover[G.key];
    let txt = '';
    if (hv?.end) txt = `grass ends at ${Math.round(end)} m`;
    else if (hv?.i != null && pts[hv.i]) txt = `${rnd(pts[hv.i][0])} m · ${fmtV(G, pts[hv.i][1])}`;
    else if (hv?.d != null) txt = `at ${rnd(hv.d)} m: ${fmtV(G, evalCurve(pts, hv.d, c.smooth, G.log, !!c.lin))}`;
    if (txt) { ctx.textAlign = 'right'; ctx.fillStyle = '#fff'; ctx.font = '11px ui-monospace, Menlo, monospace'; ctx.fillText(txt, PAD.l + L.w, 11); }
  }
  const drawAll = () => GRAPHS.forEach(draw);

  const local = (cv, e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const hit = (G, cv, p) => {
    const L = lay(cv), { Y } = yMap(G, L), c = curve();
    let best = -1, bd = 9;
    c[G.key].forEach(([d, y], i) => { const dd = Math.hypot(L.X(d) - p.x, Y(y) - p.y); if (dd < bd) { bd = dd; best = i; } });
    if (best >= 0) return { i: best };
    if (Math.abs(L.X(c.end) - p.x) < 6 && p.y > PAD.t && p.y < PAD.t + L.h) return { end: true };
    if (p.x >= PAD.l && p.x <= PAD.l + L.w) return { d: L.D(p.x) };
    return null;
  };

  for (const G of GRAPHS) {
    const cv = el.querySelector(`[data-g="${G.key}"]`);
    cv.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      const p = local(cv, e), h = hit(G, cv, p);
      if (!h) return;
      // Ctrl / Cmd: move the whole curve up or down, keeping its shape as drawn
      if (e.ctrlKey || e.metaKey) drag = { g: G, shift: true, y0: p.y, base: curve()[G.key].map(q => [...q]) };
      else if (h.d != null) return;
      else drag = { g: G, ...h };
      cv.setPointerCapture(e.pointerId);
      drawAll();
    });
    cv.addEventListener('pointermove', e => {
      const p = local(cv, e);
      if (!drag || drag.g !== G) {
        hover[G.key] = hit(G, cv, p);
        cv.style.cursor = (e.ctrlKey || e.metaKey) && hover[G.key] ? 'ns-resize' : hover[G.key]?.end ? 'ew-resize' : hover[G.key]?.i != null ? 'grab' : 'crosshair';
        draw(G);
        return;
      }
      const L = lay(cv), { V, Y } = yMap(G, L);
      edit(c => {
        if (drag.shift) {
          // the same offset on screen for every point, stopped where the first point hits the top or bottom
          let dy = p.y - drag.y0;
          for (const [, v] of drag.base) dy = clamp(dy, PAD.t - Y(v), PAD.t + L.h - Y(v));
          c[G.key] = drag.base.map(([d, v]) => [d, rnd(V(Y(v) + dy))]);
        } else if (drag.end) c.end = clamp(Math.round(L.D(p.x)), 10, XMAX);
        else {
          const pts = c[G.key], i = drag.i;
          const lo = i === 0 ? 0 : pts[i - 1][0] + 0.5, hi = i === pts.length - 1 ? XMAX : pts[i + 1][0] - 0.5;
          pts[i] = [i === 0 ? 0 : clamp(rnd(L.D(p.x)), lo, hi), rnd(V(p.y))];
        }
      });
    });
    const up = () => { if (drag?.g === G) { drag = null; drawAll(); } };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', () => { if (!drag) { hover[G.key] = null; draw(G); } });
    // the first point (at the camera) stays
    const remove = i => { if (i > 0 && curve()[G.key].length > 1) edit(c => c[G.key].splice(i, 1)); };
    cv.addEventListener('dblclick', e => {
      const p = local(cv, e), h = hit(G, cv, p);
      if (!h || h.end) return;
      if (h.i != null) return remove(h.i);
      const L = lay(cv), { V } = yMap(G, L), d = rnd(L.D(p.x));
      if (curve()[G.key].some(q => Math.abs(q[0] - d) < 0.5)) return;
      edit(c => { c[G.key].push([d, rnd(V(p.y))]); c[G.key].sort((a, b) => a[0] - b[0]); });
    });
    cv.addEventListener('contextmenu', e => {
      e.preventDefault();
      if (e.ctrlKey) return;   // Ctrl-click on a Mac: that's the curve shift, not a right click
      const h = hit(G, cv, local(cv, e));
      if (h?.i != null) remove(h.i);
    });
  }

  // ------------------------------------------------------------------ the rest of the panel
  function render() {
    if (el.hidden) return;
    const c = curve(), lvl = settings.get('gVeg');
    for (const b of el.querySelectorAll('[data-level]')) b.setAttribute('aria-checked', b.dataset.level === lvl);
    el.querySelector('[data-act="smooth"]').checked = !!c.smooth;
    for (const b of el.querySelectorAll('[data-scale]')) b.setAttribute('aria-checked', b.dataset.scale === (c.lin ? 'lin' : 'log'));
    for (const f of BUSH) {
      const row = el.querySelector(`[data-f="${f[0]}"]`), x = settings.get(f[0]);
      row.querySelector('input').value = toPos(f, x);
      row.querySelector('output').textContent = x + '×';
    }
    el.classList.toggle('off', lvl === 'off');
    drawAll();
  }

  el.addEventListener('click', e => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.level) settings.set('gVeg', t.dataset.level, silent);
    else if (t.dataset.scale) edit(c => { c.lin = t.dataset.scale === 'lin'; });
    else if (t.dataset.act === 'close') close();
    t.blur();
  });
  el.addEventListener('change', e => {
    if (e.target.dataset.act === 'smooth') { edit(c => { c.smooth = e.target.checked; }); e.target.blur(); }
  });
  el.addEventListener('input', e => {
    const row = e.target.closest('[data-f]');
    if (!row) return;
    const f = BUSH.find(x => x[0] === row.dataset.f);
    settings.set(f[0], fromPos(f, +e.target.value), silent);
  });
  // the arrow keys drive, not the slider
  el.addEventListener('pointerup', () => setTimeout(() => { const a = document.activeElement; if (a?.closest?.('.gedit') && a.type === 'range') a.blur(); }, 0));

  // drag the panel by its title
  const head = el.querySelector('.ge-head');
  head.addEventListener('pointerdown', e => {
    if (e.target.closest('button') || e.button !== 0) return;
    const r = el.getBoundingClientRect(), ox = e.clientX - r.left, oy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
    const move = ev => {
      el.style.left = clamp(ev.clientX - ox, 0, window.innerWidth - 60) + 'px';
      el.style.top = clamp(ev.clientY - oy, 0, window.innerHeight - 40) + 'px';
    };
    const stop = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', stop); };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', stop);
  });

  // live cost while open: the grass on the GPU (timer query) and the whole frame
  let timer = null, raf = 0;
  const frames = [], stats = el.querySelector('.ge-stats');
  let last = 0, shown = 0;
  const tick = now => {
    if (last) frames.push(now - last);
    last = now;
    if (frames.length > 60) frames.shift();
    if (now - shown > 250) {
      shown = now;
      const med = [...frames].sort((a, b) => a - b)[frames.length >> 1] || 0;
      stats.innerHTML = `${timer ? `<b>${timer.ms.toFixed(1)} ms</b> grass · ` : ''}${med.toFixed(1)} ms frame`;
    }
    raf = requestAnimationFrame(tick);
  };

  function open() {
    if (!el.hidden) return;
    el.hidden = false;
    timer = api.grass.setTiming(api.renderer, true);
    frames.length = 0; last = 0;
    raf = requestAnimationFrame(tick);
    render();
  }
  function close() {
    if (el.hidden) return;
    el.hidden = true;
    api.grass.setTiming(api.renderer, false);
    timer = null;
    cancelAnimationFrame(raf);
    drag = null;
  }

  // the preset, the curves or the bushes changed (here, in the menu or by a quality preset): redraw
  let queued = false;
  settings.onChange(() => {
    if (el.hidden || queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; render(); });
  });
  window.addEventListener('resize', () => { if (!el.hidden) drawAll(); });

  return { open, close, toggle: () => (el.hidden ? open() : close()), get isOpen() { return !el.hidden; } };
}
