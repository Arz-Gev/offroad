import { escapeHTML } from './hud.js';

// The loading screen (#loading in index.html): progress text and bar, and the error box if the start fails.

const loading = document.getElementById('loading');
export const loadLog = [];   // [stage, ms since navigation]

export function setLoading(text, p) {
  loadLog.push([text, Math.round(performance.now())]);
  loading.querySelector('.ld-t').textContent = text;
  if (p !== undefined) loading.style.setProperty('--p', p);
}

// Yield so the loading text can paint; the timeout keeps loading going in a hidden tab (rAF throttled)
export const frame = () => new Promise(r => {
  let done = false;
  const go = () => { if (!done) { done = true; r(); } };
  requestAnimationFrame(() => setTimeout(go, 0));
  setTimeout(go, 60);
});

export function hideLoading() {
  loading.classList.add('done');
  setTimeout(() => loading.remove(), 600);
}

export function showError(e) {
  console.error(e);
  const msg = String(e && e.message || e);
  const webgl = /webgl|webgpu|context|adapter/i.test(msg);
  loading.classList.remove('done');
  loading.classList.add('error');
  setLoading('Could not start the game');
  const box = loading.querySelector('.ld-err');
  box.hidden = false;
  box.innerHTML = (webgl
    ? 'Neither WebGPU nor WebGL 2 is available. Turn on hardware acceleration in the browser settings, or try another browser.'
    : escapeHTML(msg)) + '<br><button type="button">Reload</button>';
  box.querySelector('button').addEventListener('click', () => location.reload());
}
