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

