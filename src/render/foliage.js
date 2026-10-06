import * as THREE from 'three/webgpu';
import { float, uniform, diffuseColor, normalView, positionViewDirection, pow, max, dot, mix } from 'three/tsl';

// Foliage lighting: the standard PBR model plus light that passes through thin leaves and blades.
// For every light (with its shadow already applied to lightColor):
//   - back light: looking towards the light through the leaf, a forward-scattering lobe;
//   - wrap: the side of a card facing away from the light still gets some of it.
// So a crown or a meadow against a low sun glows at its edges, and shadowed leaves stay dark.
// `translucency` (node or number) scales it per material; `foliageLight` scales it globally (weather).

export const foliageLight = uniform(1);

class FoliageLightingModel extends THREE.PhysicalLightingModel {
  direct({ lightDirection, lightColor, reflectedLight }, builder) {
    const m = builder.material;
    const t = m.translucencyNode ?? float(0.5);
    const V = positionViewDirection, N = normalView, L = lightDirection;
    const back = pow(max(dot(V, L.negate()), 0.0), 4.0).mul(0.75);
    const wrap = max(dot(N.negate(), L), 0.0).mul(0.3);
    reflectedLight.directDiffuse.addAssign(diffuseColor.rgb.mul(lightColor).mul(back.add(wrap)).mul(t).mul(foliageLight));
    super.direct({ lightDirection, lightColor, reflectedLight }, builder);
  }
}

export class FoliageMaterial extends THREE.MeshStandardNodeMaterial {
  static get type() { return 'FoliageMaterial'; }
  constructor(params = {}) {
    const { translucency = 0.5, ...rest } = params;
    super(rest);
    this.isFoliageMaterial = true;
    this.translucencyNode = typeof translucency === 'number' ? float(translucency) : translucency;
  }
  setupLightingModel() { return new FoliageLightingModel(); }
}
