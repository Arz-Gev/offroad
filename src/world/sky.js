import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, Continue, uniform, texture, vec2, vec3, vec4, float, int, uv, positionLocal, positionWorld, cameraPosition,
  normalize, dot, length, sqrt, exp, pow, max, min, abs, clamp, mix, smoothstep, step, sign, asin, acos, atan, sin, cos,
  fract, floor, fwidth, cross, select, varying, modelWorldMatrix, cameraProjectionMatrix, cameraViewMatrix,
} from 'three/tsl';
import { ATM } from './atmosphere.js';
import { mulberry32 } from './noise.js';

// Sky: a 256x128 sky-view LUT rendered with single scattering whenever the light changes (time-of-day
// blends), then a dome that reads it and adds the sun disc, the moon, stars, the Milky Way and a moving
// cloud layer. The same dome (without the sun disc) renders into the PMREM environment map.

const LUT_W = 256, LUT_H = 128;
const PIf = 3.14159265;

// ---- single scattering (same constants as atmosphere.js, which does the CPU side)
// R2: the sphere's squared radius
const aRaySphere = Fn(([o, d, R2]) => {
  const b = dot(o, d);
  const c = dot(o, o).sub(R2);
  const disc = b.mul(b).sub(c);
  const s = sqrt(max(disc, 0.0));
  return select(disc.lessThan(0.0), vec2(-1.0, -1.0), vec2(b.negate().sub(s), b.negate().add(s)));
});

const aLightDepth = Fn(([p, l]) => {
  // xy: optical depth (Rayleigh, Mie), z: 1 if the light reaches p (0 if the planet blocks it)
  const g = aRaySphere(p, l, float(ATM.Re * ATM.Re));
  const t = aRaySphere(p, l, float(ATM.Ra * ATM.Ra)).y;
  const ds = t.div(8.0);
  const od = vec2(0).toVar();
  Loop(8, ({ i }) => {
    const q = p.add(l.mul(ds.mul(float(i).add(0.5))));
    const h = length(q).sub(ATM.Re);
    od.addAssign(vec2(exp(h.negate().div(ATM.Hr)), exp(h.negate().div(ATM.Hm))).mul(ds));
  });
  return vec3(od, select(g.x.greaterThan(0.0), float(0), float(1)));
});

const aScatter = Fn(([v, l]) => {
  const o = vec3(0.0, ATM.Re + ATM.eyeH, 0.0);
  const tmax = aRaySphere(o, v, float(ATM.Ra * ATM.Ra)).y.toVar();
  const gr = aRaySphere(o, v, float(ATM.Re * ATM.Re));
  If(gr.x.greaterThan(0.0), () => { tmax.assign(min(tmax, gr.x)); });
  const mu = dot(v, l);
  const pr = float(3.0 / (16.0 * PIf)).mul(mu.mul(mu).add(1.0));
  const g = ATM.g;
  const pm = float(3.0 / (8.0 * PIf)).mul((1 - g * g)).mul(mu.mul(mu).add(1.0)).div(pow(float(1 + g * g).sub(mu.mul(2 * g)), 1.5).mul(2 + g * g));
  const od = vec2(0).toVar();
  const sR = vec3(0).toVar(), sM = vec3(0).toVar();
  const tPrev = float(0).toVar();
  const betaR = vec3(...ATM.betaR);
  const STEPS = 24;
  Loop(STEPS, ({ i }) => {
    const f = float(i).add(1).div(STEPS);
    const t1 = tmax.mul(f).mul(f);
    // toVar: TSL expressions are generated where they are first used, so anything read after
    // tPrev changes must be pinned before the assignment
    const ds = t1.sub(tPrev).toVar();
    const s = tPrev.add(ds.mul(0.5)).toVar();
    tPrev.assign(t1);
    const p = o.add(v.mul(s));
    const h = length(p).sub(ATM.Re);
    const hr = exp(h.negate().div(ATM.Hr)).mul(ds), hm = exp(h.negate().div(ATM.Hm)).mul(ds);
    od.addAssign(vec2(hr, hm));
    const ld = aLightDepth(p, l);
    If(ld.z.greaterThan(0.5), () => {
      const tau = betaR.mul(od.x.add(ld.x)).add(float(ATM.betaM * ATM.mieExt).mul(od.y.add(ld.y)));
      const a = exp(tau.negate());
      sR.addAssign(a.mul(hr)); sM.addAssign(a.mul(hm));
    });
  });
  return sR.mul(betaR).mul(pr).add(sM.mul(ATM.betaM).mul(pm));
});

