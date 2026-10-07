import * as THREE from 'three/webgpu';
import { CSMShadowNode } from 'three/examples/jsm/csm/CSMShadowNode.js';
import { Fn, If, float, vec2, uniform, texture, reference, renderGroup, positionWorld, shadow } from 'three/tsl';

// Sun shadow in two parts:
// - the world (terrain, trees, rocks, props): cascaded shadow maps (three's CSMShadowNode) with explicit
//   split distances from the quality preset (render/quality.js SHADOWS) and a smooth wide filter, so the
//   shadows of trees are soft like real ones (the sun is a disc: the further the caster is from the ground,
//   the softer the edge, and leaves are metres up);
// - the player's car: its own small, sharp map that follows the car (CAR_LAYER, nothing else is drawn into
//   it), so the contact shadow under the car and its shadow on itself stay crisp. The car is not in the
//   world cascades at all.
// The light is a DirectionalLight whose position is the direction towards the sun (the target stays at
// the origin); CSM places one shadow camera per cascade around the view frustum slice, snapped to texels.
// Changing the cascade count or map size makes a new node (materials recompile once).

export const CAR_LAYER = 2;   // the player's car meshes: drawn by the view camera and the car shadow only

// 3x3 grid of hardware-filtered compares, `radius` texels apart: a smooth penumbra (no noise, no rings)
const smoothPCF = Fn(({ depthTexture, shadowCoord, shadow }) => {
  const mapSize = reference('mapSize', 'vec2', shadow).setGroup(renderGroup);
  const radius = reference('radius', 'float', shadow).setGroup(renderGroup);
  const step = vec2(radius).div(mapSize).toVar();
  let sum = float(0);
  for (let y = -1; y <= 1; y++) {
    for (let x = -1; x <= 1; x++) sum = sum.add(texture(depthTexture, shadowCoord.xy.add(step.mul(vec2(x, y)))).compare(shadowCoord.z));
  }
  return sum.div(9);
});

class CarLight extends THREE.Object3D {
  constructor() { super(); this.target = new THREE.Object3D(); }
}

const _m = new THREE.Matrix4(), _mi = new THREE.Matrix4(), _c = new THREE.Vector3(), _dir = new THREE.Vector3();

class SunShadowNode extends CSMShadowNode {
  constructor(light, data, car) {
    super(light, data);
    this.car = car;   // { map, half, focus: Object3D | null, center: Vector3 (in focus space) }
    this.uCarC = uniform(new THREE.Vector3()).setGroup(renderGroup);
    this.uCarL = uniform(new THREE.Vector3(0, 1, 0)).setGroup(renderGroup);
    this.uCarR2 = uniform(0).setGroup(renderGroup);
  }

  _init(builder) {
    super._init(builder);
    for (const l of this.lights) l.shadow.filterNode = smoothPCF;
    const cs = this.light.shadow.clone();
    cs.mapSize.set(this.car.map, this.car.map);
    cs.camera.layers.set(CAR_LAYER);
    cs.camera.near = 1;
    cs.camera.far = 120;
    cs.bias = -0.0001;
    cs.normalBias = 0.006;
    cs.radius = 1;
    cs.filterNode = smoothPCF;
    this.carLight = new CarLight();
    this.carLight.castShadow = true;
    this.carLight.shadow = cs;
    this.carShadow = shadow(this.carLight, cs);
    this.onInit?.();
  }

  setup(builder) {
    const world = super.setup(builder);
    return Fn(() => {
      const s = world.toVar();
      // only near the car (its shadow map covers the car's outline as seen from the sun): elsewhere skip the taps
      const d = positionWorld.sub(this.uCarC);
      const perp = d.sub(this.uCarL.mul(d.dot(this.uCarL)));
      If(perp.dot(perp).lessThan(this.uCarR2), () => { s.mulAssign(this.carShadow); });
      return s;
    })();
  }

