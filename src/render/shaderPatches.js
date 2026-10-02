import * as THREE from 'three';

// Global shader-chunk patches, installed once before any material compiles.
//
// 1. Atmosphere: three's fog chunks are replaced with exponential height fog plus aerial perspective.
//    The fog colour depends on the view direction (horizon colour towards / across / away from the sun,
//    plus a Mie glow around the sun), so distant hills fade into the sky behind them instead of into a
//    flat grey. The parameters are shared plain-object vec4 uniforms (see ATMO): UniformsUtils.clone()
//    copies Vector4s per material but keeps plain objects by reference, so one write reaches every material.
// 2. Lights: point and spot lights skip shadow lookups and the BRDF where they contribute nothing
//    (switched off, outside the cone, beyond their range). Without this every lit pixel paid for all the
//    truck's lamps even in daylight with the lamps off (~5 ms at 3360x1890 on an M1 Pro).

export const ATMO = {
  // xyz: direction towards the sun (or the moon at night), w: height-fog falloff (1/m)
  atmoSun: { x: 0, y: 1, z: 0, w: 0.02 },
  // rgb: horizon colour away from the sun, w: height-fog reference height (m)
  atmoAway: { x: 0.5, y: 0.6, z: 0.7, w: 0 },
  // rgb: horizon colour at 90 deg to the sun, w: haze density (1/m), the aerial perspective
  atmoSide: { x: 0.5, y: 0.6, z: 0.7, w: 0.0003 },
  // rgb: horizon colour towards the sun, w: maximum fog opacity
  atmoToward: { x: 0.6, y: 0.6, z: 0.6, w: 1 },
  // rgb: Mie glow colour around the sun, w: anisotropy g
  atmoGlow: { x: 0, y: 0, z: 0, w: 0.7 },
  // cloud shadows: xy wind drift of the cloud layer (m), z: cloud cover 0..1, w: shadow strength (0 = off)
  atmoCloud: { x: 0, y: 0, z: 0.45, w: 0 },
};

// uniforms to add to custom ShaderMaterials that use fog
export function atmosphereUniforms() {
  const u = {};
  for (const k in ATMO) u[k] = { value: ATMO[k] };
  return u;
}

export const setVec4 = (o, x, y, z, w) => { o.x = x; o.y = y; o.z = z; if (w !== undefined) o.w = w; };

const FOG_PARS_VERTEX = /* glsl */`
#ifdef USE_FOG
	varying float vFogDepth;
	varying vec3 vFogWorldDir;
#endif
`;

const FOG_VERTEX = /* glsl */`
#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	// camera-to-vertex offset in world space (the view matrix is rigid: its inverse rotation is the transpose)
	vFogWorldDir = ( vec4( mvPosition.xyz, 0.0 ) * viewMatrix ).xyz;
#endif
`;

