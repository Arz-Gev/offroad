// Graphics benchmark: fixed viewpoints across the map, frame time per view, screenshots.
// Works with any renderer the game uses (WebGL or WebGPU): every frame is rendered and then waited for
// in batches of 10 (WebGPU: queue.onSubmittedWorkDone, WebGL: a 1-pixel readPixels), so the number is the
// real cost of a frame (CPU + GPU, whichever is slower), not the rAF rate.
//
// 1. A dev server (npx vite --port 5181 --strictPort) and a headless Chrome with a real GPU:
//    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port=9341 \
//      --user-data-dir=/tmp/offroad-chrome-9341 --no-first-run --enable-unsafe-webgpu about:blank &
// 2. node tools/gfxbench.mjs [preset=high] [views=all|forest,meadow,...] [frames=90] [out=dir] [size=1920x1080@2]
//    env: CDP_PORT (9341), URL (http://localhost:5181/), PARAMS (extra query string, e.g. "webgl=1")
// Prints one line per view: median / p90 frame ms (of the 10-frame batches), draw calls, triangles; writes <out>/<view>.jpg.
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map(a => a.split('=')));
const preset = args.preset || 'high';
const frames = +(args.frames || 90);
const out = args.out || null;
const [sw, rest] = (args.size || '1920x1080@2').split('x');
const [sh, sdpr] = rest.split('@');
const port = process.env.CDP_PORT || 9341;
const url = (process.env.URL || 'http://localhost:5181/') + (process.env.PARAMS ? '?' + process.env.PARAMS : '');

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
await send('Emulation.setDeviceMetricsOverride', { width: +sw, height: +sh, deviceScaleFactor: +sdpr, mobile: false });
const settings = { autoPause: false, quality: preset, time: 13, hints: false };
await send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('offroad.settings.v1', ${JSON.stringify(JSON.stringify(settings))}); localStorage.setItem('offroad.introSeen.v1', '1'); } catch {}` });
const t0 = Date.now();
await send('Page.navigate', { url });
await evaluate(`new Promise((res, rej) => { const t = Date.now(); (function poll() {
  const l = document.getElementById('loading');
  if (window.game && (!l || l.classList.contains('done'))) return res(true);
  if (l && l.classList.contains('error')) return rej(new Error(l.textContent));
  if (Date.now() - t > 110000) return rej(new Error('load timeout'));
  setTimeout(poll, 200); })(); })`);
const backend = await evaluate(`(() => { const r = game.renderer; return r.backend ? (r.backend.isWebGPUBackend ? 'webgpu' : 'webgl2 (fallback)') : 'webgl (old renderer)'; })()`);
console.log(`loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s · ${backend} · preset ${preset} · ${sw}x${sh}@${sdpr}`);
if (out) fs.mkdirSync(out, { recursive: true });

for (const name of names) {
  const v = VIEWS[name];
  if (!v) { console.log(`unknown view ${name}`); continue; }
  const res = await evaluate(`(async () => {
    const g = game, sync = async () => {
      const r = g.renderer;
      if (r.backend && r.backend.device) await r.backend.device.queue.onSubmittedWorkDone();
      else { const gl = r.getContext(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); }
    };
    g.menu.isOpen && g.menu.close?.();
    g.setPaused(false);
    const t = g.teleports.find(t => t.name === ${JSON.stringify(v.tp)});
    g.settings.set('time', ${v.hour}, { silent: true });
    g.settings.set('camera', ${JSON.stringify(v.cam || 'chase')}, { silent: true });
    g.view.lights.head = ${v.lights ?? 0};
    g.placeVehicle(t.x, t.z, t.yaw);
    g.env.settle?.();
    for (let i = 0; i < 90; i++) { g.tick(1 / 60); if (i % 10 === 9) await sync(); }
    g.env.settle?.();
    g.setPaused(true); g.redraw = 1e9;
    for (let i = 0; i < 20; i++) { g.tick(1 / 60); await sync(); }
    // batches of 10 frames, one wait per batch: the GPU queue stays fed, a vsync-bound wait counts once
    const ts = [];
    for (let b = 0; b < ${frames} / 10; b++) {
      const a = performance.now();
      for (let i = 0; i < 10; i++) g.tick(1 / 60);
      await sync();
      ts.push((performance.now() - a) / 10);
    }
    ts.sort((a, b) => a - b);
    const info = g.renderer.info.render;
    return { med: ts[Math.floor(ts.length / 2)], p90: ts[Math.floor(ts.length * 0.9)], calls: info.drawCalls ?? info.calls, tris: info.triangles };
  })()`);
  console.log(`${name.padEnd(14)} median ${res.med.toFixed(1).padStart(5)} ms  p90 ${res.p90.toFixed(1).padStart(5)} ms  calls ${String(res.calls).padStart(4)}  tris ${(res.tris / 1e6).toFixed(2)} M`);
  if (out) {
    const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 85 });
    fs.writeFileSync(path.join(out, name + '.jpg'), Buffer.from(r.result.data, 'base64'));
  }
}
if (logs.length) console.log('LOGS>\n' + [...new Set(logs)].slice(0, 30).join('\n'));
ws.close();
