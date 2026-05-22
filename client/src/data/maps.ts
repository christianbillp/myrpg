import { GameMap } from "../net/types";

export interface SavedMapDef extends GameMap {
  id: string;
  name: string;
  description: string;
}

