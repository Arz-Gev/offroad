import * as THREE from 'three';
import { CLOUD_GLSL } from '../world/clouds.js';

// Sun shadow in one depth atlas, in two parts:
// - the world (terrain, trees, rocks, props): 1-2 cascades with explicit splits (render/quality.js SHADOWS) and a
//   smooth filter, so tree shadows are soft like real ones (the sun is a disc: the further the caster is
//   from the ground, the softer the edge, and leaves are metres up);
// - the player's car: its own small, sharp tile that follows the car (setCar: its meshes go on CAR_LAYER, nothing
//   else is drawn into the tile and the car is in no world cascade), so the contact shadow under the car and its
//   shadow on itself stay crisp. The shader multiplies it in only where the point projects (along the light) onto
//   the car's bounding sphere.
// The world cascades fit like three's SunLightShadow (bounding sphere per frustum slice, texel snapping, fade
// band), with the count, splits and atlas layout configurable; a drop-in LightShadow. The texel grid of each tile
// turns with the sun about a point that follows the camera (the car's tile: the car), not about the world's origin:
// there, a few hundred metres away, a sun moving with the day swept the grid ~2 cm a frame, so every edge was drawn
// anew every frame and the sun dapples in the woods blinked.
//
// three's WebGLShadowMap tests every object's layers against the *view* camera, not the shadow camera, so the
// shadow pass sets the view camera's layers per tile (attach): world tiles see layers 0 and SHADOW_LAYER (the
// shadow-only proxies, trees.js), the nearest also NEAR_SHADOW_LAYER (small things: the shrubs), the car tile CAR_LAYER only, the
// lamps' shadows 0 and SHADOW_LAYER.
//
// The shader side comes from installCascadeShadowChunks(): MAX_CASCADES slots are always declared (the last one
// is the car's); unused ones carry an empty depth range and draw nothing. The `w` of each cascade vec4 is its
// texel size in metres, which scales the depth bias and normal offset per cascade and picks its filter.

// For a shader with a sampler2DShadow of its own while there is no shadow map (shadows off, the first frame): a depth
// texture that compares. three's stand-in for a null one is never uploaded, so the sampler sat on a colour texture
// and the whole draw failed (dust and pollen drew nothing with the shadows off).
export const NO_SHADOW_MAP = new THREE.DepthTexture(1, 1);
NO_SHADOW_MAP.compareFunction = THREE.LessEqualCompare;
NO_SHADOW_MAP.needsUpdate = true;

export const CAR_LAYER = 2;      // the player's car: drawn by the view camera and into the car's tile only
export const SHADOW_LAYER = 1;   // shadow-only proxies: drawn into the shadow maps only
export const NEAR_SHADOW_LAYER = 3;   // shadow-only proxies of small things: drawn into the nearest cascade only
const WORLD_MASK = 1 | (1 << SHADOW_LAYER), CAR_MASK = 1 << CAR_LAYER, NEAR_MASK = WORLD_MASK | (1 << NEAR_SHADOW_LAYER);
const WORLD_MAX = 2;                       // world cascades
const CAR = WORLD_MAX;                     // the car's slot
export const MAX_CASCADES = WORLD_MAX + 1;

const _lightOrientation = new THREE.Matrix4();
const _viewToLight = new THREE.Matrix4();
const _lightInverse = new THREE.Matrix4();
const _pivotAt = new THREE.Matrix4();
const _lightDir = new THREE.Vector3();
const _up = new THREE.Vector3();
const _center = new THREE.Vector3();
const _v = new THREE.Vector3();
const _near = Array.from({ length: 4 }, () => new THREE.Vector3());
const _far = Array.from({ length: 4 }, () => new THREE.Vector3());
const _corners = Array.from({ length: 8 }, () => new THREE.Vector3());
const _sun = [], _rest = [];
const _ax = new THREE.Vector3(), _ay = new THREE.Vector3(), _az = new THREE.Vector3(), _p = new THREE.Vector3();

