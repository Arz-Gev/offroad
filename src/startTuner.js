// TEMPORARY experiment panel: live sliders for the engine start (starter sound in the worklet, start
// physics in params.engine), on the game screen so the start can be heard while moving them.
// "Restart engine" stops the engine and starts it again; "Copy values" puts them on the clipboard.
// Remove this file, its import in main.js and the .tuner rules in ui.css once the values are chosen
// (sound: STARTER_DEFAULTS in audio/engine-worklet.js; physics: engine in vehicle/params.js).
import { storage } from './settings.js';

const KEY = 'offroad.startTuner.v1';
// sound: same defaults as STARTER_DEFAULTS in engine-worklet.js
const SOUND = {
  unevenness: 0.45, puff: 0.06, pops: 1.4, level: 0.12, pitch: 1, mesh: 0.5, mesh2: 1, q1: 5, q2: 7,
  wobble: 0.06, labour: 1, noise: 0.03, noiseHz: 900,
};
const PHYS = { starterRpm: 300, compressionTorque: 120, catchMin: 0.8, catchSpread: 0.5, fireRamp: 0.35, startFlare: 550 };

const ROWS = [
  { title: 'Starter sound' },
  { k: 'level', label: 'Whirr level', min: 0, max: 0.4, step: 0.005, dp: 3, tip: 'Overall loudness of the starter whirr.' },
  { k: 'pitch', label: 'Pitch', min: 0.4, max: 2.5, step: 0.01, dp: 2, tip: '1 = the gear mesh (~550 Hz and ~1.1 kHz at 250 rpm). Higher = higher.' },
  { k: 'mesh', label: 'Low tone', min: 0, max: 2, step: 0.01, dp: 2, tip: 'Level of the lower tone (the mesh, ~550 Hz).' },
  { k: 'mesh2', label: 'High tone', min: 0, max: 2, step: 0.01, dp: 2, tip: 'Level of the tone an octave up (~1.1 kHz).' },
  { k: 'q1', label: 'Low purity', min: 0.5, max: 30, step: 0.5, dp: 1, tip: 'Higher = cleaner, more of a tone; lower = noisier, more of a hiss.' },
  { k: 'q2', label: 'High purity', min: 0.5, max: 30, step: 0.5, dp: 1, tip: 'Same for the high tone.' },
  { k: 'noise', label: 'Motor noise', min: 0, max: 0.15, step: 0.002, dp: 3, tip: 'Brush / motor hiss under the tones.' },
  { k: 'noiseHz', label: 'Noise centre', min: 200, max: 4000, step: 10, dp: 0, tip: 'Where that hiss sits (Hz, at standstill; rises with rpm).' },
  { k: 'wobble', label: 'Pitch wobble', min: 0, max: 0.4, step: 0.005, dp: 3, tip: 'How much the starter pitch follows the crank speeding up and slowing down. 0.15+ starts to sound like a toy ray gun.' },
  { k: 'labour', label: 'Labour', min: 0, max: 1, step: 0.01, dp: 2, tip: 'How much louder it gets while pushing through each compression stroke (the pulsing).' },
  { title: 'Engine while cranking' },
  { k: 'unevenness', label: 'Rhythm depth', min: 0, max: 0.9, step: 0.01, dp: 2, tip: 'How much the crank speeds up and slows down per compression stroke (the "rrr-rrr").' },
  { k: 'puff', label: 'Chug', min: 0, max: 0.3, step: 0.005, dp: 3, tip: 'The air puff through the exhaust on each compression stroke.' },
  { k: 'pops', label: 'Catch pops', min: 0.5, max: 4, step: 0.05, dp: 2, tip: 'Loudness of the first firings while the engine catches (x a normal firing).' },
  { title: 'Start physics' },
  { k: 'starterRpm', phys: 1, label: 'Crank speed', min: 150, max: 700, step: 5, dp: 0, tip: 'Starter no-load speed (rpm). Cranking runs at roughly 2/3 of it, unevenly.' },
  { k: 'compressionTorque', phys: 1, label: 'Compression', min: 0, max: 220, step: 5, dp: 0, tip: 'How hard each compression stroke brakes the crank (Nm): the physical side of the rhythm.' },
  { k: 'catchMin', phys: 1, label: 'Crank time', min: 0.2, max: 3, step: 0.05, dp: 2, tip: 'Seconds of cranking before the first cylinders fire (minimum).' },
  { k: 'catchSpread', phys: 1, label: 'Random extra', min: 0, max: 2, step: 0.05, dp: 2, tip: 'Random extra cranking time on top (0 = always the same).' },
  { k: 'fireRamp', phys: 1, label: 'Catch time', min: 0.05, max: 1.5, step: 0.05, dp: 2, tip: 'Seconds from the first firing to all cylinders firing (the stumble).' },
  { k: 'startFlare', phys: 1, label: 'Flare', min: 0, max: 1200, step: 10, dp: 0, tip: 'How far above idle the revs rise on a start (rpm).' },
];

