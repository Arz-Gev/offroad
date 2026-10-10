import * as THREE from 'three/webgpu';

// Materials whose sky reflection (the specular part of the environment probe) has its own strength:
// `envSpecNode` multiplies the probe's radiance (and the clear coat's) before it is used, the diffuse sky
// light is untouched. The truck uses it: glossy paint at 0.5 (a satin lobe of a bright horizon washed the
// roof white at sunset), chrome and glass above 1, and everything a bit more at night (uEnvSpec).

class EnvScaledLightingModel extends THREE.PhysicalLightingModel {
  indirectSpecular(builder) {
    const k = builder.material.envSpecNode;
    if (!k) return super.indirectSpecular(builder);
    const ctx = builder.context, radiance = ctx.radiance, cc = this.clearcoatRadiance;
    ctx.radiance = radiance.mul(k);
    if (cc) this.clearcoatRadiance = cc.mul(k);
    super.indirectSpecular(builder);
    ctx.radiance = radiance;
    this.clearcoatRadiance = cc;
  }
}

export class EnvScaledStandardMaterial extends THREE.MeshStandardNodeMaterial {
  static get type() { return 'EnvScaledStandardMaterial'; }
  constructor(p) { super(p); this.envSpecNode = null; }
  setupLightingModel() { return new EnvScaledLightingModel(); }
}

export class EnvScaledPhysicalMaterial extends THREE.MeshPhysicalNodeMaterial {
  static get type() { return 'EnvScaledPhysicalMaterial'; }
  constructor(p) { super(p); this.envSpecNode = null; }
  setupLightingModel() {
    return new EnvScaledLightingModel(this.useClearcoat, this.useSheen, this.useIridescence, this.useAnisotropy, this.useTransmission, this.useDispersion);
  }
}
