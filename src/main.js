import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { installShaderPatches } from './render/shaderPatches.js';
import { RenderPipeline } from './render/pipeline.js';
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
import { buildCarModel } from './vehicle/model/index.js';
import { makeCarParams } from './vehicle/carParams.js';
import { carDef } from './cars/index.js';
import { VehicleView } from './vehicle/vehicleView.js';
import { missingControls } from './vehicle/controls.js';
import { CameraRig, CAM_NAMES, camModesFor } from './cameraRig.js';
import { Turret } from './vehicle/turret.js';
import { Gunnery } from './weapons.js';
import { Input, setCarControls, hasControl, capsHTML } from './input.js';
import { TouchControls } from './touch.js';
import { HUD, fmtPressure, escapeHTML } from './hud.js';
import { Menu } from './menu.js';
import { Settings, storage } from './settings.js';
import { GameAudio } from './audio/audio.js';
import { Dust, Tracks } from './effects.js';
import { Multiplayer, roomFromURL } from './multiplayer.js';
import './ui.css';

installShaderPatches();     // before any material compiles

const H = 1 / 240;          // physics step
const MAX_STEPS = 16;

// ---------------------------------------------------------------- loading screen
const loading = document.getElementById('loading');
const loadLog = [];   // [stage, ms since navigation]
const setLoading = (text, p) => {
  loadLog.push([text, Math.round(performance.now())]);
  loading.querySelector('.ld-t').textContent = text;
  if (p !== undefined) loading.style.setProperty('--p', p);
};
// Yield so the loading text can paint; the timeout keeps loading going in a hidden tab (rAF throttled)
const frame = () => new Promise(r => {
  let done = false;
  const go = () => { if (!done) { done = true; r(); } };
  requestAnimationFrame(() => setTimeout(go, 0));
  setTimeout(go, 60);
});
function showError(e) {
  console.error(e);
  const msg = String(e && e.message || e);
  const webgl = /webgl|context/i.test(msg);
  loading.classList.remove('done');
  loading.classList.add('error');
  setLoading('Could not start the game');
  const box = loading.querySelector('.ld-err');
  box.hidden = false;
  box.innerHTML = (webgl
    ? 'WebGL is not available. Turn on hardware acceleration in the browser settings, or try another browser.'
    : escapeHTML(msg)) + '<br><button type="button">Reload</button>';
  box.querySelector('button').addEventListener('click', () => location.reload());
}

