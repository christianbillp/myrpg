// Re-export the shared types so server code can keep importing from this path.
// New types should be added to shared/types.ts, not here.
export * from '../../../shared/types.js';

import type { PlayerDef, MonsterDef, NPCDef, ItemDef, FeatDef, BackgroundDef, SpeciesDef, SavedMapDef, TileLegend, SpellDef, FeatureDef, NarrationDef, FactionDef, SettingDef, ConversationDef, ClassDef, SubclassDef } from '../../../shared/types.js';

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
  /** Authored quest definitions loaded from `server/data/settings/<id>/quests/*.json`
   *  (and the default set). Resolved by id when a quest is started. */
  quests: import('../../../shared/types.js').QuestDef[];
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
  /** Merged tile legend(s) from server/data/tilesets/*_legend.json — used as a passability fallback when an encounter omits a GID from its tileProperties. NOTE: the merge collides GID keys across tilesets (scribble 8 = grass, water 8 = water_edge_w); for gameplay resolution use `tileLegendsByTileset` instead. Kept only for AI map-prompt listings. */
  tileLegend: TileLegend;
  /** Per-tileset tile legends keyed by tileset base name ("scribble", "water"). Each is that tileset's own GID→entry map (keyed by standalone id = local frame + 1). Used for collision-free movement / sight / cover resolution in SessionBuilder. */
  tileLegendsByTileset: Record<string, TileLegend['tiles']>;
  /** Conversation graphs loaded from the active setting's `conversations/`
   *  directory. Empty when no setting is active. The conversation system
   *  looks up an NPC's `conversationId` here at start time. */
  conversations: ConversationDef[];
  /** US-129 ambient banter packs loaded from the active setting's `banter/`
   *  directory. Short NPC-to-NPC exchanges the world tick plays between idle
   *  NPCs. Empty when no setting is active. */
  banter: import('../../../shared/types.js').BanterPack[];
  /** Class definitions loaded from `server/data/classes/*.json`. Drive the
   *  level-up resolver, character-build defaults, and per-class scaling
   *  tables (Sneak Attack dice, Second Wind uses, etc.). */
  classes: ClassDef[];
  /** Subclass definitions loaded from `server/data/subclasses/*.json`. Each
   *  carries a `classId` referencing its parent and a `progression[]` that
   *  hangs off the parent's `subclassLevels`. */
  subclasses: SubclassDef[];
}