// The filter: a tent over 5x5 texels (the near cascade, the car) or 3x3 (cascades with texels over TENT3_TEXEL),
// each from a few hardware-filtered compares with the weights worked out per sample (Castano's optimised PCF): a
// smooth edge without bands, a lone lit texel under the leaves a round soft spot. The tile inset keeps the filter
// inside its tile.
const TENT3_TEXEL = 0.1;
const INSET = 3;

export class CascadedSunShadow extends THREE.LightShadow {
  constructor() {
    super(new THREE.OrthographicCamera(-5, 5, 5, -5, 0.5, 500));
    this.isSunLightShadow = true;
    this.mapSize.set(2048, 2048);
    // world cascades and the view distances (m) where each hands over to the next
    this.cascades = 2;
    this.splits = [48];
    this.fade = 0.12;   // fraction of a cascade's depth range that blends into the next one
    // the car's tile: texels per side, the car's root (setCar), its bounding sphere (centre in the root's space)
    this.car = { map: 1024, focus: null, center: new THREE.Vector3(), half: 4 };

    this._cameras = [];
    this._matrices = [];
    this._frustums = [];
    this._cascadeData = [];
    this._viewports = [];
    this._pivots = [];      // per tile: the grid point the grid turns about, and its texel size
    for (let i = 0; i < MAX_CASCADES; i++) {
      this._cameras.push(new THREE.OrthographicCamera());
      this._matrices.push(new THREE.Matrix4());
      this._frustums.push(new THREE.Frustum());
      this._cascadeData.push(new THREE.Vector4(1e10, -1e10, 1e10, 1));
      this._viewports.push(new THREE.Vector4(0, 0, 1, 1));
      this._pivots.push({ p: new THREE.Vector3(), t: 0 });
    }
    this._viewportCount = MAX_CASCADES;
    this._rendering = false;
    this._viewCamera = null;
    this.configure({ map: 2048, cascades: 2, splits: [48], car: 1024, far: 170 });
  }

  // S: a SHADOWS preset (render/quality.js): { map, cascades, splits, car, far }. The atlas holds the world
  // tiles side by side and then the car's, a fraction of a tile (car / map) wide. A new layout drops the map
  // (WebGLShadowMap makes a new one on the next frame).
  configure(S) {
    this.cascades = THREE.MathUtils.clamp(S.cascades | 0, 1, WORLD_MAX);
    this.splits = S.splits.slice(0, this.cascades - 1);
    this.car.map = Math.min(S.car || 1024, S.map);
    const ex = this.cascades + this.car.map / S.map;
    if (this.mapSize.x !== S.map || this._frameExtents.x !== ex) {
      this.mapSize.set(S.map, S.map);
      this._frameExtents.set(ex, 1);
      if (this.map) { this.map.depthTexture?.dispose(); this.map.dispose(); this.map = null; }
    }
    this.camera.far = S.far;
  }

  // the player's car: its meshes go on CAR_LAYER (out of the world cascades, into the car's tile); the view
  // camera must see that layer
  setCar(root, camera) {
    camera.layers.enable(CAR_LAYER);
    root.traverse(o => { if (o.isMesh || o.isLine || o.isPoints) o.layers.set(CAR_LAYER); });
    root.updateMatrixWorld(true);
    const sphere = new THREE.Box3().setFromObject(root).getBoundingSphere(new THREE.Sphere());
    this.car.focus = root;
    this.car.center.copy(root.worldToLocal(sphere.center.clone()));
    this.car.half = sphere.radius + 0.3;
  }

  // the uniform arrays always hold every slot; WebGLShadowMap draws all of them (an unused one draws nothing,
  // getCamera gives it no layers)
  getViewportCount() { return MAX_CASCADES; }

  // wrap the shadow map render: the lamps first (world layers), then the sun, which picks the layers per tile
  attach(renderer) {
    const sm = renderer.shadowMap, render = sm.render;
    sm.render = (lights, scene, camera) => {
      if (!lights.length) return render.call(sm, lights, scene, camera);
      _sun.length = _rest.length = 0;
      for (const l of lights) (l.shadow === this ? _sun : _rest).push(l);
      const mask = camera.layers.mask;
      try {
        camera.layers.mask = WORLD_MASK;
        if (_rest.length) render.call(sm, _rest, scene, camera);
        if (_sun.length) {
          if (!this.map) this._makeMap(renderer);
          this._rendering = true; this._viewCamera = camera; render.call(sm, _sun, scene, camera);
        }
      } finally {
        this._rendering = false; this._viewCamera = null;
        camera.layers.mask = mask;
      }
    };
  }

