/**
 * Cave composer — a natural cavern built as a HUB-AND-SPOKE: one large central
 * chamber with several small side chambers around it, each linked back to the
 * centre by a short passage. This silhouette is deliberately distinct from the
 * dungeon's grid of similar rooms. Built on the shared `MapCanvas` + op toolbox
 * so deterministic and AI-authored caves render identically.
 *
 * Carves varied cave floor out of a void map, walls the result, then drops a
 * pool + chasm hazard. Deterministic from the seed.
 */
import { BIOME_PALETTES, pickGroundGid } from '../../../../shared/biomePalettes.js';
import type { ComposedMap } from '../mapTypes.js';
import { MapCanvas } from './MapCanvas.js';
import { carveCorridor, placeHazard, wallAroundFloor, paintRegion, defineZone } from './mapOps.js';

interface CaveRoom { x: number; y: number; w: number; h: number; cx: number; cy: number; }

export interface ComposeCaveOpts { width: number; height: number; seed: number; large?: boolean; stairs?: boolean; }

export function composeCave(opts: ComposeCaveOpts): ComposedMap {
  const c = new MapCanvas({ width: opts.width, height: opts.height, seed: opts.seed });
  const palette = BIOME_PALETTES.cave;

  const carveRoom = (x: number, y: number, w: number, h: number): CaveRoom => {
    for (let r = y; r < y + h; r++) for (let col = x; col < x + w; col++) { c.setGround(col, r, pickGroundGid(palette, c.rng)); c.reserve(col, r); }
    return { x, y, w, h, cx: x + (w >> 1), cy: y + (h >> 1) };
  };

  // Large central chamber, roughly centred and filling ~40% of each axis —
  // sized to leave a generous border ring for the side chambers.
  const cw = Math.max(6, Math.min(opts.width - 10, Math.floor(opts.width * (0.38 + c.rng() * 0.08))));
  const ch = Math.max(5, Math.min(opts.height - 8, Math.floor(opts.height * (0.38 + c.rng() * 0.08))));
  const central = carveRoom(Math.floor((opts.width - cw) / 2), Math.floor((opts.height - ch) / 2), cw, ch);
  const rooms: CaveRoom[] = [central];

  // Small side chambers in the border ring, each tunnelled back to the centre.
  // 3-room cave → 2 side chambers; 5-room → 4 (so the total reads as 3 / 5).
  const sideWant = opts.large ? 4 : 2;
  let attempts = 0;
  while (rooms.length < sideWant + 1 && attempts < 500) {
    attempts++;
    const w = 3 + Math.floor(c.rng() * 3);   // 3..5
    const h = 3 + Math.floor(c.rng() * 3);
    const x = 2 + Math.floor(c.rng() * Math.max(1, opts.width - w - 4));
    const y = 2 + Math.floor(c.rng() * Math.max(1, opts.height - h - 4));
    if (rooms.some((r) => x < r.x + r.w + 2 && x + w + 2 > r.x && y < r.y + r.h + 2 && y + h + 2 > r.y)) continue;
    const side = carveRoom(x, y, w, h);
    rooms.push(side);
    carveCorridor(c, { from: { x: side.cx, y: side.cy }, to: { x: central.cx, y: central.cy }, floor: 'cave_gravel' });
  }

  // The southernmost side chamber is the entrance. Without the stairs feature
  // the cave opens at the map edge (a passage carved straight down to the
  // bottom); with stairs the entrance is a stairs tile inside that chamber.
  const sideRooms = rooms.slice(1);
  const entranceRoom = sideRooms.length ? sideRooms.reduce((lo, r) => (r.cy > lo.cy ? r : lo), sideRooms[0]) : central;
  if (entranceRoom && !opts.stairs) {
    carveCorridor(c, { from: { x: entranceRoom.cx, y: entranceRoom.cy }, to: { x: entranceRoom.cx, y: opts.height - 1 }, floor: 'cave_gravel' });
  }

  wallAroundFloor(c);

  // Hazards live in opposite corners of the central chamber, clear of its
  // centre (the corridor hub) so the spokes stay connected.
  placeHazard(c, { rect: { x: central.x + 1, y: central.y + 1, w: 2, h: 2 }, material: 'pool' });
  placeHazard(c, { cells: [{ x: central.x + central.w - 2, y: central.y + central.h - 2 }, { x: central.x + central.w - 3, y: central.y + central.h - 2 }], material: 'chasm' });

  // Author-time zones: the central cavern + each side chamber.
  const rectCells = (r: CaveRoom): string[] => {
    const out: string[] = [];
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) out.push(`${x},${y}`);
    return out;
  };
  c.addZone('cavern', 'central cavern', '#aa8866', rectCells(central));
  sideRooms.forEach((r, i) => c.addZone('chamber', `chamber ${i + 1}`, '#88aa99', rectCells(r)));

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
    `A great central cavern ringed by ${sideRooms.length} smaller chamber${sideRooms.length === 1 ? '' : 's'}, each tunnelled back to the hall; a still pool and a bottomless chasm lie in the dark; ${entryDesc}.`,
  );
}

const CAVE_NAMES = ['The Hollow', 'Dripstone Cave', 'The Deep Warren', 'Gloomhollow', 'The Sunless Grotto', 'Rockmaw Cavern'];
function caveName(_rooms: number, rng: () => number): string {
  return CAVE_NAMES[Math.floor(rng() * CAVE_NAMES.length)];
}
