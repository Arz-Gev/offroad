# Tasks

The player's open work list. Status: 🔄 in progress · ⏳ waiting for an answer · 📋 to do · ⏸ parked.
A finished task is deleted, not kept: the PR says what was done. Technical notes live in `DEVNOTES.md`.

## Waiting for an answer

| Task | Notes |
|---|---|
| ⏳ Tuning: the player's favourite setup | A setup the player likes in the Tab panel goes through Export into the car's file (`src/cars/<id>.js`) and becomes the stock. |

## To do

| Task | Size | Notes |
|---|---|---|
| 📋 More cars (picked by the player) | Small–medium each | Lada Niva, Jeep Wrangler (free), Jeep Wrangler 1997 (54 MB, needs slimming), HMMWV M998A1, Toyota GR Yaris Rally, classic G-Class W463 (Lexyc16, very low detail), a Land Cruiser (not the J200; e.g. the beige FJ40 "4x4 toyota Bj"). Recipe: `src/cars/README.md`. |
| 📋 Body bounces off when the roof or a side hits something | Medium | Rapier contacts on the body are too stiff / springy: zero restitution, softer contact. |
| 📋 PBR textures | Medium–large | Texture maps (normal, roughness, albedo) for the ground and the truck, as a Graphics option. |
| 📋 Suspension and wheel arches: model + animation | Large | Axles, springs and shocks are drawn and follow the physics, and they stretch with the lift and tyre size from the tuning panel; the wheel arches and the links are still the stock model. Ask the player what's still missing before starting. |
| 📋 Engine sound per engine | Medium | Every engine and every car uses the V8 sound; diesels need their own. |
| 📋 River is badly built | Medium | Later. Most of it floats in the air and is invisible from below: the water doesn't follow the terrain, the bed isn't carved. |
| 📋 WebGPU CPU cost: what's left | Small–medium | On the Windows PC (Ryzen 5 5600X + RTX 3070, 1440p Ultra, 180 Hz) WebGPU now matches WebGL in the open (~170 fps, WebGL 160–180) and is ~2.5x faster in forests (~110 vs ~43); see DEVNOTES → Renderer for the causes. Still CPU-bound there: trees (~1.8 ms; per-variant draws in every shadow pass), the car's single-use materials (an uber material would merge them), the 4 MB track texture upload every 0.25 s. Phones also seem slower (not measured). |
| 📋 Faster first load | Medium | ~110 render pipelines compile on the first visit. |
| 📋 Weather and life (asked with the WebGPU work) | Large | Rain (streaks and splashes, wet ground and puddles through the terrain's wetness uniforms, wet grip, mist, rain sound), birds, falling leaves, petals / pollen, fireflies, fake GI (canopy sky occlusion, ground bounce light), wind sheen on the grass, denser vegetation presets. Ship in small PRs. |

## Known gaps (not asked for yet)

- Tuning: tyres rubbing the arches are drawn, not simulated as a stop; tyre width doesn't change grip.
- Imported cars: cockpits have no working gauges.
- BTR-80: no 30 mm BTR-82A turret, no damage model, no swimming; the muzzle flash light casts no shadows.
- Multiplayer: friends' trucks have no engine sound and no headlight beams; friends on some mobile or work networks can't connect (needs a relay).
- Driving: the rock garden can wedge the chassis on boulders (fair, but watch for frustration); corner rollovers at 60–70 km/h are plausible (threshold ≈ 0.7 g vs dirt μ 0.72) but may feel harsh.
- World: no terrain or trees in water reflections, undergrowth casts no shadow, no ramp into the quarry, no hut interior, no snow on the near mountains.
- Ideas: water and fording (the snorkel is decorative), winch, recovery points, finer tyre tracks and deformable mud, hill descent control, damage model, force feedback.

## Parked

| Task | Notes |
|---|---|
| ⏸ Suspension / landing / body impact sounds | Removed: nothing tried sounded right. See `DEVNOTES.md` → Sound. |
| ⏸ Lake physics (driving into water) | Not a priority. |

## Decided by the player (don't redo unasked)

- Cloud shadows: tried, removed.
- The welcome card on first start: removed; only the short line at the bottom shows.
- The night road from the cockpit is bright enough.
- Impact sounds: see Parked.
