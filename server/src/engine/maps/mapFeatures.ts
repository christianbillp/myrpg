/**
 * Map placeables — the unified structure recipe layer (Phase A + Phase B).
 *
 * A *placeable* is a named, deterministic structure (a watchtower, a tavern, a
 * building, a cemetery) composed from the `mapOps` toolbox and dropped into a
 * footprint on an existing `MapCanvas`. Phase B unified what used to be two
 * concepts — fixed "set-pieces" and parametric "structures" (building/ruin) — into
 * ONE registry of placeables: some take params (a `rooms` count), all are placed
 * the same conscious way and re-rollable in place.
 *
 * Contract for a recipe:
 *   • Operate ONLY through `mapOps` + `MapCanvas`; interior randomness uses a
 *     per-placeable `interiorSeed` (not `c.rng`) so one structure can be re-rolled
 *     without disturbing the rest of the map.
 *   • Treat ground as already laid by the caller — stay within `{ x, y, w, h }`.
 *   • Emit zones/anchors for anything the encounter layer should target.
 */
import { MapCanvas } from './MapCanvas.js';
import { mulberry32 } from './shared.js';
import { fillTerrain, stampRoom, placeBuilding, placeHazard, paintRegion, defineZone, type OpResult, type Point } from './mapOps.js';
import { groundGid, groundBlocksMovement, objectBlocksMovement, type GroundMaterial } from './materials.js';
import { PATH_GIDS, WALL_GIDS, FURNITURE_GIDS, DECOR_GIDS } from '../mapTiles.js';
import type { ComposedMap, Feature, PlacementRecord } from '../mapTypes.js';

const WALL_GID_SET = new Set(Object.values(WALL_GIDS).map((g) => g & 0x1fffffff));
const PREVIEW_SIZE = 9;
const MARGIN = 2;

// ── Types ─────────────────────────────────────────────────────────────────────

/** Where (and how big) a placeable is stamped. */
export interface MapFeatureContext { x: number; y: number; w: number; h: number; }

/** Per-placeable parameters. `rooms` drives building/ruin size; `interiorSeed`
 *  seeds the interior layout so it can be re-rolled in place. */
export interface PlaceableParams { rooms?: number; interiorSeed?: number; }

export interface MapFeatureDef {
  id: string;
  label: string;
  minW: number;
  minH: number;
  /** Desired footprint for the given params, clamped to the available area.
   *  Omitted → a PREVIEW_SIZE square clamped to [min, max]. Parametric
   *  placeables (building/ruin) size to their room count. */
  desiredFootprint?: (params: PlaceableParams, maxW: number, maxH: number) => { w: number; h: number };
  place: (c: MapCanvas, ctx: MapFeatureContext, params: PlaceableParams) => OpResult;
}

/** One placeable to stamp: a registry id, optional params, and an optional target
 *  region index (big maps — restrict placement to that band). */
export interface StampSpec { id: string; params?: PlaceableParams; region?: number; }

export type { PlacementRecord } from '../mapTypes.js';

// ── Shared placers ───────────────────────────────────────────────────────────

/** Paint a crate fence around a footprint's perimeter, leaving `gate` open and
 *  skipping any reserved (structure) cell. Shared by watchtower + cemetery. */
function fenceRing(c: MapCanvas, x: number, y: number, w: number, h: number, gate: Point): OpResult {
  const cells: Point[] = [];
  for (let cy = y; cy < y + h; cy++) {
    for (let cx = x; cx < x + w; cx++) {
      const onPerimeter = cy === y || cy === y + h - 1 || cx === x || cx === x + w - 1;
      if (!onPerimeter) continue;
      if (cx === gate.x && cy === gate.y) continue;
      if (c.isReserved(cx, cy)) continue;
      cells.push({ x: cx, y: cy });
    }
  }
  if (cells.length === 0) return { ok: true, summary: 'fence: nothing to place' };
  return paintRegion(c, { cells, material: 'crate', layer: 'object' });
}

/** Stable fallback interior seed from a footprint, so a placeable with no
 *  explicit seed still renders deterministically (and identically) per map. */
function seedFor(ctx: MapFeatureContext, interiorSeed?: number): number {
  if (interiorSeed !== undefined) return interiorSeed & 0xffffffff;
  const s = 0x811c9dc5 ^ (ctx.x * 73856093) ^ (ctx.y * 19349663) ^ (ctx.w * 83492791) ^ ctx.h;
  return (s >>> 0);
}

// A chair at offset (dx,dy) from its table must FACE the table — the opposite
// direction. Tiled flip-flag rotations: north=0, east=0xA0000000, south=0xC0000000,
// west=0x60000000. (The default art faces north.)
const CHAIR_FACING: Record<string, number> = { '0,-1': 0xC0000000, '0,1': 0, '-1,0': 0xA0000000, '1,0': 0x60000000 };

/**
 * Furnish a rectangular room interior (Phase B interior dressing) — a few pieces
 * from the palette placed on a seeded RNG, leaving the room walkable. `style`
 * picks the furniture mix. Shared by the tavern recipe and furnished buildings.
 */
function furnishRoom(c: MapCanvas, rx: number, ry: number, rw: number, rh: number, rng: () => number, style: 'living' | 'rubble'): void {
  const ix0 = rx + 1, iy0 = ry + 1, ix1 = rx + rw - 2, iy1 = ry + rh - 2; // interior bounds
  const free = (x: number, y: number): boolean => x >= ix0 && x <= ix1 && y >= iy0 && y <= iy1 && c.getObject(x, y) === 0;
  const put = (x: number, y: number, gid: number): void => { if (free(x, y)) c.setObject(x, y, gid); };

  // living / rubble: ONE piece in a corner — a 4×4 room's 2×2 interior is too
  // small for more without risking an isolated cell.
  const corners: Point[] = [{ x: ix0, y: iy0 }, { x: ix1, y: iy0 }, { x: ix0, y: iy1 }, { x: ix1, y: iy1 }];
  const pieces = style === 'rubble' ? [DECOR_GIDS.CRATE_CLOSED, DECOR_GIDS.BARRELS_TWO] : [FURNITURE_GIDS.WOODEN_PLANK, DECOR_GIDS.BARRELS_TWO, FURNITURE_GIDS.BARRELS_THREE];
  const corner = corners[Math.floor(rng() * corners.length)];
  put(corner.x, corner.y, pieces[Math.floor(rng() * pieces.length)]);
}

// ── Building / ruin layout ─────────────────────────────────────────────────────

const ROOM_MIN = 4, ROOM_MAX = 7;
// A tavern's rooms run bigger than a plain building's — a taproom needs a ≥3×3
// interior to hold a bar counter AND a table or two without cramping.
const TAVERN_ROOM_MIN = 5, TAVERN_ROOM_MAX = 8;

/** A room wall side — which walls carry a doorway (for doorway-aware furnishing). */
type Side = 'N' | 'S' | 'E' | 'W';

/**
 * A building's layout: a near-square grid where each COLUMN has its own width and
 * each ROW its own height (4..7) — so rooms vary in size (a wide hall beside a
 * small cell) instead of a uniform grid, while shared walls still line up (same
 * row = same height, same column = same width) so doorways and connectivity stay
 * simple. Deterministic from `seed`; shrinks rooms / sizes to fit `maxW×maxH`.
 */
