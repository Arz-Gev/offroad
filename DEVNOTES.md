# Dev notes

What the code can't tell you: conventions, traps, rejected options, baselines, how to test.

Rules for this file: lasting facts only. No history, no dates, no "before / after" numbers (git and the PRs keep those). Name where a value lives instead of copying it, so a retune doesn't make the note wrong. Earlier agents wrote it: treat every claim as a hint, check it, and fix the note when it is wrong.

## Conventions

- **Vehicle frame** (physics and model): `+x` right, `+y` up, **`-z` forward**. `y = 0` is the ground at static ride height on the stock setup (bigger tyres and lift raise the body: `rideRaise`), `z = 0` mid-wheelbase.
- **Wheel spin** `ω > 0` = rolling forward = rotation about `-x`. Tyre torque on the wheel is `-Fx * Re`.
- **Axle roll** `phi > 0` = right side up = rotation about body `+z`. Axle compression `c` is measured at the springs (`springTrack`), not at the wheels.
- **Steer** `+1` = right. Wheel yaw rotation is `-steer` about `y`.
- **N axles**: wheels `2a` (left) and `2a+1` (right) of axle `a`, front to back.
- **Rapier heightfield**: `heights[ix * (N+1) + iz]`, columns = x, rows = z, centred on the collider. Each cell is split along the diagonal **(x1, z0)–(x0, z1)**. `terrainView.js` and every shader that reads the physics heights use the same split; if they differ, wheels float or sink.
- Rapier scene queries see colliders only after a `world.step()`. Wheel rays exclude the vehicle's own body (this also excludes the wheel side cylinders).

## Physics

