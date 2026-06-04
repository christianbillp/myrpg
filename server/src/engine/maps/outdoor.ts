/**
 * Outdoor composer — grassland and forest terrains with optional features
 * (coastline / path / intersection / buildings / campsites).
 *
 * Every cell starts as a biome-palette ground tile (grass-dominant) and
 * features layer on top:
 *   1. Coastline carves a water strip on a random edge (so subsequent
 *      placers can detect water and avoid it).
 *   2. Path / intersection stamps dirt paths on the object layer (terrain
 *      stays as natural ground), emitting `path` / `intersection` zones.
 *   3. Buildings stamp stone-floor rectangles with transparent walls on the
 *      object layer, emitting `building <n>` zones each.
 *   4. Campsites scatter campfires on dry ground.
 *   5. A final decoration pass sprinkles palette objects (trees, flowers)
 *      on every untouched natural-ground cell.
 *
 * All feature placers respect a shared `reserved: Set<string>` so a path
 * never overlaps a building and vice versa.
 */
import { BIOME_PALETTES, pickGroundGid, rollObjectGid, type BiomePalette } from '../../../../shared/biomePalettes.js';
import type { ComposedMap, ComposedTilesetRef, Feature, MapAnchors, MapZone, Terrain } from '../mapTypes.js';
import { DECOR_GIDS, PATH_GIDS, TERRAIN_GIDS, WALL_GIDS, WATER_FIRSTGID, WATER_GIDS } from '../mapTiles.js';
import { SCRIBBLE_TILESET, WATER_TILESET, flatten } from './shared.js';

export interface ComposeOutdoorOpts {
  width: number;
  height: number;
  terrain: 'grassland' | 'forest';
  features: Feature[];
  buildingsCount?: number;
  rng: () => number;
  allocZoneId: (kind: string) => string;
}

export function composeOutdoor(opts: ComposeOutdoorOpts): ComposedMap {
  const { width, height, terrain, features, rng, allocZoneId } = opts;
  const palette = BIOME_PALETTES[terrain];

  // Terrain layer — fill with the biome's natural ground.
  const terrainGrid: number[][] = [];
  const objectGrid: number[][]  = [];
  for (let r = 0; r < height; r++) {
    const row: number[] = new Array<number>(width);
    for (let c = 0; c < width; c++) row[c] = pickGroundGid(palette, rng);
    terrainGrid.push(row);
    objectGrid.push(new Array<number>(width).fill(0));
  }

  // Feature placement. Coastline first so other placers can detect water;
  // paths next (they paint object-layer tiles); buildings next (avoid path
  // cells via the shared `reserved` set); campsites last.
  const anchors: MapAnchors = {};
  const zones: MapZone[] = [];
  const reserved = new Set<string>();
  const usesWater = features.includes('coastline');
  if (usesWater) placeCoastline(terrainGrid, objectGrid, rng, width, height, anchors);
  if (features.includes('path') || features.includes('intersection')) {
    placePath(terrainGrid, objectGrid, rng, width, height, anchors, zones, reserved, allocZoneId, {
      intersection: features.includes('intersection'),
      coastline: usesWater,
    });
  }
  if (features.includes('buildings')) {
    placeBuildings(terrainGrid, objectGrid, rng, width, height, opts.buildingsCount ?? 1, anchors, zones, reserved, allocZoneId);
  }
  if (features.includes('campsites')) placeCampsites(terrainGrid, objectGrid, rng, width, height, anchors);

  applyObjectPool(palette, terrainGrid, objectGrid, rng, width, height);

  const tilesets: ComposedTilesetRef[] = usesWater ? [SCRIBBLE_TILESET, WATER_TILESET] : [SCRIBBLE_TILESET];
  return {
    width, height,
    terrainData: flatten(terrainGrid),
    objectData: flatten(objectGrid),
    name: composeOutdoorName(terrain, features),
    description: composeOutdoorDescription(terrain, features, anchors, width, height),
    tilesets,
    anchors,
    ...(zones.length > 0 ? { zones } : {}),
  };
}

