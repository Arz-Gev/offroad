// Paste into the page console (or javascript_tool) after the game has loaded.
// Lets you drive and capture frames without relying on requestAnimationFrame,
// which a hidden browser pane / background tab throttles to ~0.

// 1. Capture the canvas right after rendering and POST it to tools/shotserver.py (port 5199).
//    Run the server first:  SHOT_DIR=/some/dir python3 tools/shotserver.py
window.shot = async (name, ticks = 2) => {
  const g = window.game;
  for (let i = 0; i < ticks; i++) g.tick(1 / 60);
  const url = g.renderer.domElement.toDataURL('image/jpeg', 0.85);
  return (await fetch('http://127.0.0.1:5199/?name=' + name, { method: 'POST', body: url })).status;
};

// 2. Straight-line driver (along x = laneX, towards -z).
window.laneDriver = (laneX, targetKmh, thrMax = 0.6) => (v) => {
  const xErr = v.pos.x - laneX;
  const wantYaw = Math.max(-0.5, Math.min(0.5, xErr * 0.3));
  let e = v.yaw() - wantYaw; while (e > Math.PI) e -= 2 * Math.PI; while (e < -Math.PI) e += 2 * Math.PI;
  const sp = v.speed * 3.6;
  return { throttle: sp < targetKmh ? thrMax : 0, brake: sp > targetKmh + 4 ? 0.4 : 0, steer: Math.max(-1, Math.min(1, e * 3)), clutch: 0, handbrake: 0 };
};
window.runLane = (x, z, kmh, secs, setup, thr) => {
  const g = window.game, t = { x, z, yaw: 0 };
  g.placeVehicle(t.x, t.z, t.yaw);
  setup && setup(g.vehicle.drivetrain, g.vehicle);
  g.autopilot = laneDriver(t.x, kmh, thr);
  const log = [];
  for (let i = 0; i < secs * 60; i++) {
    g.tick(1 / 60);
    if (i % 60 === 0) log.push(`z${g.vehicle.pos.z.toFixed(1)} ${(g.vehicle.speed * 3.6).toFixed(1)}kmh ${g.vehicle.drivetrain.gearLabel()}`);
  }
  g.autopilot = null;
  return log;
};

// 3. Pure-pursuit driver along the main trail loop that slows for corners (lateral ~0.35 g).
window.trailDriver = (kmh) => {
  const curve = window.game.terrain.trailCurves[0];
  const pts = curve.getSpacedPoints(2000), seg = curve.getLength() / 2000;
  return (v) => {
    let best = 0, bd = 1e9;
    for (let i = 0; i < pts.length; i += 2) { const d = (pts[i].x - v.pos.x) ** 2 + (pts[i].z - v.pos.z) ** 2; if (d < bd) { bd = d; best = i; } }
    const tgt = pts[(best + Math.round(Math.max(8, Math.abs(v.speed) * 0.9) / seg)) % pts.length];
    let turn = 0;
    for (let k = 20; k < 160; k += 20) {
      const a = pts[(best + k) % pts.length], b = pts[(best + k + 20) % pts.length], c = pts[(best + k + 40) % pts.length];
      let dh = Math.atan2(c.x - b.x, c.z - b.z) - Math.atan2(b.x - a.x, b.z - a.z);
      while (dh > Math.PI) dh -= 2 * Math.PI; while (dh < -Math.PI) dh += 2 * Math.PI;
      turn = Math.max(turn, Math.abs(dh) / (20 * seg));
    }
    const target = Math.min(kmh, Math.sqrt(0.35 * 9.81 / Math.max(turn, 1e-3)) * 3.6);
    const dx = tgt.x - v.pos.x, dz = tgt.z - v.pos.z;
    const steer = Math.max(-1, Math.min(1, Math.atan2(dx * v.right.x + dz * v.right.z, dx * v.fwd.x + dz * v.fwd.z) * 2.0));
    const sp = v.speed * 3.6;
    return { throttle: sp < target ? 0.75 : 0, brake: sp > target + 6 ? 0.6 : 0, steer, clutch: 0, handbrake: 0, analogSteer: true };
  };
};
// e.g. game.placeVehicle(0, 40, 0); game.autopilot = trailDriver(60); for (let i = 0; i < 1800; i++) game.tick(1/60);

