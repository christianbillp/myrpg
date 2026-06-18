/**
 * Tactical analysis (Roadmap v2 · G1 / improvement #1).
 *
 * A pure, deterministic read of a composed map's *fighting shape* — cover,
 * openness, chokepoints, defensible hold-zones, and alternate-route richness —
 * computed straight off the passable grid. The encounter layer uses it to place
 * spawns by tactical role, and the composer uses it to reject degenerate layouts
 * (no cover, one giant open blob). Nothing here mutates the map.
 */
import { objectBlocksMovement, groundBlocksMovement } from './materials.js';

/** The minimal grid surface the analysis needs — satisfied by `MapCanvas` and by
 *  the lightweight `ComposedMap` adapter below. */
export interface TacticalGrid {
  width: number;
  height: number;
  getObject(x: number, y: number): number;
  getGround(x: number, y: number): number;
}

export interface HoldZone {
  /** Centroid cell of the pocket (rounded). */
  cx: number;
  cy: number;
  /** Open cells in the pocket. */
  size: number;
  /** Distinct chokepoint cells on its boundary — a defensible pocket has 1–2. */
  entrances: number;
}

export interface TacticalMetrics {
  /** Walkable cell count. */
  openCells: number;
  /** Open cells orthogonally adjacent to a blocking cell (wall/object/hazard),
   *  ÷ open cells — how much cover the map affords. 0 = a featureless field. */
  coverRatio: number;
  /** Mean fraction of walkable orthogonal neighbours over open cells. ~1 in an
   *  open field, ~0.5 down a corridor. */
  openness: number;
  /** Articulation cells of the passable graph — removing one severs the map.
   *  Corridors are dense with them; an open field has none. */
  chokepoints: Array<{ x: number; y: number }>;
  /** Defensible pockets — open areas reached through only 1–2 chokepoints. */
  holdZones: HoldZone[];
  /** Independent cycles in the passable graph (E − V + components) — a proxy for
   *  how many alternate / flanking routes exist. 0 = a pure tree (no loops). */
  loops: number;
}

function blocks(g: TacticalGrid, x: number, y: number): boolean {
  const obj = g.getObject(x, y);
  if (obj !== 0) return objectBlocksMovement(obj);
  return groundBlocksMovement(g.getGround(x, y));
}

const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [[0, -1], [0, 1], [-1, 0], [1, 0]];

/** Articulation points of the passable graph, by flat id. Iterative
 *  Hopcroft–Tarjan (the grid can hold thousands of cells — recursion would blow
 *  the stack). */
function articulationPoints(open: Set<number>, width: number, height: number): Set<number> {
  const disc = new Map<number, number>();
  const low = new Map<number, number>();
  const ap = new Set<number>();
  let timer = 1;
  const nbrs = (id: number): number[] => {
    const x = id % width, y = (id / width) | 0;
    const out: number[] = [];
    if (x > 0 && open.has(id - 1)) out.push(id - 1);
    if (x < width - 1 && open.has(id + 1)) out.push(id + 1);
    if (y > 0 && open.has(id - width)) out.push(id - width);
    if (y < height - 1 && open.has(id + width)) out.push(id + width);
    return out;
  };
  for (const s of open) {
    if (disc.has(s)) continue;
    disc.set(s, timer); low.set(s, timer); timer++;
    const stack: Array<{ u: number; parent: number; nbrs: number[]; i: number }> = [{ u: s, parent: -1, nbrs: nbrs(s), i: 0 }];
    let rootChildren = 0;
    while (stack.length) {
      const f = stack[stack.length - 1];
      if (f.i < f.nbrs.length) {
        const v = f.nbrs[f.i++];
        if (v === f.parent) continue;
        if (!disc.has(v)) {
          if (f.parent === -1) rootChildren++;
          disc.set(v, timer); low.set(v, timer); timer++;
          stack.push({ u: v, parent: f.u, nbrs: nbrs(v), i: 0 });
        } else {
          low.set(f.u, Math.min(low.get(f.u)!, disc.get(v)!));
        }
      } else {
        stack.pop();
        const p = stack[stack.length - 1];
        if (p) {
          low.set(p.u, Math.min(low.get(p.u)!, low.get(f.u)!));
          if (p.parent !== -1 && low.get(f.u)! >= disc.get(p.u)!) ap.add(p.u);
        }
      }
    }
    if (rootChildren > 1) ap.add(s);
  }
  return ap;
}

