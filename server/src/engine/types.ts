// Re-export the shared types so server code can keep importing from this path.
// New types should be added to shared/types.ts, not here.
export * from '../../../shared/types.js';

import type { PlayerDef, MonsterDef, NPCDef, ItemDef, FeatDef, BackgroundDef, SpeciesDef, SavedMapDef, TileLegend, SpellDef, FeatureDef, NarrationDef, FactionDef } from '../../../shared/types.js';

// ── Server-only types ────────────────────────────────────────────────────────

export interface GameDefs {
  playerDefs: PlayerDef[];
  monsters: MonsterDef[];
  npcs: NPCDef[];
  equipment: ItemDef[];
  maps: SavedMapDef[];
  feats: FeatDef[];
  backgrounds: BackgroundDef[];
  species: SpeciesDef[];
  spells: SpellDef[];
  features: FeatureDef[];
  narration: NarrationDef[];
  /**
   * Faction definitions loaded from `server/data/factions/*.json`. Each carries
   * an id, display name + colour, renown rating, and a default-relation table.
   * Seeds `GameState.factionRelations` at session creation.
   */
  factions: FactionDef[];
  /** Merged tile legend(s) from server/data/tilesets/*_legend.json — used as a passability fallback when an encounter omits a GID from its tileProperties. */
  tileLegend: TileLegend;
}
