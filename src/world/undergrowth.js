import * as THREE from 'three';
import { MAP_SIZE } from './terrain.js';
import { buildPlant } from './foliage.js';
import { NO_FLIP_NORMAL } from './trees.js';
import { PAT, PAT_GLSL, PAT_PERIOD, pp, ppf } from './origin.js';
import { WIND_FIELD_GLSL, windUniforms } from './wind.js';
import { NEAR_SHADOW_LAYER } from '../render/cascadeShadow.js';
import { CLOUD } from './clouds.js';
import { LEAF_PARS, LEAF_PATH_GLSL, leafLightsBegin } from './leafLight.js';

// Undergrowth: ferns, shrubs and junipers, meadow flowers, yarrow, burdock, grass tufts and seeding grass, placed on the GPU like the grass (grass.js): one plant per
// cell at most, position / size / yaw hashed from the cell. Density from the ground-data map (forest floor, grass density,
// wetness) and surface splat (none on trails, rock, sand, mud). Plants shrink to nothing at their radius edge instead
// of popping. Alpha-tested foliage-atlas cards in the shared wind; they receive shadows, and the shrubs and junipers cast them into
// the nearest shadow cascade (without one a shrub looked pasted on the ground); the small plants cast none (cheap).
// A plant is lit as a whole, like a crown (leafLight.js): its normals are those of a soft dome (LIGHT), not of its
// cards. Lit by the card's own facing, half of a field's poppy heads were maroon and half bright, the tufts black.
// On rock only the rock grass grows (uRock): small, darker tufts in little groups, where terrainView.js draws moss.

const HALF = MAP_SIZE / 2;
const TILES = 6;

// The flower fields as plants reach FIELD_RADIUS at most (further out a lavender plant is a few pixels, and at the
// presets' bush distance, ~150 m, the two fields alone drew 240k plants); beyond, their colour rides on the grass
// tips (grass.js reads FIELDS: the same drift noise, faded in where the plants shrink away).
const CAST_RANGE = 56;   // the shrubs' shadows (m from the eye): about the nearest cascade's reach
const FIELD_RADIUS = 80;
export const FIELDS = {
  far: { value: new THREE.Vector2(FIELD_RADIUS * 0.62, FIELD_RADIUS * 0.85) },
  lavender: { value: new THREE.Vector4(0.95, pp(260), 0.6, 0.17) },   // weight, patch size (m), threshold, seed
  poppy: { value: new THREE.Vector4(0.9, pp(190), 0.62, 0.61) },
};

const PARS = /* glsl */`
uniform highp sampler2D tHeight;
uniform sampler2D tSplat, tNoise, tNrm;
uniform highp sampler2DArray tGround;   // layer 0: the ground data, 1: the land data (terrainView.js)
uniform float uRock;    // grows on rock, in the moss (terrainView.js rockAt): density there
uniform vec4 uMap;      // half, cell, NN, size
uniform vec4 uGrid;     // base cell x, base cell z, spacing, cells per tile
uniform vec3 uCellPat;  // the pattern frame in cells (origin.js): offset x, z, period
${PAT_GLSL}
uniform vec4 uRad;      // shrink start, end
uniform vec4 uShape;    // min scale, max scale, density multiplier, seed
uniform vec4 uKind;     // weights: forest, meadow, shrub, edge
uniform vec4 uField;    // fields: weight, patch size (m), threshold, seed: the plant grows in big drifts over meadows
uniform vec4 uWind;     // dir x, dir z, strength, time
uniform vec2 uViewXZ;   // the eye (in the shadow pass too, where cameraPosition is the sun's)
${WIND_FIELD_GLSL}
attribute float aWind;
vec2 uHash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float uHgt(ivec2 g) { g = clamp(g, ivec2(0), ivec2(int(uMap.z) - 1)); return texelFetch(tHeight, ivec2(g.y, g.x), 0).r; }
float uGround(vec2 xz) {
  vec2 f = (xz + uMap.x) / uMap.y;
  ivec2 i = ivec2(floor(f)); vec2 t = f - vec2(i);
  float h00 = uHgt(i), h10 = uHgt(i + ivec2(1, 0)), h01 = uHgt(i + ivec2(0, 1)), h11 = uHgt(i + ivec2(1, 1));
  return t.x + t.y <= 1.0 ? h00 + (h10 - h00) * t.x + (h01 - h00) * t.y : h11 + (h01 - h11) * (1.0 - t.x) + (h10 - h11) * (1.0 - t.y);
}
`;

