import * as THREE from 'three';
import { MAP_SIZE, LIGHT_N } from '../world/terrain.js';

// Indirect light for every lit material: what reaches a surface that the sun does not light directly. Three parts,
// each following the place:
// - the sky: the light probe (environment.js), dimmed by how much of the sky the trees overhead leave open;
// - the ground's bounce: what faces down or sideways is lit by the sun and sky reflected off the ground around it,
//   in that ground's colour (meadow green, track brown, rock grey), dimmer under a cloud's shadow and in a wood;
// - the canopy: under trees, sunlight scattered down through the leaves, green.
// The place comes from the window's light map (windowBake.js makeLightMap: ground colour and open sky at 4 m). The
// probe shows the sky above the horizon and the land's average colour in the open sun below it (plus, at a low sun
// and by night, a share of the horizon's glow: environment.js LOW_FILL), so a reflection of the ground is a ground;
// the average ground's share is taken back out of the diffuse light and the local one put in.
// Installed as a patch of three's lights_fragment_maps, so it is in every standard material. A material may:
//   define GI_LOCAL and set `giLocal` (rgb the ground's colour, a the open sky) before the lights: the terrain and
//     the grass have that from their own data (and the terrain has no texture unit to spare);
//   set `giLift` (0..1): how far it stands above the ground's shade (a tree's crown rises out of the wood);
//   define GI_CABIN and set `giCabin` (0..1): a cabin's trim, lit much the same whichever way it faces;
//   define GI_OFF: the probe alone, as three has it.

// shared plain-object uniforms (UniformsUtils.clone keeps plain objects by reference: one write reaches every material)
export const GI = {
  sun: { x: 0, y: 0, z: 0, w: 1 },             // rgb: the sun's (or the moon's) light on level ground; w: the share of the land round the truck it reaches (skyline.js)
  sky: { x: 0, y: 0, z: 0, w: 0 },             // rgb: the sky's light on level ground
  ground: { x: 0.13, y: 0.13, z: 0.07, w: 1 / MAP_SIZE },   // rgb: the land's average colour (the probe's ground), w: 1 / the map's size
  // rgb: what a closed canopy scatters down, per unit of sun on level ground; w: the bounce's gain (the land is grass
  // and bushes that scatter light sideways, not a matte floor; and it is the look's fill light: at 1 the shaded side
  // of the truck sank to near black under the grade's deep toe)
  leaf: { x: 0.05, y: 0.085, z: 0.016, w: 2.0 },
  // rgb: the sun's light on what stands up from the land (grass, trunks, banks: the sides turned to the sun), as seen
  // from across the sun's direction; xz of dir: the horizontal direction towards the sun
  side: { x: 0, y: 0, z: 0, w: 0 }, dir: { x: 0, y: 1, z: 0, w: 0 },
  // the window's light map (its data is rewritten in place for a new window: every material's clone shares the source)
  map: (() => {
    const t = new THREE.DataTexture(new Uint8Array(LIGHT_N * LIGHT_N * 4).fill(255), LIGHT_N, LIGHT_N, THREE.RGBAFormat);
    t.minFilter = t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  })(),
};

export function giUniforms() {
  return { giSun: { value: GI.sun }, giSky: { value: GI.sky }, giGround: { value: GI.ground }, giLeaf: { value: GI.leaf }, giSide: { value: GI.side }, giDir: { value: GI.dir }, giMap: { value: GI.map } };
}

// a window's light map (windowBake.js); returns the land's average colour (the probe's ground follows it)
export function setLightMap(renderer, data) {
  GI.map.image.data.set(data);
  GI.map.needsUpdate = true;
  renderer.initTexture(GI.map);
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < data.length; i += 4 * 7) { r += data[i] * data[i]; g += data[i + 1] * data[i + 1]; b += data[i + 2] * data[i + 2]; }
  const k = 7 / (LIGHT_N * LIGHT_N * 255 * 255);
  GI.ground.x = r * k; GI.ground.y = g * k; GI.ground.z = b * k;
  return GI.ground;
}

// The light a small matte thing in the air gets at a place (the dust the tyres raise: it has no lit material), as
// the radiance of a white one: the sun through the canopy and the clouds (cloud: 0..1, clouds.js cloudShadowAt),
// the sky the trees leave open, the canopy's scatter. out: [r, g, b]
export function airLight(x, z, cloud, out) {
  const u = Math.min(LIGHT_N - 1, Math.max(0, Math.floor((x / MAP_SIZE + 0.5) * LIGHT_N))), v = Math.min(LIGHT_N - 1, Math.max(0, Math.floor((z / MAP_SIZE + 0.5) * LIGHT_N)));
  const open = GI.map.image.data[(v * LIGHT_N + u) * 4 + 3] / 255, cover = Math.min(1, Math.max(0, (1 - open) * 1.64));
  const sun = cloud * (1 - 0.85 * cover) / Math.PI, sky = open / Math.PI, leaf = cloud * cover / Math.PI;
  out[0] = GI.sun.x * (sun + GI.leaf.x * leaf) + GI.sky.x * sky;
  out[1] = GI.sun.y * (sun + GI.leaf.y * leaf) + GI.sky.y * sky;
  out[2] = GI.sun.z * (sun + GI.leaf.z * leaf) + GI.sky.z * sky;
  return out;
}

