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
//   define GI_OFF: the probe alone, as three has it;
//   define GI_FAST: the traced light read plainly, without the care at edges (grass and bushes).

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

// The traced indirect light (giWorld.js, giScreen.js), per pixel: the atlas of last frame's light (three parts side
// by side: A and the view depth | Y and the open sky's share | X), the camera it was made from. These uniform
// objects are shared by every lit material (installGI puts them into each one as it compiles: a render target's
// texture cannot go through three's uniform templates, which clone).
export const GI_TRACED = {
  tGI: { value: null },
  giPrevVP: { value: new THREE.Matrix4() },
  // x: 1 while the atlas holds a frame (0: the estimate below), y: half a texel of the screen across, zw: 1 / the screen's size
  giAtlas: { value: new THREE.Vector4(0, 0, 1, 1) },
  giRes: { value: new THREE.Vector2(1, 1) },   // the size of one part of the atlas (texels)
  // the player's truck against the last trace (GI_STICKY: what is on it reads the light found for it then): world to
  // its frame, that frame to the world then, its box there (half width, half length, bottom, top)
  giCarNow: { value: new THREE.Matrix4() }, giCarPrev: { value: new THREE.Matrix4() },
  giCarBody: { value: new THREE.Vector4(0, 0, 0, -1) },
  // the light at the truck (giWorld.js here): its mean, and how much more comes from above (a cabin's trim is lit
  // by it through the glass: the screen's own tracing would shut a cabin in)
  giCarA: { value: new THREE.Vector3(0.1, 0.1, 0.1) }, giCarY: { value: new THREE.Vector3() },
};

// What moves with the camera (the player's truck) reads the traced light at the same place on the screen as a frame
// ago, not where its point of the world was then: at speed that is a step ahead of it
export function giSticky(root) {
  root.traverse(o => {
    for (const m of [].concat(o.material || [])) if (m.defines && !('GI_STICKY' in m.defines)) { m.defines.GI_STICKY = ''; m.needsUpdate = true; }
  });
}

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
uniform sampler2D tGI;
uniform mat4 giPrevVP;
uniform vec4 giAtlas;
uniform vec2 giRes;
#ifdef GI_STICKY
uniform mat4 giCarNow;
uniform mat4 giCarPrev;
uniform vec4 giCarBody;
#endif
uniform vec3 giCarA;
uniform vec3 giCarY;
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
			if ( giAtlas.x > 0.5 ) {
				// the traced light: where this point was on last frame's screen, the light found there, on this normal
				vec3 giP = cameraPosition - ( vec4( vViewPosition, 0.0 ) * viewMatrix ).xyz;
				vec3 giPp = giP;
				#ifdef GI_STICKY
				{	// what is on the truck: where it was on the truck at the last trace
					vec3 giQl = ( giCarNow * vec4( giP, 1.0 ) ).xyz;
					if ( abs( giQl.x ) < giCarBody.x && abs( giQl.z ) < giCarBody.y && giQl.y > giCarBody.z && giQl.y < giCarBody.w ) giPp = ( giCarPrev * vec4( giQl, 1.0 ) ).xyz;
				}
				#endif
				vec4 giC = giPrevVP * vec4( giPp, 1.0 );
				vec2 giUv = giC.w > 0.0 ? giC.xy / giC.w * 0.5 + 0.5 : gl_FragCoord.xy * giAtlas.zw;
				float giZ = giC.w;   // how far it was from that camera
				giUv = clamp( giUv, vec2( giAtlas.y, 0.002 ), vec2( 1.0 - giAtlas.y, 0.998 ) );
				vec2 giU3 = vec2( giUv.x * 0.3333333, giUv.y );
				vec4 giA = texture2D( tGI, giU3 ), giY;
				vec2 giX;
				#ifdef GI_FAST
				// (grass, bushes: blades in front of blades, an edge at every pixel; the plain lookup)
				if ( false ) {
				#else
				if ( abs( giA.a - giZ ) > 0.08 * giZ + 0.06 ) {
				#endif
					// An edge: the light there was found for something nearer or farther (the atlas is coarser than the
					// frame). Of the four texels round the point, the ones at this point's depth: the dark under the
					// truck does not creep up its sills, the sky's light on a branch does not spill over the ground behind
					vec2 giS = giUv * giRes - 0.5, giF = fract( giS );
					ivec2 giI = ivec2( floor( giS ) ), giMax = ivec2( giRes ) - 1, giW = ivec2( int( giRes.x ), 0 );
					vec4 giSA = vec4( 0.0 ), giSY = vec4( 0.0 ); vec2 giSX = vec2( 0.0 ); float giWs = 0.0;
					for ( int giK = 0; giK < 4; giK ++ ) {
						ivec2 giO = ivec2( giK & 1, giK >> 1 ), giQ = clamp( giI + giO, ivec2( 0 ), giMax );
						vec4 giT = texelFetch( tGI, giQ, 0 );
						float giWk = ( ( giO.x == 1 ? giF.x : 1.0 - giF.x ) * ( giO.y == 1 ? giF.y : 1.0 - giF.y ) + 0.02 ) / ( 0.02 * giZ + 0.01 + abs( giT.a - giZ ) );
						giSA += giT * giWk; giSY += texelFetch( tGI, giQ + giW, 0 ) * giWk; giSX += texelFetch( tGI, giQ + 2 * giW, 0 ).xy * giWk; giWs += giWk;
					}
					giA = giSA / giWs; giY = giSY / giWs; giX = giSX / giWs;
				} else {
					giY = texture2D( tGI, vec2( giU3.x + 0.3333333, giU3.y ) );
					giX = texture2D( tGI, vec2( giU3.x + 0.6666667, giU3.y ) ).xy;
				}
				vec3 giNw = ( vec4( geometryNormal, 0.0 ) * viewMatrix ).xyz;
				vec3 giE = PI * max( giA.rgb + 0.6666667 * ( giY.rgb * giNw.y + giA.rgb * ( dot( giX, giNw.xz ) / max( dot( giA.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-6 ) ) ), 0.1 * giA.rgb );
				giOpen = min( giY.a * 2.2, 1.0 );   // the open sky's share of the upper half (of a probe's rays half go down)
				#ifdef GI_CABIN
				// inside a cabin the light comes in through the glass on every side: the light round the truck, as on a
				// surface facing half up, whichever way this one faces
				// (uInside: the camera is in the cabin, declared by the cabin's materials. Looked into from outside a cabin is
				// dimmer: its roof shuts out the sky)
				float giCab = giCabin * mix( 0.4, 1.0, uInside );
				giE = mix( giE, PI * max( giCarA + 0.4 * giCarY, 0.1 * giCarA ), giCab );
				giOpen = mix( giOpen, 1.0, giCab );
				#endif
				iblIrradiance += giE;
			} else {
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
  // Every lit material takes the traced light's shared uniform objects as it compiles, after its own
  // onBeforeCompile (an accessor on the prototype: a material's own hook, set later, lands in _giUser)
  const proto = THREE.Material.prototype, base = proto.onBeforeCompile;
  Object.defineProperty(proto, 'onBeforeCompile', {
    configurable: true,
    get() {
      if (!this._giHook) {
        const user = this._giUser || base;
        this._giHook = function (sh, r) { user.call(this, sh, r); if (sh.uniforms && 'directionalLights' in sh.uniforms) Object.assign(sh.uniforms, GI_TRACED); };
      }
      return this._giHook;
    },
    set(fn) { this._giUser = fn; this._giHook = null; },
  });
  proto.customProgramCacheKey = function () { return (this._giUser || base).toString(); };
}
