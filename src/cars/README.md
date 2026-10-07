# Cars

One file per car: `src/cars/<id>.js` exports everything the game knows about that car. `index.js` lists
them in menu order (one import, one entry). Shared code never asks which car it is: a car differs from
another only by the data in its file. A behaviour that only some cars have (a viscous centre, independent
suspension, a turret) is a field here with a default that leaves the other cars unchanged.

Adding a car: the recipe and the checks are at the end of this file.

The driver's controls aren't listed here: `src/vehicle/controls.js` works them out from the car (low range
from `transfer.low`, the centre lock from an open centre diff, lockers, a 2WD switch, extra lamps
(the J key) from `lamps.aux`, `lightBar` or `searchlights`, a turret), and the keys, pad, touch drawer, menu,
controls page and hints show only those. Give a car only what the real one has.

```js
export default {
  id: 'gclass',              // settings, saved setups, multiplayer
  label: 'G-Class',          // menu, HUD, credits
  saveKey: '...',            // optional: a localStorage key from before cars had their own (the Defender)
  physics: { ... },          // -> params P (src/vehicle/carParams.js)
  look: { ... },             // -> the model (src/vehicle/model/index.js)
  tests: { t100: [4.7, 6] }, // bands for npm run simtest (0-100 km/h, stock, automatic)
};
```

## physics

The vocabulary of the params P that the physics reads (`Vehicle.js`, `drivetrain.js`, `tire.js`), with
a few inputs that `carParams.js` turns into P. Anything not stated comes from `src/vehicle/defaults.js`
(tyre carcass, steering compliance, starter, clutch, torque converter, damper shape) or `AXLE_DEFAULTS`.

| Field | Meaning |
|---|---|
| `name` | full name (HUD) |
| `engine` | `{ preset, choices, ...overrides }`: stock engine and the tuning panel's choices from `src/vehicle/engines.js`; overrides for the starter and governor (`starterTorque`, `stallRpm`, ...) |
| `manualOnly` | no automatic: the "automatic" is the manual box shifting itself |
| `bodyMass`, `bodyInertia`, `com`, `aero.cdA` | sprung mass (kg), principal inertia about the COM [pitch, yaw, roll] (kg·m²), COM [x, y, z] (m, vehicle frame), drag area (m²) |
| `wheelbase`, `track` | m |
| `raise` | lifts the body over its computed ride height (m): ground clearance, not travel |
| `archTop` | the lowest body surface over the tyres (body frame): the tuning panel's arch room and the overlay's rub line. Measure it: `tools/rigview.html?car=<id>`, `measureArches()` |
| `axles[]` | front to back, see below |
| `tire` | `size`, `widthIn` (nominal inches: radius and width follow), `rimRadius` (m), `inertia` (kg·m², wheel + tyre + hub + half shaft), `pressure` (psi, stock), optional `grip`, `minPressure`, `maxPressure`, `kScale` (radial stiffness x), `fnRef` (nominal load), `hubDrag`, `hubDragV` |
| `steer` | `maxAngle` (rad), `ratio`, `kingpinTrack`; optional `centreZ` (turning centre for several steered axles), `rate`, compliance |
| `brakes` | max torque per wheel: `front`, `rear`, `handbrake`; optional `handbrakeHold` |
| `manual`, `auto` | `{ ratios, reverse }`; `auto.stallK` for a small engine |
| `transfer`, `finalDrive` | `{ high, low }`, axle ratio |
| `clutch` | optional `{ capacity, inputInertia }` |
| `drive` | drive layout, see below |
| `colliders` | `[name, [cx, cy, cz, hx, hy, hz, rounding]]`, body frame at static ride (ground y 0); `colliderFrame: 'hub'` measures y from the static hub height |
| `load` | `{ cargo, roof }`: where the tuning panel's cargo and roof load sit (body frame) |
| `turret` | optional: turret drives and weapons (`turret.js`, `weapons.js`) |