const GI_PARS = /* glsl */`
#define GI_PARS
uniform vec4 giSun;
uniform vec4 giSky;
uniform vec4 giGround;
uniform vec4 giLeaf;
uniform vec4 giSide;
uniform vec4 giDir;
#ifndef GI_LOCAL
uniform sampler2D giMap;
#endif
float giCloud = 1.0;    // the clouds' shadow here (getSunShadow sets it)
float giLift = 0.0;     // 0 on the ground .. 1 above the trees' shade
float giOpen = 1.0;     // the open sky here (set with the diffuse light; the reflections follow it)
float giCabin = 0.0;   // 1 inside a cabin
#ifdef GI_LOCAL
vec4 giLocal = vec4( 0.13, 0.13, 0.07, 1.0 );
#endif
`;

const GI_DIFFUSE = /* glsl */`
			#if defined( STANDARD ) && ! defined( GI_OFF )
			{
				#ifdef GI_CABIN
				// inside a cabin (giCabin) the light comes in through the glass on every side and off the trim, much the
				// same whichever way a surface faces: as if it faced half up
				vec3 giNv = normalize( geometryNormal + ( viewMatrix * vec4( 0.0, 1.3 * giCabin, 0.0, 0.0 ) ).xyz );
				#else
				vec3 giNv = geometryNormal;
				#endif
				vec3 giProbe = getIBLIrradiance( giNv );
				vec3 giN = ( vec4( giNv, 0.0 ) * viewMatrix ).xyz;   // world space (the view matrix is rigid)
				float giDn = 0.5 - 0.5 * giN.y;   // the share of what the surface faces that is ground
				#ifdef GI_LOCAL
				vec4 giM = giLocal;
				#else
				vec2 giUv = ( cameraPosition.xz - vec2( dot( vViewPosition, viewMatrix[ 0 ].xyz ), dot( vViewPosition, viewMatrix[ 2 ].xyz ) ) ) * giGround.w;
				vec4 giM = texture2D( giMap, giUv + 0.5 );
				giM.rgb *= giM.rgb;
				giM = mix( giM, vec4( giGround.rgb, 1.0 ), smoothstep( 0.47, 0.5, max( abs( giUv.x ), abs( giUv.y ) ) ) );   // beyond the window's land
				#endif
				giM.a = mix( giM.a, 1.0, giLift );
				giOpen = giM.a;
				float giCover = clamp( ( 1.0 - giM.a ) * 1.64, 0.0, 1.0 );   // 0 open .. 1 a closed wood (the ground data's shade ends at 0.39)
				// the probe: the sky, and below the horizon the average ground in the open sun; that share comes out
				vec3 giSkyE = max( giProbe - giGround.rgb * ( giSun.rgb * giSun.w + giSky.rgb ) * giDn, vec3( 0.0 ) );
				// the light on the ground round here: the sun through the clouds and the gaps in the canopy, and the sky.
				// The land is not flat: a face turned away from the sun looks at the sunlit sides of the grass, trunks and
				// banks beyond it (at a low sun far more light than level ground takes), one turned to the sun at their shade
				float giLit = giCloud * giShade;   // the sun on the ground here: under a cloud, in a mountain's shadow (skyline.js)
				vec3 giE = ( giSun.rgb + giSide.rgb * ( 1.0 - dot( giN.xz, giDir.xz ) ) ) * ( giLit * ( 1.0 - 0.85 * giCover ) ) + giSky.rgb * giM.a;
				iblIrradiance += giSkyE * giM.a + giM.rgb * giE * ( giDn * giLeaf.w ) + giLeaf.rgb * giSun.rgb * ( giLit * giCover * ( 1.0 - 0.5 * giDn ) );
			}
			#else
			iblIrradiance += getIBLIrradiance( geometryNormal );
			#endif
`;

let installed = false;
export function installGI() {
  if (installed) return;
  installed = true;
  const C = THREE.ShaderChunk;
  const line = 'iblIrradiance += getIBLIrradiance( geometryNormal );', rad = 'radiance += iblRadiance;';
  if (!C.lights_fragment_maps.includes(line) || !C.lights_fragment_maps.includes(rad)) {
    console.warn('gi: lights_fragment_maps layout changed, the indirect light is the plain probe');
    return;
  }
  C.lights_fragment_maps = C.lights_fragment_maps.replace(line, GI_DIFFUSE)
    // under the trees the sky's reflection goes with the sky
    .replace(rad, 'radiance += iblRadiance * giOpen;')
    .replace('clearcoatRadiance += getIBLRadiance( geometryViewDir, geometryClearcoatNormal, material.clearcoatRoughness );',
      'clearcoatRadiance += getIBLRadiance( geometryViewDir, geometryClearcoatNormal, material.clearcoatRoughness ) * giOpen;');
  C.lights_pars_begin = GI_PARS + C.lights_pars_begin;
  for (const k in THREE.ShaderLib) {
    const u = THREE.ShaderLib[k].uniforms;
    if (u && 'directionalLights' in u) Object.assign(u, giUniforms());
  }
  THREE.UniformsLib.lights = { ...THREE.UniformsLib.lights, ...giUniforms() };
}
