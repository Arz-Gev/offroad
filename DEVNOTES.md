# Dev notes

Things that are not obvious from reading the code: conventions, measured baselines, traps already hit, and the backlog.

## Conventions

- **Vehicle frame** (physics and model share it): `+x` right, `+y` up, **`-z` forward**. `y = 0` is the ground at static ride height, `z = 0` is mid-wheelbase. Front axle `z = -1.397`, rear `+1.397`.
- **Wheel spin** `ω > 0` = rolling forward = rotation about `-x`. Tyre torque on the wheel is `-Fx * Re`.
- **Axle roll** `phi > 0` = right side up = rotation about body `+z`. Axle compression `c` is measured at the springs (`springTrack`), not at the wheels.
- **Steer** input `+1` = right. Wheel yaw rotation is `-steer` about `y`.
- **Rapier heightfield**: `heights[ix * (N+1) + iz]`, columns = x, rows = z, centred on the collider. Each cell is split along the diagonal **(x1, z0)–(x0, z1)**. `terrainView.js` uses the same split; if the two differ, wheels float or sink.
- Rapier scene queries only see colliders after a `world.step()`. Wheel rays exclude the vehicle's own body, which also excludes the wheel side-collider cylinders.

## How the physics fits together

- Rapier steps at **240 Hz** (`H` in `main.js`). Each step, `Vehicle.step()` casts the ray fans once. It then runs **4 substeps** of tyre normal force → tyre friction → drivetrain PGS solve → tyre relaxation → axle dynamics → deflection update. The forces are averaged and applied with `addForceAtPoint` (after `resetForces`/`resetTorques`).
- **Axle DOF** uses absolute velocities (`vz`, `Om`). Body-relative rates are `vz - vMountU` and `Om - rollRateBody`. The unsprung mass is included in the Rapier body, and its gravity along `up` is cancelled on the body because the axle DOF carries it.
- **Force split**: the component of each tyre force along body-up goes into the axle DOF. The rest is applied to the chassis at the hub, which puts the roll centre at axle height (panhard rod). The roll moment from side force acting at the contact patch goes into the axle roll. Removing that is what let the truck corner at 1 g without tipping.
- **Tyre model** (`tire.js`):
  - Contact-patch deflection states `ux`, `uy` follow the relaxation-length ODE (implicit Euler).
  - The deflection is clamped by the steady-state slip, so a spinning wheel can't wind up.
  - A low-speed damper (`2.6 * Fn * fade`) stops parked trucks oscillating.
  - Stability of these terms relies on the 960 Hz substep. Raise substeps if you add stiffness.
- **Drivetrain** (`drivetrain.js`):
  - Bodies: engine, input shaft, 4 wheels.
  - Equality rows: gear, centre/axle lockers, park pawl.
  - Bounded rows: clutch/lock-up, brakes, handbrake, engine friction, rolling resistance.
  - Warm start, 24 PGS iterations.
  - Open diffs need no special code: the gear row with `-G/4` per wheel already gives an equal torque split.
- **Torque reactions**: the body gets `-(Ie*αe + Tprop_f + Tprop_r)` about `+z`, and each axle gets `+Tprop`. That's where the launch body roll and axle wrap come from. The sign follows a crank turning clockwise seen from the front.
- **Suspension**: coil springs at `springTrack` with progressive bump stops (with hysteresis), dampers at `damperTrack` (outboard, digressive above `damperKnee`). Roll damping matters most: it was ζ≈0.2 and the truck rocked itself onto two wheels.
- **Traction control** (`vehicle.tc`, key Y): brakes any wheel whose surface speed exceeds the ground speed under it, so open diffs send torque to the wheels with grip. Full authority below ~30 km/h, fading with speed.
- **Auto upshift** uses `min(wheel speed, ground speed)`. Without that it upshifted while the wheels were spinning in the rock garden.

## UI (HUD, menu, input)

