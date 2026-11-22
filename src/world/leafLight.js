import * as THREE from 'three';

// The sun on leaves. A crown is thousands of thin leaves at every angle, one behind another; drawn as a few dozen
// cards it was lit card by card: a card either took the sun on its normal or stood in the crown's shadow map, so
// against the sun a tree was a patchwork of pale cards and black ones. Here the sun's light on a leaf card is:
// - what the plant itself lets through to that point (leafSelf: 1 on the sunlit side, falling off with the length of
//   the sun's way through the crown, an ellipsoid of leaves of a given density), not the shadow map's yes or no;
// - turned back by the leaves in their colour, on the crown's own round shape (N, wrapped a little: leaves face
//   every way), most seen from the sun's side;
// - let through the leaves, yellower (they take the blue), most seen against the sun.
// So a thin crown glows through, a dense one keeps a dark heart with a bright rim, and neither has black cards.
// A material: adds LEAF_PARS to its fragment shader, sets leafSelf (and leafK: 1 leaves .. 0 wood) before the lights,
// and takes leafLightsBegin() in place of three's lights_fragment_begin. The lamps stay three's.

// What is around lights a leaf from both its sides: turned back on the one, let through on the other, and again from
// leaf to leaf inside the crown (LEAF_SKY: the indirect light on a crown against a matte card's). With the card's
// alone a wood's edge in the shade was black once fog, bloom and all were off.
export const LEAF_SKY = 1.5;
export const LEAF_PARS = /* glsl */`
float leafSelf = 1.0;   // the sunlight the plant itself lets through to here
float leafK = 1.0;      // 1: leaves, 0: wood (the plain matte light)
float leafThrough = 1.0;   // how much of the light a leaf lets through (broad leaves 1; needles are thick and waxy)
void leafSun( IncidentLight directLight, vec3 N, vec3 V, vec3 albedo, inout ReflectedLight reflectedLight ) {
	vec3 L = directLight.direction;
	float ndl = dot( N, L );
	float wrap = 0.45 * leafK;
	float macro = clamp( ( ndl + wrap ) / ( 1.0 + wrap ), 0.0, 1.0 );
	// the share of the leaves seen from their unlit face: all of them looking into the sun, none from its side
	float ft = ( 0.5 + 0.5 * dot( V, - L ) ) * leafK;
	vec3 through = vec3( 1.0, 1.12, 0.38 ) * ( 0.9 * leafThrough * ft * ft );
	// (deep in, some still arrives, scattered leaf to leaf: it falls off at a third of the rate)
	float self0 = max( leafSelf, 0.0 );   // (with MSAA a varying runs past its ends at a card's edge: pow of less than 0 is NaN)
	float self = 0.8 * self0 + 0.2 * pow( self0, 0.3 );
	reflectedLight.directDiffuse += directLight.color * ( mix( 1.0, self, leafK ) * RECIPROCAL_PI ) * albedo * ( macro * ( 1.0 - 0.5 * ft ) + through );
}
`;

// three's lights_fragment_begin with the sun's light on the surface replaced by leafSun (taken when a material is
// made: the chunk has the game's own patches by then)
let begin = null;
export function leafLightsBegin() {
  if (begin) return begin;
  const c = THREE.ShaderChunk.lights_fragment_begin;
  const a = c.indexOf('getSunLightInfo( sunLight, directLight );');
  const call = 'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';
  const b = a < 0 ? -1 : c.indexOf(call, a);
  if (b < 0) { console.warn('leafLight: lights_fragment_begin layout changed, leaves are lit as matte surfaces'); return begin = c; }
  return begin = c.slice(0, b) + 'leafSun( directLight, geometryNormal, geometryViewDir, material.diffuseColor, reflectedLight );' + c.slice(b + call.length);
}

// GLSL: the length of the way from p towards the light (unit Ld) out of the ellipsoid of centre c and radii r
// (all in one frame); 0 outside it on the light's side
export const LEAF_PATH_GLSL = /* glsl */`
float leafPath( vec3 p, vec3 Ld, vec3 c, vec3 r ) {
	vec3 q = ( p - c ) / r, d = Ld / r;
	float a = dot( d, d ), b = dot( q, d ), cc = dot( q, q ) - 1.0;
	float disc = b * b - a * cc;
	return disc > 0.0 ? max( ( - b + sqrt( disc ) ) / a, 0.0 ) : 0.0;
}
`;

// a kind's crown as an ellipsoid of leaves: centre height, radii across and up (m), and how much light a metre of it
// takes (1/m). g: the kind's geometry data (foliage.js: height, crownR, crownBase)
const DENSITY = { spruce: 0.22, pine: 0.16, birch: 0.15, apple: 0.24, oak: 0.22, dead: 0.04 };
const THROUGH = { spruce: 0.4, pine: 0.4, birch: 1, apple: 0.9, oak: 0.9, dead: 0 };
export function crownOf(kind, g) {
  const base = g.crownBase ?? g.height * 0.3, top = g.height;
  return { cy: (base + top) / 2, rx: Math.max(0.8, g.crownR), ry: Math.max(0.8, (top - base) / 2 * 1.05), sigma: DENSITY[kind] ?? 0.2, through: THROUGH[kind] ?? 0.8 };
}
