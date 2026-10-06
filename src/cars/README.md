# Cars

One file per car: `src/cars/<id>.js` exports everything the game knows about that car. `index.js` lists
them in menu order (one import, one entry). Shared code never asks which car it is: a car differs from
another only by the data in its file. A behaviour that only some cars have (a viscous centre, independent
suspension, a turret) is a field here with a default that leaves the other cars unchanged.

Recipe for adding a car, with the checks: `.claude/skills/add-car/SKILL.md`.

```js
export default {
  id: 'gclass',              // settings, saved setups, multiplayer
  label: 'G-Class',          // menu, HUD, credits
  saveKey: '...',            // optional: a localStorage key from before cars had their own (the Defender)
  physics: { ... },          // -> params P (src/vehicle/carParams.js)
  look: { ... },             // -> the model (src/vehicle/cars.js)
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
wheel, kinematic curves `rcHeight`, `camberGain`); `z` (only needed with more than two axles); `mass`
(unsprung, kg); `k` (spring, N/m at the spring), `travel` (m, full droop to the hard stop; the bump rubber
starts 5 cm before it), `bump`, `rebound` (damper N·s/m), `arb` (anti-roll bar), `springTrack`,
`damperTrack` (beam: where the springs and dampers sit; independent: the wheel track by default),
`rollInertia` (beam), `rollSteer` (beam), `steered`, `driven` (default true), `group` (which output of
the centre diff), `diff` (`'open'` default, `'lsd'` with `diffLock`), `stopScale` (bump stops of a heavy
vehicle), `droopY` (only to override the computed ride height).

**Drive** (`drive`, `vehicle/drivetrain.js` `driveLayout`): `centreSplit` (group 0's share of the drive
torque, 0.5 default), `centre` (`'open'` lockable, or `'viscous'` with `viscous` Nm per rpm of prop shaft
slip), `lockers` (false: no axle lockers), `rwd` (axles still driven in 2WD; `[]` = no 2WD switch),
`handbrake` (axles the handbrake holds).

## look

Now the fields of the model builder (`src/vehicle/cars.js`): `body: 'defender'` (the procedural Defender)
or `url` (a prepared GLB in `public/models/`), `author`, `credit`, `wheel: { R, width }` (the model's own
tyre), `eye` (driver's eye), `hoodEye`, `chase: { dist, target }`, `lamps: { head, bar, rear }` (beam
positions), `build` (a model with its own builder).
