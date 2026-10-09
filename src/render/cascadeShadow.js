import * as THREE from 'three';

// Cascaded sun shadow, up to four cascades with explicit splits. three's SunLightShadow is fixed at two
// cascades with a computed split (~20 cm texels far, ~5 cm near at 2048). Same algorithm (bounding sphere
// per frustum slice, texel snapping, fade band), with cascade count, splits and atlas layout configurable;
// a drop-in LightShadow.
//
// The shader side comes from installCascadeShadowChunks(): four slots are always declared, unused ones
// carry an empty depth range and are not drawn. The `w` of each cascade vec4 is its texel size in metres,
// which scales the depth bias, normal offset and filter radius per cascade.

export const MAX_CASCADES = 4;

const _lightOrientation = new THREE.Matrix4();
const _viewToLight = new THREE.Matrix4();
const _lightDir = new THREE.Vector3();
const _up = new THREE.Vector3();
const _center = new THREE.Vector3();
const _near = Array.from({ length: 4 }, () => new THREE.Vector3());
const _far = Array.from({ length: 4 }, () => new THREE.Vector3());
const _corners = Array.from({ length: 8 }, () => new THREE.Vector3());

// filter radius is clamped to [1, MAX_RADIUS] texels; the tile inset keeps it inside the atlas tile
const MAX_RADIUS = 2.5;

export class CascadedSunShadow extends THREE.LightShadow {
  constructor() {
    super(new THREE.OrthographicCamera(-5, 5, 5, -5, 0.5, 500));
    this.isSunLightShadow = true;
    this.mapSize.set(2048, 2048);
    // active cascades and the view distances (m) where each hands over to the next
    this.cascades = 3;
    this.splits = [14, 50];
    this.fade = 0.12;   // fraction of a cascade's depth range that blends into the next one

    this._cameras = [];
    this._matrices = [];
    this._frustums = [];
    this._cascadeData = [];
    this._viewports = [];
    for (let i = 0; i < MAX_CASCADES; i++) {
      this._cameras.push(new THREE.OrthographicCamera());
      this._matrices.push(new THREE.Matrix4());
      this._frustums.push(new THREE.Frustum());
      this._cascadeData.push(new THREE.Vector4(1e10, -1e10, 1e10, 1));
      this._viewports.push(new THREE.Vector4(0, 0, 1, 1));
    }
    this._viewportCount = MAX_CASCADES;
    this._rendering = false;
    this._frameExtents.set(2, 2);
  }

  // n active cascades (1..4); splits: n - 1 ascending distances. Two cascades fit an atlas of 2x1 tiles.
  configure(n, splits) {
    this.cascades = THREE.MathUtils.clamp(n | 0, 1, MAX_CASCADES);
    this.splits = splits.slice(0, this.cascades - 1);
    this._frameExtents.set(this.cascades > 2 ? 2 : this.cascades, this.cascades > 2 ? 2 : 1);
  }

  // The renderer sizes the shader uniform arrays (always all four cascades) and draws one shadow pass per
  // viewport from this count. Inactive cascades must not be drawn (frustumCulled = false meshes such as
  // trees and grass would be submitted for nothing), so during the shadow render only the active ones are reported.
  getViewportCount() { return this._rendering ? this.cascades : MAX_CASCADES; }

  // wrap the shadow map render so getViewportCount() knows when passes are being asked for
  attach(renderer) {
    const sm = renderer.shadowMap, render = sm.render;
    sm.render = (...args) => {
      this._rendering = true;
      try { return render.apply(sm, args); } finally { this._rendering = false; }
    };
  }

  getCamera(i = 0) { return this._cameras[i]; }
  getMatrix(i = 0) { return this._matrices[i]; }
  getFrustum(i = 0) { return this._frustums[i]; }

