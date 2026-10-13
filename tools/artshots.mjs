// Screenshots of the endless world at fixed views, for judging the look (before / after a change). Seeded world, so
// the same views every run: the start and places in the first window round it, the wind stopped, the game paused.
//   node tools/artshots.mjs out=dir [preset=ultra] [views=all|start,wide,...] [size=1600x900@1] [jpg=1]
// Chrome with --remote-debugging-port (CDP_PORT, default 9341); URL defaults to http://localhost:5177/.
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map(a => a.split('=')));
const port = process.env.CDP_PORT || 9341;
const out = args.out || 'shots';
fs.mkdirSync(out, { recursive: true });

// at: 'start' or a site type; orbit: [yaw, pitch, distance] round the truck; hour
const VIEWS = {
  start: { at: 'start', hour: 13 },
  startLamps: { at: 'start', hour: 13, lights: 1 },
  vistaLamps: { at: 'lookout', hour: 11, cam: [0, 8, 0, 190, -5], lights: 1 },
  cockpit: { at: 'start', hour: 13, camMode: 'cockpit' },
  hood: { at: 'lookout', hour: 15, camMode: 'hood' },
  wide: { at: 'start', hour: 13, orbit: [0.5, 0.35, 45] },
  back: { at: 'start', hour: 11, orbit: [3.0, 0.05, 9] },
  golden: { at: 'start', hour: 18.3, orbit: [2.5, 0.1, 12] },
  morning: { at: 'lookout', hour: 7.4, orbit: [-1.2, 0.12, 12] },
  dusk: { at: 'lookout', hour: 19.4, orbit: [2.2, 0.1, 12] },
  night: { at: 'start', hour: 23, orbit: [3.0, 0.1, 9], lights: 1 },
  rain: { at: 'lookout', hour: 13, orbit: [0.8, 0.15, 14], storm: 1 },
  lake: { at: 'lake', hour: 10.5, cam: [0, 14, 0, 90, -9] },
  lookout: { at: 'lookout', hour: 15.5, orbit: [0.8, 0.3, 30] },
  hut: { at: 'hut', hour: 17, orbit: [1.6, 0.12, 12] },
  quarry: { at: 'quarry', hour: 12, orbit: [0.4, 0.4, 30] },
  // free camera: cam [dx, height above the ground, dz, heading deg (0 = -z), pitch deg] from the truck
  vistaN: { at: 'lookout', hour: 14, cam: [0, 8, 0, 0, -4] },
  vistaE: { at: 'lookout', hour: 16.5, cam: [0, 8, 0, 100, -5] },
  vistaS: { at: 'lookout', hour: 11, cam: [0, 8, 0, 190, -5] },
  vistaS2: { at: 'lookout', hour: 11, cam: [0, 8, 0, 190, -5] },
  vistaW: { at: 'lookout', hour: 9, cam: [0, 8, 0, 280, -6] },
  air: { at: 'start', hour: 15, cam: [0, 70, 60, 20, -14] },
  eveningS: { at: 'lookout', hour: 18.3, cam: [0, 8, 0, 190, -5] },
  eveningW: { at: 'lookout', hour: 18.3, cam: [0, 8, 0, 280, -5] },
  sunward: { at: 'start', hour: 18.6, cam: [0, 3, 0, 65, 4] },
  high: { at: 'start', hour: 14, cam: [0, 220, 150, 200, -18] },
};

const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pend = new Map(); const logs = [];
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  else if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push('ERR: ' + m.params.args.map(a => a.value ?? a.description ?? '').join(' '));
});
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 180000 }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text); return r.result?.result?.value; };
await send('Runtime.enable'); await send('Page.enable');

