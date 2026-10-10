// Where does the frame go? Loads the game at one view (tools/gfxbench.mjs VIEWS) and measures the frame with
// each system switched off in turn (the difference is that system's cost).
//   node tools/gfxprofile.mjs [preset=high] [view=forest] [frames=60]     (same Chrome / server as gfxbench)
import fs from 'node:fs';
const args = Object.fromEntries(process.argv.slice(2).map(a => a.split('=')));
const preset = args.preset || 'high', view = args.view || 'forest', frames = +(args.frames || 60);
const port = process.env.CDP_PORT || 9341, url = (process.env.URL || 'http://localhost:5181/') + '?t=' + Date.now();
const VIEWS = { meadow: ['Spawn', 13], forest: ['Pine forest', 13], ford: ['The ford', 13], lookout: ['Lookout', 13], forestNight: ['Pine forest', 23] };
const [tp, hour] = VIEWS[view];
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pend = new Map();
ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 120000 }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description); return r.result?.result?.value; };
await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 2, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('offroad.settings.v1', ${JSON.stringify(JSON.stringify({ autoPause: false, quality: preset, time: hour, hints: false }))}); localStorage.setItem('offroad.introSeen.v1', '1'); } catch {}` });
await send('Page.navigate', { url });
await evaluate(`new Promise((res) => { (function poll() { const l = document.getElementById('loading'); if (window.game && (!l || l.classList.contains('done'))) return res(1); setTimeout(poll, 200); })(); })`);
// the game compiles the other lamp state in the background after loading: let that finish first
await new Promise(r => setTimeout(r, 6000));
await evaluate(`(async () => {
  const g = game; g.setPaused(false);
  const t = g.teleports.find(t => t.name === ${JSON.stringify(tp)});
  g.placeVehicle(t.x, t.z, t.yaw);
  window.__sync = async () => { const r = g.renderer; if (r.backend.device) await r.backend.device.queue.onSubmittedWorkDone(); };
  // game.frame: a whole frame (three renders the scene pass once per node frame, see main.js); the rAF loop holds
  g.holdLoop = true;
  for (let i = 0; i < 90; i++) { g.frame(1 / 60); if (i % 10 === 9) await __sync(); }
  g.env.settle(); g.setPaused(true); g.redraw = 1e9;
  window.__measure = async () => { g.redraw = 1e9; for (let i = 0; i < 10; i++) { g.frame(1 / 60); } await __sync(); const ts = [];
    for (let b = 0; b < ${frames} / 10; b++) { const a = performance.now(); for (let i = 0; i < 10; i++) g.frame(1 / 60); await __sync(); ts.push((performance.now() - a) / 10); }
    ts.sort((a, b) => a - b); return ts[ts.length >> 1]; };
})()`);
const toggles = [
  ['all on', 'null'],
  ['grass off', `g.grass.group.visible = false; g.grass.configure({ ...g.gfx.q, vegetation: false })`],
  ['undergrowth off', `g.undergrowth.group.visible = false; g.undergrowth.configure({ ...g.gfx.q, vegetation: false })`],
  ['trees off', `g.trees.group.visible = false`],
  ['near trees off', `g.trees.near.forEach(n => { n.trunk.visible = n.crown.visible = false; })`],
  ['impostors off', `g.trees.impMesh.visible = false`],
  ['crowns off', `g.trees.near.forEach(n => { n.crown.visible = false; })`],
  ['trunks off', `g.trees.near.forEach(n => { n.trunk.visible = false; })`],
  ['crowns no recv', `g.trees.near.forEach(n => { n.crown.receiveShadow = false; })`],
  ['crown shadows off', `g.trees.near.forEach(n => { if (n.crownShadow) n.crownShadow.visible = false; })`],
  ['sun shadow off', `g.env.sun.castShadow = false`],
  ['terrain off', `g.terrainView.mesh.visible = false`],
  ['AO off', `g.pipeline.configure({ ssao: 'off' })`],
  ['shafts off', `g.pipeline.configure({ shafts: false })`],
  ['bloom off', `g.pipeline.params.bloom = false`],
  ['AA off', `g.pipeline.configure({ msaa: 0, aa: 'off' })`],
  ['water off', `g.water.group.visible = false`],
  ['car off', `g.model.root.visible = false`],
];
const restore = `g.applyGraphics(); g.grass.group.visible = g.undergrowth.group.visible = g.trees.group.visible = g.terrainView.mesh.visible = g.water.group.visible = g.model.root.visible = g.trees.impMesh.visible = true; g.trees.near.forEach(n => { n.trunk.visible = n.crown.visible = n.crown.receiveShadow = true; n.crown.castShadow = false; if (n.crownShadow) n.crownShadow.visible = true; }); g.env.sun.castShadow = !!g.gfx.q.shadows && g.gfx.q.shadows !== 'off'; g.pipeline.configure({ shafts: true });`;
console.log(`${preset} · ${view}`);
let base = 0;
for (const [name, code] of toggles) {
  const ms = await evaluate(`(async () => { const g = game; ${restore}; ${code}; return await __measure(); })()`);
  if (name === 'all on') base = ms;
  console.log(`${name.padEnd(16)} ${ms.toFixed(1).padStart(5)} ms${name === 'all on' ? '' : `   saves ${(base - ms).toFixed(1)}`}`);
}
await evaluate(`(async () => { const g = game; ${restore}; })()`);
ws.close();
