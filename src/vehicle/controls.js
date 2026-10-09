// The driver's controls a car does not have, from what it is made of (drivetrain, extra lamps, turret).
// Nothing is stated per car: a car file that gains low range or extra lamps gains the control. Keys, pad,
// touch drawer, menu, controls page and hints leave these out (input.js setCarControls).
export function missingControls(vehicle, model) {
  const d = vehicle.drivetrain, out = [];
  if (!d.P.transfer?.low) out.push('range');
  if (!d.canLockCentre) out.push('centreLock');
  if (!d.canLock) out.push('lockers');
  if (!d.layout.rwd.length) out.push('rwd');
  if (!model.lights.aux.length) out.push('auxLights');
  if (!vehicle.turret) out.push('gunner', 'fire', 'aim', 'weapon');
  return out;
}