export function buildStartTuner(game) {
  const vals = { ...SOUND, ...PHYS };
  try { Object.assign(vals, JSON.parse(storage.get(KEY) || '{}')); } catch { /* defaults */ }
  const audio = game.audio, E = () => game.vehicle.P.engine;
  const push = () => {
    const snd = {}; for (const k in SOUND) snd[k] = vals[k];
    audio.setStarterTune(snd);
    for (const k in PHYS) E()[k] = vals[k];
    storage.set(KEY, JSON.stringify(vals));
  };

  const root = document.createElement('div');
  root.className = 'tuner';
  root.innerHTML = `<div class="tn-head"><b>Engine start tuner</b><span class="tn-q">temporary</span><button class="tn-fold" title="Collapse">–</button></div>
    <div class="tn-body"></div>
    <div class="tn-foot"><button class="tn-start">Restart engine</button><button class="tn-copy">Copy values</button><button class="tn-reset">Reset</button><span class="tn-msg"></span></div>`;
  const body = root.querySelector('.tn-body'), msg = root.querySelector('.tn-msg');
  const rows = [];
  for (const r of ROWS) {
    if (r.title) { const h = document.createElement('div'); h.className = 'tn-title'; h.textContent = r.title; body.appendChild(h); continue; }
    const row = document.createElement('label');
    row.className = 'tn-row';
    row.title = r.tip;
    row.innerHTML = `<span class="tn-l">${r.label}</span><input class="tn-n" type="number" min="${r.min}" max="${r.max}" step="${r.step}"><span class="tn-u"></span><input class="tn-s" type="range" min="${r.min}" max="${r.max}" step="${r.step}">`;
    const num = row.querySelector('.tn-n'), sl = row.querySelector('.tn-s');
    const apply = v => { if (!Number.isFinite(v)) return; vals[r.k] = +Math.min(r.max, Math.max(r.min, v)).toFixed(4); push(); show(); };
    sl.addEventListener('input', () => apply(+sl.value));
    sl.addEventListener('pointerup', () => sl.blur());
    num.addEventListener('change', () => { if (num.value !== '') apply(+num.value); });
    num.addEventListener('keydown', e => { if (e.key === 'Enter') num.blur(); });
    body.appendChild(row);
    rows.push({ r, num, sl });
  }
  function show() {
    for (const { r, num, sl } of rows) {
      if (document.activeElement !== num) num.value = vals[r.k].toFixed(r.dp);
      sl.value = vals[r.k];
    }
  }
  // the game reads keys on window: keep typing in the fields (and the arrow keys on the sliders) to the panel
  for (const ev of ['keydown', 'keyup']) root.addEventListener(ev, e => e.stopPropagation());
  root.querySelector('.tn-fold').addEventListener('click', e => {
    root.classList.toggle('folded');
    e.target.textContent = root.classList.contains('folded') ? '+' : '–';
  });
  const flash = t => { msg.textContent = t; setTimeout(() => { if (msg.textContent === t) msg.textContent = ''; }, 2500); };
  root.querySelector('.tn-start').addEventListener('click', e => {
    e.target.blur();
    const d = game.vehicle.drivetrain;
    d.stopEngine(); d.starterTime = 0;
    // wait until the crank has stopped, then turn the key
    const t0 = performance.now();
    const iv = setInterval(() => {
      if (Math.abs(d.rpm) < 3 || performance.now() - t0 > 4000) { clearInterval(iv); d.startEngine(); }
    }, 50);
    flash('stopping, then starting');
  });
  root.querySelector('.tn-copy').addEventListener('click', async () => {
    const text = 'engine start tuner: ' + JSON.stringify(vals);
    console.log(text);
    try { await navigator.clipboard.writeText(text); flash('copied'); } catch { flash('see console'); }
  });
  root.querySelector('.tn-reset').addEventListener('click', () => { Object.assign(vals, SOUND, PHYS); push(); show(); flash('defaults'); });
  push();
  show();
  document.body.appendChild(root);
  game.startTuner = { root, vals, show };
  return root;
}
