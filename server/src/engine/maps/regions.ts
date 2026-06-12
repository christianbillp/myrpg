/**
 * Multi-region composer (US-126) — one big map whose terrain changes as you
 * cross it: a grassland that becomes a forest and ends in a cave. Regions are
 * laid out as bands along the map's long axis, in the order given.
 *
 * Two kinds of region, two kinds of transition:
 *   • OPEN biomes (grassland / forest / urban) fill their band with palette
 *     ground + scatter objects. Where two open bands meet, an ECOTONE blends
 *     them: within `BLEND_TILES` of the (noisy) boundary each cell rolls its
 *     ground AND its scatter from the neighbouring palette with a probability
 *     that ramps from ~50% at the boundary to 0 — grass thickens into
 *     treeline instead of switching on a hard line.
 *   • ENCLOSED biomes (cave / dungeon) start as solid rock (void) and get an
 *     interior carved in the SAME style as their single-region composers —
 *     a cave is a hub-and-spoke cavern (central chamber + side chambers +
 *     gravel passages + pool/chasm hazards, mirroring `composeCave`), a
 *     dungeon is a serial chain of rectangular rooms linked by 1-wide
 *     corridors (mirroring `composeDungeon`). A MOUTH corridor is carved
 *     from the chamber nearest the neighbouring band out through the rock —
 *     entering the region is a deliberate choke point through a rock face,
 *     not a texture change.
 *
 * Every region is emitted as a named map zone; enclosed regions default
 * their zone's `lightLevel` to `dark` so the session light bake makes the
 * cave actually dark while the grassland outside stays bright (Darkvision
 * resolves per observer at read time).
 *
 * Connectivity is guaranteed: after carving, the passable cells are
 * flood-filled and every region anchor must land in one component — if not,
 * repair corridors are carved and the check reruns. A map with a sealed
 * region is an error, never a returned value.
 *
 * Deterministic: same seed + same options → byte-identical map.
 */
import { BIOME_PALETTES, pickGroundGid, rollObjectGid, type BiomePalette } from '../../../../shared/biomePalettes.js';
import type { ComposedMap, ComposeRegionsOptions, RegionSpec } from '../mapTypes.js';
import { MapCanvas } from './MapCanvas.js';
import { carveCorridor, placeHazard, wallAroundFloor, passableRegions } from './mapOps.js';

const MIN_BAND_TILES = 6;
const BLEND_TILES = 3;
const OPEN_TERRAINS = new Set(['grassland', 'forest', 'urban']);

const REGION_COLORS: Record<RegionSpec['terrain'], string> = {
  grassland: '#7aa86a',
  forest:    '#3a5e2a',
  urban:     '#8c96a5',
  cave:      '#aa8866',
  dungeon:   '#888899',
};

/** Palette used to fill / carve a region's floor. */
function paletteFor(terrain: RegionSpec['terrain']): BiomePalette {
  return BIOME_PALETTES[terrain];
}

function isOpen(spec: RegionSpec): boolean {
  return OPEN_TERRAINS.has(spec.terrain);
}

