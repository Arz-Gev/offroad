// Turret and guns of a vehicle (P.turret, carSpecs.js): traverse and elevation driven like the BPU-1's hand
// wheels (rate and acceleration limited, no stabiliser: the gun moves with the hull), the guns' rate of
// fire, belts and reloads, barrel recoil, and the ballistics shared by the game (weapons.js) and the tests.
//
// Angles are relative to the hull: yaw + = right (seen from above, clockwise), pitch + = up.
// The aim (aimYaw, aimPitch) is where the gunner wants the gun; the mouse moves it, keys and the stick move
// it at the drive's full rate. The gun follows at the drive's speed.

const wrap = a => a - Math.round(a / (2 * Math.PI)) * 2 * Math.PI;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

export class Turret {
  constructor(spec) {
    this.spec = spec;
    this.yaw = 0; this.pitch = 0;           // the gun, now (rad)
    this.yawRate = 0; this.pitchRate = 0;   // (rad/s)
    this.aimYaw = 0; this.aimPitch = 0;     // where the gunner wants it
    this.weapon = 0;                        // index in spec.weapons
    this.recoil = 0;                        // barrel slide back (m), for the view
    this.shots = 0;                         // rounds fired, all guns (multiplayer: friends draw them)
    this.events = [];                       // shots fired this step: { weapon } (weapons.js turns them into rounds)
    this.guns = spec.weapons.map(w => ({ belt: w.belt, reserve: w.ammo - w.belt, reload: 0, cool: 0, count: 0 }));
  }

  get gun() { return this.guns[this.weapon]; }
  get w() { return this.spec.weapons[this.weapon]; }

  select(i) {
    if (i === this.weapon || !this.spec.weapons[i]) return false;
    this.weapon = i;
    return true;
  }

  // aim input: dYaw / dPitch move the aim (mouse, rad); rate inputs -1..1 move it at full drive speed
  aim(dYaw, dPitch, yawIn, pitchIn, h) {
    const S = this.spec;
    this.aimYaw = wrap(this.aimYaw + dYaw + yawIn * S.yawRate * h);
    this.aimPitch = clamp(this.aimPitch + dPitch + pitchIn * S.pitchRate * h, S.pitchMin, S.pitchMax);
  }

  // one physics step: drives follow the aim, guns cycle. fire: trigger held
  step(h, fire) {
    const S = this.spec;
    // each drive: the rate it would like (proportional near the aim, capped at the drive's speed), reached
    // with the drive's acceleration (a gunner can't spin the hand wheels up instantly)
    const drive = (err, rate, max, acc) => {
      const want = clamp(err * 6, -max, max);
      return rate + clamp(want - rate, -acc * h, acc * h);
    };
    this.yawRate = drive(wrap(this.aimYaw - this.yaw), this.yawRate, S.yawRate, S.yawAccel);
    this.pitchRate = drive(this.aimPitch - this.pitch, this.pitchRate, S.pitchRate, S.pitchAccel);
    this.yaw = wrap(this.yaw + this.yawRate * h);
    this.pitch += this.pitchRate * h;
    if (this.pitch < S.pitchMin) { this.pitch = S.pitchMin; this.pitchRate = 0; }
    if (this.pitch > S.pitchMax) { this.pitch = S.pitchMax; this.pitchRate = 0; }
    // guns
    this.events.length = 0;
    for (let i = 0; i < this.guns.length; i++) {
      const g = this.guns[i], w = S.weapons[i];
      g.cool = Math.max(0, g.cool - h);
      if (g.reload > 0) {
        g.reload -= h;
        if (g.reload <= 0) { g.reload = 0; const n = Math.min(w.belt, g.reserve); g.belt = n; g.reserve -= n; }
      }
      if (i !== this.weapon || !fire || g.cool > 0 || g.reload > 0 || g.belt <= 0) continue;
      g.cool += 60 / w.rpm;
      g.belt--; g.count++; this.shots++;
      this.events.push({ weapon: i, tracer: g.count % w.tracerEvery === 0 });
      if (i === 0) this.recoil = w.recoilTravel || 0;
      if (g.belt === 0 && g.reserve > 0) g.reload = w.reload;   // the next belt goes in
    }
    // the barrel runs back out (short recoil: back and out again within a cycle)
    const w0 = S.weapons[0];
    this.recoil = Math.max(0, this.recoil - h * (w0.recoilTravel || 0) / (0.6 * 60 / w0.rpm));
  }
}

// ---------------------------------------------------------------- ballistics
// Point-mass round with quadratic drag: dv/dt = g - k |v| v. k (1/m) from the round's published retained
// velocity: v(x) = v0 exp(-k x) along a flat path.
export function ballisticStep(p, v, k, h, g = 9.81) {
  const s = Math.hypot(v.x, v.y, v.z);
  v.x -= k * s * v.x * h;
  v.y -= (k * s * v.y + g) * h;
  v.z -= k * s * v.z * h;
  p.x += v.x * h; p.y += v.y * h; p.z += v.z * h;
}

// Fly a round fired level; returns [{ d, drop, t, v }] at the distances asked (m): the sight's range marks
// (how far below the bore line it lands) and the tests' numbers.
export function trajectory(w, distances, h = 1 / 960) {
  const p = { x: 0, y: 0, z: 0 }, v = { x: w.v0, y: 0, z: 0 };
  const out = [];
  let t = 0, i = 0;
  while (i < distances.length && t < 12) {
    const x0 = p.x, y0 = p.y;
    ballisticStep(p, v, w.k, h);
    t += h;
    while (i < distances.length && p.x >= distances[i]) {
      const f = (distances[i] - x0) / (p.x - x0);
      out.push({ d: distances[i], drop: -(y0 + (p.y - y0) * f), t, v: Math.hypot(v.x, v.y) });
      i++;
    }
  }
  return out;
}