interface BuildingLayout { cols: number; gridRows: number; colW: number[]; rowH: number[]; w: number; h: number; rooms: number; }

function buildingLayout(requestedRooms: number, seed: number, maxW: number, maxH: number, roomMin = ROOM_MIN, roomMax = ROOM_MAX, biasFirst = false): BuildingLayout {
  const swapMaxToFront = (a: number[]): void => { const i = a.indexOf(Math.max(...a)); [a[0], a[i]] = [a[i], a[0]]; };
  // Make a[0] dominate: a[0] ≥ 1.5·a[i] for every i>0, with each a[i] ≥ roomMin.
  const dominate = (a: number[], roomMin: number): void => {
    swapMaxToFront(a);
    if (a.length < 2) return;
    while (Math.floor(a[0] / 1.5) < roomMin) a[0]++;
    const cap = Math.floor(a[0] / 1.5);
    for (let i = 1; i < a.length; i++) a[i] = Math.min(a[i], cap);
  };
  for (let n = Math.max(1, Math.min(5, Math.floor(requestedRooms))); n >= 1; n--) {
    const cols = Math.ceil(Math.sqrt(n));
    const gridRows = Math.ceil(n / cols);
    if (cols * (roomMin - 1) + 1 > maxW || gridRows * (roomMin - 1) + 1 > maxH) continue; // can't fit at min
    const rng = mulberry32(seed);
    const colW = Array.from({ length: cols }, () => roomMin + Math.floor(rng() * (roomMax - roomMin + 1)));
    const rowH = Array.from({ length: gridRows }, () => roomMin + Math.floor(rng() * (roomMax - roomMin + 1)));
    const span = (sizes: number[]): number => sizes.reduce((a, b) => a + b, 0) - (sizes.length - 1);
    while (span(colW) > maxW) { const i = colW.indexOf(Math.max(...colW)); if (colW[i] <= roomMin) break; colW[i]--; }
    while (span(rowH) > maxH) { const i = rowH.indexOf(Math.max(...rowH)); if (rowH[i] <= roomMin) break; rowH[i]--; }
    // `biasFirst` (taverns) makes room 0 — the entrance room — the taproom, and
    // the dominant room: at least 50% larger in AREA than any side room. Because a
    // side room inherits the taproom's row height / column width along their shared
    // wall, that means colW[0] ≥ 1.5·(any other column) and rowH[0] ≥ 1.5·(any other
    // row). Grow the taproom until its 1.5-share clears the room minimum, then cap
    // every other column/row to that share.
    if (biasFirst) { dominate(colW, roomMin); dominate(rowH, roomMin); }
    const w = span(colW), h = span(rowH);
    if (w <= maxW && h <= maxH) return { cols, gridRows, colW, rowH, w, h, rooms: n };
  }
  return { cols: 1, gridRows: 1, colW: [roomMin], rowH: [roomMin], w: roomMin, h: roomMin, rooms: 1 };
}

/** Are all open (walkable) cells of a room's interior one connected region?
 *  Used to veto a piece of blocking furniture that would seal off a pocket. */
function roomInteriorConnected(c: MapCanvas, x: number, y: number, w: number, h: number): boolean {
  const ix0 = x + 1, iy0 = y + 1, ix1 = x + w - 2, iy1 = y + h - 2;
  const open: Array<[number, number]> = [];
  for (let cy = iy0; cy <= iy1; cy++) for (let cx = ix0; cx <= ix1; cx++) {
    if (!objectBlocksMovement(c.getObject(cx, cy)) && !groundBlocksMovement(c.getGround(cx, cy))) open.push([cx, cy]);
  }
  if (open.length <= 1) return true;
  const inSet = new Set(open.map(([a, b]) => `${a},${b}`));
  const seen = new Set([`${open[0][0]},${open[0][1]}`]);
  const stack: Array<[number, number]> = [open[0]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
      const k = `${a + dx},${b + dy}`;
      if (inSet.has(k) && !seen.has(k)) { seen.add(k); stack.push([a + dx, b + dy]); }
    }
  }
  return seen.size === open.length;
}

/**
 * Furnish ONE tavern room by its ROLE, doorway-aware. Tables/chairs/hearths are
 * passable decoration; only barrels/crates block, and each blocking piece is
 * vetoed if it would seal the room — so connectivity is never broken. The cell
 * just inside every doorway is kept clear so the lane through stays open.
 */
function furnishTavernRoom(c: MapCanvas, room: { x: number; y: number; w: number; h: number }, role: string, doorSides: Set<Side>, rng: () => number): void {
  const { x, y, w, h } = room;
  const ix0 = x + 1, iy0 = y + 1, ix1 = x + w - 2, iy1 = y + h - 2;
  if (ix1 < ix0 || iy1 < iy0) return; // no interior to dress

  const keep = new Set<string>();
  if (doorSides.has('N')) keep.add(`${x + (w >> 1)},${iy0}`);
  if (doorSides.has('S')) keep.add(`${x + (w >> 1)},${iy1}`);
  if (doorSides.has('W')) keep.add(`${ix0},${y + (h >> 1)}`);
  if (doorSides.has('E')) keep.add(`${ix1},${y + (h >> 1)}`);

  const free = (cx: number, cy: number): boolean =>
    cx >= ix0 && cx <= ix1 && cy >= iy0 && cy <= iy1 && c.getObject(cx, cy) === 0 && !keep.has(`${cx},${cy}`);
  // Place a piece; if it blocks movement, veto it when it would seal the interior.
  const put = (cx: number, cy: number, gid: number): boolean => {
    if (!free(cx, cy)) return false;
    c.setObject(cx, cy, gid);
    if (objectBlocksMovement(gid) && !roomInteriorConnected(c, x, y, w, h)) { c.setObject(cx, cy, 0); return false; }
    return true;
  };

  const corners = (): Point[] => [{ x: ix0, y: iy0 }, { x: ix1, y: iy0 }, { x: ix0, y: iy1 }, { x: ix1, y: iy1 }];
  // A stacked-firewood corner — homely flavour with NO open flame (taverns get no
  // campfire indoors).
  const woodpile = (): boolean => {
    for (const k of corners()) if (put(k.x, k.y, DECOR_GIDS.FIREWOOD)) return true;
    return false;
  };
  const table = (tx: number, ty: number): void => {
    if (!put(tx, ty, FURNITURE_GIDS.WOODEN_PLANK)) return;
    const want = 1 + Math.floor(rng() * 2);
    let placed = 0;
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
      if (placed >= want) break;
      if (put(tx + dx, ty + dy, FURNITURE_GIDS.CHAIR + (CHAIR_FACING[`${dx},${dy}`] ?? 0))) placed++;
    }
  };
  const midX = ix0 + ((ix1 - ix0) >> 1), midY = iy0 + ((iy1 - iy0) >> 1);
  const sideClear = (['N', 'S', 'E', 'W'] as const).find((s) => !doorSides.has(s)); // a wall with no doorway
  const wallLine = (side: Side): Array<[number, number]> => {
    const cells: Array<[number, number]> = [];
    if (side === 'N' || side === 'S') { const ry = side === 'N' ? iy0 : iy1; for (let cx = ix0; cx <= ix1; cx++) cells.push([cx, ry]); }
    else { const rx = side === 'W' ? ix0 : ix1; for (let cy = iy0; cy <= iy1; cy++) cells.push([rx, cy]); }
    return cells;
  };

  if (role === 'taproom') {
    // Bar counter (planks, barrel bookends) along a doorway-free wall.
    if (sideClear) { const line = wallLine(sideClear); line.forEach(([cx, cy], i) => put(cx, cy, i === 0 || i === line.length - 1 ? FURNITURE_GIDS.BARRELS_THREE : FURNITURE_GIDS.WOODEN_PLANK)); }
    const tables = Math.max(1, Math.min(3, Math.floor(((ix1 - ix0 + 1) * (iy1 - iy0 + 1)) / 6)));
    for (let t = 0; t < tables; t++) table(ix0 + Math.floor(rng() * (ix1 - ix0 + 1)), iy0 + Math.floor(rng() * (iy1 - iy0 + 1)));
    if (rng() < 0.5) woodpile();
    return;
  }
  if (role === 'kitchen') {
    woodpile();
    if (sideClear) for (const [cx, cy] of wallLine(sideClear)) if (rng() < 0.6) put(cx, cy, rng() < 0.5 ? DECOR_GIDS.CRATE_CLOSED : DECOR_GIDS.BARRELS_TWO);
    return;
  }
  if (role === 'cellar') {
    // Stores: barrels/crates on alternating rows, the connectivity veto carving lanes.
    for (let cy = iy0; cy <= iy1; cy += 2) for (let cx = ix0; cx <= ix1; cx++) if (rng() < 0.7) put(cx, cy, rng() < 0.5 ? DECOR_GIDS.BARRELS_TWO : DECOR_GIDS.CRATE_CLOSED);
    return;
  }
  if (role === 'snug') { table(midX, midY); return; }
  if (role === 'parlour') { woodpile(); table(midX, midY); return; }
  // guest: sparse — a single chair or crate in a corner.
  const k = corners()[Math.floor(rng() * 4)];
  put(k.x, k.y, rng() < 0.5 ? FURNITURE_GIDS.CHAIR : DECOR_GIDS.CRATE_CLOSED);
}

