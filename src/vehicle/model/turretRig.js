import * as THREE from 'three/webgpu';

// A turret made of the model's own nodes: yaw (the turret, about the ring) > pitch (the gun cradle and what
// rides on it, about the trunnions) > recoil (the barrel, slides back in the cradle). Points the guns fire
// from (muzzles), the searchlight and the gunner's sight are empty objects in those groups; weapons.js and
// cameraRig.js read them.
//
// spec (the car's look.turret), points in the model's hub frame (y 0 at the static hub):
//   { yaw: 'node', pitch: ['node', ...], recoil: 'node', ring: [x, y, z], trunnion: [x, y, z],
//     muzzles: { name: [x, y, z] (the first in recoil, the rest in pitch) }, lamp: [x, y, z],
//     sight: [x, y, z] (in the yaw group, from the ring) }

export function turretRig(root, shell, spec, take, hubY) {
  const hubFrame = p => new THREE.Vector3(p[0], p[1] + hubY, p[2]);
  const yaw = new THREE.Group(), pitch = new THREE.Group(), recoil = new THREE.Group();
  const ringAt = hubFrame(spec.ring), trunAt = hubFrame(spec.trunnion);
  yaw.position.copy(ringAt);
  pitch.position.copy(trunAt).sub(ringAt);
  root.add(yaw); yaw.add(pitch); pitch.add(recoil);
  const node = name => shell.getObjectByName(name);
  take(node(spec.recoil), recoil, trunAt);
  for (const n of [].concat(spec.pitch)) take(node(n), pitch, trunAt);
  take(node(spec.yaw), yaw, ringAt);
  const out = { yaw, pitch, recoil };
  Object.entries(spec.muzzles).forEach(([name, p], i) => {
    const o = new THREE.Object3D(); o.position.copy(hubFrame(p)).sub(trunAt);
    (i === 0 ? recoil : pitch).add(o);
    out[name] = o;
  });
  out.lampAt = new THREE.Object3D(); out.lampAt.position.copy(hubFrame(spec.lamp)).sub(trunAt); pitch.add(out.lampAt);
  out.sight = new THREE.Object3D(); out.sight.position.set(...spec.sight); yaw.add(out.sight);
  return {
    turret: out,
    // yaw + = right (seen from above, clockwise), pitch + = up, recoil (m) slides the barrel back
    update(view, v) {
      const T = v.turret;
      if (!T) return;
      yaw.rotation.y = -T.yaw;
      pitch.rotation.x = T.pitch;
      recoil.position.z = T.recoil || 0;
    },
  };
}
