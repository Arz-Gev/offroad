# Offroad

Three.js + Rapier off-road sandbox: a procedural Defender 110 (built from `reference.webp`), a G-Class and a Lancia Delta.

```
npm install
npm run dev        # http://localhost:5174
npm run simtest    # headless physics checks (settle, accel, brake, slope, climb, turn, manual)
```

See **DEVNOTES.md** for conventions, baselines, known traps, testing workflow and the backlog.

## Controls
**Esc** (gamepad **Menu**) pauses and opens the menu (to change the car, pick it in Settings and press **Apply & restart**): **Locations** (teleport), **Settings** (gearbox, camera, time of day, sound and volume, units, HUD options) and the full **Controls** list. **Friends** is multiplayer: Invite copies a link, and whoever opens it drives next to you (peer to peer, no server). The first start shows a short controls card. Settings are saved in the browser.

| Keyboard | Gamepad | Touch | Action |
|---|---|---|---|
| W / ↑ · S / ↓ | RT · LT | Gas · Brake pedals | Throttle · brake (automatic: hold brake at a stop to reverse) |
| A D / ← → | Left stick | Left thumb slides (or tilt) | Steer |
| Space | A | HB | Handbrake |
| Shift | LB | Clutch (shown when needed) | Clutch (manual with auto-clutch off) |
| E · Q | RB · X | ▲ · ▼ | Shift up · down (automatic: selector P R N D) |
| M | View |  | Automatic ⇄ manual |
| K |  |  | Auto-clutch on / off |
| T | D-pad ↓ | Vehicle → Range | Transfer case high / low (stop first) |
| X | D-pad ← | Vehicle → Centre diff | Centre diff lock |
| Z | D-pad → | Vehicle → Lockers | Axle lockers: rear → front + rear → off |
| [ · ] |  | Vehicle → Tyres − · + | Tyre pressure down · up |
| I | Left stick click | Vehicle → Engine | Start engine |
| O |  |  | Stop engine |
| L | D-pad ↑ | Vehicle → Lights | Headlights off / low / high |
| J |  |  | Roof light bar |
| G |  |  | Hazard lights |
| R | B | Recover | Recover (back on the wheels) |
| C | Y | Cam | Camera: chase, cockpit, hood, wheel, orbit |
| Mouse drag · wheel | Right stick | Drag the view · pinch | Look around · zoom |
| N |  |  | Time of day: day, dusk, night |
| P |  |  | Locations (teleport picker; 1–7 in the picker) |
| H |  |  | Controls list |
| V |  |  | Sound on / off |
| U |  |  | Suspension and tyre-load panel |
| F3 or ` |  |  | Telemetry |

Browser shortcuts (Cmd/Ctrl/Alt combinations, F5, F11, F12) are never captured.

**Phones and tablets**: on-screen controls appear as soon as you touch the screen (Menu → Settings → Touch screen: auto / on / off, thumb or tilt steering). Left thumb steers, right thumb works the pedals (analog: higher up the pedal is more), ▲ ▼ shift, the **Vehicle** button next to the menu holds range, diff locks, 2WD / 4WD, engine, lights, tyres and tuning. Drag the view to look around, pinch to zoom. Phones and tablets get the **Mobile** graphics preset: no anti-aliasing, shadows, ambient occlusion or grass, medium ground shading, and a pixel density that sets itself between 100 and 150 % to hold 45–60 fps. Best in landscape. The fullscreen button next to Menu (it pulses until you first use it) goes full screen on Android, tablets and desktop; on iPhone it explains Share → Add to Home Screen, which then starts full screen.

## What is simulated
- **Chassis**: Rapier rigid body. **Solid beam axles** (front + rear) with heave + roll DOF, own mass and inertia, coil springs, digressive dampers, bump stops, droop limits, anti-roll bars → real articulation and wheel hop.
- **Tyres**: 39-ray fan per wheel (3 rows across the tread) gives contact point/normal/deflection, so tyres climb steps and rocks. Radial spring/damper depends on pressure (6–38 psi); transient slip (relaxation length) + Pacejka-style combined slip; load sensitivity; surface types (dirt, grass, rock, mud, sand, wood, concrete). Tyre mesh squashes against the contact plane in the vertex shader (flat patch + sidewall bulge). Side-impact cylinders stop rocks passing through sidewalls.
- **Drivetrain**: 4.6 V8 torque curve, idle governor, stall + starter, rev limiter, engine-braking/pumping losses. Manual 5-speed with clutch (or auto-clutch) and rev-match/grind logic; 6-speed automatic with torque converter, lock-up and shift schedule. LT230-style transfer case (high/low), lockable centre diff, front/rear lockers, transmission handbrake on the rear prop, ABS. Solved as velocity constraints (PGS). Engine torque rock and axle wrap feed back into the chassis.
- **Audio**: procedural cross-plane V8 (AudioWorklet), gravel/skid/mud/wind, transfer whine, gear grind, bump-stop knocks.

## Map
1 km procedural terrain inside mountain ranges that run on to the horizon. The original core: trail loop + branch with ruts and a mud hole, a big hill, and a proving ground: A axle twister + whoops, B steps 15–45 cm + logs, C rock garden, D ramps 20°/30°/35°, E mud + off-camber. Around it: a 2.5 km outer trail loop past a lake, a stream with a ford, meadows with a ruined hut, an old quarry, a pine forest, and a spiral track up a lookout peak. P opens the location picker. Graphics quality (Auto/Low/Medium/High/Ultra) and resolution scale are in Settings.

## Credits
- Multiplayer: [Trystero](https://github.com/dmotz/trystero) (MIT).
- Mercedes-Benz G-Class 2021 model: [ItsDiyor on Sketchfab](https://sketchfab.com/3d-models/1768618c049b49fcb0d09a86d6f67c8d), CC BY 4.0. Wheels split off, compressed and re-framed for the game (`public/models/gclass2021.glb`).
- Lancia Delta HF Integrale Evo 2 model: [TARANTULA on Sketchfab](https://sketchfab.com/3d-models/85614131e0dc4613a948472aaa935fc7), CC BY 4.0. Same treatment (`public/models/lancia-delta.glb`).
