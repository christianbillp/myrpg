import { GameMap } from "../systems/MapGenerator";

export interface SavedMapDef extends GameMap {
  id: string;
  name: string;
  description: string;
}

