import * as THREE from 'three';
import { D } from './truckDims.js';
import { mesh, rbox, span, bar, pipe, extrudeProfile, plate, frame } from './geom.js';

// Defender cabin, left-hand drive. Laid out from the driver's eye (D.DX, 1.78, 0.10):
// the dash top sits at the windscreen base (~25° below the eye line), the instrument pod looks over the
// steering-wheel rim, the bonnet shows over the dash, the header with visors and mirror closes the view.

export const EYE = new THREE.Vector3(D.DX, 1.71, 0.03);

// ---------------------------------------------------------------- gauges
// 1024² canvas: speedo (top left), tacho (top right), fuel (bottom left), temp (bottom right)
function gaugeTexture() {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 1024;
  const g = c.getContext('2d');
  g.fillStyle = '#060708';
  g.fillRect(0, 0, 1024, 1024);
  const font = (px, w = 'bold') => `${w} ${px}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  const dial = (cx, cy, r, max, major, minorPer, label, sub, redFrom, numbers = true, fmt = v => v) => {
    g.save();
    g.translate(cx, cy);
    const grd = g.createRadialGradient(0, 0, r * 0.1, 0, 0, r);
    grd.addColorStop(0, '#15171b'); grd.addColorStop(1, '#0a0b0d');
    g.fillStyle = grd;
    g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#2b2e34'; g.lineWidth = r * 0.03; g.stroke();
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
    const steps = Math.round(max / major) * minorPer;
    for (let i = 0; i <= steps; i++) {
      const v = (i / steps) * max;
      const a = a0 + (a1 - a0) * (i / steps);
      const isMajor = i % minorPer === 0;
      g.strokeStyle = redFrom !== undefined && v >= redFrom - 1e-6 ? '#ff3b2f' : '#f2f2ee';
      g.lineWidth = isMajor ? r * 0.032 : r * 0.014;
      const r0 = r * 0.92, r1 = r * (isMajor ? 0.76 : 0.84);
      g.beginPath(); g.moveTo(Math.cos(a) * r0, Math.sin(a) * r0); g.lineTo(Math.cos(a) * r1, Math.sin(a) * r1); g.stroke();
      if (isMajor && numbers) {
        g.fillStyle = '#f2f2ee';
        g.font = font(Math.round(r * 0.17));
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(String(fmt(v)), Math.cos(a) * r * 0.6, Math.sin(a) * r * 0.6);
      }
    }
    if (redFrom !== undefined) {
      g.strokeStyle = '#d42a20'; g.lineWidth = r * 0.05;
      g.beginPath(); g.arc(0, 0, r * 0.95, a0 + (a1 - a0) * (redFrom / max), a1); g.stroke();
    }
    g.fillStyle = '#9ca3ad';
    g.font = font(Math.round(r * 0.1), '600');
    g.textAlign = 'center';
    g.fillText(label, 0, r * 0.38);
    if (sub) { g.font = font(Math.round(r * 0.075), '500'); g.fillText(sub, 0, r * 0.52); }
    g.restore();
  };
  dial(256, 256, 236, 160, 20, 4, 'km/h', 'DEFENDER', undefined);
  dial(768, 256, 236, 6, 1, 5, 'x1000 r/min', '', 5);
  // fuel / temp: half arcs
  const small = (cx, cy, r, left, right, label, redLeft) => {
    g.save(); g.translate(cx, cy);
    g.fillStyle = '#0c0d10'; g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#2b2e34'; g.lineWidth = r * 0.04; g.stroke();
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
    for (let i = 0; i <= 8; i++) {
      const a = a0 + (a1 - a0) * i / 8;
      g.strokeStyle = (redLeft && i === 0) || (!redLeft && i === 8) ? '#ff3b2f' : '#f2f2ee';
      g.lineWidth = i % 4 === 0 ? r * 0.05 : r * 0.025;
      g.beginPath(); g.moveTo(Math.cos(a) * r * 0.9, Math.sin(a) * r * 0.9); g.lineTo(Math.cos(a) * r * (i % 4 === 0 ? 0.68 : 0.78), Math.sin(a) * r * (i % 4 === 0 ? 0.68 : 0.78)); g.stroke();
    }
    g.fillStyle = '#f2f2ee'; g.font = font(Math.round(r * 0.2)); g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(left, Math.cos(a0) * r * 0.48, Math.sin(a0) * r * 0.42);
    g.fillText(right, Math.cos(a1) * r * 0.48, Math.sin(a1) * r * 0.42);
    g.fillStyle = '#9ca3ad'; g.font = font(Math.round(r * 0.15), '600'); g.fillText(label, 0, r * 0.45);
    g.restore();
  };
  small(256, 768, 200, 'E', 'F', 'FUEL', true);
  small(768, 768, 200, 'C', 'H', 'TEMP', false);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// circle with its UVs mapped into one quadrant of the gauge texture
function dialMesh(r, mat, qx, qy) {
  const geo = new THREE.CircleGeometry(r, 48);
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, qx * 0.5 + uv.getX(i) * 0.5, qy * 0.5 + uv.getY(i) * 0.5);
  const m = new THREE.Mesh(geo, mat);
  m.receiveShadow = true;
  return m;
}

export function buildInterior(mats, body) {
  const { W, WG, WAIST, EAVE, SCREEN, FLOOR, DX, REAR } = D;
  const add = (o, p = body) => { p.add(o); return o; };
  const sides = [-1, 1];
  const dynamic = [];

  // ---------------------------------------------------------------- dash
  const DT = 1.40; // dash top (windscreen base)
  // top shelf under the screen, with the classic bulkhead vent-flap levers
  add(span(-0.84, 0.84, DT - 0.035, DT, SCREEN - 0.005, -0.52, mats.dash, 0.012));
  for (const x of [-0.25, 0.25]) {
    add(span(x - 0.16, x + 0.16, DT, DT + 0.004, -0.66, -0.58, mats.dashSoft));
    add(bar([x, DT + 0.005, -0.6], [x, DT + 0.03, -0.55], 0.006, mats.cabinMetal, 6));
  }
  // padded upper fascia with a rolled front edge
  add(extrudeProfile([[-0.56, DT - 0.02], [-0.47, DT - 0.035], [-0.445, DT - 0.08], [-0.45, 1.22], [-0.56, 1.20]], 1.66, mats.dashSoft, 0.02));
  // lower fascia + knee panel
  add(span(-0.83, 0.83, 1.0, 1.21, -0.62, -0.5, mats.dash, 0.015));
  // passenger open shelf (Defender cubby) with a grab rail
  add(span(0.18, 0.80, 1.155, 1.17, -0.56, -0.44, mats.dash, 0.006));
  add(bar([0.22, 1.27, -0.43], [0.76, 1.27, -0.43], 0.011, mats.seatTrim, 8));
  for (const x of [0.22, 0.76]) add(bar([x, 1.27, -0.43], [x, 1.25, -0.47], 0.011, mats.seatTrim, 8));
  // round vents at the ends, rectangular ones in the centre stack
  for (const s of sides) {
    const v = add(mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.03, 20).rotateX(Math.PI / 2), mats.seal, s * 0.74, 1.31, -0.44));
    v.castShadow = false;
    add(mesh(new THREE.TorusGeometry(0.046, 0.006, 6, 20), mats.dash, s * 0.74, 1.31, -0.428));
    for (let k = -1; k <= 1; k++) add(span(s * 0.74 - 0.04, s * 0.74 + 0.04, 1.31 + k * 0.022 - 0.003, 1.31 + k * 0.022 + 0.003, -0.432, -0.424, mats.dash));
  }
  // centre stack: vents, radio, heater controls, switches
  add(span(-0.14, 0.14, 0.82, 1.24, -0.62, -0.42, mats.dash, 0.02));
  for (const s of sides) {
    add(span(s * 0.065 - 0.05, s * 0.065 + 0.05, 1.15, 1.215, -0.425, -0.416, mats.seal));
    for (let k = 0; k < 4; k++) add(span(s * 0.065 - 0.047, s * 0.065 + 0.047, 1.157 + k * 0.016, 1.161 + k * 0.016, -0.418, -0.412, mats.dash));
  }
  add(span(-0.09, 0.09, 1.06, 1.11, -0.425, -0.415, mats.seal));        // radio
  add(span(-0.085, 0.085, 1.075, 1.095, -0.416, -0.413, mats.cabinMetal));
  for (const x of [-0.08, 0, 0.08]) add(mesh(new THREE.CylinderGeometry(0.018, 0.02, 0.025, 14).rotateX(Math.PI / 2), mats.seatTrim, x, 0.985, -0.41));
  for (let k = 0; k < 4; k++) add(rbox(0.024, 0.032, 0.015, 0.004, mats.seal, -0.27 + k * 0.034, 1.17, -0.445)); // rocker switches

  // ---------------------------------------------------------------- instrument pod
  // the binnacle sits on the fascia's front edge, in front of the dash shelf (which would otherwise cut
  // the lower half of the dials), and looks between the rim top (21-25 deg below the eye line) and the
  // wheel boss (35 deg); the gauge face tilts back to face the eye
  const POD = new THREE.Vector3(DX, 1.405, -0.50);
  const pod = new THREE.Group();
  pod.position.copy(POD);
  pod.rotation.x = -Math.atan2(EYE.y + 0.02 - POD.y, EYE.z - POD.z);
  body.add(pod);
  add(rbox(0.385, 0.15, 0.15, 0.035, mats.dash, 0, 0.0, -0.087), pod);             // housing (face 12 mm behind the dials)
  add(span(-0.197, 0.197, 0.066, 0.084, -0.15, 0.062, mats.dash, 0.008), pod);     // hood
  for (const s of sides) add(span(s * 0.178, s * 0.197, -0.06, 0.084, -0.05, 0.058, mats.dash, 0.006), pod);
  add(span(-0.182, 0.182, -0.068, 0.07, -0.012, -0.004, mats.seal), pod);          // face plate
  const gaugeMat = new THREE.MeshStandardMaterial({ map: gaugeTexture(), roughness: 0.55, metalness: 0, emissive: 0xfff4e6, emissiveIntensity: 0 });
  gaugeMat.emissiveMap = gaugeMat.map;
  const ringMat = mats.cabinMetal;
  const needleMat = new THREE.MeshStandardMaterial({ color: 0xff6a2a, emissive: 0xff4a12, emissiveIntensity: 0.35, roughness: 0.4 });
  const needleGeo = new THREE.BoxGeometry(0.0032, 0.05, 0.0015); needleGeo.translate(0, 0.019, 0);
  const smallNeedleGeo = new THREE.BoxGeometry(0.0026, 0.028, 0.0015); smallNeedleGeo.translate(0, 0.011, 0);
  const needles = {};
  const gaugeMeshes = [];
  const dials = [['speed', -0.064, 0.0, 0.056, 0, 1, needleGeo], ['rpm', 0.064, 0.0, 0.056, 1, 1, needleGeo], ['fuel', -0.149, 0.016, 0.026, 0, 0, smallNeedleGeo], ['temp', 0.149, 0.016, 0.026, 1, 0, smallNeedleGeo]];
  for (const [k, x, y, r, qx, qy, ng] of dials) {
    const d = dialMesh(r, gaugeMat, qx, qy);
    d.position.set(x, y, 0.0);
    pod.add(d);
    gaugeMeshes.push(d);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r + 0.003, 0.0035, 6, 40), ringMat);
    ring.position.set(x, y, 0.003);
    pod.add(ring);
    const pivot = new THREE.Group();
    pivot.userData.keep = true;
    pivot.position.set(x, y, 0.004);
    const nd = new THREE.Mesh(ng, needleMat);
    pivot.add(nd);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.12, r * 0.12, 0.004, 12).rotateX(Math.PI / 2), mats.seal);
    hub.position.z = 0.002;
    pivot.add(hub);
    pod.add(pivot);
    needles[k] = pivot;
  }
  // warning lamp strip between the dials
  const warnMat = new THREE.MeshStandardMaterial({ color: 0x1a1c20, roughness: 0.4, emissive: 0xff7a20, emissiveIntensity: 0 });
  for (let k = 0; k < 3; k++) {
    const w = new THREE.Mesh(new THREE.CircleGeometry(0.0055, 12), warnMat);
    w.position.set(-0.012 + k * 0.012, -0.045, 0.001);
    pod.add(w);
  }

  // ---------------------------------------------------------------- steering
  const tilt = 0.49; // wheel plane leans back 28° from vertical
  const steeringWheel = new THREE.Group();
  steeringWheel.position.set(DX, 1.36, -0.36);
  steeringWheel.rotation.x = -tilt;
  body.add(steeringWheel);
  const swRot = new THREE.Group();
  steeringWheel.add(swRot);
  const swMat = mats.seatTrim;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.0165, 12, 64), swMat);
  rim.castShadow = true;
  swRot.add(rim);
  // grip bulges at 10 and 2
  for (const a of [Math.PI * 0.82, Math.PI * 0.18]) {
    const gp = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.0185, 10, 12, 0.5), swMat);
    gp.rotation.z = a - 0.25;
    swRot.add(gp);
  }
  // three spokes (9, 3, 6 o'clock), dished towards the column
  for (const a of [Math.PI, 0, -Math.PI / 2]) {
    const len = 0.145;
    const sp = new THREE.Mesh(new THREE.BoxGeometry(len, a === -Math.PI / 2 ? 0.035 : 0.042, 0.012), mats.dash);
    sp.position.set(Math.cos(a) * (0.05 + len / 2), Math.sin(a) * (0.05 + len / 2), -0.018);
    sp.rotation.z = a;
    sp.rotation.y = a === -Math.PI / 2 ? 0 : -Math.cos(a) * 0.18;
    sp.castShadow = true;
    swRot.add(sp);
  }
  const boss = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.068, 0.045, 24).rotateX(Math.PI / 2), mats.dash);
  boss.position.z = -0.03;
  swRot.add(boss);
  const badge = new THREE.Mesh(new THREE.CircleGeometry(0.022, 20), mats.cabinMetal);
  badge.position.z = -0.006;
  swRot.add(badge);
  dynamic.push(steeringWheel);
  // column shroud along the wheel axis, stalks
  {
    const axis = new THREE.Vector3(0, Math.sin(tilt), Math.cos(tilt));
    const hub = new THREE.Vector3(DX, 1.36, -0.36);
    const a = hub.clone().addScaledVector(axis, -0.07), b = hub.clone().addScaledVector(axis, -0.3);
    add(bar(a.toArray(), b.toArray(), 0.05, mats.dash, 14, 0.042));
    for (const s of sides) add(bar(hub.clone().addScaledVector(axis, -0.1).add(new THREE.Vector3(s * 0.035, 0.0, 0)).toArray(), hub.clone().addScaledVector(axis, -0.12).add(new THREE.Vector3(s * 0.15, 0.02, 0)).toArray(), 0.006, mats.seal, 6));
  }

  // ---------------------------------------------------------------- floor, tunnel, levers, pedals
  add(span(-0.16, 0.16, FLOOR, 0.99, -0.68, 0.14, mats.carpet, 0.05));   // transmission tunnel
  const gearLever = new THREE.Group();
  gearLever.position.set(-0.08, 0.99, -0.2);
  body.add(gearLever);
  gearLever.add(mesh(new THREE.CylinderGeometry(0.009, 0.012, 0.3, 10).translate(0, 0.15, 0), mats.cabinMetal));
  gearLever.add(mesh(new THREE.SphereGeometry(0.028, 16, 12), mats.seatTrim, 0, 0.31, 0));
  add(mesh(new THREE.CylinderGeometry(0.05, 0.065, 0.05, 16), mats.seal, -0.08, 1.0, -0.2));   // gaiter
  const transferLever = new THREE.Group();
  transferLever.position.set(0.04, 0.99, -0.1);
  body.add(transferLever);
  transferLever.add(mesh(new THREE.CylinderGeometry(0.008, 0.01, 0.22, 10).translate(0, 0.11, 0), mats.cabinMetal));
  transferLever.add(mesh(new THREE.SphereGeometry(0.022, 14, 10), mats.tail, 0, 0.225, 0));
  add(mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.04, 14), mats.seal, 0.04, 1.0, -0.1));
  dynamic.push(gearLever, transferLever);
  // handbrake between the seats
  add(rbox(0.04, 0.05, 0.26, 0.015, mats.seal, 0.0, 1.03, 0.08)).rotation.x = 0.35;
  // pedals
  for (const [x, w] of [[DX - 0.12, 0.06], [DX + 0.01, 0.07], [DX + 0.15, 0.08]]) {
    add(rbox(w, 0.08, 0.015, 0.006, mats.seal, x, 0.92, -0.58)).rotation.x = -0.5;
    add(bar([x, 0.95, -0.6], [x, 1.05, -0.62], 0.008, mats.cabinMetal, 6));
  }
  // floor mats
  for (const x of [DX, -DX]) add(span(x - 0.24, x + 0.24, FLOOR, FLOOR + 0.008, -0.68, -0.2, mats.rubber, 0.003));

  // ---------------------------------------------------------------- seats
  // front: seat box across the cabin, two buckets, centre cubby
  add(span(-0.8, 0.8, FLOOR, 0.99, -0.12, 0.42, mats.cabinPaint, 0.01));
  const seat = (x, z, back = 0.21, head = true, w = 0.5) => {
    add(span(x - w / 2, x + w / 2, 0.99, 1.13, z - 0.5, z + 0.04, mats.seat, 0.05));                 // cushion
    for (const s of sides) add(span(x + s * (w / 2 - 0.05), x + s * (w / 2), 1.08, 1.17, z - 0.48, z + 0.02, mats.seat, 0.03)); // bolsters
    const bk = add(rbox(w, 0.64, 0.13, 0.05, mats.seat, x, 1.44, z + 0.13));
    bk.rotation.x = back;   // + leans the top rearwards (towards +z)
    for (const s of sides) { const b = add(rbox(0.06, 0.6, 0.15, 0.03, mats.seat, x + s * (w / 2 - 0.03), 1.43, z + 0.14)); b.rotation.x = back; }
    add(rbox(w - 0.1, 0.5, 0.03, 0.01, mats.seatTrim, x, 1.42, z + 0.215)).rotation.x = back; // seat back shell
    if (head) {
      add(rbox(0.27, 0.17, 0.09, 0.04, mats.seat, x, 1.85, z + 0.26));
      for (const s of sides) add(bar([x + s * 0.06, 1.77, z + 0.25], [x + s * 0.06, 1.72, z + 0.24], 0.006, mats.cabinMetal, 6));
    }
  };
  seat(DX, 0.0);
  seat(-DX, 0.0);
  add(rbox(0.3, 0.2, 0.42, 0.04, mats.dashSoft, 0, 1.08, 0.18));   // centre cubby / armrest
  // rear bench (second row) on its box, rear wheel arch boxes, cargo floor
  add(span(-0.8, 0.8, FLOOR, 0.98, 0.62, 1.15, mats.cabinPaint, 0.01));
  add(span(-0.76, 0.76, 0.98, 1.11, 0.64, 1.14, mats.seat, 0.05));
  const rb = add(rbox(1.5, 0.6, 0.13, 0.05, mats.seat, 0, 1.41, 1.22));
  rb.rotation.x = 0.17;
  for (const x of [-0.5, 0, 0.5]) add(rbox(0.25, 0.15, 0.08, 0.035, mats.seat, x, 1.79, 1.3));
  for (const s of sides) {
    add(span(s * 0.555, s * 0.86, 1.03, 1.1, 0.8, 2.0, mats.cabinPaint, 0.02));     // wheel arch housing
    add(span(s * 0.555, s * 0.575, FLOOR, 1.1, 0.8, 2.0, mats.cabinPaint, 0.005));
    add(span(s * 0.6, s * 0.84, 1.1, 1.16, 1.3, 2.2, mats.seat, 0.03));             // folded side bench
  }

  // ---------------------------------------------------------------- door cards, pillars, trims
  for (const s of sides) {
    const xi = s * (W - 0.05);
    // front door card with armrest, pull, winder, interior handle
    add(span(xi - 0.012, xi + 0.012, 0.8, WAIST - 0.01, -0.665, 0.215, mats.dashSoft, 0.008));
    add(span(xi, xi - s * 0.03, WAIST - 0.03, WAIST + 0.012, -0.67, 0.22, mats.dash, 0.01));   // capping
    add(rbox(0.06, 0.05, 0.36, 0.02, mats.dash, xi - s * 0.035, 1.12, -0.18));                // armrest
    add(bar([xi - s * 0.02, 1.2, -0.42], [xi - s * 0.02, 1.2, -0.2], 0.01, mats.seal, 6));     // pull
    add(mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.015, 14).rotateZ(Math.PI / 2), mats.cabinMetal, xi - s * 0.02, 1.27, -0.05));
    add(bar([xi - s * 0.03, 1.27, -0.05], [xi - s * 0.03, 1.22, 0.02], 0.006, mats.cabinMetal, 6));
    add(rbox(0.02, 0.03, 0.09, 0.008, mats.cabinMetal, xi - s * 0.02, 1.3, -0.5));
    // rear door card
    add(span(xi - 0.012, xi + 0.012, 0.8, WAIST - 0.01, 0.255, 0.96, mats.dashSoft, 0.008));
    add(span(xi, xi - s * 0.03, WAIST - 0.03, WAIST + 0.012, 0.25, 0.965, mats.dash, 0.01));
    // rear quarter trim
    add(span(xi - 0.012, xi + 0.012, 1.1, WAIST - 0.01, 0.99, REAR - 0.06, mats.dashSoft, 0.008));
    // B pillar trim + seat belt
    const xb = s * (WG * D.tumble(1.6) - 0.045);
    add(span(xb - 0.015, xb + 0.015, WAIST, EAVE - 0.03, 0.17, 0.29, mats.dashSoft, 0.01));
    add(rbox(0.02, 0.05, 0.05, 0.01, mats.seatTrim, xb - s * 0.02, 1.86, 0.25));
    add(span(xb - s * 0.02 - 0.002, xb - s * 0.02 + 0.002, 1.0, 1.85, 0.255, 0.30, mats.seatTrim));
    // grab handle above the door
    add(pipe([[xb - s * 0.02, 1.88, -0.32], [xb - s * 0.05, 1.86, -0.3], [xb - s * 0.05, 1.86, -0.1], [xb - s * 0.02, 1.88, -0.08]], 0.009, mats.seatTrim, 0.02, 6));
  }

  // ---------------------------------------------------------------- headliner, header, visors, mirror
  {
    const hy = EAVE - 0.01;
    const xw = WG * D.tumble(hy) - 0.04;
    add(span(-xw + 0.06, xw - 0.06, hy - 0.004, hy + 0.012, D.HEADER + 0.03, REAR - 0.06, mats.headliner, 0.006));
    // coves down to the window tops
    for (const s of sides) add(span(s * (xw - 0.07), s * xw, hy - 0.05, hy + 0.01, D.HEADER + 0.03, REAR - 0.06, mats.headliner, 0.02));
    // transverse seams + dome lamp
    for (const z of [0.25, 1.05, 1.75]) add(span(-xw + 0.07, xw - 0.07, hy - 0.007, hy - 0.004, z - 0.004, z + 0.004, mats.dashSoft));
    add(rbox(0.16, 0.02, 0.08, 0.008, mats.seatTrim, 0, hy - 0.01, 0.42));
    add(rbox(0.12, 0.012, 0.05, 0.006, mats.sideLens, 0, hy - 0.019, 0.42)).castShadow = false;
    // header rail over the screen
    const zH = D.HEADER;
    add(span(-xw, xw, hy - 0.06, hy + 0.005, zH - 0.02, zH + 0.06, mats.dashSoft, 0.015));
    // sun visors folded up
    for (const x of [DX, -DX]) {
      const v = add(rbox(0.38, 0.022, 0.16, 0.012, mats.headliner, x, hy - 0.072, zH + 0.13));
      v.rotation.x = 0.12;
      add(bar([x - 0.2, hy - 0.06, zH + 0.06], [x - 0.2, hy - 0.072, zH + 0.12], 0.006, mats.cabinMetal, 6));
    }
    // interior mirror on a stem from the header, turned towards the driver
    const mg = new THREE.Group();
    mg.position.set(0, hy - 0.095, zH + 0.05);
    mg.rotation.set(-0.08, -0.28, 0);
    body.add(mg);
    add(bar([0, hy - 0.05, zH + 0.03], [0, hy - 0.085, zH + 0.05], 0.008, mats.seatTrim, 6));
    add(rbox(0.215, 0.066, 0.03, 0.02, mats.seatTrim, 0, 0, 0), mg);
    add(rbox(0.2, 0.053, 0.004, 0.016, mats.mirror, 0, 0, 0.0155), mg).castShadow = false;
  }
  // A-pillar trims inside the screen frame
  for (const s of sides) {
    const p0 = [s * (WG - 0.045), WAIST + 0.01, D.SCREEN + 0.035], p1 = [s * (WG * D.tumble(EAVE) - 0.045), EAVE - 0.03, D.HEADER + 0.035];
    add(bar(p0, p1, 0.028, mats.dashSoft, 10));
  }

  return {
    needles, gaugeMat, needleMat, warnMat, steeringWheel: swRot, steeringBase: steeringWheel, gearLever, transferLever,
    driverEye: EYE.clone(), dynamic, gaugeMeshes,
  };
}
