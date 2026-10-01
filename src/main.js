import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

import { Terrain, SPAWN, LANES, HILL } from './world/terrain.js';
import { buildTerrainView } from './world/terrainView.js';
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

const H = 1 / 240;          // physics step
const MAX_STEPS = 16;

// ---------------------------------------------------------------- loading screen
const loading = document.getElementById('loading');
const setLoading = (text, p) => {
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
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 3000);

  setLoading('Generating terrain…', 0.2); await frame();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = H;
  const terrain = new Terrain(7);
  terrain.createCollider(RAPIER, world);
  const terrainView = buildTerrainView(terrain);
  scene.add(terrainView);

  setLoading('Placing rocks and trees…', 0.5); await frame();
  const colliderSurface = new Map();
  const props = buildProps(RAPIER, world, terrain, colliderSurface, terrainView.userData.material.userData.uniforms.uRock.value);
  scene.add(props);

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

  const env = new Environment(renderer, scene);
  const rig = new CameraRig(camera, terrain);
  const input = new Input(canvas);
  const hud = new HUD();
  const audio = new GameAudio();
  const settings = new Settings();
  const dust = new Dust(scene);
  const tracks = new Tracks(terrainView.userData.material);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth / 2, window.innerHeight / 2), 0.5, 0.4, 2.2);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // interpolated body pose
  const prevPos = new THREE.Vector3().copy(vehicle.pos), curPos = new THREE.Vector3().copy(vehicle.pos);
  const prevQ = new THREE.Quaternion().copy(vehicle.quat), curQ = new THREE.Quaternion().copy(vehicle.quat);
  const rPos = new THREE.Vector3(), rQ = new THREE.Quaternion();

  // teleport targets, shown in the menu's Locations tab (x, z, yaw are also used by tools/browser-snippets.js)
  const teleports = [
    { name: 'Spawn', tag: 'Trail', title: 'Spawn', desc: 'Start of the trail loop: ruts, a mud hole and a branch towards the hills.', x: SPAWN.x, z: SPAWN.z, yaw: 0 },
    { name: 'Axle twister', tag: 'Proving ground · lane A', title: 'Axle twister and whoops', desc: 'Offset humps that lift one wheel at a time. Watch the axle articulation.', x: LANES.A, z: 47, yaw: 0 },
    { name: 'Steps and logs', tag: 'Proving ground · lane B', title: 'Steps and logs', desc: 'Ledges from 15 to 45 cm, then logs. Low range and a slow approach.', x: LANES.B, z: 47, yaw: 0 },
    { name: 'Rock garden', tag: 'Proving ground · lane C', title: 'Rock garden', desc: 'Boulders. Needs low range, lockers and a careful line.', x: LANES.C, z: 47, yaw: 0 },
    { name: 'Ramps', tag: 'Proving ground · lane D', title: 'Ramps 20° / 30° / 35°', desc: 'Climbs in low range. The steepest needs the centre diff locked.', x: LANES.D, z: 47, yaw: 0 },
    { name: 'Mud and off-camber', tag: 'Proving ground · lane E', title: 'Mud and off-camber', desc: 'A deep mud hole and a side slope. Air down and keep momentum.', x: LANES.E, z: 47, yaw: 0 },
    { name: 'The big hill', tag: 'Hill', title: 'The big hill', desc: 'A long climb with views over the whole map.', x: HILL.x - 52, z: HILL.z + 8, yaw: -Math.PI / 2 },
  ];
  const placeVehicle = (x, z, yaw, lift = 0.5) => {
    let y = terrain.heightAt(x, z);
    for (const dx of [-1.5, 1.5]) for (const dz of [-2.2, 2.2]) y = Math.max(y, terrain.heightAt(x + dx, z + dz));
    vehicle.reset({ x, y: y + lift, z }, yaw);
    prevPos.copy(vehicle.pos); curPos.copy(vehicle.pos); prevQ.copy(vehicle.quat); curQ.copy(vehicle.quat);
    rig.first = true;
    game.redraw = 3;
  };

  const game = { composer, bloom, tracks, dust, RAPIER, world, terrain, vehicle, model, view, rig, env, input, hud, audio, settings, renderer, scene, camera, placeVehicle, teleports, paused: false, redraw: 0, stepsPerFrame: 0, autopilot: null };
  window.game = game;

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
    camera(v, o) { rig.setMode(v); if (!o.silent) say('camera', CAM_NAMES[v]); },
    time(v, o) {
      env.setMode(v);
      if (o.startup) { env.blend = 1; env.apply(1); }
      if (!o.silent) say('time', { day: 'Day', dusk: 'Dusk', night: 'Night' }[v]);
      if (v === 'night' && view.lights.head === 0) setHeadlights(1, true);
    },
    muted(v, o) { audio.setMuted(v); refreshSound(); if (!o.silent) say('sound', v ? `Sound off · ${k('mute')} turns it on` : 'Sound on'); },
    volume(v) { audio.setVolume(v); },
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
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
    game.redraw = 3;
  });

  // ---------------------------------------------------------------- frame
  let acc = 0;
  // one frame of the game; also callable from the console for testing (game.tick(1/60))
  function tick(dt) {
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
      env.update(dt, rPos);
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
    if (draw) {
      bloom.enabled = env.mode !== 'day';
      bloom.strength = env.night ? 0.7 : 0.35;
      composer.render();
    }
    mark('render');
    input.endFrame();
  }
  game.tick = tick;

  // apply the saved settings without toasts, then warm up the shaders behind the loading screen
  settings.applyAll({ startup: true });
  refreshSound();

  setLoading('Compiling shaders…', 0.86); await frame();
  try {
    await Promise.race([renderer.compileAsync(scene, camera), new Promise(r => setTimeout(r, 6000))]);
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