- **Files**: `input.js` (keyboard + gamepad, `BINDINGS`), `hud.js` (in-game HUD), `menu.js` (Esc menu + welcome card), `settings.js` (saved settings), `ui.css` (all UI styles), `main.js` (wires them together). `index.html` only holds the loading screen and its inline styles.
- **`BINDINGS` in `input.js` is the single source of truth** for every control: the key/pad dispatch, the HUD hints, the toasts' key caps, the welcome card and the menu's Controls page are all generated from it. To add a control, add a binding with an `id`, then a handler in `ACTIONS` in `main.js`.
- Discrete actions fire from the key event (`input.onAction`), not from the game loop, so they work while driving frames by hand with `game.tick`. Plain keys are `preventDefault`ed while driving (no scrolling, no Firefox quick find); the F row except F3 and every Cmd/Ctrl/Alt combination go to the browser. On a Cmd keydown the held keys are dropped (macOS sends no keyup for them).
- **Settings**: `settings.set(key, value, { silent })` saves to localStorage (every access wrapped in try/catch) and calls `APPLY[key]` in `main.js`. Keys, the menu and startup all go through it, so a setting can't drift from the game state. `silent` means no toast (startup, and menu changes, where the control shows the result). The welcome card's "seen" flag is a separate storage key.
- **Pause**: the menu and the welcome card pause the game (`game.paused`): no physics steps, the master gain fades out, the menu gets the keys/pad (`input.uiHandler`), and the 3D view renders only when something changes (`game.redraw`, time-of-day blend). Auto-pause on window blur / tab hide is a setting.
- **Feedback**: `hud.toast(html, { kind: '' | 'good' | 'warn', key })`. A toast with the same `key` updates in place instead of stacking (pressure, lights, camera, ...). Drivetrain `say()` strings are mapped to toasts with device-specific key caps in `DT_MESSAGES` (`hud.js`). Persistent context tips (rolled over, engine off, in neutral, stuck) come from `HUD.updateTips` at 4 Hz.
- **Cost rules**: no layout reads per frame; DOM text/classes are written only when the shown value changes (cache in `hud.c`); bars move with `transform`; the rpm dial redraws only when the rpm moves ≥ 20 rpm, over a cached static layer; the suspension panel checks at 20 Hz and redraws only when a shown value changes; telemetry updates at 10 Hz only while visible. Measured: HUD ≈ 0.02 ms/frame, < 1 DOM mutation per frame while driving.
- **Scaling**: the HUD scales with `--s` = √(min(W/1600, H/1000)) clamped to 0.8–1.4, times the HUD-size setting; every HUD length is `calc(N * var(--u))`. Small windows (< 760 wide or < 560 high) and the cockpit view get the compact cluster. The menu uses fixed px with media queries (full-screen sheet under 640 px).
- **Sound pill**: audio needs a user gesture; the pill says so until the AudioContext runs, then hides (or shows "Sound off" while muted). Mute and volume act on the master gain only.
- **Testing the UI**: dismiss the first-start card first (`game.menu.closeIntro()`; it also pauses `game.tick` physics until closed). Dispatch `KeyboardEvent`s on `window` to test keys; `game.action('camera')` etc. runs an action directly; a fake gamepad works by overriding `navigator.getGamepads`. The browser pane can't screenshot HTML overlays reliably at emulated sizes larger than the pane, so use `tools/cdp.mjs` (headless Chrome over CDP) for HUD/menu screenshots at any size.

## Baselines (re-run `npm run simtest` after physics changes and compare)

| Check | Value |
|---|---|
| Static load sum | = weight (21 974 N); tyre squash ≈ 3 cm at 20 psi, 5–6 cm at 8 psi |
| 0–100 km/h (auto) | 8.7 s; shifts at ~4800 rpm WOT (traction control trims launch wheelspin) |
| 80→0 km/h braking | 34 m, ~0.75 g on dirt (μ 0.72), stable with ABS (without ABS the rear locks and it spins) |
| 30° slope, P + handbrake | holds, ~2 cm settle |
| 30° climb, low range | open diffs + traction control: climbs; centre locked: climbs faster; TC off + open centre: can't (correct) |
| Steady cornering (`tools/handling.mjs`) | dirt ~0.59 g, grass ~0.50 g, ~8° roll, no wheel lift in steady turns or keyboard slalom up to 70 km/h |
| Proving ground | steps up to 45 cm OK, logs OK, 35° ramp OK, twister ±11° axle roll; rock garden needs lockers + a line |
| Trail lap (`tools/traillap.mjs 60 0.45 90`) | 53 km/h mean, wheel off ground 5.8 %, vertical accel rms 2.65 m/s², max roll 9°, no rollovers (before the Oct 2 ride fix: 12 %, 4.0 m/s², 27°) |
| Browser cost | physics ≈ 0.45 ms/step (≈1.8 ms/frame), render ≈ 1 ms, truck = 78 meshes after `mergeStatic` |

