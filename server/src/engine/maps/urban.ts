/**
 * Urban composer — a dense paved village: a central plaza, winding through-
 * streets, and many small buildings packed across the map with their doors
 * fronting the square, each joined to it by a crooked lane. Built on the shared
 * `MapCanvas` + op toolbox, so deterministic and AI-authored towns render
 * identically. Deterministic from the seed.
 */
import type { ComposedMap } from '../mapTypes.js';
import { MapCanvas } from './MapCanvas.js';
import { fillTerrain, placeBuilding, layPath, paintRegion, defineZone, type Point } from './mapOps.js';

export interface ComposeUrbanOpts { width: number; height: number; seed: number; buildingsCount?: number; }

export function composeUrban(opts: ComposeUrbanOpts): ComposedMap {
  const W = opts.width, H = opts.height;
  const c = new MapCanvas({ width: W, height: H, seed: opts.seed });
  fillTerrain(c, { biome: 'urban' });
  const clampX = (x: number): number => Math.max(1, Math.min(W - 2, x));
  const clampY = (y: number): number => Math.max(1, Math.min(H - 2, y));
  const jitter = (): number => Math.floor(c.rng() * 5) - 2;

  // Smaller central plaza of finer slabs — leaves room for a denser town.
  const pw = Math.max(4, Math.floor(W * 0.22));
  const ph = Math.max(4, Math.floor(H * 0.22));
  const px = Math.floor((W - pw) / 2);
  const py = Math.floor((H - ph) / 2);
  paintRegion(c, { rect: { x: px, y: py, w: pw, h: ph }, material: 'slabs', layer: 'ground' });
  defineZone(c, { name: 'plaza', color: '#c8b78a', rect: { x: px, y: py, w: pw, h: ph } });
  // Reserve the plaza so buildings keep off the square.
  for (let y = py; y < py + ph; y++) for (let x = px; x < px + pw; x++) c.reserve(x, y);
  const plaza = { cx: px + (pw >> 1), cy: py + (ph >> 1) };

  // Two winding through-streets crossing at the plaza — meandering waypoint
  // lists give the lanes their crook.
  layPath(c, { waypoints: [
    { x: 0, y: clampY(plaza.cy + jitter()) },
    { x: clampX(Math.floor(W * 0.3)), y: clampY(plaza.cy + jitter()) },
    { x: plaza.cx, y: plaza.cy },
    { x: clampX(Math.floor(W * 0.7)), y: clampY(plaza.cy + jitter()) },
    { x: W - 1, y: clampY(plaza.cy + jitter()) },
  ] });
  layPath(c, { waypoints: [
    { x: clampX(plaza.cx + jitter()), y: 0 },
    { x: clampX(plaza.cx + jitter()), y: clampY(Math.floor(H * 0.3)) },
    { x: plaza.cx, y: plaza.cy },
    { x: clampX(plaza.cx + jitter()), y: clampY(Math.floor(H * 0.7)) },
    { x: clampX(plaza.cx + jitter()), y: H - 1 },
  ] });

  // Pack buildings across the whole map (not just the corners). Each fronts the
  // plaza with its door and is joined to it by a crooked lane.
  const want = Math.max(4, Math.min(12, Math.floor(opts.buildingsCount ?? 8)));
  const fits = (x: number, y: number, w: number, h: number): boolean => {
    for (let r = y - 1; r <= y + h; r++) for (let col = x - 1; col <= x + w; col++) {
      if (col < 0 || col >= W || r < 0 || r >= H || c.isReserved(col, r)) return false;
    }
    return true;
  };
  let placed = 0;
  for (let a = 0; a < 400 && placed < want; a++) {
    const w = 4 + Math.floor(c.rng() * 3);  // 4..6
    const h = 4 + Math.floor(c.rng() * 2);  // 4..5
    const x = 1 + Math.floor(c.rng() * Math.max(1, W - w - 2));
    const y = 1 + Math.floor(c.rng() * Math.max(1, H - h - 2));
    if (!fits(x, y, w, h)) continue;
    const bcx = x + (w >> 1), bcy = y + (h >> 1);
    // Door on the side facing the plaza.
    const dxp = plaza.cx - bcx, dyp = plaza.cy - bcy;
    const door: 'N' | 'S' | 'E' | 'W' = Math.abs(dxp) > Math.abs(dyp) ? (dxp > 0 ? 'E' : 'W') : (dyp > 0 ? 'S' : 'N');
    if (!placeBuilding(c, { x, y, w, h, doorSide: door, floor: 'wood_floor', name: `building ${placed + 1}` }).ok) continue;
    placed++;
    const doorOut: Point = door === 'S' ? { x: bcx, y: y + h }
      : door === 'N' ? { x: bcx, y: y - 1 }
      : door === 'E' ? { x: x + w, y: bcy }
      : { x: x - 1, y: bcy };
    // Crooked lane from the door to the nearest plaza cell, via a jittered jog.
    const target: Point = { x: clampX(Math.max(px, Math.min(px + pw - 1, doorOut.x))), y: clampY(Math.max(py, Math.min(py + ph - 1, doorOut.y))) };
    const jog: Point = { x: clampX(Math.floor((doorOut.x + target.x) / 2) + jitter()), y: clampY(Math.floor((doorOut.y + target.y) / 2) + jitter()) };
    layPath(c, { waypoints: [doorOut, jog, target], zone: false });
  }

  c.anchors.entrance = { x: plaza.cx, y: clampY(py + ph) };

  return c.toComposedMap(
    URBAN_NAMES[Math.floor(c.rng() * URBAN_NAMES.length)],
    `A dense village of ${placed} building${placed === 1 ? '' : 's'} along winding lanes around a central plaza.`,
  );
}

const URBAN_NAMES = ['Market Square', 'The Old Quarter', 'Cobble Cross', 'Tradesmen’s Row', 'The Town Common', 'Stonemarket'];