  updateBefore(frame) {
    super.updateBefore(frame);
    const L = this.carLight, car = this.car, light = this.light;
    if (L.parent === null) { light.parent.add(L.target); light.parent.add(L); }
    const focus = car.focus;
    if (!focus) { this.uCarR2.value = 0; return; }
    const sc = L.shadow.camera;
    sc.left = sc.bottom = -car.half; sc.right = sc.top = car.half;
    sc.updateProjectionMatrix();
    _dir.subVectors(light.position, light.target.position).normalize();   // towards the light
    focus.updateMatrixWorld();
    _c.copy(car.center).applyMatrix4(focus.matrixWorld);
    this.uCarC.value.copy(_c);
    this.uCarL.value.copy(_dir);
    this.uCarR2.value = car.half * car.half;
    // snap to the map's texels in light space (no crawling edges as the car moves)
    const texel = 2 * car.half / car.map;
    _m.lookAt(_dir, new THREE.Vector3(0, 0, 0), THREE.Object3D.DEFAULT_UP);
    _mi.copy(_m).invert();
    _c.applyMatrix4(_mi);
    _c.x = Math.round(_c.x / texel) * texel;
    _c.y = Math.round(_c.y / texel) * texel;
    _c.applyMatrix4(_m);
    L.position.copy(_c).addScaledVector(_dir, 60);
    L.target.position.copy(_c);
    L.updateMatrixWorld();
    L.target.updateMatrixWorld();
  }

  dispose() {
    if (this.carLight?.parent) { this.carLight.parent.remove(this.carLight.target); this.carLight.parent.remove(this.carLight); }
    super.dispose();
  }
}

export class SunShadows {
  constructor(light) {
    this.light = light;
    this.spec = null;
    // the car's own sharp shadow: set by setCar (main.js) once the car is built
    this.car = { map: 1024, half: 4, focus: null, center: new THREE.Vector3() };
    light.castShadow = true;
    const sh = light.shadow;
    // layer 1: shadow-only proxies (the lighter tree crowns, trees.js); CSM clones this camera per cascade
    sh.camera.layers.enable(1);
    sh.camera.near = 1;
    sh.camera.far = 1200;
    sh.bias = -0.0002;
    sh.normalBias = 0.04;
    sh.radius = 1;
    this.csm = null;
  }

  // the player's car: its meshes go on CAR_LAYER (out of the world cascades, into the car's own map)
  setCar(root, camera) {
    camera.layers.enable(CAR_LAYER);
    root.traverse(o => { if (o.isMesh) o.layers.set(CAR_LAYER); });
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    this.car.focus = root;
    this.car.center.copy(root.worldToLocal(sphere.center.clone()));
    this.car.half = sphere.radius + 0.3;
  }

  // S: { map, far, cascades, splits, soft, car } or null (no sun shadow)
  configure(S) {
    const light = this.light;
    light.castShadow = !!S;
    if (!S) return;
    const key = `${S.map}/${S.cascades}/${S.car}`;
    const sh = light.shadow;
    this.car.map = S.car;
    if (!this.csm || this.key !== key) {
      this.key = key;
      if (this.csm) { this.csm.dispose(); this.csm = null; }
      sh.mapSize.set(S.map, S.map);
      if (sh.map) { sh.map.dispose(); sh.map = null; }
      this.csm = new SunShadowNode(light, {
        cascades: S.cascades, maxFar: S.far, mode: 'custom', lightMargin: 120,
        customSplitsCallback: (n, near, far, out) => {
          for (let i = 0; i < n - 1; i++) out.push(Math.min(0.95, (this.spec.splits[i] ?? far * (i + 1) / n) / far));
          out.push(1);
        },
      }, this.car);
      this.csm.fade = true;
      this.csm.onInit = () => this.updateCascades();
      sh.shadowNode = this.csm;
    }
    this.spec = S;
    this.csm.maxFar = S.far;
    // texel-scaled bias: the far cascades have bigger texels
    sh.normalBias = 0.02 + 0.6 * S.far / S.map * 0.05;
    if (this.csm.camera) this.updateCascades();
  }

  // after the view camera changes (fov, aspect) and on configure: cascade bounds + filter width per cascade
  updateCascades() {
    const csm = this.csm;
    if (!csm?.camera) return;
    csm.updateFrustums();
    for (const l of csm.lights) {
      const cam = l.shadow.camera;
      const texel = (cam.right - cam.left) / l.shadow.mapSize.x;
      l.shadow.radius = THREE.MathUtils.clamp(this.spec.soft / texel, 0.8, 1.5);
      l.shadow.normalBias = this.light.shadow.normalBias;
    }
  }
}
