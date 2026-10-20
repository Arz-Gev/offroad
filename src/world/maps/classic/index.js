import { ClassicTerrain, SPAWN, LANES, HILL, POI } from './terrain.js';
import { bakeClassic } from './bake.js';
import { buildProvingGround } from './provingGround.js';
import { TREE_KINDS } from '../../treeKinds.js';

// The classic map: one fixed 1 km map (trail loops, the proving ground, lake, ford, hut, quarry, lookout), walled at
// its edge, built on the main thread at load. See maps/index.js for what a map provides.
export const classic = {
  id: 'classic',
  async open() {
    const terrain = new ClassicTerrain(7);
    const dims = TREE_KINDS.map(k => { const g = k.build(); return { kind: k.kind, crownR: g.crownR, trunkR: g.trunkR }; });
    const win = bakeClassic(terrain, dims);
    return { terrain, win, spawn: { ...SPAWN }, streamer: null, farLand: false, fallY: -60 };
  },
  extras: ({ RAPIER, world, terrain, colliderSurface }) => buildProvingGround(RAPIER, world, terrain, colliderSurface),
  // the menu's places (x, z local; also used by tools/browser-snippets.js). trailSpot(x, z, back): on the nearest trail
  places: (terrain, trailSpot) => [
    { name: 'Spawn', tag: 'Trail', title: 'Spawn', desc: 'Start of the trail loop: ruts, a mud hole and a branch towards the hills.', x: SPAWN.x, z: SPAWN.z, yaw: 0 },
    { name: 'Axle twister', tag: 'Proving ground · lane A', title: 'Axle twister and whoops', desc: 'Offset humps that lift one wheel at a time. Watch the axle articulation.', x: LANES.A, z: 47, yaw: 0 },
    { name: 'Steps and logs', tag: 'Proving ground · lane B', title: 'Steps and logs', desc: 'Ledges from 15 to 45 cm, then logs. Low range and a slow approach.', x: LANES.B, z: 47, yaw: 0 },
    { name: 'Rock garden', tag: 'Proving ground · lane C', title: 'Rock garden', desc: 'Boulders. Needs low range, lockers and a careful line.', x: LANES.C, z: 47, yaw: 0 },
    { name: 'Ramps', tag: 'Proving ground · lane D', title: 'Ramps 20° / 30° / 35°', desc: 'Climbs in low range. The steepest needs the centre diff locked.', x: LANES.D, z: 47, yaw: 0 },
    { name: 'Mud and off-camber', tag: 'Proving ground · lane E', title: 'Mud and off-camber', desc: 'A deep mud hole and a side slope. Air down and keep momentum.', x: LANES.E, z: 47, yaw: 0 },
    { name: 'The big hill', tag: 'Hill', title: 'The big hill', desc: 'A long climb with views over the whole map.', x: HILL.x - 52, z: HILL.z + 8, yaw: -Math.PI / 2 },
    { name: 'Lake shore', tag: 'Outer loop · east', title: 'Lake shore', desc: 'A sandy beach on the lake. Splash through the shallows along the shore.', x: 386, z: 44, yaw: Math.atan2(-(POI.lake.x - 386), -(POI.lake.z - 44)) },
    { name: 'The ford', tag: 'Outer loop · north-east', title: 'The ford', desc: 'The trail crosses the stream: 30 cm of water over gravel. Keep it slow and steady.', ...trailSpot(POI.ford.x, POI.ford.z, 35) },
    { name: 'Ruined hut', tag: 'Outer loop · south', title: 'Ruined hut', desc: 'An old stone hut in the meadows, off the long southern straight.', ...trailSpot(POI.hut.x, POI.hut.z, 40) },
    { name: 'Old quarry', tag: 'South-west', title: 'Old quarry', desc: 'A gravel pit with terraced walls. Loose ground, room to play.', x: POI.quarry.x + 10, z: POI.quarry.z + 6, yaw: Math.PI / 2 },
    { name: 'Lookout', tag: 'Peak · spiral spur', title: 'Lookout summit', desc: 'The top of the spiral track: the whole map and the ranges beyond.', ...trailSpot(POI.lookout.x, POI.lookout.z, 14) },
    { name: 'Pine forest', tag: 'Outer loop · north', title: 'Pine forest', desc: 'The trail through the dense northern forest. Lovely with the headlights at night.', ...trailSpot(POI.forest.x, POI.forest.z, 0) },
  ],
};
