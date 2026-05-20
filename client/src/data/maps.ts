import { GameMap } from "../systems/MapGenerator";

export interface SavedMapDef {
  id: string;
  name: string;
  description: string;
  rows: string[];
}

export function toGameMap(def: SavedMapDef): GameMap {
  const numRows = def.rows.length;
  const numCols = def.rows[0]?.length ?? 0;
  const passable = def.rows.map((row) => [...row].map((c) => c === "."));
  return { cols: numCols, rows: numRows, passable };
}

export const SAVED_MAPS: SavedMapDef[] = [
  {
    id: "arena",
    name: "Arena",
    description: "An open fighting pit with\nsymmetric stone pillars.",
    rows: [
      "################",
      "#..............#",
      "#.##........##.#",
      "#..............#",
      "#...##....##...#",
      "#..............#",
      "#..............#",
      "#...##....##...#",
      "#..............#",
      "#.##........##.#",
      "#..............#",
      "################",
    ],
  },
  {
    id: "dungeon",
    name: "Dungeon",
    description: "Two chambers divided by\na wall, linked by a gap.",
    rows: [
      "####################",
      "#.......####.......#",
      "#.......####.......#",
      "#.......####.......#",
      "#..................#",
      "#.......####.......#",
      "#.......####.......#",
      "#.......####.......#",
      "#.......####.......#",
      "#.......####.......#",
      "#.......####.......#",
      "####################",
    ],
  },
  {
    id: "ruins",
    name: "Ruins",
    description: "Scattered rubble across\nan open battlefield.",
    rows: [
      "####################",
      "#..................#",
      "#.##...........##..#",
      "#..................#",
      "#....##.....##.....#",
      "#..................#",
      "#..................#",
      "#.....##.....##....#",
      "#..................#",
      "#..##...........##.#",
      "#..................#",
      "#..................#",
      "#.##...........##..#",
      "####################",
    ],
  },
  {
    id: "catacombs",
    name: "Catacombs",
    description: "Winding corridors through\nancient stone passages.",
    rows: [
      "################",
      "#..............#",
      "##############.#",
      "#..............#",
      "#.##############",
      "#..............#",
      "##############.#",
      "#..............#",
      "#.##############",
      "#..............#",
      "#..............#",
      "################",
    ],
  },
];
