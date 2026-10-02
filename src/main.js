import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { installShaderPatches } from './render/shaderPatches.js';
import { RenderPipeline } from './render/pipeline.js';
import { QUALITY, autoQuality } from './render/quality.js';

import { Terrain, SPAWN, LANES, HILL, POI } from './world/terrain.js';
import { buildTerrainView } from './world/terrainView.js';
import { buildGrass } from './world/grass.js';
import { buildTrees } from './world/trees.js';
import { buildWater } from './world/water.js';
import { buildUndergrowth } from './world/undergrowth.js';
import { makeRockMaterial } from './world/materials.js';
import { buildProps } from './world/props.js';
import { Environment, TIME_ORDER } from './world/environment.js';
import { makeDefenderParams } from './vehicle/params.js';
import { Vehicle } from './vehicle/Vehicle.js';
import { buildTruck } from './vehicle/truckModel.js';
import { VehicleView } from './vehicle/vehicleView.js';
import { CameraRig, CAM_MODES, CAM_NAMES } from './cameraRig.js';
import { Input, capsHTML } from './input.js';
import { HUD, fmtPressure, escapeHTML } from './hud.js';
import { Menu } from './menu.js';
import { Settings } from './settings.js';
import { GameAudio } from './audio/audio.js';
import { Dust, Tracks } from './effects.js';
import './ui.css';

