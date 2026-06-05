/**
 * Cave composer — a natural cavern of organic rock chambers linked by winding
 * passages, with the occasional pool or chasm hazard. Built on the shared
 * `MapCanvas` + op toolbox (the same primitives the agentic AI generator uses),
 * so deterministic and AI-authored caves render identically.
 *
 * Carves 4–6 non-overlapping chambers of varied cave floor out of a void map,
 * connects consecutive chamber centres with corridors, walls the result, then
 * drops 1–2 hazards. Deterministic from the seed.
 */
import { BIOME_PALETTES, pickGroundGid } from '../../../../shared/biomePalettes.js';
import type { ComposedMap } from '../mapTypes.js';
import { MapCanvas } from './MapCanvas.js';
import { carveCorridor, placeHazard, wallAroundFloor, paintRegion, defineZone } from './mapOps.js';

export interface ComposeCaveOpts { width: number; height: number; seed: number; large?: boolean; stairs?: boolean; }

export function composeCave(opts: ComposeCaveOpts): ComposedMap {
  const c = new MapCanvas({ width: opts.width, height: opts.height, seed: opts.seed });
  const palette = BIOME_PALETTES.cave;
  const want = opts.large ? 6 : 4;

  const rooms: Array<{ x: number; y: number; w: number; h: number; cx: number; cy: number }> = [];
  let attempts = 0;
  while (rooms.length < want && attempts < 120) {
    attempts++;
    const w = 4 + Math.floor(c.rng() * 5);
    const h = 4 + Math.floor(c.rng() * 4);
    const x = 2 + Math.floor(c.rng() * Math.max(1, opts.width - w - 4));
    const y = 2 + Math.floor(c.rng() * Math.max(1, opts.height - h - 4));
    if (rooms.some((r) => x < r.x + r.w + 2 && x + w + 2 > r.x && y < r.y + r.h + 2 && y + h + 2 > r.y)) continue;
    // Carve the chamber with varied cave floor for a natural rock look.
    for (let r = y; r < y + h; r++) for (let col = x; col < x + w; col++) { c.setGround(col, r, pickGroundGid(palette, c.rng)); c.reserve(col, r); }
    rooms.push({ x, y, w, h, cx: x + (w >> 1), cy: y + (h >> 1) });
  }

  // Connect NW→SE so the chain reads as a route through the cave.
  rooms.sort((a, b) => (a.cy + a.cx) - (b.cy + b.cx));
  for (let i = 1; i < rooms.length; i++) carveCorridor(c, { from: { x: rooms[i - 1].cx, y: rooms[i - 1].cy }, to: { x: rooms[i].cx, y: rooms[i].cy }, floor: 'cave_gravel' });

  // The southernmost chamber is the entrance. Without the stairs feature the
  // cave opens at the map edge (a passage carved straight down to the bottom);
  // with stairs the entrance is a stairs tile inside that chamber instead.
  const entranceRoom = rooms.length ? rooms.reduce((lo, r) => (r.cy > lo.cy ? r : lo), rooms[0]) : null;
  if (entranceRoom && !opts.stairs) {
    carveCorridor(c, { from: { x: entranceRoom.cx, y: entranceRoom.cy }, to: { x: entranceRoom.cx, y: opts.height - 1 }, floor: 'cave_gravel' });
  }

  wallAroundFloor(c);

  // Hazards: a pool in one chamber, a chasm in another (never the entrance).
  if (rooms.length >= 2) {
    const pool = rooms[1];
    placeHazard(c, { rect: { x: pool.cx - 1, y: pool.cy - 1, w: 2, h: 2 }, material: 'pool' });
  }
  if (rooms.length >= 3) {
    const chasm = rooms[rooms.length - 1];
    placeHazard(c, { cells: [{ x: chasm.cx, y: chasm.cy }, { x: chasm.cx + 1, y: chasm.cy }], material: 'chasm' });
  }

  if (entranceRoom) {
    c.anchors.entrance = { x: entranceRoom.cx, y: entranceRoom.cy };
    c.anchors.rooms = rooms;
    if (opts.stairs) {
      const pt = { x: entranceRoom.cx, y: entranceRoom.cy };
      // Guarantee solid footing under the stairs (clear any hazard that landed here).
      paintRegion(c, { cells: [pt], material: 'cave_dust', layer: 'ground' });
      paintRegion(c, { cells: [pt], material: 'stairs', layer: 'object' });
      defineZone(c, { name: 'Entrance Stairs', color: '#e2b96f', cells: [pt] });
    }
  }

  const entryDesc = opts.stairs ? 'a stairway descends into it from above' : 'an opening breaches the cavern wall at the map edge';
  return c.toComposedMap(
    caveName(rooms.length, c.rng),
    `A natural cavern of ${rooms.length} rock chamber${rooms.length === 1 ? '' : 's'} linked by winding passages, with still pools and a bottomless chasm in the dark; ${entryDesc}.`,
  );
}

const CAVE_NAMES = ['The Hollow', 'Dripstone Cave', 'The Deep Warren', 'Gloomhollow', 'The Sunless Grotto', 'Rockmaw Cavern'];
function caveName(_rooms: number, rng: () => number): string {
  return CAVE_NAMES[Math.floor(rng() * CAVE_NAMES.length)];
}
