/**
 * Tavern composer — a single-room tavern building set in a grass surround.
 * Layout follows the `tavern_small` / `tavern_keg` reference maps:
 *   • Wooden-plank floor (gid 85) over the whole interior footprint.
 *   • Wall ring on the object layer using the same transparent-twin tiles
 *     buildings / dungeons use (10 corners, 11 straights).
 *   • One doorway centred on the south wall (gid 26, no wall object).
 *   • A bar counter — `wooden_plank_transparent` (gid 14) in a row two
 *     cells below the north wall, spanning most of the interior width.
 *     A 3-barrel stack sits behind each end of the bar.
 *   • 2–4 small tables (single plank cells) in the lower interior, each
 *     ringed with 1–2 chairs (gid 28).
 *
 * Zones emitted: `tavern` (full interior), `bar` (counter row), `tables`
 * (every standalone table cell).
 *
 * Anchor: `entrance` is the cell immediately south of the doorway, where a
 * visitor steps onto the porch.
 */
import type { ComposedMap, MapAnchors, MapZone } from '../mapTypes.js';
import { FURNITURE_GIDS, TERRAIN_GIDS, WALL_GIDS } from '../mapTiles.js';
import { SCRIBBLE_TILESET, flatten } from './shared.js';

export interface ComposeTavernOpts {
  width: number;
  height: number;
  rng: () => number;
  allocZoneId: (kind: string) => string;
}

