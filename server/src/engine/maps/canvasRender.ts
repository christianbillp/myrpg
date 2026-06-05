/**
 * ASCII renderer for a MapCanvas. The agentic map generator sends this back to
 * the model after every operation so it can SEE the map it is building and
 * self-correct — the feedback loop the old one-shot generator never had.
 *
 * Each cell becomes one character. The object layer (walls, decor, paths) is
 * drawn on top of the ground layer, mirroring how the game renders. A coordinate
 * ruler frames the grid so the model can place features by (x,y), and a legend
 * lists only the glyphs actually present.
 */
import { MapCanvas } from './MapCanvas.js';
import {
  GROUND_MATERIALS, HAZARD_MATERIALS, WALL_GIDS, PATH_GIDS, WATER_GIDS,
  DECOR_MATERIALS, FURNITURE_MATERIALS,
} from './materials.js';

const strip = (g: number): number => g & 0x1fffffff;

/** Ground GID → glyph (lowercase letters, punctuation, plus hazards/water). */
const GROUND_GLYPHS: Array<[number, string, string]> = [
  [GROUND_MATERIALS.grass,         'g', 'grass'],
  [GROUND_MATERIALS.stone_floor,   '.', 'stone floor'],
  [GROUND_MATERIALS.cracked_stone, ',', 'cracked stone'],
  [43,                             ';', 'stone floor (diamond)'],
  [57,                             ':', 'stone floor (inlay)'],
  [99,                             'n', 'bumpy terrain'],
  [GROUND_MATERIALS.wood_floor,    'w', 'wood floor'],
  [GROUND_MATERIALS.cave_dust,     'd', 'cave dust'],
  [GROUND_MATERIALS.cave_gravel,   'a', 'cave gravel'],
  [GROUND_MATERIALS.cave_rock,     'k', 'cave rock'],
  [GROUND_MATERIALS.cave_smooth,   'm', 'cave smooth'],
  [GROUND_MATERIALS.cobbles,       'o', 'cobbles'],
  [GROUND_MATERIALS.bricks,        'i', 'bricks'],
  [GROUND_MATERIALS.slabs,         'l', 'slabs'],
  [GROUND_MATERIALS.plaza,         'p', 'plaza'],
  [WATER_GIDS.WATER,               '~', 'water'],
  [WATER_GIDS.EDGE_N,              '~', 'water'],
  [WATER_GIDS.EDGE_S,              '~', 'water'],
  [WATER_GIDS.EDGE_E,              '~', 'water'],
  [WATER_GIDS.EDGE_W,              '~', 'water'],
  [WATER_GIDS.OUTER_NW,            '~', 'water'],
  [WATER_GIDS.OUTER_NE,            '~', 'water'],
  [WATER_GIDS.OUTER_SW,            '~', 'water'],
  [WATER_GIDS.OUTER_SE,            '~', 'water'],
  [HAZARD_MATERIALS.pool,          'O', 'pool (impassable)'],
  [HAZARD_MATERIALS.chasm_small,   'X', 'chasm (impassable, blocks sight)'],
  [HAZARD_MATERIALS.chasm,         'X', 'chasm (impassable, blocks sight)'],
  [HAZARD_MATERIALS.chasm_large,   'X', 'chasm (impassable, blocks sight)'],
];

