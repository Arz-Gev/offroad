import * as THREE from 'three/webgpu';
import RAPIER from '@dimforge/rapier3d-compat';
import { createRenderer } from './render/gpu.js';
import { RenderPipeline } from './render/post.js';
import { QUALITY, SHADOWS, autoQuality, presetToGfx, gfxToQuality } from './render/quality.js';

import { Terrain, SPAWN, LANES, HILL, POI } from './world/terrain.js';
import { buildTerrainView } from './world/terrainView.js';
import { buildGrass } from './world/grass.js';
import { buildTrees } from './world/trees.js';
import { buildWater } from './world/water.js';
import { buildUndergrowth } from './world/undergrowth.js';
import { makeRockMaterial } from './world/materials.js';
import { buildProps } from './world/props.js';
import { Environment, QUICK_HOURS, QUICK_ORDER } from './world/environment.js';
import { applySetup, rideRaise, useCar } from './vehicle/tuning.js';
import { ColliderView } from './vehicle/colliderView.js';
import { TuningPanel } from './tuningPanel.js';
import { Vehicle } from './vehicle/Vehicle.js';
import { buildCarModel, CARS } from './vehicle/cars.js';
import { makeCarParams } from './vehicle/carSpecs.js';
import { VehicleView } from './vehicle/vehicleView.js';
import { CameraRig, CAM_NAMES, camModesFor } from './cameraRig.js';
import { Turret } from './vehicle/turret.js';
import { Gunnery } from './weapons.js';
import { Input, capsHTML } from './input.js';
import { TouchControls } from './touch.js';
import { HUD, fmtPressure, escapeHTML } from './hud.js';
import { Menu } from './menu.js';
import { Settings } from './settings.js';
import { GameAudio } from './audio/audio.js';
import { Dust, Tracks } from './effects.js';
import { Multiplayer, roomFromURL } from './multiplayer.js';
import './ui.css';

const H = 1 / 240;          // physics step
const MAX_STEPS = 16;

// ---------------------------------------------------------------- loading screen
const loading = document.getElementById('loading');
const loadLog = [];   // [stage, ms since navigation]: game.loadLog, for tuning the start-up time
const setLoading = (text, p) => {
  loadLog.push([text, Math.round(performance.now())]);
  loading.querySelector('.ld-t').textContent = text;
  if (p !== undefined) loading.style.setProperty('--p', p);
};
// Yield so the loading text can paint. rAF gives a real paint; the timeout keeps loading going
// when the tab is hidden and rAF is throttled to ~0.
const frame = () => new Promise(r => {
  let done = false;
  const go = () => { if (!done) { done = true; r(); } };
  requestAnimationFrame(() => setTimeout(go, 0));
  setTimeout(go, 60);
});
function showError(e) {
  console.error(e);
  const msg = String(e && e.message || e);
  const webgl = /webgl|webgpu|context|adapter/i.test(msg);
  loading.classList.remove('done');
  loading.classList.add('error');
  setLoading('Could not start the game');
  const box = loading.querySelector('.ld-err');
  box.hidden = false;
  box.innerHTML = (webgl
    ? 'Neither WebGPU nor WebGL 2 is available. Turn on hardware acceleration in the browser settings, or try another browser.'
    : escapeHTML(msg)) + '<br><button type="button">Reload</button>';
  box.querySelector('button').addEventListener('click', () => location.reload());
}

