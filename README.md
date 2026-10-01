# Offroad Defender

Three.js + Rapier off-road sandbox with a procedural Defender 110 (built from `reference.webp`).

```
npm install
npm run dev        # http://localhost:5174
npm run simtest    # headless physics checks (settle, accel, brake, slope, climb, turn, manual)
```

## What is simulated
- **Chassis**: Rapier rigid body. **Solid beam axles** (front + rear) with heave + roll DOF, own mass and inertia, coil springs, digressive dampers, bump stops, droop limits, anti-roll bars → real articulation and wheel hop.
- **Tyres**: 39-ray fan per wheel (3 rows across the tread) gives contact point/normal/deflection, so tyres climb steps and rocks. Radial spring/damper depends on pressure (6–38 psi); transient slip (relaxation length) + Pacejka-style combined slip; load sensitivity; surface types (dirt, grass, rock, mud, sand, wood, concrete). Tyre mesh squashes against the contact plane in the vertex shader (flat patch + sidewall bulge). Side-impact cylinders stop rocks passing through sidewalls.
- **Drivetrain**: 4.6 V8 torque curve, idle governor, stall + starter, rev limiter, engine-braking/pumping losses. Manual 5-speed with clutch (or auto-clutch) and rev-match/grind logic; 6-speed automatic with torque converter, lock-up and shift schedule. LT230-style transfer case (high/low), lockable centre diff, front/rear lockers, transmission handbrake on the rear prop, ABS. Solved as velocity constraints (PGS). Engine torque rock and axle wrap feed back into the chassis.
- **Audio**: procedural cross-plane V8 (AudioWorklet), gravel/skid/mud/wind, transfer whine, gear grind, bump-stop knocks.

## Map
400 m procedural terrain: trail loop + branch with ruts and a mud hole, a big hill, mountains, trees, boulders, and a proving ground (P to teleport): A axle twister + whoops, B steps 15–45 cm + logs, C rock garden, D ramps 20°/30°/35°, E mud + off-camber.