- Rapier at **240 Hz** (`H` in `main.js`); each step `Vehicle.step()` casts the ray fans once, then runs **4 substeps** (960 Hz) and applies the averaged forces. Tyre relaxation and the damper terms are stable only because of 960 Hz: raise substeps if you add stiffness.
- **Axle DOF** uses absolute velocities (`vz`, `Om`); body-relative rates are `vz - vMountU`, `Om - rollRateBody`. Unsprung gravity along `up` is cancelled on the Rapier body, because the axle DOF carries it.
- **Force split**: the tyre force along body-up goes into the axle DOF, the rest acts on the chassis at the hub (roll centre at axle height, panhard rod). The roll moment from side force at the patch goes into the axle roll; that is what lets the truck corner at 1 g without tipping.
- **Independent corners** (`Vehicle.cornerSubstep`): one DOF per wheel; `rcHeight` sets the side force's share into the corner (`q = rc / (track/2)`), the rest goes to the body at the patch. An independent car's anti-roll bar is N/m at the wheels, a beam axle's is N·m/rad; `suspcheck.mjs` and the tuning panel count an independent bar as `arb · track²`.
- **Static loads**: lever rule for 2 axles, a rigid body on equal springs for more (`axleShares`).
- **Tyre model** (`tire.js`):
  - Deflection `ux`, `uy` is clamped by the steady-state slip so a spinning wheel can't wind up; a low-speed damper stops parked trucks oscillating.
  - Radial damping (`tireRadialDamping`) grows when aired down and when creeping. The shocks do ~10× more, so it matters mostly for the heavy BTR. `node tools/tirehop.mjs bump|wash [kmh] [psi]`.
  - Load sensitivity: the peak slip angle grows as `Fn^0.35` (`latPeak`), so cornering stiffness ~`Fn^0.65`; without it load transfer cost no grip and weight split and bars barely changed the balance. It is relative to `P.tire.fnRef` (the 33" tyre's load): without that the BTR's tyres lost a quarter of their μ and it couldn't stand on 30°.
- **Contact patch** (`Vehicle.castContact` / `integrateTyre`): 39 rays, ground linear between rays, `TIRE_SUB` samples between rays, force `K·√δ` per angle, `K` from `tireRadialStiffness(psi)`. The tread band is stiff (loaded profile = upper envelope of the raw one under parabolas of curvature `R / (2·TIRE_BELT)`): without it a step edge cut into the tyre and gave big acceleration spikes. Costs ~0.55–0.75 ms per physics step for 4 wheels. `node tools/tiretest.mjs rock|step [kmh] [psi]`.
- **Tilted tyres and hard landings** (`tools/droptest.mjs`; `tools/resettest.mjs` drops the truck at random spots, `ROLL=90` on its side): a tyre squashed onto its rim gives back only `RIM_GIVE_BACK` of the strike; the tilted ground normal is `n_wheelplane·√(1−s²) + axle·s` (exact for a plane; the cheaper approximation let side grip hold a rolled truck up on its tyre shoulders); the outer ray rows add the tread overhang × s, else the downhill edge sank unfelt.
- **Physics ground = drawn ground** (`node tools/groundmatch.mjs`): terrain rays and `surfaceHeight` must agree to fractions of a mm. A boulder's collider is the convex hull of its vertices and the drawn rock is pushed out onto that hull (`props.js addRock`, ~170 ms at load), so tyres don't float over dents. Hull above mesh: median ~0.1 mm, 90 % ~8 mm, 99 % ~29 mm; much more means `addRock` broke.
- **Drivetrain**: open diffs need no special code (the gear row with `-G/4` per wheel already splits equally). Torque reactions: body gets `-(Ie*αe + Tprop_f + Tprop_r)` about `+z`, each axle `+Tprop` (launch roll, axle wrap); sign follows a crank turning clockwise seen from the front.
- **Drive layouts** (`drive.layout`: 'awd' default, 'parttime', 'rwd', 'fwd'; `driveLayout(P)`): centre-diff groups (`axles[i].group`, axles in a group rigidly linked), cam-type LSD axle diffs, centre split `drive.centreSplit` (group 0's share, 0.5 = equal), `drive.centre: 'viscous'` bounds the lock by Nm per rpm of prop slip. With several handbrake axles each needs its own row: one row on the mean let the groups counter-rotate through the centre diff and held nothing. `node tools/difftest.mjs [car]`, `npm run simtest layouts`. In difftest the Lancia with TC off at full throttle on split grip yaws round: expected (its Torsen and coupling spin the dirt wheels too; a driver would lift).
- **Handbrake**: rear brake plus a standstill hold on the transfer output (`brakes.handbrakeHold`, fades out by 2 m/s), so an open centre diff can't let the front pull away. `node tools/hbtest.mjs [deg]`. **2WD** (F): `drivetrain.rwd`, high range only, forces the centre lock off; `wheelMean()` follows the driven wheels.
- **Handling balance** (`tools/yawtest.mjs`): mild understeer (~1.9°/g at the road wheels on dirt; lifting off at the limit tucks the nose in a little and settles) that comes from real parts, not a stability aid: tyre load sensitivity, front weight share, front roll-stiffness share a little above it, steering compliance (`Vehicle.steerCompliance`), rear roll steer (`rollSteer`). Yaw inertia includes the axles. Roll damping matters: at ζ≈0.2 the truck rocked itself onto two wheels.
- **Traction control** (`vehicle.tc`, Y) brakes any wheel faster than the ground under it so open diffs send torque to wheels with grip; full authority below ~30 km/h. Its cap scales with `P.brakes.front` (a fixed cap let eight spinning BTR wheels sit on a 30° ramp forever). Rolling backwards with wheels driven forwards counts as wheelspin, so TC brakes them and the vehicle slides on: gradient tests climb from a run-up, like real ones.
- **Auto upshift** uses `min(wheel speed, ground speed)` (else it upshifts while the wheels spin in the rock garden). Manual-only cars (`P.manualOnly`) get `autoShift`: at full throttle it upshifts only if the next gear still accelerates (else a 30° climb in 1st low shifted at the governor and bogged).
- **Driveline losses** `P.tire.hubDragV` (BTR: hub reductions, eight wheel drives): without it the BTR ran to its governor well past its real top speed.

## Traps already hit

- **Wheel side cylinders must never touch the terrain heightfield.** They are teleported to the hub every step, so ground contact is a huge impulse on the whole truck (10–37 g spikes, the "pogo stick" ride). Heightfields are `GROUP_GROUND`; the cylinders filter it out and only hit rocks, logs and trees.
- **Don't fix understeer with rear roll stiffness.** Moving roll stiffness to the rear once made the rear-heavy truck nearly neutral and it spun on lift-off at speed. The real cause was keyboard steering asking for far too much angle (next item).
- **Keyboard steering at speed is limited by lateral acceleration** (`applyInput`, setting `steerAssist`, `STEER_ASSIST` in `Vehicle.js`): a held key asks for the angle that corners at k × the grip under the truck + c × the front tyres' peak slip angle. Input filter only: flooring the gas at the limit can still spin the truck, by design. The gamepad keeps its own speed curve; touch steering counts as analog. `node tools/steerassist.mjs` (`FULL=1` floors the gas).
- With no one steering the truck wanders slowly under full power (axle wrap + roll steer). Real, but headless runs need room.
- **Teleport stall**: `reset()` zeroes the wheel speeds, which stalls an engine with the converter locked; so it drops the lock-up and sets `startGrace`.
- After `world.step()` Rapier has cleared the solver contacts (`numSolverContacts()` is 0). Read `numContacts()` with `contactDist(j) < 0.01` and `localContactPoint1/2` (pick by `flipped`) instead (`touchPoints` in `colliderView.js`).
- **Static colliders cost even when far or disabled** (~0.12 µs per collider per 240 Hz step); only removal helps, hence `ColliderStream` (32 m chunks, ±2 around the truck).
- `flat` is a reserved GLSL word.
- Tone mapping is Neutral (`render/post.js`): ACES made red paint look salmon.
- The Sky shader is very bright: by day bloom needs a high threshold (`bloomThr` in the `environment.js` keys), or everything washes out white.
- Screen-space bump mapping in the terrain shader wrecked the normals and hid all ground shadows. For ground detail use a real normal map.
- Canvas `putImageData` premultiplies alpha and destroys colour where alpha is low. Procedural textures go straight into `DataTexture`s.
- Terrain features narrower than ~2 grid cells (0.5 m) alias into washboard bumps on diagonal trails. Keep features wide.
- Trail junctions: blend the trails' smoothed heights by weight, and compute the end corrections **before** mutating the array (a bug left a 2 m cliff).
- **16 samplers per shader stage** (WebGPU). The terrain at night with the lamps on uses 15: sun shadow (2 world cascades + the car's own map), the head lamp's shadow and cookie, the aux cookie, the light probe, the DFG LUT and its own textures. Every `SpotLight.map` (cookie) and every shadowed light adds a sampler to *every* lit material: that is why searchlights have no cookie, the muzzle flash light casts no shadow and the world gets at most 2 cascades. Textures with Nearest min and mag filters take no sampler (the rut map; the terrain blends it by hand).
- **Never change the set of lights.** Adding or removing a light, toggling `castShadow` or `visible`, giving a SpotLight another `map`, or setting another `scene.environment` texture rebuilds the node shaders of every lit material (1–2 s of CPU each time; the pipeline cache doesn't save it). So the lamps are always in the scene at intensity 0 when off (`LampSpotLightNode` in `render/lamps.js` skips an off lamp's cookie, shadow and BRDF in a shader branch), the head lamp keeps one cookie texture and gets the low / high beam copied into it, and the finished reflection probe is copied into one target (`envShown`). `tools/hitchtest.mjs` looks for long frames over lamp switches and a day / night sweep.
- **The head lamp's shadow map is drawn once during the warm-up** (`shadow.needsUpdate` in `main.js`). Its first render replaces the texture three made at compile time, and some materials kept the old one: a "Destroyed texture ShadowDepthTexture used in a submit" error every frame from the first lamp switch on.
- Headlights default off in daytime: each shadow-casting spotlight is a full extra shadow pass for almost no visible light.

## Baselines

Rows marked **(simtest)** are checked by `npm run simtest`, which fails on a regression; run it after physics changes. The others are manual tools: rerun the one that matches what you changed. A band that a deliberate change moves goes in the same commit, with the new number here.

| Check | Value |
|---|---|
| Static load sum (simtest) | = weight; tyre squash ≈ 3.3 cm at 20 psi, 5–6 cm at 8 psi |
| 0–100 km/h, auto (simtest) | Defender 8.7 s, G-Class 5.2 s (real 5.4), Lancia 5.5 s (real 5.7); static ride error under 1.5 cm (`simtest cars`) |
| 0–100 per engine (`node tools/dyno.mjs`, auto / manual, in the Defender) | 4.6 V8 8.67 / 9.12 s, 5.0 V8 5.39 / 6.12, 3.5 V8 19.1 / 18.9, 300Tdi 21.7 / 23.3, Td5 17.6 / 18.0, 2.4 TDCi 17.7 / 15.9, G 500 5.10 / 5.91, Lancia 2.0 9.9 / 11.8. The tuning panel's estimate is within ~5 %; the Lancia engine is further off (~6 % auto, ~12 % manual) |
| 80→0 km/h braking (simtest) | 34 m, ~0.75 g on dirt, stable with ABS (without ABS the rear locks and it spins) |
| 30° slope, P + handbrake (simtest) | holds, ~2 cm settle |
| 30° climb, low range (simtest) | open diffs + TC: climbs; centre locked: faster; TC off + open centre: can't (correct) |
| Steady cornering (`tools/handling.mjs`) | dirt ~0.59 g, grass ~0.50 g, ~8.5° roll, no wheel lift. Concrete: 0.79 g, but a keyboard slalom rolls it over (static stability factor ≈ 0.87) |
| High-speed yaw (`tools/yawtest.mjs dirt 90 3`) | fixed road-wheel angle, then lift off: body slip stays under ~8° and shrinks; no spin at 1–5°, 60–110 km/h on dirt, grass, concrete |
| Trail lap (`tools/traillap.mjs 60 0.45 90`) | 52.8 km/h mean, any wheel off ground 1.6 %, vertical accel rms 2.02 m/s², max roll 8.3°, no rollovers |
| Sharp-edged ramps (`tools/ramptest.mjs`, low, all locked, concrete) | approach 42°, departure 32°, breakover 39°; climbs 25–40° (dirt up to 38°). The rear overhang limits departure; bumpers scrape at the foot of 30°+ ramps |
| Live retune (`tools/retunetest.mjs`) | big tyre / lift / load / spring changes while parked: peak vertical accel ≤ 1.4 m/s², standing still after |
| BTR-80 (simtest btr) | 0–60 24.4 s, top 80.3 km/h (real 80); 60→0 23 m; 30° from a run-up in 1st low; parked on 30° with the handbrake; 25° side slope holds; turning radius 13.6 m (real 13.2); 0.46 g at 40 km/h. Turret: 90° in 7.8 s, −4°…+60°; KPVT 600 rpm, 771 m/s |
| Proving ground (drive it) | steps up to 45 cm and logs OK, 35° ramp OK, twister ±11° axle roll; the rock garden needs lockers and a line (it can wedge the chassis: fair, but watch for frustration) |
| Ground match (`tools/groundmatch.mjs`), trail junctions (`tools/junction.mjs`) | see Physics; steepest trail-centre slope 19.2° |

Not checked: in manual with the auto-clutch, lifting off on a 30° climb in 1st low opens the clutch and the truck rolls back; the automatic holds.

## Testing

- **Headless physics**: `npm run simtest [settle|accel|brake|slope|climb|turn|manual|cars|btr|layouts|suspension]`, exit 1 on any FAIL. `VERBOSE=1` prints traces; `TUNE='{json}'` prints only.
- Per-car tools take `CAR=<id>`: `traillap.mjs [kmh] [cornerG] [secs] [analog|digital]`, `handling.mjs [surface]`, `yawtest.mjs`, `steerassist.mjs`, `tiretest.mjs`, `tirehop.mjs`, `droptest.mjs`, `resettest.mjs`. The car as an argument: `suspcheck.mjs [car]` (sag, room to the bump rubber, heave frequency, front roll share), `difftest.mjs [car]`. Defender only: `bumptest.mjs`, `climb.mjs` (`NOTC=1`), `ramptest.mjs`, `retunetest.mjs`, `profile.mjs` (visible body vs colliders: run after moving bodywork or colliders; it shows lower angles than the colliders because shackles and exhaust are left out on purpose). Terrain: `terraintest.mjs`, `junction.mjs`, `trailprofile.mjs` (must list no crests that unload the truck), `mapimage.mjs out.png`.
- **Browser**: `window.game` (`tick(dt)`, `autopilot`, `placeVehicle`, `action(id)`, `timings`, `loadLog`, `env`, `mp`, ...). `shot()` captures only the game canvas; for HUD and menus use `tools/cdp.mjs` (headless Chrome over CDP).
- A hidden pane or background tab throttles `requestAnimationFrame`: FPS readings are meaningless and screenshots stale. Drive with `game.tick` and capture with `tools/shotserver.py` + `shot()` from `tools/browser-snippets.js` (also has the lane and trail drivers).
- **UI**: dispatch `KeyboardEvent`s on `window`; a fake gamepad by overriding `navigator.getGamepads`; touch with Playwright `hasTouch` + CDP `Input.dispatchTouchEvent`. A headless page gets `blur` events and opens the menu: turn `autoPause` off.
- **Dynamic resolution**: `game.updateDynamicResolution(dt, false)` takes fake frame times (a hidden pane can't give real ones).
- **Graphics** (headless Chrome with `--enable-unsafe-webgpu`, see the tool headers): `tools/gfxbench.mjs` (fixed views, ms per frame, screenshots), `tools/gfxprofile.mjs` (what switching each system off saves), `tools/hitchtest.mjs` (long frames). They drive whole frames with `game.frame()` and stop the rAF loop with `game.holdLoop`: three renders the scene pass once per *node frame*, which advances only on animation frames, so `tick`s in a row skip the scene (the tools print `scene Nx` as a check). Wait ~6 s after load before measuring. `?webgl=1` forces the WebGL 2 backend. Navigate with a fresh query string each run, or Chrome serves stale modules.
- **GPU timing** drifts ±30 % with other GPU load (other agents' headless pages, the in-app browser): compare interleaved runs, and end CDP runs on `about:blank`.
- **Sound**: `node tools/enginesound.mjs out.wav` renders the worklet through a fixed script and prints each segment's level; `starttest.mjs [auto|manual] [P|N]` / `startsound.mjs` for the engine start (rpm trace: cranks ~170–280 rpm, flares to ~2100, idle after ~3 s; it's player-tuned, so a drivetrain change that moves this trace changed the start). Audio-model reviews of the WAV were inconsistent: the player's ear decides.

## UI (HUD, menu, input, touch)

- **`main.js`** builds the world and the car, wires settings (`APPLY`), actions (`ACTIONS`) and the menu, and runs the frame (`tick`). Split out of it: `loading.js` (loading screen), `graphics.js` (presets, resolution, dynamic resolution, Auto quality), `placement.js` (locations, teleports, Recover).
- **`BINDINGS` in `input.js` is the single source of truth** for controls (dispatch, HUD hints, key caps, menu Controls page). To add one: a binding with an `id`, then a handler in `ACTIONS` in `main.js`. `setCarControls` / `hasControl` drop the controls a car lacks (`vehicle/controls.js`) everywhere.
- Discrete actions fire from the key event (`input.onAction`), not the game loop, so they work while driving frames with `game.tick`. On Cmd keydown the held keys are dropped (macOS sends no keyup for them); the F row except F3 and all Cmd/Ctrl/Alt combos go to the browser.
- **HUD cost rules**: no layout reads per frame; DOM text/classes written only on change (cache in `hud.c`); bars move with `transform`; the rpm dial redraws only on a ≥ 20 rpm move.
- **Touch** (`touch.js`): pointer capture on every control (multi-finger; sliding off keeps the control); `touch.release()` on pause prevents stuck gas. The device becomes `'touch'` only *after* a tap finishes (switching re-renders the UI and would eat the click).
- Picking a car only marks it (`menu.pending`); **Apply & restart** reloads, because module state is set once at startup.

## Cars

How to add one: `src/cars/README.md`. Every car is a file in `src/cars/`, listed in `index.js`; `vehicle/carParams.js` `makeCarParams(id)` builds any of them. Shared code never checks which car it is.

- **Each car must feel like itself** (player): copying the Defender's chassis onto the G-Class and Lancia fixed their ride and was rejected. Ride comfort comes from trail-friendly travel and pressures; character from weight, inertia, engine, steering ratio, bars and tyre grip.
- **Tyre sizes are absolute** (`tyreRadius` / `tyreWidth` in `tire.js`, calibrated on the Defender's 33"), 0.5" steps.
- **Setups** are stored per car (`offroad.tuning.v1.<car>`, the Defender keeps the bare key); `tuning.useCar(id)` runs first in `main.js`. Migrations live in `fill` in `tuning.js` (setup `v`, a car's `suspensionV` drops an older suspension section).
- **Tuning panel with more than two axles**: front / rear readouts are the first and last axle. The panel's BTR top speed and 0–60 are a little slower than the physics on purpose (the estimate includes `hubDragV`).
- **Imported models** (`model/shell.js`): the shell's wheels go into our wheel groups; own tyres don't squash; transmission glass becomes plain alpha (transmission costs a second scene render); `realBlack` fixes the dark cabins (a `colorNode` / `metalnessNode` on the GLTF material, which three's node copy keeps; `createTireMaterial` copies them onto deforming tyres). `tools/cutparts.mjs` moves pieces inside a box into their own node (steering wheels, lamp glass, driving lamps). `physics.archTop` is measured with rigview `measureArches()`.
- **Lights per car**: J is "aux" (extra lamps) everywhere in code; only `look.lightBar` keeps its name. A light bar beam exists only where the car has a bar (`look.lightBar`); other extra lamps come from `look.lamps.aux` and `look.searchlights`.
- **G-Class** (front double wishbones, rear beam) and **Lancia** (struts all round): springs at the wheel track give much more roll stiffness than inboard beam springs, so the independent axles carry little or no bar (the G-Class's rear beam bar is stiffer instead). Lancia: lower roll centres rolled the outer wheels onto the bump rubbers in every trail corner; more travel or stiffer springs brought back floor strikes and a rollover at 85 km/h; with the Defender's `stallK` its 2.0 stalled in D. Its inner rear wheel lifting in a hard slalom is intended (rally Delta).
- **Static ride**: the Defender's and G-Class's front springs sit at ~40 % of travel; the Lancia and BTR at about half. Stiffer springs to reach 40 % were tried and rejected on the Lancia (its low floor hits crests at 70+; `raise` is clearance, not travel) and the BTR (less droop, worse wheel loads on diagonal blocks). `node tools/suspcheck.mjs` prints the numbers.
- The BTR-82A the player asked for has no downloadable model; that's why the game has the BTR-80.
- **Rejected model, don't download again**: Toyota Land Cruiser J200 (David_Holiday): SketchUp-style export, no textures, most surfaces doubled with a dark see-through copy, tyres in hundreds of pieces.

## BTR-80

- **Model** (`public/models/btr80.glb`; prep config and commands in `assets-src/btr80/`): `tools/prepcar.mjs` handles N wheels (corners `<axle><L|R>`), holder node at each measured hub, tyre material split out (`tire_<k>`), suspension parts split out of the hull by bounding boxes. The physics hub path follows design curves, so the arms stretch a few cm over the travel. `tools/rigview.html?car=btr80` poses the rig by hand (`pose`, `isolate`, `hide`, `turret`, `rays`).
- Steers its first two axles about one centre (`steer.centreZ`, Ackermann); centre-diff groups 1+3 / 2+4 like the real transfer case.
- **Turret and guns** (`turret.js`, `weapons.js`): rounds are point masses with quadratic drag (`k` from the published retained velocity), ray cast per step, ricochet at glancing angles, recoil impulse at the trunnion. Every round is a tracer (a game choice).
- **Muzzle flash**: real photographed flames (`public/fx/muzzle-*.png`, from `assets-src/muzzleflash/`); the strip along the bore must be `DoubleSide`. **Flash light**: a spot and a point glow that stay in the scene at intensity 0 (no recompile), dim by day (`FLASH_DAY`), no shadows (texture units, see Traps).

## Multiplayer (`multiplayer.js`)

- **Transport**: Trystero (WebRTC; public Nostr relays only for introduction, `appId` `offroad-defender-arzgev`), lazy-loaded on first join. Rooms = `?room=<id>`. No TURN server: peers behind symmetric NAT can't connect. The fix is a relay (Cloudflare Durable Object, or Trystero's `ws-relay`); Vercel can't host one.
- **Model**: every player simulates only their own truck and sends a flat array (`S` layout) `SEND_HZ` times a second. The receiver keeps `BUF` snapshots, estimates clock offset as the smallest `now − senderTime` seen (creeping up slowly for drift), plays back `DELAY` behind, extrapolates up to `EXTRAP`.
- **Friends' trucks** use the normal `VehicleView` through a proxy (`makeProxy`), without spot lights (a light per truck changes the lights hash) and without sound.
- **Solid trucks** (setting `solidTrucks`; off = ghosts): the friend's collision boxes on a *dynamic* puppet body with their mass, gravity off, excluded from the heightfield, pulled to the network pose by a critically damped spring (snaps on a large error). A kinematic body was tried: hitting a parked friend stopped us dead and they felt nothing.
- **Test**: two headless Chromes (own ports and `--user-data-dir`) on the same `?room=` URL, `localStorage` preloaded with `autoPause: false` and a name; `game.mp` exposes `peers`, `note`, `follow`.

## Truck model, cockpit and lamps

- **Files**: `src/vehicle/model/index.js` builds a car's model from its look; the Defender's procedural body is in `model/defender/` (`dims.js` measured off `reference.webp`: 2.794 m wheelbase = 459 px in the side view).
- **Greenhouse tumblehome**: everything above the waist is built straight, then `warpGroup(gh, tumblehome(WAIST, k))` scales x by height. Build greenhouse parts at their straight positions. Extrude helpers keep outlines exact (`bevelOffset = -bevel`): draw profiles at final size.
- **Materials** (`materials.js`, node materials): `dirt` needs merged geometry in body space (`mergeStatic`); glass and chrome get stronger sky reflections (`uEnvSpec`; `render/envscale.js` scales the probe's specular per material), paint stays below 1 (the sky washes red out at grazing angles); glass draws only the viewer-facing cap (`maskNode = frontFacing`; both caps of the slab attenuated the view twice); `grain` is a bump height in metres (~0.1–1 mm), and its normalize must be guarded (a NaN pixel is spread over the screen by bloom).
- **Cockpit eye lines** (from the Defender's cockpit eye): windscreen −24° … +10°; steering-rim top at the screen base, 21–25° below the eye line; dials 26–34°, between rim and wheel boss (35°). The binnacle sits on the fascia's front edge (inside the dash shelf its top cut the dials). Keep the housing face behind the dial discs (z-fighting). Recheck these eye lines if you move anything.
- **Lamps** (`lamps.js`): ground irradiance from a lamp at height h is `I·h/r³`, so a plain cone blows out the near ground; beams are spot lights with a half-float `SpotLight.map` cookie encoding I(elevation, azimuth), soft-edged. The cookie projects through the spot's shadow camera; outside it the light is *not* masked, so keep `shadow.focus = 1` and far = distance.
  - One head spot (ahead of the bumper, so no truck geometry is in its frustum) is the only shadow caster, updated only while the head lamps are on. No point lights: every light is evaluated per pixel on all terrain even at zero intensity.
  - Lamp output is scaled by the scene's ambient level so daytime headlights paint no pool.
  - Vertical surfaces 10–20 m ahead get ~100× the ground irradiance: `LampSpotLightNode` (`render/lamps.js`, registered for every SpotLight) caps each lamp's irradiance with a soft shoulder `E/√(1+(E/K)²)`, `K = LAMP_KNEE`, using |N·L| so leaves and blades lit through their back face are capped too. Retune K if night exposure changes a lot.
- **Testing beams**: hide the terrain and props, add a flat 400 m plane with posts at the truck's pose, shoot top-down and cockpit views.

## Vehicle tuning

- **Files**: `vehicle/tuning.js` (schema, `STOCK` built from the car's file, `applySetup`, `analyze`, `RANGES`), `tuningPanel.js`, `colliderView.js` (Show physics), `dyno.js` + `dyno.worker.js`. A new stock setup goes into the car's file (`src/cars/<id>.js`).
- `applySetup(P, setup)` writes into the existing params, so Vehicle, Drivetrain and the view see changes on the next step:
  - *Live*: engine, gears, dampers, bars, travel, brakes, steering, grip, pressures (per axle: `vehicle.pressures`; `[ ]` keep the split).
  - *Eased*: tyre radius and lift (`morphGeometry`); spring rates and mass blend over ~0.5 s. Step changes launched the body at 1 g.
  - *Rebuilt in place*: mass, COM, inertia (`setAdditionalMassProperties`); chassis boxes and wheel cylinders recreated on the same body.
  - Physics geometry lives on the vehicle (`vehicle.R`, `axle.droopY`); the view and overlay read those, not `P`.
- **Lift** lowers `droopY`, so body, colliders and COM rise together and arch room grows. Rubbing is drawn (red tyre outline), not simulated.
- **Defender colliders** are fitted to the visible body (comments in `src/cars/defender.js`); an invisible low nose box was why it couldn't climb steep ramps. Left out on purpose: D-ring shackles and the exhaust (they bend). The spare-wheel box doesn't scale with tyre size.
- **Measure 0–100**: a worker builds its own Rapier world (flat dirt strip) and a `Vehicle` from a copy of the live params; no steering (a lane-keeping correction scrubbed the tyres and doubled the time).
- Closed panel and Show physics off cost nothing per frame.

## Renderer: WebGPU (`render/`)

The game renders with three's `WebGPURenderer`. Every shader is TSL (`three/tsl`), compiled to WGSL on WebGPU and to GLSL on the WebGL 2 backend the same renderer falls back to (`?webgl=1` forces it). No `ShaderMaterial`, `onBeforeCompile` or `ShaderChunk` patches: a plain material from a loader gets a node copy made by three, which keeps any `*Node` fields set on it.

- **Files**: `gpu.js` (the device with the adapter's limits; `renderer.caps`: `webgpu`, `compute`, `gpu` name for Auto, `floatFilter`), `post.js` (scene pass, SSAO, quarter-res sun shafts, bloom, eye adaptation one frame late in 1×1 ping-pong targets, composite with Neutral tone map and grade, FXAA / SMAA), `fog.js` (`scene.fogNode`, the `ATMO` uniforms `environment.js` writes), `shadows.js`, `lamps.js`, `foliage.js` (lighting model with light through leaves), `envscale.js` (per-material sky reflection), `sprites.js` (particles as instanced quads), `glbake.js` (startup bakes of the GLSL ground-layer and ripple recipes on a throwaway WebGL 2 context, read back into textures).
- **Anti-aliasing**: Off / FXAA / SMAA / MSAA 4× (WebGPU multisamples 1× or 4× only; a saved MSAA 2× becomes 4×). Off in every preset.
- **Bloom** (`post.js`): three's BloomNode passes everything above its threshold at full strength with no cap, so its input is prefiltered like the old chain (Karis average of 4 taps, a cap, a soft knee) and BloomNode's own threshold is 0. Without it the sun disc flooded half the screen and the glow vanished at once when the disc left the view.
- **Traps**:
  - TSL generates an expression where it is first used. Anything read after a variable is reassigned, or used in more than one branch of an `If`, must be pinned with `.toVar()` first: the grass's far bucket got zeros for its blade data, and the sky LUT came out black.
  - Compute shaders have no camera: pass its position as a uniform (`grass.shared.uCam`). A compute node's `count` is also a bounds check three writes into the shader: set it before each dispatch.
  - A compute stage may have as few as 8 storage buffers (10 on the M1 Pro): the grass packs each bucket's blade data into one buffer.
  - `positionNode` is a *local* position: a mesh that carries data in its matrix (the WebGL vegetation tiles carry their tile index) must subtract it again, or every tile is drawn shifted by its offset.
  - Don't use `exp2()` for numbers that must be whole (cell indices that get hashed): it isn't exact on every GPU.
  - `material.colorNode` replaces color × map; a material with `map` on a geometry without uv makes the shadow pass sample it anyway (warning): the Defender tyre wraps the rubber texture from its position and drops `map`.
  - `normalWorld` inside a colorNode is the final normal: use `normalWorldGeometry` there, or it is a cycle. An explicit `normalNode` is never flipped on back faces: grass, plants and crowns set their own so both faces shade alike (with the flip half the grass came out black).
  - Pipelines depend on the target's format and sample count: `compileScene()` in `main.js` compiles for the scene pass's target.

## World and rendering

- **Files**: `world/` (terrain, terrainView, textures, trees, grass, undergrowth, water, props, `colliderStream.js`, `sky.js` + `atmosphere.js`, `environment.js`), `render/` (renderer and post, see "Renderer: WebGPU"), `render/quality.js`; splashes and dust in `effects.js`.
- **Map**: 1024 m, 0.5 m grid (`N = 2048`). Inside r < 140 m the original 400 m map (trail loop, proving ground, big hill), blending into the outer design by 200 m; an 8 km render-only vista (`terrain.far`); invisible walls at the edge.
- **Physics heights on the GPU**: level-0 terrain, grass, undergrowth and water read them from an R32F texture (layout `ix * NN + iz`, so load texel `(iz, ix)`) with Rapier's cell split; trees, rocks and the hut sit on `surfaceHeight`.
- **Trail ride**: `smoothTrailBeds()` low-passes the bed under the trail band (normalised over the driven bed only, so cut walls don't leak in), then adds rut and crown detail back; outer trails get a cut-only grade limit (`maxGrade`). Check with `trailprofile.mjs`, `junction.mjs`, `traillap.mjs` after terrain changes.
- **Light units**: the sun at noon is ~4 scene units, the moon ~0.2 (`sunE` / `moonE` in the `environment.js` keys). Night exposure adapts in a fixed range; a beam-lit road should be a bright mid tone, moonlit ground dim and blue. The lamp peaks and `LAMP_KNEE` were checked against this.
- **Grass**: one grid that thins with distance (header of `grass.js`); density, height and width are curves over distance (`evalCurve`, per level in `quality.js` `grassCurve`), tuned by eye by the player. Thin blades take the side facing the sun (`shared.uSun`, from the sun light) plus a hot spot with the sun behind the viewer. WebGPU: a compute pass runs one thread per instance the visible tiles draw (a table of the tiles, binary-searched) and appends the blades that exist and are in view to three buckets (4 / 2 / 1 segments by distance), one indirect draw each. WebGL 2: every tile is an instanced mesh and every instance runs the vertex stage, culled or not (~2.5 ms per million blade vertices on the M1 Pro). Both paths place the same blades: compare them with the wind stopped (`grass.shared.uWind.value.z = 0`). Undergrowth works the same way (`undergrowth.js`, one compute pass per kind).
- **Quality presets** (`quality.js`, applied live): every field has a `g`-prefixed setting (`presetToGfx` / `gfxToQuality`); changing one switches `quality` to `custom`. Grass and bushes is the `gVeg` row (off / low / medium / high / ultra, `vegOf`): picking a level makes quality Custom. Rough GPU cost is in the header of `quality.js`.
- **Auto quality** (`updateAutoQuality` in `graphics.js`, called from the rAF loop only, so `game.tick` tests don't trigger it): ladder low → ultra; start = the preset saved for this GPU + screen (`offroad.autoQuality.v1`, which then only steps down) or a guess from the GPU name. < 45 fps → one down; ≥ 57 → try one up, keep it only if it holds 50, else the ceiling stays below. A hidden pane doesn't measure; a throttled but visible one measures low.
- **Mobile preset** (Auto on phones and tablets, `isMobileDevice` incl. iPadOS): no AA, shadows, SSAO or grass; `updateDynamicResolution` (`graphics.js`) moves the pixel density in steps to hold 45–60 fps and only resizes buffers, never recompiles.
- **Sun shadow** (`render/shadows.js`): the world gets 2 soft cascades (three's CSMShadowNode; `SHADOWS` in `quality.js`) with a smooth 3×3 filter of hardware-compared taps (`smoothPCF`; three's 5-tap Vogel PCF is noisy when wide), width `soft` metres. The player's car is on `CAR_LAYER` (`SunShadows.setCar`): out of the world cascades, with its own sharp map that follows it, snapped to texels and sized by its bounding sphere; the shader multiplies it in only where the point projects (along the light) onto that sphere.
- **Trees**: near crowns cast their shadow from a lighter twin (`shadowCrown`: every other card, scaled up) on layer 1, which only shadow cameras render (the sun's and the head lamp's include it). Impostors are an InstancedBufferGeometry billboard.
- **AO** (`ssaoNode` in `post.js`): the WebGL game's SSAO ported to TSL, same look and strength (1 m / 8 samples, High 1.4 m / 16): half-res linear depth, normals from 4 neighbours, a spiral capped at 8 % of the screen height, a depth-aware 4×4 blur. Flat ground must read exactly 1.0. Under 1 ms at 2880×1620 on the M1 Pro. Rejected: three's GTAONode, 5–7 ms there (its taps read the full-res depth across the whole radius, and a metre near the camera is hundreds of pixels: cache misses; plus normals from 9 reads and a projection per tap). With MSAA, `post.js` copies sample 0 of the depth into a float target for AO and the sun shafts (WebGPU has no depth resolve).
- **Dust**: camera-facing quads sized in metres (`render/sprites.js`: WebGPU has no point sizes), so puffs look the same at any resolution, DPR and fov. Capped at `PUFF_CAP`; wheelspin adds little, so a car stuck spinning makes a haze, not a wall.
- **Load**: ~7 s to "Ready" on a warm Chrome shader cache, more on the first visit (~110 pipelines); `game.loadLog` has stage times.

## Time of day (`world/environment.js`)

- **One number**: the hour, 0..24. `env.setHour(h, { instant })` is the only entry point (`APPLY.time` in `main.js`): `instant` for the slider, buttons and startup, otherwise a sweep *forward* over `ANIM_TIME` (N key).
- **Key frames** (`KEYS`) with a periodic monotone cubic between them (no overshoot, so a key renders exactly its own values). Day / Dusk / Night are keys at `QUICK_HOURS`. To add a look, add a key.
- **Sun and moon follow arcs** (`SUN_ARC`, `MOON_ARC`); a key's `pin: [elev, azim]` puts the sun exactly where that preset had it.
- **Continuous, never a mode switch**: direct light = sun + moon, each fading with its own height; fog and sky colours = a sun part (kept until 14° below: twilight) + a moon part. A sun below the horizon dip keeps the horizon's last dim red transmittance, else it would jump to 0.
- **Exposure** `auto` 0..1 cross-fades fixed exposure and eye adaptation in log space; the luminance pass runs only while `auto > 0.001`. Blue-hour and pre-dawn keys run fully adaptive, else the frame dips to black between sun and moon.
- **`env.darkness`** (0..1) drives everything that fades; **`env.night`** is the same with hysteresis, for the automatic headlights (`env.onNightChange`).
- **Light probe**: three's `fromScene()` does the whole PMREM prefilter in one frame (a 35 ms hitch); `updateProbe` spreads it over ~15 frames using PMREMGenerator internals (three is pinned) and falls back to `fromScene` if they're missing; the finished probe is copied into one target (see Traps, the set of lights). `env.settle()` finishes it synchronously (tests, screenshots).
- **Testing**: `game.env.setHour(h, { instant: true })`, `game.env.settle()`, then tick; `game.setPaused(true)` and `game.redraw = 1e9` for a static scene.

## Sound

- **Engine start** (`STARTER_DEFAULTS` in `engine-worklet.js`, `audio.setStarterTune()` live): tuned by ear by the player, don't retune unasked. Rejected: broadband noise only ("a dog sniffing"), sine tones with crank wobble ("a toy ray gun"); narrow-band noise at the gear mesh works.
- Engine timbre has little energy at 200–600 Hz (a real V8 has harmonic bands there), so low-load rpm changes are heard mostly as loudness. Keep low-rpm lugging quieter than high-rpm WOT. Fixed-length noise clicks per exhaust pulse sounded like a ticking motorboat: pulses last a fixed crank angle.
- **Impact sounds: removed on purpose, don't add back unasked.** Rejected by ear: the old synthesised knock (a toy sound, fired on every landing), Freesound "S021 Metal Impact" and nine synthesised variants. If picked up again: real recordings picked by the player, trigger only on bump-stop entry, separate tyre-landing and body-contact sounds (body contacts need Rapier `CONTACT_FORCE_EVENTS`), muffled in the cockpit.
