import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { installShaderPatches } from './render/shaderPatches.js';
import { RenderPipeline } from './render/pipeline.js';

import { Terrain, SPAWN } from './world/terrain.js';
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
import { batchByMaterial } from './vehicle/model/batched.js';
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
import { loadLog, setLoading, frame, hideLoading, showError } from './loading.js';
import { createGraphics, GFX_KEYS } from './graphics.js';
import { createPlacement } from './placement.js';
import { Menu } from './menu.js';
import { Settings } from './settings.js';
import { GameAudio } from './audio/audio.js';
import { Dust, Tracks } from './effects.js';
import { Multiplayer, roomFromURL } from './multiplayer.js';
import './ui.css';

installShaderPatches();     // before any material compiles

const H = 1 / 240;          // physics step
const MAX_STEPS = 16;

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
  env.sun.shadow.setCar?.(model.root, camera);   // the car gets its own sharp sun shadow, the world a soft one
  model.batch = batchByMaterial(model.root);   // one draw per material (after setCar: the batches take its layer)
  if (P.turret && model.turret) vehicle.turret = new Turret(P.turret);
  const view = new VehicleView(model, vehicle);
  const colliderView = new ColliderView(scene, model, vehicle);
  const d = vehicle.drivetrain;


  setCarControls(missingControls(vehicle, model));   // before the HUD, touch and menu list controls

  const rig = new CameraRig(camera, terrain);
  if (model.chaseDist) rig.dist = model.chaseDist;
  const input = new Input(canvas);
  const hud = new HUD();
  // Toasts with the same key replace each other (key null: no grouping).
  const say = (key, html, kind = '', t) => hud.toast(html, { kind, t, key: key || html });
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

  const afterPlace = () => {
    prevPos.copy(vehicle.pos); curPos.copy(vehicle.pos); prevQ.copy(vehicle.quat); curQ.copy(vehicle.quat);
    rig.first = true;
    game.redraw = 3;
  };
  const { teleports, nearestLocation, placeVehicle, recover: recoverVehicle } = createPlacement({ RAPIER, world, terrain, vehicle, trees, props, onPlaced: afterPlace });
  const recover = () => { recoverVehicle(); say('place', 'Recovered', 'good'); };

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
  let started = false;
  const gfx = createGraphics({ renderer, pipeline, env, scenery, settings, dust, gunnery, game, say, started: () => started });
  const applyGraphics = gfx.apply;
  game.gfx = gfx;
  game.applyGraphics = applyGraphics;
  game.autoTune = gfx.tune;
  game.dynRes = gfx.dynRes; game.updateDynamicResolution = gfx.updateDynamicResolution;

  // ---------------------------------------------------------------- settings -> game
  // Every persisted setting is applied here (key, menu or startup). opts.silent: no toast.
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
      if (v === 'auto' && !o.startup && !o.reset) gfx.startAutoTune(true);   // picked in the menu: re-measure
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
        case 'qualityNote': return gfx.qualityNote();
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
    gfx.updateDynamicResolution(dt, paused);
    input.endFrame();
  }
  game.tick = tick;
  // tools (gfxbench, gfxprofile) drive the frames themselves: holdLoop stops the rAF loop, and frame() is one
  // whole frame with the renderer's counters (draw calls, triangles) summed over all its passes
  game.holdLoop = false;
  game.frame = (dt = 1 / 60) => {
    const info = renderer.info, ar = info.autoReset;
    info.autoReset = false; info.reset();
    tick(dt);
    info.autoReset = ar;
  };

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
  hideLoading();
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
    if (dt <= 0 || game.holdLoop) return;
    gfx.updateAutoQuality(dt);
    tick(dt);
  }
  requestAnimationFrame(loop);
}

main().catch(showError);
