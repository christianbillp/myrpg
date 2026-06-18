/**
 * Cave composer — two silhouettes (Roadmap v2 · M2/D2), picked from the seed:
 *   • hub_spoke — one large central chamber ringed by small side chambers, each
 *     tunnelled back to the centre (the original cavern shape).
 *   • cavern    — an organic cellular-automata cavern: a single connected blob of
 *     irregular rock carved by smoothing random noise.
 * Both are built on the shared `MapCanvas` + op toolbox so deterministic and
 * AI-authored caves render identically, then walled and seeded with a pool +
 * chasm. Deterministic from the seed.
 */
import { BIOME_PALETTES, pickGroundGid } from '../../../../shared/biomePalettes.js';
import type { ComposedMap, MapAnchors } from '../mapTypes.js';
import { MapCanvas } from './MapCanvas.js';
import { carveCorridor, placeHazard, wallAroundFloor, paintRegion, defineZone, passableRegions } from './mapOps.js';

interface CaveRoom { x: number; y: number; w: number; h: number; cx: number; cy: number; }

export type CaveVariant = 'hub_spoke' | 'cavern';
const CAVE_VARIANTS: readonly CaveVariant[] = ['hub_spoke', 'cavern'];

export interface ComposeCaveOpts { width: number; height: number; seed: number; large?: boolean; stairs?: boolean; variant?: CaveVariant; }

export function composeCave(opts: ComposeCaveOpts): ComposedMap {
  const c = new MapCanvas({ width: opts.width, height: opts.height, seed: opts.seed });
  const variant = opts.variant ?? CAVE_VARIANTS[Math.floor(c.rng() * CAVE_VARIANTS.length)];
  return variant === 'cavern' ? composeCavern(c, opts) : composeHubSpoke(c, opts);
}

// ── Hub-and-spoke (original) ────────────────────────────────────────────────────

function composeHubSpoke(c: MapCanvas, opts: ComposeCaveOpts): ComposedMap {
  const palette = BIOME_PALETTES.cave;

  const carveRoom = (x: number, y: number, w: number, h: number): CaveRoom => {
    for (let r = y; r < y + h; r++) for (let col = x; col < x + w; col++) { c.setGround(col, r, pickGroundGid(palette, c.rng)); c.reserve(col, r); }
    return { x, y, w, h, cx: x + (w >> 1), cy: y + (h >> 1) };
  };

  const cw = Math.max(6, Math.min(opts.width - 10, Math.floor(opts.width * (0.38 + c.rng() * 0.08))));
  const ch = Math.max(5, Math.min(opts.height - 8, Math.floor(opts.height * (0.38 + c.rng() * 0.08))));
  const central = carveRoom(Math.floor((opts.width - cw) / 2), Math.floor((opts.height - ch) / 2), cw, ch);
  const rooms: CaveRoom[] = [central];

  const sideWant = opts.large ? 4 : 2;
  let attempts = 0;
  while (rooms.length < sideWant + 1 && attempts < 500) {
    attempts++;
    const w = 3 + Math.floor(c.rng() * 3);
    const h = 3 + Math.floor(c.rng() * 3);
    const x = 2 + Math.floor(c.rng() * Math.max(1, opts.width - w - 4));
    const y = 2 + Math.floor(c.rng() * Math.max(1, opts.height - h - 4));
    if (rooms.some((r) => x < r.x + r.w + 2 && x + w + 2 > r.x && y < r.y + r.h + 2 && y + h + 2 > r.y)) continue;
    const side = carveRoom(x, y, w, h);
    rooms.push(side);
    carveCorridor(c, { from: { x: side.cx, y: side.cy }, to: { x: central.cx, y: central.cy }, floor: 'cave_gravel' });
  }

  const sideRooms = rooms.slice(1);
  const entranceRoom = sideRooms.length ? sideRooms.reduce((lo, r) => (r.cy > lo.cy ? r : lo), sideRooms[0]) : central;
  if (entranceRoom && !opts.stairs) {
    carveCorridor(c, { from: { x: entranceRoom.cx, y: entranceRoom.cy }, to: { x: entranceRoom.cx, y: opts.height - 1 }, floor: 'cave_gravel' });
  }

  wallAroundFloor(c);

  placeHazard(c, { rect: { x: central.x + 1, y: central.y + 1, w: 2, h: 2 }, material: 'pool' });
  placeHazard(c, { cells: [{ x: central.x + central.w - 2, y: central.y + central.h - 2 }, { x: central.x + central.w - 3, y: central.y + central.h - 2 }], material: 'chasm' });

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
      paintRegion(c, { cells: [pt], material: 'cave_dust', layer: 'ground' });
      paintRegion(c, { cells: [pt], material: 'stairs', layer: 'object' });
      defineZone(c, { name: 'Entrance Stairs', color: '#e2b96f', cells: [pt] });
    }
  }

  const entryDesc = opts.stairs ? 'a stairway descends into it from above' : 'an opening breaches the cavern wall at the map edge';
  return c.toComposedMap(
    caveName(c.rng),
    `A great central cavern ringed by ${sideRooms.length} smaller chamber${sideRooms.length === 1 ? '' : 's'}, each tunnelled back to the hall; a still pool and a bottomless chasm lie in the dark; ${entryDesc}.`,
  );
}