const TAVERN_ROLES: readonly string[] = ['kitchen', 'cellar', 'snug', 'parlour', 'guest'];

/**
 * Stamp a building / ruin / tavern into `ctx` (Phase B): a grid of shared-wall
 * rooms of VARIED sizes, linked by a spanning tree of doorways with one outer
 * (north) entrance — connected, pocket-free. `kind` selects the floor, the
 * furnishing, and the zones:
 *   • building — stone floor, sparse corner dressing, one `building` zone.
 *   • ruin     — cracked floor, crumbling walls + rubble, one `ruin` zone.
 *   • tavern   — wood floor, bigger rooms biased to a large taproom (room 0),
 *                role-furnished back rooms, a zone per room + an overall `tavern`.
 */
function stampStructure(c: MapCanvas, ctx: MapFeatureContext, kind: 'building' | 'ruin' | 'tavern', requestedRooms: number, interiorSeed?: number): OpResult {
  const { x, y } = ctx;
  const isTavern = kind === 'tavern', ruined = kind === 'ruin';
  const seed = seedFor(ctx, interiorSeed);
  const L = buildingLayout(requestedRooms, seed, ctx.w, ctx.h, isTavern ? TAVERN_ROOM_MIN : ROOM_MIN, isTavern ? TAVERN_ROOM_MAX : ROOM_MAX, isTavern);
  const rng = mulberry32(seed ^ 0x5bd1e995); // separate stream for decoration
  const xOff = (col: number): number => L.colW.slice(0, col).reduce((a, b) => a + (b - 1), 0);
  const yOff = (row: number): number => L.rowH.slice(0, row).reduce((a, b) => a + (b - 1), 0);
  const colOf = (i: number): number => i % L.cols;
  const rowOf = (i: number): number => Math.floor(i / L.cols);

  const floor: GroundMaterial = isTavern ? 'wood_floor' : ruined ? 'cracked_stone' : 'stone_floor';
  const origin: Array<{ x: number; y: number; w: number; h: number }> = [];
  const zoneCells: Point[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < L.rooms; i++) {
    const col = colOf(i), row = rowOf(i);
    const rx = x + xOff(col), ry = y + yOff(row), rw = L.colW[col], rh = L.rowH[row];
    origin.push({ x: rx, y: ry, w: rw, h: rh });
    stampRoom(c, { x: rx, y: ry, w: rw, h: rh, floor });
    for (let cy = ry; cy < ry + rh; cy++) for (let cx = rx; cx < rx + rw; cx++) {
      const k = `${cx},${cy}`;
      if (!seen.has(k)) { seen.add(k); zoneCells.push({ x: cx, y: cy }); }
    }
  }

  // Spanning-tree doorways: link each room to its left neighbour, or (first in a
  // row) the room above — through the shared wall midpoint. Track which wall side
  // of each room carries a doorway, so furnishing keeps those lanes clear.
  const doorSides: Array<Set<Side>> = origin.map(() => new Set<Side>());
  for (let i = 1; i < L.rooms; i++) {
    const col = colOf(i), r = origin[i];
    if (col > 0) { c.setObject(r.x, r.y + (r.h >> 1), 0); doorSides[i].add('W'); doorSides[i - 1].add('E'); }
    else { c.setObject(r.x + (r.w >> 1), r.y, 0); doorSides[i].add('N'); doorSides[i - L.cols].add('S'); }
  }
  c.setObject(origin[0].x + (origin[0].w >> 1), origin[0].y, 0); // outer north entrance
  doorSides[0].add('N');

  if (isTavern) {
    // Room 0 (largest, holds the entrance) is the taproom; the rest are rolled.
    for (let i = 0; i < L.rooms; i++) {
      const role = i === 0 ? 'taproom' : TAVERN_ROLES[Math.floor(rng() * TAVERN_ROLES.length)];
      furnishTavernRoom(c, origin[i], role, doorSides[i], rng);
      defineZone(c, { name: role, color: '#aa7755', rect: origin[i] });
    }
    defineZone(c, { name: 'tavern', color: '#aa7755', cells: zoneCells });
    (c.anchors.buildings ??= []).push({ x, y, w: L.w, h: L.h }); // a `building` spawn anchor
    return { ok: true, summary: `tavern ${L.rooms} room(s) at (${x},${y})` };
  }

  defineZone(c, { name: ruined ? 'ruin' : 'building', color: '#8866cc', cells: zoneCells });

  if (ruined) {
    let crumbles = 1 + Math.floor(rng() * 3);
    for (let t = 0; t < 40 && crumbles > 0; t++) {
      const p = zoneCells[Math.floor(rng() * zoneCells.length)];
      if (WALL_GID_SET.has(c.getObject(p.x, p.y) & 0x1fffffff)) {
        c.setObject(p.x, p.y, rng() < 0.5 ? 0 : DECOR_GIDS.CRATE_CLOSED);
        crumbles--;
      }
    }
  }

  // Interior dressing — only rooms with a ≥3×3 interior (≥5×5), so furniture sits
  // in corners well clear of the doorway cells. The entrance room (0) and court
  // stay clear.
  for (let i = 1; i < L.rooms; i++) {
    const r = origin[i];
    if (r.w >= 5 && r.h >= 5 && rng() < (ruined ? 0.6 : 0.85)) {
      furnishRoom(c, r.x, r.y, r.w, r.h, rng, ruined ? 'rubble' : 'living');
    }
  }

  (c.anchors.buildings ??= []).push({ x, y, w: L.w, h: L.h });
  return { ok: true, summary: `${ruined ? 'ruin' : 'building'} ${L.rooms} room(s) at (${x},${y})` };
}

