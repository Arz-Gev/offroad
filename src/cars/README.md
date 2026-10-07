# Cars

One file per car: `src/cars/<id>.js` exports everything the game knows about that car. `index.js` lists
them in menu order (one import, one entry). Shared code never asks which car it is: a car differs from
another only by the data in its file. A behaviour that only some cars have (a viscous centre, independent
suspension, a turret) is a field here with a default that leaves the other cars unchanged.

Recipe for adding a car, with the checks: `.claude/skills/add-car/SKILL.md`.

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
