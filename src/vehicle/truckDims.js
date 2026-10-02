// Shared body dimensions (vehicle frame: +x right, +y up, -z forward, y = 0 ground at static ride,
// z = 0 mid-wheelbase). Measured off reference.webp (side view: 2.794 m wheelbase = 459 px).
export const D = {
  W: 0.90,          // lower body half width (outer skin)
  WG: 0.868,        // greenhouse half width at the waist (before tumblehome)
  TUMBLE: 0.12,     // greenhouse inward lean: x *= 1 - TUMBLE * (y - WAIST)
  SILL: 0.66,       // body bottom between the arches
  WAIST: 1.385,     // top of the lower body (door capping line)
  EAVE: 1.935,      // top of the greenhouse sides (start of the roof chamfer)
  ROOF: 2.0,
  FRONT: -2.0,      // front face of the wings
  REAR: 2.33,       // rear face
  SCREEN: -0.70,    // windscreen base / bulkhead
  RAKE: 0.17,       // windscreen top is this much further back than its base
  ARCH_F: -1.397, ARCH_R: 1.397,
  ARCH_TOP: 1.03,   // top of the wheel arch openings (truckBody.js ATOP)
  FLOOR: 0.78,      // cabin floor top
  DX: -0.42,        // driver seat centre (left-hand drive)
};
D.HEADER = D.SCREEN + D.RAKE;
// A-pillar line: z of the windscreen plane at height y
D.pillarZ = (y) => D.SCREEN + (y - D.WAIST) * (D.RAKE / (D.EAVE - D.WAIST));
// tumblehome scale at height y
D.tumble = (y) => 1 - D.TUMBLE * Math.max(0, y - D.WAIST);
