import * as THREE from 'three/webgpu';
import { CSMShadowNode } from 'three/examples/jsm/csm/CSMShadowNode.js';

// Cascaded sun shadow (three's CSMShadowNode): 2-4 cascades with explicit split distances from the quality
// preset (render/quality.js SHADOWS), one depth map per cascade, a fade band between cascades.
// The light is a DirectionalLight whose position is the direction towards the sun (the target stays at
// the origin); CSM places one shadow camera per cascade around the view frustum slice, snapped to texels.
// Changing the cascade count or map size makes a new CSM node (materials recompile once).

export class SunShadows {
  constructor(light, camera) {
    this.light = light;
    this.camera = camera;
    this.spec = null;
    light.castShadow = true;
    const sh = light.shadow;
    // layer 1: shadow-only proxies (the lighter tree crowns, trees.js); CSM clones this camera per cascade
    sh.camera.layers.enable(1);
    sh.camera.near = 1;
    sh.camera.far = 1200;
    sh.bias = -0.0002;
    sh.normalBias = 0.04;
    sh.radius = 2;
    this.csm = null;
  }

  // S: { map, far, cascades, splits, soft } or null (no sun shadow)
  configure(S) {
    const light = this.light;
    light.castShadow = !!S;
    if (!S) return;
    const key = `${S.map}/${S.cascades}`;
    const sh = light.shadow;
    if (!this.csm || this.key !== key) {
      this.key = key;
      if (this.csm) { this.csm.dispose(); this.csm = null; }
      sh.mapSize.set(S.map, S.map);
      if (sh.map) { sh.map.dispose(); sh.map = null; }
      this.csm = new CSMShadowNode(light, {
        cascades: S.cascades, maxFar: S.far, mode: 'custom', lightMargin: 120,
        customSplitsCallback: (n, near, far, out) => {
          for (let i = 0; i < n - 1; i++) out.push(Math.min(0.95, (this.spec.splits[i] ?? far * (i + 1) / n) / far));
          out.push(1);
        },
      });
      this.csm.fade = true;
      sh.shadowNode = this.csm;
    }
    this.spec = S;
    this.csm.maxFar = S.far;
    // texel-scaled bias: the far cascades have bigger texels
    sh.normalBias = 0.02 + 0.6 * S.far / S.map * 0.05;
    sh.radius = Math.max(1, S.soft / (2.4 * (S.splits[0] || S.far) / S.map));
    if (this.csm.camera) this.csm.updateFrustums();
  }
}