// 3b. Driver along the endless world's road network: follows the road it is on, at its end (a junction) takes the
//     road that carries on straightest (turn > 0: the leftmost, < 0: the rightmost), slows for corners. Survives
//     the window moving (it finds its road again in the new window's local coordinates).
window.roadDriver = (kmh, turn = 0) => {
  const st = { road: null, dir: 1, i: 0, n: 0 };
  const near = (p, x, z, from, to) => { let b = from, bd = 1e18; for (let i = Math.max(0, from); i <= Math.min(p.xs.length - 1, to); i++) { const d = (p.xs[i] - x) ** 2 + (p.zs[i] - z) ** 2; if (d < bd) { bd = d; b = i; } } return [b, Math.sqrt(bd)]; };
  const acquire = (v, roads) => {
    let best = null, bd = 14;
    for (const p of roads) { const [i, d] = near(p, v.pos.x, v.pos.z, 0, p.xs.length - 1); if (d < bd) { bd = d; best = [p, i]; } }
    if (!best) return false;
    const [p, i] = best, j = Math.min(p.xs.length - 1, i + 4), k = Math.max(0, j - 8);
    const tx = p.xs[j] - p.xs[k], tz = p.zs[j] - p.zs[k];
    st.road = p; st.i = i; st.dir = tx * v.fwd.x + tz * v.fwd.z >= 0 ? 1 : -1;
    return true;
  };
  return (v) => {
    const roads = window.game.terrain.trailCurves;
    if (!st.road || !roads.includes(st.road)) { if (!acquire(v, roads)) return { throttle: 0, brake: 0.5, steer: 0, clutch: 0, handbrake: 0 }; }
    let p = st.road;
    [st.i] = near(p, v.pos.x, v.pos.z, st.i - 30, st.i + 30);
    const n = p.xs.length, la = Math.round(Math.max(8, Math.abs(v.speed) * 0.9) / 0.5);
    // at the end of the road: the road leaving the same junction that carries on best
    if ((st.dir > 0 && st.i + 20 >= n - 1) || (st.dir < 0 && st.i - 20 <= 0)) {
      const ex = p.xs[st.dir > 0 ? n - 1 : 0], ez = p.zs[st.dir > 0 ? n - 1 : 0];
      const hx = v.fwd.x, hz = v.fwd.z;
      let best = null, bs = -1e9;
      for (const q of roads) {
        if (q === p) continue;
        for (const [end, d] of [[0, 1], [q.xs.length - 1, -1]]) {
          if (Math.hypot(q.xs[end] - ex, q.zs[end] - ez) > 12 || q.xs.length < 60) continue;
          const k = end + d * 30, ax = q.xs[k] - q.xs[end], az = q.zs[k] - q.zs[end], l = Math.hypot(ax, az) || 1;
          const straight = (ax * hx + az * hz) / l, side = (hx * az - hz * ax) / l;
          const score = straight + turn * side + (Math.random() - 0.5) * 0.3;
          if (score > bs) { bs = score; best = [q, end, d]; }
        }
      }
      if (best) { st.road = p = best[0]; st.i = best[1]; st.dir = best[2]; }
    }
    const m = p.xs.length, at = k => Math.max(0, Math.min(m - 1, k));
    const tg = at(st.i + st.dir * la);
    let curv = 0;
    for (let k = 20; k < 160; k += 20) {
      const a = at(st.i + st.dir * k), b = at(st.i + st.dir * (k + 20)), c = at(st.i + st.dir * (k + 40));
      let dh = Math.atan2(p.xs[c] - p.xs[b], p.zs[c] - p.zs[b]) - Math.atan2(p.xs[b] - p.xs[a], p.zs[b] - p.zs[a]);
      while (dh > Math.PI) dh -= 2 * Math.PI; while (dh < -Math.PI) dh += 2 * Math.PI;
      curv = Math.max(curv, Math.abs(dh) / 10);
    }
    const target = Math.min(kmh, Math.sqrt(0.35 * 9.81 / Math.max(curv, 1e-3)) * 3.6);
    const dx = p.xs[tg] - v.pos.x, dz = p.zs[tg] - v.pos.z;
    const steer = Math.max(-1, Math.min(1, Math.atan2(dx * v.right.x + dz * v.right.z, dx * v.fwd.x + dz * v.fwd.z) * 2.0));
    const sp = v.speed * 3.6;
    return { throttle: sp < target ? 0.8 : 0, brake: sp > target + 6 ? 0.6 : 0, steer, clutch: 0, handbrake: 0, analogSteer: true };
  };
};

// 4. Frame budget: game.timings holds smoothed ms per stage (physics, view, dust, audio, hud, render).
