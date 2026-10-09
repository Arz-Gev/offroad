# Tasks

The player's open work list. Status: 🔄 in progress · ⏳ waiting for an answer · 📋 to do · ⏸ parked.
A finished task is deleted, not kept: the PR says what was done. Technical notes live in `DEVNOTES.md`.

## Waiting for an answer

| Task | Notes |
|---|---|
| ⏳ Tuning: the player's favourite setup | A setup the player likes in the Tab panel goes through Export into `DEFAULT_SETUP` in `src/vehicle/tuning.js` and becomes the stock. |

## To do

| Task | Size | Notes |
|---|---|---|
| 📋 More cars (picked Oct 4) | Small–medium each | Lada Niva, Jeep Wrangler (free), Jeep Wrangler 1997 (54 MB, needs slimming), HMMWV M998A1, Toyota GR Yaris Rally, classic G-Class W463 (Lexyc16, very low detail), a Land Cruiser (not the J200; e.g. the beige FJ40 "4x4 toyota Bj"). Recipe: `src/cars/README.md`. |
| 📋 Body bounces off when the roof or a side hits something | Medium | Rapier contacts on the body are too stiff / springy: zero restitution, softer contact. |
| 📋 PBR textures | Medium–large | Texture maps (normal, roughness, albedo) for the ground and the truck, as a Graphics option. |
| 📋 Defender suspension and wheel arches: model + animation | Large | Axles, links and shocks that follow the physics (the G-Class, Lancia and BTR already have moving arms). |
| 📋 Engine sound per engine | Medium | Every engine and every car uses the V8 sound; diesels need their own. |
| 📋 River is badly built | Medium | Later. Most of it floats in the air and is invisible from below: the water doesn't follow the terrain, the bed isn't carved. |

## Known gaps (not asked for yet)

- Tuning: tyres rubbing the arches are drawn, not simulated as a stop; tyre width doesn't change grip.
- Imported cars: cockpits have no working gauges.
- BTR-80: no 30 mm BTR-82A turret, no damage model, no swimming; the muzzle flash light casts no shadows.
- Multiplayer: friends' trucks have no engine sound and no headlight beams; friends on some mobile or work networks can't connect (needs a relay).
- World: no terrain or trees in water reflections, undergrowth casts no shadow, no ramp into the quarry, no hut interior, no snow on the near mountains.
- Ideas: water and fording (the snorkel is decorative), winch, recovery points, finer tyre tracks and deformable mud, the tyre shadow squashing with the tyre, terrain LOD, hill descent control, damage model, force feedback.

## Parked

| Task | Notes |
|---|---|
| ⏸ Suspension / landing / body impact sounds | Removed: nothing tried sounded right. See `DEVNOTES.md` → Sound. |
| ⏸ Lake physics (driving into water) | Not a priority. |
| ⏸ Short hitch on the first switch to night | Not a priority. |