// per kind, how the plant takes the light (LIGHT): bulge: how much of its dome is sides (0: lit as level ground),
// sigma: how much of the sun a metre of it takes, through: how much a leaf or petal lets through, foot: what is left
// of the light at its foot (the neighbours' shade)
const PLANT_LIGHT = {
  fern: { bulge: 0.9, sigma: 0.7, through: 0.8, foot: 0.65 },
  shrub: { bulge: 2.0, sigma: 1.1, through: 0.7, foot: 0.6 },
  flowers: { bulge: 0.7, sigma: 0.5, through: 0.9, foot: 0.55 },
  tuft: { bulge: 0.7, sigma: 0.7, through: 0.9, foot: 0.45 },
  rockgrass: { bulge: 0.7, sigma: 0.7, through: 0.9, foot: 0.5 },
  lavender: { bulge: 0.8, sigma: 0.7, through: 0.6, foot: 0.55 },
  poppy: { bulge: 0.7, sigma: 0.4, through: 1.0, foot: 0.55 },
  yarrow: { bulge: 0.7, sigma: 0.5, through: 0.8, foot: 0.55 },
  juniper: { bulge: 1.6, sigma: 1.0, through: 0.4, foot: 0.6 },
  seedgrass: { bulge: 0.6, sigma: 0.4, through: 1.0, foot: 0.5 },
  herb: { bulge: 1.0, sigma: 0.7, through: 0.9, foot: 0.6 },
};
const LIGHT_PARS = /* glsl */`
uniform vec4 uPlantSun;   // towards the sun or the moon (clouds.js keeps it current)
uniform vec4 uLeafC;      // the plant as an ellipsoid of leaves: centre height, radii across and up, density
uniform vec4 uLeafK;      // bulge, through, foot, how far past the plant its sun shadow is looked up (0: at the leaf)
varying vec2 vPlant;      // the sun the plant lets through to here, the sky's light here
varying vec3 vPlTint;     // this plant's own shade of its colour
${LEAF_PATH_GLSL}`;
// the plant's light at this vertex: the dome's normal, the sun's way through it, the shade at its foot
const LIGHT = /* glsl */`
vPlant = vec2(1.0); vPlTint = vec3(1.0);
float plPush = 0.0;
if (plSc > 0.0) {
  vec2 hT = uHash22(cellH + uShape.w + 5.3);
  vPlTint = mix(vec3(0.89, 0.99, 1.07), vec3(1.1, 1.01, 0.84), hT.x) * (0.78 + 0.38 * hT.y);
  vec3 pc = vec3(0.0, uLeafC.x, 0.0), pr = uLeafC.yzy;
  vec3 pe = (position - pc) / pr;
  pe /= max(length(pe), 1.0);
  objectNormal = normalize(pe * uLeafK.x + vec3(0.0, 1.0, 0.0));
  objectNormal.xz = plR * objectNormal.xz;
  vec3 pl = uPlantSun.xyz;
  pl.xz = transpose(plR) * pl.xz;
  float path = leafPath(position, normalize(pl), pc, pr) * plSc;
  float up = clamp((position.y - (pc.y - pr.y)) / (2.0 * pr.y), 0.0, 1.0);
  float foot = mix(uLeafK.z, 1.0, smoothstep(0.0, 0.6, up));
  vPlant = vec2(exp(-uLeafC.w * path) * foot, foot);
  if (uLeafK.w > 0.0) plPush = path + uLeafK.w * plSc;
}
`;