const preset = args.preset || 'ultra';
const [sw, rest] = (args.size || '1600x900@1').split('x');
const [sh, sdpr] = rest.split('@');
const names = !args.views || args.views === 'all' ? Object.keys(VIEWS) : args.views.split(',');
await send('Emulation.setDeviceMetricsOverride', { width: +sw, height: +sh, deviceScaleFactor: +sdpr, mobile: false });
const settings = { autoPause: false, quality: preset, time: 13, hints: false, timeFlow: 'off', muted: true, weather: 'fair' };
await send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.clear(); localStorage.setItem('offroad.settings.v1', ${JSON.stringify(JSON.stringify(settings))}); localStorage.setItem('offroad.introSeen.v1', '1'); } catch {}` });
await send('Page.navigate', { url: (process.env.URL || 'http://localhost:5177/') + '?t=' + Date.now() + (process.env.PARAMS ? '&' + process.env.PARAMS : '') });
await evaluate(`new Promise((res, rej) => { (function poll() { const l = document.getElementById('loading'); if (window.game && (!l || l.classList.contains('done'))) return res(1); if (l && l.classList.contains('error')) return rej(new Error(l.textContent)); setTimeout(poll, 200); })(); })`);
await new Promise(r => setTimeout(r, 5000));
await evaluate(`(() => { document.getElementById('hud').style.display = 'none'; })()`);
if (process.env.JS) console.log('js', await evaluate(process.env.JS));   // e.g. JS='game.pipeline.params.paint = 1'
for (const name of names) {
  const v = VIEWS[name];
  const ok = await evaluate(`(async () => {
    const g = game, frame = g.frame || g.tick;
    g.holdLoop = true; g.setPaused(false); g.autopilot = null;
    g.weather?.set?.({ s: ${v.storm ?? 0}, wet: ${v.storm ?? 0}, bow: 0 });
    g.settings.set('time', ${v.hour}, { silent: true });
    g.settings.set('camera', ${JSON.stringify(v.camMode || 'chase')}, { silent: true });
    g.view.lights.head = ${v.lights ?? 0};
    const at = ${JSON.stringify(v.at)};
    if (at === 'start') { const t = g.teleports[0]; g.placeVehicle(t.ax - g.ORIGIN.x, t.az - g.ORIGIN.z, t.yaw); }
    else {
      let s = g.terrain.sites.filter(s => s.type === at).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))[0];
      if (!s) {
        // not in this window: the nearest one in the world (absolute coordinates), travel there
        const W = new (await import('/src/world/worldgen.js')).World(window.__seed ?? 7), ox = g.ORIGIN.x, oz = g.ORIGIN.z, R = 4000;
        const all = W.regionsIn(ox - R, oz - R, ox + R, oz + R).flatMap(r => r.sites || []).filter(q => q.type === at);
        all.sort((a, b) => Math.hypot(a.x - ox, a.z - oz) - Math.hypot(b.x - ox, b.z - oz));
        if (!all[0]) return 'no ' + at;
        if (!(await g.placeWorld(all[0].x + 40, all[0].z, 0))) return 'travel failed';
        for (let i = 0; i < 30; i++) frame(1 / 60);
        s = g.terrain.sites.filter(q => q.type === at).sort((a, b) => Math.hypot(a.x - g.vehicle.pos.x, a.z - g.vehicle.pos.z) - Math.hypot(b.x - g.vehicle.pos.x, b.z - g.vehicle.pos.z))[0];
        if (!s) return 'no ' + at + ' after travel';
      }
      if (at === 'lake') { const lk = s.lake; g.placeVehicle(lk.x + lk.rx * 1.35, lk.z, Math.PI / 2); }
      else if (at === 'lookout') g.placeVehicle(s.x, s.z, 0.6);
      else g.placeVehicle(s.x + 14, s.z + 10, 0.6);
    }
    g.grass.shared.uWind.value.z = ${+(args.wind ?? 0)};
    if (g.pipeline.clouds) { g.pipeline.clouds.wind.x = 0; g.pipeline.clouds.wind.y = 0; }   // the same clouds (and cloud shadows) every run
    const o = ${JSON.stringify(v.orbit || null)}, dist = (window.__dist0 ??= g.rig.dist);
    g.input.mouse.lastMove = o ? 1e15 : 0;
    const c = ${JSON.stringify(v.cam || null)};
    g.camPose = null;
    if (c) {
      const p = g.vehicle.pos, x = p.x + c[0], z = p.z + c[2], y = g.terrain.heightAt(x, z) + c[1];
      const h = c[3] * Math.PI / 180, pi = c[4] * Math.PI / 180;
      g.camPose = (cam) => { cam.position.set(x, y, z); cam.lookAt(x - Math.sin(h) * Math.cos(pi) * 100, y + Math.sin(pi) * 100, z - Math.cos(h) * Math.cos(pi) * 100); cam.updateMatrixWorld(); };
    }
    for (let i = 0; i < 120; i++) { if (o) { g.rig.orbitYaw = o[0]; g.rig.orbitPitch = o[1]; g.rig.dist = o[2]; } else g.rig.dist = dist; frame(1 / 60); }
    g.env.settle?.(); g.setPaused(true); g.redraw = 1e9;
    for (let i = 0; i < 30; i++) frame(1 / 60);
    g.env.settle?.();
    for (let i = 0; i < 4; i++) frame(1 / 60);
    return 'ok';
  })()`);
  if (ok !== 'ok') { console.log('skip', name, ok); continue; }
  if (args.bench) {
    // frame cost: batches of 10 frames, each batch waited for with a 1-pixel read (CPU + GPU, whichever is slower)
    const ms = await evaluate(`(() => {
      const g = game, gl = g.renderer.getContext(), px = new Uint8Array(4), out = [];
      for (let b = 0; b < ${+args.bench}; b++) {
        const t0 = performance.now();
        for (let i = 0; i < 10; i++) g.frame(1 / 60);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        out.push((performance.now() - t0) / 10);
      }
      out.sort((a, b) => a - b);
      return out[Math.floor(out.length / 2)].toFixed(2) + ' ms (p90 ' + out[Math.floor(out.length * 0.9)].toFixed(2) + ')';
    })()`);
    console.log('bench', name, ms);
    if (args.noshot) continue;
  }
  const jpg = args.jpg !== '0';
  const r = await send('Page.captureScreenshot', jpg ? { format: 'jpeg', quality: 88 } : { format: 'png' });
  fs.writeFileSync(path.join(out, name + (jpg ? '.jpg' : '.png')), Buffer.from(r.result.data, 'base64'));
  console.log('shot', name);
  if (args.pick) {
    // what is under a pixel (x,y in 0..1 of the frame): the objects a ray from the camera hits, nearest first
    const [px, py] = args.pick.split(',').map(Number);
    console.log('pick', await evaluate(`(() => {
      const g = game, T = g.THREE, rc = new T.Raycaster();
      rc.setFromCamera(new T.Vector2(${px} * 2 - 1, 1 - ${py} * 2), g.camera);
      return rc.intersectObjects(g.scene.children, true).slice(0, 5).map(h => (h.object.name || h.object.type) + '/' + (h.object.parent?.name || '') + ' ' + h.distance.toFixed(1) + 'm ' + (h.object.material?.type || ''));
    })()`));
  }
}
const t = await evaluate(`JSON.stringify(game.timings || {})`);
console.log('timings', t);
await evaluate(`(() => { game.holdLoop = false; game.camPose = null; })()`);
await send('Page.navigate', { url: 'about:blank' });
if (logs.length) console.log('LOGS>\n' + [...new Set(logs)].slice(0, 20).join('\n'));
ws.close();