export function composeRegions(opts: ComposeRegionsOptions): ComposedMap {
  const { width, height } = opts;
  const regions = opts.regions;
  if (regions.length < 2 || regions.length > 5) throw new Error('regions must list 2-5 entries');
  if (width < 24 || height < 16) throw new Error('Multi-region map too small (min 24×16)');
  if (width > 96 || height > 64) throw new Error('Multi-region map too large (max 96×64)');

  const seed = (opts.seed ?? Date.now()) & 0xffffffff;
  const c = new MapCanvas({ width, height, seed });
  const horizontal = width >= height;
  const axisLen = horizontal ? width : height;
  const perpLen = horizontal ? height : width;

  // ── Band layout: cumulative shares → base boundaries, then a clamped
  // random-walk offset per perpendicular row so edges meander naturally. ──
  const shares = regions.map((r) => Math.max(0.25, r.share ?? 1));
  const totalShare = shares.reduce((a, b) => a + b, 0);
  const baseBounds: number[] = [];
  let acc = 0;
  for (let i = 0; i < regions.length - 1; i++) {
    acc += shares[i];
    baseBounds.push(Math.round((acc / totalShare) * axisLen));
  }
  for (let i = 0; i < baseBounds.length; i++) {
    const lo = (i === 0 ? 0 : baseBounds[i - 1]) + MIN_BAND_TILES;
    const hi = (i === baseBounds.length - 1 ? axisLen : baseBounds[i + 1]) - MIN_BAND_TILES;
    if (lo > hi) throw new Error(`region ${i + 1} band is narrower than ${MIN_BAND_TILES} tiles — fewer regions or a bigger map needed`);
    baseBounds[i] = Math.max(lo, Math.min(hi, baseBounds[i]));
  }
  // boundaryAt[b][perp] — noisy boundary position for each perpendicular row.
  const boundaryAt: number[][] = baseBounds.map((base) => {
    const offsets: number[] = [];
    let off = 0;
    for (let p = 0; p < perpLen; p++) {
      off += c.rng() < 0.5 ? -1 : 1;
      off = Math.max(-3, Math.min(3, off));
      offsets.push(Math.max(2, Math.min(axisLen - 2, base + off)));
    }
    return offsets;
  });

  const regionIndexAt = (along: number, perp: number): number => {
    let idx = 0;
    for (const bounds of boundaryAt) {
      if (along >= bounds[perp]) idx++;
    }
    return idx;
  };
  const cellRegion = (x: number, y: number): number =>
    horizontal ? regionIndexAt(x, y) : regionIndexAt(y, x);

  // Signed distance (in tiles along the axis) from a cell to boundary `b` —
  // negative on the earlier-region side. Used for the ecotone ramp.
  const distToBoundary = (x: number, y: number, b: number): number => {
    const along = horizontal ? x : y;
    const perp = horizontal ? y : x;
    return along - boundaryAt[b][perp];
  };

  // ── Ground fill: open bands get palette ground (with ecotone mixing
  // against adjacent OPEN neighbours); enclosed bands stay void for now. ──
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = cellRegion(x, y);
      if (!isOpen(regions[idx])) continue;
      c.setGround(x, y, pickGroundGid(blendedPalette(regions, idx, x, y, distToBoundary, c.rng), c.rng));
    }
  }

  // ── Enclosed interiors: carve each band in its single-region composer's
  // style (cave hub-and-spoke / dungeon room chain), then a mouth corridor
  // out to the neighbouring band. Anchor per region for the connectivity
  // spine — for enclosed regions the anchor is real carved floor. ──
  const anchorPoints: Array<{ x: number; y: number }> = [];
  const deferredHazards: Array<Parameters<typeof placeHazard>[1]> = [];
  for (let i = 0; i < regions.length; i++) {
    const spec = regions[i];
    const bandLo = i === 0 ? 0 : baseBounds[i - 1];
    const bandHi = i === regions.length - 1 ? axisLen : baseBounds[i];
    const centerAlong = Math.floor((bandLo + bandHi) / 2);
    const centerPerp = Math.floor(perpLen / 2);
    const anchor = horizontal ? { x: centerAlong, y: centerPerp } : { x: centerPerp, y: centerAlong };
    anchorPoints.push(anchor);
    if (isOpen(spec)) continue;

    // The mouth exits toward the nearest open neighbour: the previous band
    // when one exists, else the next.
    const neighbour = i > 0 ? i - 1 : i + 1;
    const interior = carveEnclosedInterior(c, spec, {
      bandLo, bandHi, horizontal, cellRegion, regionIdx: i,
      mouthSide: neighbour < i ? 'low' : 'high',
    });
    anchorPoints[i] = interior.anchor;
    deferredHazards.push(...interior.hazards);

    // Mouth: carve from the chamber nearest the boundary out into the open
    // band — a trail that punches the rock face exactly once.
    const nLo = neighbour === 0 ? 0 : baseBounds[neighbour - 1];
    const nHi = neighbour === regions.length - 1 ? axisLen : baseBounds[neighbour];
    const mouthAlong = neighbour < i ? nHi - 3 : nLo + 3;
    const mouthTarget = horizontal ? { x: mouthAlong, y: interior.mouthFrom.y } : { x: interior.mouthFrom.x, y: mouthAlong };
    carveCorridor(c, {
      from: interior.mouthFrom,
      to: mouthTarget,
      floor: spec.terrain === 'dungeon' ? 'stone_floor' : 'cave_gravel',
      width: spec.terrain === 'dungeon' ? 1 : 2,
    });
  }

  // Rock faces: every void cell adjacent to floor becomes a wall — this is
  // both the enclosed regions' interior walls AND the face an open band
  // runs into at an enclosed boundary.
  wallAroundFloor(c);

  // Hazards land after the wall pass, matching `composeCave`'s order —
  // each enclosed interior queued its own (cave pool + chasm pair).
  for (const hazard of deferredHazards) placeHazard(c, hazard);

  // ── Scatter pass: every untouched natural-ground cell in an open region
  // rolls the (ecotone-blended) palette's object pool. ──
  applyBlendedObjectPool(c, regions, cellRegion, distToBoundary);

  // ── Connectivity guarantee ──
  ensureConnected(c, anchorPoints);

  // ── Zones (one per region, floor cells only) + anchors ──
  for (let i = 0; i < regions.length; i++) {
    const spec = regions[i];
    const cells: string[] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (cellRegion(x, y) !== i) continue;
        if (c.getGround(x, y) === 0) continue;
        cells.push(c.key(x, y));
      }
    }
    c.addZone('region', spec.name ?? spec.terrain, REGION_COLORS[spec.terrain], cells);
    const light = spec.light ?? (isOpen(spec) ? undefined : 'dark');
    if (light) c.zones[c.zones.length - 1].lightLevel = light;
  }
  c.anchors.entrance = anchorPoints[0];
  c.anchors.vault = anchorPoints[anchorPoints.length - 1];

  return c.toComposedMap(regionsName(regions, c.rng), regionsDescription(regions, horizontal));
}

