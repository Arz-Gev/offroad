import * as THREE from 'three/webgpu';
import { rbox, bar, frame, mergeStatic } from './geom.js';

// Parts any car can carry, placed by its look (body frame).
//
// lightBar: a roof light bar: a black crossbar on two feet, `lamps` square lamps across `width` (lens
// role 'bar') and the bar beam just ahead of them. spec: { at: [x, y, z] (the lamps' centre), width,
// lamps, roof (the y the feet stand on) }.
export function lightBar(mats, spec) {
  const g = new THREE.Group();
  const [x0, y, z] = spec.at, n = spec.lamps ?? 4, half = spec.width / 2;
  const add = o => { g.add(o); return o; };
  add(bar([x0 - half, y - 0.075, z + 0.03], [x0 + half, y - 0.075, z + 0.03], 0.02, mats.blackMetal, 8));
  for (const s of [-1, 1]) add(bar([x0 + s * (half - 0.06), y - 0.075, z + 0.03], [x0 + s * (half - 0.02), spec.roof, z + 0.08], 0.018, mats.blackMetal, 8));
  for (let k = 0; k < n; k++) {
    const x = x0 - half + 0.09 + (2 * half - 0.18) * (n === 1 ? 0.5 : k / (n - 1));
    add(rbox(0.18, 0.135, 0.1, 0.02, mats.black, x, y, z));
    add(rbox(0.012, 0.05, 0.04, 0.004, mats.black, x, y - 0.075, z + 0.02));
    add(frame(-0.07, -0.051, 0.07, 0.051, 0.01, 0.008, 0.014, mats.chrome)).position.set(x, y, z - 0.05);
    add(rbox(0.142, 0.104, 0.014, 0.006, mats.barLens, x, y, z - 0.048)).castShadow = false;
  }
  mergeStatic(g);
  return { group: g, beam: [x0, y, z - 0.12], lenses: { bar: [mats.barLens] } };
}