async function main() {
  setLoading('Starting physics…', 0.08); await frame();
  await RAPIER.init();

  const canvas = document.getElementById('c');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.NoToneMapping;     // done in the pipeline's composite pass
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 6000);
  const pipeline = new RenderPipeline(renderer, scene, camera);

  setLoading('Generating terrain…', 0.2); await frame();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = H;
  const terrain = new Terrain(7);
  terrain.createCollider(RAPIER, world);
  const scenery = { parts: [], configure(q) { for (const p of this.parts) p.configure?.(q); }, update(dt, cam, focus) { for (const p of this.parts) p.update?.(dt, cam, focus); } };
  const env = new Environment(renderer, scene, pipeline);
  setLoading('Painting the ground…', 0.4); await frame();
  const terrainView = buildTerrainView(terrain, renderer, { noise: env.sky.noise });
  scene.add(terrainView.mesh);
  scenery.parts.push(terrainView);
  const grass = buildGrass(terrainView);
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
  const undergrowth = buildUndergrowth(terrainView, trees.atlas, grass.shared.uWind);
  scene.add(undergrowth.group);
  scenery.parts.push(undergrowth);
  trees.updatePhysics(SPAWN.x, SPAWN.z);

  setLoading('Building the truck…', 0.68); await frame();
  const settings = new Settings();
  const car = settings.get('car');
  useCar(car);   // before the panel is built: stock, ranges and saved setups are per car
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
  if (P.turret && model.turret) vehicle.turret = new Turret(P.turret);
  const view = new VehicleView(model, vehicle);
  const colliderView = new ColliderView(scene, model, vehicle);
  const d = vehicle.drivetrain;


  setCarControls(missingControls(vehicle, model));   // before the HUD, touch and menu list controls

  const rig = new CameraRig(camera, terrain);
  if (model.chaseDist) rig.dist = model.chaseDist;
  const input = new Input(canvas);
  const hud = new HUD();
  const touch = new TouchControls({ input, canvas, hud, action: id => input.onAction(id) });
  hud.setDevice(input.device);
  const audio = new GameAudio();
  const dust = new Dust(scene);
  dust.waterAt = (x, z) => terrain.waterLevelAt(x, z);
  const gunnery = vehicle.turret ? new Gunnery({ RAPIER, world, scene, vehicle, model, terrain, surfaceAt, audio }) : null;
  const camModes = camModesFor(model);
  input.sightLock = () => { try { canvas.requestPointerLock?.()?.catch?.(() => {}); } catch { /* not allowed: drag to aim, Enter fires */ } };
  const tracks = new Tracks(terrainView.material);


  const prevPos = new THREE.Vector3().copy(vehicle.pos), curPos = new THREE.Vector3().copy(vehicle.pos);
  const prevQ = new THREE.Quaternion().copy(vehicle.quat), curQ = new THREE.Quaternion().copy(vehicle.quat);
  const rPos = new THREE.Vector3(), rQ = new THREE.Quaternion();

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
  // menu Locations tab (x, z, yaw also used by tools/browser-snippets.js)
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
  const streamAround = (x, z) => {
    trees.updatePhysics(x, z);
    props.userData.stream.update(x, z);
    world.step();   // queries see streamed colliders only after a step
  };
  const afterPlace = () => {
    prevPos.copy(vehicle.pos); curPos.copy(vehicle.pos); prevQ.copy(vehicle.quat); curQ.copy(vehicle.quat);
    rig.first = true;
    game.redraw = 3;
  };
  const placeVehicle = (x, z, yaw, lift = 0.5) => {
    let y = terrain.heightAt(x, z);
    for (const dx of [-1.5, 1.5]) for (const dz of [-2.2, 2.2]) y = Math.max(y, terrain.heightAt(x + dx, z + dz));
    streamAround(x, z);
    vehicle.reset({ x, y: y + lift + rideRaise(vehicle.P), z }, yaw);
    afterPlace();
  };

  // How the truck would stand at (x, z) facing yaw: tilted to a ground plane fitted under its wheels,
  // just above the tyres' touch (a bump under a wheel or the belly lifts it).
  const _sR = new THREE.Vector3(), _sB = new THREE.Vector3(), _sU = new THREE.Vector3(), _sM = new THREE.Matrix4();
  const standAt = (x, z, yaw) => {
    const P = vehicle.P, s = Math.sin(yaw), c = Math.cos(yaw), t2 = P.track / 2;
    const h = (lx, lz) => terrain.heightAt(x + lx * c + lz * s, z - lx * s + lz * c);
    // plane h = a + b * lx + d * lz: b from the side-to-side tilt of each axle, d from the axles' heights
    const ax = P.axles.map(a => ({ z: a.z, l: h(-t2, a.z), r: h(t2, a.z) }));
    const n = ax.length, mz = ax.reduce((m, a) => m + a.z, 0) / n, mh = ax.reduce((m, a) => m + (a.l + a.r) / 2, 0) / n;
    const b = ax.reduce((m, a) => m + (a.r - a.l) / P.track, 0) / n;
    let num = 0, den = 0;
    for (const a of ax) { num += (a.z - mz) * ((a.l + a.r) / 2 - mh); den += (a.z - mz) ** 2; }
    const d = den > 0 ? num / den : 0, a0 = mh - d * mz;
    const plane = (lx, lz) => a0 + b * lx + d * lz;
    // ground above the plane under a wheel would bury the tyre; under the belly it's fine up to ~25 cm
    let lift = 0, rough = 0;
    for (const a of ax) for (const [lx, gh] of [[-t2, a.l], [t2, a.r]]) { const r = gh - plane(lx, a.z); lift = Math.max(lift, r); rough = Math.max(rough, Math.abs(r)); }
    const zF = Math.min(...ax.map(a => a.z)), zB = Math.max(...ax.map(a => a.z));
    for (const [lx, lz] of [[0, 0], [0, zF], [0, zB], [-t2, 0], [t2, 0]]) {
      const r = h(lx, lz) - plane(lx, lz);
      lift = Math.max(lift, r - 0.25); rough = Math.max(rough, Math.abs(r));
    }
    _sR.set(c, b, -s).normalize(); _sB.set(s, d, c).normalize();
    _sU.crossVectors(_sB, _sR).normalize();
    _sR.addScaledVector(_sU, -_sR.dot(_sU)).normalize();
    _sB.crossVectors(_sR, _sU);
    const quat = new THREE.Quaternion().setFromRotationMatrix(_sM.makeBasis(_sR, _sU, _sB));
    const up = 0.12 + rideRaise(P) + 0.1 + lift;   // 0.12 + rideRaise = spawn height
    const pos = { x: x + _sU.x * up, y: a0 + _sU.y * up, z: z + _sU.z * up };
    return { pos, quat, ground: a0, slope: Math.acos(Math.min(1, _sU.y)) * 180 / Math.PI, rough };
  };

  const blocked = st => {
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (const [cx, cy, cz, hx, hy, hz] of vehicle.P.colliders) {
      x0 = Math.min(x0, cx - hx); x1 = Math.max(x1, cx + hx);
      y0 = Math.min(y0, cy - hy); y1 = Math.max(y1, cy + hy);
      z0 = Math.min(z0, cz - hz); z1 = Math.max(z1, cz + hz);
    }
    y0 += 0.3;
    const ctr = new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2).applyQuaternion(st.quat);
    const box = new RAPIER.Cuboid((x1 - x0) / 2, Math.max(0.1, (y1 - y0) / 2), (z1 - z0) / 2);
    return !!world.intersectionWithShape({ x: st.pos.x + ctr.x, y: st.pos.y + ctr.y, z: st.pos.z + ctr.z }, st.quat, box,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, vehicle.body);
  };

  // Recover: flattest clear spot within ~12 m, same heading, tilted to the slope and just above the
  // ground so it settles instead of dropping and rolling again.
  const RECOVER_RINGS = [[0, 1], [3, 8], [6, 12], [9, 16], [12, 20]];
  const recoverSpot = () => {
    const x = vehicle.pos.x, z = vehicle.pos.z, yaw = vehicle.yaw(), here = terrain.heightAt(x, z);
    streamAround(x, z);
    let best = null, bestScore = Infinity;
    for (const [r, n] of RECOVER_RINGS) for (let i = 0; i < n; i++) {
      const t = (i + 0.5 * (r / 3 % 2)) / n * Math.PI * 2;
      const st = standAt(x + Math.cos(t) * r, z + Math.sin(t) * r, yaw);
      const score = st.slope + st.rough * 20 + r * 0.5 + Math.abs(st.ground - here) * 1.5;
      if (score >= bestScore || blocked(st)) continue;
      best = st; bestScore = score;
    }
    return best;
  };
  const recover = () => {
    const st = recoverSpot();
    if (st) {
      streamAround(st.pos.x, st.pos.z);
      vehicle.reset(st.pos, 0, st.quat);
      afterPlace();
    } else placeVehicle(vehicle.pos.x, vehicle.pos.z, vehicle.yaw(), 1.0);
    say('place', 'Recovered', 'good');
  };

  const game = { gunnery, scenery, grass, trees, water, undergrowth, props, terrainView, pipeline, bloom: pipeline.params, tracks, dust, RAPIER, world, terrain, vehicle, model, view, rig, env, input, hud, audio, settings, renderer, scene, camera, placeVehicle, teleports, tuning, colliderView, touch, paused: false, redraw: 0, stepsPerFrame: 0, autopilot: null, loadLog, THREE };
  window.game = game;

  const mp = new Multiplayer({
    RAPIER, world, scene, vehicle, view, settings,
    say: (key, html, kind) => hud.toast(html, { kind, key }),
    placeNear: (x, z, yaw) => placeVehicle(x, z, yaw),
    friendShots: (p, n) => gunnery?.friendShots(p.model, p.proxy, n),
    changed: () => { if (menu.isOpen) menu.refresh(); },
  });
  game.mp = mp;

  // ---------------------------------------------------------------- graphics quality
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
      // new map size or atlas layout: drop the old depth atlas (rebuilt next frame)
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
    if (!tune.on || settings.get('quality') !== 'auto' || game.paused || document.hidden || !started) return;
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
    applyGraphics();
    if (next < i) saveAutoTune();
    say('quality', `Graphics: ${QUALITY[gfx.auto.preset].label}${next < i ? ' for a steadier frame rate' : ' (testing)'}`, '', 2.5);
  }
  startAutoTune(false);
  game.autoTune = tune;

  game.gfx = gfx;
  game.applyGraphics = applyGraphics;
  game.dynRes = dynRes; game.updateDynamicResolution = updateDynamicResolution;

  // ---------------------------------------------------------------- settings -> game
  // Every persisted setting is applied here (key, menu or startup). opts.silent: no toast.
  // Toasts with the same key replace each other (key null: no grouping).
  const say = (key, html, kind = '', t) => hud.toast(html, { kind, t, key: key || html });
  const k = id => capsHTML(id, input.device);
  const setHeadlights = (h, silent) => {
    view.lights.head = h;
    if (!silent) say('head', ['Headlights off', 'Low beam', 'High beam'][h]);
  };
  // auto headlights at dusk (env.night has hysteresis: fires once per crossing)
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
      if (!camModes.includes(v)) v = 'chase';   // gunner's sight on a car without a turret
      rig.setMode(v);
      if (v !== 'gunner' && document.pointerLockElement) document.exitPointerLock?.();
      if (!o.silent) say('camera', v === 'gunner' && input.device !== 'touch' && input.device !== 'pad' ? `${CAM_NAMES[v]} · click in it to aim with the mouse` : CAM_NAMES[v]);
    },
    // the hour follows at once; the N key asks for the 2.5 s sweep
    time(v, o) {
      env.setHour(v, { instant: !o.animate });
      if (o.startup) env.flush();
      if (!o.silent) say('time', TIME_NAMES[quickTime(v)] || env.hourText);
    },
    muted(v, o) { audio.setMuted(v); refreshSound(); if (!o.silent) say('sound', v ? `Sound off · ${k('mute')} turns it on` : 'Sound on'); },
    volume(v) { audio.setVolume(v); },
    quality(v, o) {
      if (v === 'auto' && !o.startup && !o.reset) startAutoTune(true);   // picked in the menu: re-measure
      applyGraphics();
    },
    ...Object.fromEntries(GFX_KEYS.map(key => [key, (v, o) => {
      if (o.sync || o.startup || o.reset) return;
      if (settings.get('quality') !== 'custom') settings.set('quality', 'custom', { silent: true }); else applyGraphics();
    }])),
    renderScale: () => applyGraphics(),
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
    auxLights: () => { view.lights.aux = !view.lights.aux; say('aux', view.lights.aux ? 'Extra lamps on' : 'Extra lamps off'); },
    hazards: () => { view.lights.hazard = !view.lights.hazard; say('haz', view.lights.hazard ? 'Hazard lights on' : 'Hazard lights off'); },
    recover,
    camera: () => settings.set('camera', next(camModes, rig.mode)),
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
  input.onAction = id => { if (ACTIONS[id] && hasControl(id)) ACTIONS[id](); };
  game.action = id => input.onAction(id);

  // ---------------------------------------------------------------- pause menu
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
        case 'auxLights': return view.lights.aux;
        case 'hazards': return view.lights.hazard;
        case 'here': return nearestLocation();
        case 'mpNote': return mp.note;
        case 'name': return mp.name;
        case 'qualityNote': {
          const sel = settings.get('quality'), auto = QUALITY[gfx.auto.preset].label;
          const dyn = gfx.q?.dynamicDpr ? ` Pixel density adjusts itself between 100 and 150 % to hold 45–60 fps (now ${Math.round(Math.min(gfx.dyn, window.devicePixelRatio || 1) * 100)} %).` : '';
          const how = gfx.auto.preset === 'mobile' ? 'for this device.' : tune.on ? 'measuring the frame rate while you drive…' : tune.measured ? 'measured on this computer. Pick another preset and Auto again to measure again.' : 'for this graphics chip.';
          return (sel === 'auto' ? `Auto: ${auto}, ${how}` : sel === 'custom' ? `Custom: your own settings below. Auto would pick ${auto}.` : `Auto would pick ${auto} here.`) + dyn;
        }
        default: return settings.get(key);
      }
    },
    set(key, v) {
      const silent = { silent: true };
      if (key === 'sound') settings.set('muted', !v, silent);
      else if (key === 'headlights') setHeadlights(v, true);
      else if (key === 'auxLights') view.lights.aux = !!v && model.lights.aux.length > 0;
      else if (key === 'hazards') view.lights.hazard = !!v;
      else if (key === 'timeQuick') settings.set('time', QUICK_HOURS[v], silent);
      else if (key === 'resetSettings') { settings.reset(); applyGraphics(); }
      else settings.set(key, v, silent);
      game.redraw = 3;
    },
    action(id) {
      if (id === 'pressureDown' || id === 'pressureUp') vehicle.setPressure(vehicle.pressure + (id === 'pressureDown' ? -2 : 2));
      else if (id === 'mpInvite') mp.invite().then(() => menu.isOpen && menu.refresh());
      else if (id === 'mpGoto') { if (mp.count) menu.close(); mp.gotoFriend(); }
      else if (id === 'mpLeave') mp.leave();
      else if (id === 'mpName') mp.rename();
      game.redraw = 3;
    },
    teleport,
    recover,
    applyCar(c) { settings.set('car', c, { silent: true }); location.reload(); },
    onPause: setPaused,
  });
  game.menu = menu;
  Object.assign(tuningApi, { vehicle, settings, colliderView, action: id => input.onAction(id), toast: (html, kind, key) => say(key, html, kind), redraw: () => { game.redraw = 3; } });
  colliderView.setEnabled(!!tuning.state.ui.overlay);
  game.setPaused = setPaused;
  hud.onMenu = () => menu.open();
  hud.onFullscreen = () => menu.runAction('fullscreen');

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
  if (navigator.getAutoplayPolicy?.('audiocontext') === 'allowed' || navigator.userActivation?.hasBeenActive) unlockAudio();

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    applyGraphics();
  });

  // ---------------------------------------------------------------- frame
  let acc = 0;
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
    // in the sight the mouse turns the turret (px -> rad by the field of view)
    if (gunnerView && !paused) {
      const k = (rig.gunnerFov * Math.PI / 180) / window.innerHeight;
      vehicle.turret.aim(input.mouse.dx * k, -input.mouse.dy * k, 0, 0, 0);
    }

    if (!paused) {
      acc += dt;
      let steps = 0;
      while (acc >= H && steps < MAX_STEPS) {
        prevPos.copy(curPos); prevQ.copy(curQ);
        mp.stepBodies(now - (acc - H), H);
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
      if (curPos.y < -60) { placeVehicle(SPAWN.x, SPAWN.z, 0); say('place', 'Fell off the map: back at the spawn', 'warn'); }
    }
    mark('physics');
    mp.update(paused ? 0 : dt, now - acc, { night: env.night, darkness: env.darkness, shadows: true });
    // paused: render only on change
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

  settings.applyAll({ startup: true });
  refreshSound();

  // compile for the HDR target: the program variant depends on the output colour space
  const compileScene = () => {
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(pipeline.hdr);
    const p = renderer.compileAsync(scene, camera);
    renderer.setRenderTarget(prev);
    return p;
  };
  setLoading('Compiling shaders…', 0.86); await frame();
  // Warm-up behind the loading screen. Lamps change the lights hash (shadow-casting head spot), so
  // first a frame with every lamp on (compile + a real draw that builds the pipeline states and lamp
  // shadow map; without it switching lamps on at night stalled ~200 ms), then the real state. The tick
  // without drawing comes first so the compile sees the lights as they are.
  try {
    const ls = view.lights, head = ls.head, aux = ls.aux;
    ls.head = 1; ls.aux = model.lights.aux.length > 0;
    tick(1 / 60, false);
    view.update(rPos, rQ, 0, { night: true, shadows: true });
    await Promise.race([compileScene(), new Promise(r => setTimeout(r, 6000))]);
    // the eye-adaptation pass only runs at dusk and night: compile it now
    const pp = pipeline.params, ae = pp.autoExposure, au = pp.auto;
    pp.autoExposure = true; pp.auto = 0.5;
    pipeline.render(1 / 60);
    pp.autoExposure = ae; pp.auto = au;
    pipeline.resetExposure = true;
    ls.head = head; ls.aux = aux;
    tick(1 / 60, false);
    await Promise.race([compileScene(), new Promise(r => setTimeout(r, 6000))]);
  } catch (e) { console.warn('shader warm-up', e); }
  tick(1 / 60);

  setLoading('Ready', 1); await frame();
  loading.classList.add('done');
  setTimeout(() => loading.remove(), 600);
  started = true;

  // invite link: join the room and drive next to the first friend heard
  const inviteRoom = roomFromURL();
  if (inviteRoom) mp.join(inviteRoom, { follow: true }).then(() => say('mp', 'Joining your friends…', 'good', 4), e => { console.warn(e); say('mp', 'Could not join the room', 'warn'); });

  say('welcome', `${escapeHTML(carDef(car).label)} · ${d.gearboxSetting === 'auto' ? (vehicle.P.manualOnly ? 'auto-shift' : 'automatic') : 'manual'} · ${input.device === 'touch' ? 'Menu at the top left' : `${k('menu')} menu · ${k('controls')} controls`}`, '', 5);

  let last = performance.now();
  function loop(now) {
    requestAnimationFrame(loop);
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.1) dt = 0.1;
    if (dt <= 0) return;
    updateAutoQuality(dt);
    tick(dt);
  }
  requestAnimationFrame(loop);
}

main().catch(showError);
