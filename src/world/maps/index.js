import { classic } from './classic/index.js';
import { endless } from './endless.js';

// The maps the menu offers (World → Map; picking one restarts the game). A map is a source of windows of land in
// the shape windowBake.js makes them (terrain + baked data), which every world system draws and collides with:
//   id, label, note (menu), info (its tooltip line)
//   open({ hooks }) -> { terrain, win (the first window), spawn (world coordinates, yaw), streamer (endless: more
//     windows as the truck drives; null for a fixed map), farLand (the vista has its own land data), fallY (below
//     this the truck is put back at the start) }
//   places(terrain, trailSpot) (optional): a fixed list of the menu's places (local x, z, yaw); without it the menu
//     lists the start and the places found while driving (placement.js)
//   extras(ctx) (optional): more of the map's own scenery with colliders, an Object3D
export const MAPS = [
  { ...classic, label: 'Classic', note: '1 km · proving ground', info: 'Classic: the hand-made 1 km map with trail loops, the proving ground, a lake, a ford, a hut, a quarry and a lookout.' },
  { ...endless, label: 'Endless', note: 'Procedural · no edge', info: 'Endless: a world with no edge, made as you drive. Roads, lakes, huts, quarries and lookouts; places you find are added to Places. Takes longer to load.' },
];
export const mapById = id => MAPS.find(m => m.id === id) || MAPS[0];