// ── Decoration pass ─────────────────────────────────────────────────────────

function applyObjectPool(
  palette: BiomePalette,
  terrain: number[][],
  objects: number[][],
  rng: () => number,
  W: number, H: number,
): void {
  if (palette.objectPool.length === 0) return;
  const naturalGround = new Set(palette.groundPool.map((e) => e.gid));
  const isWall = (x: number, y: number): boolean => {
    if (x < 0 || x >= W || y < 0 || y >= H) return false;
    const g = terrain[y][x] & 0x1fffffff;
    return !naturalGround.has(g);
  };
  const flat = new Array<number>(W * H).fill(0);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) flat[r * W + c] = objects[r][c];

  const SOUTH_BUFFER = 3;
  for (let r = 0; r < H - SOUTH_BUFFER; r++) {
    for (let c = 0; c < W; c++) {
      if (objects[r][c] !== 0) continue;
      const ground = terrain[r][c] & 0x1fffffff;
      if (!naturalGround.has(ground)) continue;
      const gid = rollObjectGid(palette, rng, c, r, W, H, flat, isWall);
      if (gid !== 0) {
        objects[r][c] = gid;
        flat[r * W + c] = gid;
      }
    }
  }
}

// ── Water helpers + coastline ──────────────────────────────────────────────

function isWaterCell(terrain: number[][], r: number, c: number, W: number, H: number): boolean {
  if (r < 0 || r >= H || c < 0 || c >= W) return false;
  const gid = terrain[r][c];
  return gid >= WATER_FIRSTGID && gid < WATER_FIRSTGID + 16;
}

function rectTouchesWater(terrain: number[][], x: number, y: number, w: number, h: number, W: number, H: number): boolean {
  for (let r = y; r < y + h; r++) {
    for (let c = x; c < x + w; c++) {
      if (isWaterCell(terrain, r, c, W, H)) return true;
    }
  }
  return false;
}

function placeCoastline(terrain: number[][], objects: number[][], rng: () => number, W: number, H: number, anchors: MapAnchors): void {
  const sides = ['N', 'E', 'S', 'W'] as const;
  const side = sides[Math.floor(rng() * 4)];
  const depth = side === 'N' || side === 'S' ? Math.max(3, Math.floor(H * 0.4)) : Math.max(3, Math.floor(W * 0.4));

  const fillCol = (r: number, edgeTile: number, fillTile: number, isShoreline: boolean) => {
    for (let c = 0; c < W; c++) {
      objects[r][c] = 0;
      terrain[r][c] = isShoreline ? edgeTile : fillTile;
    }
  };
  const fillRow = (c: number, edgeTile: number, fillTile: number, isShoreline: boolean) => {
    for (let r = 0; r < H; r++) {
      objects[r][c] = 0;
      terrain[r][c] = isShoreline ? edgeTile : fillTile;
    }
  };

  if (side === 'N') {
    for (let r = 0; r < depth; r++) fillCol(r, WATER_GIDS.EDGE_S, WATER_GIDS.WATER, r === depth - 1);
  } else if (side === 'S') {
    for (let r = H - depth; r < H; r++) fillCol(r, WATER_GIDS.EDGE_N, WATER_GIDS.WATER, r === H - depth);
  } else if (side === 'W') {
    for (let c = 0; c < depth; c++) fillRow(c, WATER_GIDS.EDGE_E, WATER_GIDS.WATER, c === depth - 1);
  } else {
    for (let c = W - depth; c < W; c++) fillRow(c, WATER_GIDS.EDGE_W, WATER_GIDS.WATER, c === W - depth);
  }

  const band: Array<{ x: number; y: number }> = [];
  if (side === 'N') {
    for (let c = 0; c < W; c++) for (let i = 0; i < 3; i++) band.push({ x: c, y: H - 1 - i });
  } else if (side === 'S') {
    for (let c = 0; c < W; c++) for (let i = 0; i < 3; i++) band.push({ x: c, y: i });
  } else if (side === 'W') {
    for (let r = 0; r < H; r++) for (let i = 0; i < 3; i++) band.push({ x: W - 1 - i, y: r });
  } else {
    for (let r = 0; r < H; r++) for (let i = 0; i < 3; i++) band.push({ x: i, y: r });
  }
  anchors.inlandBand = band;
}

