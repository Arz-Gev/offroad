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
| ✅ Wide graphics settings | Menu → **Graphics** tab: preset, resolution, pixel density cap, shadows, SSAO, anti-aliasing, bloom, terrain distance and shading, tree detail distance, distant tree shadows, grass density and distance, bushes. Changing any option switches the preset to Custom. |
| ✅ SSAO | Graphics → Ambient occlusion: Off / Low / High. On by default on High (Low) and Ultra (High) presets. |
| ✅ Fullscreen switch in Graphics, Welcome card button removed | |
| ✅ SSAO pattern on some displays | Banding / dot grid on flat ground on the Mac and in 1440p fullscreen. Fixed in the AO depth reconstruction; confirmed gone by the player. |
| ✅ Cloud shadows | Tried, then removed at the player's request. |
| ✅ Night road too dark from the cockpit | Checked by the player: fine. |

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
| 📋 Time-of-day slider | Medium | Instead of the three presets: blend lamps, fog and exposure smoothly. |
| 📋 Glass shader | Medium | Windows look almost opaque grey and flat. Needs Fresnel and cleaner transparency. |
| 📋 PBR textures | Medium–large | Materials are already PBR; this means texture maps (normal, roughness, albedo) for the ground and the truck. Will be a Graphics option. |
| 📋 Suspension, shocks and wheel arches: model + animation | Large | Axles, links and shocks that follow the physics. Best as a separate agent together with the bigger wheels. |
| 📋 Vehicle tuning settings | Large | Tyre pressure, springs, dampers, travel, gear ratios, power. Some need rebuilding the physics body live. |
| 📋 Phones and tablets | Large | Touch controls, a mobile performance preset, HUD layout. Last. |

## Parked

| Task | Notes |
|---|---|
| ⏸ Lake physics (driving into water) | Not a priority. |
| ⏸ Short hitch on the first switch to night | Not a priority. |
