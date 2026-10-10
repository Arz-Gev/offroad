import * as THREE from 'three';

// The car's parts drawn as one BatchedMesh per material: one draw (WEBGL_multi_draw) instead of one per mesh,
// in the view and in the car's shadow tile. mergeStatic (geom.js) already merges the parts that move together;
// this also joins the parts that share a material but move apart (the four wheels, the axles, the needles).
//
// The meshes stay where they are as stand-ins: everything that moves, hides or scales a part keeps working on
// them, and sync() (VehicleView.update, after every part has moved) copies each one's transform relative to the
// car's root and its visibility into its batch instance, only when it changed. The stand-ins are on no layer,
// so no camera draws them. Left alone: transparent materials (sorted per object), meshes with their own depth
// material (the deforming tyres carry per-wheel uniforms), and materials used by a single mesh.
// Call after the meshes have their final layers (CascadedSunShadow.setCar): a batch takes its parts' layers.

const sigOf = geo => Object.keys(geo.attributes).sort().map(k => {
  const a = geo.attributes[k];
  return k + a.itemSize + (a.normalized ? 'n' : '') + a.array.constructor.name;
}).join(',') + (geo.index ? '|i' : '');

export function batchByMaterial(root) {
  root.updateMatrixWorld(true);
  const groups = new Map();
  root.traverse(o => {
    if (!o.isMesh || o.isInstancedMesh || o.isBatchedMesh || o.isSkinnedMesh) return;
    const m = o.material, geo = o.geometry;
    if (Array.isArray(m) || m.transparent || o.customDepthMaterial || o.customDistanceMaterial) return;
    if (Object.keys(geo.morphAttributes).length || geo.drawRange.start !== 0 || geo.drawRange.count !== Infinity) return;
    if (Object.values(geo.attributes).some(a => a.isInterleavedBufferAttribute)) return;
    const key = `${m.uuid}|${o.castShadow}${o.receiveShadow}|${o.layers.mask}|${sigOf(geo)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  });

  const batches = [];
  for (const parts of groups.values()) {
    if (parts.length < 2) continue;
    const geos = [...new Set(parts.map(o => o.geometry))];
    let vertices = 0, indices = 0;
    for (const g of geos) { vertices += g.attributes.position.count; indices += g.index ? g.index.count : 0; }
    const b = new THREE.BatchedMesh(parts.length, vertices, indices, parts[0].material);
    const ids = new Map(geos.map(g => [g, b.addGeometry(g)]));
    const inst = parts.map(o => b.addInstance(ids.get(o.geometry)));
    b.castShadow = parts[0].castShadow; b.receiveShadow = parts[0].receiveShadow;
    b.layers.mask = parts[0].layers.mask;
    b.frustumCulled = false; b.perObjectFrustumCulled = false; b.sortObjects = false;
    root.add(b);
    for (const o of parts) o.layers.mask = 0;
    batches.push({ b, parts, inst, last: new Float64Array(parts.length * 16).fill(NaN), shown: new Int8Array(parts.length).fill(-1) });
  }

  const m = new THREE.Matrix4();
  const visible = o => { for (let c = o; c && c !== root; c = c.parent) if (!c.visible) return false; return true; };
  return {
    batches,
    sync() {
      root.updateMatrixWorld(true);
      for (const { b, parts, inst, last, shown } of batches) for (let i = 0; i < parts.length; i++) {
        const o = parts[i];
        // relative to the root through the local matrices: exact, so a part that didn't move compares equal
        m.copy(o.matrix);
        for (let c = o.parent; c && c !== root; c = c.parent) m.premultiply(c.matrix);
        const e = m.elements, k0 = i * 16;
        let moved = false;
        for (let k = 0; k < 16; k++) if (last[k0 + k] !== e[k]) { last[k0 + k] = e[k]; moved = true; }
        if (moved) b.setMatrixAt(inst[i], m);
        const v = visible(o) ? 1 : 0;
        if (shown[i] !== v) { shown[i] = v; b.setVisibleAt(inst[i], v === 1); }
      }
    },
    dispose() { for (const { b } of batches) { b.removeFromParent(); b.dispose(); } },
  };
}
