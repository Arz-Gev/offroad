import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

// A downloaded body (a GLB prepared by tools/prepcar.mjs: +x right, -z forward, metres, the hub centre at
// y 0, mid-wheelbase at z 0) and the helpers that move its parts into our groups.

const _m = new THREE.Matrix4();

export async function loadShell(url) {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(import.meta.env.BASE_URL + url);
  const shell = gltf.scene;
  shell.name = 'shell';
  shell.traverse(o => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    const m = o.material;
    // glass: plain alpha blending (transmission would add a second scene render every frame)
    if (m.transmission > 0) { m.transmission = 0; m.transparent = true; m.opacity = Math.min(m.opacity, 0.35); }
    if (m.transparent) { o.castShadow = false; m.depthWrite = false; }
    else realBlack(m);
  });
  shell.updateMatrixWorld(true);
  return shell;
}

// Downloaded cabins are darker than any real black and partly flagged metal (a dark metal reflects
// nothing): dark "metal" becomes plastic, albedo gets a floor, baked AO is halved.
const BLACK = 0.05;   // linear albedo of black plastic / leather
const BAKED_AO = 0.5;
const REAL_BLACK = `#include <metalnessmap_fragment>
{
  float lum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  metalnessFactor *= smoothstep(0.08, 0.25, lum);
  diffuseColor.rgb = sqrt(diffuseColor.rgb * diffuseColor.rgb + ${(BLACK * BLACK).toFixed(6)});
}`;
function realBlack(m) {
  if (!m.isMeshStandardMaterial) return;
  if (m.aoMap) m.aoMapIntensity = BAKED_AO;
  m.onBeforeCompile = sh => { sh.fragmentShader = sh.fragmentShader.replace('#include <metalnessmap_fragment>', REAL_BLACK); };
  m.customProgramCacheKey = () => 'real-black';
  m.userData.realBlack = true;   // createTireMaterial keeps the patch on the deforming copies
}

// Move a node's meshes into a group, keeping where they are: the group sits at `at` (the frame the node's
// world matrices are in). Returns the number of meshes moved.
export function take(node, group, at) {
  const meshes = [];
  node.updateMatrixWorld(true);
  _m.makeTranslation(-at.x, -at.y, -at.z);
  node.traverse(o => { if (o.isMesh) meshes.push(o); });
  for (const o of meshes) {
    const m = new THREE.Mesh(o.geometry, o.material);
    m.matrixAutoUpdate = false;
    m.matrix.multiplyMatrices(_m, o.matrixWorld);
    m.castShadow = true; m.receiveShadow = true; m.name = o.name;
    group.add(m);
  }
  node.removeFromParent();
  return meshes.length;
}

// Put the shell at the static hub height (the mean of the axles' static hubs; a slight pitch when the first
// and the last differ), raised by `raise` (a car that sits higher than its model). Returns the hub height.
export function placeShell(shell, P, ride, raise = 0) {
  const nA = P.axles.length, f = ride[0].hubY, r = ride[nA - 1].hubY;
  const hubY = ride.reduce((s, x) => s + x.hubY, 0) / nA;   // the model's hub frame: y 0 here
  shell.position.y = hubY + raise;
  shell.rotation.x = Math.asin((f - r) / (P.axles[nA - 1].z - P.axles[0].z));
  return hubY;
}