/** Object GID (flags stripped) → glyph. Walls/path share one glyph per family. */
const OBJECT_GLYPHS: Array<[number, string, string]> = [
  [strip(WALL_GIDS.NORTH),             '#', 'wall'],
  [strip(WALL_GIDS.SOUTH),             '#', 'wall'],
  [strip(WALL_GIDS.EAST),              '#', 'wall'],
  [strip(WALL_GIDS.WEST),              '#', 'wall'],
  [strip(WALL_GIDS.CORNER_TL),         '#', 'wall'],
  [strip(WALL_GIDS.CORNER_TR),         '#', 'wall'],
  [strip(WALL_GIDS.CORNER_BL),         '#', 'wall'],
  [strip(WALL_GIDS.CORNER_BR),         '#', 'wall'],
  [strip(WALL_GIDS.PARTIAL_CORNER_UL), '#', 'wall'],
  [strip(WALL_GIDS.PARTIAL_CORNER_UR), '#', 'wall'],
  [strip(WALL_GIDS.PARTIAL_CORNER_LL), '#', 'wall'],
  [strip(WALL_GIDS.PARTIAL_CORNER_LR), '#', 'wall'],
  [39, '%', 'cracked wall (cover, passable)'],
  [81, 'x', 'broken wall (rubble, passable)'],
  [strip(PATH_GIDS.V),                 '+', 'path'],
  [strip(PATH_GIDS.H),                 '+', 'path'],
  [strip(PATH_GIDS.CORNER_SE),         '+', 'path'],
  [strip(PATH_GIDS.CORNER_SW),         '+', 'path'],
  [strip(PATH_GIDS.CORNER_NW),         '+', 'path'],
  [strip(PATH_GIDS.CORNER_NE),         '+', 'path'],
  [strip(PATH_GIDS.INTERSECTION),      '+', 'path'],
  [strip(FURNITURE_MATERIALS.doorway), '/', 'doorway'],
  [strip(FURNITURE_MATERIALS.stairs),  '>', 'stairs (entrance)'],
  [strip(FURNITURE_MATERIALS.table),   '=', 'table'],
  [strip(FURNITURE_MATERIALS.chair),   'H', 'chair'],
  [strip(FURNITURE_MATERIALS.barrels_tall), 'B', 'barrels'],
  [strip(DECOR_MATERIALS.tree),        'T', 'tree'],
  [strip(DECOR_MATERIALS.flowers),     '*', 'flowers'],
  [strip(DECOR_MATERIALS.campfire),    'F', 'campfire'],
  [strip(DECOR_MATERIALS.firewood),    '"', 'firewood'],
  [strip(DECOR_MATERIALS.crate),       'C', 'crate'],
  [strip(DECOR_MATERIALS.barrels),     'B', 'barrels'],
];

const GROUND_MAP = new Map(GROUND_GLYPHS.map(([g, ch]) => [g, ch]));
const OBJECT_MAP = new Map(OBJECT_GLYPHS.map(([g, ch]) => [g, ch]));
const GLYPH_LABEL = new Map<string, string>([
  [' ', 'void (no floor)'],
  ...GROUND_GLYPHS.map(([, ch, label]) => [ch, label] as [string, string]),
  ...OBJECT_GLYPHS.map(([, ch, label]) => [ch, label] as [string, string]),
]);

function glyphFor(c: MapCanvas, x: number, y: number): string {
  const obj = c.getObject(x, y);
  if (obj !== 0) return OBJECT_MAP.get(strip(obj)) ?? '?';
  const ground = c.getGround(x, y);
  if (ground === 0) return ' ';
  return GROUND_MAP.get(strip(ground)) ?? '?';
}

/**
 * Render the canvas as an ASCII grid with a coordinate ruler and a legend of
 * the glyphs in use. Compact enough to send every turn for maps up to 40 wide.
 */
export function renderCanvasAscii(c: MapCanvas): string {
  const tens: string[] = ['  '];
  const ones: string[] = ['  '];
  for (let x = 0; x < c.width; x++) {
    tens.push(x % 10 === 0 ? String((x / 10) | 0) : ' ');
    ones.push(String(x % 10));
  }
  const lines: string[] = [tens.join(''), ones.join('')];
  const used = new Set<string>();
  for (let y = 0; y < c.height; y++) {
    const row: string[] = [String(y % 10), ' '];
    for (let x = 0; x < c.width; x++) {
      const ch = glyphFor(c, x, y);
      used.add(ch);
      row.push(ch);
    }
    lines.push(row.join(''));
  }
  const legend = [...used].filter((ch) => ch !== ' ' || used.has(' '))
    .sort()
    .map((ch) => `  '${ch}' = ${GLYPH_LABEL.get(ch) ?? 'unknown'}`)
    .join('\n');
  return `${c.width}×${c.height} map (x→ right, y→ down):\n${lines.join('\n')}\n\nLEGEND:\n${legend}`;
}