export function composeTavern(opts: ComposeTavernOpts): ComposedMap {
  const { width: W, height: H, rng, allocZoneId } = opts;
  const terrainGrid: number[][] = [];
  const objectGrid: number[][]  = [];
  for (let r = 0; r < H; r++) {
    terrainGrid.push(new Array<number>(W).fill(TERRAIN_GIDS.GRASS));
    objectGrid.push(new Array<number>(W).fill(0));
  }

  const tw = Math.max(10, Math.min(W - 4, 14 + Math.floor(rng() * 5)));   // 14..18 ideally
  const th = Math.max(7,  Math.min(H - 4,  8 + Math.floor(rng() * 3)));   // 8..10
  const tx = Math.floor((W - tw) / 2);
  const ty = Math.floor((H - th) / 2);
  const doorC = tx + Math.floor(tw / 2);

  const interiorCells: string[] = [];
  for (let r = ty; r < ty + th; r++) {
    for (let c = tx; c < tx + tw; c++) {
      terrainGrid[r][c] = TERRAIN_GIDS.WOOD_FLOOR;
      interiorCells.push(`${c},${r}`);

      const isN = r === ty, isS = r === ty + th - 1;
      const isW = c === tx, isE = c === tx + tw - 1;
      if (!(isN || isS || isW || isE)) continue;
      // South-wall doorway, rotated 180° so the open arch faces out the south
      // edge (the tile's art opens to the top by default).
      if (isS && c === doorC) { objectGrid[r][c] = FURNITURE_GIDS.DOORWAY + 0xC0000000; continue; }
      if (isN && isW)      objectGrid[r][c] = WALL_GIDS.CORNER_TL;
      else if (isN && isE) objectGrid[r][c] = WALL_GIDS.CORNER_TR;
      else if (isS && isW) objectGrid[r][c] = WALL_GIDS.CORNER_BL;
      else if (isS && isE) objectGrid[r][c] = WALL_GIDS.CORNER_BR;
      else if (isN)        objectGrid[r][c] = WALL_GIDS.NORTH;
      else if (isS)        objectGrid[r][c] = WALL_GIDS.SOUTH;
      else if (isW)        objectGrid[r][c] = WALL_GIDS.WEST;
      else                 objectGrid[r][c] = WALL_GIDS.EAST;
    }
  }

  // Bar counter — row of plank tiles 2 cells below the north wall, with a
  // 2-cell pad from the side walls; 3-barrel stacks bookend it.
  const barRow = ty + 2;
  const barStart = tx + 2;
  const barEnd   = tx + tw - 3;
  const barCells: string[] = [];
  for (let c = barStart; c <= barEnd; c++) {
    objectGrid[barRow][c] = FURNITURE_GIDS.WOODEN_PLANK;
    barCells.push(`${c},${barRow}`);
  }
  if (objectGrid[ty + 1]?.[barStart] === 0) objectGrid[ty + 1][barStart] = FURNITURE_GIDS.BARRELS_THREE;
  if (objectGrid[ty + 1]?.[barEnd]   === 0) objectGrid[ty + 1][barEnd]   = FURNITURE_GIDS.BARRELS_THREE;

  // Tables — single plank tiles in the lower interior with 1..2 chairs adjacent.
  const tableCount = 2 + Math.floor(rng() * 3);   // 2..4
  const tableCells: string[] = [];
  const tableMinRow = barRow + 2;
  const tableMaxRow = ty + th - 2;
  for (let i = 0; i < tableCount; i++) {
    for (let attempt = 0; attempt < 24; attempt++) {
      const cx = tx + 2 + Math.floor(rng() * Math.max(1, tw - 4));
      const cy = tableMinRow + Math.floor(rng() * Math.max(1, tableMaxRow - tableMinRow + 1));
      if (objectGrid[cy][cx] !== 0) continue;
      const sides: Array<[number, number]> = [[0, -1], [0, 1], [-1, 0], [1, 0]];
      for (let s = sides.length - 1; s > 0; s--) {
        const j = Math.floor(rng() * (s + 1));
        [sides[s], sides[j]] = [sides[j], sides[s]];
      }
      let chairsPlaced = 0;
      const wantChairs = 1 + Math.floor(rng() * 2);
      const reservedChairs: Array<[number, number]> = [];
      for (const [dx, dy] of sides) {
        if (chairsPlaced >= wantChairs) break;
        const nx = cx + dx, ny = cy + dy;
        if (nx <= tx || nx >= tx + tw - 1 || ny <= ty || ny >= ty + th - 1) continue;
        if (objectGrid[ny][nx] !== 0) continue;
        reservedChairs.push([nx, ny]);
        chairsPlaced++;
      }
      if (chairsPlaced === 0) continue;
      objectGrid[cy][cx] = FURNITURE_GIDS.WOODEN_PLANK;
      tableCells.push(`${cx},${cy}`);
      for (const [nx, ny] of reservedChairs) objectGrid[ny][nx] = FURNITURE_GIDS.CHAIR;
      break;
    }
  }

  const zones: MapZone[] = [];
  zones.push({ id: allocZoneId('tavern'), name: 'tavern', color: '#aa7755', cells: interiorCells.sort() });
  if (barCells.length > 0)    zones.push({ id: allocZoneId('bar'),    name: 'bar',    color: '#cc9966', cells: barCells.sort() });
  if (tableCells.length > 0)  zones.push({ id: allocZoneId('tables'), name: 'tables', color: '#ccaa44', cells: tableCells.sort() });

  const anchors: MapAnchors = {};
  anchors.entrance = { x: doorC, y: Math.min(ty + th, H - 1) };

  return {
    width: W, height: H,
    terrainData: flatten(terrainGrid),
    objectData: flatten(objectGrid),
    name: tavernName(tw, rng),
    description: tavernDescription(tableCount, tw, th),
    tilesets: [SCRIBBLE_TILESET],
    anchors,
    zones,
  };
}

const TAVERN_NAMES_SMALL = ['Roadside Tavern', 'The Old Inn', 'The Wayside Keg', 'The Quiet Hearth'];
const TAVERN_NAMES_LARGE = ['The Common Hall', 'The Tall Lantern', 'The Drover’s Inn', 'The Long Bar'];

function tavernName(buildingWidth: number, rng: () => number): string {
  const pool = buildingWidth >= 16 ? TAVERN_NAMES_LARGE : TAVERN_NAMES_SMALL;
  return pool[Math.floor(rng() * pool.length)];
}

function tavernDescription(tableCount: number, buildingWidth: number, buildingHeight: number): string {
  const size = buildingWidth >= 16 ? 'spacious' : 'snug';
  return `A ${size} wood-floored tavern (${buildingWidth}×${buildingHeight}) with a bar along the north wall and ${tableCount} table${tableCount === 1 ? '' : 's'} for patrons. Doorway opens to the south.`;
}