// ── Recipes ───────────────────────────────────────────────────────────────────

const watchtower: MapFeatureDef = {
  id: 'watchtower', label: 'Watchtower', minW: 5, minH: 5,
  place: (c, { x, y, w, h }) => {
    const tx = x + ((w - 3) >> 1), ty = y + ((h - 3) >> 1);
    const tower = placeBuilding(c, { x: tx, y: ty, w: 3, h: 3, doorSide: 'S', name: 'watchtower' });
    if (!tower.ok) return tower;
    const fence = fenceRing(c, x, y, w, h, { x: x + (w >> 1), y: y + h - 1 });
    if (!fence.ok) return fence;
    defineZone(c, { name: 'watchtower courtyard', color: '#9a8f6a', rect: { x, y, w, h } });
    return { ok: true, summary: `watchtower ${w}×${h} at (${x},${y})` };
  },
};

const cemetery: MapFeatureDef = {
  id: 'cemetery', label: 'Cemetery', minW: 6, minH: 6,
  place: (c, { x, y, w, h }) => {
    const cryptX = x + ((w - 3) >> 1);
    const crypt = placeBuilding(c, { x: cryptX, y, w: 3, h: 3, doorSide: 'S', name: 'crypt' });
    if (!crypt.ok) return crypt;
    const gateX = x + (w >> 1);
    const fence = fenceRing(c, x, y, w, h, { x: gateX, y: y + h - 1 });
    if (!fence.ok) return fence;
    const graves: Point[] = [];
    for (let cy = y + 3; cy <= y + h - 2; cy += 2) {
      for (let cx = x + 1; cx <= x + w - 2; cx += 2) {
        if (cx === gateX || c.isReserved(cx, cy)) continue;
        graves.push({ x: cx, y: cy });
      }
    }
    if (graves.length > 0) { const r = paintRegion(c, { cells: graves, material: 'crate', layer: 'object' }); if (!r.ok) return r; }
    defineZone(c, { name: 'cemetery', color: '#6a6a78', rect: { x, y, w, h } });
    return { ok: true, summary: `cemetery ${w}×${h} at (${x},${y}), ${graves.length} graves` };
  },
};

const townSquare: MapFeatureDef = {
  id: 'town_square', label: 'Town square', minW: 7, minH: 7,
  place: (c, { x, y, w, h }) => {
    const pave = paintRegion(c, { rect: { x, y, w, h }, material: 'plaza', layer: 'ground' });
    if (!pave.ok) return pave;
    const fx = x + (w >> 1) - 1, fy = y + (h >> 1) - 1;
    const fountain = placeHazard(c, { rect: { x: fx, y: fy, w: 2, h: 2 }, material: 'pool' });
    if (!fountain.ok) return fountain;
    const stalls: Point[] = [{ x: x + 1, y: y + 1 }, { x: x + w - 2, y: y + 1 }, { x: x + 1, y: y + h - 2 }, { x: x + w - 2, y: y + h - 2 }];
    const r = paintRegion(c, { cells: stalls, material: 'barrels', layer: 'object' });
    if (!r.ok) return r;
    defineZone(c, { name: 'fountain', color: '#5a8fb0', rect: { x: fx, y: fy, w: 2, h: 2 } });
    defineZone(c, { name: 'town square', color: '#b0a070', rect: { x, y, w, h } });
    return { ok: true, summary: `town square ${w}×${h} at (${x},${y})` };
  },
};

const buildingFootprint = (p: PlaceableParams, maxW: number, maxH: number): { w: number; h: number } => {
  const L = buildingLayout(p.rooms ?? 1, (p.interiorSeed ?? 0) & 0xffffffff, maxW, maxH);
  return { w: L.w, h: L.h };
};

const tavernFootprint = (p: PlaceableParams, maxW: number, maxH: number): { w: number; h: number } => {
  const L = buildingLayout(p.rooms ?? 2, (p.interiorSeed ?? 0) & 0xffffffff, maxW, maxH, TAVERN_ROOM_MIN, TAVERN_ROOM_MAX, true);
  return { w: L.w, h: L.h };
};

/** Tavern (Phase B → v2) — a multi-room establishment: a large taproom (bar,
 *  tables, hearth) plus rolled back rooms (kitchen, cellar, snug, parlour, guest),
 *  all connected with one outer entrance. `rooms` sizes it; the interior re-rolls
 *  from `interiorSeed`. */
const tavern: MapFeatureDef = {
  id: 'tavern', label: 'Tavern', minW: TAVERN_ROOM_MIN, minH: TAVERN_ROOM_MIN,
  desiredFootprint: tavernFootprint,
  place: (c, ctx, p) => stampStructure(c, ctx, 'tavern', p.rooms ?? 2, p.interiorSeed),
};

const building: MapFeatureDef = {
  id: 'building', label: 'Building', minW: ROOM_MIN, minH: ROOM_MIN,
  desiredFootprint: buildingFootprint,
  place: (c, ctx, p) => stampStructure(c, ctx, 'building', p.rooms ?? 1, p.interiorSeed),
};

const ruin: MapFeatureDef = {
  id: 'ruin', label: 'Ruin', minW: ROOM_MIN, minH: ROOM_MIN,
  desiredFootprint: buildingFootprint,
  place: (c, ctx, p) => stampStructure(c, ctx, 'ruin', p.rooms ?? 1, p.interiorSeed),
};

// ── Wilderness set-pieces (Roadmap v2 · M3/#8) ──────────────────────────────────

/** Shrine — a paved dais ringed by a dotted colonnade (a ruined ring, some
 *  pillars missing) around a central altar with flower offerings. The dotted ring
 *  is always walkable; the interior is open. */
const shrine: MapFeatureDef = {
  id: 'shrine', label: 'Shrine', minW: 7, minH: 7,
  desiredFootprint: () => ({ w: 7, h: 7 }),
  place: (c, { x, y, w, h }, p) => {
    const rng = mulberry32(seedFor({ x, y, w, h }, p.interiorSeed));
    paintRegion(c, { rect: { x, y, w, h }, material: 'plaza', layer: 'ground' });
    const pillars: Point[] = [];
    for (let cx = x; cx < x + w; cx += 2) { pillars.push({ x: cx, y }); pillars.push({ x: cx, y: y + h - 1 }); }
    for (let cy = y + 2; cy < y + h - 1; cy += 2) { pillars.push({ x, y: cy }); pillars.push({ x: x + w - 1, y: cy }); }
    const kept = pillars.filter(() => rng() > 0.18); // ~18% missing → a ruined ring
    if (kept.length) paintRegion(c, { cells: kept, material: 'crate', layer: 'object' });
    const ax = x + (w >> 1), ay = y + (h >> 1);
    paintRegion(c, { cells: [{ x: ax, y: ay }], material: 'cracked_stone', layer: 'ground' });
    paintRegion(c, { cells: [{ x: ax - 1, y: ay }, { x: ax + 1, y: ay }], material: 'flowers', layer: 'object' });
    defineZone(c, { name: 'altar', color: '#d8c46a', rect: { x: ax, y: ay, w: 1, h: 1 } });
    defineZone(c, { name: 'shrine', color: '#b0a0d0', rect: { x, y, w, h } });
    return { ok: true, summary: `shrine ${w}×${h} at (${x},${y})` };
  },
};

