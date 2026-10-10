// Where does the WebGL frame go? Loads the game at one view and prints, per pass (sun / lamp shadow maps, scene,
// AO, exposure, bloom, composite, other renders such as the sky and the probe): draw calls and the page
// JavaScript spent issuing them; then the frame time with each system switched off in turn (the difference is
// that system's cost). GPU timer queries are useless here: on the M1 Pro (ANGLE on Metal) they report 4-7x the
// real frame time.
//   node tools/glprofile.mjs [preset=high] [view=forest] [frames=60] [toggles=0]     (same Chrome / server as gfxbench)
// view: meadow, forest, ford, lookout, forestNight, drive (the truck on the main trail at 50 km/h).
const args = Object.fromEntries(process.argv.slice(2).map(a => a.split('=')));
const preset = args.preset || 'high', view = args.view || 'forest', frames = +(args.frames || 60);
const port = process.env.CDP_PORT || 9341, url = (process.env.URL || 'http://localhost:5181/') + '?t=' + Date.now();
const VIEWS = { meadow: ['Spawn', 13], forest: ['Pine forest', 13], ford: ['The ford', 13], lookout: ['Lookout', 13], forestNight: ['Pine forest', 23], drive: [null, 13] };
const [tp, hour] = VIEWS[view];
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pend = new Map();
ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 180000 }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text); return r.result?.result?.value; };
await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 2, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('offroad.settings.v1', ${JSON.stringify(JSON.stringify({ autoPause: false, quality: preset, time: hour, hints: false, muted: true }))}); localStorage.setItem('offroad.introSeen.v1', '1'); } catch {}` });
await send('Page.navigate', { url });
await evaluate(`new Promise((res) => { (function poll() { const l = document.getElementById('loading'); if (window.game && (!l || l.classList.contains('done'))) return res(1); setTimeout(poll, 200); })(); })`);
await new Promise(r => setTimeout(r, 6000));
await evaluate(`(async () => {
  const g = game, r = g.renderer, gl = r.getContext();
  const px = new Uint8Array(4);
  window.__sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  g.holdLoop = true; g.setPaused(false);
  g.settings.set('time', ${hour}, { silent: true });
  if (${JSON.stringify(tp)}) {
    const t = g.teleports.find(t => t.name === ${JSON.stringify(tp)});
    g.placeVehicle(t.x, t.z, t.yaw);
    for (let i = 0; i < 90; i++) { g.frame(1 / 60); if (i % 10 === 9) __sync(); }
    g.env.settle(); g.setPaused(true); g.redraw = 1e9;
  } else {
    // the gfxbench drive view: pure pursuit along the main trail at 50 km/h
    const curve = g.terrain.trailCurves[0], N = 2000, pts = curve.getSpacedPoints(N), seg = curve.getLength() / N;
    const a = pts[0], b = pts[4];
    g.placeVehicle(a.x, a.z, Math.atan2(b.x - a.x, b.z - a.z));
    if (g.vehicle.fwd.x * (b.x - a.x) + g.vehicle.fwd.z * (b.z - a.z) < 0) g.placeVehicle(a.x, a.z, Math.atan2(b.x - a.x, b.z - a.z) + Math.PI);
    g.autopilot = (v) => {
      let best = 0, bd = 1e9;
      for (let i = 0; i < N; i += 2) { const d = (pts[i].x - v.pos.x) ** 2 + (pts[i].z - v.pos.z) ** 2; if (d < bd) { bd = d; best = i; } }
      const tgt = pts[(best + Math.round(Math.max(8, Math.abs(v.speed) * 0.9) / seg)) % N];
      const dx = tgt.x - v.pos.x, dz = tgt.z - v.pos.z;
      const steer = Math.max(-1, Math.min(1, Math.atan2(dx * v.right.x + dz * v.right.z, dx * v.fwd.x + dz * v.fwd.z) * 2));
      const sp = v.speed * 3.6;
      return { throttle: sp < 50 ? 0.75 : 0, brake: sp > 58 ? 0.5 : 0, steer, clutch: 0, handbrake: 0, analogSteer: true };
    };
    for (let i = 0; i < 480; i++) { g.frame(1 / 60); if (i % 10 === 9) __sync(); }
  }
  window.__measure = async (n = ${frames}) => { g.redraw = 1e9; for (let i = 0; i < 10; i++) g.frame(1 / 60); __sync(); const ts = [];
    for (let b = 0; b < n / 10; b++) { const a = performance.now(); for (let i = 0; i < 10; i++) g.frame(1 / 60); __sync(); ts.push((performance.now() - a) / 10); }
    ts.sort((a, b) => a - b); return ts[ts.length >> 1]; };
})()`);

// ---- per pass: draw calls and JavaScript time
const passes = await evaluate(`(async () => {
  const g = game, r = g.renderer, gl = r.getContext(), info = r.info.render, p = g.pipeline, sm = r.shadowMap;
  const S = {}, at = (l) => S[l] || (S[l] = { calls: 0, js: 0 });
  let cur = null, c0 = 0, j0 = 0;
  const sw = (label) => {
    const now = performance.now();
    if (cur) { const s = at(cur); s.calls += info.calls - c0; s.js += now - j0; }
    cur = label; c0 = info.calls; j0 = now;
  };
  const PASS = new Map([[p.aoMat, 'ao'], [p.aoBlurMat, 'ao'], [p.lumMat, 'exposure'], [p.adaptMat, 'exposure'], [p.downMat, 'bloom'], [p.upMat, 'bloom'], [p.compMat, 'composite'], [p.fxaaMat, 'composite']]);
  const pass0 = p.pass, smr = sm.render, render0 = r.render, own = Object.prototype.hasOwnProperty.call(r, 'render');
  p.pass = function (m, t) { sw(PASS.get(m) || 'post-other'); pass0.call(this, m, t); sw('other'); };
  sm.render = function (lights, ...a) {
    if (!lights || !lights.length || !sm.enabled) return smr.call(sm, lights, ...a);
    const back = cur;
    const sun = lights.filter(l => l.isSunLight || l.isDirectionalLight), rest = lights.filter(l => !(l.isSunLight || l.isDirectionalLight));
    sw('shadow:sun'); smr.call(sm, sun, ...a);
    if (rest.length) { sw('shadow:lamps'); smr.call(sm, rest, ...a); }
    sw(back);
  };
  r.render = function (s, c) { if (s === g.scene) { sw('scene'); render0.call(this, s, c); sw('other'); } else render0.call(this, s, c); };
  const n = ${frames};
  let jsFrame = 0;
  for (let i = 0; i < n; i++) {
    const a = performance.now();
    r.info.reset(); sw('other'); g.frame(1 / 60); sw(null);
    jsFrame += performance.now() - a;
    if (i % 10 === 9) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  }
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  p.pass = pass0; sm.render = smr; if (own) r.render = render0; else delete r.render;
  const out = {};
  for (const [l, s] of Object.entries(S)) out[l] = { calls: s.calls / n, js: s.js / n };
  return { out, jsFrame: jsFrame / n };
})()`);
const frameMs = await evaluate('__measure()');
console.log(`${preset} · ${view} · frame ${frameMs.toFixed(1)} ms (CPU + GPU, whichever is slower) · page JS ${passes.jsFrame.toFixed(1)} ms`);
console.log('pass              draws   JS ms');
let tc = 0, tj = 0;
for (const [l, s] of Object.entries(passes.out).sort((a, b) => b[1].calls - a[1].calls)) {
  tc += s.calls; tj += s.js;
  console.log(`${l.padEnd(16)} ${s.calls.toFixed(0).padStart(6)} ${s.js.toFixed(2).padStart(7)}`);
}
console.log(`${'total'.padEnd(16)} ${tc.toFixed(0).padStart(6)} ${tj.toFixed(2).padStart(7)}`);

if (args.toggles !== '0') {
  const toggles = [
    ['all on', 'null'],
    ['grass off', `g.grass.group.visible = false`],
    ['undergrowth off', `g.undergrowth.group.visible = false`],
    ['trees off', `g.trees.group.visible = false`],
    ['near trees off', `g.trees.near.forEach(n => { n.trunk.visible = n.crown.visible = false; })`],
    ['impostors off', `g.trees.impMesh.visible = false`],
    ['crowns off', `g.trees.near.forEach(n => { n.crown.visible = false; })`],
    ['crowns no cast', `g.trees.near.forEach(n => { n.crown.castShadow = false; })`],
    ['trunks off', `g.trees.near.forEach(n => { n.trunk.visible = false; })`],
    ['imp. no cast', `g.trees.impMesh.castShadow = false`],
    ['sun shadow off', `g.env.sun.castShadow = false`],
    ['terrain off', `g.terrainView.mesh.visible = false`],
    ['props off', `g.props.visible = false`],
    ['AO off', `g.pipeline.configure({ ssao: 'off' })`],
    ['bloom off', `g.pipeline.params.bloom = false`],
    ['water off', `g.water.group.visible = false`],
    ['car off', `g.model.root.visible = false`],
  ];
  const restore = `g.applyGraphics(); for (const o of [g.grass.group, g.undergrowth.group, g.trees.group, g.terrainView.mesh, g.water.group, g.model.root, g.trees.impMesh, g.props]) o.visible = true; g.trees.near.forEach(n => { n.trunk.visible = n.crown.visible = true; n.crown.castShadow = true; }); g.scenery.configure(g.gfx.q); g.grass.update(0, g.camera); g.undergrowth.update(0, g.camera);`;
  let base = 0;
  for (const [name, code] of toggles) {
    const ms = await evaluate(`(async () => { const g = game; ${restore}; ${code}; return await __measure(); })()`);
    if (name === 'all on') base = ms;
    console.log(`${name.padEnd(16)} ${ms.toFixed(1).padStart(5)} ms${name === 'all on' ? '' : `   saves ${(base - ms).toFixed(1)}`}`);
  }
  await evaluate(`(async () => { const g = game; ${restore}; })()`);
}
await evaluate(`(() => { game.autopilot = null; game.holdLoop = false; })()`);
await send('Page.navigate', { url: 'about:blank' });
ws.close();
