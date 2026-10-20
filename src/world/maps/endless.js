import { Terrain } from '../terrain.js';
import { Streamer } from '../streamer.js';

// The endless map: a procedural world with no edge (worldgen.js), built in 1 km windows round the truck in a worker
// and streamed in as it drives (streamer.js). seed: one world for everyone (friends in a room see the same land).
export const endless = {
  id: 'endless',
  seed: 7,
  // hooks: the streamer's prepare / apply (main.js fills them in once every system exists)
  async open({ hooks }) {
    const streamer = new Streamer(this.seed, { prepare: (t, w) => hooks.prepare(t, w), apply: (t, w, dx, dz) => hooks.apply(t, w, dx, dz) });
    const spawn = await streamer.spawn;   // world coordinates
    const win = await streamer.first(spawn.x, spawn.z);
    return { terrain: Terrain.fromData(win), win, spawn, streamer, farLand: true, fallY: -400 };
  },
};
