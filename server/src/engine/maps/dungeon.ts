/**
 * Dungeon composer — carves 3 or 5 non-overlapping rectangular rooms
 * connected by 1-cell-wide L-shaped corridors out of a void map.
 *
 * Rendering follows the `broken_ward` reference map:
 *   • Every floor cell AND every wall cell carries a stone-floor tile on
 *     the terrain layer (the floor extends UNDER the wall).
 *   • Walls go on the object layer using transparent-twin gids (11
 *     straights, 10 convex corners, 66 concave / partial corners) with
 *     the right rotation per cell based on its 4-neighbour mask.
 *   • Outside the dungeon both layers stay at gid 0 (impassable void).
 *
 * The southernmost room becomes the `entrance` (its centre cell becomes
 * the anchor; an entry corridor punches south to the map edge from the
 * room's middle column). The room farthest from the entrance becomes
 * the `vault`.
 */
import { BIOME_PALETTES, pickGroundGid } from '../../../../shared/biomePalettes.js';
import type { ComposedMap, Feature, MapAnchors, MapZone } from '../mapTypes.js';
import { WALL_GIDS, FURNITURE_GIDS } from '../mapTiles.js';
import { SCRIBBLE_TILESET, flatten } from './shared.js';

export interface ComposeDungeonOpts {
  width: number;
  height: number;
  features: Feature[];
  rng: () => number;
  allocZoneId: (kind: string) => string;
}

export function composeDungeon(opts: ComposeDungeonOpts): ComposedMap {
  const { width: W, height: H, features, rng, allocZoneId } = opts;
  // Stairs feature: the dungeon entrance is a stairs tile inside the entry room
  // (covered by an "Entrance Stairs" zone) instead of a corridor punched out to
  // the south map edge.
  const useStairs = features.includes('stairs');
  const terrainGrid: number[][] = [];
  const objectGrid: number[][]  = [];
  for (let r = 0; r < H; r++) {
    terrainGrid.push(new Array<number>(W).fill(0));
    objectGrid.push(new Array<number>(W).fill(0));
  }

  const floor: boolean[][] = Array.from({ length: H }, () => new Array<boolean>(W).fill(false));
  const roomCount = features.includes('5-room') ? 5 : 3;

  const rooms: Array<{ x: number; y: number; w: number; h: number; cx: number; cy: number }> = [];
  const maxAttempts = 250;
  while (rooms.length < roomCount) {
    let placed = false;
    for (let attempt = 0; attempt < maxAttempts && !placed; attempt++) {
      const w = 4 + Math.floor(rng() * 4);
      const h = 4 + Math.floor(rng() * 3);
      const x = 2 + Math.floor(rng() * (W - w - 4));
      const y = 2 + Math.floor(rng() * (H - h - 4));
      const overlap = rooms.some((r) =>
        x < r.x + r.w + 2 && x + w + 2 > r.x && y < r.y + r.h + 2 && y + h + 2 > r.y,
      );
      if (overlap) continue;
      rooms.push({ x, y, w, h, cx: x + Math.floor(w / 2), cy: y + Math.floor(h / 2) });
      placed = true;
    }
    if (!placed) break;
  }

  for (const r of rooms) {
    for (let dy = 0; dy < r.h; dy++) for (let dx = 0; dx < r.w; dx++) floor[r.y + dy][r.x + dx] = true;
  }

  // Serial chain, south → north: the southernmost room is the entrance and the
  // chain links consecutive rooms only, so there is a single path to the last
  // (deepest) room — the "final room".
  rooms.sort((a, b) => (b.cy - a.cy) || (a.cx - b.cx));
  for (let i = 1; i < rooms.length; i++) {
    carveCorridor(floor, rooms[i - 1].cx, rooms[i - 1].cy, rooms[i].cx, rooms[i].cy);
  }

  const entryRoom = rooms[0];
  const finalRoom = rooms.length > 1 ? rooms[rooms.length - 1] : undefined;
  if (entryRoom && !useStairs) {
    const entryX = entryRoom.x + Math.floor(entryRoom.w / 2);
    for (let r = entryRoom.y + entryRoom.h; r < H; r++) floor[r][entryX] = true;
  }

  const dungeonPalette = BIOME_PALETTES.dungeon;
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      if (floor[r][c]) {
        terrainGrid[r][c] = pickGroundGid(dungeonPalette, rng);
        continue;
      }
      const fN  = !!floor[r - 1]?.[c];
      const fS  = !!floor[r + 1]?.[c];
      const fE  = !!floor[r]?.[c + 1];
      const fW  = !!floor[r]?.[c - 1];
      const fNW = !!floor[r - 1]?.[c - 1];
      const fNE = !!floor[r - 1]?.[c + 1];
      const fSW = !!floor[r + 1]?.[c - 1];
      const fSE = !!floor[r + 1]?.[c + 1];
      const anyFloor = fN || fS || fE || fW || fNW || fNE || fSW || fSE;
      if (!anyFloor) continue;

      terrainGrid[r][c] = pickGroundGid(dungeonPalette, rng);

      // Concave (room wraps around the wall cell on two perpendicular sides).
      if (fS && fE)      objectGrid[r][c] = WALL_GIDS.PARTIAL_CORNER_UL;
      else if (fS && fW) objectGrid[r][c] = WALL_GIDS.PARTIAL_CORNER_UR;
      else if (fN && fE) objectGrid[r][c] = WALL_GIDS.PARTIAL_CORNER_LL;
      else if (fN && fW) objectGrid[r][c] = WALL_GIDS.PARTIAL_CORNER_LR;
      // Straights — one orthogonal floor neighbour; art faces the floor.
      else if (fS) objectGrid[r][c] = WALL_GIDS.NORTH;
      else if (fN) objectGrid[r][c] = WALL_GIDS.SOUTH;
      else if (fE) objectGrid[r][c] = WALL_GIDS.WEST;
      else if (fW) objectGrid[r][c] = WALL_GIDS.EAST;
      // Convex outer corners — diagonal-only floor neighbour.
      else if (fSE) objectGrid[r][c] = WALL_GIDS.CORNER_TL;
      else if (fSW) objectGrid[r][c] = WALL_GIDS.CORNER_TR;
      else if (fNE) objectGrid[r][c] = WALL_GIDS.CORNER_BL;
      else if (fNW) objectGrid[r][c] = WALL_GIDS.CORNER_BR;
    }
  }

  const anchors: MapAnchors = { rooms };
  const zones: MapZone[] = [];
  if (entryRoom) anchors.entrance = { x: entryRoom.cx, y: entryRoom.cy };
  if (finalRoom) anchors.vault = { x: finalRoom.cx, y: finalRoom.cy };

  // One author-time zone per room along the chain: the first is the entrance,
  // the last is the "final room", the rest are "room <n>".
  let roomN = 0;
  for (const r of rooms) {
    const cells: string[] = [];
    for (let yy = r.y; yy < r.y + r.h; yy++) for (let xx = r.x; xx < r.x + r.w; xx++) cells.push(`${xx},${yy}`);
    const isEntrance = r === entryRoom;
    const isFinal = r === finalRoom;
    const name = isEntrance ? 'entrance' : isFinal ? 'final room' : `room ${++roomN}`;
    const color = isEntrance ? '#88cc88' : isFinal ? '#cc8866' : '#6688aa';
    zones.push({ id: allocZoneId(name.replace(' ', '_')), name, color, cells: cells.sort() });
  }

  // Stairs entrance: drop the stairs tile on the entry-room centre and tag it.
  if (entryRoom && useStairs) {
    const ex = entryRoom.cx, ey = entryRoom.cy;
    objectGrid[ey][ex] = FURNITURE_GIDS.STAIRS_UP;
    zones.push({ id: allocZoneId('entrance_stairs'), name: 'Entrance Stairs', color: '#e2b96f', cells: [`${ex},${ey}`] });
  }

  return {
    width: W, height: H,
    terrainData: flatten(terrainGrid),
    objectData: flatten(objectGrid),
    name: dungeonName(rooms.length, rng),
    description: dungeonDescription(rooms.length, useStairs),
    tilesets: [SCRIBBLE_TILESET],
    anchors,
    ...(zones.length > 0 ? { zones } : {}),
  };
}

