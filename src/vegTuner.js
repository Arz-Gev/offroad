import { QUALITY } from './render/quality.js';
import { storage } from './settings.js';
import './vegTuner.css';

// TEMPORARY tool for retuning the grass and bush presets (loaded only with ?vegtune, see MEADOW in
// world/terrain.js). A panel over the running game: pick a preset, its current values ("old") load into
// the sliders; moving one makes a "new" version of that preset, and Old / New flip between the two.
// Copy puts all four presets (new where edited) on the clipboard in render/quality.js's format.
// The edits live in localStorage (offroad.vegtune.v1) so a reload keeps them.

const KEY = 'offroad.vegtune.v1';
const PRESETS = [['low', 'Low'], ['medium', 'Med'], ['high', 'High'], ['ultra', 'Ultra']];
// [field in the quality preset, label, min, max, log scale, unit]; ranges are wide on purpose (tuning)
const GROUPS = [
  ['Grass', [['grass', 'Density', 0.01, 1.5, true, '×'], ['grassHeight', 'Height', 0.5, 6, false, '×'], ['grassWidth', 'Width', 0.3, 5, false, '×'], ['grassNear', 'Distance', 15, 100, false, ' m']]],
  ['Far grass', [['farDensity', 'Density', 0.005, 1.5, true, '×'], ['farWidth', 'Width', 0.5, 8, false, '×'], ['grassRadius', 'Distance', 40, 350, false, ' m']]],
  ['Bushes', [['bushes', 'Density', 0.02, 4, true, '×'], ['bushHeight', 'Size', 0.5, 4, false, '×'], ['bushDist', 'Distance', 0.5, 4, false, '×']]],
];
const FIELDS = GROUPS.flatMap(g => g[1]);
const STEPS = 1000;
const round = v => +(v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toPrecision(3));
const toPos = (f, v) => Math.round(STEPS * (f[4] ? Math.log(v / f[2]) / Math.log(f[3] / f[2]) : (v - f[2]) / (f[3] - f[2])));
const fromPos = (f, p) => round(f[4] ? f[2] * (f[3] / f[2]) ** (p / STEPS) : f[2] + (f[3] - f[2]) * p / STEPS);
const pick = q => Object.fromEntries(FIELDS.map(f => [f[0], q[f[0]]]));

// api: { settings, apply(values) — scenery with these grass and bush values on top of the current graphics }
export function startVegTuner(api) {
  const old = Object.fromEntries(PRESETS.map(([p]) => [p, pick(QUALITY[p])]));
  let st = { cur: 'high', view: 'old', edits: {}, collapsed: false };
  try { st = { ...st, ...JSON.parse(storage.get(KEY) || '{}') }; } catch { /* keep defaults */ }
  const save = () => storage.set(KEY, JSON.stringify(st));
  const values = () => (st.view === 'new' && st.edits[st.cur]) || old[st.cur];

  const el = document.createElement('div');
  el.className = 'vegt';
  el.innerHTML = `
    <div class="vt-head"><b>Grass presets</b><span class="vt-sub">tuning meadow</span><button type="button" class="vt-x" data-act="collapse" title="Hide / show"></button></div>
    <div class="vt-body">
      <div class="vt-seg vt-presets">${PRESETS.map(([p, l]) => `<button type="button" data-preset="${p}">${l}</button>`).join('')}</div>
      <div class="vt-bar">
        <div class="vt-seg vt-view"><button type="button" data-view="old">Old</button><button type="button" data-view="new">New</button></div>
        <button type="button" class="vt-b" data-act="reset">Drop new</button>
        <button type="button" class="vt-b primary" data-act="copy">Copy all</button>
      </div>
      ${GROUPS.map(([title, fs]) => `<h3>${title}</h3>${fs.map(f => `
        <div class="vt-row" data-f="${f[0]}"><div class="vt-l"><span>${f[1]}</span><output></output><small></small></div>
        <input type="range" min="0" max="${STEPS}" step="1"></div>`).join('')}`).join('')}
      <textarea class="vt-out" readonly hidden></textarea>
    </div>`;
  document.body.appendChild(el);

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
    for (const f of FIELDS) {
      const row = el.querySelector(`[data-f="${f[0]}"]`), x = v[f[0]], changed = x !== o[f[0]];
      row.querySelector('input').value = toPos(f, x);
      row.querySelector('output').textContent = x + f[5];
      row.querySelector('small').textContent = changed ? `was ${o[f[0]]}` : '';
      row.classList.toggle('mod', changed);
    }
  }
  function apply() { api.apply(values()); }

  el.addEventListener('click', e => {
    const t = e.target.closest('button');
    if (!t || t.disabled) return;
    if (t.dataset.preset) {
      st.cur = t.dataset.preset;
      st.view = st.edits[st.cur] ? 'new' : 'old';
      api.settings.set('quality', st.cur);   // the whole preset (shadows, resolution, ...), so the frame rate is the real one
    } else if (t.dataset.view) st.view = t.dataset.view;
    else if (t.dataset.act === 'reset') { delete st.edits[st.cur]; st.view = 'old'; }
    else if (t.dataset.act === 'collapse') st.collapsed = !st.collapsed;
    else if (t.dataset.act === 'copy') copy();
    t.blur();
    save(); render(); apply();
  });
  el.addEventListener('input', e => {
    const row = e.target.closest('[data-f]');
    if (!row) return;
    const f = FIELDS.find(x => x[0] === row.dataset.f);
    if (!st.edits[st.cur]) st.edits[st.cur] = { ...old[st.cur] };
    st.view = 'new';
    st.edits[st.cur][f[0]] = fromPos(f, +e.target.value);
    save(); render(); apply();
  });
  // the arrow keys drive, not the slider
  el.addEventListener('change', e => e.target.blur());
  el.addEventListener('pointerup', () => setTimeout(() => document.activeElement?.closest?.('.vegt') && document.activeElement.blur(), 0));

  function copy() {
    const lines = PRESETS.map(([p]) => {
      const v = st.edits[p] || old[p];
      return `${p}: ${FIELDS.map(f => `${f[0]}: ${v[f[0]]}`).join(', ')}${st.edits[p] ? '' : '   // unchanged'}`;
    });
    const text = `Grass presets (vegtune):\n${lines.join('\n')}`;
    const out = el.querySelector('.vt-out');
    const shown = () => { out.hidden = false; out.value = text; out.select(); };
    const ok = () => { const b = el.querySelector('[data-act="copy"]'); b.textContent = 'Copied ✓'; setTimeout(() => { b.textContent = 'Copy all'; }, 1500); };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(ok, shown); else shown();
  }

  // any graphics change rebuilds the scenery from the settings: put the tuned values back on top
  api.settings.onChange(() => apply());
  render();
  if (api.settings.get('quality') !== st.cur) api.settings.set('quality', st.cur); else apply();
}