  // the atlas as WebGLShadowMap would make it (depth texture with compare), but a one-channel colour attachment:
  // nothing reads the colour, and RGBA cost ~0.2-0.4 ms of bandwidth a frame (63 MB at High)
  _makeMap(renderer) {
    const w = this.mapSize.x * this._frameExtents.x, h = this.mapSize.y * this._frameExtents.y;
    const map = new THREE.WebGLRenderTarget(w, h, { format: THREE.RedFormat });
    map.texture.name = 'sun.shadowMapColour';
    map.depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
    map.depthTexture.name = 'sun.shadowMap';
    map.depthTexture.format = THREE.DepthFormat;
    map.depthTexture.compareFunction = renderer.state.buffers.depth.getReversed() ? THREE.GreaterEqualCompare : THREE.LessEqualCompare;
    map.depthTexture.minFilter = map.depthTexture.magFilter = THREE.LinearFilter;
    this.map = map;
  }

  // WebGLShadowMap asks for each tile's camera right before drawing the tile: set the layers it draws
  getCamera(i = 0) {
    if (this._rendering) this._viewCamera.layers.mask = i === CAR ? (this.car.focus ? CAR_MASK : 0) : i === 0 ? NEAR_MASK : i < this.cascades ? WORLD_MASK : 0;
    return this._cameras[i];
  }
  getMatrix(i = 0) { return this._matrices[i]; }
  getFrustum(i = 0) { return this._frustums[i]; }

  updateMatrices(light, viewCamera) {
    if (viewCamera === undefined) return;
    const n = this.cascades, mw = this.mapSize.x, mh = this.mapSize.y;

    // world tiles inset so the filter cannot read across tiles
    const insetX = INSET / mw, insetY = INSET / mh;
    for (let i = 0; i < WORLD_MAX; i++) this._viewports[i].set(i + insetX, insetY, 1 - 2 * insetX, 1 - 2 * insetY);
    const resX = mw * (1 - 2 * insetX), resY = mh * (1 - 2 * insetY);
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

    for (let i = 0; i < WORLD_MAX; i++) {
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

      // snap to the texel grid: no shimmering when the camera moves (the radius in steps, so the texel holds)
      radius = Math.ceil(radius * 16) / 16 / (1 - 1 / resolution);
      const tx = 2 * radius / resX, ty = 2 * radius / resY;
      this._snap(i, _center, tx, ty, viewCamera.matrixWorld);
      data.w = 2 * radius / resolution;   // texel size in metres

      _center.z = globalMaxZ + shadowNear;
      _center.applyMatrix4(_lightOrientation);
      this._place(i, _center, radius, shadowNear, globalMaxZ - minZ + 2 * shadowNear);
    }
    this._updateCar();
  }

  // the car's tile: centred on the car's bounding sphere, the light's direction, snapped to its texels.
  // Its cascade vec4: the sphere's centre and radius in atlas texels, texel size in metres
  _updateCar() {
    const car = this.car, data = this._cascadeData[CAR];
    const tile = car.map / this.mapSize.x, inset = INSET / this.mapSize.x;
    const vp = this._viewports[CAR].set(this.cascades + inset, inset, tile - 2 * inset, tile - 2 * inset);
    if (!car.focus) { data.set(0, 0, 0, 1); return; }
    const res = vp.z * this.mapSize.x, texel = 2 * car.half / res;
    car.focus.updateMatrixWorld();
    _center.copy(car.center).applyMatrix4(car.focus.matrixWorld).applyMatrix4(_lightInverse.copy(_lightOrientation).transpose());
    this._snap(CAR, _center, texel, texel, _pivotAt.makeTranslation(_p.copy(car.center).applyMatrix4(car.focus.matrixWorld)));
    _center.z += 60;
    _center.applyMatrix4(_lightOrientation);
    this._place(CAR, _center, car.half, 1, 120);
    const w = this.mapSize.x * this._frameExtents.x, h = this.mapSize.y * this._frameExtents.y;
    data.set((vp.x + vp.z / 2) / this._frameExtents.x * w, (vp.y + vp.w / 2) / this._frameExtents.y * h, res / 2, texel);
  }