/** Farmstead — a fenced field (one gate) with a small farmhouse in a corner and
 *  passable crop rows (flowers) striping the open ground. */
const farmstead: MapFeatureDef = {
  id: 'farmstead', label: 'Farmstead', minW: 9, minH: 8,
  desiredFootprint: () => ({ w: 10, h: 8 }),
  place: (c, { x, y, w, h }) => {
    placeBuilding(c, { x: x + 1, y: y + 1, w: 4, h: 4, doorSide: 'S', name: 'farmhouse' });
    fenceRing(c, x, y, w, h, { x: x + (w >> 1), y: y + h - 1 }); // a south gate
    for (let cy = y + 6; cy <= y + h - 2; cy += 2) {
      const row: Point[] = [];
      for (let cx = x + 1; cx <= x + w - 2; cx++) if (!c.isReserved(cx, cy)) row.push({ x: cx, y: cy });
      if (row.length) paintRegion(c, { cells: row, material: 'flowers', layer: 'object' });
    }
    defineZone(c, { name: 'field', color: '#9bbf6a', rect: { x, y, w, h } });
    defineZone(c, { name: 'farmstead', color: '#caa46a', rect: { x, y, w, h } });
    return { ok: true, summary: `farmstead ${w}×${h} at (${x},${y})` };
  },
};

/** Mine — a dug-out adit: a cracked-stone apron with a stairs-down shaft at the
 *  back and a few cart props (cover) to the sides. Open, no walls. */
const mine: MapFeatureDef = {
  id: 'mine', label: 'Mine', minW: 6, minH: 5,
  desiredFootprint: () => ({ w: 7, h: 5 }),
  place: (c, { x, y, w, h }, p) => {
    const rng = mulberry32(seedFor({ x, y, w, h }, p.interiorSeed));
    paintRegion(c, { rect: { x, y, w, h }, material: 'cracked_stone', layer: 'ground' });
    const sx = x + (w >> 1), sy = y + 1;
    paintRegion(c, { cells: [{ x: sx, y: sy }], material: 'stairs', layer: 'object' });
    defineZone(c, { name: 'mine shaft', color: '#8a8a8a', rect: { x: sx, y: sy, w: 1, h: 1 } });
    const props: Point[] = [{ x: x, y: y + h - 1 }, { x: x + w - 1, y: y + h - 1 }, { x: x + 1, y: y + h - 2 }, { x: x + w - 2, y: y + h - 2 }];
    const kept = props.filter(() => rng() < 0.75);
    if (kept.length) paintRegion(c, { cells: kept, material: 'crate', layer: 'object' });
    defineZone(c, { name: 'mine', color: '#9a8466', rect: { x, y, w, h } });
    return { ok: true, summary: `mine ${w}×${h} at (${x},${y})` };
  },
};

/** Bandit hideout — a ruined stockade (cracked-stone enclosure with a sally-port
 *  gap and a couple of broken wall segments), scattered cover, and a campfire. */
const banditHideout: MapFeatureDef = {
  id: 'bandit_hideout', label: 'Bandit hideout', minW: 7, minH: 6,
  desiredFootprint: () => ({ w: 8, h: 6 }),
  place: (c, { x, y, w, h }, p) => {
    const rng = mulberry32(seedFor({ x, y, w, h }, p.interiorSeed));
    const side = (['N', 'S', 'E', 'W'] as const)[Math.floor(rng() * 4)];
    const gap = side === 'N' ? { x: x + (w >> 1), y } : side === 'S' ? { x: x + (w >> 1), y: y + h - 1 }
      : side === 'W' ? { x, y: y + (h >> 1) } : { x: x + w - 1, y: y + (h >> 1) };
    stampRoom(c, { x, y, w, h, floor: 'cracked_stone', doorways: [gap] });
    let breaks = 1 + Math.floor(rng() * 2);
    for (let t = 0; t < 24 && breaks > 0; t++) {
      const onTopBot = rng() < 0.5;
      const cell = onTopBot
        ? { x: x + 1 + Math.floor(rng() * (w - 2)), y: rng() < 0.5 ? y : y + h - 1 }
        : { x: rng() < 0.5 ? x : x + w - 1, y: y + 1 + Math.floor(rng() * (h - 2)) };
      if (WALL_GID_SET.has(c.getObject(cell.x, cell.y) & 0x1fffffff)) { c.setObject(cell.x, cell.y, 0); breaks--; }
    }
    c.setObject(x + 1, y + h - 2, DECOR_GIDS.CRATE_CLOSED);
    c.setObject(x + w - 2, y + 1, DECOR_GIDS.BARRELS_TWO);
    c.setObject(x + (w >> 1), y + (h >> 1), DECOR_GIDS.CAMPFIRE); // a camp's open fire — fine outdoors
    defineZone(c, { name: 'hideout', color: '#7a6a55', rect: { x, y, w, h } });
    return { ok: true, summary: `bandit hideout ${w}×${h} at (${x},${y})` };
  },
};

// ── Registry ───────────────────────────────────────────────────────────────────

/** Placeable id → definition. Add a structure by adding an entry; nothing else. */
export const FEATURE_REGISTRY: Record<string, MapFeatureDef> = {
  [watchtower.id]: watchtower,
  [cemetery.id]: cemetery,
  [townSquare.id]: townSquare,
  [tavern.id]: tavern,
  [building.id]: building,
  [ruin.id]: ruin,
  [shrine.id]: shrine,
  [farmstead.id]: farmstead,
  [mine.id]: mine,
  [banditHideout.id]: banditHideout,
};

export const FEATURE_IDS: readonly string[] = Object.keys(FEATURE_REGISTRY);

/** Desired footprint for a placeable + params, clamped to [min, max]. */
function footprintOf(def: MapFeatureDef, params: PlaceableParams, maxW: number, maxH: number): { w: number; h: number } {
  const raw = def.desiredFootprint
    ? def.desiredFootprint(params, maxW, maxH)
    : { w: Math.max(def.minW, PREVIEW_SIZE), h: Math.max(def.minH, PREVIEW_SIZE) };
  return { w: Math.max(def.minW, Math.min(maxW, raw.w)), h: Math.max(def.minH, Math.min(maxH, raw.h)) };
}

/**
 * Stamp a registered placeable into an explicit footprint (used by the agentic
 * builder + a quick preview). Validates id + footprint, then delegates.
 */
export function placeFeature(c: MapCanvas, id: string, ctx: MapFeatureContext, params: PlaceableParams = {}): OpResult {
  const def = FEATURE_REGISTRY[id];
  if (!def) return { ok: false, error: `unknown placeable "${id}" (have: ${FEATURE_IDS.join(', ')})` };
  const x = Math.floor(ctx.x), y = Math.floor(ctx.y), w = Math.floor(ctx.w), h = Math.floor(ctx.h);
  if (w < def.minW || h < def.minH) return { ok: false, error: `${def.label} needs at least ${def.minW}×${def.minH} (got ${w}×${h})` };
  if (x < 0 || y < 0 || x + w > c.width || y + h > c.height) return { ok: false, error: `${def.label} ${w}×${h} at (${x},${y}) is out of bounds` };
  return def.place(c, { x, y, w, h }, params);
}

