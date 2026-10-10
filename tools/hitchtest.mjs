// Hitch test: per-frame timing around lamp switches and the time-of-day sweep (N key), to catch freezes
// (shader rebuilds when the set of lights or the environment texture changes, see DEVNOTES "Never change
// the set of lights"). Same setup as tools/gfxbench.mjs (dev server on 5181, headless Chrome on 9341).
//   node tools/hitchtest.mjs [preset]      env: URL, PARAMS (e.g. "webgl=1")
// Each line: median and worst frame (ms, until the GPU is done; cpu = time inside game.frame) and how many
// frames took over 50 ms.
const port = process.env.CDP_PORT || 9341, url = process.env.URL || 'http://localhost:5181/';
const preset = process.argv[2] || 'high';
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pend = new Map(); const logs = [];
ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } else if (m.method === 'Runtime.exceptionThrown') logs.push(m.params.exceptionDetails.exception?.description); });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true, timeout: 300000 }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description); return r.result?.result?.value; };
await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 2, mobile: false });
const settings = { autoPause: false, quality: preset, time: 13, hints: false, muted: true };
await send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('offroad.settings.v1', ${JSON.stringify(JSON.stringify(settings))}); localStorage.setItem('offroad.introSeen.v1', '1'); } catch {}` });
await send('Page.navigate', { url: url + (url.includes('?') ? '&' : '?') + 't=' + Date.now() + (process.env.PARAMS ? '&' + process.env.PARAMS : '') });
await ev(`new Promise(res => { (function p() { const l = document.getElementById('loading'); if (window.game && (!l || l.classList.contains('done'))) return res(1); setTimeout(p, 200); })(); })`);
await new Promise(r => setTimeout(r, 8000));
const res = await ev(`(async () => {
  const g = game, r = g.renderer;
  // WebGPU: the queue; WebGL: a 1-pixel read of the canvas waits for the GPU
  const gl = r.backend ? null : r.getContext(), px = new Uint8Array(4);
  const sync = async () => { if (r.backend?.device) return r.backend.device.queue.onSubmittedWorkDone(); if (gl) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };
  const frame = g.frame || ((dt) => g.tick(dt));
  g.holdLoop = true; g.setPaused(false);
  const t = g.teleports[0]; g.placeVehicle(t.x, t.z, t.yaw);
  const run = async (n) => { const out = []; for (let i = 0; i < n; i++) { const a = performance.now(); frame(1 / 60); const c = performance.now(); await sync(); out.push([c - a, performance.now() - a]); } return out; };
  const sum = (name, f) => { const tot = f.map(x => x[1]).sort((a, b) => a - b); const worst = f.reduce((m, x) => x[1] > m[1] ? x : m, [0, 0]);
    return name.padEnd(26) + ' median ' + tot[tot.length >> 1].toFixed(1) + '  worst ' + worst[1].toFixed(0) + ' ms (cpu ' + worst[0].toFixed(0) + ')  >50ms: ' + f.filter(x => x[1] > 50).length; };
  const L = g.view.lights, lines = [];
  const setTime = (h) => { g.settings.set('time', h, { silent: true }); };
  await run(60);
  setTime(13); await run(30); lines.push(sum('day, lamps off', await run(60)));
  L.head = 1; lines.push(sum('day: lamps ON (1st)', await run(60)));
  lines.push(sum('day, lamps on, steady', await run(60)));
  L.head = 0; lines.push(sum('day: lamps OFF', await run(60)));
  L.head = 1; lines.push(sum('day: lamps ON (2nd)', await run(60)));
  L.head = 0; await run(30);
  setTime(23); lines.push(sum('jump to night (instant)', await run(60)));
  lines.push(sum('night, lamps off, steady', await run(60)));
  L.head = 1; lines.push(sum('night: lamps ON', await run(60)));
  lines.push(sum('night, lamps on, steady', await run(60)));
  L.head = 2; lines.push(sum('night: high beam', await run(60)));
  L.head = 0; lines.push(sum('night: lamps OFF', await run(60)));
  setTime(13); await run(60);
  g.settings.set('time', 23, { animate: true, silent: true }); lines.push(sum('sweep day -> night (N)', await run(200)));
  g.settings.set('time', 13, { animate: true, silent: true }); lines.push(sum('sweep night -> day (N)', await run(200)));
  g.holdLoop = false;
  return lines.join('\\n');
})()`);
console.log(preset + '\n' + res);
if (logs.length) console.log('EXC', logs.slice(0, 5));
await send('Page.navigate', { url: 'about:blank' });   // a parked page uses no GPU
ws.close();
