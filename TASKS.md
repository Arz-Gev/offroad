# Tasks

Player feedback and the work list. Status: ✅ done · 🔄 in progress · ⏳ waiting for an answer · 📋 to do · ⏸ parked.
Technical notes live in `DEVNOTES.md`.

## Done

| Task | Notes |
|---|---|
| ✅ Seats looked reversed | Seat backs leaned forward; tilt sign fixed (front seats and rear bench). |
| ✅ ABS on / off | Key **B**; HUD shows "ABS OFF". |
| ✅ Truck creeps / accelerates with the handbrake on | At a stop the handbrake now also holds the transfer output, so the front can't pull through an open centre diff. Holds at full throttle, also on a 20° slope. |
| ✅ Handbrake modes | Menu → Settings → Driving: **Hold**, **Toggle**, **Auto** (short tap toggles, long press holds). |
| ✅ Rear-wheel-drive mode | Key **F**: 2WD ⇄ 4WD, HIGH range only, below 30 km/h. |
| ✅ Wide graphics settings | Menu → **Graphics** tab: preset, resolution, pixel density cap, shadows, SSAO, anti-aliasing, bloom, terrain distance and shading, distant tree shadows. Changing any option switches the preset to Custom. The full-detail tree distance is no longer a setting: 40 m on Low and Medium, 50 m on High, Ultra and Custom. |
| ✅ Grass and bushes: taller, denser, much further | Own section in Graphics with exact-value sliders (density, height, blade width, distance, dense-layer radius, far-layer width and spacing; bush density, size, distance) and an on / off switch that also hides the sliders. The four presets use the player's hand-tuned values; slider ranges are ±20 % around the presets. Density now sets the cell spacing, so a low density is really cheaper. Ultra's grass and bushes cost about 20 ms. |
| ✅ SSAO | Graphics → Ambient occlusion: Off / Low / High. On by default on High (Low) and Ultra (High) presets. |
| ✅ Fullscreen switch in Graphics, Welcome card button removed | |
| ✅ SSAO pattern on some displays | Banding / dot grid on flat ground on the Mac and in 1440p fullscreen. Fixed in the AO depth reconstruction; confirmed gone by the player. |
| ✅ Glass shader | Windows were grey and almost opaque. Now one face per pane (it was dimming the view twice), Fresnel alpha, a lighter tint; every pane is as clear as the front door glass. |
| ✅ Gap between rim and tyre | The rim face was smaller than the barrel and the barrel was one-sided, so you could see through a ring around the face. |
| ✅ Pixel density cap hidden where it does nothing | Shown only on screens with a device pixel ratio above 1. |
| ✅ Cloud shadows | Tried, then removed at the player's request. |
| ✅ Night road too dark from the cockpit | Checked by the player: fine. |
| ✅ Time-of-day slider | Menu → Settings → Time of day: a slider (HH:MM, 5-minute steps) that the picture follows at once, plus Day / Dusk / Night buttons (13:00, 19:30, 23:00, which look exactly as the old presets). The sun and moon travel on arcs, dawn and dusk are continuous, exposure and lamps have no jumps. **N** still jumps day → dusk → night with a 2.5 s sweep. Headlights come on once when it gets dark. Old saved settings (`night`, ...) are migrated. |

## Next (waiting for answers)

| Task | Difficulty | Notes |
|---|---|---|
| ⏳ Truck too fast and powerful | Easy | Now 0–100 km/h in 8.7 s. Pick the engine: Td5 diesel (~15 s), V8 (~10–11 s), or keep as is. |
| ⏳ Bigger wheels, higher suspension | Medium | Tyre size? 33" or 35". Wheel arches, colliders and balance need adjusting too. |

## To do

| Task | Difficulty | Notes |
|---|---|---|
| 📋 Can't climb steep slopes although nothing touches the wheel | Medium | Probably the chassis rails and the front bumper/winch colliders sit lower and further forward than the visible model: an invisible nose hits the slope first. |
| 📋 Body bounces off when the roof or side hits something | Medium | Rapier contacts on the body are too stiff / springy: zero restitution, softer contact. |
| 📋 PBR textures | Medium–large | Materials are already PBR; this means texture maps (normal, roughness, albedo) for the ground and the truck. Will be a Graphics option. |
| 📋 Suspension, shocks and wheel arches: model + animation | Large | Axles, links and shocks that follow the physics. Best as a separate agent together with the bigger wheels. |
| 📋 Vehicle tuning settings | Large | Tyre pressure, springs, dampers, travel, gear ratios, power. Some need rebuilding the physics body live. |
| 📋 River is badly built | Medium | Must be fixed, but later. Most of its length floats in the air, and from below it isn't even visible: the water surface doesn't follow the terrain / the riverbed isn't carved into it. |
| 📋 Phones and tablets | Large | Touch controls, a mobile performance preset, HUD layout. Last. |

## Parked

| Task | Notes |
|---|---|
| ⏸ Lake physics (driving into water) | Not a priority. |
| ⏸ Short hitch on the first switch to night | Not a priority. |