**Axles** (`axles[i]`): `type` `'beam'` (solid axle: heave + roll) or `'independent'` (one DOF per
wheel, kinematic curves `rcHeight` (roll centre height, m) and `camberGain` (rad of camber per m of
bump)); `linkage` of an independent axle: `'wishbones'` (default) or `'strut'` (MacPherson; it also picks
the running gear drawn for a model without its own); `z` (only needed with more than two axles); `mass`
(unsprung, kg); `k` (spring, N/m at the spring), `travel` (m, full droop to the hard stop; the bump rubber
starts 5 cm before it), `bump`, `rebound` (damper N·s/m), `arb` (anti-roll bar), `springTrack`,
`damperTrack` (beam: where the springs and dampers sit; independent: the wheel track by default),
`rollInertia` (beam), `rollSteer` (beam), `steered`, `driven` (default true), `group` (which output of
the centre diff), `diff` (`'open'` default, `'lsd'` with `diffLock`), `stopScale` (bump stops of a heavy
vehicle), `droopY` (only to override the computed ride height).

**Drive** (`drive`, `vehicle/drivetrain.js` `driveLayout`): `layout`:
- `'awd'` (default): permanent all-wheel drive through a centre diff: `centre` `'open'` (the driver can
  lock it) or `'viscous'` (with `viscous`, Nm per rpm of prop shaft slip); `centreSplit` (group 0's share
  of the drive torque, 0.5 default); `rwd` (the axles a 2WD switch keeps; `[]` = no switch);
- `'parttime'`: selectable 4WD without a centre diff (starts in 2WD, the front turns with the rear in 4WD);
- `'rwd'` / `'fwd'`: rear- / front-wheel drive (the rear / front half of the axles).

Also `lockers` (false: no axle lockers on the open axle diffs), `handbrake` (axles the handbrake holds),
an axle's own `driven` and `group` (which output of the centre diff), `diff` (`'open'`, `'lsd'` with
`diffLock`: the share of the axle's torque its friction can move across, Torsen 70 : 30 = 0.4). A car
without low range leaves out `transfer.low`.

## look

What the model is made of (`src/vehicle/model/index.js` builds it; every part is chosen by these fields
and by the axle types, nothing by the car's name). Positions are in the body frame unless said.

| Field | Meaning |
|---|---|
| `body` | `'defender'`: the procedural Defender (`model/defender/`); else `url`: a GLB prepared by `tools/prepcar.mjs` (`public/models/`), with `author` and `credit` (menu credits, CC BY) |
| `wheel` | the model's own wheels: `{ R, width }` (its tyre, measured by prepcar), `rim` (radius that stays round, default the physics rim), `hubSpins` (hub_<k> is on the rim and spins, not a caliper). A body without wheels gets our steel wheels |
| `suspension` | the model's own double wishbones: `{ parts: 'wishbones', pivotLow, pivotUp }` (prepcar `parts` per corner, the arms' inner pivots in the hub frame). Independent corners without parts are drawn by us (`model/independent.js`, by the axle's `linkage`); beam axles are always ours (`model/beamAxle.js`) |
| `eye`, `hoodEye`, `chase` | cameras: the driver's eye, the hood camera, `{ dist, target }` of the chase camera |
| `lamps` | beam positions `{ head, aux, rear }` (a procedural body knows its own; `aux`, the extra lamps on the J key, is optional: one point or a list) and `lenses`: role -> a pattern matched against the material and mesh names (`head`, `side`, `aux`, `work`, `tail`, `brake`, `reverse`, `amber`, `beacon`). A mesh name pattern picks a lamp out of a shared material (cut it out first with `tools/cutparts.mjs` if it is one mesh with others) |
| `lightBar` | optional, only for a car that really carries one: a roof light bar (`model/accessories.js`): `{ at, width, lamps, roof }`; it carries an aux beam |
| `searchlights` | optional: round lamps whose model has the cover shut, drawn open with a clear lens (`model/accessories.js` `searchlight`): `[{ at (the face centre, hub frame), r (lens), rim, turret (rides the gun cradle), cone }]`; each carries a narrow aux beam. A car with no aux beam at all (no `lamps.aux`, `lightBar` or `searchlights`) has no extra lamps: the J key and the menu switch hide |
| `cockpit` | node names of the cabin's moving parts: `steeringWheel`, `gearLever`, `transferLever` (cut out with `tools/cutparts.mjs`); a node turns about its own thin axis |
| `turret` | a turret of the model's nodes (`model/turretRig.js`): `yaw`, `pitch`, `recoil`, `ring`, `trunnion`, `muzzles`, `sight` (hub frame) |
| `runningGear` | options of the beam axle kit: `transferCase` (where the prop shafts start) |

Variants (other axle types, another drive layout) without a new file: `carParams.paramsFromDef(def)` and
`model.buildModel(def)` take a definition; `tools/rigview.html?car=<id>&patch={json}` shows one, and
`npm run simtest suspension` / `layouts` drive some.

## Adding a car

**No code for one car.** Shared code (`src/` outside the car files) never checks which car it is: no
`if (car === 'x')`, `P.car === ...`, and no `nA === 2` standing in for "the Defender". A behaviour the shared
code doesn't have yet (a diff, a suspension, a gearbox) becomes a data field with a default that leaves the
other cars unchanged, like `drive.layout`, `drive.centre: 'viscous'`, `axles[i].type`, `manualOnly`,
`look.turret`. Prove it: `npm run simtest` output for the other cars is identical before and after (diff
it). Describe the new field here and in DEVNOTES.md.

Where a car's data lives besides its file: the list and menu order in `index.js`; the engine in
`src/vehicle/engines.js` (`ENGINES.<preset>`, a catalogue: one engine can sit in several cars); the model in
`public/models/<id>.glb`; credits in the root `README.md`; notes and numbers in DEVNOTES.md ("Cars").
Anything a car doesn't set comes from `src/vehicle/defaults.js`: ordinary parts, not another car's.
Start the file from the closest car of the same kind.

### 1. Real data

Manufacturer pages, press releases, magazine tests, Wikipedia, carfolio, cars-data. Comment every number
with its source or "estimate". A made-up car says so.

- **Masses**: `bodyMass` is sprung (kerb minus unsprung); an axle's `mass` is unsprung (axle or arms,
  wheels, brakes). An off-roader's beam axle is 150–210 kg, a car's independent axle 80–90 kg.