// ── Conscious placement ─────────────────────────────────────────────────────────

const PATH_GID_SET = new Set([PATH_GIDS.V, PATH_GIDS.H, PATH_GIDS.INTERSECTION, PATH_GIDS.CORNER_SE, PATH_GIDS.CORNER_SW, PATH_GIDS.CORNER_NW, PATH_GIDS.CORNER_NE].map((g) => g & 0x1fffffff));

/** A cell a placeable must NOT overwrite: a blocking object, a road tile, or
 *  blocking ground (water/chasm/void). Used for the placement SCORE (soft). */
function isHardCell(c: MapCanvas, x: number, y: number): boolean {
  const obj = c.getObject(x, y) & 0x1fffffff;
  if (obj !== 0) {
    if (objectBlocksMovement(obj)) return true;
    if (PATH_GID_SET.has(obj)) return true;
  }
  return groundBlocksMovement(c.getGround(x, y));
}

/** A cell a placeable's FOOTPRINT may never sit on — a road tile or an existing
 *  structure wall. These are NOT cleared (that would cut the road / merge two
 *  buildings), so the footprint must avoid them entirely. Trees / water are not
 *  forbidden (`clearFootprint` tidies them). This is the hard guarantee that a
 *  path never collides with a structure, and structures never overlap. */
function isForbiddenCell(c: MapCanvas, x: number, y: number): boolean {
  const obj = c.getObject(x, y) & 0x1fffffff;
  return obj !== 0 && (PATH_GID_SET.has(obj) || WALL_GID_SET.has(obj));
}

/**
 * Find where to drop a `fw × fh` footprint so it disturbs the terrain least.
 * Scores every candidate (footprint + 1-tile border) by overlapped obstacles
 * (footprint weighted heavier), lowest wins, ties break toward the map centre.
 * `allowed`, when given (region targeting, Phase B), constrains the footprint to
 * lie wholly inside that cell set.
 */
function findFeaturePlacement(c: MapCanvas, fw: number, fh: number, allowed?: Set<string>): { x: number; y: number; score: number } {
  const cx = (c.width - fw) / 2, cy = (c.height - fh) / 2;
  const maxX = c.width - fw - 1, maxY = c.height - fh - 1;
  let best = { x: (c.width - fw) >> 1, y: (c.height - fh) >> 1, score: Infinity };
  let bestDist = Infinity;
  for (let y = 1; y <= maxY; y++) {
    for (let x = 1; x <= maxX; x++) {
      if (allowed && !footprintInside(allowed, x, y, fw, fh)) continue;
      let score = 0;
      let forbidden = false;
      for (let ry = y - 1; ry <= y + fh && !forbidden; ry++) {
        for (let rx = x - 1; rx <= x + fw; rx++) {
          const inFoot = rx >= x && rx < x + fw && ry >= y && ry < y + fh;
          // A road / existing wall in the FOOTPRINT is a hard reject — never
          // overwrite it (that's the path-vs-structure collision).
          if (inFoot && isForbiddenCell(c, rx, ry)) { forbidden = true; break; }
          if (isHardCell(c, rx, ry)) score += inFoot ? 3 : 1;
        }
      }
      if (forbidden || score > best.score) continue;
      const dist = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      if (score < best.score || dist < bestDist) { best = { x, y, score }; bestDist = dist; }
    }
  }
  return best;
}

function footprintInside(allowed: Set<string>, x: number, y: number, fw: number, fh: number): boolean {
  for (let cy = y; cy < y + fh; cy++) for (let cx = x; cx < x + fw; cx++) if (!allowed.has(`${cx},${cy}`)) return false;
  return true;
}

/** Clear a footprint (+1 buffer) so a placeable never collides: remove objects
 *  (trees/paths/decor), and lift blocking ground (water/chasm/void) to grass. */
function clearFootprint(c: MapCanvas, x: number, y: number, w: number, h: number): void {
  const grass = groundGid('grass')!;
  for (let cy = y - 1; cy < y + h + 1; cy++) {
    for (let cx = x - 1; cx < x + w + 1; cx++) {
      if (!c.inBounds(cx, cy)) continue;
      const inFoot = cx >= x && cx < x + w && cy >= y && cy < y + h;
      c.setObject(cx, cy, 0);
      if (inFoot && groundBlocksMovement(c.getGround(cx, cy))) c.setGround(cx, cy, grass);
    }
  }
}

/**
 * Place ONE placeable consciously and stamp it, returning the placement score
 * (0 = nothing overwritten) and a record (footprint + interiorSeed) for in-place
 * re-roll. `allowed` restricts placement to a region's cells. Returns null if it
 * can't fit (too big / no allowed spot).
 */
function stampPlaceableBestFit(c: MapCanvas, spec: StampSpec, allowed?: Set<string>): { score: number; record: PlacementRecord } | null {
  const def = FEATURE_REGISTRY[spec.id];
  if (!def) throw new Error(`unknown placeable "${spec.id}" (have: ${FEATURE_IDS.join(', ')})`);
  const params = { ...(spec.params ?? {}) };
  // Resolve a concrete interior seed (drawn from the map RNG when unset) and
  // record it, so this structure can be re-rolled in place later.
  if (params.interiorSeed === undefined) params.interiorSeed = (Math.floor(c.rng() * 0xffffffff)) >>> 0;
  const maxW = c.width - MARGIN * 2, maxH = c.height - MARGIN * 2;
  if (def.minW > maxW || def.minH > maxH) return null; // map can't fit even the minimum
  const { w, h } = footprintOf(def, params, maxW, maxH);
  if (w < def.minW || h < def.minH) return null;
  const { x, y, score } = findFeaturePlacement(c, w, h, allowed);
  if (!Number.isFinite(score)) return null;            // no spot clear of roads/walls
  if (allowed && !footprintInside(allowed, x, y, w, h)) return null; // region too small
  clearFootprint(c, x, y, w, h);
  const res = def.place(c, { x, y, w, h }, params);
  if (!res.ok) throw new Error(res.error);
  return { score, record: { id: def.id, label: def.label, x, y, w, h, rooms: params.rooms, interiorSeed: params.interiorSeed } };
}

// ── Compose / stamp entry points ────────────────────────────────────────────────

/** Region zones (one per band) from a composed big map, in region order. */
function regionZoneCells(base: ComposedMap): string[][] {
  return (base.zones ?? []).filter((z) => z.id.includes('_region_')).map((z) => z.cells);
}

/** Rehydrate a composed map's grids onto a fresh canvas (seeded for new RNG). */
function rehydrate(base: ComposedMap, seed: number): MapCanvas {
  const c = new MapCanvas({ width: base.width, height: base.height, seed: seed & 0xffffffff });
  for (let y = 0; y < base.height; y++) for (let x = 0; x < base.width; x++) {
    const i = y * base.width + x;
    c.setGround(x, y, base.terrainData[i]);
    c.setObject(x, y, base.objectData[i]);
  }
  return c;
}

