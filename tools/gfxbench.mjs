// Graphics benchmark: fixed viewpoints across the map, frame time per view, screenshots.
// Works with any renderer the game uses (WebGL or WebGPU): every frame is rendered and then waited for
// in batches of 10 (WebGPU: queue.onSubmittedWorkDone, WebGL: a 1-pixel readPixels), so the number is the
// real cost of a frame (CPU + GPU, whichever is slower), not the rAF rate.
//
// 1. A dev server (npx vite --port 5181 --strictPort) and a visible Chrome window (the player wants real-window
//    numbers; --headless=new works too, without size=window):
//    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9341 \
//      --user-data-dir=/tmp/offroad-chrome-9341 --no-first-run --test-type --mute-audio about:blank &
// 2. node tools/gfxbench.mjs [preset=high] [views=all|forest,meadow,...] [frames=90] [out=dir] [size=1920x1080@2] [dust=0] [raf=5]
//    env: CDP_PORT (9341), URL (http://localhost:5181/), PARAMS (extra query string, e.g. "webgl=1")
// Prints one line per view: median / p90 frame ms (of the 10-frame batches), draw calls, triangles; writes <out>/<view>.jpg.
// raf=<s>: instead, let the game's own requestAnimationFrame loop run for s seconds and print its frame rate
// (for a visible Chrome window, where presenting the canvas and the display's refresh rate count too; size=window
// keeps the window's own size and pixel ratio).
// The drive views keep the truck moving on the main trail (an autopilot, physics running) so the dust is in
// the air while measuring; they also print how many dust particles are alive.
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map(a => a.split('=')));
const preset = args.preset || 'high';
const frames = +(args.frames || 90);
const out = args.out || null;
const winSize = args.size === 'window';
const [sw, rest] = (winSize ? '0x0@0' : args.size || '1920x1080@2').split('x');
const [sh, sdpr] = rest.split('@');
const raf = +(args.raf || 0);
const port = process.env.CDP_PORT || 9341;
const url = (process.env.URL || 'http://localhost:5181/') + '?t=' + Date.now() + (process.env.PARAMS ? '&' + process.env.PARAMS : '');

// view: teleport name (game.teleports), hour, camera mode, optional camera yaw offset (orbit, rad)
const VIEWS = {
  meadow: { tp: 'Spawn', hour: 13 },
  forest: { tp: 'Pine forest', hour: 13 },
  forestCockpit: { tp: 'Pine forest', hour: 13, cam: 'cockpit' },
  lake: { tp: 'Lake shore', hour: 13 },
  ford: { tp: 'The ford', hour: 13 },
  hut: { tp: 'Ruined hut', hour: 18.25 },
  lookout: { tp: 'Lookout', hour: 13 },
  hill: { tp: 'The big hill', hour: 10 },
  forestNight: { tp: 'Pine forest', hour: 23, lights: 2 },
  // driving along the main trail (km/h, start this far along the loop): dust behind the wheels
  drive: { trail: 0.0, kmh: 50, hour: 13 },
  donut: { trail: 0.0, kmh: 0, hour: 17, donut: true },   // full lock + full throttle on the trail: the camera in a dust cloud
};
const names = !args.views || args.views === 'all' ? Object.keys(VIEWS) : args.views.split(',');