  // c (light space) onto tile i's texel grid, which goes through its pivot (world): then the pivot moves along that
  // same grid to the grid point nearest `at` (the camera, the car), so the grid only turns with the sun about what
  // is close by, and nothing shifts when the pivot moves
  _snap(i, c, tx, ty, at) {
    const pv = this._pivots[i];
    _lightOrientation.extractBasis(_ax, _ay, _az);
    if (pv.t !== tx) { pv.t = tx; pv.p.setFromMatrixPosition(at); }   // a new texel size: any grid
    const px = pv.p.dot(_ax), py = pv.p.dot(_ay);
    c.x = px + Math.round((c.x - px) / tx) * tx;
    c.y = py + Math.round((c.y - py) / ty) * ty;
    _v.setFromMatrixPosition(at).sub(pv.p);
    pv.p.addScaledVector(_ax, Math.round(_v.dot(_ax) / tx) * tx).addScaledVector(_ay, Math.round(_v.dot(_ay) / ty) * ty).addScaledVector(_az, _v.dot(_az));
  }

  // an orthographic camera at `pos` looking along the light, `half` metres to each side
  _place(i, pos, half, near, far) {
    const cam = this._cameras[i], camera = this.camera;
    cam.position.copy(pos);
    cam.quaternion.setFromRotationMatrix(_lightOrientation);
    cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half;
    cam.near = near;
    cam.far = far;
    cam.coordinateSystem = camera.coordinateSystem;
    cam._reversedDepth = camera.reversedDepth;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    this._updateMatrix(cam, this._matrices[i], this._frustums[i], this._viewports[i]);
  }
}

