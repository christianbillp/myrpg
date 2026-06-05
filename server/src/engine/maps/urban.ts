/**
 * Urban composer — a paved settlement: a varied stone-paved ground, a central
 * plaza, several buildings, and dirt/paved paths linking their doors to the
 * square. Built on the shared `MapCanvas` + op toolbox, so deterministic and
 * AI-authored towns render identically.
 *
 * Deterministic from the seed.
 */
import type { ComposedMap } from '../mapTypes.js';
import { MapCanvas } from './MapCanvas.js';
import { fillTerrain, placeBuilding, layPath, paintRegion, defineZone } from './mapOps.js';

export interface ComposeUrbanOpts { width: number; height: number; seed: number; buildingsCount?: number; }

export function composeUrban(opts: ComposeUrbanOpts): ComposedMap {
  const c = new MapCanvas({ width: opts.width, height: opts.height, seed: opts.seed });
  fillTerrain(c, { biome: 'urban' });

  // Central plaza of finer slabs as the focal square.
  const pw = Math.max(4, Math.floor(opts.width * 0.3));
  const ph = Math.max(4, Math.floor(opts.height * 0.3));
  const px = Math.floor((opts.width - pw) / 2);
  const py = Math.floor((opts.height - ph) / 2);
  paintRegion(c, { rect: { x: px, y: py, w: pw, h: ph }, material: 'slabs', layer: 'ground' });
  defineZone(c, { name: 'plaza', color: '#c8b78a', rect: { x: px, y: py, w: pw, h: ph } });
  const plazaCentre = { x: px + (pw >> 1), y: py + (ph >> 1) };

  // Ring buildings around the plaza on the four sides, connecting each door to
  // the square with a path. Count clamped 2..6.
  const want = Math.max(2, Math.min(6, Math.floor(opts.buildingsCount ?? 4)));
  const slots: Array<{ x: number; y: number; w: number; h: number; door: 'N' | 'S' | 'E' | 'W' }> = [
    { x: 2, y: 2, w: 6, h: 5, door: 'S' },
    { x: opts.width - 8, y: 2, w: 6, h: 5, door: 'S' },
    { x: 2, y: opts.height - 7, w: 6, h: 5, door: 'N' },
    { x: opts.width - 8, y: opts.height - 7, w: 6, h: 5, door: 'N' },
    { x: Math.floor(opts.width / 2) - 3, y: 1, w: 6, h: 4, door: 'S' },
    { x: Math.floor(opts.width / 2) - 3, y: opts.height - 5, w: 6, h: 4, door: 'N' },
  ];
  let placed = 0;
  for (const s of slots) {
    if (placed >= want) break;
    if (s.x < 1 || s.y < 1 || s.x + s.w > opts.width - 1 || s.y + s.h > opts.height - 1) continue;
    const res = placeBuilding(c, { x: s.x, y: s.y, w: s.w, h: s.h, doorSide: s.door, floor: 'wood_floor', name: `building ${placed + 1}` });
    if (!res.ok) continue;
    placed++;
    // Path from just outside the door to the plaza edge.
    const doorOut = s.door === 'S' ? { x: s.x + (s.w >> 1), y: s.y + s.h }
      : s.door === 'N' ? { x: s.x + (s.w >> 1), y: s.y - 1 }
      : s.door === 'E' ? { x: s.x + s.w, y: s.y + (s.h >> 1) }
      : { x: s.x - 1, y: s.y + (s.h >> 1) };
    layPath(c, { waypoints: [doorOut, plazaCentre], zone: false });
  }

  c.anchors.entrance = { x: plazaCentre.x, y: Math.min(opts.height - 1, py + ph) };

  return c.toComposedMap(
    URBAN_NAMES[Math.floor(c.rng() * URBAN_NAMES.length)],
    `A paved settlement square ringed by ${placed} building${placed === 1 ? '' : 's'}, with stone paths converging on a central plaza.`,
  );
}

const URBAN_NAMES = ['Market Square', 'The Old Quarter', 'Cobble Cross', 'Tradesmen’s Row', 'The Town Common', 'Stonemarket'];