// ── Path placer ────────────────────────────────────────────────────────────

function placePath(
  terrain: number[][],
  objects: number[][],
  rng: () => number,
  W: number, H: number,
  anchors: MapAnchors,
  zones: MapZone[],
  reserved: Set<string>,
  allocZoneId: (kind: string) => string,
  opts: { intersection: boolean; coastline: boolean },
): void {
  const pathCells = new Set<string>();
  const paint = (x: number, y: number): boolean => {
    if (x < 0 || x >= W || y < 0 || y >= H) return false;
    if (isWaterCell(terrain, y, x, W, H)) return false;
    pathCells.add(`${x},${y}`);
    reserved.add(`${x},${y}`);
    return true;
  };
  const edgePoint = (x: number, y: number): { x: number; y: number } | null =>
    (x >= 0 && x < W && y >= 0 && y < H && !isWaterCell(terrain, y, x, W, H)) ? { x, y } : null;

  const endpoints: Array<{ x: number; y: number }> = [];

  if (opts.intersection && opts.coastline) {
    const band = anchors.inlandBand;
    let cx = W / 2, cy = H / 2;
    if (band && band.length > 0) {
      cx = band.reduce((s, p) => s + p.x, 0) / band.length;
      cy = band.reduce((s, p) => s + p.y, 0) / band.length;
    }
    const horizDist = Math.min(cx, W - 1 - cx);
    const vertDist  = Math.min(cy, H - 1 - cy);
    const spineHorizontal = vertDist < horizDist;
    if (spineHorizontal) {
      const spineRow = Math.max(2, Math.min(H - 3, Math.round(cy)));
      const stemCol  = 3 + Math.floor(rng() * Math.max(1, W - 6));
      for (let x = 0; x < W; x++) paint(x, spineRow);
      const waterIsSouth = cy < H / 2;
      const step = waterIsSouth ? 1 : -1;
      let y = spineRow + step;
      while (y >= 0 && y < H && paint(stemCol, y)) y += step;
      anchors.pathIntersection = { x: stemCol, y: spineRow };
      const left  = edgePoint(0, spineRow);
      const right = edgePoint(W - 1, spineRow);
      const stemEnd = edgePoint(stemCol, y - step);
      for (const p of [left, right, stemEnd]) if (p) endpoints.push(p);
    } else {
      const spineCol = Math.max(2, Math.min(W - 3, Math.round(cx)));
      const stemRow  = 3 + Math.floor(rng() * Math.max(1, H - 6));
      for (let y = 0; y < H; y++) paint(spineCol, y);
      const waterIsEast = cx < W / 2;
      const step = waterIsEast ? 1 : -1;
      let x = spineCol + step;
      while (x >= 0 && x < W && paint(x, stemRow)) x += step;
      anchors.pathIntersection = { x: spineCol, y: stemRow };
      const top    = edgePoint(spineCol, 0);
      const bottom = edgePoint(spineCol, H - 1);
      const stemEnd = edgePoint(x - step, stemRow);
      for (const p of [top, bottom, stemEnd]) if (p) endpoints.push(p);
    }
  } else if (opts.intersection) {
    const row = 3 + Math.floor(rng() * Math.max(1, H - 6));
    const col = 3 + Math.floor(rng() * Math.max(1, W - 6));
    for (let x = 0; x < W; x++) paint(x, row);
    for (let y = 0; y < H; y++) paint(col, y);
    anchors.pathIntersection = { x: col, y: row };
    for (const p of [edgePoint(0, row), edgePoint(W - 1, row), edgePoint(col, 0), edgePoint(col, H - 1)]) {
      if (p) endpoints.push(p);
    }
  } else {
    const horizontal = rng() < 0.5;
    if (horizontal) {
      const row = 3 + Math.floor(rng() * Math.max(1, H - 6));
      for (let x = 0; x < W; x++) paint(x, row);
      for (const p of [edgePoint(0, row), edgePoint(W - 1, row)]) if (p) endpoints.push(p);
    } else {
      const col = 3 + Math.floor(rng() * Math.max(1, W - 6));
      for (let y = 0; y < H; y++) paint(col, y);
      for (const p of [edgePoint(col, 0), edgePoint(col, H - 1)]) if (p) endpoints.push(p);
    }
  }

  if (pathCells.size === 0) return;

  // Second pass: pick the right path GID + rotation per cell from its
  // 4-neighbour mask in pathCells. T-junctions fall back to the 4-way
  // intersection tile since the spritesheet has no dedicated T tile.
  const inPath = (x: number, y: number): boolean => pathCells.has(`${x},${y}`);
  for (const cell of pathCells) {
    const [sx, sy] = cell.split(',');
    const x = parseInt(sx, 10), y = parseInt(sy, 10);
    const n = inPath(x, y - 1), s = inPath(x, y + 1);
    const e = inPath(x + 1, y), w = inPath(x - 1, y);
    const mask = (n ? 8 : 0) | (s ? 4 : 0) | (e ? 2 : 0) | (w ? 1 : 0);
    let gid: number;
    switch (mask) {
      case 0b1100: gid = PATH_GIDS.V; break;
      case 0b0011: gid = PATH_GIDS.H; break;
      case 0b1111: gid = PATH_GIDS.INTERSECTION; break;
      case 0b0110: gid = PATH_GIDS.CORNER_SE; break;
      case 0b0101: gid = PATH_GIDS.CORNER_SW; break;
      case 0b1001: gid = PATH_GIDS.CORNER_NW; break;
      case 0b1010: gid = PATH_GIDS.CORNER_NE; break;
      case 0b1000: case 0b0100: gid = PATH_GIDS.V; break;
      case 0b0010: case 0b0001: gid = PATH_GIDS.H; break;
      case 0b1110: case 0b1101: case 0b1011: case 0b0111: gid = PATH_GIDS.INTERSECTION; break;
      default: gid = PATH_GIDS.H;
    }
    objects[y][x] = gid;
  }

  anchors.pathEndpoints = endpoints;
  zones.push({ id: allocZoneId('path'), name: 'path', color: '#cc9966', cells: [...pathCells].sort() });
  if (anchors.pathIntersection) {
    const i = anchors.pathIntersection;
    zones.push({ id: allocZoneId('intersection'), name: 'intersection', color: '#ffaa44', cells: [`${i.x},${i.y}`] });
  }
}