/** The palette a cell draws from, after ecotone mixing: near a boundary with
 *  an OPEN neighbour, the neighbour's palette wins with probability ramping
 *  from ~50% at the line to 0 at `BLEND_TILES`. */
function blendedPalette(
  regions: RegionSpec[],
  idx: number,
  x: number,
  y: number,
  distToBoundary: (x: number, y: number, b: number) => number,
  rng: () => number,
): BiomePalette {
  const own = paletteFor(regions[idx].terrain);
  // Boundary b sits between regions b and b+1.
  for (const [b, neighbourIdx] of [[idx - 1, idx - 1], [idx, idx + 1]] as Array<[number, number]>) {
    if (b < 0 || b >= regions.length - 1) continue;
    if (neighbourIdx < 0 || neighbourIdx >= regions.length) continue;
    if (!isOpen(regions[neighbourIdx]) || regions[neighbourIdx].terrain === regions[idx].terrain) continue;
    const dist = Math.abs(distToBoundary(x, y, b));
    if (dist > BLEND_TILES) continue;
    const mix = 0.5 * (1 - dist / (BLEND_TILES + 1));
    if (rng() < mix) return paletteFor(regions[neighbourIdx].terrain);
  }
  return own;
}

interface EnclosedBand {
  bandLo: number;
  bandHi: number;
  horizontal: boolean;
  cellRegion: (x: number, y: number) => number;
  regionIdx: number;
  /** Which end of the band (along the axis) the mouth exits from. */
  mouthSide: 'low' | 'high';
}

interface EnclosedInterior {
  /** Guaranteed-floor point for the connectivity spine / vault anchor —
   *  the central chamber (cave) or the deepest room (dungeon). */
  anchor: { x: number; y: number };
  /** Centre of the chamber/room nearest the open neighbour — where the
   *  mouth corridor starts. */
  mouthFrom: { x: number; y: number };
  /** Hazards to drop AFTER `wallAroundFloor` runs (matching `composeCave`'s
   *  order, so the wall ring forms around clean floor first). */
  hazards: Array<Parameters<typeof placeHazard>[1]>;
}

interface BandRoom { x: number; y: number; w: number; h: number; cx: number; cy: number; }

/**
 * Carve an enclosed band's interior in the same style as its single-region
 * composer, scoped to the band rect (4-tile rock margin on the band ends so
 * the face survives the boundary noise, 2-tile margin on the map edges):
 *   • cave — `composeCave`'s hub-and-spoke: one large central chamber, side
 *     chambers tunnelled back to it with gravel passages, a pool + chasm
 *     hazard pair in the central chamber's corners.
 *   • dungeon — `composeDungeon`'s serial room chain: rectangular rooms with
 *     a 2-cell separation, linked in mouth-to-deepest order by 1-wide
 *     stone corridors.
 */