// ── Cellular-automata cavern ─────────────────────────────────────────────────────

const NEIGH4: ReadonlyArray<readonly [number, number]> = [[0, -1], [0, 1], [-1, 0], [1, 0]];

function composeCavern(c: MapCanvas, opts: ComposeCaveOpts): ComposedMap {
  const { width: W, height: H } = opts;
  const palette = BIOME_PALETTES.cave;

  // 1. Random fill the interior (border stays solid rock), then smooth with the
  //    classic 4–5 cellular-automata rule so blobs coalesce into a cavern.
  let cells: boolean[][] = Array.from({ length: H }, (_, y) =>
    Array.from({ length: W }, (_, x) => (x <= 1 || y <= 1 || x >= W - 2 || y >= H - 2 ? false : c.rng() < 0.46)));
  const wallNeighbours = (g: boolean[][], x: number, y: number): number => {
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || !g[ny][nx]) n++; // off-map counts as rock
    }
    return n;
  };
  for (let it = 0; it < 5; it++) {
    const next = cells.map((row) => row.slice());
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const w = wallNeighbours(cells, x, y);
      next[y][x] = w < 4 ? true : w > 5 ? false : cells[y][x];
    }
    cells = next;
  }

  // 2. Keep only the largest connected floor blob (others become rock) so the
  //    cavern is one reachable space. Fall back to a central rectangle if the CA
  //    produced nothing usable.
  let floorCells = largestComponent(cells, W, H);
  if (floorCells.length < 24) {
    floorCells = [];
    const rx = Math.floor(W * 0.25), ry = Math.floor(H * 0.25), rw = Math.floor(W * 0.5), rh = Math.floor(H * 0.5);
    cells = Array.from({ length: H }, () => new Array<boolean>(W).fill(false));
    for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) { cells[y][x] = true; floorCells.push([x, y]); }
  }
  const isFloor = new Set(floorCells.map(([x, y]) => y * W + x));

  // 3. Paint ground + reserve every floor cell.
  for (const [x, y] of floorCells) { c.setGround(x, y, pickGroundGid(palette, c.rng)); c.reserve(x, y); }

  // 4. Entrance: the southernmost floor cell; open a passage down to the map edge
  //    (unless a stairs entrance is requested).
  let entrance = floorCells[0];
  for (const cell of floorCells) if (cell[1] > entrance[1]) entrance = cell;
  if (!opts.stairs) carveCorridor(c, { from: { x: entrance[0], y: entrance[1] }, to: { x: entrance[0], y: H - 1 }, floor: 'cave_gravel' });

  wallAroundFloor(c);

  // 5. Pool + chasm on deep-interior cells (all 8 neighbours floor), far apart,
  //    each vetoed if it would split the cavern.
  const deep = floorCells.filter(([x, y]) => NEIGH4.every(([dx, dy]) => isFloor.has((y + dy) * W + (x + dx)))
    && isFloor.has((y - 1) * W + (x - 1)) && isFloor.has((y + 1) * W + (x + 1)));
  if (deep.length) {
    const pool = deep.reduce((a, b) => (a[0] + a[1] <= b[0] + b[1] ? a : b)); // NW-most
    const chasm = deep.reduce((a, b) => (a[0] + a[1] >= b[0] + b[1] ? a : b)); // SE-most
    placeHazardSafely(c, pool[0], pool[1], 'pool');
    if (chasm[0] !== pool[0] || chasm[1] !== pool[1]) placeHazardSafely(c, chasm[0], chasm[1], 'chasm');
  }

  // 6. Zone over the whole cavern + entrance/vault anchors.
  defineZone(c, { name: 'cavern', color: '#aa8866', cells: floorCells.map(([x, y]) => ({ x, y })) });
  const xs = floorCells.map((p) => p[0]), ys = floorCells.map((p) => p[1]);
  const bbox: CaveRoom = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs) + 1, h: Math.max(...ys) - Math.min(...ys) + 1, cx: entrance[0], cy: entrance[1] };
  const anchors: MapAnchors = c.anchors;
  anchors.entrance = { x: entrance[0], y: entrance[1] };
  anchors.rooms = [bbox];
  const far = farthestFloor(isFloor, W, entrance);
  anchors.vault = { x: far[0], y: far[1] };
  if (opts.stairs) {
    const pt = { x: entrance[0], y: entrance[1] };
    paintRegion(c, { cells: [pt], material: 'cave_dust', layer: 'ground' });
    paintRegion(c, { cells: [pt], material: 'stairs', layer: 'object' });
    defineZone(c, { name: 'Entrance Stairs', color: '#e2b96f', cells: [pt] });
  }

  const entryDesc = opts.stairs ? 'a stairway descends into it from above' : 'a passage breaks through to the map edge';
  return c.toComposedMap(
    caveName(c.rng),
    `A winding natural cavern of irregular rock, one connected hollow; a still pool and a bottomless chasm lie in the dark; ${entryDesc}.`,
  );
}