// ── Building placer ────────────────────────────────────────────────────────

function placeBuildings(
  terrain: number[][],
  objects: number[][],
  rng: () => number,
  W: number, H: number,
  count: number,
  anchors: MapAnchors,
  zones: MapZone[],
  reserved: Set<string>,
  allocZoneId: (kind: string) => string,
): void {
  const want = Math.max(1, Math.min(5, Math.floor(count)));
  const placed: Array<{ x: number; y: number; w: number; h: number }> = [];

  const fits = (x: number, y: number, w: number, h: number): boolean => {
    if (x < 1 || y < 1 || x + w > W - 1 || y + h > H - 1) return false;
    for (let r = y; r < y + h; r++) {
      for (let c = x; c < x + w; c++) {
        if (isWaterCell(terrain, r, c, W, H)) return false;
        if (reserved.has(`${c},${r}`)) return false;
      }
    }
    return true;
  };

  for (let i = 0; i < want; i++) {
    let attempt = 0;
    let stamped = false;
    while (attempt < 40 && !stamped) {
      attempt++;
      const w = 4 + Math.floor(rng() * 4);
      const h = 4 + Math.floor(rng() * 3);
      const x = 1 + Math.floor(rng() * Math.max(1, W - w - 2));
      const y = 1 + Math.floor(rng() * Math.max(1, H - h - 2));
      if (!fits(x, y, w, h)) continue;

      // One non-corner cell on a random side becomes the doorway.
      const side = Math.floor(rng() * 4);
      let doorR = -1, doorC = -1;
      if (side === 0)      { doorR = y;           doorC = x + 1 + Math.floor(rng() * (w - 2)); }
      else if (side === 1) { doorR = y + h - 1;   doorC = x + 1 + Math.floor(rng() * (w - 2)); }
      else if (side === 2) { doorC = x;           doorR = y + 1 + Math.floor(rng() * (h - 2)); }
      else                 { doorC = x + w - 1;   doorR = y + 1 + Math.floor(rng() * (h - 2)); }

      const cells: string[] = [];
      for (let r = y; r < y + h; r++) {
        for (let c = x; c < x + w; c++) {
          terrain[r][c] = TERRAIN_GIDS.STONE_FLOOR;
          reserved.add(`${c},${r}`);
          cells.push(`${c},${r}`);

          const isN = r === y, isS = r === y + h - 1;
          const isW = c === x, isE = c === x + w - 1;
          if (!(isN || isS || isW || isE)) continue;
          if (r === doorR && c === doorC) continue;

          if (isN && isW)      objects[r][c] = WALL_GIDS.CORNER_TL;
          else if (isN && isE) objects[r][c] = WALL_GIDS.CORNER_TR;
          else if (isS && isW) objects[r][c] = WALL_GIDS.CORNER_BL;
          else if (isS && isE) objects[r][c] = WALL_GIDS.CORNER_BR;
          else if (isN)        objects[r][c] = WALL_GIDS.NORTH;
          else if (isS)        objects[r][c] = WALL_GIDS.SOUTH;
          else if (isW)        objects[r][c] = WALL_GIDS.WEST;
          else                 objects[r][c] = WALL_GIDS.EAST;
        }
      }
      placed.push({ x, y, w, h });
      zones.push({ id: allocZoneId(`building_${placed.length}`), name: `building ${placed.length}`, color: '#8866cc', cells: cells.sort() });
      stamped = true;
    }
  }
  if (placed.length > 0) anchors.buildings = placed;
}

