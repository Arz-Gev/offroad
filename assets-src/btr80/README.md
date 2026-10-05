# BTR-80 source model

Raw download, not shipped (outside `public/`). Prepare it into `public/models/` with `tools/prepcar.mjs` (generalised to 8 wheels) and gltf-transform.

- **Model**: "BTR 80" by Goga.Danelia, CC BY 4.0, https://sketchfab.com/3d-models/2980ab7cbc4d41b7893e3233e9dcc1ce (3ds Max + Substance Painter, 274k faces on Sketchfab, GLB 14.7 MB, 6 textures). Needs a credit in README and the car's `CARS` entry.
- **Why this one**: the owner asked for https://sketchfab.com/3d-models/e0b704b5953645ee89c00c03a7d63e4c (BTR-82A with a 30 mm turret, `wanted-btr82a-not-downloadable.jpg`), but it is not downloadable (the API returns 403). This was the best downloadable BTR-80/82 among ~100 searched: textured, separate tyres and rims, a turret hierarchy. Others were untextured, SketchUp-style merged exports, or rips from games (War Thunder, Squad, WARNO, Armored Warfare).
- **Frame**: units are about 1.19 × metres (length 9.08 vs the real 7.65 m; check against the real track 2.41 m and the 13.00-18 tyre). It faces **+z** (flip it). The wheel centres are slightly asymmetric left/right: measure each wheel.
- **Nodes** (`node` + gltf-transform inspect):
  - `Object004_BTR 80 Body Green_0`: the hull, 41k tris. **The suspension is inside this mesh**: per wheel an upper and a lower arm, a vertical shock absorber and a hub carrier (`underside.jpg`). Split it out by connected components, as `prepcar.mjs` does for the wheels.
  - `Diski0xx`: rims (6.9k tris each), with a child `Borbali0xx`: the tyre (21k tris each). 8 of each, so the tyre deforms and the rim doesn't.
  - `BTR_80_B_Baked002`: the turret (yaw), child `BTR_80_C_Baked002`: the gun cradle (pitch), child `LULA_Baked002`: the barrel (14.5 mm KPVT). `BTR_80_E_Baked002`: the coaxial PKT. `BTR_80_D_Baked002`: a hull part near the turret: check it.
  - Small parts: headlights, blinkers, IR illuminator, mirrors, vision block.
- `views.jpg`: side, 3/4, low and bottom renders from `tools/modelview.html`.