## Traps already hit

- **Wheel side cylinders must never touch the terrain heightfield.** They are teleported to the hub every step, so any contact with the ground becomes a huge impulse on the whole truck (10–37 g spikes, the "pogo stick" ride). Collision groups: heightfields are `GROUP_GROUND` (set in the Vehicle constructor), the cylinders filter it out and only hit rocks, logs and trees.
- Keyboard steering at speed must be limited by lateral acceleration (`applyInput`): full lock at 45 km/h used to ask for 4× the angle the bend needed, which rocked the truck onto two wheels.

- `flat` is a reserved GLSL word (the tyre shader failed to compile).
- three r186 removed `PCFSoftShadowMap`; use `PCFShadowMap`. Use `NeutralToneMapping`: ACES made the red paint look salmon.
- The Sky shader is very bright. Bloom must stay off in daytime, and `scene.environmentIntensity` must be low (0.22 day), or everything washes out white.
- Screen-space bump mapping in the terrain shader wrecked the normals and hid all shadows on the ground. It was removed; if you want ground detail, use a real normal map.
- Canvas `putImageData` premultiplies alpha and destroys colour where alpha is low. Procedural textures are written straight into `DataTexture`s.
- Terrain features narrower than ~2 grid cells (0.5 m grid) alias into washboard bumps on diagonal trails. That happened with the ruts; keep features wide.
- Trail junctions: blend the trails' smoothed heights by weight, and compute the end corrections **before** mutating the array (a bug left a 2 m cliff there).
- Default headlights off in daytime: in the day each shadow-casting spotlight is a full extra shadow pass for almost no visible light.

## Testing workflow

- **Headless**: `npm run simtest [settle|accel|brake|slope|climb|turn|manual]`.
  - Ride/handling on the real map and synthetic roads: `tools/traillap.mjs [kmh] [cornerG] [secs] [analog|digital]` (trail loop with a pure-pursuit driver; `digital` mimics keyboard steering), `tools/handling.mjs [surface]` (keyboard full-lock circles and slaloms), `tools/bumptest.mjs [kmh] [height] [length] [both|left]`, `tools/climb.mjs [surface] [high|low] [humps] [open,centre,all]` (`NOTC=1` turns traction control off). Also `tools/terraintest.mjs` and `tools/junction.mjs` (steepest slope on trail centres).
- **In the browser**, `window.game` exposes:
  - `tick(dt)` runs one frame by hand
  - `autopilot = fn(vehicle, dt) -> raw input`
  - `placeVehicle(x, z, yaw)` and `teleports`
  - `action(id)` runs a control (`BINDINGS` id), `menu`, `settings`, `setPaused(bool)`, `paused`
  - `timings` (ms per stage), plus `vehicle`, `rig`, `env`, `bloom`, …
- `shot()` captures only the WebGL canvas. For the HUD and menus use `tools/cdp.mjs` (see its header), or `read_page` / DOM inspection in the pane.
- A hidden browser pane or background tab throttles `requestAnimationFrame`. FPS readings are then meaningless and screenshots are stale. Drive with `game.tick` and capture frames with `tools/shotserver.py` plus the `shot()` helper in `tools/browser-snippets.js`, which also has the lane and trail test drivers.
- Engine sound: `node tools/enginesound.mjs out.wav` renders the worklet through a fixed script (idle, blip, lugging, cruise, WOT, overrun) and prints the level of each segment. Keep low-rpm lugging quieter than high-rpm WOT. Exhaust pulses last a fixed crank angle; the old fixed ~1.5 ms noise clicks sounded like a ticking motorboat at idle (user complaint). Audio-model reviews (seed via OpenRouter) of the WAV were inconsistent, so treat them as weak evidence.

## Backlog / ideas

The player's task list with status is in `TASKS.md`; keep it current.

