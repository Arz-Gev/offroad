// TEMPORARY experiment panel: live sliders for the grass and undergrowth settings, shown on the game
// screen so the effect is visible while moving them. Values are the exact setting values (multipliers and
// metres, no percents). Remove this file, its import in main.js and the .tuner rules in ui.css when the
// values are chosen (then put the chosen ones in settings.js DEFAULTS and render/quality.js).

const ROWS = [
  { title: 'Grass' },
  { key: 'gGrass', label: 'Density', min: 0, max: 8, step: 0.05, unit: '×', dp: 2, tip: '0 = grass off. 1 = a blade in every cell (the old maximum); above 1 packs more blades in.' },
  { key: 'gGrassHeight', label: 'Height', min: 0.1, max: 10, step: 0.05, unit: '×', dp: 2, tip: '1 = the original blade height (near blades 0.34 m, far 0.32 m).' },
  { key: 'gGrassWidth', label: 'Blade width', min: 0.2, max: 6, step: 0.05, unit: '×', dp: 2, tip: '1 = the original width.' },
  { key: 'gGrassDist', label: 'Distance', min: 10, max: 500, step: 1, unit: 'm', dp: 0, tip: 'Where the grass ends (the far, coarser layer).' },
  { key: 'gGrassNear', label: 'Dense layer', min: 0, max: 80, step: 1, unit: 'm', dp: 0, tip: 'Radius of the fine near layer (the expensive one). 0 = automatic (17 m, a bit more on a long distance).' },
  { key: 'gGrassFarWidth', label: 'Far width', min: 0.1, max: 3, step: 0.05, unit: '×', dp: 2, tip: 'Width of the far layer blades (the ones past the dense layer), on top of the width above and the growth below.' },
  { key: 'gGrassFarSpacing', label: 'Far spacing', min: 0.3, max: 4, step: 0.05, unit: '×', dp: 2, tip: 'Cell spacing of the far layer. Below 1 packs more blades in (more cost), above 1 thins them out.' },
  { key: 'gGrassFarGrow', label: 'Far growth', min: 0, max: 1.5, step: 0.05, unit: '', dp: 2, tip: 'How much the far layer gets wider and sparser as the grass distance goes past 52 m. 1 = proportional to the distance (the original), 0 = not at all.' },
  { title: 'Bushes and plants' },
  { key: 'gBushes', label: 'Density', min: 0, max: 8, step: 0.05, unit: '×', dp: 2, tip: '0 = off. 1 = the original spacing.' },
  { key: 'gBushHeight', label: 'Size', min: 0.2, max: 6, step: 0.05, unit: '×', dp: 2, tip: 'Scales whole plants (height and width). 1 = the original size.' },
  { key: 'gBushDist', label: 'Distance', min: 0.2, max: 6, step: 0.05, unit: '×', dp: 2, tip: 'Multiplier of the original distances (ferns 44 m, shrubs 72 m, flowers 36 m, tufts 32 m).' },
];

export function buildTuner(settings, game) {
  const root = document.createElement('div');
  root.className = 'tuner';
  root.innerHTML = `<div class="tn-head"><b>Grass tuner</b><span class="tn-q"></span><button class="tn-fold" title="Collapse">–</button></div>
    <div class="tn-body"></div>
    <div class="tn-foot"><button class="tn-copy">Copy values</button><button class="tn-reset">Reset</button><span class="tn-msg"></span></div>`;
  const body = root.querySelector('.tn-body'), msg = root.querySelector('.tn-msg'), qlab = root.querySelector('.tn-q');
  const rows = [];
  for (const r of ROWS) {
    if (r.title) { const h = document.createElement('div'); h.className = 'tn-title'; h.textContent = r.title; body.appendChild(h); continue; }
    const row = document.createElement('label');
    row.className = 'tn-row';
    row.title = r.tip;
    row.innerHTML = `<span class="tn-l">${r.label}</span><input class="tn-n" type="number" min="${r.min}" max="${r.max}" step="${r.step}"><span class="tn-u">${r.unit}</span><input class="tn-s" type="range" min="${r.min}" max="${r.max}" step="${r.step}">`;
    const num = row.querySelector('.tn-n'), sl = row.querySelector('.tn-s');
    const apply = v => { v = Math.min(r.max, Math.max(r.min, v)); if (Number.isFinite(v)) settings.set(r.key, +v.toFixed(3), { silent: true }); show(); };
    sl.addEventListener('input', () => apply(+sl.value));
    sl.addEventListener('pointerup', () => sl.blur());
    num.addEventListener('change', () => { if (num.value !== '') apply(+num.value); });
    num.addEventListener('keydown', e => { if (e.key === 'Enter') num.blur(); });
    body.appendChild(row);
    rows.push({ r, num, sl });
  }
  function show() {
    for (const { r, num, sl } of rows) {
      const v = settings.get(r.key);
      if (document.activeElement !== num) num.value = v.toFixed(r.dp);
      sl.value = v;
    }
    const q = settings.get('quality');
    qlab.textContent = q === 'custom' ? 'custom' : 'preset: ' + (game.gfx?.preset || q);
  }
  // the game reads keys on window: keep typing in the fields (and the arrow keys on the sliders) to the panel
  for (const ev of ['keydown', 'keyup']) root.addEventListener(ev, e => e.stopPropagation());
  root.querySelector('.tn-fold').addEventListener('click', e => {
    root.classList.toggle('folded');
    e.target.textContent = root.classList.contains('folded') ? '+' : '–';
  });
  const flash = t => { msg.textContent = t; setTimeout(() => { if (msg.textContent === t) msg.textContent = ''; }, 2500); };
  root.querySelector('.tn-copy').addEventListener('click', async () => {
    const text = ROWS.filter(r => r.key).map(r => `${r.key}: ${settings.get(r.key)}`).join('\n');
    console.log(text);
    try { await navigator.clipboard.writeText(text); flash('copied'); } catch { flash('see console'); }
  });
  root.querySelector('.tn-reset').addEventListener('click', () => {
    settings.set('quality', 'auto', { silent: true });   // a preset writes its own values into the options
    flash('back to the automatic preset');
  });
  settings.onChange(show);
  show();
  document.body.appendChild(root);
  game.tuner = { root, rows, show };
  return root;
}
