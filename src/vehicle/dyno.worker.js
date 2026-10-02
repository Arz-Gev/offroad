import RAPIER from '@dimforge/rapier3d-compat';
import { accelRun } from './dyno.js';

let ready = null;
self.onmessage = async e => {
  if (!ready) ready = RAPIER.init();
  await ready;
  const { id, P, opts } = e.data;
  try {
    const it = accelRun(RAPIER, P, opts);
    let r;
    while (!(r = it.next()).done) self.postMessage({ id, progress: r.value });
    self.postMessage({ id, done: r.value });
  } catch (err) { self.postMessage({ id, error: String(err && err.message || err) }); }
};