- **COM** `[0, height, z]`: z = −(front axle share − 0.5) × wheelbase (negative = towards the front).
  Height like the neighbours: off-roader 0.85–0.9 m, hatchback about 0.5 m.
- **Inertia** `[pitch, yaw, roll]`: m·(L²+H²)/12, m·(L²+W²)/12, m·(W²+H²)/12 from the body's size, then
  compare with the other cars by mass and size.
- **Tyres**: `size` and `widthIn` in nominal inches from the size (265/70 R17 ≈ 31.6 × 10.4), `rimRadius`
  in m, `pressure` in psi, `grip` above 1 only for sports tyres. The radius is `0.42 × inches / 33`.
- **Engine**: a new `ENGINES` entry with `gross([[rpm, Nm], ...])` from the published curve or the peaks,
  `idleRpm`, `limiterRpm`, `redlineRpm`, `shiftRpm`, `inertia`, and where the numbers come from in `note`.
  Tuning choices in `engine.choices` (usually `ROAD_ENGINES`).
- **Gearbox**: `manual`, `auto`, `finalDrive`, `transfer`. No low range on the real car: no `low`. A small
  engine with an automatic may need a higher `auto.stallK` or it stalls in D at idle (Lancia: 165).
- **Drive**: `layout` (`'parttime'` for Jimny, Hilux, Wrangler), `centreSplit` (G 500 0.4, Integrale
  0.47), `rwd: []` for a permanent 4x4 without 2WD (most of them; the Defender's 2WD is a game extra),
  `lockers: false` without lockers, a Torsen axle `diff: 'lsd'` with `diffLock` 0.4.
- **Steering**: `maxAngle` from the turning circle, `ratio`, `kingpinTrack`. **Brakes**: like neighbours
  of similar mass.

### 2. Suspension

Each axle's `type` as on the real car. Independent: `rcHeight` 0.05–0.15 m for wishbones, 0.05–0.10 for a
strut; `camberGain` −0.2…−0.6; `k` is at the wheel, no `springTrack`; its springs give more roll stiffness
(wider track), so retune the bars with `suspcheck`. `npm run simtest suspension` checks the types work.

- `travel`: full droop to the hard stop; the bump rubber starts 5 cm before it.
- Springs `k`: static sag about 35–45 % of travel and 9–10 cm to the bump rubber
  (`node tools/suspcheck.mjs <id>`). A low car can go softer if stiffer springs make the floor hit
  crests (the Lancia stays at 51 %): decide by `traillap`, not the percentage.
- Ride height is computed (`droopY` puts the ground at y 0 at static ride); `raise` lifts body and model
  (clearance, not travel).
- Dampers `bump`, `rebound`: scale from a neighbour by √(k·m).
- Anti-roll bars: the front share of roll stiffness a bit above the front weight share (mild understeer;
  `suspcheck` prints both). Don't fix understeer with rear roll stiffness (DEVNOTES).

### 3. Model

1. **Pick**: wheels separate or separable, up to ~400k triangles, PBR textures, an interior, an open
   licence (CC BY goes in the credits). Not SketchUp exports with merged parts, untextured models or game
   rips. Note rejected models in DEVNOTES so nobody downloads them again.
2. **Download** with the Sketchfab API: `GET https://api.sketchfab.com/v3/models/<uid>/download` returns a
   signed GLB link (header `Authorization: Token <key>`; locally the key is in `~/keys/sketchfab_api_key`).
   Keep the download in a scratch dir outside the repo: it can always be downloaded again.
3. **Inspect**: `npx @gltf-transform/cli inspect car.glb`: units (metres?), which way is forward (the
   headlights), materials, LINES primitives.
4. **Prepare**: `node tools/prepcar.mjs in.glb out.glb '{json}'` (deps in a scratch dir, see its header).
   It bakes the frame, splits the wheels (`wheel_*`, `hub_*`, `tire_*` with `tireMaterial`) and prints the
   body outline per 10 cm for the colliders.
5. **Cabin parts and lamps** merged into other meshes: cut them out with `node tools/cutparts.mjs`
   (`LIST='[x,y,z,r]'` lists the pieces near a point). The steering wheel is the 0.3–0.4 m piece in front of
   the driver's eyes, not the column; in `tools/rigview.html?car=<id>` it turns clockwise steering right.
6. **Compression**: none up to 400k triangles: what prepcar and cutparts made goes to `public/models/`.
   Above that, as in `assets-src/btr80/README.md`: optimize with `--join false --flatten false` (or the
   wheels merge back into the body); base textures as lossy WebP, the normal map lossless (lossy gives
   blotchy shading).
7. **`assets-src/<id>/README.md`**, the only file there: source link, author, licence, scale, the
   prepcar and cutparts arguments, the commands.
8. **Arches**: `archTop` from `measureArches()` in `tools/rigview.html?car=<id>`.

Colliders come from the prepcar outline (body frame at static ride: ground y 0, mid-wheelbase z 0, −z
forward). `tests.t100` is a band around the real 0–100; a heavy vehicle needs its own simtest scenario
(like `btr`).

### 4. Checks (all of them; put the numbers in the report)

Tools with `CAR=` use the stock setup.

| Command | Done when |
|---|---|
| `npm run simtest` | 0 FAIL; the other cars' numbers identical to the run before the change |
| `npm run simtest cars` | ride height error under 1.5 cm, 0–100 inside `tests.t100` |
| `node tools/suspcheck.mjs <id>` | sag and room as in step 2, front roll share a bit above front weight share |
| `node tools/difftest.mjs <id>` | `split` = `centreSplit` ±2 %; with TC it pulls away with one axle on ice |
| `CAR=<id> node tools/traillap.mjs 60`, `70`, `85` | `rollovers 0`, `near bump stop` about 1.5 % or less, no `spike ... body contacts` lines (the body hitting the ground) |
| `CAR=<id> node tools/handling.mjs` | no rollover or wheel lift on the circle, a believable lateral g |
| `CAR=<id> node tools/yawtest.mjs` | after lifting off at 90 km/h the slip angle (`beta`) doesn't grow |
| `npx vite build` | builds |
| `tools/rigview.html?car=<id>` | suspension from below at bump and droop, steering wheel, no wheels sinking into the body |
| the game | no console errors; screenshots side, 3/4, cabin by day and night, underside, headlights at night, on a trail: send them to the owner, don't commit them |

To open the game on the car, set `localStorage` `offroad.settings.v1` = `{"car":"<id>"}` before loading.
Tab → Show physics shows the boxes, suspension travel and tyre patches.

Then a line in DEVNOTES.md ("Cars"): sources, the model's measurements (tyre radius, wheelbase, track),
the numbers from the checks, what differs from the real car and why, and anything found and not fixed.

Known limits: beam axles and drawn independent corners are our generic parts (the car's track, travel and
height, not its own arms); only double wishbones can use the model's own arms (`look.suspension`, the
BTR). Interiors of downloaded models are dark.