function carveEnclosedInterior(c: MapCanvas, spec: RegionSpec, band: EnclosedBand): EnclosedInterior {
  const palette = paletteFor(spec.terrain);
  // Inner rect in map coordinates the rooms may occupy.
  const alongLo = band.bandLo + 4;
  const alongHi = band.bandHi - 4;
  const perpLo = 2;
  const perpHi = (band.horizontal ? c.height : c.width) - 2;
  const rect = band.horizontal
    ? { x0: alongLo, x1: alongHi, y0: perpLo, y1: perpHi }
    : { x0: perpLo, x1: perpHi, y0: alongLo, y1: alongHi };
  const rectW = Math.max(4, rect.x1 - rect.x0);
  const rectH = Math.max(4, rect.y1 - rect.y0);

  const carveRect = (r: BandRoom): void => {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        if (x < 1 || x >= c.width - 1 || y < 1 || y >= c.height - 1) continue;
        if (band.cellRegion(x, y) !== band.regionIdx) continue;
        c.setGround(x, y, pickGroundGid(palette, c.rng));
        c.reserve(x, y);
      }
    }
  };
  const overlaps = (rooms: BandRoom[], x: number, y: number, w: number, h: number): boolean =>
    rooms.some((r) => x < r.x + r.w + 2 && x + w + 2 > r.x && y < r.y + r.h + 2 && y + h + 2 > r.y);
  const mouthDistance = (r: BandRoom): number => {
    const along = band.horizontal ? r.cx : r.cy;
    return band.mouthSide === 'low' ? along - band.bandLo : band.bandHi - along;
  };

  if (spec.terrain === 'cave') {
    // Central chamber ~40% of each axis of the band rect, centred.
    const cw = Math.max(4, Math.min(rectW - 2, Math.floor(rectW * (0.38 + c.rng() * 0.08))));
    const ch = Math.max(4, Math.min(rectH - 2, Math.floor(rectH * (0.38 + c.rng() * 0.08))));
    const central: BandRoom = {
      x: rect.x0 + Math.floor((rectW - cw) / 2), y: rect.y0 + Math.floor((rectH - ch) / 2),
      w: cw, h: ch, cx: 0, cy: 0,
    };
    central.cx = central.x + (central.w >> 1);
    central.cy = central.y + (central.h >> 1);
    carveRect(central);
    const rooms: BandRoom[] = [central];

    // Side chambers tunnelled back to the centre (2 small, 3 in a big band).
    const sideWant = rectW * rectH >= 380 ? 3 : 2;
    let attempts = 0;
    while (rooms.length < sideWant + 1 && attempts < 400) {
      attempts++;
      const w = 3 + Math.floor(c.rng() * 3);
      const h = 3 + Math.floor(c.rng() * 3);
      const x = rect.x0 + Math.floor(c.rng() * Math.max(1, rectW - w));
      const y = rect.y0 + Math.floor(c.rng() * Math.max(1, rectH - h));
      if (overlaps(rooms, x, y, w, h)) continue;
      const side: BandRoom = { x, y, w, h, cx: x + (w >> 1), cy: y + (h >> 1) };
      carveRect(side);
      rooms.push(side);
      carveCorridor(c, { from: { x: side.cx, y: side.cy }, to: { x: central.cx, y: central.cy }, floor: 'cave_gravel' });
    }

    // Hazards in the central chamber's opposite corners, clear of the centre
    // (the corridor hub) — mirrors `composeCave`. Deferred until after the
    // wall pass, same as the single-region composer.
    const hazards: EnclosedInterior['hazards'] = [];
    if (central.w >= 6 && central.h >= 5) {
      hazards.push({ rect: { x: central.x + 1, y: central.y + 1, w: 2, h: 2 }, material: 'pool' });
      hazards.push({ cells: [
        { x: central.x + central.w - 2, y: central.y + central.h - 2 },
        { x: central.x + central.w - 3, y: central.y + central.h - 2 },
      ], material: 'chasm' });
    }

    const sideRooms = rooms.slice(1);
    const mouthRoom = sideRooms.length
      ? sideRooms.reduce((best, r) => (mouthDistance(r) < mouthDistance(best) ? r : best), sideRooms[0])
      : central;
    return { anchor: { x: central.cx, y: central.cy }, mouthFrom: { x: mouthRoom.cx, y: mouthRoom.cy }, hazards };
  }

  // Dungeon — serial room chain, mouth-nearest room first (the entrance),
  // deepest room last (the vault-side anchor).
  const roomWant = rectW * rectH >= 380 ? 4 : 3;
  const rooms: BandRoom[] = [];
  let attempts = 0;
  while (rooms.length < roomWant && attempts < 400) {
    attempts++;
    const w = 4 + Math.floor(c.rng() * 4);
    const h = 4 + Math.floor(c.rng() * 3);
    if (w > rectW || h > rectH) continue;
    const x = rect.x0 + Math.floor(c.rng() * Math.max(1, rectW - w));
    const y = rect.y0 + Math.floor(c.rng() * Math.max(1, rectH - h));
    if (overlaps(rooms, x, y, w, h)) continue;
    const room: BandRoom = { x, y, w, h, cx: x + Math.floor(w / 2), cy: y + Math.floor(h / 2) };
    carveRect(room);
    rooms.push(room);
  }
  if (rooms.length === 0) {
    // Degenerate band — guarantee at least one room at the rect centre.
    const room: BandRoom = { x: rect.x0 + Math.floor(rectW / 2) - 2, y: rect.y0 + Math.floor(rectH / 2) - 2, w: 4, h: 4, cx: 0, cy: 0 };
    room.cx = room.x + 2; room.cy = room.y + 2;
    carveRect(room);
    rooms.push(room);
  }
  rooms.sort((a, b) => mouthDistance(a) - mouthDistance(b));
  for (let i = 1; i < rooms.length; i++) {
    carveCorridor(c, { from: { x: rooms[i - 1].cx, y: rooms[i - 1].cy }, to: { x: rooms[i].cx, y: rooms[i].cy }, floor: 'stone_floor' });
  }
  const deepest = rooms[rooms.length - 1];
  return { anchor: { x: deepest.cx, y: deepest.cy }, mouthFrom: { x: rooms[0].cx, y: rooms[0].cy }, hazards: [] };
}

