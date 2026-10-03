# Offroad Defender

Three.js + Rapier off-road sandbox with a procedural Defender 110 (built from `reference.webp`).

```
npm install
npm run dev        # http://localhost:5174
npm run simtest    # headless physics checks (settle, accel, brake, slope, climb, turn, manual)
```

See **DEVNOTES.md** for conventions, baselines, known traps, testing workflow and the backlog.

## Controls
**Esc** (gamepad **Menu**) pauses and opens the menu: **Locations** (teleport), **Settings** (gearbox, camera, time of day, sound and volume, units, HUD options) and the full **Controls** list. **Friends** is multiplayer: Invite copies a link, and whoever opens it drives next to you (peer to peer, no server). The first start shows a short controls card. Settings are saved in the browser.

| Keyboard | Gamepad | Action |
|---|---|---|
| W / ↑ · S / ↓ | RT · LT | Throttle · brake (automatic: hold brake at a stop to reverse) |
| A D / ← → | Left stick | Steer |
| Space | A | Handbrake |
| Shift | LB | Clutch (manual with auto-clutch off) |
| E · Q | RB · X | Shift up · down (automatic: selector P R N D) |
| M | View | Automatic ⇄ manual |
| K | | Auto-clutch on / off |
| T | D-pad ↓ | Transfer case high / low (stop first) |
| X | D-pad ← | Centre diff lock |
| Z | D-pad → | Axle lockers: rear → front + rear → off |
| [ · ] | | Tyre pressure down · up |
| I | Left stick click | Start engine |
| O | | Stop engine |
| L | D-pad ↑ | Headlights off / low / high |
| J | | Roof light bar |
| G | | Hazard lights |
| R | B | Recover (back on the wheels) |
| C | Y | Camera: chase, cockpit, hood, wheel, orbit |
| Mouse drag · wheel | Right stick | Look around · zoom |
| N | | Time of day: day, dusk, night |
| P | | Locations (teleport picker; 1–7 in the picker) |
| H | | Controls list |
| V | | Sound on / off |
| U | | Suspension and tyre-load panel |
| F3 or ` | | Telemetry |

Browser shortcuts (Cmd/Ctrl/Alt combinations, F5, F11, F12) are never captured.

## What is simulated
- **Chassis**: Rapier rigid body. **Solid beam axles** (front + rear) with heave + roll DOF, own mass and inertia, coil springs, digressive dampers, bump stops, droop limits, anti-roll bars → real articulation and wheel hop.
- **Tyres**: 39-ray fan per wheel (3 rows across the tread) gives contact point/normal/deflection, so tyres climb steps and rocks. Radial spring/damper depends on pressure (6–38 psi); transient slip (relaxation length) + Pacejka-style combined slip; load sensitivity; surface types (dirt, grass, rock, mud, sand, wood, concrete). Tyre mesh squashes against the contact plane in the vertex shader (flat patch + sidewall bulge). Side-impact cylinders stop rocks passing through sidewalls.
- **Drivetrain**: 4.6 V8 torque curve, idle governor, stall + starter, rev limiter, engine-braking/pumping losses. Manual 5-speed with clutch (or auto-clutch) and rev-match/grind logic; 6-speed automatic with torque converter, lock-up and shift schedule. LT230-style transfer case (high/low), lockable centre diff, front/rear lockers, transmission handbrake on the rear prop, ABS. Solved as velocity constraints (PGS). Engine torque rock and axle wrap feed back into the chassis.
- **Audio**: procedural cross-plane V8 (AudioWorklet), gravel/skid/mud/wind, transfer whine, gear grind, bump-stop knocks.

## Map
1 km procedural terrain inside mountain ranges that run on to the horizon. The original core: trail loop + branch with ruts and a mud hole, a big hill, and a proving ground: A axle twister + whoops, B steps 15–45 cm + logs, C rock garden, D ramps 20°/30°/35°, E mud + off-camber. Around it: a 2.5 km outer trail loop past a lake, a stream with a ford, meadows with a ruined hut, an old quarry, a pine forest, and a spiral track up a lookout peak. P opens the location picker. Graphics quality (Auto/Low/Medium/High/Ultra) and resolution scale are in Settings.

## Credits
- Multiplayer: [Trystero](https://github.com/dmotz/trystero) (MIT).
- Mercedes-Benz G-Class 2021 model: [ItsDiyor on Sketchfab](https://sketchfab.com/3d-models/1768618c049b49fcb0d09a86d6f67c8d), CC BY 4.0. Wheels removed, compressed and re-framed for the game (`public/models/gclass2021.glb`).
