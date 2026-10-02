// Drive a headless Chrome over the DevTools protocol: viewport sizes, keys, clicks, JS, screenshots.
// Unlike the canvas capture in browser-snippets.js this captures the HTML HUD and menus too, at any
// window size (the browser pane's own screenshots break when it emulates a size larger than the pane).
//
// 1. Start Chrome once (real GPU, rAF not throttled):
//    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port=9333 \
//      --user-data-dir=/tmp/offroad-chrome --no-first-run about:blank &
// 2. node tools/cdp.mjs steps.json      (CDP_PORT=9334 node ... to talk to a Chrome on another port)
//    steps: [{ "viewport": [w, h, dpr?, mobile?] }, { "nav": "http://localhost:5174/" }, { "wait": ms },
//            { "eval": "js expression (awaited)" }, { "key": { "code": "KeyE", "key": "e", "vk": 69 } },
//            { "click": [x, y] }, { "cpu": 4 }, { "shot": "out.jpg", "clip": [x, y, w, h, scale?] },
//            { "poll": "expr", "ms": 8000, "every": 100, "shotAt": "text in result", "shotFile": "x.jpg" },
//            { "preload": "js run before page scripts" }, { "unpreload": true }]
//    The viewport override lasts for one run (one CDP session), so set it at the start of every steps file.
//    Console output and exceptions are printed at the end.
import fs from 'node:fs';
const steps = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const list = await (await fetch('http://127.0.0.1:' + (process.env.CDP_PORT || 9333) + '/json')).json();
let tgt = list.find(t => t.type === 'page');
const ws = new WebSocket(tgt.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pend = new Map(); const logs = [];
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  else if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.type + ': ' + m.params.args.map(a => a.value ?? a.description ?? '').join(' '));
  else if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
});
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Runtime.enable'); await send('Page.enable');
for (const s of steps) {
  if (s.viewport) { const [w, h, dpr = 1, mobile = false] = s.viewport; await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile }); }
  if (s.nav) { await send('Page.navigate', { url: s.nav }); }
  if (s.wait) await new Promise(r => setTimeout(r, s.wait));
  if (s.eval) {
    const r = await send('Runtime.evaluate', { expression: s.eval, awaitPromise: true, returnByValue: true, timeout: 60000 });
    const res = r.result?.result; const ex = r.result?.exceptionDetails;
    console.log('EVAL>', ex ? 'ERROR ' + (ex.exception?.description || ex.text) : JSON.stringify(res?.value));
  }
  if (s.preload) { const r = await send('Page.addScriptToEvaluateOnNewDocument', { source: s.preload }); s._pid = r.result.identifier; globalThis._pid = s._pid; }
  if (s.unpreload) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: globalThis._pid });
  if (s.cpu) await send('Emulation.setCPUThrottlingRate', { rate: s.cpu });
  if (s.poll) {
    const seen = []; const t0 = Date.now();
    while (Date.now() - t0 < (s.ms || 8000)) {
      const r = await send('Runtime.evaluate', { expression: s.poll, returnByValue: true });
      const v = JSON.stringify(r.result?.result?.value);
      if (seen[seen.length - 1]?.v !== v) seen.push({ t: Date.now() - t0, v });
      if (s.shotAt && !s._shot && v.includes(s.shotAt)) { s._shot = 1; const sr = await send('Page.captureScreenshot', { format: 'jpeg', quality: 85 }); fs.writeFileSync(s.shotFile, Buffer.from(sr.result.data, 'base64')); }
      await new Promise(r => setTimeout(r, s.every || 100));
    }
    console.log('POLL>\n' + seen.map(x => x.t + 'ms ' + x.v).join('\n'));
  }
  if (s.key) {
    for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, code: s.key.code, key: s.key.key, windowsVirtualKeyCode: s.key.vk || 0, text: type === 'keyDown' ? s.key.text : undefined });
  }
  if (s.click) {
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: s.click[0], y: s.click[1], button: 'left', clickCount: 1 });
  }
  if (s.shot) {
    const opt = { format: 'jpeg', quality: 88 }; if (s.clip) { const [x, y, width, height, scale = 2] = s.clip; opt.clip = { x, y, width, height, scale }; }
    const r = await send('Page.captureScreenshot', opt);
    fs.writeFileSync(s.shot, Buffer.from(r.result.data, 'base64'));
    console.log('SHOT>', s.shot);
  }
}
if (logs.length) console.log('LOGS>\n' + logs.join('\n'));
ws.close();