/** Scatter objects on open-region natural ground, drawing each cell's pool
 *  from the same ecotone-blended palette its ground used — tree density
 *  thickens across a grass→forest blend instead of jumping. */
function applyBlendedObjectPool(
  c: MapCanvas,
  regions: RegionSpec[],
  cellRegion: (x: number, y: number) => number,
  distToBoundary: (x: number, y: number, b: number) => number,
): void {
  const naturalGround = new Set<number>();
  for (const r of regions) {
    if (!isOpen(r)) continue;
    for (const e of paletteFor(r.terrain).groundPool) naturalGround.add(e.gid);
  }
  const isWall = (x: number, y: number): boolean => {
    if (!c.inBounds(x, y)) return false;
    return !naturalGround.has(c.getGround(x, y) & 0x1fffffff);
  };
  const flat = new Array<number>(c.width * c.height).fill(0);
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) flat[y * c.width + x] = c.getObject(x, y);

  for (let y = 1; y < c.height - 1; y++) {
    for (let x = 1; x < c.width - 1; x++) {
      if (c.getObject(x, y) !== 0 || c.isReserved(x, y)) continue;
      const idx = cellRegion(x, y);
      if (!isOpen(regions[idx])) continue;
      if (!naturalGround.has(c.getGround(x, y) & 0x1fffffff)) continue;
      const palette = blendedPalette(regions, idx, x, y, distToBoundary, c.rng);
      const gid = rollObjectGid(palette, c.rng, x, y, c.width, c.height, flat, isWall);
      if (gid !== 0) {
        c.setObject(x, y, gid);
        flat[y * c.width + x] = gid;
      }
    }
  }
}

/** Flood-fill the passable cells; if any region anchor is outside the main
 *  component, carve repair corridors along the spine and re-check. */
function ensureConnected(c: MapCanvas, anchors: Array<{ x: number; y: number }>): void {
  const componentOf = (labels: number[][], p: { x: number; y: number }): number => labels[p.y]?.[p.x] ?? -1;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { labels } = passableRegions(c);
    const home = componentOf(labels, anchors[0]);
    const disconnected = anchors.some((a) => componentOf(labels, a) !== home || home === -1);
    if (!disconnected) return;
    for (let i = 0; i < anchors.length - 1; i++) {
      carveCorridor(c, { from: anchors[i], to: anchors[i + 1], floor: 'cave_gravel' });
    }
    wallAroundFloor(c);
  }
  const { labels } = passableRegions(c);
  const home = componentOf(labels, anchors[0]);
  if (anchors.some((a) => componentOf(labels, a) !== home || home === -1)) {
    throw new Error('composeRegions: could not connect all regions — try a larger map or fewer regions');
  }
}

const REGION_MAP_NAMES = ['The Long Crossing', 'Borderlands', 'The Wild Road', 'Threshold Country', 'The Changing Land', 'Marchlands'];
function regionsName(_regions: RegionSpec[], rng: () => number): string {
  return REGION_MAP_NAMES[Math.floor(rng() * REGION_MAP_NAMES.length)];
}

function regionsDescription(regions: RegionSpec[], horizontal: boolean): string {
  const dir = horizontal ? 'west to east' : 'north to south';
  const names = regions.map((r) => r.name ?? r.terrain);
  const parts: string[] = [];
  for (let i = 0; i < regions.length; i++) {
    if (i === 0) { parts.push(`${names[i]}`); continue; }
    const enclosed = !OPEN_TERRAINS.has(regions[i].terrain);
    parts.push(enclosed ? `a ${names[i]} mouth opening in the rock beyond` : `${names[i]} closing in`);
  }
  return `A long traverse, ${dir}: ${parts.join(', then ')}. Each region is a named zone; the enclosed dark is real — bring light or darkvision.`;
}
