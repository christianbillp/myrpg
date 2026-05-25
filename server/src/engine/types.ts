// Re-export the shared types so server code can keep importing from this path.
// New types should be added to shared/types.ts, not here.
export * from '../../../shared/types.js';

import type { PlayerDef, MonsterDef, NPCDef, ItemDef, FeatDef, BackgroundDef, SpeciesDef } from '../../../shared/types.js';

// ── Server-only types ────────────────────────────────────────────────────────

export interface GameDefs {
  playerDefs: PlayerDef[];
  monsters: MonsterDef[];
  npcs: NPCDef[];
  equipment: ItemDef[];
  maps: { id: string; passable: boolean[][]; cols: number; rows: number; name: string; mapdescription: string }[];
  feats: FeatDef[];
  backgrounds: BackgroundDef[];
  species: SpeciesDef[];
}