  updateMatrices(light, viewCamera) {
    if (viewCamera === undefined) return;
    const n = this.cascades;
    const ext = this._frameExtents;

    // inset the tiles so the filter cannot read across atlas tiles
    const insetX = Math.min(0.25, (Math.ceil(MAX_RADIUS) + 1) / this.mapSize.x);
    const insetY = Math.min(0.25, (Math.ceil(MAX_RADIUS) + 1) / this.mapSize.y);
    for (let i = 0; i < MAX_CASCADES; i++) {
      // tile (col, row) in the atlas, filled row by row
      if (i < n) this._viewports[i].set((i % ext.x) + insetX, Math.floor(i / ext.x) + insetY, 1 - 2 * insetX, 1 - 2 * insetY);
      else this._viewports[i].set(0, 0, 1, 1);
    }
    const resX = this.mapSize.x * (1 - 2 * insetX);
    const resY = this.mapSize.y * (1 - 2 * insetY);
    const resolution = Math.min(resX, resY);

    const camera = this.camera;
    const vNear = viewCamera.near;
    const vFar = Math.max(vNear + 1e-6, Math.min(camera.far, viewCamera.far));

    const edges = [vNear];
    for (let i = 1; i < n; i++) edges.push(THREE.MathUtils.clamp(this.splits[i - 1], vNear + 0.5, vFar - 0.5));
    edges.push(vFar);

    _lightDir.setFromMatrixPosition(light.matrixWorld).negate().normalize();
    _up.set(0, 1, 0);
    if (Math.abs(_up.dot(_lightDir)) > 0.99) _up.set(0, 0, 1);
    _lightOrientation.lookAt(_center.set(0, 0, 0), _lightDir, _up);
    _viewToLight.copy(_lightOrientation).transpose().multiply(viewCamera.matrixWorld);

    // view frustum corners in light space (the rotation keeps distances, so fitting and snapping work here)
    const zNear = viewCamera.reversedDepth ? 1 : -1;
    const invProj = viewCamera.projectionMatrixInverse;
    let globalMaxZ = -Infinity;
    for (let i = 0; i < 4; i++) {
      const x = i === 0 || i === 1 ? 1 : -1;
      const y = i === 0 || i === 3 ? 1 : -1;
      const nc = _near[i].set(x, y, zNear).applyMatrix4(invProj);
      const fc = _far[i].copy(nc).multiplyScalar(vFar / vNear);
      nc.applyMatrix4(_viewToLight);
      fc.applyMatrix4(_viewToLight);
      globalMaxZ = Math.max(globalMaxZ, nc.z, fc.z);
    }
    // raise the ceiling one shadow range towards the light so casters outside the view still cast into it
    globalMaxZ += vFar;
    const shadowNear = camera.near;

    for (let i = 0; i < MAX_CASCADES; i++) {
      const data = this._cascadeData[i];
      if (i >= n) { data.set(1e10, -1e10, 1e10, 1); continue; }

      // each cascade also covers the fade band of the previous one so both can be sampled while blending
      const begin = i === 0 ? vNear : this._cascadeData[i - 1].z;
      const end = edges[i + 1];
      const fadeStart = end - this.fade * (end - edges[i]);
      data.set(i === 0 ? -1e10 : begin, end, fadeStart, 1);

      // bounding sphere of the slice: rotation stable
      const a0 = (begin - vNear) / (vFar - vNear), a1 = (end - vNear) / (vFar - vNear);
      _center.set(0, 0, 0);
      for (let j = 0; j < 4; j++) {
        _corners[j * 2].lerpVectors(_near[j], _far[j], a0);
        _corners[j * 2 + 1].lerpVectors(_near[j], _far[j], a1);
        _center.add(_corners[j * 2]).add(_corners[j * 2 + 1]);
      }
      _center.multiplyScalar(1 / 8);
      let r2 = 0, minZ = Infinity;
      for (let j = 0; j < 8; j++) {
        r2 = Math.max(r2, _corners[j].distanceToSquared(_center));
        minZ = Math.min(minZ, _corners[j].z);
      }
      let radius = Math.sqrt(r2);

      // snap to the texel grid: no shimmering when the camera moves
      radius /= 1 - 1 / resolution;
      const tx = 2 * radius / resX, ty = 2 * radius / resY;
      _center.x = Math.round(_center.x / tx) * tx;
      _center.y = Math.round(_center.y / ty) * ty;
      data.w = 2 * radius / resolution;   // texel size in metres

      _center.z = globalMaxZ + shadowNear;
      _center.applyMatrix4(_lightOrientation);

      const cam = this._cameras[i];
      cam.position.copy(_center);
      cam.quaternion.setFromRotationMatrix(_lightOrientation);
      cam.left = -radius; cam.right = radius; cam.top = radius; cam.bottom = -radius;
      cam.near = shadowNear;
      cam.far = globalMaxZ - minZ + 2 * shadowNear;
      cam.coordinateSystem = camera.coordinateSystem;
      cam._reversedDepth = camera.reversedDepth;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
      this._updateMatrix(cam, this._matrices[i], this._frustums[i], this._viewports[i]);
    }
  }
}

