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
| 0–100 km/h (auto) | 9.06 s; shifts at ~4800 rpm WOT |
| 80→0 km/h braking | 28 m, 0.85 g, stable with ABS (without ABS the rear locks and it spins) |
| 30° slope, P + handbrake | holds, ~2 cm settle |
| 30° climb, low range | open centre diff: can't climb (correct); centre locked: 10 km/h; auto idles holding on the slope |
| Steady cornering | ~0.57 g limit, ~9° roll, understeer, inner wheels near lift |
| Proving ground | steps up to 45 cm OK, logs OK, 35° ramp OK, twister ±11° axle roll; rock garden needs lockers + a line |
| Trail lap at ≤60 km/h with the corner-slowing driver | completes upright; ~11 % of time a wheel is off the ground |
| Browser cost | physics ≈ 0.45 ms/step (≈1.8 ms/frame), render ≈ 1 ms, truck = 78 meshes after `mergeStatic` |

## Traps already hit

- `flat` is a reserved GLSL word (the tyre shader failed to compile).
- three r186 removed `PCFSoftShadowMap`; use `PCFShadowMap`. Use `NeutralToneMapping`: ACES made the red paint look salmon.
- The Sky shader is very bright. Bloom must stay off in daytime, and `scene.environmentIntensity` must be low (0.22 day), or everything washes out white.
- Screen-space bump mapping in the terrain shader wrecked the normals and hid all shadows on the ground. It was removed; if you want ground detail, use a real normal map.
- Canvas `putImageData` premultiplies alpha and destroys colour where alpha is low. Procedural textures are written straight into `DataTexture`s.
- Terrain features narrower than ~2 grid cells (0.5 m grid) alias into washboard bumps on diagonal trails. That happened with the ruts; keep features wide.
- Trail junctions: blend the trails' smoothed heights by weight, and compute the end corrections **before** mutating the array (a bug left a 2 m cliff there).
- Default headlights off in daytime: in the day each shadow-casting spotlight is a full extra shadow pass for almost no visible light.

## Testing workflow

- **Headless**: `npm run simtest [settle|accel|brake|slope|climb|turn|manual]`. Also `tools/terraintest.mjs` and `tools/junction.mjs` (steepest slope on trail centres).
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

- **Unverified by ear**: engine sound character, levels of tyre/wind/whine.
- Water and fording (the snorkel is decorative for now); winch with a rope; recovery points.
- Tyre tracks: the map-wide 2048² texture is coarse (0.2 m/texel). A local high-res map or decals would look better. Mud sinkage / deformable mud would also help.
- The shadow uses the un-squashed tyre; it needs a custom depth material with the same deform code.
- Terrain: LOD and skirts for far chunks, less visible texture tiling, grass, more biomes. The map is 400 m and the user said it will grow.
- Gameplay: hill descent control, ABS on/off key, selectable engine (diesel), a damage model, force feedback, more gamepad mappings.
- The rock garden can wedge the chassis on boulders. That's fair, but watch for frustration.
- Rollovers at 60–70 km/h in corners are physically plausible (rollover threshold ≈ 0.7 g against dirt μ 0.72) but may feel harsh.

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
- **Quality presets** (`quality.js`, Settings → Graphics, applied live; Auto picks High on an M1 Pro/Max, one step down for windows over ~9 Mpx at the device ratio): measured in headless Chrome 1920×1080 @ DPR 2, trail drive, day: Low 5.1 ms (1920×1080, FXAA, no grass), Medium 8.7 ms (2400×1350, FXAA), High 13.0 ms (2880×1620, MSAA 2), Ultra 22 ms (3840×2160, MSAA 4). The base build measured 11.5–13 ms at 3360×1890 in the same runs (night 13.5–14.1 vs High 13.9–14.4; cockpit 15.1 vs 13.4). Absolute numbers drift ±30 % with other GPU load (other agents' headless pages, the in-app browser); compare interleaved runs. A headless page left on the game keeps the GPU busy: end CDP runs on `about:blank`.
- **Load**: ~3 s to "Ready" (terrain 1.1 s, ground layers/splat/ground data 0.7 s, props + trees 0.6 s, compile + warm-up 0.4 s). `game.loadLog` has the stage times.
- **Not done / ideas**: screen-space AO (only baked cavity/canopy AO), cloud shadows, terrain and trees in water reflections (sky only), undergrowth shadow casting, a drivable ramp into the quarry, interior detail for the hut, snow on the near mountains.