installShaderPatches();     // before any material compiles: atmosphere fog, light skipping

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
  // the scene renders into the pipeline's HDR target (MSAA there); the canvas only gets the final pass
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.NoToneMapping;     // tone mapping happens in the pipeline's composite pass
  renderer.outputColorSpace = THREE.SRGBColorSpace;

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
  const P = makeDefenderParams();
  const surfaceAt = (col, p) => (col && colliderSurface.get(col.handle)) || terrain.surfaceAt(p.x, p.z);
  const spawnY = terrain.heightAt(SPAWN.x, SPAWN.z) + 0.12;
  const vehicle = new Vehicle(RAPIER, world, P, { position: { x: SPAWN.x, y: spawnY, z: SPAWN.z }, yaw: SPAWN.yaw, surfaceAt });
  world.step();
  const model = buildTruck(P);
  scene.add(model.root);
  const view = new VehicleView(model, vehicle);
  const d = vehicle.drivetrain;


  const rig = new CameraRig(camera, terrain);
  const input = new Input(canvas);
  const hud = new HUD();
  const audio = new GameAudio();
  const settings = new Settings();
  const dust = new Dust(scene);
  dust.waterAt = (x, z) => terrain.waterLevelAt(x, z);
  const tracks = new Tracks(terrainView.material);


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
    vehicle.reset({ x, y: y + lift, z }, yaw);
    prevPos.copy(vehicle.pos); curPos.copy(vehicle.pos); prevQ.copy(vehicle.quat); curQ.copy(vehicle.quat);
    rig.first = true;
    game.redraw = 3;
  };

  const game = { scenery, grass, trees, water, undergrowth, props, terrainView, pipeline, bloom: pipeline.params, tracks, dust, RAPIER, world, terrain, vehicle, model, view, rig, env, input, hud, audio, settings, renderer, scene, camera, placeVehicle, teleports, paused: false, redraw: 0, stepsPerFrame: 0, autopilot: null, loadLog };
  window.game = game;

  // ---------------------------------------------------------------- graphics quality
  // preset (auto picks one from the GPU) + resolution scale; everything is applied live
  const gfx = { auto: autoQuality(renderer), preset: null, q: null };
  const _db = new THREE.Vector2();
  function applyGraphics() {
    const sel = settings.get('quality');
    const name = sel === 'auto' ? gfx.auto.preset : sel;
    const q = QUALITY[name] || QUALITY.high;
    gfx.preset = name; gfx.q = q;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.dpr) * settings.get('renderScale'));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.getDrawingBufferSize(_db);
    pipeline.configure({ msaa: q.msaa, fxaa: q.fxaa });
    pipeline.params.bloom = q.bloom !== false;
    pipeline.setSize(_db.x, _db.y);
    const sh = env.sun.shadow;
    if (sh.mapSize.x !== q.shadowMap) { sh.mapSize.set(q.shadowMap, q.shadowMap); if (sh.map) { sh.map.dispose(); sh.map = null; } }
    sh.camera.far = q.shadowFar;
    sh.radius = q.shadowRadius;
    scenery.configure(q);
    game.redraw = 3;
  }
  game.gfx = gfx;
  game.applyGraphics = applyGraphics;

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
  const APPLY = {
    gearbox(v, o) { if (d.mode !== v) { d.toggleMode(); if (o.silent) d.message = null; } },
    autoClutch(v, o) { if (d.clutchAssist !== v) { d.toggleClutchAssist(); if (o.silent) d.message = null; } },
    handbrake(v, o) {
      vehicle.hbMode = v; vehicle.hbLatched = false;
      if (!o.silent) say('hb', { hold: 'Handbrake: hold the key', toggle: 'Handbrake: press on, press off', auto: 'Handbrake: automatic at a stop' }[v]);
    },
    camera(v, o) { rig.setMode(v); if (!o.silent) say('camera', CAM_NAMES[v]); },
    time(v, o) {
      env.setMode(v);
      if (o.startup) { env.blend = 1; env.apply(1); }
      if (!o.silent) say('time', { day: 'Day', dusk: 'Dusk', night: 'Night' }[v]);
      if (v === 'night' && view.lights.head === 0) setHeadlights(1, true);
    },
    muted(v, o) { audio.setMuted(v); refreshSound(); if (!o.silent) say('sound', v ? `Sound off · ${k('mute')} turns it on` : 'Sound on'); },
    volume(v) { audio.setVolume(v); },
    quality: () => applyGraphics(),
    renderScale: () => applyGraphics(),
    speedUnit: hudOpt, pressureUnit: hudOpt, cluster: hudOpt, hudScale: hudOpt, hints: hudOpt, suspension: hudOpt, telemetry: hudOpt, fps: hudOpt,
  };
  function hudOpt(v, o, key) { hud.configure({ [key]: v }); }
  settings.onChange((key, v, o) => {
    if (APPLY[key]) APPLY[key](v, o, key);
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
    gearbox: () => settings.set('gearbox', d.mode === 'auto' ? 'manual' : 'auto'),
    autoClutch: () => settings.set('autoClutch', !d.clutchAssist),
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
    camera: () => settings.set('camera', next(CAM_MODES, rig.mode)),
    time: () => settings.set('time', next(TIME_ORDER, env.mode)),
    menu: () => menu.open(),
    locations: () => menu.open('locations'),
    controls: () => menu.open('controls'),
    mute: () => toggle('muted'),
    suspension: () => toggle('suspension'),
    telemetry: () => toggle('telemetry'),
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
    input.uiHandler = p ? ev => menu.handle(ev) : null;
    game.redraw = 3;
  }
  const menu = new Menu({
    locations: teleports,
    device: () => input.device,
    get(key) {
      switch (key) {
        case 'gearbox': return d.mode;
        case 'autoClutch': return d.clutchAssist;
        case 'camera': return rig.mode;
        case 'time': return env.mode;
        case 'sound': return !settings.get('muted');
        case 'pressureText': return fmtPressure(vehicle.pressure, settings.get('pressureUnit'));
        case 'headlights': return view.lights.head;
        case 'lightBar': return view.lights.bar;
        case 'hazards': return view.lights.hazard;
        case 'here': return nearestLocation();
        case 'qualityNote': return settings.get('quality') === 'auto' ? `Auto: ${QUALITY[gfx.auto.preset].label} for this graphics chip.` : `Auto would pick ${QUALITY[gfx.auto.preset].label} here.`;
        default: return settings.get(key);
      }
    },
    set(key, v) {
      const silent = { silent: true };
      if (key === 'sound') settings.set('muted', !v, silent);
      else if (key === 'headlights') setHeadlights(v, true);
      else if (key === 'lightBar') view.lights.bar = !!v;
      else if (key === 'hazards') view.lights.hazard = !!v;
      else if (key === 'resetSettings') settings.reset();
      else settings.set(key, v, silent);
      game.redraw = 3;
    },
    action(id) {
      // menu buttons: the menu shows the result itself, so no toasts
      if (id === 'pressureDown' || id === 'pressureUp') vehicle.setPressure(vehicle.pressure + (id === 'pressureDown' ? -2 : 2));
      game.redraw = 3;
    },
    teleport,
    recover,
    onPause: setPaused,
    introDone: () => { settings.introSeen = true; },
  });
  game.menu = menu;
  game.setPaused = setPaused;
  hud.onMenu = () => menu.open();

  // pause when the window loses focus (setting), so the truck doesn't roll away unattended
  let started = false;
  const autoPause = () => { if (started && settings.get('autoPause') && !menu.blocking) menu.open(); };
  window.addEventListener('blur', autoPause);
  document.addEventListener('visibilitychange', () => { if (document.hidden) autoPause(); });

  // ---------------------------------------------------------------- input devices
  input.onDevice = dev => { hud.setDevice(dev); menu.renderDevice(); };
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
    input.update(dt);
    const raw = game.autopilot ? game.autopilot(vehicle, dt) : input.raw;
    const paused = game.paused;

    if (!paused) {
      acc += dt;
      let steps = 0;
      while (acc >= H && steps < MAX_STEPS) {
        prevPos.copy(curPos); prevQ.copy(curQ);
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
    // paused: render only when something changed (setting, resize, time-of-day blend), the menu covers the view
    const draw = !paused || game.redraw > 0 || env.blend < 1;
    if (game.redraw > 0) game.redraw--;
    if (draw) {
      const alpha = acc / H;
      rPos.lerpVectors(prevPos, curPos, alpha);
      rQ.slerpQuaternions(prevQ, curQ, alpha);
      view.update(rPos, rQ, paused ? 0 : dt, { night: env.night, shadows: true });
      rig.update(dt, input, rPos, rQ, vehicle, model);
      env.update(dt, rPos, camera);
      // the wheels and the body push the grass aside
      const pushers = vehicle.wheels.map(w => ({ x: w.P.x, y: w.P.y, z: w.P.z, r: w.contact ? 0.85 : 0 }));
      pushers.push({ x: rPos.x, y: rPos.y, z: rPos.z, r: 1.7 });
      grass.setPushers(pushers);
      scenery.update(dt, camera, rPos);
    }
    mark('view');
    if (!paused) {
      dust.spawnFromVehicle(vehicle, dt);
      dust.update(dt, env.night ? 0.12 : env.mode === 'dusk' ? 0.7 : 1.0);
    }
    mark('dust');
    audio.update(dt, vehicle, { cockpit: rig.mode === 'cockpit' });
    mark('audio');
    hud.update(dt, vehicle, view, {
      cam: rig.mode, paused, raw,
      telemetry: () => `steps/frame ${game.stepsPerFrame}  cam ${rig.mode}  time ${env.mode}\npos ${vehicle.pos.x.toFixed(1)} ${vehicle.pos.y.toFixed(1)} ${vehicle.pos.z.toFixed(1)}`,
    });
    mark('hud');
    if (draw && render) pipeline.render(paused ? 1 / 60 : dt);
    mark('render');
    input.endFrame();
  }
  game.tick = tick;

  // apply the saved settings without toasts, then warm up the shaders behind the loading screen
  settings.applyAll({ startup: true });
  refreshSound();

  // compile for the pipeline's HDR target: the program variant depends on the output colour space
  // (compiling for the canvas gave sRGB-output programs that are never used)
  const compileScene = () => {
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(pipeline.hdr);
    const p = renderer.compileAsync(scene, camera);
    renderer.setRenderTarget(prev);
    return p;
  };
  setLoading('Compiling shaders…', 0.86); await frame();
  // Warm-up behind the loading screen. The lamps change the lights hash (shadow-casting head spot, lamp
  // visibility at night), so first a frame with every lamp on (compile + one real draw, which also builds
  // the GPU pipeline states and the lamp shadow map: switching on the lamps at night stalled ~200 ms
  // without it), then the real state. One frame without drawing comes first, so the compile sees the
  // lights as they are.
  try {
    const ls = view.lights, head = ls.head, bar = ls.bar;
    ls.head = 1; ls.bar = true;
    tick(1 / 60, false);
    view.update(rPos, rQ, 0, { night: true, shadows: true });
    await Promise.race([compileScene(), new Promise(r => setTimeout(r, 6000))]);
    pipeline.render(1 / 60);
    ls.head = head; ls.bar = bar;
    tick(1 / 60, false);
    await Promise.race([compileScene(), new Promise(r => setTimeout(r, 6000))]);
  } catch (e) { console.warn('shader warm-up', e); }
  tick(1 / 60);

  setLoading('Ready', 1); await frame();
  loading.classList.add('done');
  setTimeout(() => loading.remove(), 600);
  started = true;

  if (!settings.introSeen) menu.openIntro();
  else say('welcome', `Defender 110 V8 · ${d.mode === 'auto' ? 'automatic' : 'manual'} · ${k('menu')} menu · ${k('controls')} controls`, '', 5);

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