- **Unverified by ear**: engine sound character, levels of tyre/wind/whine.
- Water and fording (the snorkel is decorative for now); winch with a rope; recovery points.
- Tyre tracks: the map-wide 2048² texture is coarse (0.2 m/texel). A local high-res map or decals would look better. Mud sinkage / deformable mud would also help.
- The shadow uses the un-squashed tyre; it needs a custom depth material with the same deform code.
- Terrain: LOD and skirts for far chunks, less visible texture tiling, grass, more biomes. The map is 400 m and the user said it will grow.
- Gameplay: hill descent control, selectable engine (diesel), a damage model, force feedback, more gamepad mappings.
- The rock garden can wedge the chassis on boulders. That's fair, but watch for frustration.
- Rollovers at 60–70 km/h in corners are physically plausible (rollover threshold ≈ 0.7 g against dirt μ 0.72) but may feel harsh.

## Truck model, cockpit and lamps

- **Files** (`src/vehicle/`): `truckModel.js` assembles the truck and keeps the running gear (wheels, axles, springs, links) tied to `params.js`; `truckBody.js` exterior; `truckInterior.js` cabin + gauges; `truckLights.js` lamps + beam cookies; `truckMaterials.js` materials and shader patches; `truckDims.js` shared body dimensions (measured off `reference.webp`: 2.794 m wheelbase = 459 px in the side view); `geom.js` modelling helpers and `mergeStatic`.
- **Greenhouse tumblehome**: everything above the waist is built straight, then `warpGroup(gh, tumblehome(WAIST, k))` scales x by height (normals follow). Build greenhouse parts at their straight positions.
- **Extrude helpers keep the outline exact** (`bevelOffset = -bevel`): the bevel eats inward, so profiles can be drawn at their final size.
- **Materials**: `truckMaterials.js` patches stock materials (`customProgramCacheKey` per option set):
  - `dirt`: object-space dust on the lower body and a film on flat tops (needs the merged geometry in body space, which `mergeStatic` gives).
  - `env`: multiplier on the specular environment. `scene.environmentIntensity` is kept low for the terrain, so glass/chrome need more; paint is set below 1 because the sky PMREM washes red paint out at grazing angles (bonnet in the hood/cockpit view).
  - `glass`: premultiplied output (tint attenuated by alpha, reflections not), back faces reflect almost nothing (inside the cabin the env horizon showed as a line across the screen).
  - `ao`: cabin occlusion on interior materials (the hemisphere light is not shadowed).
  - `grain`: object-space noise bump on plastics, height in metres (~0.1–1 mm), faded by `fwidth`. A unit-height bump at 420 cycles/m looked like asphalt. Guard the normalize: a NaN pixel is spread over the whole screen by bloom (black cockpit at night).
- **Cockpit geometry**: eye `(-0.42, 1.76, 0.10)`, fov 62, pitch −0.14. Windscreen spans about −24° … +10° from the eye; rim top sits at the screen base (21–25° below the eye line); the dials (26–34°) sit between the rim and the wheel boss (35°). The binnacle sits on the fascia's front edge, in front of the dash shelf (`DT = 1.40`): when it sat inside the shelf, the shelf top cut the lower half of every dial. Keep the housing face behind the dial discs (z-fighting doubled the numbers). Check the eye→rim/dial/boss lines if you move anything.
- **Lamps** (`truckLights.js`): ground irradiance from a lamp at height h is `I·h/r³`, so a plain cone always blows out the near ground. The beams are spot lights with a `SpotLight.map` cookie encoding I(elevation, azimuth): near field ~1/100 of the peak, hot zone just under the cut-off, flat cut-off with a right-side kick-up (low), hot spot on the horizon (high), wide flood with little upward light (bar). Cookies are half-float (8-bit banded in the near field). The cookie's projection is the spot's shadow camera (fov = 2·angle, far = distance); outside it the light is *not* masked, so keep `shadow.focus = 1` and far = distance.
  - One head spot (in front of the bumper hoop, so no truck geometry is in its frustum) is the only shadow caster; `shadow.autoUpdate` is on only while the head lamps are on. Bar and rear spots have no shadow. No point lights.
  - Lights are `visible = false` in the day unless switched on (no per-pixel cost); at night they stay visible at zero intensity so switching lamps never recompiles shaders. The day→night switch recompiles once (as before). A one-time prewarm with `renderer.compileAsync` with the lights visible would remove that hitch (needs a hook in `main.js`).
  - Lamp output is scaled by the scene's ambient level (sun·sinθ + hemi, read from the scene lights) so headlights in daylight don't paint a pool on the ground.
  - Vertical surfaces 10–20 m ahead in the hot zone get ~100× the ground irradiance (physics: `I/d²` vs `I·h/r³`). Driving at a bank, that blew out and bloomed over the whole windscreen. `truckLights.js` patches `ShaderChunk.lights_fragment_begin` (spot-light loop only; only the truck has spot lights) with a soft shoulder on each lamp's irradiance, `E/√(1+(E/K)²)`, `K = LAMP_KNEE = 9`. Beam-lit road is ~1–7, so the throw is untouched. It coexists with the world branch's `if (directLight.visible)` wrap of the same loop (both regexes match either order). If the night exposure changes a lot, retune `K` with it.