const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const tgt = list.find(t => t.type === 'page');
const ws = new WebSocket(tgt.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pend = new Map(); const logs = [];
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  else if (m.method === 'Runtime.consoleAPICalled' && /error|warn/.test(m.params.type)) logs.push(m.params.type + ': ' + m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 400));
  else if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
});
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr, timeout = 120000) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
};
await send('Runtime.enable'); await send('Page.enable');
if (!winSize) await send('Emulation.setDeviceMetricsOverride', { width: +sw, height: +sh, deviceScaleFactor: +sdpr, mobile: false });
const settings = { autoPause: false, quality: preset, time: 13, hints: false, muted: true };
await send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('offroad.settings.v1', ${JSON.stringify(JSON.stringify(settings))}); localStorage.setItem('offroad.introSeen.v1', '1'); } catch {}` });
const t0 = Date.now();
await send('Page.navigate', { url });
await evaluate(`new Promise((res, rej) => { const t = Date.now(); (function poll() {
  const l = document.getElementById('loading');
  if (window.game && (!l || l.classList.contains('done'))) return res(true);
  if (l && l.classList.contains('error')) return rej(new Error(l.textContent));
  if (Date.now() - t > 110000) return rej(new Error('load timeout'));
  setTimeout(poll, 200); })(); })`);
// the game compiles the other lamp state in the background after loading: let that finish first
await new Promise(r => setTimeout(r, 6000));
const backend = await evaluate(`(() => { const r = game.renderer; return r.backend ? (r.backend.isWebGPUBackend ? 'webgpu' : 'webgl2 (fallback)') : 'webgl (old renderer)'; })()`);
const canvasSize = await evaluate(`(() => { const c = game.renderer.domElement; return c.width + 'x' + c.height + ' (' + innerWidth + 'x' + innerHeight + '@' + devicePixelRatio + ')'; })()`);
console.log(`loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s · ${backend} · preset ${preset} · canvas ${canvasSize}${raf ? ` · rAF loop ${raf} s` : ''}`);
if (out) fs.mkdirSync(out, { recursive: true });

for (const name of names) {
  const v = VIEWS[name];
  if (!v) { console.log(`unknown view ${name}`); continue; }
  const res = await evaluate(`(async () => {
    const g = game, r = g.renderer;
    // wait until the GPU has finished: WebGPU's queue, or a 1-pixel read from a framebuffer of our own (WebGL)
    const gl = r.backend ? r.backend.gl : r.getContext();
    if (gl && r.backend && !window.__syncFb) {
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      window.__syncFb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, window.__syncFb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, prev); gl.bindTexture(gl.TEXTURE_2D, null);
    }
    const sync = async () => {
      if (r.backend && r.backend.device) return r.backend.device.queue.onSubmittedWorkDone();
      if (!r.backend) { gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); return; }   // old renderer: the canvas
      const prev = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, window.__syncFb);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prev);
    };
    // one whole frame (game.frame advances three's node frame like a browser frame does; the old renderer has no such gate)
    // the old renderer resets its counters on every render call (the last one is the post quad): count whole frames
    const step = () => { if (g.frame) return g.frame(1 / 60); r.info.autoReset = false; r.info.reset(); g.tick(1 / 60); };
    g.holdLoop = true;
    g.menu.isOpen && g.menu.close?.();
    g.setPaused(false);
    g.settings.set('time', ${v.hour}, { silent: true });
    g.settings.set('camera', ${JSON.stringify(v.cam || 'chase')}, { silent: true });
    g.view.lights.head = ${v.lights ?? 0};
    const drive = ${JSON.stringify(v.trail !== undefined ? v : null)};
    g.autopilot = null;
    g.dust.setEnabled(${args.dust !== '0'});
    if (drive) {
      // pure pursuit along the main trail (tools/browser-snippets.js trailDriver), or circles on full lock
      const curve = g.terrain.trailCurves[0], N = 2000, pts = curve.getSpacedPoints(N), seg = curve.getLength() / N;
      const i0 = Math.floor(drive.trail * N), a = pts[i0], b = pts[i0 + 4];
      g.placeVehicle(a.x, a.z, 0);
      const v = g.vehicle, fx = b.x - a.x, fz = b.z - a.z;
      const yaw = Math.atan2(fx, fz);
      g.placeVehicle(a.x, a.z, yaw);
      if (v.fwd.x * fx + v.fwd.z * fz < 0) g.placeVehicle(a.x, a.z, yaw + Math.PI);
      g.autopilot = drive.donut ? () => ({ throttle: 1, brake: 0, steer: 1, clutch: 0, handbrake: 0, analogSteer: true }) : (v) => {
        let best = 0, bd = 1e9;
        for (let i = 0; i < N; i += 2) { const d = (pts[i].x - v.pos.x) ** 2 + (pts[i].z - v.pos.z) ** 2; if (d < bd) { bd = d; best = i; } }
        const tgt = pts[(best + Math.round(Math.max(8, Math.abs(v.speed) * 0.9) / seg)) % N];
        const dx = tgt.x - v.pos.x, dz = tgt.z - v.pos.z;
        const steer = Math.max(-1, Math.min(1, Math.atan2(dx * v.right.x + dz * v.right.z, dx * v.fwd.x + dz * v.fwd.z) * 2));
        const sp = v.speed * 3.6;
        return { throttle: sp < drive.kmh ? 0.75 : 0, brake: sp > drive.kmh + 8 ? 0.5 : 0, steer, clutch: 0, handbrake: 0, analogSteer: true };
      };
      // get up to speed and fill the air with dust
      for (let i = 0; i < 480; i++) { step(); if (i % 10 === 9) await sync(); }
    } else {
      const t = g.teleports.find(t => t.name === ${JSON.stringify(v.tp)});
      g.placeVehicle(t.x, t.z, t.yaw);
      g.env.settle?.();
      for (let i = 0; i < 90; i++) { step(); if (i % 10 === 9) await sync(); }
      g.env.settle?.();
      g.setPaused(true); g.redraw = 1e9;
      for (let i = 0; i < 20; i++) { step(); await sync(); }
    }
    // batches of 10 frames, one wait per batch: the GPU queue stays fed, a vsync-bound wait counts once
    const ts = [];
    if (${raf}) {
      // the game's own loop: frame intervals from requestAnimationFrame for raf seconds
      g.holdLoop = false;
      const dts = []; let prev = 0, end = performance.now() + ${raf} * 1000;
      await new Promise(res => { const f = t => { if (prev) dts.push(t - prev); prev = t; if (t < end) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
      const tot = dts.reduce((a, b) => a + b, 0);
      dts.sort((a, b) => a - b);
      const ri = r.info.render;
      g.autopilot = null;
      return { raf: true, fps: dts.length / tot * 1000, med: dts[dts.length >> 1], p90: dts[Math.floor(dts.length * 0.9)], calls: ri.calls ?? ri.drawCalls, tris: ri.triangles, drive: !!drive, kmh: g.vehicle.speed * 3.6, dust: 0, scenes: 0 };
    }
    // check: how many times per frame the scene itself is drawn (view + shadow maps), so a skipped frame shows
    let scenes = 0; const own = Object.prototype.hasOwnProperty.call(r, 'render'), render0 = r.render; r.render = function (s, c) { if (s === g.scene) scenes++; return render0.call(this, s, c); };
    let last = null;
    for (let b = 0; b < ${frames} / 10; b++) {
      const a = performance.now();
      for (let i = 0; i < 10; i++) step();
      const ri = r.info.render; last = { calls: ri.drawCalls ?? ri.calls, tris: ri.triangles };   // before an animation frame resets it
      await sync();
      ts.push((performance.now() - a) / 10);
    }
    if (own) r.render = render0; else delete r.render;   // the old WebGLRenderer sets render in its constructor
    ts.sort((a, b) => a - b);
    r.info.autoReset = true;
    let dust = 0;
    for (let i = 0; i < g.dust.max; i++) if (g.dust.life[i] > 0) dust++;
    const kmh = g.vehicle.speed * 3.6;
    g.autopilot = null;
    g.holdLoop = false;
    return { med: ts[Math.floor(ts.length / 2)], p90: ts[Math.floor(ts.length * 0.9)], calls: last.calls, tris: last.tris, dust, kmh, drive: !!drive, scenes: scenes / ${frames} };
  })()`);
  if (res.raf) console.log(`${name.padEnd(14)} ${res.fps.toFixed(1).padStart(5)} fps  median ${res.med.toFixed(1).padStart(5)} ms  p90 ${res.p90.toFixed(1).padStart(5)} ms${res.drive ? `  ${res.kmh.toFixed(0)} km/h` : ''}`);
  else console.log(`${name.padEnd(14)} median ${res.med.toFixed(1).padStart(5)} ms  p90 ${res.p90.toFixed(1).padStart(5)} ms  calls ${String(res.calls).padStart(4)}  tris ${(res.tris / 1e6).toFixed(2)} M  scene ${res.scenes.toFixed(1)}x${res.drive ? `  ${res.kmh.toFixed(0)} km/h, dust ${res.dust}` : ''}`);
  if (out) {
    const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 85 });
    fs.writeFileSync(path.join(out, name + '.jpg'), Buffer.from(r.result.data, 'base64'));
  }
}
if (logs.length) console.log('LOGS>\n' + [...new Set(logs)].slice(0, 30).join('\n'));
await send('Page.navigate', { url: 'about:blank' });   // a parked page uses no GPU
ws.close();