// getSunShadow with per-cascade texel-scaled bias, normal offset and filter radius, and the car's tile:
//   shadow.bias        depth bias in texels of the cascade (a fixed NDC bias was ~15 cm in the near cascade)
//   shadow.normalBias  offset along the surface normal in texels, scaled by sin(angle to the light)
// The filter is a tent over 5x5 or 3x3 texels (above): no noise, no bands (three's 5-tap rotated Vogel disk is
// noisy when wide).
const GET_SUN_SHADOW = /* glsl */`
		${CLOUD_GLSL}
		float sunPCF( sampler2DShadow shadowMap, vec2 mapSize, vec4 coord, float bias, bool wide ) {
			coord.xyz /= coord.w;
			coord.z += bias;
			if ( coord.x < 0.0 || coord.x > 1.0 || coord.y < 0.0 || coord.y > 1.0 || coord.z > 1.0 ) return 1.0;
			vec2 uv = coord.xy * mapSize, base = floor( uv + 0.5 ), f = uv + 0.5 - base;
			base -= 0.5;
			vec2 inv = 1.0 / mapSize;
			float z = coord.z, sum = 0.0;
			if ( wide ) {
				vec3 uw = vec3( 4.0 - 3.0 * f.x, 7.0, 1.0 + 3.0 * f.x ), vw = vec3( 4.0 - 3.0 * f.y, 7.0, 1.0 + 3.0 * f.y );
				vec3 u = ( vec3( 3.0 - 2.0 * f.x, 3.0 + f.x, f.x ) / uw + vec3( - 2.0, 0.0, 2.0 ) + base.x ) * inv.x;
				vec3 v = ( vec3( 3.0 - 2.0 * f.y, 3.0 + f.y, f.y ) / vw + vec3( - 2.0, 0.0, 2.0 ) + base.y ) * inv.y;
				sum += uw.x * ( vw.x * texture( shadowMap, vec3( u.x, v.x, z ) ) + vw.y * texture( shadowMap, vec3( u.x, v.y, z ) ) + vw.z * texture( shadowMap, vec3( u.x, v.z, z ) ) );
				sum += uw.y * ( vw.x * texture( shadowMap, vec3( u.y, v.x, z ) ) + vw.y * texture( shadowMap, vec3( u.y, v.y, z ) ) + vw.z * texture( shadowMap, vec3( u.y, v.z, z ) ) );
				sum += uw.z * ( vw.x * texture( shadowMap, vec3( u.z, v.x, z ) ) + vw.y * texture( shadowMap, vec3( u.z, v.y, z ) ) + vw.z * texture( shadowMap, vec3( u.z, v.z, z ) ) );
				return sum * ( 1.0 / 144.0 );
			}
			vec2 uw = vec2( 3.0 - 2.0 * f.x, 1.0 + 2.0 * f.x ), vw = vec2( 3.0 - 2.0 * f.y, 1.0 + 2.0 * f.y );
			vec2 u = ( vec2( 2.0 - f.x, f.x ) / uw + vec2( - 1.0, 1.0 ) + base.x ) * inv.x;
			vec2 v = ( vec2( 2.0 - f.y, f.y ) / vw + vec2( - 1.0, 1.0 ) + base.y ) * inv.y;
			sum += uw.x * ( vw.x * texture( shadowMap, vec3( u.x, v.x, z ) ) + vw.y * texture( shadowMap, vec3( u.x, v.y, z ) ) );
			sum += uw.y * ( vw.x * texture( shadowMap, vec3( u.y, v.x, z ) ) + vw.y * texture( shadowMap, vec3( u.y, v.y, z ) ) );
			return sum * ( 1.0 / 16.0 );
		}

		float getSunShadow(
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
			vec2 mapSize = sunLightShadow.shadowMapSize;

			float shadow = 1.0;

			// world cascades, back to front so each fade band blends with the shadow of the cascade behind it
			for ( int i = ${WORLD_MAX - 1}; i >= 0; i -- ) {

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

					#if defined( SHADOWMAP_TYPE_PCF )
						float cascadeShadow = sunPCF( shadowMap, mapSize, m * vec4( p, 1.0 ), bias, texel < ${TENT3_TEXEL.toFixed(3)} );
					#else
						float cascadeShadow = getShadow( shadowMap, mapSize, 1.0, bias, 1.0, m * vec4( p, 1.0 ) );
					#endif

					shadow = mix( cascadeShadow, shadow, smoothstep( cascade.z, cascade.y, viewDepth ) );

				}

			}

			#if defined( SHADOWMAP_TYPE_PCF )
			// the car's tile, only where the point projects (along the light) onto the car's bounding sphere
			{
				vec4 car = sunShadowCascade[ cascadeOffset + ${CAR} ];
				mat4 m = sunShadowMatrix[ cascadeOffset + ${CAR} ];
				vec4 c = m * vec4( worldPos, 1.0 );
				vec2 d = c.xy * mapSize - car.xy;
				if ( dot( d, d ) < car.z * car.z ) {
					float texel = car.w;
					vec3 zRow = vec3( m[ 0 ][ 2 ], m[ 1 ][ 2 ], m[ 2 ][ 2 ] );
					float zLen = max( length( zRow ), 1e-8 );
					float ndl = dot( worldNormal, zRow / zLen );
					float sinT = sqrt( max( 1.0 - ndl * ndl, 0.0 ) );
					vec3 p = worldPos + worldNormal * ( sunLightShadow.shadowNormalBias * texel * ( 0.3 + 0.7 * sinT ) );
					shadow *= sunPCF( shadowMap, mapSize, m * vec4( p, 1.0 ), - sunLightShadow.shadowBias * texel * zLen, true );
				}
			}
			#endif

			float cloud = cloudShadow( worldPos );
			#ifdef GI_PARS
			giCloud = cloud;   // the ground's bounce dims under the cloud too (gi.js)
			#endif
			return mix( 1.0, shadow, sunLightShadow.shadowIntensity ) * cloud;

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