// getSunShadow with per-cascade texel-scaled bias, normal offset and filter radius:
//   shadow.bias        depth bias in texels of the cascade (a fixed NDC bias was ~15 cm in the near cascade)
//   shadow.normalBias  offset along the surface normal in texels, scaled by sin(angle to the light)
//   shadow.radius      filter blur in metres; per cascade at least 1 and at most MAX_RADIUS texels
const GET_SUN_SHADOW = /* glsl */`float getSunShadow(
			#if defined( SHADOWMAP_TYPE_PCF )
				sampler2DShadow shadowMap,
			#else
				sampler2D shadowMap,
			#endif
			SunLightShadow sunLightShadow,
			int shadowIndex
		) {

			vec3 worldPos = vSunShadowWorldPosition.xyz;
			// materials without a vertex normal (the terrain computes its own) give a zero vector: treat it as up
			float nLen = length( vSunShadowWorldNormal );
			vec3 worldNormal = nLen > 1e-4 ? vSunShadowWorldNormal / nLen : vec3( 0.0, 1.0, 0.0 );
			float viewDepth = vSunShadowWorldPosition.w;
			int cascadeOffset = shadowIndex * SUN_LIGHT_CASCADES;

			float shadow = 1.0;

			// back to front so each fade band blends with the shadow of the cascade behind it
			for ( int i = SUN_LIGHT_CASCADES - 1; i >= 0; i -- ) {

				// ( begin, end, fade start ) view depths and the texel size of the cascade
				vec4 cascade = sunShadowCascade[ cascadeOffset + i ];

				if ( viewDepth >= cascade.x && viewDepth < cascade.y ) {

					mat4 m = sunShadowMatrix[ cascadeOffset + i ];
					float texel = cascade.w;
					// the third matrix row is the light axis scaled by 1 / depth range
					vec3 zRow = vec3( m[ 0 ][ 2 ], m[ 1 ][ 2 ], m[ 2 ][ 2 ] );
					float zLen = max( length( zRow ), 1e-8 );
					float ndl = dot( worldNormal, zRow / zLen );
					float sinT = sqrt( max( 1.0 - ndl * ndl, 0.0 ) );

					vec3 p = worldPos + worldNormal * ( sunLightShadow.shadowNormalBias * texel * ( 0.3 + 0.7 * sinT ) );
					float bias = - sunLightShadow.shadowBias * texel * zLen;
					float radius = clamp( sunLightShadow.shadowRadius / texel, 1.0, ${MAX_RADIUS.toFixed(1)} );

					float cascadeShadow = getShadow(
						shadowMap,
						sunLightShadow.shadowMapSize,
						sunLightShadow.shadowIntensity,
						bias,
						radius,
						m * vec4( p, 1.0 )
					);

					shadow = mix( cascadeShadow, shadow, smoothstep( cascade.z, cascade.y, viewDepth ) );

				}

			}

			return shadow;

		}`;

let installed = false;
// Call once before any material compiles.
export function installCascadeShadowChunks() {
  if (installed) return true;
  installed = true;
  const C = THREE.ShaderChunk;
  let s = C.shadowmap_pars_fragment;
  const a = s.indexOf('float getSunShadow(');
  const r = a < 0 ? -1 : s.indexOf('return shadow;', a);
  const b = r < 0 ? -1 : s.indexOf('}', r) + 1;
  if (a < 0 || b <= 0 || !/#define SUN_LIGHT_CASCADES 2\b/.test(s)) {
    console.warn('cascadeShadow: shadowmap_pars_fragment layout changed, keeping three\'s two cascades');
    installed = false;
    return false;
  }
  s = s.slice(0, a) + GET_SUN_SHADOW + s.slice(b);
  C.shadowmap_pars_fragment = s.replace(/#define SUN_LIGHT_CASCADES 2\b/, `#define SUN_LIGHT_CASCADES ${MAX_CASCADES}`);
  return true;
}