async function main() {
  setLoading('Starting physics…', 0.08); await frame();
  await RAPIER.init();

  const canvas = document.getElementById('c');
  // WebGPU when the browser has it, else the same renderer on WebGL 2 (?webgl=1 forces that)
  setLoading('Starting the graphics…', 0.12); await frame();
  const forceWebGL = /[?&]webgl=1\b/.test(location.search);
  const renderer = await createRenderer(canvas, { forceWebGL });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 6000);
  const pipeline = new RenderPipeline(renderer, scene, camera);

  setLoading('Generating terrain…', 0.2); await frame();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = H;
  const terrain = new Terrain(7);
  terrain.createCollider(RAPIER, world);
  // world visuals that follow the camera or depend on the quality preset (grass, tree LOD, terrain LOD)
  const scenery = { parts: [], configure(q) { for (const p of this.parts) p.configure?.(q); }, update(dt, cam, focus) { for (const p of this.parts) p.update?.(dt, cam, focus); } };
  const env = new Environment(renderer, scene, pipeline);
  setLoading('Painting the ground…', 0.4); await frame();
  const terrainView = buildTerrainView(terrain, renderer, { noise: env.sky.noise });
  scene.add(terrainView.mesh);
  scenery.parts.push(terrainView);
  const grass = buildGrass(terrainView, renderer);
  scene.add(grass.group);
  scenery.parts.push(grass);
  const water = buildWater(terrain, terrainView, renderer);
  scene.add(water.group);
  scenery.parts.push(water);

  setLoading('Placing rocks and trees…', 0.5); await frame();
  const colliderSurface = new Map();
  const props = buildProps(RAPIER, world, terrain, colliderSurface, makeRockMaterial(terrainView.layers, { vertexColors: true }));
  scene.add(props);
  setLoading('Growing the forest…', 0.58); await frame();
  const trees = buildTrees(RAPIER, world, terrain, colliderSurface, renderer, terrainView, grass.shared.uWind);
  scene.add(trees.group);
  scenery.parts.push(trees);
  const undergrowth = buildUndergrowth(terrainView, trees.atlas, grass.shared.uWind, renderer, grass.shared.uCam);
  scene.add(undergrowth.group);
  scenery.parts.push(undergrowth);
  trees.updatePhysics(SPAWN.x, SPAWN.z);

  setLoading('Building the truck…', 0.68); await frame();
  // the player's tuning setup (saved) goes into the params before the truck is built
  const settings = new Settings();
  const car = settings.get('car');
  useCar(car);   // the tuning stock, ranges and saved setups are the car's own (before the panel is built)
  const tuningApi = {};
  const tuning = new TuningPanel(tuningApi);
  const P = applySetup(makeCarParams(), tuning.setup);
  const surfaceAt = (col, p) => (col && colliderSurface.get(col.handle)) || terrain.surfaceAt(p.x, p.z);
  const spawnY = terrain.heightAt(SPAWN.x, SPAWN.z) + 0.12 + rideRaise(P);
  const vehicle = new Vehicle(RAPIER, world, P, { position: { x: SPAWN.x, y: spawnY, z: SPAWN.z }, yaw: SPAWN.yaw, surfaceAt });
  vehicle.pressures = [tuning.setup.tyres.pressF, tuning.setup.tyres.pressR];
  world.step();
  const model = await buildCarModel(car);
  scene.add(model.root);
  // a turret (BTR-80): its state lives on the vehicle (the view, the HUD and the network read it)
  if (P.turret && model.turret) vehicle.turret = new Turret(P.turret);
  const view = new VehicleView(model, vehicle);
  const colliderView = new ColliderView(scene, model, vehicle);
  const d = vehicle.drivetrain;


  const rig = new CameraRig(camera, terrain);
  if (model.chaseDist) rig.dist = model.chaseDist;
  const input = new Input(canvas);
  const hud = new HUD();
  const touch = new TouchControls({ input, canvas, hud, action: id => input.onAction(id) });
  hud.setDevice(input.device);   // touch.js picks 'touch' on a phone or tablet
  const audio = new GameAudio();
  const dust = new Dust(scene);
  dust.waterAt = (x, z) => terrain.waterLevelAt(x, z);
  const gunnery = vehicle.turret ? new Gunnery({ RAPIER, world, scene, vehicle, model, terrain, surfaceAt, audio }) : null;
  const camModes = camModesFor(model);
  // the sight: the pointer locks to the view, so the mouse turns the turret (the first click in the sight)
  input.sightLock = () => { try { canvas.requestPointerLock?.()?.catch?.(() => {}); } catch { /* not allowed: drag to aim, Enter fires */ } };
  const tracks = new Tracks(terrainView);


  // interpolated body pose
  const prevPos = new THREE.Vector3().copy(vehicle.pos), curPos = new THREE.Vector3().copy(vehicle.pos);
  const prevQ = new THREE.Quaternion().copy(vehicle.quat), curQ = new THREE.Quaternion().copy(vehicle.quat);
  const rPos = new THREE.Vector3(), rQ = new THREE.Quaternion();

  // a spot on the nearest trail, `back` metres before the point, facing along the trail
  function trailSpot(x, z, back = 0) {
    let best = null, bd = Infinity;
    for (const c of terrain.trailCurves) {
      const n = Math.round(c.getLength() / 2), pts = c.getSpacedPoints(n);
      for (let k = 0; k <= n; k++) { const d = (pts[k].x - x) ** 2 + (pts[k].z - z) ** 2; if (d < bd) { bd = d; best = { pts, k, n }; } }
    }
    const { pts, k } = best, k0 = Math.max(0, k - Math.round(back / 2)), k1 = Math.min(pts.length - 1, k0 + 3);
    const p = pts[k0], q = pts[k1];
    return { x: p.x, z: p.z, yaw: Math.atan2(-(q.x - p.x), -(q.z - p.z)) };
  }
  // teleport targets, shown in the menu's Locations tab (x, z, yaw are also used by tools/browser-snippets.js)
  const teleports = [
    { name: 'Spawn', tag: 'Trail', title: 'Spawn', desc: 'Start of the trail loop: ruts, a mud hole and a branch towards the hills.', x: SPAWN.x, z: SPAWN.z, yaw: 0 },
    { name: 'Axle twister', tag: 'Proving ground · lane A', title: 'Axle twister and whoops', desc: 'Offset humps that lift one wheel at a time. Watch the axle articulation.', x: LANES.A, z: 47, yaw: 0 },
    { name: 'Steps and logs', tag: 'Proving ground · lane B', title: 'Steps and logs', desc: 'Ledges from 15 to 45 cm, then logs. Low range and a slow approach.', x: LANES.B, z: 47, yaw: 0 },
    { name: 'Rock garden', tag: 'Proving ground · lane C', title: 'Rock garden', desc: 'Boulders. Needs low range, lockers and a careful line.', x: LANES.C, z: 47, yaw: 0 },
    { name: 'Ramps', tag: 'Proving ground · lane D', title: 'Ramps 20° / 30° / 35°', desc: 'Climbs in low range. The steepest needs the centre diff locked.', x: LANES.D, z: 47, yaw: 0 },
    { name: 'Mud and off-camber', tag: 'Proving ground · lane E', title: 'Mud and off-camber', desc: 'A deep mud hole and a side slope. Air down and keep momentum.', x: LANES.E, z: 47, yaw: 0 },
    { name: 'The big hill', tag: 'Hill', title: 'The big hill', desc: 'A long climb with views over the whole map.', x: HILL.x - 52, z: HILL.z + 8, yaw: -Math.PI / 2 },
    { name: 'Lake shore', tag: 'Outer loop · east', title: 'Lake shore', desc: 'A sandy beach on the lake. Splash through the shallows along the shore.', x: 386, z: 44, yaw: Math.atan2(-(POI.lake.x - 386), -(POI.lake.z - 44)) },
    { name: 'The ford', tag: 'Outer loop · north-east', title: 'The ford', desc: 'The trail crosses the stream: 30 cm of water over gravel. Keep it slow and steady.', ...trailSpot(POI.ford.x, POI.ford.z, 35) },
    { name: 'Ruined hut', tag: 'Outer loop · south', title: 'Ruined hut', desc: 'An old stone hut in the meadows, off the long southern straight.', ...trailSpot(POI.hut.x, POI.hut.z, 40) },
    { name: 'Old quarry', tag: 'South-west', title: 'Old quarry', desc: 'A gravel pit with terraced walls. Loose ground, room to play.', x: POI.quarry.x + 10, z: POI.quarry.z + 6, yaw: Math.PI / 2 },
    { name: 'Lookout', tag: 'Peak · spiral spur', title: 'Lookout summit', desc: 'The top of the spiral track: the whole map and the ranges beyond.', ...trailSpot(POI.lookout.x, POI.lookout.z, 14) },
    { name: 'Pine forest', tag: 'Outer loop · north', title: 'Pine forest', desc: 'The trail through the dense northern forest. Lovely with the headlights at night.', ...trailSpot(POI.forest.x, POI.forest.z, 0) },
  ];
  const placeVehicle = (x, z, yaw, lift = 0.5) => {
    let y = terrain.heightAt(x, z);
    for (const dx of [-1.5, 1.5]) for (const dz of [-2.2, 2.2]) y = Math.max(y, terrain.heightAt(x + dx, z + dz));
    trees.updatePhysics(x, z);
    props.userData.stream.update(x, z);
    world.step();   // scene queries see the streamed colliders only after a step
    vehicle.reset({ x, y: y + lift + rideRaise(vehicle.P), z }, yaw);
    prevPos.copy(vehicle.pos); curPos.copy(vehicle.pos); prevQ.copy(vehicle.quat); curQ.copy(vehicle.quat);
    rig.first = true;
    game.redraw = 3;
  };

  const game = { gunnery, scenery, grass, trees, water, undergrowth, props, terrainView, pipeline, bloom: pipeline.params, tracks, dust, RAPIER, world, terrain, vehicle, model, view, rig, env, input, hud, audio, settings, renderer, scene, camera, placeVehicle, teleports, tuning, colliderView, touch, paused: false, redraw: 0, stepsPerFrame: 0, autopilot: null, loadLog, THREE };
  window.game = game;

  // drive with friends (invite links, peer to peer); the menu's Friends tab
  const mp = new Multiplayer({
    RAPIER, world, scene, vehicle, view, settings,
    say: (key, html, kind) => hud.toast(html, { kind, key }),
    placeNear: (x, z, yaw) => placeVehicle(x, z, yaw),
    friendShots: (p, n) => gunnery?.friendShots(p.model, p.proxy, n),
    changed: () => { if (menu.isOpen) menu.refresh(); },
  });
  game.mp = mp;

  // ---------------------------------------------------------------- graphics quality
  // preset (auto picks one from the GPU) or 'custom' (the g* settings) + resolution scale; applied live
  const gfx = { auto: autoQuality(renderer), preset: null, q: null, dyn: 1 };
  const _db = new THREE.Vector2();
  const GFX_KEYS = Object.keys(presetToGfx(QUALITY.high));
  function applyGraphics() {
    const sel = settings.get('quality');
    let q;
    if (sel === 'custom') {
      q = gfxToQuality(settings.all);
      gfx.preset = 'custom';
    } else {
      const name = sel === 'auto' ? gfx.auto.preset : sel;
      q = QUALITY[name] || QUALITY.high;
      gfx.preset = name;
      // show the preset's values in the per-option controls
      const g = presetToGfx(q);
      for (const k of GFX_KEYS) settings.set(k, g[k], { silent: true, sync: true });
      // grass and bushes are the player's switch, except Mobile turns them off (turning them on makes it Custom)
      if (q.vegetation === false) settings.set('vegetation', false, { silent: true, sync: true });
    }
    q = { ...q, vegetation: settings.get('vegetation') };
    gfx.q = q;
    pipeline.configure({ msaa: q.msaa >= 2 ? 4 : 0, aa: q.msaa ? 'off' : q.aa || (q.fxaa ? 'fxaa' : 'off'), ssao: q.ssao });
    pipeline.params.bloom = q.bloom !== false;
    applyResolution();
    env.shadows.configure(SHADOWS[q.shadows]);
    scenery.configure(q);
    game.redraw = 3;
  }
  // pixel ratio and buffer sizes only (window resize, dynamic resolution)
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
  // Dynamic resolution (presets with dynamicDpr: Mobile). It starts at 100 % pixel density so the first
  // seconds are smooth, then steps by 12.5 % every few seconds: up while the game holds ~60 fps, down below
  // 45. A step up that drops it under 50 fps goes back and that level is not tried again for a minute.
  // Only the frame rate is measured (no test scene, nothing for the player to wait for).
  const dynRes = { t: 0, n: 0, skip: 1, ceil: Infinity, ceilUntil: 0, raised: false };
  const DYN_STEP = 0.125, DYN_MIN = 1;
  function updateDynamicResolution(dt, paused) {
    const q = gfx.q, R = dynRes;
    if (!q?.dynamicDpr || paused || document.hidden || (window.devicePixelRatio || 1) <= DYN_MIN) { R.t = R.n = 0; return; }
    R.t += dt; R.n++;
    if (R.t < 2.5) return;
    const fps = R.n / R.t, now = performance.now();
    R.t = R.n = 0;
    if (R.skip > 0) { R.skip--; return; }               // the window right after a change holds its hitch
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
  game.gfx = gfx;
  game.applyGraphics = applyGraphics;
  game.dynRes = dynRes; game.updateDynamicResolution = updateDynamicResolution;   // console / tests

  // ---------------------------------------------------------------- settings -> game
  // Every persisted setting is applied here, whether it came from a key, the menu or startup.
  // opts.silent: no toast (startup, and changes made in the menu where the control shows the state).
  // toasts with the same key replace each other instead of stacking (key null: no grouping)
  const say = (key, html, kind = '', t) => hud.toast(html, { kind, t, key: key || html });
  const k = id => capsHTML(id, input.device);
  const setHeadlights = (h, silent) => {
    view.lights.head = h;
    if (!silent) say('head', ['Headlights off', 'Low beam', 'High beam'][h]);
  };
  // automatic headlights when it gets dark (env.night has hysteresis, so this fires once per crossing)
  env.onNightChange = night => { if (night && view.lights.head === 0) setHeadlights(1, true); };
  const TIME_NAMES = { day: 'Day', dusk: 'Dusk', night: 'Night' };
  const quickTime = h => QUICK_ORDER.find(q => Math.abs(QUICK_HOURS[q] - h) < 0.01);
  const APPLY = {
    car(v, o) { if (!o.silent) location.reload(); },
    gearbox(v, o) { if (d.gearboxSetting !== v) { d.setGearbox(v); if (o.silent) d.message = null; } },
    autoClutch(v, o) { if (d.clutchAssist !== v) { d.toggleClutchAssist(); if (o.silent) d.message = null; } },
    arcadeAuto(v, o) {
      vehicle.arcadeAuto = v; vehicle.revTimer = 0;
      if (!o.silent) say('arcade', v ? 'Arcade automatic: hold brake at a stop to reverse' : 'Realistic automatic: select R to reverse');
    },
    handbrake(v, o) {
      vehicle.hbMode = v; vehicle.hbLatched = false;
      if (!o.silent) say('hb', { hold: 'Handbrake: hold the key', toggle: 'Handbrake: press on, press off', auto: 'Handbrake: tap toggles, long press holds' }[v]);
    },
    steerAssist(v, o) {
      vehicle.steerAssist = v;
      if (!o.silent) say('steerAssist', { strong: 'Keyboard steering: strong assist', light: 'Keyboard steering: light assist', off: 'Keyboard steering: no assist, full lock at any speed' }[v]);
    },
    fov(v) { rig.fov = v; game.redraw = 3; },
    camera(v, o) {
      if (!camModes.includes(v)) v = 'chase';   // the gunner's sight on a car without a turret
      rig.setMode(v);
      if (v !== 'gunner' && document.pointerLockElement) document.exitPointerLock?.();
      if (!o.silent) say('camera', v === 'gunner' && input.device !== 'touch' && input.device !== 'pad' ? `${CAM_NAMES[v]} · click in it to aim with the mouse` : CAM_NAMES[v]);
    },
    // the hour follows at once (menu slider, startup); the N key asks for the 2.5 s sweep
    time(v, o) {
      env.setHour(v, { instant: !o.animate });
      if (o.startup) env.flush();
      if (!o.silent) say('time', TIME_NAMES[quickTime(v)] || env.hourText);
    },
    muted(v, o) { audio.setMuted(v); refreshSound(); if (!o.silent) say('sound', v ? `Sound off · ${k('mute')} turns it on` : 'Sound on'); },
    volume(v) { audio.setVolume(v); },
    quality: () => applyGraphics(),
    ...Object.fromEntries(GFX_KEYS.map(key => [key, (v, o) => {
      if (o.sync || o.startup || o.reset) return;
      if (settings.get('quality') !== 'custom') settings.set('quality', 'custom', { silent: true }); else applyGraphics();
    }])),
    renderScale: () => applyGraphics(),
    vegetation(v, o) {
      if (o.sync) return;
      if (v && !o.startup && !o.reset && gfx.preset === 'mobile') settings.set('quality', 'custom', { silent: true });
      else applyGraphics();
    },
    solidTrucks: () => mp.setSolid(),
    dust: v => dust.setEnabled(v),
    touchControls: v => touch.configure({ mode: v }),
    touchSteer: v => touch.configure({ steer: v }),
    speedUnit: hudOpt, pressureUnit: hudOpt, cluster: hudOpt, hudScale: hudOpt, hints: hudOpt, suspension: hudOpt, telemetry: hudOpt, fps: hudOpt,
  };
  function hudOpt(v, o, key) { hud.configure({ [key]: v }); }
  settings.onChange((key, v, o) => {
    if (APPLY[key]) APPLY[key](v, o, key);
    tuning.dirty = true;
    game.redraw = 3;
  });

  // ---------------------------------------------------------------- actions (keys, pad, menu)
  const changePressure = delta => {
    const before = vehicle.pressure;
    vehicle.setPressure(before + delta);
    const p = vehicle.pressure, u = settings.get('pressureUnit');
    if (p === before) { say('pressure', `Tyres at the ${delta < 0 ? 'minimum' : 'maximum'}: ${fmtPressure(p, u)}`, 'warn'); return; }
    const note = p <= 14 ? ' · aired down: big footprint, more grip off-road' : p >= 32 ? ' · road pressure: firm, less grip on loose ground' : '';
    say('pressure', `Tyres ${fmtPressure(p, u)}${note}`);
  };
  const recover = () => {
    placeVehicle(vehicle.pos.x, vehicle.pos.z, vehicle.yaw(), 1.0);
    say('place', 'Recovered', 'good');
  };
  const teleport = i => {
    const t = teleports[i];
    if (!t) return;
    placeVehicle(t.x, t.z, t.yaw);
    say('place', escapeHTML(t.title), 'good');
  };
  const nearestLocation = () => {
    let best = -1, bd = 25 * 25;
    teleports.forEach((t, i) => { const dd = (t.x - vehicle.pos.x) ** 2 + (t.z - vehicle.pos.z) ** 2; if (dd < bd) { bd = dd; best = i; } });
    return best;
  };
  const next = (list, cur) => list[(list.indexOf(cur) + 1) % list.length];
  const toggle = key => settings.set(key, !settings.get(key));

  const ACTIONS = {
    shiftUp: () => d.requestShift(1),
    shiftDown: () => d.requestShift(-1),
    gearbox: () => settings.set('gearbox', d.gearboxSetting === 'auto' ? 'manual' : 'auto'),
    autoClutch: () => (d.mode === 'auto' ? toggle('arcadeAuto') : settings.set('autoClutch', !d.clutchAssist)),
    range: () => d.toggleRange(vehicle.speed),
    centreLock: () => d.toggleCenterLock(),
    lockers: () => d.cycleAxleLockers(),
    traction: () => { vehicle.tc = !vehicle.tc; say('tc', vehicle.tc ? 'Traction control on' : 'Traction control off: open diffs spin the lightest wheel'); },
    abs: () => { vehicle.abs = !vehicle.abs; say('abs', vehicle.abs ? 'ABS on' : 'ABS off: hard braking locks the wheels'); },
    rwd: () => d.toggleRwd(vehicle.speed),
    engineStart: () => d.startEngine(),
    engineStop: () => {
      if (!d.running && !d.cranking) { say('engine', `Engine is already off · ${k('engineStart')} starts it`); return; }
      d.stopEngine(); say('engine', 'Engine off');
    },
    pressureDown: () => changePressure(-2),
    pressureUp: () => changePressure(2),
    headlights: () => setHeadlights((view.lights.head + 1) % 3),
    lightBar: () => { view.lights.bar = !view.lights.bar; say('bar', view.lights.bar ? 'Light bar on' : 'Light bar off'); },
    hazards: () => { view.lights.hazard = !view.lights.hazard; say('haz', view.lights.hazard ? 'Hazard lights on' : 'Hazard lights off'); },
    recover,
    camera: () => settings.set('camera', next(camModes, rig.mode)),
    // turret vehicles: the gunner's sight on / off (back to the last other camera), switch guns
    gunner: () => {
      if (!vehicle.turret) return;
      if (rig.mode === 'gunner') settings.set('camera', rig.lastMode && rig.lastMode !== 'gunner' ? rig.lastMode : 'chase');
      else { rig.lastMode = rig.mode; settings.set('camera', 'gunner'); }
    },
    weapon: () => {
      const T = vehicle.turret;
      if (!T) return;
      T.select((T.weapon + 1) % T.spec.weapons.length);
      say('weapon', T.w.name, 'good');
    },
    time: () => {
      // day -> dusk -> night -> day, from wherever the slider is: the next quick hour after the current one
      const h = settings.get('time');
      const q = QUICK_ORDER.find(n => QUICK_HOURS[n] > h + 0.01) || QUICK_ORDER[0];
      settings.set('time', QUICK_HOURS[q], { animate: true });
    },
    menu: () => menu.open(),
    locations: () => menu.open('locations'),
    controls: () => menu.open('controls'),
    mute: () => toggle('muted'),
    suspension: () => toggle('suspension'),
    telemetry: () => toggle('telemetry'),
    tuning: () => tuning.toggle(),
  };
  input.onAction = id => { if (ACTIONS[id]) ACTIONS[id](); };
  game.action = id => input.onAction(id);

  // ---------------------------------------------------------------- pause menu + welcome card
  function setPaused(p) {
    if (game.paused === p) return;
    game.paused = p;
    document.body.classList.toggle('paused', p);
    audio.setPaused(p);
    input.reset();
    touch.release();
    input.uiHandler = p ? ev => menu.handle(ev) : null;
    game.redraw = 3;
  }
  const menu = new Menu({
    locations: teleports,
    device: () => input.device,
    get(key) {
      switch (key) {
        case 'gearbox': return d.gearboxSetting;
        case 'autoClutch': return d.clutchAssist;
        case 'arcadeAuto': return !!settings.get('arcadeAuto');
        case 'camera': return rig.mode;
        case 'timeQuick': return quickTime(settings.get('time')) || '';
        case 'sound': return !settings.get('muted');
        case 'pressureText': return fmtPressure(vehicle.pressure, settings.get('pressureUnit'));
        case 'headlights': return view.lights.head;
        case 'lightBar': return view.lights.bar;
        case 'hazards': return view.lights.hazard;
        case 'here': return nearestLocation();
        case 'mpNote': return mp.note;
        case 'name': return mp.name;
        case 'qualityNote': {
          const sel = settings.get('quality'), auto = QUALITY[gfx.auto.preset].label;
          const dyn = gfx.q?.dynamicDpr ? ` Pixel density adjusts itself between 100 and 150 % to hold 45–60 fps (now ${Math.round(Math.min(gfx.dyn, window.devicePixelRatio || 1) * 100)} %).` : '';
          return (sel === 'auto' ? `Auto: ${auto} for this ${gfx.auto.preset === 'mobile' ? 'device' : 'graphics chip'}.` : sel === 'custom' ? `Custom: your own settings below. Auto would pick ${auto}.` : `Auto would pick ${auto} here.`) + dyn;
        }
        default: return settings.get(key);
      }
    },
    set(key, v) {
      const silent = { silent: true };
      if (key === 'sound') settings.set('muted', !v, silent);
      else if (key === 'headlights') setHeadlights(v, true);
      else if (key === 'lightBar') view.lights.bar = !!v;
      else if (key === 'hazards') view.lights.hazard = !!v;
      else if (key === 'timeQuick') settings.set('time', QUICK_HOURS[v], silent);
      else if (key === 'resetSettings') { settings.reset(); applyGraphics(); }
      else settings.set(key, v, silent);
      game.redraw = 3;
    },
    action(id) {
      // menu buttons: the menu shows the result itself, so no toasts
      if (id === 'pressureDown' || id === 'pressureUp') vehicle.setPressure(vehicle.pressure + (id === 'pressureDown' ? -2 : 2));
      else if (id === 'mpInvite') mp.invite().then(() => menu.isOpen && menu.refresh());
      else if (id === 'mpGoto') { if (mp.count) menu.close(); mp.gotoFriend(); }
      else if (id === 'mpLeave') mp.leave();
      else if (id === 'mpName') mp.rename();
      game.redraw = 3;
    },
    teleport,
    recover,
    // the car is built at startup: save the choice and start again with it
    applyCar(c) { settings.set('car', c, { silent: true }); location.reload(); },
    onPause: setPaused,
    introDone: () => { settings.introSeen = true; },
  });
  game.menu = menu;
  Object.assign(tuningApi, { vehicle, settings, colliderView, action: id => input.onAction(id), toast: (html, kind, key) => say(key, html, kind), redraw: () => { game.redraw = 3; } });
  colliderView.setEnabled(!!tuning.state.ui.overlay);
  game.setPaused = setPaused;
  hud.onMenu = () => menu.open();
  hud.onFullscreen = () => menu.runAction('fullscreen');

  // pause when the window loses focus (setting), so the truck doesn't roll away unattended
  let started = false;
  const autoPause = () => { if (started && settings.get('autoPause') && !menu.blocking) menu.open(); };
  window.addEventListener('blur', autoPause);
  document.addEventListener('visibilitychange', () => { if (document.hidden) autoPause(); });

  // ---------------------------------------------------------------- input devices
  input.onDevice = dev => { hud.setDevice(dev); touch.setDevice(dev); menu.renderDevice(); };
  window.addEventListener('gamepadconnected', e => {
    say('pad', `Controller connected · ${capsHTML('menu', 'pad')} menu`, 'good', 3.5);
    console.info('gamepad', e.gamepad.id, e.gamepad.mapping || '(non-standard mapping)');
  });
  window.addEventListener('gamepaddisconnected', () => { say('pad', 'Controller disconnected', 'warn', 3.5); input.setDevice('kb'); });

  // ---------------------------------------------------------------- sound (needs a user gesture)
  let audioFailed = false, audioPending = null;
  function refreshSound() {
    hud.setSound(audioFailed ? 'error' : settings.get('muted') ? 'muted' : audio.ready && audio.state === 'running' ? 'on' : 'locked');
  }
  function unlockAudio() {
    if (audioFailed || audioPending || (audio.ready && audio.state === 'running')) return;
    audioPending = audio.start()
      .then(() => {
        if (!audio.hooked && audio.ctx) { audio.hooked = true; audio.ctx.addEventListener('statechange', refreshSound); }
      })
      .catch(e => { console.warn('audio', e); audioFailed = true; })
      .finally(() => { audioPending = null; refreshSound(); });
  }
  for (const ev of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(ev, unlockAudio, true);
  // start right away where the browser says sound may play without a gesture (no console warning otherwise)
  if (navigator.getAutoplayPolicy?.('audiocontext') === 'allowed' || navigator.userActivation?.hasBeenActive) unlockAudio();

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    applyGraphics();
  });

  // ---------------------------------------------------------------- frame
  let acc = 0;
  // one frame of the game; also callable from the console for testing (game.tick(1/60))
  function tick(dt, render = true) {
    const T = game.timings || (game.timings = {});
    let tm = performance.now();
    const mark = key => { const n = performance.now(); T[key] = (T[key] || 0) * 0.9 + (n - tm) * 0.1; tm = n; };
    touch.update(dt, vehicle, view);
    input.update(dt);
    const gunnerView = rig.mode === 'gunner' && !!vehicle.turret;
    input.gunner = gunnerView;
    input.turret = !!vehicle.turret;
    const raw = game.autopilot ? game.autopilot(vehicle, dt) : input.raw;
    const paused = game.paused;
    const now = performance.now() / 1000;
    // in the sight the mouse turns the turret like the gunner's hand wheels (px -> rad by the field of view)
    if (gunnerView && !paused) {
      const k = (rig.gunnerFov * Math.PI / 180) / window.innerHeight;
      vehicle.turret.aim(input.mouse.dx * k, -input.mouse.dy * k, 0, 0, 0);
    }

    if (!paused) {
      acc += dt;
      let steps = 0;
      while (acc >= H && steps < MAX_STEPS) {
        prevPos.copy(curPos); prevQ.copy(curQ);
        mp.stepBodies(now - (acc - H), H);   // friends' solid trucks at this step's instant
        if (gunnery) {
          vehicle.turret.aim(0, 0, raw.aimX || 0, raw.aimY || 0, H);
          gunnery.step(H, !!raw.fire);
        }
        vehicle.step(H, raw);
        world.step();
        const t = vehicle.body.translation(), q = vehicle.body.rotation();
        curPos.set(t.x, t.y, t.z); curQ.set(q.x, q.y, q.z, q.w);
        trees.updatePhysics(t.x, t.z);
        props.userData.stream.update(t.x, t.z);
        tracks.stamp(vehicle, H);
        acc -= H;
        steps++;
      }
      if (steps === MAX_STEPS) acc = 0;
      game.stepsPerFrame = steps;
      // fell off the world
      if (curPos.y < -60) { placeVehicle(SPAWN.x, SPAWN.z, 0); say('place', 'Fell off the map: back at the spawn', 'warn'); }
    }
    mark('physics');
    mp.update(paused ? 0 : dt, now - acc, { night: env.night, darkness: env.darkness, shadows: true });
    // paused: render only when something changed (setting, resize, time-of-day blend), the menu covers the view
    const draw = !paused || game.redraw > 0 || env.active;
    if (game.redraw > 0) game.redraw--;
    if (draw) {
      const alpha = acc / H;
      rPos.lerpVectors(prevPos, curPos, alpha);
      rQ.slerpQuaternions(prevQ, curQ, alpha);
      view.update(rPos, rQ, paused ? 0 : dt, { night: env.night, darkness: env.darkness, shadows: true });
      colliderView.update();
      rig.update(dt, input, rPos, rQ, vehicle, model);
      mp.updateTags(camera);
      env.update(dt, rPos, camera);
      // the wheels and the body push the grass aside
      const pushers = vehicle.wheels.map(w => ({ x: w.P.x, y: w.P.y, z: w.P.z, r: w.contact ? 0.85 : 0 }));
      pushers.push({ x: rPos.x, y: rPos.y, z: rPos.z, r: 1.7 });
      grass.setPushers(pushers);
      scenery.update(dt, camera, rPos);
    }
    mark('view');
    if (!paused && dust.enabled) {
      dust.spawnFromVehicle(vehicle, dt);
      dust.update(dt, 1 - 0.88 * env.darkness);
    }
    if (gunnery && draw) gunnery.update(paused ? 0 : dt, camera, 1 - 0.85 * env.darkness, env.darkness);
    audio.listener = camera.position;
    mark('dust');
    audio.update(dt, vehicle, { cockpit: rig.mode === 'cockpit' });
    mark('audio');
    hud.update(dt, vehicle, view, {
      cam: rig.mode, paused, raw,
      gun: gunnery ? { gunnery, sight: gunnerView, fov: rig.gunnerFov, locked: !!document.pointerLockElement } : null,
      telemetry: () => `steps/frame ${game.stepsPerFrame}  cam ${rig.mode}  time ${env.hourText}\npos ${vehicle.pos.x.toFixed(1)} ${vehicle.pos.y.toFixed(1)} ${vehicle.pos.z.toFixed(1)}`,
    });
    tuning.update(dt, vehicle, raw);
    mark('hud');
    if (draw && render) pipeline.render(paused ? 1 / 60 : dt);
    mark('render');
    updateDynamicResolution(dt, paused);
    input.endFrame();
  }
  game.tick = tick;

  // apply the saved settings without toasts, then warm up the shaders behind the loading screen
  settings.applyAll({ startup: true });
  refreshSound();

  // compile for the pipeline's HDR target: the program variant depends on the output colour space
  // (compiling for the canvas gave sRGB-output programs that are never used)
  // compile for the pipeline's scene target: the pipeline state depends on its format and sample count
  const compileScene = () => {
    const prev = renderer.getRenderTarget();
    const sp = pipeline.scenePass;
    if (sp) { sp.setSize(_db.x || 1, _db.y || 1); renderer.setRenderTarget(sp.renderTarget); }
    const p = renderer.compileAsync(scene, camera);
    renderer.setRenderTarget(prev);
    return p;
  };
  setLoading('Compiling shaders…', 0.86); await frame();
  // Warm-up behind the loading screen: the pipelines for the scene as it is now (the lamps' visibility is
  // part of every lit material's variant), then one real frame (post passes, shadow passes, eye adaptation).
  // The other lamp state (night with lamps / day without) is compiled in the background once the game runs,
  // so the first dusk does not stall. compileAsync builds the shaders synchronously and the GPU pipelines
  // asynchronously, so the lamps can be put back right after the call.
  try {
    tick(1 / 60, false);
    await Promise.race([compileScene(), new Promise(r => setTimeout(r, 8000))]);
    loadLog.push(['compiled', Math.round(performance.now())]);
    // the eye-adaptation pass only runs at dusk and night: draw it once here too
    const pp = pipeline.params, ae = pp.autoExposure, au = pp.auto;
    pp.autoExposure = true; pp.auto = 0.5;
    pipeline.render(1 / 60);
    pp.autoExposure = ae; pp.auto = au;
    pipeline.resetExposure = true;
    loadLog.push(['first frame', Math.round(performance.now())]);
  } catch (e) { console.warn('shader warm-up', e); }
  tick(1 / 60);
  const warmOtherLamps = () => {
    const ls = view.lights, head = ls.head, bar = ls.bar, night = env.night;
    if (!night) { ls.head = 1; ls.bar = true; }
    view.update(rPos, rQ, 0, { night: !night, darkness: night ? 0 : 1, shadows: true });
    compileScene().catch(e => console.warn('background warm-up', e));
    ls.head = head; ls.bar = bar;
    view.update(rPos, rQ, 0, { night, darkness: env.darkness, shadows: true });
  };
  (window.requestIdleCallback || (f => setTimeout(f, 1500)))(warmOtherLamps, { timeout: 4000 });

  setLoading('Ready', 1); await frame();
  loading.classList.add('done');
  setTimeout(() => loading.remove(), 600);
  started = true;

  // opened from an invite link: join the room and drive next to the first friend we hear from
  const inviteRoom = roomFromURL();
  if (inviteRoom) mp.join(inviteRoom, { follow: true }).then(() => say('mp', 'Joining your friends…', 'good', 4), e => { console.warn(e); say('mp', 'Could not join the room', 'warn'); });

  if (!settings.introSeen) menu.openIntro();
  else say('welcome', `${escapeHTML(CARS[car]?.label || 'Offroad')} · ${d.gearboxSetting === 'auto' ? (vehicle.P.manualOnly ? 'auto-shift' : 'automatic') : 'manual'} · ${input.device === 'touch' ? 'Menu at the top left' : `${k('menu')} menu · ${k('controls')} controls`}`, '', 5);

  let last = performance.now();
  function loop(now) {
    requestAnimationFrame(loop);
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.1) dt = 0.1;
    if (dt <= 0) return;
    tick(dt);
  }
  requestAnimationFrame(loop);
}

main().catch(showError);
