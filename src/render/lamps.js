import * as THREE from 'three/webgpu';
import { normalView, dot, max, abs, inverseSqrt, float, If } from 'three/tsl';

// Spot lights with an irradiance shoulder (only the vehicles and the muzzle flash have spot lights).
// Inverse-square makes a bank or a tree trunk 8-10 m ahead, facing the lamps, ~100x brighter than the road
// at 30-60 m (I/d^2 vs I*h/r^3); with a fixed exposure it blows out and blooms over the whole windscreen.
// The eye adapts locally; this emulates it with a soft cap on each lamp's irradiance: E -> E/sqrt(1+(E/K)^2).
// Road irradiance from the beams is ~1-7 (scene units), so the far throw is untouched.
export const LAMP_KNEE = 9.0;

class LampSpotLightNode extends THREE.SpotLightNode {
  static get type() { return 'LampSpotLightNode'; }
  // the lamps stay in the scene when off (a light leaving the scene rebuilds every lit shader): a switched-off
  // lamp (intensity 0) skips its cookie, shadow and BRDF work in a real branch
  setup(builder) {
    const c = this.colorNode;
    If(c.r.add(c.g).add(c.b).greaterThan(0.0), () => { super.setup(builder); });
  }
  setupDirect(builder) {
    const d = super.setupDirect(builder);
    const c = d.lightColor;
    // |N.L|: leaves and blades also take the light through their back face (render/foliage.js), so the
    // cap must hold there too (with max(N.L, 0) a bush facing away got the uncapped lamp, brighter than it)
    const E = abs(dot(normalView, d.lightDirection)).mul(max(c.r, max(c.g, c.b)));
    d.lightColor = c.mul(inverseSqrt(E.mul(E).mul(1 / (LAMP_KNEE * LAMP_KNEE)).add(1.0)));
    return d;
  }
}

export function installLamps(renderer) {
  renderer.library.lightNodes.delete(THREE.SpotLight);   // replace three's own (no redefinition warning)
  renderer.library.addLight(LampSpotLightNode, THREE.SpotLight);
}