- **Colliders** (`params.js`, density 0, so mass/inertia are unchanged): the engine-bay box top was raised to the raised bonnet centre (1.38 m) and the rack box to the rack top (2.33 m); before, the bonnet could sink ~13 cm into a rock and the rack ~10 cm into the ground on a rollover. simtest output is identical.
- **Budget**: 110 meshes after merging (79 shadow casters), ~160 k triangles (the tyres are ~25 k each). Day frame cost went down versus the old truck: its 7 lights (2 point, 4 spot, cabin) were evaluated per pixel on all terrain even at zero intensity.
- **Measured** (headless Chrome, 1920×1080 @ DPR 1.75, trail driver, base and new interleaved twice; another agent's Chrome was loading the GPU, so only the ratios mean anything): GPU ms/frame day chase 41/38 → 29/23, day cockpit 50/46 → 33/28, night chase high+bar 92/86 → 65/66, night cockpit high+bar 100/91 → 84/75. Draw calls 174 → 212 (day), 208 → 225 (night, lamps on).
- **Testing beams**: hide `scene.children[0]` / `[1]` (terrain, props), add a flat 400 m plane with posts at the truck's pose and shoot top-down and cockpit views; the real terrain (banks, ramps) makes beam shapes hard to judge.

## World and rendering

- **Files**: `world/terrain.js` (map generation, trails, water bodies, `POI`), `world/terrainView.js` (CDLOD terrain renderer + ground-data map), `world/textures.js` (GPU-baked ground layers, bark), `world/materials.js` (triplanar mossy rock), `world/grass.js`, `world/undergrowth.js`, `world/foliage.js` (card atlas, tree/plant geometry), `world/trees.js` (forest, impostors, fallen logs), `world/water.js`, `world/props.js` (boulders, outcrops, ruined hut, proving-ground props), `world/colliderStream.js`, `world/sky.js` + `world/atmosphere.js` (scattering sky), `world/environment.js` (time of day), `render/pipeline.js` (HDR post), `render/quality.js` (presets), `render/shaderPatches.js` (fog/atmosphere, light skipping). Splashes are in `effects.js`.
- **Map**: 1024 m, 0.5 m grid (2049² heights, `N = 2048`). Inside r < 140 m the original 400 m map is unchanged (trail loop, branch, proving ground, big hill); it blends into the outer design by 200 m. Edge mountains continue into an 8 km render-only vista (16 m grid, `terrain.far`); invisible walls stand at the map edge. Generation ≈ 1.1 s (coarse 2 m + mid 1 m fields upsampled, fine detail from a periodic 128 m tile). `node tools/mapimage.mjs out.png` renders the layout (relief, surfaces, trails, water).
- **Consistency with the physics**: the terrain's level-0 patches, the grass, the undergrowth and the water all read the physics heights (R32F texture, data layout `ix * NN + iz`, so `texelFetch(t, ivec2(iz, ix))`) with Rapier's cell split. Trees, rocks and the hut sit on `surfaceHeight` (same split).
- **Trail ride quality** (user complaint: bouncy): after the junction blends and the mud hole, `smoothTrailBeds()` low-passes the bed under the trail band (Gaussian σ 2 m, normalised over the driven bed only, so cut walls don't leak in), then adds the rut/crown detail back. Outer trails get a cut-only grade limit (`maxGrade`) and their kinks rounded. Checks: `node tools/trailprofile.mjs 65` (crests that unload the truck below a speed; BASE=2 for sharper features) must list none; `node tools/junction.mjs` (steepest trail-centre slope, 19.2°); `node tools/traillap.mjs 60 0.45 90` (from main, needs main's vehicle physics). With main's physics: wheel off ground 5.8 → 2.6 %, vertical accel rms 2.65 → 1.93 m/s², peak 33.9 → 11.9, max roll 9.2 → 8.0°; outer loop (trail 2) 1.5 %, rms 1.42, no rollovers.
- **Static colliders are streamed** (`ColliderStream`, chunks of 32 m, ±2 chunks around the truck; trees have their own copy of the same scheme). Rapier's step cost grows with every collider in the world, static, far or *disabled* (~0.12 µs per collider per 240 Hz step: 800 boulders = 0.4 ms/frame); only removal helps. `placeVehicle` and the physics loop call `updatePhysics`/`stream.update`; scene queries see new colliders after the next `world.step()`. Physics per frame went from ~1.5–2.3 ms (base: 1100 trunks + 500 rocks always in) to ~0.7–1.0 ms.
- **HDR pipeline** (`pipeline.js`): scene → RGBA16F target (MSAA per preset) → bloom (13-tap down / tent up, soft threshold applied after exposure) → exposure (fixed by day, eye adaptation at night, clamped per preset) → Neutral tone map → grade → sRGB → optional FXAA. The renderer itself has `NoToneMapping`. Bloom by day is weak and high-threshold (the Sky/bloom washout trap still applies).
- **Light units and the night** (for the lamps): sun ≈ 4 scene units at noon, moon 0.22 (moonlit ground ≈ 0.1–0.15), sky and fog from the same single-scattering model (`atmosphere.js`). Night exposure adapts in 1.0–3.2 (key 0.06): a beam-lit road at 1–7 units renders as a bright mid tone, moonlit ground stays dim and blue; bloom at night has threshold 1.4 (after exposure), strength 0.06, so lamp lenses glow without smearing. The truck branch's lamps (45 000 cd peak low beam, irradiance shoulder K = 9) were checked against this; if the exposure range changes, retune K with it. Grass and foliage respond to lamps through mostly-up normals (blades facing the beam a little more), so roadside grass glows without blowing out.
- **Shader traps hit**:
  - A geometry without a `normal` attribute makes three compile MeshStandard/Lambert/Phong `FLAT_SHADED`: vertex normals are ignored and `vNormal` doesn't exist. The grass computes its normals in the shader, so it carries a dummy normal attribute.
  - `DoubleSide` flips the normal on back faces; for foliage cards and grass blades that made every back-facing card shade as if it faced into the crown / the ground (half the grass was black). Foliage uses `NO_FLIP_NORMAL` (`trees.js`).
  - Program variants include the output colour space: `compileAsync` must run with the HDR target bound (`compileScene()` in `main.js`), otherwise it compiles sRGB-output programs that are never used.
  - Lamp visibility / shadow flags change the lights hash and recompile every lit program: the load warms up with one real frame with all lamps on (first lamp switch at night 600 → 20 ms).
  - Instanced grass is vertex bound on the M1 Pro (~2.5 ms per million blade vertices, culled blades included): radius × density of the 2-segment near layer is the main cost knob. The tile index rides in the mesh matrix (no instanced divisor attribute).
- **Quality presets** (`quality.js`, Settings → Graphics, applied live; Auto picks High on an M1 Pro/Max, one step down for windows over ~9 Mpx at the device ratio): measured in headless Chrome 1920×1080 @ DPR 2, trail drive, day: Low 5.1 ms (1920×1080, FXAA, no grass), Medium 8.7 ms (2400×1350, FXAA), High 13.0 ms (2880×1620, MSAA 2), Ultra 22 ms (3840×2160, MSAA 4). The base build measured 11.5–13 ms at 3360×1890 in the same runs (night 13.5–14.1 vs High 13.9–14.4; cockpit 15.1 vs 13.4). Grass and undergrowth have their own table per preset (hand-tuned by the user, `quality.js`: density, height, width, distance, dense-layer radius, far-layer width/spacing/growth; bushes density, size, distance) and sliders under Settings → Graphics → Grass and bushes, whose ranges are 20 % below the lowest to 20 % above the highest preset value (`RANGES` in `settings.js` and the menu rows must stay in sync); the Grass and bushes switch (`vegetation`, not part of the presets) hides all of it. Density is the cell spacing (1/√density) for both grass layers and the bushes, so a low density really draws fewer instances; the far grass layer widens and thins past 52 m only as far as `grassFarGrow` says (0 in every preset). Vegetation cost on an M1 Pro, 1920×1080 @ DPR 2, whole frame: Low 9 ms, Medium 13, High 19, Ultra 46 (Ultra without vegetation 26). Absolute numbers drift ±30 % with other GPU load (other agents' headless pages, the in-app browser); compare interleaved runs. A headless page left on the game keeps the GPU busy: end CDP runs on `about:blank`.
- **Sun shadow** (`render/cascadeShadow.js`): three's `SunLightShadow` is fixed at two cascades, so this is the same algorithm with 2-4 cascades, explicit split distances and a 2x2 atlas. `SHADOWS` in `quality.js` sets map size, far, cascades, splits and softness per level (High 3 cascades at 2560, Ultra 4 at 4096 = 8192 px atlas, 268 MB). The shader chunk `getSunShadow` is replaced (`installCascadeShadowChunks`): bias, normal offset and filter radius scale with each cascade's texel size (`shadow.bias` / `normalBias` are in texels, `radius` in metres). Four cascade slots are always declared (the uniform arrays must hold them); unused ones are not drawn (`attach()` makes `getViewportCount()` report only the active ones during the shadow pass). The terrain has no vertex normal, so a zero `vSunShadowWorldNormal` must not be normalised (NaN made every ground lookup read as lit).
- **Graphics options** (menu Graphics tab): every preset field has a setting with a `g` prefix (`presetToGfx` / `gfxToQuality` in `quality.js`). Picking a preset writes its values into them (`{ sync: true }`, ignored by their handlers); changing one switches `quality` to `custom`, which builds the quality object from them. Shadows `off` sets `sun.castShadow = false` (recompiles lit programs once).
- **SSAO** (`pipeline.js`): the HDR target carries a `DepthTexture` (resolved from MSAA by three). Half-resolution pass, 8 or 16 spiral samples, normals rebuilt from depth neighbours (smaller depth step wins), 1.0 / 1.4 m radius, fades out by 160 m, 4x4 Bayer rotation pattern + one depth-aware 4x4 box blur that averages exactly one period (the old noise + separable blur left a residual pattern that beat against the upsampling at some pixel densities), multiplied into the scene colour before exposure. Flat ground must read exactly 1.0 (check by reading `pipeline.ao[1]` with `readRenderTargetPixels` into a Uint16Array, half floats): depth samples are snapped to full-res texel centres before unprojecting, normals use central differences except across depth edges, and an occluder must stand 4 cm + 0.6 % of the distance above the tangent plane. Without these the ground showed resolution-dependent bands / dot grids (user saw them on a Mac and a 1440p monitor). Intensity 1.8.
- **Load**: ~3 s to "Ready" (terrain 1.1 s, ground layers/splat/ground data 0.7 s, props + trees 0.6 s, compile + warm-up 0.4 s). `game.loadLog` has the stage times.
- **Not done / ideas**: terrain and trees in water reflections (sky only), undergrowth shadow casting, a drivable ramp into the quarry, interior detail for the hut, snow on the near mountains.

## 2026-10-02: quick fixes batch
- Handbrake: rear-axle brake as before, plus a standstill hold on the transfer output (`brakes.handbrakeHold`, fades out by 2 m/s) so an open centre diff can't let the front pull away. Modes `hold | toggle | auto` (auto: tap < 0.3 s toggles, long press holds) (setting `handbrake`, logic in `Vehicle.handbrakeLogic`). Test: `node tools/hbtest.mjs [deg]`.
- 2WD (key F): `drivetrain.rwd` drives the rear axle only, HIGH range only, forces the centre lock off; `wheelMean()` follows the driven wheels.
- ABS on/off (key B); HUD shows "ABS OFF".
- Seat backs leaned forward (looked rear-facing): rotation sign fixed in `truckInterior.js`.
