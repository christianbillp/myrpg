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

/** Dungeon layout silhouette (Roadmap v2 · M2/D1):
 *   • serial — the classic single chain entrance→…→vault (one path).
 *   • branch — a minimum spanning tree: side passages and dead-end spurs.
 *   • loop   — a spanning tree plus a few extra edges, so the dungeon has
 *              flanking loops (no single chokepoint chain). */
export type DungeonVariant = 'serial' | 'branch' | 'loop';
const DUNGEON_VARIANTS: readonly DungeonVariant[] = ['serial', 'branch', 'loop'];

export interface ComposeDungeonOpts {
  width: number;
  height: number;
  features: Feature[];
  rng: () => number;
  allocZoneId: (kind: string) => string;
  /** Force a layout silhouette; default picks one from the seed. */
  variant?: DungeonVariant;
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

  // Link the rooms as a graph. The southernmost room is the entrance; the
  // variant decides whether the rest form a single chain, a branching tree, or a
  // looped graph. The "final room" (vault) is the room graph-farthest from the
  // entrance — for `serial` that's the deepest room, as before.
  rooms.sort((a, b) => (b.cy - a.cy) || (a.cx - b.cx));
  const variant = opts.variant ?? DUNGEON_VARIANTS[Math.floor(rng() * DUNGEON_VARIANTS.length)];
  const edges = planDungeonEdges(rooms, variant, rng);
  for (const [i, j] of edges) carveCorridor(floor, rooms[i].cx, rooms[i].cy, rooms[j].cx, rooms[j].cy);

  const entryRoom = rooms[0];
  const vaultIndex = rooms.length > 1 ? farthestRoom(rooms.length, edges, 0) : 0;
  const finalRoom = rooms.length > 1 ? rooms[vaultIndex] : undefined;
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
    description: dungeonDescription(rooms.length, useStairs, variant),
    tilesets: [SCRIBBLE_TILESET],
    anchors,
    ...(zones.length > 0 ? { zones } : {}),
  };
}

/** Plan which room pairs get a corridor. `serial` = a chain; `branch` = a
 *  minimum spanning tree (Prim, by squared centre distance); `loop` = that tree
 *  plus the shortest few non-tree edges, adding flanking loops. Every variant
 *  spans all rooms, so the dungeon stays fully connected. */
function planDungeonEdges(rooms: Array<{ cx: number; cy: number }>, variant: DungeonVariant, _rng: () => number): Array<[number, number]> {
  const n = rooms.length;
  if (n <= 1) return [];
  if (variant === 'serial') return Array.from({ length: n - 1 }, (_, i) => [i, i + 1] as [number, number]);

  const dist = (a: number, b: number): number => { const dx = rooms[a].cx - rooms[b].cx, dy = rooms[a].cy - rooms[b].cy; return dx * dx + dy * dy; };
  const inTree = new Set<number>([0]);
  const edges: Array<[number, number]> = [];
  while (inTree.size < n) {
    let best: { a: number; b: number; d: number } | null = null;
    for (const a of inTree) for (let b = 0; b < n; b++) if (!inTree.has(b)) { const d = dist(a, b); if (!best || d < best.d) best = { a, b, d }; }
    edges.push([best!.a, best!.b]); inTree.add(best!.b);
  }
  if (variant === 'loop') {
    const have = new Set(edges.map(([a, b]) => (a < b ? `${a},${b}` : `${b},${a}`)));
    const cand: Array<[number, number, number]> = [];
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) if (!have.has(`${a},${b}`)) cand.push([a, b, dist(a, b)]);
    cand.sort((p, q) => p[2] - q[2]);
    const extra = Math.max(1, Math.round((n - 1) * 0.4));
    for (let i = 0; i < extra && i < cand.length; i++) edges.push([cand[i][0], cand[i][1]]);
  }
  return edges;
}

/** BFS room index farthest (in corridor hops) from `start`. */
function farthestRoom(n: number, edges: Array<[number, number]>, start: number): number {
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of edges) { adj[a].push(b); adj[b].push(a); }
  const dist = new Array<number>(n).fill(-1); dist[start] = 0;
  const q = [start];
  while (q.length) { const u = q.shift()!; for (const v of adj[u]) if (dist[v] < 0) { dist[v] = dist[u] + 1; q.push(v); } }
  let far = start;
  for (let i = 0; i < n; i++) if (dist[i] > dist[far]) far = i;
  return far;
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

function dungeonDescription(roomCount: number, stairs: boolean, variant: DungeonVariant): string {
  const entry = stairs
    ? 'A flight of stairs in the entry chamber descends from above.'
    : 'The entrance opens onto the southern edge of the map.';
  const shape = variant === 'serial'
    ? 'strung along a single line of corridors'
    : variant === 'branch'
      ? 'branching off a winding network of corridors'
      : 'woven together by looping corridors';
  return `A stone dungeon of ${roomCount} room${roomCount === 1 ? '' : 's'} ${shape}, ending at the final room. ${entry}`;
}