/** Place a 1-cell hazard, reverting it if it severs the cavern. */
function placeHazardSafely(c: MapCanvas, x: number, y: number, material: 'pool' | 'chasm'): void {
  const prevGround = c.getGround(x, y), prevObj = c.getObject(x, y);
  placeHazard(c, { cells: [{ x, y }], material });
  if (passableRegions(c).sizes.length > 1) { c.setGround(x, y, prevGround); c.setObject(x, y, prevObj); }
}

/** Largest 4-connected component of floor cells, as [x,y] pairs. */
function largestComponent(cells: boolean[][], W: number, H: number): Array<[number, number]> {
  const seen = new Array<boolean>(W * H).fill(false);
  let best: Array<[number, number]> = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!cells[y][x] || seen[y * W + x]) continue;
    const comp: Array<[number, number]> = [];
    const stack: Array<[number, number]> = [[x, y]]; seen[y * W + x] = true;
    while (stack.length) {
      const [cx, cy] = stack.pop()!;
      comp.push([cx, cy]);
      for (const [dx, dy] of NEIGH4) {
        const nx = cx + dx, ny = cy + dy;
        if (nx >= 0 && ny >= 0 && nx < W && ny < H && cells[ny][nx] && !seen[ny * W + nx]) { seen[ny * W + nx] = true; stack.push([nx, ny]); }
      }
    }
    if (comp.length > best.length) best = comp;
  }
  return best;
}

/** Floor cell farthest (in steps) from `start`, via BFS over the floor set. */
function farthestFloor(floor: Set<number>, W: number, start: [number, number]): [number, number] {
  const startId = start[1] * W + start[0];
  const dist = new Map<number, number>([[startId, 0]]);
  const q: number[] = [startId];
  let far = startId;
  while (q.length) {
    const id = q.shift()!;
    if (dist.get(id)! > dist.get(far)!) far = id;
    const x = id % W, y = (id / W) | 0;
    for (const [dx, dy] of NEIGH4) {
      const nid = (y + dy) * W + (x + dx);
      if (floor.has(nid) && !dist.has(nid)) { dist.set(nid, dist.get(id)! + 1); q.push(nid); }
    }
  }
  return [far % W, (far / W) | 0];
}

const CAVE_NAMES = ['The Hollow', 'Dripstone Cave', 'The Deep Warren', 'Gloomhollow', 'The Sunless Grotto', 'Rockmaw Cavern'];
function caveName(rng: () => number): string {
  return CAVE_NAMES[Math.floor(rng() * CAVE_NAMES.length)];
}
