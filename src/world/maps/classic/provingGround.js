import * as THREE from 'three';
import { SURFACES } from '../../../vehicle/tire.js';
import { makeBarkTexture } from '../../textures.js';
import { LANES } from './terrain.js';

// The proving ground's fixed obstacles (the lanes' ground is shaped in terrain.js buildLanes, the rock garden's
// boulders are in bake.js): lane B's concrete steps and logs, the posts at the lane starts. Colliders made once.
export function buildProvingGround(RAPIER, world, terrain, colliderSurface) {
  const group = new THREE.Group();
  group.name = 'proving ground';
  // ---------------- lane B: concrete steps then logs
  const concrete = new THREE.MeshStandardMaterial({ color: 0x9c9890, roughness: 0.9 });
  const stepHeights = [0.15, 0.25, 0.35, 0.45];
  stepHeights.forEach((h, k) => {
    const z = 34 - k * 8;
    const y = terrain.heightAt(LANES.B, z);
    const hx = 2.2, hz = 0.7;
    const m = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, h + 0.4, hz * 2), concrete);
    m.position.set(LANES.B, y + (h - 0.4) / 2 + 0.0, z);
    m.castShadow = m.receiveShadow = true;
    group.add(m);
    const col = world.createCollider(RAPIER.ColliderDesc.cuboid(hx, (h + 0.4) / 2, hz).setTranslation(m.position.x, m.position.y, m.position.z).setFriction(0.95));
    colliderSurface.set(col.handle, SURFACES.concrete);
  });
  const bark = makeBarkTexture();
  const logMat = new THREE.MeshStandardMaterial({ color: 0x8a7258, map: bark, roughness: 0.9 });
  [0.12, 0.2, 0.28].forEach((r, k) => {
    const z = 2 - k * 7.5;
    const y = terrain.heightAt(LANES.B, z) + r * 0.85;
    const len = 6;
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.08, len, 16), logMat);
    m.rotation.z = Math.PI / 2;
    m.rotation.y = (k - 1) * 0.12;
    m.position.set(LANES.B, y, z);
    m.castShadow = m.receiveShadow = true;
    group.add(m);
    const q = m.quaternion;
    const col = world.createCollider(RAPIER.ColliderDesc.cylinder(len / 2, r).setTranslation(LANES.B, y, z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }).setFriction(0.7));
    colliderSurface.set(col.handle, SURFACES.wood);
  });
  // lane markers (posts) at lane starts
  const postMat = new THREE.MeshStandardMaterial({ color: 0xd8d0c0, roughness: 0.7 });
  const stripeMat = new THREE.MeshStandardMaterial({ color: 0xc8301e, roughness: 0.6 });
  for (const lx of Object.values(LANES)) for (const s of [-1, 1]) {
    const x = lx + s * 4.2, z = 44;
    const y = terrain.heightAt(x, z);
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.2, 8), postMat);
    p.position.set(x, y + 0.6, z);
    p.castShadow = true;
    group.add(p);
    const st = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.2, 8), stripeMat);
    st.position.set(x, y + 1.0, z);
    group.add(st);
  }
  return group;
}