// one plant per instance: where it stands (uPos, at its place in the world)
const PLACE = /* glsl */`float gk = uGrid.w;
float gid = float(gl_InstanceID);
vec2 aTile = modelMatrix[3].xz;   // the tile index rides in the mesh position (see below)
vec2 cellIdx = uGrid.xy + aTile * gk + vec2(mod(gid, gk), floor(gid / gk));
// the hash's cell: in the pattern frame (the window's shifts are whole cells), wrapped at its period
vec2 cellH = mod(cellIdx + uCellPat.xy, uCellPat.z);
vec2 hA = uHash22(cellH + uShape.w), hB = uHash22(cellH + uShape.w + 17.17);
vec2 pxz = (cellIdx + hA) * uGrid.z, pq = (cellH + hA) * uGrid.z;
float dCam = distance(pxz, uViewXZ);
float shrink = 1.0 - smoothstep(uRad.x, uRad.y, dCam);
vec4 gd = textureLod(tGround, vec3((pxz + uMap.x + 0.5) / (uMap.w + 1.0), 0.0), 0.0);
vec4 sp = textureLod(tSplat, ((pxz + uMap.x) / uMap.y + 0.5) / uMap.z, 0.0);
vec4 nz = textureLod(tNoise, pq / ${ppf(53)}, 0.0);
float bare = clamp(1.0 - (sp.r + sp.g + sp.b + sp.a) * 2.5, 0.0, 1.0) * (1.0 - smoothstep(0.3, 0.6, gd.b));
float forest = smoothstep(0.25, 0.75, gd.g);
float meadow = gd.a * (1.0 - forest);
float dens = uKind.x * forest * smoothstep(0.3, 0.55, nz.r + 0.15)
           + uKind.y * meadow * smoothstep(0.5, 0.7, nz.b)
           + uKind.z * (forest * 0.6 + meadow * 0.25) * smoothstep(0.35, 0.6, nz.g)
           + uKind.w * meadow * smoothstep(0.45, 0.6, nz.a);
if (uField.x > 0.0) {
  vec4 fn = textureLod(tNoise, pq / uField.y + uField.w, 0.0);
  float patchK = smoothstep(uField.z, uField.z + 0.1, fn.r * 0.7 + fn.g * 0.3);
  dens += uField.x * smoothstep(0.15, 0.5, gd.a) * (1.0 - forest) * patchK;
}
dens *= bare;
// on rock (the splat's or steep ground, not sheer faces): in the moss, from terrainView.js rockAt's moss terms without
// the per-pixel ones (ledges, crevices: their average), in little groups
if (uRock > 0.0) {
  vec4 nr = textureLod(tNrm, ((pxz + uMap.x) / uMap.y + 0.5) / uMap.z, 0.0);
  vec2 nxz = nr.rg * 2.0 - 1.0;
  float ny = sqrt(max(0.0, 1.0 - dot(nxz, nxz)));
  float rocky = max(sp.b, smoothstep(0.22, 0.34, 1.0 - ny)) * smoothstep(0.45, 0.65, ny);
  vec4 ld = textureLod(tGround, vec3((pxz + uMap.x + 0.5) / (uMap.w + 1.0), 1.0), 0.0);   // r lushness, a rock kind
  vec3 rp = vec3(pxz.x, uGround(pxz), pxz.y);
  float north = clamp(-dot(normalize(nxz + vec2(1e-4, 0.0)), vec2(0.41, -0.91)), 0.0, 1.0) * smoothstep(0.92, 0.6, ny);
  vec4 mn = textureLod(tNoise, rp.xz / 5.3 + rp.y * 0.07, 0.0);
  float blot = textureLod(tNoise, (rp.xz + rp.y * 0.7) / 19.0, 0.0).a;
  float drive = ld.r * 0.55 + north * 0.35 + smoothstep(0.55, 0.85, ny) * 0.45 + smoothstep(0.75, 1.0, ld.a) * 0.25 - 0.47
    + (mn.r - 0.5) * 0.5 + (blot - 0.5) * 0.3;
  // clumps of a hand's breadth to a metre, with bare rock between them
  vec4 cl = textureLod(tNoise, pxz / 1.4 + 5.3, 0.0);
  float clump = smoothstep(0.55, 0.68, cl.g * 0.75 + cl.r * 0.25);
  dens += uRock * rocky * smoothstep(0.08, 0.3, drive) * clump;
}
dens *= uShape.z;
float inMap = step(max(abs(pxz.x), abs(pxz.y)), uMap.x - 2.0);
vec3 objectNormal = vec3(0.0, 1.0, 0.0);
vec3 uPos = vec3(0.0, -1e4, 0.0);
mat2 plR = mat2(1.0); float plSc = 0.0;   // this plant's turn and size
if (hB.x < dens && shrink > 0.0 && inMap > 0.0) {
  // (shrinking to nothing at the radius: they used to stop at 15 % and vanish)
  float sc = mix(uShape.x, uShape.y, hB.y) * (0.15 + 0.85 * shrink) * smoothstep(0.0, 0.2, shrink);
  float yaw = hA.x * 6.2831853 + hB.y * 3.1;
  float c = cos(yaw), s = sin(yaw);
  mat2 R = mat2(c, -s, s, c);
  vec3 lp = position * sc;
  lp.xz = R * lp.xz;
  plR = R; plSc = sc;
  // wind: whole plant leans, tips flutter
  float t = uWind.w;
  float gust = windGust(pq, t);   // the same gusts as the grass and the trees (wind.js)
  float sway = sin(t * (1.7 + hA.y) + pxz.x * 0.3 + pxz.y * 0.2);
  lp.xz += uWind.xy * uWind.z * aWind * aWind * sc * (0.13 * gust + 0.06 * sway * (0.5 + 0.6 * gust));
  lp += vec3(sin(t * 4.3 + dot(lp, vec3(3.1, 2.3, 1.7))), 0.0, cos(t * 3.7 + dot(lp, vec3(1.9, 2.9, 2.3)))) * 0.025 * aWind * uWind.z;
  float gy = uGround(pxz);
  uPos = vec3(pxz.x, gy - 0.03, pxz.y) + lp;
}`;