/**
 * Stamp a LIST of placeables onto an already-composed base — the unified "place
 * structures on any map" path. Each is placed consciously (clear spot, biased
 * central, optionally within a target region), the spot cleared, then stamped;
 * later ones avoid earlier ones. Records each placement for in-place re-roll.
 * Returns the merged map + the summed placement score (0 = all fit cleanly).
 */
export function stampExtrasOnto(base: ComposedMap, stamps: StampSpec[], seed = 0): { map: ComposedMap; score: number } {
  const c = rehydrate(base, seed);
  const regionCells = regionZoneCells(base);
  const labels: string[] = [];
  const records: PlacementRecord[] = [];
  let score = 0;
  for (const s of stamps) {
    const allowed = s.region !== undefined && regionCells[s.region] ? new Set(regionCells[s.region]) : undefined;
    const r = stampPlaceableBestFit(c, s, allowed);
    if (!r) continue;
    score += r.score; labels.push(FEATURE_REGISTRY[s.id].label); records.push(r.record);
  }
  const out = c.toComposedMap(`${base.name}${labels.length ? ' + ' + labels.join(' + ') : ''}`, base.description);
  out.zones = [...(base.zones ?? []), ...(out.zones ?? [])];
  out.anchors = { ...base.anchors, ...c.anchors, buildings: [...(base.anchors.buildings ?? []), ...(c.anchors.buildings ?? [])] };
  if (records.length || base.placements) out.placements = [...(base.placements ?? []), ...records];
  return { map: out, score };
}

/** Back-compat single-placeable wrapper. */
export function stampFeatureOnto(base: ComposedMap, feature: string, seed = 0): { map: ComposedMap; score: number } {
  return stampExtrasOnto(base, [{ id: feature }], seed);
}

/**
 * Re-roll ONE placeable's interior IN PLACE (Phase B): re-run its recipe at its
 * recorded footprint with a fresh interior seed, leaving every other cell of the
 * map untouched. The shell stays put; only the interior changes. `placementIndex`
 * indexes `base.placements`.
 */
export function restampPlaceable(base: ComposedMap, placementIndex: number, newInteriorSeed: number): ComposedMap {
  const placements = base.placements ?? [];
  const p = placements[placementIndex];
  if (!p) throw new Error(`no placement at index ${placementIndex}`);
  const c = rehydrate(base, newInteriorSeed);
  clearFootprint(c, p.x, p.y, p.w, p.h);
  const res = placeFeature(c, p.id, { x: p.x, y: p.y, w: p.w, h: p.h }, { rooms: p.rooms, interiorSeed: newInteriorSeed });
  if (!res.ok) throw new Error(res.error);
  // Preserve the base's zones EXCEPT this placeable's old zone(s) under the
  // footprint; re-add the freshly emitted ones.
  const inFoot = (cells: string[]): boolean => cells.some((k) => { const [x, y] = k.split(',').map(Number); return x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h; });
  const keptZones = (base.zones ?? []).filter((z) => !(z.id.includes('_region_') === false && inFoot(z.cells)));
  const out = c.toComposedMap(base.name, base.description);
  out.zones = [...keptZones, ...(out.zones ?? [])];
  out.anchors = base.anchors;
  out.placements = placements.map((rec, i) => i === placementIndex ? { ...rec, interiorSeed: newInteriorSeed } : rec);
  return out;
}

/** Compose a flat field with ONE placeable centred — the "show me this" preview. */
export function composeFeatureMap(opts: { width: number; height: number; seed?: number; feature: string; params?: PlaceableParams; baseMaterial?: GroundMaterial }): ComposedMap {
  const def = FEATURE_REGISTRY[opts.feature];
  if (!def) throw new Error(`unknown placeable "${opts.feature}" (have: ${FEATURE_IDS.join(', ')})`);
  const c = new MapCanvas({ width: opts.width, height: opts.height, seed: (opts.seed ?? 0) & 0xffffffff });
  const fill = fillTerrain(c, { material: opts.baseMaterial ?? 'grass' });
  if (!fill.ok) throw new Error(fill.error);
  const r = stampPlaceableBestFit(c, { id: opts.feature, params: opts.params });
  if (!r) throw new Error(`map ${opts.width}×${opts.height} too small for ${def.label}`);
  const out = c.toComposedMap(def.label, `A ${def.label.toLowerCase()} on an open field.`);
  out.placements = [r.record];
  return out;
}

// ── Big-map roads (Phase A5 + Phase B winding) ──────────────────────────────────

function pathGidForMask(n: boolean, s: boolean, e: boolean, w: boolean): number {
  const mask = (n ? 8 : 0) | (s ? 4 : 0) | (e ? 2 : 0) | (w ? 1 : 0);
  switch (mask) {
    case 0b1100: return PATH_GIDS.V;
    case 0b0011: return PATH_GIDS.H;
    case 0b1111: return PATH_GIDS.INTERSECTION;
    case 0b0110: return PATH_GIDS.CORNER_SE;
    case 0b0101: return PATH_GIDS.CORNER_SW;
    case 0b1001: return PATH_GIDS.CORNER_NW;
    case 0b1010: return PATH_GIDS.CORNER_NE;
    case 0b1000: case 0b0100: return PATH_GIDS.V;
    case 0b0010: case 0b0001: return PATH_GIDS.H;
    case 0b1110: case 0b1101: case 0b1011: case 0b0111: return PATH_GIDS.INTERSECTION;
    default: return PATH_GIDS.H;
  }
}

/** A cell a road can occupy: passable open ground (not void/water/hazard) and not
 *  a wall. */
function roadable(c: MapCanvas, x: number, y: number): boolean {
  const g = c.getGround(x, y) & 0x1fffffff;
  if (g === 0 || groundBlocksMovement(g)) return false;
  return !WALL_GID_SET.has(c.getObject(x, y) & 0x1fffffff);
}

/**
 * A WINDING road as an ordered single-thread staircase (Phase B): walk the main
 * axis from edge to edge, occasionally jogging ONE cell on the cross axis (then
 * forcing a horizontal step) so the road meanders within `maxDev` of `centre`.
 * Because it's a simple thread — every cell adjacent only to its neighbours in
 * the walk — bends auto-tile to CORNER tiles, never T-junctions (which would
 * fall back to the 4-way intersection tile). The intersection tile then appears
 * only where two roads genuinely cross.
 */
function windingThread(len: number, centre: number, maxDev: number, rng: () => number): Array<[number, number]> {
  const cells: Array<[number, number]> = [];
  let main = 0, cross = centre;
  cells.push([main, cross]);
  let lastWasJog = false;
  while (main < len - 1) {
    if (!lastWasJog && rng() < 0.22) {
      let dir = cross > centre ? -1 : cross < centre ? 1 : (rng() < 0.5 ? -1 : 1);
      if (rng() < 0.25) dir = -dir; // occasionally drift outward
      const nc = cross + dir;
      if (nc >= centre - maxDev && nc <= centre + maxDev) { cross = nc; cells.push([main, cross]); lastWasJog = true; continue; }
    }
    main++; cells.push([main, cross]); lastWasJog = false;
  }
  return cells;
}

/**
 * Route a road between two cells (Roadmap v2 · G2) — a shortest 4-connected path
 * over `roadable` cells (avoiding `blocked`), as an ordered cell list. `goal` is
 * always reachable even if not itself roadable (it's the cell at a structure's
 * doorstep). Returns null if no route exists.
 */
