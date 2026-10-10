# BTR-80 source model

Not in the repo: download the GLB from the Sketchfab link below into a scratch dir. Prepare it into `public/models/` with `tools/prepcar.mjs` (generalised to 8 wheels) and gltf-transform.

- **Model**: "BTR 80" by Goga.Danelia, CC BY 4.0, https://sketchfab.com/3d-models/2980ab7cbc4d41b7893e3233e9dcc1ce (3ds Max + Substance Painter, 274k faces on Sketchfab, GLB 14.7 MB, 6 textures). Needs a credit in README and the car's `CARS` entry.
- **Why this one**: the owner asked for https://sketchfab.com/3d-models/e0b704b5953645ee89c00c03a7d63e4c (BTR-82A with a 30 mm turret), but it is not downloadable (the API returns 403). This was the best downloadable BTR-80/82 among ~100 searched: textured, separate tyres and rims, a turret hierarchy. Others were untextured, SketchUp-style merged exports, or rips from games (War Thunder, Squad, WARNO, Armored Warfare).
- **Frame**: units are about 1.19 × metres (length 9.08 vs the real 7.65 m; check against the real track 2.41 m and the 13.00-18 tyre). It faces **+z** (flip it). The wheel centres are slightly asymmetric left/right: measure each wheel.
- **Nodes** (`node` + gltf-transform inspect):
  - `Object004_BTR 80 Body Green_0`: the hull, 41k tris. **The suspension is inside this mesh**: per wheel an upper and a lower arm, a vertical shock absorber and a hub carrier. Split it out by connected components, as `prepcar.mjs` does for the wheels.
  - `Diski0xx`: rims (6.9k tris each), with a child `Borbali0xx`: the tyre (21k tris each). 8 of each, so the tyre deforms and the rim doesn't.
  - `BTR_80_B_Baked002`: the turret (yaw), child `BTR_80_C_Baked002`: the gun cradle (pitch), child `LULA_Baked002`: the barrel (14.5 mm KPVT). `BTR_80_E_Baked002`: the coaxial PKT. `BTR_80_D_Baked002`: a hull part near the turret: check it.
  - Small parts: headlights, blinkers, IR illuminator, mirrors, vision block.

## Preparing it (what made `public/models/btr80.glb`, 3.0 MB)

1. `node tools/prepcar.mjs btr80-source.glb /tmp/btr80-prep.glb "$(cat cfg.json)"` with the config below (deps: `@gltf-transform/core`, `extensions`, `functions`, `gl-matrix`, `meshoptimizer` in a scratch dir, see the tool's header). What it means:
   - `scale` 0.82: wheelbase 4.44 m (real 4.40), track 2.31 (real 2.41), tyre R 0.572 (real 0.56). A compromise: the model's proportions don't match the real vehicle exactly.
   - `wheels`: per wheel the x range and z centre (model frame after flip and scale) that pick its connected parts; `wheelHubs`: the measured hub centre of each wheel (the wheels are 5–6 cm off-centre in the source). Each wheel group goes into a holder node at its hub.
   - `tireMaterial`: the tyre (`BTR_80_Tire`, the `Borbali*` meshes) is split from the rim (`Diski*`) into `tire_<k>`, so the game deforms the tyre and not the rim.
   - `parts`: suspension pieces cut out of the hull mesh by bounding box per wheel (x range for the right side, mirrored for the left; y range; z offset from the wheel centre): lower and upper arms, torsion bars, shock eyes, rod and body. The game animates them (`src/vehicle/btrModel.js`).
2. `npx @gltf-transform/cli optimize /tmp/btr80-prep.glb /tmp/btr80-opt.glb --compress meshopt --texture-compress false --texture-size 1024 --simplify false --join false --flatten false --instance false --palette false`
3. `npx @gltf-transform/cli webp /tmp/btr80-opt.glb /tmp/btr80-webp.glb --quality 90 --slots "{baseColorTexture,metallicRoughnessTexture}"`, then `npx @gltf-transform/cli webp /tmp/btr80-webp.glb public/models/btr80.glb --lossless --slots normalTexture` (lossy WebP on the normal map gave blotchy shading).
4. Check it in `tools/rigview.html?car=btr80` (rig, tyre deformation, turret) and in the game.

```json
{"scale":0.82,"flip":true,"hubY":0.665,"R":0.697,"tireMaterial":"BTR_80_Tire",
"wheels":[[-1.74,-1.155,2.490],[-1.74,-1.155,0.861],[-1.74,-1.155,-1.284],[-1.74,-1.155,-2.914],[1.02,1.60,2.490],[1.02,1.60,0.861],[1.02,1.60,-1.284],[1.02,1.60,-2.914]],
"wheelHubs":[[-1.478,0.676,2.490],[-1.478,0.677,0.861],[-1.478,0.680,-1.284],[-1.478,0.682,-2.914],[1.345,0.649,2.490],[1.341,0.650,0.861],[1.341,0.652,-1.284],[1.345,0.655,-2.914]],
"parts":[
{"name":"barLow","x":[1.10,1.22],"y":[0.40,0.52],"dz":[-0.2,0.2]},
{"name":"barUp","x":[1.11,1.22],"y":[0.76,0.87],"dz":[-0.2,0.2]},
{"name":"shockEyeLo","x":[1.05,1.12],"y":[0.86,0.94],"dz":[-0.2,0.2]},
{"name":"shockRod","x":[1.05,1.12],"y":[0.91,1.32],"dz":[-0.2,0.2]},
{"name":"shockBody","x":[1.04,1.13],"y":[1.29,1.52],"dz":[-0.2,0.2]},
{"name":"shockEyeUp","x":[1.05,1.12],"y":[1.51,1.58],"dz":[-0.2,0.2]},
{"name":"armLow","x":[0.705,1.20],"y":[0.40,0.70],"dz":[-0.30,0.30]},
{"name":"armUp","x":[0.71,1.20],"y":[0.76,0.95],"dz":[-0.30,0.30]}]}
```