const FOG_PARS_FRAGMENT = /* glsl */`
#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	varying vec3 vFogWorldDir;
	#ifdef FOG_EXP2
		uniform float fogDensity;
		uniform vec4 atmoSun;
		uniform vec4 atmoAway;
		uniform vec4 atmoSide;
		uniform vec4 atmoToward;
		uniform vec4 atmoGlow;
		uniform vec4 atmoCloud;
		// Cloud shadows: project the shaded point along the light onto the cloud layer (1.8 km, like the sky
		// dome's) and darken the sun by a soft value-noise cover there. Procedural, so no texture per material.
		float atmoHash( vec2 p ) { p = fract( p * vec2( 0.1031, 0.1030 ) ); p += dot( p, p.yx + 33.33 ); return fract( ( p.x + p.y ) * p.y ); }
		float atmoNoise( vec2 p ) {
			vec2 i = floor( p ), f = fract( p );
			f = f * f * ( 3.0 - 2.0 * f );
			return mix( mix( atmoHash( i ), atmoHash( i + vec2( 1.0, 0.0 ) ), f.x ), mix( atmoHash( i + vec2( 0.0, 1.0 ) ), atmoHash( i + 1.0 ), f.x ), f.y );
		}
		float atmoCloudShadow( vec3 viewPos ) {
			if ( atmoCloud.w <= 0.0 || atmoSun.y <= 0.02 ) return 1.0;
			vec3 wp = cameraPosition + ( vec4( viewPos, 0.0 ) * viewMatrix ).xyz;
			vec2 q = ( wp.xz + atmoSun.xz * ( ( 1800.0 - wp.y ) / max( atmoSun.y, 0.12 ) ) + atmoCloud.xy ) / 520.0;
			float f = atmoNoise( q ) * 0.55 + atmoNoise( q * 2.13 + 7.1 ) * 0.28 + atmoNoise( q * 4.7 + 3.3 ) * 0.17;
			float c = smoothstep( 1.0 - atmoCloud.z, 1.0 - atmoCloud.z + 0.3, f );
			return 1.0 - atmoCloud.w * c;
		}
		// fog opacity and colour for a camera-relative world offset d
		float atmoFogFactor( vec3 d ) {
			float dist = length( d );
			float b = atmoSun.w;
			float dens0 = fogDensity * exp( - b * ( cameraPosition.y - atmoAway.w ) );
			float dy = clamp( d.y * b, - 40.0, 40.0 );
			float hf = abs( dy ) > 1e-3 ? ( 1.0 - exp( - dy ) ) / dy : 1.0 - 0.5 * dy;
			float od = dist * ( min( dens0 * hf, 0.2 ) + atmoSide.w );
			return min( 1.0 - exp( - od ), atmoToward.w );
		}
		vec3 atmoFogColor( vec3 v ) {
			vec2 hz = normalize( v.xz + vec2( 1e-5 ) );
			vec2 sz = normalize( atmoSun.xz + vec2( 1e-5 ) );
			float a = dot( hz, sz );
			vec3 col = a > 0.0 ? mix( atmoSide.rgb, atmoToward.rgb, a ) : mix( atmoSide.rgb, atmoAway.rgb, - a );
			float g = atmoGlow.w;
			float mu = dot( v, atmoSun.xyz );
			float hg = ( 1.0 - g * g ) / pow( max( 1.0 + g * g - 2.0 * g * mu, 1e-4 ), 1.5 );
			return col + atmoGlow.rgb * hg * 0.0795775;
		}
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
#endif
`;

const FOG_FRAGMENT = /* glsl */`
#ifdef USE_FOG
	#ifdef FOG_EXP2
		{
			vec3 fogD = vFogWorldDir;
			float fogFactor = atmoFogFactor( fogD );
			vec3 fogCol = atmoFogColor( fogD / max( length( fogD ), 1e-4 ) );
			gl_FragColor.rgb = mix( gl_FragColor.rgb, fogCol, fogFactor );
		}
	#else
		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
		gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
	#endif
#endif
`;

let installed = false;
export function installShaderPatches() {
  if (installed) return;
  installed = true;
  const C = THREE.ShaderChunk;
  C.fog_pars_vertex = FOG_PARS_VERTEX;
  C.fog_vertex = FOG_VERTEX;
  C.fog_pars_fragment = FOG_PARS_FRAGMENT;
  C.fog_fragment = FOG_FRAGMENT;
  // every built-in material with fog gets the shared atmosphere uniforms
  for (const k in THREE.ShaderLib) {
    const u = THREE.ShaderLib[k].uniforms;
    if (u && 'fogDensity' in u) Object.assign(u, atmosphereUniforms());
  }
  THREE.UniformsLib.fog = { ...THREE.UniformsLib.fog, ...atmosphereUniforms() };

  // lights: skip lamps that contribute nothing to this pixel
  let lf = C.lights_fragment_begin;
  const dirInfo = '\t\tgetDirectionalLightInfo( directionalLight, directLight );\n';
  if (lf.includes(dirInfo)) {
    lf = lf.replace(dirInfo, dirInfo + '\t\t#if defined( USE_FOG ) && defined( FOG_EXP2 )\n\t\tdirectLight.color *= atmoCloudShadow( geometryPosition );\n\t\t#endif\n');
  } else {
    console.warn('shaderPatches: directional light layout changed, cloud shadows disabled');
  }
  const pointRE = /(\t\tgetPointLightInfo\( pointLight, geometryPosition, directLight \);\n)([\s\S]*?)(\t\tRE_Direct\( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight \);\n)/;
  const spotRE = /(\t\tgetSpotLightInfo\( spotLight, geometryPosition, directLight \);\n)([\s\S]*?)(\t\tRE_Direct\( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight \);\n)/;
  const wrap = (m, a, body, re) => `${a}\t\tif ( directLight.visible ) {\n${body}${re}\t\t}\n`;
  if (pointRE.test(lf) && spotRE.test(lf)) {
    lf = lf.replace(pointRE, wrap).replace(spotRE, wrap);
    // #define/#undef inside the spot block stay balanced: both are inside the braces
    C.lights_fragment_begin = lf;
  } else {
    console.warn('shaderPatches: lights_fragment_begin layout changed, light skipping disabled');
  }
}
