import { buildSpruce, buildPine, buildBirch, buildDead, buildBlossom, buildOak } from './foliage.js';

// The tree variants, in the order the placement numbers them (worker: placement and ground data; trees.js: drawing).
// bark: which bark texture the trunk takes
export const TREE_KINDS = [
  { kind: 'spruce', bark: 'conifer', build: () => buildSpruce(11, 17) },
  { kind: 'spruce', bark: 'conifer', build: () => buildSpruce(23, 12.5) },
  { kind: 'pine', bark: 'conifer', build: () => buildPine(31, 19) },
  { kind: 'pine', bark: 'conifer', build: () => buildPine(47, 15) },
  { kind: 'birch', bark: 'birch', build: () => buildBirch(53, 13) },
  { kind: 'dead', bark: 'conifer', build: () => buildDead(61, 11) },
  { kind: 'blossom', bark: 'conifer', build: () => buildBlossom(71, 8) },
  { kind: 'blossom', bark: 'conifer', build: () => buildBlossom(83, 6.8) },
  { kind: 'oak', bark: 'conifer', build: () => buildOak(91, 12.5) },
];
