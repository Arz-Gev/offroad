import * as THREE from 'three/webgpu';
import { normalView, dot, max, inverseSqrt, float } from 'three/tsl';

// Spot lights with an irradiance shoulder (only the vehicles and the muzzle flash have spot lights).
// Inverse-square makes a bank or a tree trunk 8-10 m ahead, facing the lamps, ~100x brighter than the road
// at 30-60 m (I/d^2 vs I*h/r^3); with a fixed exposure it blows out and blooms over the whole windscreen.
// The eye adapts locally; this emulates it with a soft cap on each lamp's irradiance: E -> E/sqrt(1+(E/K)^2).
// Road irradiance from the beams is ~1-7 (scene units), so the far throw is untouched.
export const LAMP_KNEE = 9.0;

class LampSpotLightNode extends THREE.SpotLightNode {
  static get type() { return 'LampSpotLightNode'; }
  setupDirect(builder) {
    const d = super.setupDirect(builder);
    const c = d.lightColor;
    const E = max(dot(normalView, d.lightDirection), 0.0).mul(max(c.r, max(c.g, c.b)));
    d.lightColor = c.mul(inverseSqrt(E.mul(E).mul(1 / (LAMP_KNEE * LAMP_KNEE)).add(1.0)));
    return d;
  }
}

export function installLamps(renderer) {
  renderer.library.lightNodes.delete(THREE.SpotLight);   // replace three's own (no redefinition warning)
  renderer.library.addLight(LampSpotLightNode, THREE.SpotLight);
}
