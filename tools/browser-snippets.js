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

// 2. Straight-line driver for the proving-ground lanes (teleport index 1..5).
window.laneDriver = (laneX, targetKmh, thrMax = 0.6) => (v) => {
  const xErr = v.pos.x - laneX;
  const wantYaw = Math.max(-0.5, Math.min(0.5, xErr * 0.3));
  let e = v.yaw() - wantYaw; while (e > Math.PI) e -= 2 * Math.PI; while (e < -Math.PI) e += 2 * Math.PI;
  const sp = v.speed * 3.6;
  return { throttle: sp < targetKmh ? thrMax : 0, brake: sp > targetKmh + 4 ? 0.4 : 0, steer: Math.max(-1, Math.min(1, e * 3)), clutch: 0, handbrake: 0 };
};
window.runLane = (idx, kmh, secs, setup, thr) => {
  const g = window.game, t = g.teleports[idx];
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
// e.g. runLane(4, 6, 25, d => { d.range = 'low'; d.centerLock = true; })   // 20/30/35 deg ramps

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

// 4. Frame budget: game.timings holds smoothed ms per stage (physics, view, dust, audio, hud, render).
