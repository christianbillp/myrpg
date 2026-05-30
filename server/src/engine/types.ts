// Re-export the shared types so server code can keep importing from this path.
// New types should be added to shared/types.ts, not here.
export * from '../../../shared/types.js';

import type { PlayerDef, MonsterDef, NPCDef, ItemDef, FeatDef, BackgroundDef, SpeciesDef, SavedMapDef, TileLegend, SpellDef, FeatureDef, NarrationDef, FactionDef, SettingDef } from '../../../shared/types.js';

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
  /**
   * Loaded campaign settings under `server/data/settings/<id>/setting.md`.
   * Each entry carries the parsed frontmatter + H2 sections. The active
   * setting (if any) is exposed via `activeSetting`; AI prompts and the
   * `lookup_setting` tool source their content from it.
   */
  settings: SettingDef[];
  /** Currently selected setting — null when only core rules apply. Chosen at
   *  startup from `ACTIVE_SETTING_ID` env var or the first loaded setting. */
  activeSetting: SettingDef | null;
  /** Merged tile legend(s) from server/data/tilesets/*_legend.json — used as a passability fallback when an encounter omits a GID from its tileProperties. */
  tileLegend: TileLegend;
}
