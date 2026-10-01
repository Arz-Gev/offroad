import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

import { Terrain, SPAWN, LANES, HILL } from './world/terrain.js';
import { buildTerrainView } from './world/terrainView.js';
import { buildProps } from './world/props.js';
import { Environment } from './world/environment.js';
import { makeDefenderParams } from './vehicle/params.js';
import { Vehicle } from './vehicle/Vehicle.js';
import { buildTruck } from './vehicle/truckModel.js';
import { VehicleView } from './vehicle/vehicleView.js';
import { CameraRig } from './cameraRig.js';
import { Input } from './input.js';
import { HUD } from './hud.js';
import { GameAudio } from './audio/audio.js';
import { Dust, Tracks } from './effects.js';

const H = 1 / 240;          // physics step
const MAX_STEPS = 16;

const loading = document.getElementById('loading');
const setLoading = t => { loading.querySelector('.t').textContent = t; };
const frame = () => new Promise(r => setTimeout(r, 0));

async function main() {
  setLoading('Starting physics…'); await frame();
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

  setLoading('Generating terrain…'); await frame();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = H;
  const terrain = new Terrain(7);
  terrain.createCollider(RAPIER, world);
  const terrainView = buildTerrainView(terrain);
  scene.add(terrainView);

  setLoading('Placing rocks and trees…'); await frame();
  const colliderSurface = new Map();
  const props = buildProps(RAPIER, world, terrain, colliderSurface, terrainView.userData.material.userData.uniforms.uRock.value);
  scene.add(props);

  setLoading('Building the truck…'); await frame();
  const P = makeDefenderParams();
  const surfaceAt = (col, p) => (col && colliderSurface.get(col.handle)) || terrain.surfaceAt(p.x, p.z);
  const spawnY = terrain.heightAt(SPAWN.x, SPAWN.z) + 0.12;
  const vehicle = new Vehicle(RAPIER, world, P, { position: { x: SPAWN.x, y: spawnY, z: SPAWN.z }, yaw: SPAWN.yaw, surfaceAt });
  world.step();
  const model = buildTruck(P);
  scene.add(model.root);
  const view = new VehicleView(model, vehicle);

  const env = new Environment(renderer, scene);
  const rig = new CameraRig(camera, terrain);
  const input = new Input(canvas);
  const hud = new HUD();
  const audio = new GameAudio();
  const dust = new Dust(scene);
  const tracks = new Tracks(terrainView.userData.material);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth / 2, window.innerHeight / 2), 0.5, 0.4, 2.2);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
  });

  // audio needs a user gesture
  const startAudio = () => { audio.start().catch(e => console.warn('audio', e)); document.getElementById('soundhint').style.display = 'none'; };
  window.addEventListener('keydown', startAudio, { once: true });
  window.addEventListener('pointerdown', startAudio, { once: true });

  // interpolated body pose
  const prevPos = new THREE.Vector3().copy(vehicle.pos), curPos = new THREE.Vector3().copy(vehicle.pos);
  const prevQ = new THREE.Quaternion().copy(vehicle.quat), curQ = new THREE.Quaternion().copy(vehicle.quat);
  const rPos = new THREE.Vector3(), rQ = new THREE.Quaternion();

  const teleports = [
    { name: 'Spawn', x: SPAWN.x, z: SPAWN.z, yaw: 0 },
    { name: 'Proving ground: axle twister (lane A)', x: LANES.A, z: 47, yaw: 0 },
    { name: 'Proving ground: steps & logs (lane B)', x: LANES.B, z: 47, yaw: 0 },
    { name: 'Proving ground: rock garden (lane C)', x: LANES.C, z: 47, yaw: 0 },
    { name: 'Proving ground: ramps 20° / 30° / 35° (lane D)', x: LANES.D, z: 47, yaw: 0 },
    { name: 'Proving ground: mud + off-camber (lane E)', x: LANES.E, z: 47, yaw: 0 },
    { name: 'The big hill', x: HILL.x - 52, z: HILL.z + 8, yaw: -Math.PI / 2 },
  ];
  let tpIndex = 0;
  const placeVehicle = (x, z, yaw, lift = 0.5) => {
    let y = terrain.heightAt(x, z);
    for (const dx of [-1.5, 1.5]) for (const dz of [-2.2, 2.2]) y = Math.max(y, terrain.heightAt(x + dx, z + dz));
    vehicle.reset({ x, y: y + lift, z }, yaw);
    prevPos.copy(vehicle.pos); curPos.copy(vehicle.pos); prevQ.copy(vehicle.quat); curQ.copy(vehicle.quat);
    rig.first = true;
  };

  const game = { composer, bloom, tracks, dust, RAPIER, world, terrain, vehicle, model, view, rig, env, input, hud, audio, renderer, scene, camera, placeVehicle, teleports, paused: false, stepsPerFrame: 0, autopilot: null };
  window.game = game;

  function handleKeys() {
    const d = vehicle.drivetrain;
    const hit = c => input.hit(c);
    if (hit('KeyE')) d.requestShift(1);
    if (hit('KeyQ')) d.requestShift(-1);
    if (hit('KeyM')) d.toggleMode();
    if (hit('KeyK')) d.toggleClutchAssist();
    if (hit('KeyT')) d.toggleRange(vehicle.speed);
    if (hit('KeyX')) d.toggleCenterLock();
    if (hit('KeyZ')) d.cycleAxleLockers();
    if (hit('BracketLeft') || hit('BracketRight')) {
      vehicle.setPressure(vehicle.pressure + (hit('BracketLeft') ? -2 : 2));
      const p = vehicle.pressure;
      hud.message(`Tyres ${p.toFixed(0)} psi` + (p <= 14 ? ' — aired down: big footprint, more grip off-road' : p >= 32 ? ' — road pressure: firm, less grip on loose ground' : ''));
    }
    if (hit('KeyI')) { d.startEngine(); }
    if (hit('KeyO')) { d.stopEngine(); hud.message('Engine off'); }
    if (hit('KeyL')) { view.lights.head = (view.lights.head + 1) % 3; hud.message(['Headlights off', 'Low beam', 'High beam'][view.lights.head]); }
    if (hit('KeyJ')) { view.lights.bar = !view.lights.bar; hud.message(view.lights.bar ? 'Light bar on' : 'Light bar off'); }
    if (hit('KeyG')) { view.lights.hazard = !view.lights.hazard; }
    if (hit('KeyN')) { const m = env.cycle(); hud.message(m[0].toUpperCase() + m.slice(1)); if (m === 'night' && view.lights.head === 0) view.lights.head = 1; }
    if (hit('KeyC')) { rig.cycle(); hud.camLabel(rig.label); }
    if (hit('KeyR')) { placeVehicle(vehicle.pos.x, vehicle.pos.z, vehicle.yaw(), 1.0); hud.message('Recovered'); }
    if (hit('KeyP')) { tpIndex = (tpIndex + 1) % teleports.length; const t = teleports[tpIndex]; placeVehicle(t.x, t.z, t.yaw); hud.message(t.name); }
    if (hit('KeyH')) hud.toggleHelp();
    if (hit('F3') || hit('Backquote')) hud.toggleTelemetry();
    if (hit('KeyV')) hud.message(audio.toggleMute() ? 'Sound off' : 'Sound on');
  }

  setLoading('Ready'); await frame();
  loading.style.opacity = 0;
  setTimeout(() => loading.remove(), 600);
  hud.camLabel(rig.label);
  hud.message('Defender 110 V8 — automatic. Press H for controls, M for manual gearbox.', 5);

  let last = performance.now(), acc = 0;
  function loop(now) {
    requestAnimationFrame(loop);
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.1) dt = 0.1;
    tick(dt);
  }
  // one frame of the game; also callable from the console for testing (game.tick(1/60))
  function tick(dt) {
    const T = game.timings || (game.timings = {});
    let tm = performance.now();
    const mark = k => { const n = performance.now(); T[k] = (T[k] || 0) * 0.9 + (n - tm) * 0.1; tm = n; };
    input.update(dt);
    handleKeys();
    const raw = game.autopilot ? game.autopilot(vehicle, dt) : input.raw;

    if (!game.paused) {
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
      if (curPos.y < -60) placeVehicle(SPAWN.x, SPAWN.z, 0);
    }
    mark('physics');
    const alpha = acc / H;
    rPos.lerpVectors(prevPos, curPos, alpha);
    rQ.slerpQuaternions(prevQ, curQ, alpha);

    view.update(rPos, rQ, dt, { night: env.night, shadows: true });
    rig.update(dt, input, rPos, rQ, vehicle, model);
    env.update(dt, rPos);
    mark('view');
    dust.spawnFromVehicle(vehicle, dt);
    dust.update(dt, env.night ? 0.12 : env.mode === 'dusk' ? 0.7 : 1.0);
    mark('dust');
    audio.update(dt, vehicle, { cockpit: rig.mode === 'cockpit' });
    mark('audio');
    hud.update(dt, vehicle, view, `steps/frame ${game.stepsPerFrame}  cam ${rig.mode}  time ${env.mode}\npos ${vehicle.pos.x.toFixed(1)} ${vehicle.pos.y.toFixed(1)} ${vehicle.pos.z.toFixed(1)}`);
    mark('hud');
    bloom.enabled = env.mode !== 'day';
    bloom.strength = env.night ? 0.7 : 0.35;
    composer.render();
    mark('render');
    input.endFrame();
  }
  game.tick = tick;
  requestAnimationFrame(loop);
}

main().catch(e => {
  console.error(e);
  setLoading('Error: ' + e.message);
});