export function buildUndergrowth(terrainView, atlas, windUniform) {
  const U = terrainView.uniforms;
  const group = new THREE.Group();
  group.name = 'undergrowth';
  const viewXZ = { value: new THREE.Vector2() };
  const shared = { uViewXZ: viewXZ, tHeight: U.tHeight, tSplat: U.tSplat, tGround: U.tGround, tNoise: U.tNoise, tNrm: U.tNrm, uMap: U.uMap, uWind: windUniform, ...windUniforms() };

  // opts: maxRadius (m, after the presets' distance scale), color (multiplies the atlas)
  const makeKind = (name, geoBase, spacing, radius, shape, kind, field = [0, 200, 0.6, 0], rock = 0, opts = {}) => {
    const k = Math.ceil(radius * 2 / spacing / TILES);
    const uniforms = {
      ...shared,
      uGrid: { value: new THREE.Vector4(0, 0, spacing, k) },
      uCellPat: { value: new THREE.Vector3(0, 0, 1) }, uPat: PAT,
      uRad: { value: new THREE.Vector4(radius * 0.7, radius, 0, 0) },
      uShape: { value: new THREE.Vector4(...shape) },
      uKind: { value: new THREE.Vector4(...kind) },
      uField: { value: new THREE.Vector4(...field) },
      uRock: { value: rock },
    };
    geoBase.computeBoundingBox();
    const bb = geoBase.boundingBox, pl = PLANT_LIGHT[name];
    const rx = 0.9 * Math.max(-bb.min.x, bb.max.x, -bb.min.z, bb.max.z), ry = 0.5 * (bb.max.y - bb.min.y);
    const lit = {
      uPlantSun: { value: CLOUD.sun },
      uLeafC: { value: new THREE.Vector4(bb.min.y + ry, rx, ry, pl.sigma) },
      // (a caster: past its own shadow, which shaded it card by card; the shade of what stands round it still lands)
      uLeafK: { value: new THREE.Vector4(pl.bulge, pl.through, pl.foot, opts.casts ? 0.4 * rx : 0) },
    };
    const mat = new THREE.MeshStandardMaterial({ map: atlas, alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.85, metalness: 0 });
    if (opts.color) mat.color.setRGB(...opts.color);
    mat.defines = { TK_THIN: '', TK_LEAF: '', GI_FAST: '' };   // the lamps light it alike from every side (lamps.js); the traced light read plainly (gi.js)
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uniforms, lit);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\n' + PARS + LIGHT_PARS)
        .replace('#include <beginnormal_vertex>', '\n' + PLACE + LIGHT)
        .replace('#include <shadowmap_vertex>', `#include <shadowmap_vertex>
#if defined( USE_SHADOWMAP ) && NUM_SUN_LIGHT_SHADOWS > 0
vSunShadowWorldPosition.xyz += normalize(uPlantSun.xyz) * plPush;
#endif`)
        .replace('#include <begin_vertex>', 'vec3 transformed = uPos;')
        .replace('#include <project_vertex>', 'vec4 mvPosition = viewMatrix * vec4(transformed, 1.0);\ngl_Position = projectionMatrix * mvPosition;')
        .replace('#include <worldpos_vertex>', '#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0\nvec4 worldPosition = vec4(transformed, 1.0);\n#endif');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec4 uLeafK;\nvarying vec2 vPlant;\nvarying vec3 vPlTint;\n' + LEAF_PARS)
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vPlTint;')
        .replace('#include <normal_fragment_begin>', NO_FLIP_NORMAL)
        .replace('#include <lights_fragment_begin>', 'leafSelf = vPlant.x; leafThrough = uLeafK.y;\n' + leafLightsBegin())
        .replace('#include <aomap_fragment>', '#include <aomap_fragment>\nreflectedLight.indirectDiffuse *= max(vPlant.y, 0.0); reflectedLight.indirectSpecular *= 0.3 * max(vPlant.y, 0.0);');
    };
    mat.customProgramCacheKey = () => 'undergrowth-v8';
    // the shadow pass places them the same way (three's depth shader has no normal step: all in begin_vertex)
    let depth = null;
    if (opts.casts) {
      depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: atlas, alphaTest: 0.42, side: THREE.DoubleSide });
      depth.onBeforeCompile = (sh) => {
        Object.assign(sh.uniforms, uniforms);
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\n' + PARS)
          .replace('#include <begin_vertex>', PLACE + '\nvec3 transformed = uPos;')
          .replace('#include <project_vertex>', 'vec4 mvPosition = viewMatrix * vec4(transformed, 1.0);\ngl_Position = projectionMatrix * mvPosition;')
          .replace('#include <worldpos_vertex>', '');
      };
      depth.customProgramCacheKey = () => 'undergrowth-depth-v1';
    }
    const tiles = [], casters = [];
    for (let tx = 0; tx < TILES; tx++) for (let tz = 0; tz < TILES; tz++) {
      const g = new THREE.InstancedBufferGeometry();
      for (const a of ['position', 'normal', 'uv', 'aWind']) g.setAttribute(a, geoBase.getAttribute(a));
      g.setIndex(geoBase.getIndex());
      g.instanceCount = k * k;
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
      const m = new THREE.Mesh(g, mat);
      m.frustumCulled = false; m.receiveShadow = true; m.castShadow = false; m.matrixAutoUpdate = false;
      m.userData.tile = [tx, tz];
      m.position.set(tx, 0, tz); m.updateMatrix(); m.matrixWorldAutoUpdate = false; m.matrixWorld.copy(m.matrix);
      group.add(m);
      tiles.push(m);
      if (!depth) continue;
      const c = new THREE.Mesh(g, mat);
      c.layers.set(NEAR_SHADOW_LAYER);
      c.frustumCulled = false; c.castShadow = true; c.receiveShadow = false; c.customDepthMaterial = depth;
      c.position.set(tx, 0, tz); c.updateMatrix(); c.matrixAutoUpdate = false; c.matrixWorldAutoUpdate = false; c.matrixWorld.copy(c.matrix);
      c.userData.tile = [tx, tz];
      group.add(c);
      casters.push(c);
    }
    return { name, mat, uniforms, tiles, casters, spacing, baseSpacing: spacing, radius, baseRadius: radius, maxRadius: opts.maxRadius ?? Infinity, baseScale: [shape[0], shape[1]], k };
  };

  //                          geometry                     spacing radius  [min, max scale, density, seed]  [forest, meadow, shrub, edge]
  const kinds = [
    makeKind('fern', buildPlant('fern', 11), 1.6, 44, [0.75, 1.35, 0.8, 3.1], [1, 0, 0, 0]),
    makeKind('shrub', buildPlant('bush', 12), 3.6, 72, [0.45, 1.13, 0.55, 7.7], [0, 0, 1, 0], undefined, 0, { casts: true }),
    makeKind('flowers', buildPlant('flowers', 13), 1.25, 36, [0.7, 1.15, 0.6, 11.3], [0, 1, 0, 0]),
    makeKind('tuft', buildPlant('tuft', 14), 1.0, 32, [0.7, 1.4, 0.45, 19.9], [0.25, 0, 0, 1]),
    makeKind('rockgrass', buildPlant('tuft', 21), 0.4, 14, [0.25, 0.55, 1.0, 37.1], [0, 0, 0, 0], undefined, 1, { maxRadius: 45, color: [0.5, 0.56, 0.32] }),
    makeKind('yarrow', buildPlant('yarrow', 17), 1.9, 38, [0.7, 1.2, 0.45, 41.9], [0, 0.6, 0, 0.8]),
    makeKind('seedgrass', buildPlant('seedgrass', 18), 1.6, 40, [0.7, 1.3, 0.42, 47.3], [0.1, 0.5, 0, 0.9]),
    makeKind('juniper', buildPlant('juniper', 19), 5.2, 72, [0.45, 1.05, 0.45, 53.1], [0, 0, 1, 0.15], undefined, 0, { casts: true }),
    makeKind('herb', buildPlant('herb', 20), 2.3, 34, [0.55, 1.0, 0.4, 59.7], [0.45, 0, 0, 0.6]),
    // fields: lavender in long drifts, poppies in red patches (each its own noise: they rarely overlap)
    makeKind('lavender', buildPlant('lavender', 15), 0.85, 46, [0.75, 1.15, 1.0, 23.7], [0, 0, 0, 0], FIELDS.lavender.value.toArray()),
    makeKind('poppy', buildPlant('poppy', 16), 0.7, 40, [0.7, 1.1, 1.0, 29.3], [0, 0.12, 0, 0], FIELDS.poppy.value.toArray()),
  ];

  const frustum = new THREE.Frustum(), pv = new THREE.Matrix4(), box = new THREE.Box3();
  let enabled = true;
  return {
    group, kinds,
    configure(q) {
      // density: closer / further apart cells (the per-kind probability stays), distance and height are multipliers
      const dens = q.bushes ?? 1, dist = q.bushDist ?? 1, hs = q.bushHeight ?? 1;
      enabled = q.vegetation !== false && dens > 0 && dist > 0;
      group.visible = enabled;
      if (!enabled) return;
      for (const K of kinds) {
        const r = Math.min(K.baseRadius * dist, K.uniforms.uField.value.x > 0 ? FIELD_RADIUS : Infinity, K.maxRadius);
        K.radius = r;
        // snapped so the cells divide the window's step (256 m): the plants stay put when the frame shifts
        K.spacing = 256 / Math.max(1, Math.round(256 * Math.sqrt(dens) / K.baseSpacing));
        K.k = Math.ceil(r * 2 / K.spacing / TILES);
        K.uniforms.uGrid.value.z = K.spacing;
        K.uniforms.uGrid.value.w = K.k;
        K.uniforms.uRad.value.set(r * 0.7, r, 0, 0);
        K.uniforms.uShape.value.x = K.baseScale[0] * hs;
        K.uniforms.uShape.value.y = K.baseScale[1] * hs;
        for (const m of K.tiles) m.geometry.instanceCount = K.k * K.k;
      }
    },
    update(dt, camera) {
      if (!enabled) return;
      pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(pv);
      const cx = camera.position.x, cz = camera.position.z, cy = camera.position.y;
      viewXZ.value.set(cx, cz);
      for (const K of kinds) {
        const s = K.spacing, k = K.k, n = k * TILES, R = K.radius;
        const bx = Math.floor((cx / s - n / 2) / k) * k, bz = Math.floor((cz / s - n / 2) / k) * k;
        K.uniforms.uGrid.value.x = bx; K.uniforms.uGrid.value.y = bz;
        const pc = Math.round(PAT_PERIOD / s);
        K.uniforms.uCellPat.value.set(Math.round(PAT.value.x / s) % pc, Math.round(PAT.value.y / s) % pc, pc);
        for (const m of K.tiles) {
          const [tx, tz] = m.userData.tile;
          const x0 = (bx + tx * k) * s, z0 = (bz + tz * k) * s, x1 = x0 + k * s, z1 = z0 + k * s;
          const ddx = Math.max(x0 - cx, 0, cx - x1), ddz = Math.max(z0 - cz, 0, cz - z1);
          if (Math.hypot(ddx, ddz) > R || (Math.abs(x0) > HALF && Math.abs(x1) > HALF) || (Math.abs(z0) > HALF && Math.abs(z1) > HALF)) { m.visible = false; continue; }
          box.min.set(x0, cy - 80, z0); box.max.set(x1, cy + 40, z1);
          m.visible = frustum.intersectsBox(box);
        }
        for (let i = 0; i < K.casters.length; i++) {
          // a shrub out of the view still casts into it: a few metres more round it, as far as the near cascade reaches
          const c = K.casters[i], [tx, tz] = c.userData.tile;
          const x0 = (bx + tx * k) * s, z0 = (bz + tz * k) * s, x1 = x0 + k * s, z1 = z0 + k * s;
          const ddx = Math.max(x0 - cx, 0, cx - x1), ddz = Math.max(z0 - cz, 0, cz - z1);
          if (Math.hypot(ddx, ddz) > Math.min(R, CAST_RANGE)) { c.visible = false; continue; }
          box.min.set(x0 - 6, cy - 80, z0 - 6); box.max.set(x1 + 6, cy + 40, z1 + 6);
          c.visible = frustum.intersectsBox(box);
        }
      }
    },
  };
}
