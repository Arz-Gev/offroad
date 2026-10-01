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

## Baselines (re-run `npm run simtest` after physics changes and compare)

| Check | Value |
|---|---|
| Static load sum | = weight (21 974 N); tyre squash ≈ 3 cm at 20 psi, 5–6 cm at 8 psi |
| 0–100 km/h (auto) | 8.7 s; shifts at ~4800 rpm WOT |
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
  - `timings` (ms per stage), plus `vehicle`, `rig`, `env`, `bloom`, …
- A hidden browser pane or background tab throttles `requestAnimationFrame`. FPS readings are then meaningless and screenshots are stale. Drive with `game.tick` and capture frames with `tools/shotserver.py` plus the `shot()` helper in `tools/browser-snippets.js`, which also has the lane and trail test drivers.
- Engine sound can be checked offline with an `OfflineAudioContext` and the worklet (level, NaNs, periodicity = rpm/120 for the uneven V8). Nobody has listened to it yet.

## Backlog / ideas

- **Unverified by ear**: engine sound character, levels of tyre/wind/whine.
- Water and fording (the snorkel is decorative for now); winch with a rope; recovery points.
- Tyre tracks: the map-wide 2048² texture is coarse (0.2 m/texel). A local high-res map or decals would look better. Mud sinkage / deformable mud would also help.
- The shadow uses the un-squashed tyre; it needs a custom depth material with the same deform code.
- Terrain: LOD and skirts for far chunks, less visible texture tiling, grass, more biomes. The map is 400 m and the user said it will grow.
- Gameplay: hill descent control, ABS on/off key, selectable engine (diesel), a damage model, force feedback, more gamepad mappings.
- The rock garden can wedge the chassis on boulders. That's fair, but watch for frustration.
- Rollovers at 60–70 km/h in corners are physically plausible (rollover threshold ≈ 0.7 g against dirt μ 0.72) but may feel harsh.
