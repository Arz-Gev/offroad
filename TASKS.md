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
| ✅ At speed the truck spins out after a small steer, and keeps turning when you lift off | Caused by the Oct 2 fix for "doesn't turn at speed": the anti-roll bars were moved to the rear (8000 / 8500), which with the rear-heavy weight made the truck nearly neutral. Fixed with physics, not a stability aid: the tyre model now loses grip with load like a real tyre, weight 51 % front, bars back to 11000 / 4000, steering compliance and rear axle roll steer. Now ~1.9°/g understeer; lifting off at the limit only tucks the nose in a little. If you saved a setup in the Tab panel with the old bars, they are reset to the new stock. |
| ✅ Keyboard steering assist setting | Menu → Settings → Driving: **Strong** (held key ≈ the angle the truck can corner at: 7° at 90 km/h), **Light** (like the gamepad stick: 23° at 90 km/h), **Off** (full lock 35.5° at any speed). Short taps always give small angles (the key ramps in over 0.5 s). |
| ✅ In-game vehicle tuning (was four tasks: too fast and powerful, bigger wheels and higher suspension, can't climb steep slopes, tuning settings) | **Tab** opens a panel over the running game (no pause; the mouse works the panel, the keys still drive). Engine: 4.6 V8 (stock), 5.0 Works V8, 3.5 V8, 300Tdi, Td5, 2.4 TDCi, plus torque and rev limiter. Gearbox ratios, final drive, transfer high / low, driveline switches. Tyres 31–37″, width, pressure front / rear, grip. Lift 0–15 cm, springs, bump / rebound, anti-roll bars, bump travel per axle. Brakes (force, front share, handbrake). Cargo, roof load, centre of mass height. Steering lock and ratio. Readouts show consequences: power, 0–100 estimate, top speed, km/h per gear, ride frequency and damping (softer / stiffer than stock), clearance, approach / departure / breakover, room in the arches, axle loads, rollover limit, which axle locks first, turning circle. **Measure 0–100** runs the real physics on a flat pad (stock V8 8.7 s, Td5 17.5 s, 5.0 V8 5.5 s, 300Tdi 21.4 s, auto). Stock button, per-section reset, saved setups, Export / Import JSON. **Show physics** draws the collision boxes (red where they touch), wheel cylinders, tyres against the arches, suspension travel and contact patches; a box editor moves and resizes them live. The steep-slope problem was the invisible nose: the front bumper box sat 10 cm lower and 11 cm further forward than the visible bumper. Colliders now fit the model: approach 32° → 43°, the truck climbs 40–42° ramps it used to stop at. |

## Next (waiting for answers)

| Task | Difficulty | Notes |
|---|---|---|
| ⏳ Tuning: the player's favourite setup | Easy | Try engines, tyres and lift in the Tab panel. A setup you like goes through Export into `DEFAULT_SETUP` in `src/vehicle/tuning.js` and becomes the truck's stock. |

## To do

| Task | Difficulty | Notes |
|---|---|---|
| 📋 Body bounces off when the roof or side hits something | Medium | Rapier contacts on the body are too stiff / springy: zero restitution, softer contact. |
| 📋 PBR textures | Medium–large | Materials are already PBR; this means texture maps (normal, roughness, albedo) for the ground and the truck. Will be a Graphics option. |
| 📋 Suspension, shocks and wheel arches: model + animation | Large | Axles, links and shocks that follow the physics. Tyre size and lift now come from the tuning panel (the springs stretch with the lift, the wheels scale); the arches and links are still the stock model. |
| 📋 Tuning: what's left | Medium | The engine sound is the V8 for every engine (diesels need their own sound). Tyres rubbing the arches are shown (red tyre outline), not simulated as a stop. Tyre width changes the look, the contact rays and the side cylinders, not the grip. The model's long rear overhang limits the departure angle to 31° (the rear bumper scrapes at the foot of 30°+ ramps); lift and bigger tyres fix that, as on the real truck. |
| 📋 River is badly built | Medium | Must be fixed, but later. Most of its length floats in the air, and from below it isn't even visible: the water surface doesn't follow the terrain / the riverbed isn't carved into it. |
| 📋 Phones and tablets | Large | Touch controls, a mobile performance preset, HUD layout. Last. |

## Parked

| Task | Notes |
|---|---|
| ⏸ Lake physics (driving into water) | Not a priority. |
| ⏸ Short hitch on the first switch to night | Not a priority. |
