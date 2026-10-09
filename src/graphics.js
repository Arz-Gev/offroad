import * as THREE from 'three';
import { QUALITY, SHADOWS, autoQuality, presetToGfx, gfxToQuality } from './render/quality.js';
import { storage } from './settings.js';

// Graphics settings -> renderer: the preset or Custom values, resolution, dynamic resolution (Mobile) and Auto
// quality by measurement. ctx: { renderer, pipeline, env, scenery, settings, dust, gunnery, game, say, started() }.
export const GFX_KEYS = Object.keys(presetToGfx(QUALITY.high));

export function createGraphics(ctx) {
  const { renderer, pipeline, env, scenery, settings, dust, gunnery, game, say } = ctx;
  const gfx = { auto: autoQuality(renderer), preset: null, q: null, dyn: 1 };
  const _db = new THREE.Vector2();

  function apply() {
    const sel = settings.get('quality');
    let q;
    if (sel === 'custom') {
      q = gfxToQuality(settings.all);
      gfx.preset = 'custom';
    } else {
      const name = sel === 'auto' ? gfx.auto.preset : sel;
      q = QUALITY[name] || QUALITY.high;
      gfx.preset = name;
      const g = presetToGfx(q);
      for (const k of GFX_KEYS) settings.set(k, g[k], { silent: true, sync: true });
    }
    q = { ...q, vegetation: settings.get('gVeg') !== 'off' };
    gfx.q = q;
    pipeline.configure({ msaa: q.msaa, fxaa: q.fxaa, ssao: q.ssao });
    pipeline.params.bloom = q.bloom !== false;
    applyResolution();
    const S = SHADOWS[q.shadows], sh = env.sun.shadow;
    env.sun.castShadow = !!S;
    if (S) {
      // new map size or atlas layout: drop the old depth atlas (rebuilt next frame). configure() changes the
      // frame extents in place, so ext is read again after it
      const ext = sh.getFrameExtents(), ex = ext.x, ey = ext.y;
      if (sh.configure) sh.configure(S.cascades, S.splits);
      if (sh.mapSize.x !== S.map || ext.x !== ex || ext.y !== ey) {
        sh.mapSize.set(S.map, S.map);
        if (sh.map) { sh.map.depthTexture?.dispose(); sh.map.dispose(); sh.map = null; }
      }
      sh.camera.far = S.far;
      sh.radius = sh.configure ? S.soft : 1.4;
    }
    scenery.configure(q);
    game.redraw = 3;
  }

  function applyResolution() {
    const q = gfx.q, dpr = q.dynamicDpr ? gfx.dyn : q.dpr;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dpr) * settings.get('renderScale'));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.getDrawingBufferSize(_db);
    pipeline.setSize(_db.x, _db.y);
    dust.setViewport(_db.y);
    gunnery?.setViewport(_db.y);
    game.redraw = 3;
  }

  // Dynamic resolution (presets with dynamicDpr: Mobile). Starts at 100 % density, steps 12.5 % every
  // 2.5 s: up at ~60 fps, down below 45. A step up that falls under 50 goes back and is barred for 1 min.
  const dynRes = { t: 0, n: 0, skip: 1, ceil: Infinity, ceilUntil: 0, raised: false };
  const DYN_STEP = 0.125, DYN_MIN = 1;
  function updateDynamicResolution(dt, paused) {
    const q = gfx.q, R = dynRes;
    if (!q?.dynamicDpr || paused || document.hidden || (window.devicePixelRatio || 1) <= DYN_MIN) { R.t = R.n = 0; return; }
    R.t += dt; R.n++;
    if (R.t < 2.5) return;
    const fps = R.n / R.t, now = performance.now();
    R.t = R.n = 0;
    if (R.skip > 0) { R.skip--; return; }               // the window after a change holds its hitch
    const max = Math.min(q.dpr, window.devicePixelRatio || 1);
    if (now > R.ceilUntil) R.ceil = Infinity;
    let next = gfx.dyn;
    if (fps < 45 || (R.raised && fps < 50)) {
      if (R.raised) { R.ceil = gfx.dyn - DYN_STEP; R.ceilUntil = now + 60000; }
      next = Math.max(DYN_MIN, gfx.dyn - DYN_STEP);
    } else if (fps >= 57 && gfx.dyn + DYN_STEP <= Math.min(max, R.ceil) + 1e-6) next = gfx.dyn + DYN_STEP;
    R.raised = next > gfx.dyn;
    if (next !== gfx.dyn) { gfx.dyn = next; R.skip = 1; applyResolution(); }
  }

  // Auto quality by measurement (not on phones). Algorithm and thresholds: DEVNOTES.md, "Auto quality".
  const AUTO_LADDER = ['low', 'medium', 'high', 'ultra'], AUTO_KEY = 'offroad.autoQuality.v1';
  const autoSig = `${gfx.auto.gpu}|${Math.round(screen.width * screen.height * (window.devicePixelRatio || 1) ** 2 / 1e5)}`;
  const autoSaved = () => { try { return JSON.parse(storage.get(AUTO_KEY) || '{}'); } catch { return {}; } };
  gfx.auto.guess = gfx.auto.preset;
  const tune = { on: false, t: 0, dts: [], ceil: AUTO_LADDER.length - 1, raised: false, measured: false };
  function startAutoTune(fresh) {
    const saved = autoSaved()[autoSig];
    tune.on = AUTO_LADDER.includes(gfx.auto.guess);
    tune.t = 0; tune.dts.length = 0; tune.raised = false; tune.measured = false;
    tune.ceil = AUTO_LADDER.length - 1;
    if (!tune.on) return;
    if (!fresh && AUTO_LADDER.includes(saved)) {
      gfx.auto.preset = saved; tune.measured = true;
      tune.ceil = AUTO_LADDER.indexOf(saved);            // measured: only step down from here
    } else gfx.auto.preset = gfx.auto.guess;
  }
  function saveAutoTune() {
    const all = autoSaved();
    all[autoSig] = gfx.auto.preset;
    storage.set(AUTO_KEY, JSON.stringify(all));
    tune.measured = true;
  }
  function updateAutoQuality(dt) {
    if (!tune.on || settings.get('quality') !== 'auto' || game.paused || document.hidden || !ctx.started()) return;
    tune.t += dt;
    if (tune.t < 3) return;
    tune.dts.push(dt);
    if (tune.t < 4) return;
    const s = tune.dts.slice().sort((a, b) => a - b), fps = 1 / s[s.length >> 1];
    if (tune.t < 7 && fps >= 40) return;          // under 40 fps: decide after 1 s
    tune.t = 0; tune.dts.length = 0;
    const i = AUTO_LADDER.indexOf(gfx.auto.preset);
    let next = i;
    if (tune.raised && fps < 50) { next = i - 1; tune.ceil = next; }   // step up didn't hold
    else if (fps < 45 && i > 0) { next = i - 1; tune.ceil = next; }
    else if (fps >= 57 && i < tune.ceil) next = i + 1;
    tune.raised = next > i;
    if (next === i) { tune.on = false; saveAutoTune(); return; }
    gfx.auto.preset = AUTO_LADDER[next];
    apply();
    if (next < i) saveAutoTune();
    say('quality', `Graphics: ${QUALITY[gfx.auto.preset].label}${next < i ? ' for a steadier frame rate' : ' (testing)'}`, '', 2.5);
  }
  startAutoTune(false);

  // the note under Quality in the menu
  function qualityNote() {
    const sel = settings.get('quality'), auto = QUALITY[gfx.auto.preset].label;
    const dyn = gfx.q?.dynamicDpr ? ` Pixel density adjusts itself between 100 and 150 % to hold 45–60 fps (now ${Math.round(Math.min(gfx.dyn, window.devicePixelRatio || 1) * 100)} %).` : '';
    const how = gfx.auto.preset === 'mobile' ? 'for this device.' : tune.on ? 'measuring the frame rate while you drive…' : tune.measured ? 'measured on this computer. Pick another preset and Auto again to measure again.' : 'for this graphics chip.';
    return (sel === 'auto' ? `Auto: ${auto}, ${how}` : sel === 'custom' ? `Custom: your own settings below. Auto would pick ${auto}.` : `Auto would pick ${auto} here.`) + dyn;
  }

  return Object.assign(gfx, { tune, dynRes, apply, applyResolution, updateDynamicResolution, updateAutoQuality, startAutoTune, qualityNote });
}
