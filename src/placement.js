import * as THREE from 'three';
import { ORIGIN } from './world/origin.js';
import { MAP_SIZE } from './world/terrain.js';
import { rideRaise } from './vehicle/tuning.js';

// Putting the vehicle somewhere: the menu's locations, teleports and Recover (R). A map with fixed places
// (maps/index.js places()) lists those; an endless one lists the start and the places found while driving, and
// teleports to far ones once the window round them is built (streamer.js).
// ctx: { RAPIER, world, terrain, vehicle, trees, props, streamer (endless maps), map, spawn (world coordinates),
// onPlaced(), say() }.

const NAMES = {
  hut: { tag: 'Ruin', title: 'Ruined hut', desc: 'An old stone hut by the road. Walls to nose up to, rubble round it.' },
  lake: { tag: 'Water', title: 'Lake', desc: 'A lake in a hollow, a sandy shore, a stream running in from the hills.' },
  quarry: { tag: 'Quarry', title: 'Old quarry', desc: 'A pit cut into the hillside: terraced walls, a gravel floor, a ramp in.' },
  lookout: { tag: 'Summit', title: 'Lookout', desc: 'The top of a hill, a track winding up to it, the land laid out below.' },
};
const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

export function createPlacement({ RAPIER, world, terrain, vehicle, trees, props, streamer, map, spawn, onPlaced, say }) {
  const FOUND_KEY = `offroad.found.${map.id}.v1`;
  // the nearest point on a road to (x, z) (local), facing along it; back: metres back along the road
  function trailSpot(x, z, back = 0, maxD = Infinity) {
    let best = null, bd = maxD * maxD;
    for (const c of terrain.trailCurves) {
      const n = Math.round(c.getLength() / 2), pts = c.getSpacedPoints(n);
      for (let k = 0; k <= n; k++) { const d = (pts[k].x - x) ** 2 + (pts[k].z - z) ** 2; if (d < bd) { bd = d; best = { pts, k, n }; } }
    }
    if (!best) return null;
    const { pts, k } = best, k0 = Math.max(0, k - Math.round(back / 2)), k1 = Math.min(pts.length - 1, k0 + 3);
    const p = pts[k0], q = pts[k1];
    return { x: p.x, z: p.z, yaw: Math.atan2(-(q.x - p.x), -(q.z - p.z)) };
  }

  // the menu's list: the start, then every place found (kept in the browser), nearest the start first
  const describe = (s) => {
    const n = NAMES[s.type], d = Math.hypot(s.x - spawn.x, s.z - spawn.z);
    const dir = COMPASS[(Math.round(Math.atan2(s.x - spawn.x, s.z - spawn.z) / (Math.PI / 4)) + 8) % 8];   // north is +z (the midday sun is towards -z)
    return { name: n.title, tag: `${n.tag} · ${d < 950 ? Math.round(d / 10) * 10 + ' m' : (d / 1000).toFixed(1) + ' km'} ${dir} of the start`, title: n.title, desc: n.desc, ax: s.x, az: s.z, site: s };
  };
  let found = [];
  try { found = JSON.parse(localStorage.getItem(FOUND_KEY) || '[]').filter(s => NAMES[s.type]); } catch { found = []; }
  const teleports = [];
  const fixed = map.places ? map.places(terrain, trailSpot).map(p => ({ ...p, ax: p.x + ORIGIN.x, az: p.z + ORIGIN.z, fixed: true })) : null;
  const rebuild = () => {
    teleports.length = 0;
    if (fixed) { teleports.push(...fixed); return; }
    teleports.push({ name: 'Start', tag: 'Road', title: 'The start', desc: 'Where the world begins: a road out into the hills, every way open.', ax: spawn.x, az: spawn.z, yaw: spawn.yaw, start: true });
    for (const s of [...found].sort((a, b) => Math.hypot(a.x - spawn.x, a.z - spawn.z) - Math.hypot(b.x - spawn.x, b.z - spawn.z))) teleports.push(describe(s));
  };
  rebuild();
  // places within ~120 m of the truck are found (checked twice a second)
  let findT = 0;
  const discover = (dt) => {
    if (fixed || (findT -= dt) > 0) return;
    findT = 0.5;
    for (const s of terrain.sites) {
      if (!NAMES[s.type] || found.some(f => f.id === s.id)) continue;
      const r = s.type === 'lake' ? Math.max(s.lake?.rx ?? 60, s.lake?.rz ?? 60) + 60 : 120;
      if (Math.hypot(s.x - vehicle.pos.x, s.z - vehicle.pos.z) > r) continue;
      const f = { id: s.id, type: s.type, x: s.ax, z: s.az };
      found.push(f);
      try { localStorage.setItem(FOUND_KEY, JSON.stringify(found)); } catch { /* private mode: kept for this session */ }
      rebuild();
      say?.('found', `Found: ${NAMES[s.type].title} · added to Locations`, 'good');
    }
  };

  // a location's local position and heading (in the current window)
  const localSpot = (t) => {
    const x = t.ax - ORIGIN.x, z = t.az - ORIGIN.z;
    if (t.start || t.fixed) return { x, z, yaw: t.yaw };
    const s = t.site;
    if (s.type === 'lake') {
      // on the shore, facing the water
      const lk = terrain.sites.find(q => q.id === s.id)?.lake;
      if (lk) {
        // on the shore, along it (facing the water it rolled in), on the flattest spot round it
        let best = null, bs = 0;
        for (let k = 0; k < 24; k++) {
          const a = k / 24 * Math.PI * 2, px = lk.x + Math.cos(a) * lk.rx * 1.32, pz = lk.z + Math.sin(a) * lk.rz * 1.32;
          const ny = terrain.normalAt(px, pz).y;
          if (terrain.waterLevelAt(px, pz) < -1e8 && ny > bs) { bs = ny; best = { x: px, z: pz, yaw: Math.atan2(-(-Math.sin(a) * lk.rx), -(Math.cos(a) * lk.rz)) }; }
        }
        if (best) return best;
      }
    }
    if (s.type === 'quarry') { const sp = trailSpot(x, z, 25, 120); if (sp) return sp; }
    if (s.type === 'lookout') { const sp = trailSpot(x, z, 14, 80); if (sp) return sp; }
    const sp = trailSpot(x, z, 0, 90);
    if (sp) return sp;
    return { x: x + 12, z, yaw: 0 };
  };

  const nearestLocation = () => {
    let best = -1, bd = 25 * 25;
    teleports.forEach((t, i) => { const dd = (t.ax - ORIGIN.x - vehicle.pos.x) ** 2 + (t.az - ORIGIN.z - vehicle.pos.z) ** 2; if (dd < bd) { bd = dd; best = i; } });
    return best;
  };

  const streamAround = (x, z) => {
    trees.updatePhysics(x, z);
    props.stream.update(x, z);
    world.step();   // queries see streamed colliders only after a step
  };
  const placeVehicle = (x, z, yaw, lift = 0.5) => {
    let y = terrain.heightAt(x, z);
    for (const dx of [-1.5, 1.5]) for (const dz of [-2.2, 2.2]) y = Math.max(y, terrain.heightAt(x + dx, z + dz));
    streamAround(x, z);
    vehicle.reset({ x, y: y + lift + rideRaise(vehicle.P), z }, yaw);
    onPlaced();
  };
  // somewhere in the world (world coordinates): at once if it is well inside the window, else once the window round it
  // is built. spot(): the local spot once there (default: the point itself)
  const near = (ax, az) => Math.abs(ax - ORIGIN.x) < MAP_SIZE / 2 - 120 && Math.abs(az - ORIGIN.z) < MAP_SIZE / 2 - 120;
  const placeWorld = async (ax, az, yaw, spot = null) => {
    if (streamer && !near(ax, az)) {
      say?.('place', 'Travelling…', '', 6);
      const ok = await streamer.goTo(ax, az);
      if (!ok) return false;
    }
    const s = spot ? spot() : { x: ax - ORIGIN.x, z: az - ORIGIN.z, yaw };
    placeVehicle(s.x, s.z, s.yaw ?? yaw);
    return true;
  };
  const teleportTo = (t) => placeWorld(t.ax, t.az, t.yaw ?? 0, () => localSpot(t));
  // a site of the world ({ type, x, z, id }, world coordinates), as the menu would go there (tools)
  const visit = (s) => teleportTo(describe(s));

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
    const wheelLift = lift;
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
    // hang: how far a hump under the belly lifts the wheels off their ground (high-centred)
    return { pos, quat, ground: a0, slope: Math.acos(Math.min(1, _sU.y)) * 180 / Math.PI, rough, hang: lift - wheelLift };
  };

  const bodyBox = () => {
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (const [cx, cy, cz, hx, hy, hz] of vehicle.P.colliders) {
      x0 = Math.min(x0, cx - hx); x1 = Math.max(x1, cx + hx);
      y0 = Math.min(y0, cy - hy); y1 = Math.max(y1, cy + hy);
      z0 = Math.min(z0, cz - hz); z1 = Math.max(z1, cz + hz);
    }
    return { x0, x1, y0, y1, z0, z1 };
  };
  // pad widens the box so the truck doesn't land against the trees it was wedged between
  const blocked = (st, pad = 0) => {
    const bb = bodyBox(), { x0, x1, y1, z0, z1 } = bb, y0 = bb.y0 + 0.3;
    const ctr = new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2).applyQuaternion(st.quat);
    const box = new RAPIER.Cuboid((x1 - x0) / 2 + pad, Math.max(0.1, (y1 - y0) / 2), (z1 - z0) / 2 + pad);
    return !!world.intersectionWithShape({ x: st.pos.x + ctr.x, y: st.pos.y + ctr.y, z: st.pos.z + ctr.z }, st.quat, box,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, vehicle.body);
  };
  // anything but terrain (rock, log, stump) more than 15 cm up under the wheels or belly
  const _uRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 }), _uP = new THREE.Vector3();
  const obstacleUnder = st => {
    const P = vehicle.P, t2 = P.track / 2, { x0, x1, z0, z1 } = bodyBox();
    const pts = P.axles.flatMap(a => [[-t2, a.z], [t2, a.z]]);
    for (const lx of [x0 * 0.6, 0, x1 * 0.6]) for (let k = 0; k <= 4; k++) pts.push([lx, z0 + (z1 - z0) * k / 4]);
    for (const [lx, lz] of pts) {
      _uP.set(lx, 0, lz).applyQuaternion(st.quat);
      const px = st.pos.x + _uP.x, pz = st.pos.z + _uP.z, g = terrain.heightAt(px, pz);
      _uRay.origin.x = px; _uRay.origin.y = g + 3; _uRay.origin.z = pz;
      const hit = world.castRay(_uRay, 3.5, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, vehicle.body);
      if (hit && 3 - hit.timeOfImpact > 0.15) return true;
    }
    return false;
  };

  // Recover: flattest clear spot within ~15 m, same heading, tilted to the slope and just above the
  // ground so it settles instead of dropping and rolling again. A truck still upright is stuck, so it
  // always moves. The strict pass wants room all round, nothing under it and no hang; the loose pass
  // takes any spot the body fits in.
  const RECOVER_RINGS = [[0, 1], [3, 8], [6, 12], [9, 16], [12, 20], [15, 24]];
  const recoverSpot = () => {
    const x = vehicle.pos.x, z = vehicle.pos.z, yaw = vehicle.yaw(), here = terrain.heightAt(x, z);
    const upright = vehicle.up.y > 0.8;
    streamAround(x, z);
    for (const strict of [true, false]) {
      let best = null, bestScore = Infinity;
      for (const [r, n] of RECOVER_RINGS) for (let i = 0; i < n; i++) {
        if (r === 0 && upright && strict) continue;
        const t = (i + 0.5 * (r / 3 % 2)) / n * Math.PI * 2;
        const st = standAt(x + Math.cos(t) * r, z + Math.sin(t) * r, yaw);
        if (strict && st.hang > 0.05) continue;
        const score = st.slope + st.rough * 20 + st.hang * 40 + r * 0.5 + Math.abs(st.ground - here) * 1.5;
        if (score >= bestScore || blocked(st, strict ? 0.5 : 0) || (strict && obstacleUnder(st))) continue;
        best = st; bestScore = score;
      }
      if (best) return best;
    }
    return null;
  };
  const recover = () => {
    const st = recoverSpot();
    if (st) {
      streamAround(st.pos.x, st.pos.z);
      vehicle.reset(st.pos, 0, st.quat);
      onPlaced();
    } else placeVehicle(vehicle.pos.x, vehicle.pos.z, vehicle.yaw(), 1.0);
  };

  return { teleports, nearestLocation, placeVehicle, placeWorld, teleportTo, visit, discover, recover };
}
