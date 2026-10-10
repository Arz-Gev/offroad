// Screenshots at fixed views for before / after comparisons of a rendering change: the wind stopped, the game
// paused, the camera settled, same frame count every run. Same Chrome / server as gfxbench.
//   node tools/gfxshots.mjs out=dir [preset=high] [views=all|meadow,...] [size=1920x1080@2]
// Compare two runs: node tools/gfxshots.mjs diff=dirA,dirB out=dirDiff (needs nothing else: the diff runs in Chrome).
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map(a => a.split('=')));
const port = process.env.CDP_PORT || 9341;
const out = args.out || 'shots';
fs.mkdirSync(out, { recursive: true });

// view: teleport, hour, camera mode, head lamps, chase camera turned by orbit [yaw, pitch, distance]
const VIEWS = {
  meadow: { tp: 'Spawn', hour: 13 },
  car: { tp: 'Spawn', hour: 16, orbit: [2.3, 0.1, 6] },
  forest: { tp: 'Pine forest', hour: 13 },
  forestCockpit: { tp: 'Pine forest', hour: 13, cam: 'cockpit' },
  hood: { tp: 'Pine forest', hour: 13, cam: 'hood' },
  ford: { tp: 'The ford', hour: 13 },
  hut: { tp: 'Ruined hut', hour: 18.25 },
  lookout: { tp: 'Lookout', hour: 13 },
  forestNight: { tp: 'Pine forest', hour: 23, lights: 1 },
};

const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pend = new Map(); const logs = [];
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  else if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
});
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 180000 }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text); return r.result?.result?.value; };
await send('Runtime.enable'); await send('Page.enable');

if (args.diff) {
  // per pixel |a - b| (amplified x4) and the share of pixels that differ by more than 8 / 255
  const [a, b] = args.diff.split(',');
  await send('Page.navigate', { url: 'about:blank' });
  for (const f of fs.readdirSync(a).filter(f => f.endsWith('.png'))) {
    if (!fs.existsSync(path.join(b, f))) continue;
    const da = fs.readFileSync(path.join(a, f)).toString('base64'), db = fs.readFileSync(path.join(b, f)).toString('base64');
    const res = await evaluate(`(async () => {
      const load = async (s) => { const i = new Image(); i.src = 'data:image/png;base64,' + s; await i.decode(); return i; };
      const A = await load(${JSON.stringify(da)}), B = await load(${JSON.stringify(db)});
      const w = A.width, h = A.height, c = new OffscreenCanvas(w, h), x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(A, 0, 0); const pa = x.getImageData(0, 0, w, h);
      x.drawImage(B, 0, 0); const pb = x.getImageData(0, 0, w, h);
      let n = 0, sum = 0;
      for (let i = 0; i < pa.data.length; i += 4) {
        let m = 0;
        for (let k = 0; k < 3; k++) { const d = Math.abs(pa.data[i + k] - pb.data[i + k]); m = Math.max(m, d); pa.data[i + k] = Math.min(255, d * 4); }
        pa.data[i + 3] = 255; sum += m; if (m > 8) n++;
      }
      x.putImageData(pa, 0, 0);
      const blob = await c.convertToBlob({ type: 'image/png' });
      const buf = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 32768) s += String.fromCharCode(...buf.subarray(i, i + 32768));
      return { png: btoa(s), share: n / (w * h), mean: sum / (w * h) };
    })()`);
    fs.writeFileSync(path.join(out, f), Buffer.from(res.png, 'base64'));
    console.log(`${f.padEnd(20)} ${(res.share * 100).toFixed(2).padStart(6)} % of pixels differ by > 8, mean ${res.mean.toFixed(2)}`);
  }
  ws.close();
  process.exit(0);
}

const preset = args.preset || 'high';
const [sw, rest] = (args.size || '1920x1080@2').split('x');
const [sh, sdpr] = rest.split('@');
const names = !args.views || args.views === 'all' ? Object.keys(VIEWS) : args.views.split(',');
await send('Emulation.setDeviceMetricsOverride', { width: +sw, height: +sh, deviceScaleFactor: +sdpr, mobile: false });
const settings = { autoPause: false, quality: preset, time: 13, hints: false, muted: true, hudScale: 0 };
await send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('offroad.settings.v1', ${JSON.stringify(JSON.stringify(settings))}); localStorage.setItem('offroad.introSeen.v1', '1'); } catch {}` });
await send('Page.navigate', { url: (process.env.URL || 'http://localhost:5181/') + '?t=' + Date.now() + (process.env.PARAMS ? '&' + process.env.PARAMS : '') });
await evaluate(`new Promise((res, rej) => { (function poll() { const l = document.getElementById('loading'); if (window.game && (!l || l.classList.contains('done'))) return res(1); if (l && l.classList.contains('error')) return rej(new Error(l.textContent)); setTimeout(poll, 200); })(); })`);
await new Promise(r => setTimeout(r, 6000));
await evaluate(`(() => { document.getElementById('hud').style.display = 'none'; })()`);
for (const name of names) {
  const v = VIEWS[name];
  await evaluate(`(async () => {
    const g = game, frame = g.frame || g.tick;
    g.holdLoop = true; g.setPaused(false); g.autopilot = null;
    g.settings.set('time', ${v.hour}, { silent: true });
    g.settings.set('camera', ${JSON.stringify(v.cam || 'chase')}, { silent: true });
    g.view.lights.head = ${v.lights ?? 0};
    const t = g.teleports.find(t => t.name === ${JSON.stringify(v.tp)});
    g.placeVehicle(t.x, t.z, t.yaw);
    g.grass.shared.uWind.value.z = 0;
    const o = ${JSON.stringify(v.orbit || null)}, dist = (window.__dist0 ??= g.rig.dist);
    g.input.mouse.lastMove = o ? 1e15 : 0;   // not idle: the chase camera keeps the orbit offset
    for (let i = 0; i < 120; i++) { if (o) { g.rig.orbitYaw = o[0]; g.rig.orbitPitch = o[1]; g.rig.dist = o[2]; } else g.rig.dist = dist; frame(1 / 60); }
    g.env.settle?.(); g.setPaused(true); g.redraw = 1e9;
    for (let i = 0; i < 30; i++) frame(1 / 60);
    g.env.settle?.();
    for (let i = 0; i < 4; i++) frame(1 / 60);
  })()`);
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(r.result.data, 'base64'));
  console.log('shot', name);
}
await evaluate(`(() => { game.holdLoop = false; })()`);
await send('Page.navigate', { url: 'about:blank' });
if (logs.length) console.log('LOGS>\n' + [...new Set(logs)].slice(0, 20).join('\n'));
ws.close();
