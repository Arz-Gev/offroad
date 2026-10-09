import * as THREE from 'three';
import { SPAWN, LANES, HILL, POI } from './world/terrain.js';
import { rideRaise } from './vehicle/tuning.js';

// Putting the vehicle somewhere: the menu's locations, teleports and Recover (R).
// ctx: { RAPIER, world, terrain, vehicle, trees, props, onPlaced() }.
export function createPlacement({ RAPIER, world, terrain, vehicle, trees, props, onPlaced }) {
  function trailSpot(x, z, back = 0) {
    let best = null, bd = Infinity;
    for (const c of terrain.trailCurves) {
      const n = Math.round(c.getLength() / 2), pts = c.getSpacedPoints(n);
      for (let k = 0; k <= n; k++) { const d = (pts[k].x - x) ** 2 + (pts[k].z - z) ** 2; if (d < bd) { bd = d; best = { pts, k, n }; } }
    }
    const { pts, k } = best, k0 = Math.max(0, k - Math.round(back / 2)), k1 = Math.min(pts.length - 1, k0 + 3);
    const p = pts[k0], q = pts[k1];
    return { x: p.x, z: p.z, yaw: Math.atan2(-(q.x - p.x), -(q.z - p.z)) };
  }
  // menu Locations tab (x, z, yaw also used by tools/browser-snippets.js)
  const teleports = [
    { name: 'Spawn', tag: 'Trail', title: 'Spawn', desc: 'Start of the trail loop: ruts, a mud hole and a branch towards the hills.', x: SPAWN.x, z: SPAWN.z, yaw: 0 },
    { name: 'Axle twister', tag: 'Proving ground · lane A', title: 'Axle twister and whoops', desc: 'Offset humps that lift one wheel at a time. Watch the axle articulation.', x: LANES.A, z: 47, yaw: 0 },
    { name: 'Steps and logs', tag: 'Proving ground · lane B', title: 'Steps and logs', desc: 'Ledges from 15 to 45 cm, then logs. Low range and a slow approach.', x: LANES.B, z: 47, yaw: 0 },
    { name: 'Rock garden', tag: 'Proving ground · lane C', title: 'Rock garden', desc: 'Boulders. Needs low range, lockers and a careful line.', x: LANES.C, z: 47, yaw: 0 },
    { name: 'Ramps', tag: 'Proving ground · lane D', title: 'Ramps 20° / 30° / 35°', desc: 'Climbs in low range. The steepest needs the centre diff locked.', x: LANES.D, z: 47, yaw: 0 },
    { name: 'Mud and off-camber', tag: 'Proving ground · lane E', title: 'Mud and off-camber', desc: 'A deep mud hole and a side slope. Air down and keep momentum.', x: LANES.E, z: 47, yaw: 0 },
    { name: 'The big hill', tag: 'Hill', title: 'The big hill', desc: 'A long climb with views over the whole map.', x: HILL.x - 52, z: HILL.z + 8, yaw: -Math.PI / 2 },
    { name: 'Lake shore', tag: 'Outer loop · east', title: 'Lake shore', desc: 'A sandy beach on the lake. Splash through the shallows along the shore.', x: 386, z: 44, yaw: Math.atan2(-(POI.lake.x - 386), -(POI.lake.z - 44)) },
    { name: 'The ford', tag: 'Outer loop · north-east', title: 'The ford', desc: 'The trail crosses the stream: 30 cm of water over gravel. Keep it slow and steady.', ...trailSpot(POI.ford.x, POI.ford.z, 35) },
    { name: 'Ruined hut', tag: 'Outer loop · south', title: 'Ruined hut', desc: 'An old stone hut in the meadows, off the long southern straight.', ...trailSpot(POI.hut.x, POI.hut.z, 40) },
    { name: 'Old quarry', tag: 'South-west', title: 'Old quarry', desc: 'A gravel pit with terraced walls. Loose ground, room to play.', x: POI.quarry.x + 10, z: POI.quarry.z + 6, yaw: Math.PI / 2 },
    { name: 'Lookout', tag: 'Peak · spiral spur', title: 'Lookout summit', desc: 'The top of the spiral track: the whole map and the ranges beyond.', ...trailSpot(POI.lookout.x, POI.lookout.z, 14) },
    { name: 'Pine forest', tag: 'Outer loop · north', title: 'Pine forest', desc: 'The trail through the dense northern forest. Lovely with the headlights at night.', ...trailSpot(POI.forest.x, POI.forest.z, 0) },
  ];

  const nearestLocation = () => {
    let best = -1, bd = 25 * 25;
    teleports.forEach((t, i) => { const dd = (t.x - vehicle.pos.x) ** 2 + (t.z - vehicle.pos.z) ** 2; if (dd < bd) { bd = dd; best = i; } });
    return best;
  };

  const streamAround = (x, z) => {
    trees.updatePhysics(x, z);
    props.userData.stream.update(x, z);
    world.step();   // queries see streamed colliders only after a step
  };
  const placeVehicle = (x, z, yaw, lift = 0.5) => {
    let y = terrain.heightAt(x, z);
    for (const dx of [-1.5, 1.5]) for (const dz of [-2.2, 2.2]) y = Math.max(y, terrain.heightAt(x + dx, z + dz));
    streamAround(x, z);
    vehicle.reset({ x, y: y + lift + rideRaise(vehicle.P), z }, yaw);
    onPlaced();
  };

  // How the truck would stand at (x, z) facing yaw: tilted to a ground plane fitted under its wheels,
  // just above the tyres' touch (a bump under a wheel or the belly lifts it).
  const _sR = new THREE.Vector3(), _sB = new THREE.Vector3(), _sU = new THREE.Vector3(), _sM = new THREE.Matrix4();
  const standAt = (x, z, yaw) => {
    const P = vehicle.P, s = Math.sin(yaw), c = Math.cos(yaw), t2 = P.track / 2;
    const h = (lx, lz) => terrain.heightAt(x + lx * c + lz * s, z - lx * s + lz * c);
    // plane h = a + b * lx + d * lz: b from the side-to-side tilt of each axle, d from the axles' heights
    const ax = P.axles.map(a => ({ z: a.z, l: h(-t2, a.z), r: h(t2, a.z) }));
    const n = ax.length, mz = ax.reduce((m, a) => m + a.z, 0) / n, mh = ax.reduce((m, a) => m + (a.l + a.r) / 2, 0) / n;
    const b = ax.reduce((m, a) => m + (a.r - a.l) / P.track, 0) / n;
    let num = 0, den = 0;
    for (const a of ax) { num += (a.z - mz) * ((a.l + a.r) / 2 - mh); den += (a.z - mz) ** 2; }
    const d = den > 0 ? num / den : 0, a0 = mh - d * mz;
    const plane = (lx, lz) => a0 + b * lx + d * lz;
    // ground above the plane under a wheel would bury the tyre; under the belly it's fine up to ~25 cm
    let lift = 0, rough = 0;
    for (const a of ax) for (const [lx, gh] of [[-t2, a.l], [t2, a.r]]) { const r = gh - plane(lx, a.z); lift = Math.max(lift, r); rough = Math.max(rough, Math.abs(r)); }
    const zF = Math.min(...ax.map(a => a.z)), zB = Math.max(...ax.map(a => a.z));
    for (const [lx, lz] of [[0, 0], [0, zF], [0, zB], [-t2, 0], [t2, 0]]) {
      const r = h(lx, lz) - plane(lx, lz);
      lift = Math.max(lift, r - 0.25); rough = Math.max(rough, Math.abs(r));
    }
    _sR.set(c, b, -s).normalize(); _sB.set(s, d, c).normalize();
    _sU.crossVectors(_sB, _sR).normalize();
    _sR.addScaledVector(_sU, -_sR.dot(_sU)).normalize();
    _sB.crossVectors(_sR, _sU);
    const quat = new THREE.Quaternion().setFromRotationMatrix(_sM.makeBasis(_sR, _sU, _sB));
    const up = 0.12 + rideRaise(P) + 0.1 + lift;   // 0.12 + rideRaise = spawn height
    const pos = { x: x + _sU.x * up, y: a0 + _sU.y * up, z: z + _sU.z * up };
    return { pos, quat, ground: a0, slope: Math.acos(Math.min(1, _sU.y)) * 180 / Math.PI, rough };
  };

  const blocked = st => {
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (const [cx, cy, cz, hx, hy, hz] of vehicle.P.colliders) {
      x0 = Math.min(x0, cx - hx); x1 = Math.max(x1, cx + hx);
      y0 = Math.min(y0, cy - hy); y1 = Math.max(y1, cy + hy);
      z0 = Math.min(z0, cz - hz); z1 = Math.max(z1, cz + hz);
    }
    y0 += 0.3;
    const ctr = new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2).applyQuaternion(st.quat);
    const box = new RAPIER.Cuboid((x1 - x0) / 2, Math.max(0.1, (y1 - y0) / 2), (z1 - z0) / 2);
    return !!world.intersectionWithShape({ x: st.pos.x + ctr.x, y: st.pos.y + ctr.y, z: st.pos.z + ctr.z }, st.quat, box,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, vehicle.body);
  };

  // Recover: flattest clear spot within ~12 m, same heading, tilted to the slope and just above the
  // ground so it settles instead of dropping and rolling again.
  const RECOVER_RINGS = [[0, 1], [3, 8], [6, 12], [9, 16], [12, 20]];
  const recoverSpot = () => {
    const x = vehicle.pos.x, z = vehicle.pos.z, yaw = vehicle.yaw(), here = terrain.heightAt(x, z);
    streamAround(x, z);
    let best = null, bestScore = Infinity;
    for (const [r, n] of RECOVER_RINGS) for (let i = 0; i < n; i++) {
      const t = (i + 0.5 * (r / 3 % 2)) / n * Math.PI * 2;
      const st = standAt(x + Math.cos(t) * r, z + Math.sin(t) * r, yaw);
      const score = st.slope + st.rough * 20 + r * 0.5 + Math.abs(st.ground - here) * 1.5;
      if (score >= bestScore || blocked(st)) continue;
      best = st; bestScore = score;
    }
    return best;
  };
  const recover = () => {
    const st = recoverSpot();
    if (st) {
      streamAround(st.pos.x, st.pos.z);
      vehicle.reset(st.pos, 0, st.quat);
      onPlaced();
    } else placeVehicle(vehicle.pos.x, vehicle.pos.z, vehicle.yaw(), 1.0);
  };

  return { teleports, nearestLocation, placeVehicle, recover };
}
