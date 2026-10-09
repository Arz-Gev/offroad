import { ROAD_ENGINES } from '../vehicle/engines.js';

// Lancia Delta HF Integrale Evo 2 (1993): 2.0 16v turbo, 215 PS, 314 Nm; 1,340 kg, ~60 % on the front.
// Format: src/cars/README.md.
export default {
  id: 'lancia',
  label: 'Lancia Delta',
  suspensionV: 3,           // older saved setups (before the independent axles, v3) take the stock suspension

  physics: {
    name: 'Delta HF Integrale',
    engine: { preset: 'lancia', choices: ROAD_ENGINES },
    bodyMass: 1170, bodyInertia: [1450, 1900, 450], com: [0, 0.50, -0.22], aero: { cdA: 0.68 },
    wheelbase: 2.477, track: 1.401,
    archTop: 0.67,   // the lowest body over the tyres (tools/rigview.html measureArches)
    // character: a gravel rally car: light, very quick steering, grippy rally tyres, a rear bar that helps it
    // turn in. Soft, long travel and 6 cm higher than the road car (road springs and 17 cm of travel scraped
    // over the trail bumps above 60). The static ride uses half the travel (6 cm to the bump rubbers): that
    // keeps the low floor off the ground, stiffer springs (40000 / 28000, 9 cm) struck it over crests at 70+
    // (tools/traillap.mjs)
    raise: 0.06,
    // MacPherson struts all round, as the real car. The springs work at the wheel track, so they alone give
    // more roll stiffness than beam axles with bars: no front bar, a light rear one. Roll centres 0.12 / 0.16
    // (the gravel lift raises them too; lower ones rolled the outer wheels onto the bump rubbers in trail
    // corners). Bump damping 3000 / 2200 keeps the rubbers below 2 % of the trail lap; more travel instead
    // let the floor hit the crests
    axles: [
      { type: 'independent', linkage: 'strut', rcHeight: 0.12, camberGain: -0.5, steered: true, mass: 88,
        k: 30000, bump: 3000, rebound: 3700, arb: 0, travel: 0.22 },
      // Torsen rear: up to 70 : 30 across the axle (diffLock 0.4)
      { type: 'independent', linkage: 'strut', rcHeight: 0.16, camberGain: -0.4, mass: 82, diff: 'lsd', diffLock: 0.4,
        k: 22000, bump: 2200, rebound: 2700, arb: 2000, travel: 0.22 },
    ],
    tire: { size: 23.5, widthIn: 9.5, rimRadius: 0.203, inertia: 1.0, pressure: 22, grip: 1.12 },
    steer: { maxAngle: 0.56, ratio: 12, kingpinTrack: 1.27 },
    brakes: { front: 2000, rear: 1000, handbrake: 1600 },
    // looser converter: the small engine would stall in D at idle with the default 112
    auto: { ratios: [3.50, 2.20, 1.52, 1.13, 0.93, 0.78], reverse: 3.5, stallK: 165 },
    manual: { ratios: [3.50, 2.18, 1.52, 1.13, 0.93], reverse: 3.55 },
    transfer: { high: 1.0 },   // no low range, like the real car
    finalDrive: 3.11,
    // permanent 4WD, no driver's locks: an epicyclic centre diff splitting 47 : 53 front / rear (16v and later;
    // the 8v was 56 : 44) behind a Ferguson viscous coupling, an open front diff and the Torsen rear.
    // Viscous: ~150 Nm at 100 rpm of prop shaft slip (estimate)
    drive: { centreSplit: 0.47, centre: 'viscous', viscous: 1.5, lockers: false, rwd: [] },
    colliders: [
      ['Cabin', [0, 0.805, 0.50, 0.79, 0.505, 0.85, 0.06]],                    // sill 0.30 to roof 1.31, windscreen top to the hatch
      ['Bonnet and wings', [0, 0.59, -1.175, 0.80, 0.29, 0.825, 0.06]],        // 0.30 to bonnet 0.88, nose to windscreen
      ['Boot', [0, 0.62, 1.625, 0.80, 0.32, 0.275, 0.05]],                     // to the tail at 1.9
      ['Front bumper', [0, 0.45, -1.92, 0.70, 0.17, 0.10, 0.03]],             // 0.28-0.62, face at -2.02
      ['Rear bumper', [0, 0.44, 1.85, 0.72, 0.16, 0.10, 0.03]],               // 0.28-0.60
      ['Floor', [0, 0.24, 0, 0.55, 0.06, 1.6, 0.03]],                          // underside 0.18
    ],
    // boot floor (~0.55 m) behind the rear seats, and on the roof (top 1.31); from the collision boxes
    load: { cargo: [0, 0.62, 1.45], roof: [0, 1.42, 0.40] },
  },

  look: {
    url: 'models/lancia-delta.glb',
    author: 'TARANTULA',
    credit: 'Lancia Delta HF Integrale Evo 2 by TARANTULA, CC BY 4.0, https://sketchfab.com/3d-models/85614131e0dc4613a948472aaa935fc7',
    wheel: { R: 0.2965, width: 0.241 },
    chase: { dist: 5.6, target: 0.85 },   // 0.7 m shorter and 0.6 m lower than the Defender: the camera comes closer
    eye: [-0.38, 1.10, 0.15],
    hoodEye: [0, 1.02, -1.05],
    // beams: the head beam just ahead of the four headlamps (hub y 0.36, faces at z -1.89), the extra lamps' (J)
    // from the four driving lamps in the grille (hub y 0.40, faces at z -2.05; no roof bar). Lamp inserts glow
    // behind the clear glass, picked by mesh name: the driving lamps' were cut out of the LightBump mesh
    // (tools/cutparts.mjs, box [[-0.34, 0.34], [0.32, 0.48], [-2.06, -2.025]]); the rest of it is the headlamps
    // and fog lamps; the LightBump rear meshes are the tail and brake lamps (Bump001) and front indicators (Bump002)
    lamps: { head: [0, 0.64, -2.08], aux: [0, 0.68, -2.09], rear: [0, 0.75, 2.0],
      lenses: { head: '^Light_Glass_Bump_LightBump_0$', aux: '^driving_lamps', tail: 'Bump001_LightBump_rear',
        brake: 'Bump001_LightBump_rear', amber: 'Bump002_LightBump_rear' } },
    // the steering wheel was cut out of the cabin mesh (tools/cutparts.mjs, box [[-0.52, -0.12], [0.34, 0.68], [-0.63, -0.40]], model frame)
    cockpit: { steeringWheel: 'steering_wheel' },
  },

  tests: {
    t100: [4.9, 6.3],   // real Delta Evo 2: 0-100 in 5.7 s
  },
};