/** Connected components of an open-cell subset (4-connectivity), as id arrays. */
function components(cells: Set<number>, width: number, height: number): number[][] {
  const seen = new Set<number>();
  const out: number[][] = [];
  for (const start of cells) {
    if (seen.has(start)) continue;
    const comp: number[] = [];
    const stack = [start]; seen.add(start);
    while (stack.length) {
      const id = stack.pop()!;
      comp.push(id);
      const x = id % width, y = (id / width) | 0;
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const nid = ny * width + nx;
        if (cells.has(nid) && !seen.has(nid)) { seen.add(nid); stack.push(nid); }
      }
    }
    out.push(comp);
  }
  return out;
}

export function tacticalAnalysis(g: TacticalGrid): TacticalMetrics {
  const { width, height } = g;
  const open = new Set<number>();
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (!blocks(g, x, y)) open.add(y * width + x);

  const openCells = open.size;
  if (openCells === 0) return { openCells: 0, coverRatio: 0, openness: 0, chokepoints: [], holdZones: [], loops: 0 };

  let coverAdjacent = 0, openNeighbourSum = 0, edgeCount = 0;
  for (const id of open) {
    const x = id % width, y = (id / width) | 0;
    let openN = 0, hasCover = false;
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = x + dx, ny = y + dy;
      const inB = nx >= 0 && ny >= 0 && nx < width && ny < height;
      if (inB && open.has(ny * width + nx)) { openN++; if (nx > x || ny > y) edgeCount++; } // count each undirected edge once
      else if (inB && blocks(g, nx, ny)) hasCover = true; // a real wall/object, not the map edge
    }
    openNeighbourSum += openN / 4;
    if (hasCover) coverAdjacent++;
  }

  const ap = articulationPoints(open, width, height);
  const chokepoints = [...ap].map((id) => ({ x: id % width, y: (id / width) | 0 }));

  // Hold zones: components of (open minus chokepoints) reached through 1–2
  // chokepoints. Excludes the wide-open backdrop (0 entrances) and busy hubs (≥3).
  const pocketCells = new Set([...open].filter((id) => !ap.has(id)));
  const holdZones: HoldZone[] = [];
  for (const comp of components(pocketCells, width, height)) {
    if (comp.length < 4) continue;
    const entranceSet = new Set<number>();
    for (const id of comp) {
      const x = id % width, y = (id / width) | 0;
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = x + dx, ny = y + dy, nid = ny * width + nx;
        if (nx >= 0 && ny >= 0 && nx < width && ny < height && ap.has(nid)) entranceSet.add(nid);
      }
    }
    if (entranceSet.size < 1 || entranceSet.size > 2) continue;
    let sx = 0, sy = 0;
    for (const id of comp) { sx += id % width; sy += (id / width) | 0; }
    holdZones.push({ cx: Math.round(sx / comp.length), cy: Math.round(sy / comp.length), size: comp.length, entrances: entranceSet.size });
  }

  const compCount = components(open, width, height).length;
  const loops = edgeCount - openCells + compCount;

  return {
    openCells,
    coverRatio: coverAdjacent / openCells,
    openness: openNeighbourSum / openCells,
    chokepoints,
    holdZones,
    loops,
  };
}

/** Run the analysis over a `ComposedMap`'s flat grids (no `MapCanvas` needed). */
export function tacticalAnalysisOfMap(map: { width: number; height: number; terrainData: number[]; objectData: number[] }): TacticalMetrics {
  return tacticalAnalysis({
    width: map.width,
    height: map.height,
    getGround: (x, y) => map.terrainData[y * map.width + x] ?? 0,
    getObject: (x, y) => map.objectData[y * map.width + x] ?? 0,
  });
}
