// The driver's controls a car does not have, from what it is made of: its drivetrain (low range, a
// lockable centre diff, axle lockers, a 2WD switch), its lamps (a light bar) and a turret. Nothing is
// stated per car: a car file that gains low range or a light bar gains the control. The keys, the pad,
// the touch drawer, the menu, the controls page and the hints leave these out (input.js setCarControls).
export function missingControls(vehicle, model) {
  const d = vehicle.drivetrain, out = [];
  if (!d.P.transfer?.low) out.push('range');
  if (!d.canLockCentre) out.push('centreLock');
  if (!d.canLock) out.push('lockers');
  if (!d.layout.rwd.length) out.push('rwd');
  if (!model.lights.bar) out.push('lightBar');
  if (!vehicle.turret) out.push('gunner', 'fire', 'aim', 'weapon');
  return out;
}