function routeThread(c: MapCanvas, start: [number, number], goal: [number, number], blocked: Set<string>): Array<[number, number]> | null {
  const key = (x: number, y: number): string => `${x},${y}`;
  const prev = new Map<string, string | null>([[key(start[0], start[1]), null]]);
  const q: Array<[number, number]> = [start];
  const gk = key(goal[0], goal[1]);
  while (q.length) {
    const [x, y] = q.shift()!;
    if (x === goal[0] && y === goal[1]) break;
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
      const nx = x + dx, ny = y + dy, kk = key(nx, ny);
      if (!c.inBounds(nx, ny) || prev.has(kk)) continue;
      const isGoal = nx === goal[0] && ny === goal[1];
      if (!isGoal && (!roadable(c, nx, ny) || blocked.has(kk))) continue;
      prev.set(kk, key(x, y));
      q.push([nx, ny]);
    }
  }
  if (!prev.has(gk)) return null;
  const path: Array<[number, number]> = [];
  let cur: string | null = gk;
  while (cur) { const [x, y] = cur.split(',').map(Number); path.push([x, y]); cur = prev.get(cur) ?? null; }
  return path.reverse();
}

/**
 * Lay a road from a map edge up to each placed structure's doorstep (Roadmap v2 ·
 * M4/#4) — "a path leading to the tavern". Routes avoid every other footprint and
 * merge with any existing road network (auto-tiled, intersection tiles only where
 * roads truly cross). Idempotent-ish: re-tiles all path cells from the union.
 */
export function connectPlaceablesByRoad(base: ComposedMap, seed = 1): ComposedMap {
  const placements = base.placements ?? [];
  if (placements.length === 0) return base;
  const c = rehydrate(base, seed);

  // Footprint interiors are off-limits to a road (it must arrive at the wall, not
  // cut through). The 1-ring is left open so the road can reach the doorstep.
  const blocked = new Set<string>();
  for (const p of placements) for (let yy = p.y; yy < p.y + p.h; yy++) for (let xx = p.x; xx < p.x + p.w; xx++) blocked.add(`${xx},${yy}`);

  const pathCells = new Set<string>();
  for (const z of base.zones ?? []) if (z.name === 'path') for (const cell of z.cells) pathCells.add(cell);

  for (const p of placements) {
    const target = doorstep(c, p, blocked);
    if (!target) continue;
    const start = nearestEdgeRoadable(c, target, blocked);
    if (!start) continue;
    const route = routeThread(c, start, target, blocked);
    if (route) for (const [x, y] of route) pathCells.add(`${x},${y}`);
  }

  const inPath = (x: number, y: number): boolean => pathCells.has(`${x},${y}`);
  for (const k of pathCells) {
    const [x, y] = k.split(',').map(Number);
    c.setObject(x, y, pathGidForMask(inPath(x, y - 1), inPath(x, y + 1), inPath(x + 1, y), inPath(x - 1, y)));
    c.reserve(x, y);
  }
  const out = c.toComposedMap(base.name, base.description);
  out.zones = [...(base.zones ?? []).filter((z) => z.name !== 'path')];
  if (pathCells.size > 0) out.zones.push({ id: `zone_path_${(seed >>> 0).toString(16)}`, name: 'path', color: '#cc9966', cells: [...pathCells].sort() });
  out.anchors = base.anchors;
  out.placements = base.placements;
  return out;
}

/** A roadable cell orthogonally adjacent to a footprint (the doorstep), preferring
 *  the side facing a map edge so the approach reads naturally. */
function doorstep(c: MapCanvas, p: PlacementRecord, blocked: Set<string>): [number, number] | null {
  const mid = (a: number, b: number): number => a + (b >> 1);
  const cands: Array<[number, number]> = [
    [mid(p.x, p.w), p.y + p.h], [mid(p.x, p.w), p.y - 1],
    [p.x - 1, mid(p.y, p.h)], [p.x + p.w, mid(p.y, p.h)],
  ];
  let best: [number, number] | null = null, bestEdge = Infinity;
  for (const [x, y] of cands) {
    if (!c.inBounds(x, y) || blocked.has(`${x},${y}`) || !roadable(c, x, y)) continue;
    const edge = Math.min(x, y, c.width - 1 - x, c.height - 1 - y);
    if (edge < bestEdge) { best = [x, y]; bestEdge = edge; }
  }
  return best;
}

/** The roadable map-edge cell nearest a target (scans the 4 borders). */
function nearestEdgeRoadable(c: MapCanvas, target: [number, number], blocked: Set<string>): [number, number] | null {
  let best: [number, number] | null = null, bestD = Infinity;
  const consider = (x: number, y: number): void => {
    if (blocked.has(`${x},${y}`) || !roadable(c, x, y)) return;
    const d = Math.abs(x - target[0]) + Math.abs(y - target[1]);
    if (d < bestD) { best = [x, y]; bestD = d; }
  };
  for (let x = 0; x < c.width; x++) { consider(x, 0); consider(x, c.height - 1); }
  for (let y = 0; y < c.height; y++) { consider(0, y); consider(c.width - 1, y); }
  return best;
}

/**
 * Lay roads onto a big map — the `path` / `intersection` features. A WINDING road
 * runs the long axis through the map centre (crossing the bands); `intersection`
 * adds the perpendicular cross-road. Roads paint only on `roadable` cells outside
 * `exclude` (cave/dungeon regions), clearing decoration and stopping at
 * walls/water. Structures stamped afterwards avoid the road tiles.
 */
export function applyBigMapRoads(base: ComposedMap, features: Feature[], exclude: Set<string> = new Set()): ComposedMap {
  if (!features.includes('path') && !features.includes('intersection')) return base;
  const c = rehydrate(base, 1);
  const roadHere = (x: number, y: number): boolean => roadable(c, x, y) && !exclude.has(`${x},${y}`);
  const horizontal = c.width >= c.height;
  const orientations: Array<'h' | 'v'> = features.includes('intersection') ? ['h', 'v'] : [horizontal ? 'h' : 'v'];

  const pathCells = new Set<string>();
  const add = (x: number, y: number): void => { if (roadHere(x, y)) pathCells.add(`${x},${y}`); };
  for (const o of orientations) {
    // 'h' walks along x with the cross axis y; 'v' the reverse.
    const thread = o === 'h'
      ? windingThread(c.width, c.height >> 1, Math.min(4, c.height >> 2), c.rng)
      : windingThread(c.height, c.width >> 1, Math.min(4, c.width >> 2), c.rng);
    for (const [main, cross] of thread) { if (o === 'h') add(main, cross); else add(cross, main); }
  }
  const inPath = (x: number, y: number): boolean => pathCells.has(`${x},${y}`);
  for (const k of pathCells) {
    const [x, y] = k.split(',').map(Number);
    c.setObject(x, y, pathGidForMask(inPath(x, y - 1), inPath(x, y + 1), inPath(x + 1, y), inPath(x - 1, y)));
    c.reserve(x, y);
  }
  if (pathCells.size > 0) c.addZone('path', 'path', '#cc9966', pathCells);

  const out = c.toComposedMap(base.name, base.description);
  out.zones = [...(base.zones ?? []), ...(out.zones ?? [])];
  out.anchors = { ...base.anchors, ...c.anchors };
  if (base.placements) out.placements = base.placements;
  return out;
}