const hash13 = Fn(([p0]) => { const p = fract(p0.mul(0.1031)).toVar(); p.addAssign(dot(p, p.zyx.add(31.32))); return fract(p.x.add(p.y).mul(p.z)); });
const hash33 = Fn(([p0]) => { const p = fract(p0.mul(vec3(0.1031, 0.1030, 0.0973))).toVar(); p.addAssign(dot(p, p.yxz.add(33.33))); return fract(p.xxy.add(p.yxx).mul(p.zyx)); });

function makeNoiseTexture(size = 256) {
  // tileable value-noise fbm, four independent channels (r: big shapes, g: mid, b/a: detail)
  const rnd = mulberry32(4242);
  const grid = (period) => { const v = new Float32Array(period * period); for (let i = 0; i < v.length; i++) v[i] = rnd(); return v; };
  const sample = (v, period, x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), tx = x - xi, ty = y - yi;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const x0 = ((xi % period) + period) % period, y0 = ((yi % period) + period) % period;
    const x1 = (x0 + 1) % period, y1 = (y0 + 1) % period;
    const a = v[y0 * period + x0], b = v[y0 * period + x1], c = v[y1 * period + x0], d = v[y1 * period + x1];
    return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
  };
  const chans = [[4, 5], [8, 4], [16, 4], [32, 3]].map(([base, oct]) => {
    const layers = []; for (let o = 0; o < oct; o++) layers.push({ p: base << o, v: grid(base << o) });
    return layers;
  });
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    for (let c = 0; c < 4; c++) {
      let s = 0, a = 1, n = 0;
      for (const L of chans[c]) { s += a * sample(L.v, L.p, x / size * L.p, y / size * L.p); n += a; a *= 0.5; }
      data[(y * size + x) * 4 + c] = Math.round(Math.min(1, Math.max(0, (s / n - 0.5) * 1.6 + 0.5)) * 255);
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

export class Sky {
  constructor(renderer) {
    this.renderer = renderer;
    this.lut = new THREE.RenderTarget(LUT_W, LUT_H, { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.lut.texture.wrapS = THREE.RepeatWrapping;
    const U = this.uniforms = {
      uSunDir: uniform(new THREE.Vector3(0, 1, 0)), uMoonDir: uniform(new THREE.Vector3(0, 1, 0)),
      uSunE: uniform(new THREE.Vector3()), uMoonE: uniform(new THREE.Vector3()), uNightBase: uniform(new THREE.Vector3()),
      uSunDisc: uniform(new THREE.Vector3()), uMoonDisc: uniform(new THREE.Vector3()), uGround: uniform(new THREE.Vector3(0.02, 0.02, 0.018)),
      uCloudLit: uniform(new THREE.Vector3(1, 1, 1)), uCloudAmb: uniform(new THREE.Vector3(0.3, 0.33, 0.4)),
      uTime: uniform(0), uCover: uniform(0.45), uStars: uniform(0), uSunSize: uniform(0.0125), uCloudAlpha: uniform(1), uMoonPhase: uniform(0.6),
      uWind: uniform(new THREE.Vector2(0.0011, 0.0004)), uCamPos: uniform(new THREE.Vector3()),
      uRain: uniform(0),
    };
    this.noise = makeNoiseTexture();

    // ---- the LUT pass
    const lutMat = new THREE.NodeMaterial();
    lutMat.fragmentNode = Fn(() => {
      const az = uv().x.mul(6.2831853);
      const t = uv().y.mul(2.0).sub(1.0);
      const el = sign(t).mul(t).mul(t).mul(1.5707963);
      const v = vec3(cos(el).mul(sin(az)), sin(el), cos(el).mul(cos(az)));
      const c = vec3(0).toVar();
      If(dot(U.uSunE, U.uSunE).greaterThan(0.0), () => { c.addAssign(aScatter(v, U.uSunDir).mul(U.uSunE)); });
      If(dot(U.uMoonE, U.uMoonE).greaterThan(0.0), () => { c.addAssign(aScatter(v, U.uMoonDir).mul(U.uMoonE)); });
      // airglow / light pollution: a faint floor so the night sky is deep blue rather than black
      c.addAssign(U.uNightBase.mul(pow(float(1).sub(max(v.y, 0.0)), 3.0).mul(0.45).add(0.55)));
      return vec4(c, 1.0);
    })();
    this.lutQuad = new THREE.QuadMesh(lutMat);

    // ---- the dome
    const tLUT = texture(this.lut.texture), tNoise = texture(this.noise);
    const lut = Fn(([d]) => {
      const el = asin(clamp(d.y, -1.0, 1.0));
      const t = sign(el).mul(sqrt(abs(el).div(1.5707963)));
      const az = atan(d.x, d.z);
      return tLUT.sample(vec2(fract(az.div(6.2831853)), t.mul(0.5).add(0.5))).rgb;
    });
    const cloudDensity = Fn(([p]) => {
      const n = tNoise.sample(p);
      const n2 = tNoise.sample(p.mul(3.1).add(vec2(0.37, 0.71)).add(U.uWind.mul(U.uTime).mul(0.6)));
      const f = n.r.mul(0.55).add(n.g.mul(0.25)).add(n2.b.mul(0.14)).add(n2.a.mul(0.06));
      const cover = U.uCover;
      return smoothstep(float(1).sub(cover), float(1).sub(cover).add(0.32), f);
    });
    const stars = Fn(([d]) => {
      const s = float(0).toVar();
      for (const [scale, pw] of [[160.0, 18.0], [330.0, 30.0]]) {
        const p = d.mul(scale);
        const cell = floor(p);
        const h = hash33(cell);
        const b = pow(hash13(cell.add(7.0)), pw);
        const c = cell.add(0.2).add(h.mul(0.6));
        const dd = length(p.sub(c)).div(scale);
        const px = fwidth(dd).mul(1.2).add(1e-5);
        const tw = sin(U.uTime.mul(h.x.mul(4.0).add(2.0)).add(h.y.mul(40.0))).mul(0.25).add(0.75);
        s.addAssign(b.mul(tw).mul(smoothstep(px.mul(1.6), 0.0, dd)).mul(12.0));
      }
      return s;
    });
    const domeColor = (withSun) => Fn(() => {
      const d = normalize(positionLocal);
      const col = lut(d).toVar();
      const up = d.y;
      // below the horizon (seen only from high ground, mostly hidden by terrain): dark ground haze
      col.assign(mix(col, U.uGround.add(col.mul(0.6)), smoothstep(0.0, -0.08, up)));
      // night sky: stars + Milky Way band, faded near the horizon by the atmosphere
      If(U.uStars.greaterThan(0.001).and(up.greaterThan(-0.02)), () => {
        const hz = smoothstep(-0.02, 0.25, up);
        const gal = vec3(0.35, 0.55, -0.76).normalize();
        const band = exp(pow(dot(d, gal).div(0.16), 2.0).negate());
        const bp = vec2(atan(d.x, d.z), asin(d.y)).mul(2.0);
        const mw = band.mul(tNoise.sample(bp.mul(0.35)).g.mul(0.55).add(0.45)).mul(tNoise.sample(bp.mul(1.3)).r.mul(0.4).add(0.6));
        col.addAssign(vec3(0.55, 0.6, 0.8).mul(mw).mul(0.0016).mul(U.uStars).mul(hz));
        col.addAssign(vec3(0.85, 0.9, 1.0).mul(stars(d)).mul(0.012).mul(U.uStars).mul(hz));
      });
      if (withSun) {
        // sun disc (limb darkened) and the moon
        const cs = dot(d, U.uSunDir);
        const r = acos(clamp(cs, -1.0, 1.0)).div(U.uSunSize);
        If(r.lessThan(1.0), () => {
          const mu = sqrt(float(1).sub(r.mul(r)));
          col.addAssign(U.uSunDisc.mul(mu.mul(0.6).add(0.4)).mul(smoothstep(1.0, 0.9, r)).mul(float(1).sub(U.uRain.mul(0.9))));
        });
        const cm = dot(d, U.uMoonDir);
        const rm = acos(clamp(cm, -1.0, 1.0)).div(0.0105);
        If(rm.lessThan(1.0), () => {
          const mx = normalize(cross(U.uMoonDir, vec3(0.0, 1.0, 0.0)));
          const my = cross(mx, U.uMoonDir);
          const q = vec2(dot(d.sub(U.uMoonDir), mx), dot(d.sub(U.uMoonDir), my)).div(0.0105);
          const z = sqrt(max(0.0, float(1).sub(dot(q, q))));
          const lit = clamp(dot(normalize(vec3(q, z)), normalize(vec3(U.uMoonPhase, 0.25, 0.6))).mul(1.2).add(0.15), 0.0, 1.0);
          const maria = tNoise.sample(q.mul(0.18).add(0.5)).r.mul(0.25).add(0.75);
          col.addAssign(U.uMoonDisc.mul(lit).mul(maria).mul(smoothstep(1.0, 0.94, rm)));
        });
        col.addAssign(U.uMoonDisc.mul(0.0009).mul(exp(max(rm.sub(1.0), 0.0).mul(-0.12))));
      }
      // clouds: a layer at ~1.8 km, lit from the sun/moon direction, fading into the haze at the horizon
      If(up.greaterThan(0.0).and(U.uCloudAlpha.greaterThan(0.001)), () => {
        const p = d.xz.mul(float(1800.0).div(max(up, 0.02))).add(U.uCamPos.xz).div(9000.0).add(U.uWind.mul(U.uTime));
        const den = cloudDensity(p);
        If(den.greaterThan(0.001), () => {
          const L = select(U.uSunDir.y.greaterThan(-0.05), U.uSunDir, U.uMoonDir);
          const lo = normalize(L.xz.add(1e-4)).mul(0.018);
          const shade = cloudDensity(p.add(lo)).mul(0.7).add(cloudDensity(p.add(lo.mul(2.2))).mul(0.3));
          const light = exp(shade.mul(-2.4)).mul(float(1).sub(den.mul(0.35)));
          const mu = dot(d, L);
          const g = 0.55;
          const phase = float(1 - g * g).div(pow(float(1 + g * g).sub(mu.mul(2 * g)), 1.5)).mul(0.12).add(0.35);
          // rain: grey, heavy, less light through
          const cc0 = U.uCloudAmb.mul(up.mul(0.25).add(0.75)).add(U.uCloudLit.mul(light).mul(phase).mul(float(1).sub(U.uRain.mul(0.7))));
          const fade = smoothstep(0.0, 0.18, up);
          const a = den.mul(fade).mul(U.uCloudAlpha);
          const cc = mix(cc0, col, float(1).sub(fade).mul(0.5));
          col.assign(mix(col, cc, a));
        });
      });
      return col;
    })();

    const domeMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    domeMat.colorNode = domeColor(true);
    // push the dome to the far plane (inside the frustum): every terrain pixel in front of it wins early-z
    domeMat.vertexNode = Fn(() => {
      const p = cameraProjectionMatrix.mul(cameraViewMatrix).mul(modelWorldMatrix).mul(vec4(positionLocal, 1.0)).toVar();
      p.z.assign(p.w.mul(0.99999));
      return p;
    })();
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), domeMat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = 1e6;
    this.dome.scale.setScalar(2500);
    this.dome.castShadow = this.dome.receiveShadow = false;
    // environment version: no sun disc (the sun's direct light is the directional light)
    this.envScene = new THREE.Scene();
    const envMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    envMat.colorNode = domeColor(false);
    this.envDome = new THREE.Mesh(this.dome.geometry, envMat);
    this.envDome.scale.setScalar(100);
    this.envScene.add(this.envDome);
  }

  // sunE / moonE: illuminance (rgb) at the top of the atmosphere times the sky brightness scale
  updateLUT(sunDir, sunE, moonDir, moonE, nightBase) {
    const u = this.uniforms;
    u.uSunDir.value.copy(sunDir); u.uMoonDir.value.copy(moonDir);
    u.uSunE.value.copy(sunE); u.uMoonE.value.copy(moonE); u.uNightBase.value.copy(nightBase);
    const r = this.renderer, prev = r.getRenderTarget();
    r.setRenderTarget(this.lut);
    this.lutQuad.render(r);
    r.setRenderTarget(prev);
  }

  update(dt, camera) {
    this.uniforms.uTime.value += dt;
    this.dome.position.copy(camera.position);
    this.uniforms.uCamPos.value.copy(camera.position);
    const far = camera.far * 0.9;
    if (this.dome.scale.x !== far) this.dome.scale.setScalar(far);
  }
}