// ── Campsites ──────────────────────────────────────────────────────────────

function placeCampsites(terrain: number[][], objects: number[][], rng: () => number, W: number, H: number, anchors: MapAnchors): void {
  const count = 1 + Math.floor(rng() * 2);
  for (let i = 0; i < count; i++) {
    let cx = -1, cy = -1;
    for (let attempt = 0; attempt < 12; attempt++) {
      const tx = 2 + Math.floor(rng() * (W - 4));
      const ty = 2 + Math.floor(rng() * (H - 4));
      if (!rectTouchesWater(terrain, tx - 1, ty - 1, 3, 3, W, H)) { cx = tx; cy = ty; break; }
    }
    if (cx < 0) continue;
    objects[cy][cx] = DECOR_GIDS.CAMPFIRE;
    (anchors.campfires ??= []).push({ x: cx, y: cy });
    for (let r = Math.max(0, cy - 2); r < Math.min(H, cy + 3); r++) {
      for (let c = Math.max(0, cx - 2); c < Math.min(W, cx + 3); c++) {
        if (objects[r][c] === DECOR_GIDS.TREE) objects[r][c] = 0;
      }
    }
    const offsets: Array<[number, number, number]> = [
      [-1, 0, DECOR_GIDS.FIREWOOD],
      [ 1, 0, DECOR_GIDS.CRATE_CLOSED],
    ];
    for (const [dx, dy, gid] of offsets) {
      const x = cx + dx, y = cy + dy;
      if (x >= 0 && x < W && y >= 0 && y < H && objects[y][x] === 0 && terrain[y][x] === TERRAIN_GIDS.GRASS) {
        objects[y][x] = gid;
      }
    }
  }
}

// ── Naming + description (outdoor only) ────────────────────────────────────