function carveCorridor(floor: boolean[][], x1: number, y1: number, x2: number, y2: number): void {
  const rows = floor.length;
  const cols = floor[0].length;
  const horizFirst = (x1 + y1) % 2 === 0;
  if (horizFirst) {
    const [a, b] = x1 < x2 ? [x1, x2] : [x2, x1];
    for (let c = a; c <= b; c++) if (y1 >= 0 && y1 < rows && c >= 0 && c < cols) floor[y1][c] = true;
    const [c, d] = y1 < y2 ? [y1, y2] : [y2, y1];
    for (let r = c; r <= d; r++) if (r >= 0 && r < rows && x2 >= 0 && x2 < cols) floor[r][x2] = true;
  } else {
    const [a, b] = y1 < y2 ? [y1, y2] : [y2, y1];
    for (let r = a; r <= b; r++) if (r >= 0 && r < rows && x1 >= 0 && x1 < cols) floor[r][x1] = true;
    const [c, d] = x1 < x2 ? [x1, x2] : [x2, x1];
    for (let cc = c; cc <= d; cc++) if (y2 >= 0 && y2 < rows && cc >= 0 && cc < cols) floor[y2][cc] = true;
  }
}

const DUNGEON_NAME_VARIANTS: Record<3 | 5, string[]> = {
  3: ['Three-Chamber Dungeon', 'Forgotten Crypt', 'Three-Cell Warren', 'Stones Below'],
  5: ['Five-Chamber Dungeon', 'Sealed Catacomb', 'Five-Cell Warren', 'The Deeper Hall'],
};

function dungeonName(roomCount: number, rng: () => number): string {
  const variants = DUNGEON_NAME_VARIANTS[(roomCount === 5 ? 5 : 3) as 3 | 5];
  return variants[Math.floor(rng() * variants.length)];
}

function dungeonDescription(roomCount: number, stairs: boolean): string {
  const entry = stairs
    ? 'A flight of stairs in the entry chamber descends from above.'
    : 'The entrance opens onto the southern edge of the map.';
  return `A stone dungeon of ${roomCount} room${roomCount === 1 ? '' : 's'} strung along a single line of corridors, ending at the final room. ${entry}`;
}
