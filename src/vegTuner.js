import { QUALITY } from './render/quality.js';
import { storage } from './settings.js';
import { evalCurve } from './world/grass.js';
import './vegTuner.css';

// TEMPORARY tool for retuning the grass and bush presets (loaded only with ?vegtune, see MEADOW in
// world/terrain.js). A panel over the running game, dragged by its title. Pick a preset: its current
// values ("old") load; any edit makes a "new" version of that preset, Old / New flip between the two.
// Grass is three curves over the distance (density, height, width): drag the points (Ctrl / Cmd + drag
// moves the whole curve up or down), double-click to add or remove one (right-click removes too), drag
// the dashed line to move where the grass ends.
// Copy / Paste carry one preset's values to another (Paste makes them the new version of the current one).
// Copy all puts all four presets (new where edited) on the clipboard. Edits survive a reload (localStorage).

const KEY = 'offroad.vegtune.v14';
const PRESETS = [['low', 'Low'], ['medium', 'Med'], ['high', 'High'], ['ultra', 'Ultra']];
const XMAX = 300, XT = [0, 10, 25, 50, 100, 200, 300], XT_LIN = [0, 50, 100, 150, 200, 250, 300];
const rnd = v => (v >= 10 ? Math.round(v) : v >= 1 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100);
const GRAPHS = [
  // log: a log axis in the Log view; linMax / linTicks: the axis in the Lin view
  { key: 'density', label: 'Density', unit: '/m²', min: 0.3, max: 300, log: true, ticks: [1, 10, 100], minor: [3, 30, 300], linMax: 150, linTicks: [0, 50, 100, 150] },
  { key: 'height', label: 'Height', unit: ' cm', min: 5, max: 400, log: true, ticks: [10, 30, 100, 300], linMax: 400, linTicks: [0, 100, 200, 300, 400] },
  { key: 'width', label: 'Width', unit: ' cm', min: 1, max: 200, log: true, ticks: [1, 3, 10, 30, 100], linMax: 200, linTicks: [0, 50, 100, 150, 200] },
];
// bushes: [field, label, min, max, log scale, unit]
const BUSH = [['bushes', 'Density', 0.02, 4, true, '×'], ['bushHeight', 'Size', 0.5, 4, false, '×'], ['bushDist', 'Distance', 0.5, 4, false, '×']];
const STEPS = 1000;
const toPos = (f, v) => Math.round(STEPS * (f[4] ? Math.log(v / f[2]) / Math.log(f[3] / f[2]) : (v - f[2]) / (f[3] - f[2])));
const fromPos = (f, p) => rnd(f[4] ? f[2] * (f[3] / f[2]) ** (p / STEPS) : f[2] + (f[3] - f[2]) * p / STEPS);
const clone = o => JSON.parse(JSON.stringify(o));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// api: { settings, apply(values), grass, renderer }
export function startVegTuner(api) {
  const old = Object.fromEntries(PRESETS.map(([p]) => {
    const q = QUALITY[p];
    return [p, { curve: clone(q.grassCurve), bushes: q.bushes, bushHeight: q.bushHeight, bushDist: q.bushDist }];
  }));
  let st = { cur: 'high', view: 'old', edits: {}, collapsed: false };
  try { st = { ...st, ...JSON.parse(storage.get(KEY) || '{}') }; } catch { /* keep defaults */ }
  const save = () => storage.set(KEY, JSON.stringify(st));
  const values = () => (st.view === 'new' && st.edits[st.cur]) || old[st.cur];
  const editable = () => {   // the first edit of a preset copies it into its new version
    if (!st.edits[st.cur]) st.edits[st.cur] = clone(old[st.cur]);
    st.view = 'new';
    return st.edits[st.cur];
  };

  const el = document.createElement('div');
  el.className = 'vegt';
  el.innerHTML = `
    <div class="vt-head"><b>Grass</b><span class="vt-stats"></span><button type="button" class="vt-x" data-act="collapse" title="Hide / show"></button></div>
    <div class="vt-body">
      <div class="vt-bar">
        <div class="vt-seg vt-presets">${PRESETS.map(([p, l]) => `<button type="button" data-preset="${p}">${l}</button>`).join('')}</div>
        <div class="vt-seg"><button type="button" data-view="old">Old</button><button type="button" data-view="new">New</button></div>
        <button type="button" class="vt-b" data-act="reset" title="Drop the new version of this preset">Drop</button>
        <button type="button" class="vt-b primary" data-act="copy">Copy all</button>
      </div>
      <div class="vt-bar">
        <div class="vt-seg"><button type="button" data-scale="lin">Lin</button><button type="button" data-scale="log">Log</button></div>
        <label class="vt-check"><input type="checkbox" data-act="smooth"> Smooth</label>
        <button type="button" class="vt-b vt-push" data-act="copy1" title="Copy this preset (as shown)">Copy</button>
        <button type="button" class="vt-b" data-act="paste">Paste</button>
        <span class="vt-help" title="Drag points. Ctrl / Cmd + drag: move the whole curve up or down. Double-click: add or remove a point (right-click removes too). Drag the dashed line: where the grass ends. The faint line is the old preset.">?</span>
      </div>
      ${GRAPHS.map(g => `<canvas class="vt-graph" data-g="${g.key}"></canvas>`).join('')}
      <div class="vt-bush">
        <b>Bushes</b>
        ${BUSH.map(f => `
        <div class="vt-row" data-f="${f[0]}"><span>${f[1]}</span><input type="range" min="0" max="${STEPS}" step="1"><output></output></div>`).join('')}
      </div>
      <textarea class="vt-out" readonly hidden></textarea>
    </div>`;
  document.body.appendChild(el);

  // ------------------------------------------------------------------ graphs
  const PAD = { l: 34, r: 8, t: 16, b: 16 };
  // Log view: √distance across (room for the near metres), log values up; Lin view: both plain
  const isLin = () => !!values().curve.lin;
  const lay = cv => {
    const W = cv.clientWidth, H = cv.clientHeight, w = W - PAD.l - PAD.r, h = H - PAD.t - PAD.b, lin = isLin();
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
    if (cv.width !== Math.round(L.W * dpr)) { cv.width = Math.round(L.W * dpr); cv.height = Math.round(L.H * dpr); }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, L.W, L.H);
    const v = values(), c = v.curve, pts = c[G.key], end = c.end;
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
    const line = (p, smooth, lin, color, width) => {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
      for (let x = PAD.l; x <= PAD.l + L.w; x += 2) { const y = Y(evalCurve(p, L.D(x), smooth, G.log, lin)); x === PAD.l ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
      ctx.stroke();
    };
    // the old preset's curve, faint, while editing its new version
    if (st.view === 'new' && st.edits[st.cur]) line(old[st.cur].curve[G.key], old[st.cur].curve.smooth, !!old[st.cur].curve.lin, 'rgba(255,255,255,0.22)', 1.5);
    line(pts, c.smooth, !!c.lin, '#ffb347', 2);
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
    const L = lay(cv), { Y } = yMap(G, L), c = values().curve;
    let best = -1, bd = 9;
    c[G.key].forEach(([d, y], i) => { const dd = Math.hypot(L.X(d) - p.x, Y(y) - p.y); if (dd < bd) { bd = dd; best = i; } });
    if (best >= 0) return { i: best };
    if (Math.abs(L.X(c.end) - p.x) < 6 && p.y > PAD.t && p.y < PAD.t + L.h) return { end: true };
    if (p.x >= PAD.l && p.x <= PAD.l + L.w) return { d: L.D(p.x) };
    return null;
  };
  let applyQueued = false;
  const applySoon = () => { if (applyQueued) return; applyQueued = true; requestAnimationFrame(() => { applyQueued = false; apply(); }); };

  for (const G of GRAPHS) {
    const cv = el.querySelector(`[data-g="${G.key}"]`);
    cv.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      const p = local(cv, e), h = hit(G, cv, p);
      if (!h) return;
      if (e.ctrlKey || e.metaKey) {
        // Ctrl / Cmd: move the whole curve up or down, keeping its shape as drawn
        drag = { g: G, shift: true, y0: p.y, base: editable().curve[G.key].map(q => [...q]) };
      } else {
        if (h.d != null) return;
        editable();
        drag = { g: G, ...h };
      }
      cv.setPointerCapture(e.pointerId);
      render();
    });
    cv.addEventListener('pointermove', e => {
      const p = local(cv, e);
      if (!drag || drag.g !== G) {
        hover[G.key] = hit(G, cv, p);
        cv.style.cursor = (e.ctrlKey || e.metaKey) && hover[G.key] ? 'ns-resize' : hover[G.key]?.end ? 'ew-resize' : hover[G.key]?.i != null ? 'grab' : 'crosshair';
        draw(G);
        return;
      }
      const L = lay(cv), { V, Y } = yMap(G, L), c = editable().curve;
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
      drawAll(); applySoon();
    });
    const up = () => { if (drag?.g === G) { drag = null; save(); render(); apply(); } };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', () => { if (!drag) { hover[G.key] = null; draw(G); } });
    const remove = (i) => {
      const pts = editable().curve[G.key];
      if (i > 0 && pts.length > 1) pts.splice(i, 1);   // the first point (at the camera) stays
    };
    cv.addEventListener('dblclick', e => {
      const p = local(cv, e), h = hit(G, cv, p);
      if (!h || h.end) return;
      if (h.i != null) remove(h.i);
      else {
        const L = lay(cv), { V } = yMap(G, L), pts = editable().curve[G.key], d = rnd(L.D(p.x));
        if (!pts.some(q => Math.abs(q[0] - d) < 0.5)) { pts.push([d, rnd(V(p.y))]); pts.sort((a, b) => a[0] - b[0]); }
      }
      save(); render(); apply();
    });
    cv.addEventListener('contextmenu', e => {
      e.preventDefault();
      if (e.ctrlKey) return;   // Ctrl-click on a Mac: that's the curve shift, not a right click
      const h = hit(G, cv, local(cv, e));
      if (h?.i != null) { remove(h.i); save(); render(); apply(); }
    });
  }

  // ------------------------------------------------------------------ the rest of the panel
  function render() {
    el.classList.toggle('collapsed', !!st.collapsed);
    const v = values(), o = old[st.cur], hasNew = !!st.edits[st.cur];
    for (const b of el.querySelectorAll('[data-preset]')) {
      b.setAttribute('aria-checked', b.dataset.preset === st.cur);
      b.classList.toggle('edited', !!st.edits[b.dataset.preset]);
    }
    for (const b of el.querySelectorAll('[data-view]')) b.setAttribute('aria-checked', b.dataset.view === (hasNew ? st.view : 'old'));
    el.querySelector('[data-view="new"]').disabled = !hasNew;
    el.querySelector('[data-act="reset"]').disabled = !hasNew;
    el.querySelector('[data-act="smooth"]').checked = !!v.curve.smooth;
    const paste = el.querySelector('[data-act="paste"]');
    paste.disabled = !st.clip;
    paste.title = st.clip ? `Paste the copied ${st.clip.from} values into ${st.cur}` : 'Copy a preset first';
    for (const b of el.querySelectorAll('[data-scale]')) b.setAttribute('aria-checked', b.dataset.scale === (v.curve.lin ? 'lin' : 'log'));
    for (const f of BUSH) {
      const row = el.querySelector(`[data-f="${f[0]}"]`), x = v[f[0]], changed = x !== o[f[0]];
      row.querySelector('input').value = toPos(f, x);
      row.querySelector('output').textContent = x + f[5];
      row.title = changed ? `was ${o[f[0]]}` : '';
      row.classList.toggle('mod', changed);
    }
    drawAll();
  }
  function apply() {
    const v = values();
    api.apply({ grassCurve: v.curve, bushes: v.bushes, bushHeight: v.bushHeight, bushDist: v.bushDist });
  }

  el.addEventListener('click', e => {
    const t = e.target.closest('button');
    if (!t || t.disabled) return;
    if (t.dataset.preset) {
      st.cur = t.dataset.preset;
      st.view = st.edits[st.cur] ? 'new' : 'old';
      api.settings.set('quality', st.cur);   // the whole preset (shadows, resolution, ...), so the frame time is the real one
    } else if (t.dataset.view) st.view = t.dataset.view;
    else if (t.dataset.scale) editable().curve.lin = t.dataset.scale === 'lin';
    else if (t.dataset.act === 'reset') { delete st.edits[st.cur]; st.view = 'old'; }
    else if (t.dataset.act === 'collapse') st.collapsed = !st.collapsed;
    else if (t.dataset.act === 'copy') copy();
    else if (t.dataset.act === 'copy1') {
      st.clip = { ...clone(values()), from: st.cur };
      const v = values();
      navigator.clipboard?.writeText(`${st.cur}: ${JSON.stringify({ ...v.curve, bushes: v.bushes, bushHeight: v.bushHeight, bushDist: v.bushDist })}`).catch(() => {});
      t.textContent = 'Copied ✓'; setTimeout(() => { t.textContent = 'Copy'; }, 1500);
    } else if (t.dataset.act === 'paste' && st.clip) {
      const { from, ...v } = clone(st.clip);
      st.edits[st.cur] = v; st.view = 'new';
    }
    t.blur();
    save(); render(); apply();
  });
  el.addEventListener('change', e => {
    if (e.target.dataset.act === 'smooth') { editable().curve.smooth = e.target.checked; e.target.blur(); save(); render(); apply(); }
  });
  el.addEventListener('input', e => {
    const row = e.target.closest('[data-f]');
    if (!row) return;
    const f = BUSH.find(x => x[0] === row.dataset.f);
    editable()[f[0]] = fromPos(f, +e.target.value);
    save(); render(); apply();
  });
  // the arrow keys drive, not the slider
  el.addEventListener('pointerup', () => setTimeout(() => { const a = document.activeElement; if (a?.closest?.('.vegt') && a.type === 'range') a.blur(); }, 0));

  // drag the panel by its title
  const head = el.querySelector('.vt-head');
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

  function copy() {
    const lines = PRESETS.map(([p]) => {
      const v = st.edits[p] || old[p];
      return `${p}: ${JSON.stringify({ ...v.curve, bushes: v.bushes, bushHeight: v.bushHeight, bushDist: v.bushDist })}${st.edits[p] ? '' : '   // unchanged'}`;
    });
    const text = `Grass presets (vegtune curves):\n${lines.join('\n')}`;
    const out = el.querySelector('.vt-out');
    const shown = () => { out.hidden = false; out.value = text; out.select(); };
    const ok = () => { const b = el.querySelector('[data-act="copy"]'); b.textContent = 'Copied ✓'; setTimeout(() => { b.textContent = 'Copy all'; }, 1500); };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(ok, shown); else shown();
  }

  // live cost: the grass on the GPU (timer query), the whole frame, how many blades were sent
  const timer = api.grass.setTiming(api.renderer, true);
  const frames = [];
  let last = performance.now(), shown = 0;
  const stats = el.querySelector('.vt-stats');
  const tick = now => {
    frames.push(now - last); last = now;
    if (frames.length > 60) frames.shift();
    if (now - shown > 250) {
      shown = now;
      const med = [...frames].sort((a, b) => a - b)[frames.length >> 1] || 0;
      const g = timer ? `<b>${timer.ms.toFixed(1)} ms</b>` : 'no GPU timer';
      stats.innerHTML = `${g} grass · ${med.toFixed(1)} ms frame · ${Math.round((api.grass.sent || 0) / 1000)}k sent`;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // any graphics change rebuilds the scenery from the settings: put the tuned values back on top
  api.settings.onChange(() => apply());
  window.addEventListener('resize', drawAll);
  render();
  if (api.settings.get('quality') !== st.cur) api.settings.set('quality', st.cur); else apply();
}