const FEATURE_ADJ: Partial<Record<Feature, string>> = {
  campsites:    'Camped',
  coastline:    'Coastal',
  path:         'Wayside',
  intersection: 'Crossroads',
  buildings:    'Settled',
};

function composeOutdoorName(terrain: 'grassland' | 'forest', features: Feature[]): string {
  const t = terrain === 'forest' ? 'Forest' : 'Field';
  if (features.length === 0) return t;
  const adj = FEATURE_ADJ[features[0]];
  return adj ? `${adj} ${t}` : t;
}

function composeOutdoorDescription(terrain: Terrain, features: Feature[], anchors: MapAnchors, W: number, H: number): string {
  const base = terrain === 'forest'
    ? 'A wooded clearing under thick canopy.'
    : 'Open grassland stretches across the map.';
  const layout: string[] = [];
  if (features.includes('coastline')) layout.push(`Water along the ${waterSide(anchors, W, H)} edge of the map`);
  if (features.includes('path') || features.includes('intersection')) {
    if (anchors.pathIntersection) {
      layout.push(features.includes('coastline') ? 'a T-junction meets a single dirt path' : 'two dirt paths cross at an intersection');
    } else {
      layout.push('a dirt path runs across the map');
    }
  }
  if (features.includes('buildings')) {
    const n = anchors.buildings?.length ?? 0;
    const where = listPositions(anchors.buildings, W, H);
    layout.push(`${plural(n, 'building')}${where ? ` at the ${where}` : ''}`);
  }
  if (features.includes('campsites')) {
    const n = anchors.campfires?.length ?? 0;
    const where = listPositions(anchors.campfires, W, H);
    layout.push(`${plural(n, 'campfire')}${where ? ` at the ${where}` : ''}`);
  }
  if (layout.length === 0) return base;
  const detailLine = layout.map((s, i) => i === 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s).join('; ');
  return `${base} ${detailLine}.`;
}

function cardinal(rect: { x: number; y: number; w: number; h: number }, W: number, H: number): string {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const thirdX = W / 3;
  const thirdY = H / 3;
  const horiz = cx < thirdX ? 'west' : cx > 2 * thirdX ? 'east' : '';
  const vert  = cy < thirdY ? 'north' : cy > 2 * thirdY ? 'south' : '';
  if (vert && horiz) return `${vert}-${horiz}`;
  if (vert)  return vert;
  if (horiz) return horiz;
  return 'centre';
}

function listPositions(items: Array<{ x: number; y: number; w?: number; h?: number }> | undefined, W: number, H: number): string {
  if (!items || items.length === 0) return '';
  const labels = items.map((it) => cardinal({ x: it.x, y: it.y, w: it.w ?? 0, h: it.h ?? 0 }, W, H));
  const unique: string[] = [];
  for (const l of labels) if (!unique.includes(l)) unique.push(l);
  if (unique.length === 1) return unique[0];
  if (unique.length === 2) return `${unique[0]} and ${unique[1]}`;
  return `${unique.slice(0, -1).join(', ')}, and ${unique[unique.length - 1]}`;
}

function waterSide(anchors: MapAnchors, W: number, H: number): string {
  const band = anchors.inlandBand;
  if (!band || band.length === 0) return 'one edge';
  let sumX = 0, sumY = 0;
  for (const c of band) { sumX += c.x; sumY += c.y; }
  const cx = sumX / band.length;
  const cy = sumY / band.length;
  const dxFromCenter = cx - W / 2;
  const dyFromCenter = cy - H / 2;
  if (Math.abs(dxFromCenter) > Math.abs(dyFromCenter)) return dxFromCenter > 0 ? 'west' : 'east';
  return dyFromCenter > 0 ? 'north' : 'south';
}

function plural(n: number, noun: string): string {
  if (n === 1) return `one ${noun}`;
  if (n === 2) return `two ${noun}s`;
  if (n === 3) return `three ${noun}s`;
  if (n === 4) return `four ${noun}s`;
  return `${n} ${noun}s`;
}
