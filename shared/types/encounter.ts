/**
 * EncounterDef + secrets + starting zones.
 *
 * Extracted from the original god-file `shared/types.ts` (now a barrel that
 * re-exports every domain module under `shared/types/`).
 */

// Cross-domain imports — keep these explicit so the dependency graph is visible.
import type { ConversationDef } from "./conversation.js";
import type { NPCDef } from "./entities.js";
import type { EncounterTrigger } from "./triggers.js";

export type SecretReward =
  | { type: 'coins'; cp: number }
  | { type: 'item'; itemId: string }
  | { type: 'lore'; text: string };

export interface SecretDef {
  id: string; dc: number; reward: SecretReward; successText: string; failureText: string;
}

/**
 * Tileset metadata surfaced to the client so it can preload the atlas and
 * slice the spritesheet correctly. `imageUrl` is server-relative
 * (e.g. "/tilesets/roguelike.png"). Tile frame = `gid - firstgid`.
 */
export interface MapTilesetInfo {
  firstgid: number;
  name: string;
  imageUrl: string;
  imagewidth: number;
  imageheight: number;
  tilewidth: number;
  tileheight: number;
  spacing: number;
  margin: number;
  columns: number;
  /**
   * Per-tile movement blocking extracted from the source .tsj's
   * `tiles[].properties`. Keyed by tileset-local tile id (i.e. `gid - firstgid`).
   * Tiles absent from this map default to NOT blocking movement, matching
   * Tiled's convention that unmarked tiles have no restrictions.
   */
  tileBlocksMovement: Record<number, boolean>;
}

// Map definition as served by the API. Maps are pure geometry now:
// they carry the GID grid(s) plus identity/dimensions/description, with NO
// tile semantics. Whether a tile is passable, difficult, trapped, etc. is
// declared per-encounter via EncounterDef.tileProperties.
//
// Maps may carry a second optional object layer drawn on top of the ground
// layer (doors, trees, furniture, etc.). A GID of 0 in the object layer means
// "no object on this cell". A cell is passable iff its ground GID is passable
// AND its object GID (if non-zero) is also passable.
export interface SavedMapDef {
  id: string;
  name: string;
  mapdescription: string;
  cols: number;
  rows: number;
  /** Row-major 2D grid of GIDs from the map's ground layer. */
  gidGrid: number[][];
  /** Row-major 2D grid of GIDs from the map's optional object layer. 0 = empty. */
  objectGidGrid?: number[][];
  /** Tileset metadata for client-side rendering. */
  tilesets: MapTilesetInfo[];
  /** Author-time named tile regions saved with the map. Consumed by the
   *  Map Editor, the session light bake (US-126 — a zone's `lightLevel`
   *  becomes the per-tile ambient light of its cells), and encounter-
   *  generation passes that want to describe "the altar / guardtower /
   *  road" by location. Optional — hand-authored maps that pre-date the
   *  feature simply omit it. */
  zones?: Array<{ id: string; name: string; color: string; cells: string[]; lightLevel?: 'bright' | 'dim' | 'dark' }>;
}

/**
 * Per-GID tile semantics declared by an encounter. Each entry describes how
 * the encounter wants a particular tile from the referenced map to behave
 * during this scenario. Encounters MAY reuse the same map with different
 * properties (e.g. one runs a bridge with broken walls passable, another
 * keeps them solid).
 *
 * Lookup priority for a tile's `blocksMovement` / `blocksSight` flags:
 *   1. Encounter's tileProperties (this type) — explicit override.
 *   2. The source tileset's per-tile data (`MapTilesetInfo.tileBlocksMovement`).
 *   3. The global tile legend.
 *   4. Default `false` (unmarked tiles neither block movement nor sight).
 */
export interface EncounterTileProperty {
  gid: number;
  /** When true, creatures cannot walk onto this tile. */
  blocksMovement?: boolean;
  /** When true, line-of-sight cannot pass through this tile (wall, dense
   *  foliage). Independent of movement — a chasm blocks movement but not
   *  sight; a glass wall blocks sight but not movement. */
  blocksSight?: boolean;
  /** SRD 5.2.1 Cover — tiles between an attacker and a target contribute to
   *  the target's effective cover. The `Vision.canSee` LOS walker collects
   *  the worst cover along the line and the combat resolver translates it
   *  to an AC bonus: half (+2), three-quarters (+5), total (untargetable). */
  cover?: 'half' | 'three-quarters' | 'total';
  /** SRD 5.2.1 Obscurance — `lightly` imposes Disadvantage on Wisdom
   *  (Perception) checks to see into the tile; `heavily` Blinds the
   *  observer while looking into it AND counts as a valid Hide cover for
   *  the SRD Hide action. */
  obscurance?: 'lightly' | 'heavily';
  // Future, currently parsed-but-unused:
  // difficult?: boolean;     // costs 2 ft of movement per ft (US-044)
  // trapped?: { dc: number; damageDice: number; damageSides: number; damageType: string };
}

/**
 * One worldbuilding "Setting" — a markdown-authored campaign world that both
 * the dev AI (encounter generator) and the in-game GM reference as ground
 * truth. Loaded from `server/data/settings/<id>/setting.md` at startup; the
 * markdown's frontmatter populates the metadata fields, and each `## ` H2
 * heading becomes an entry in `sectionsByName` (keyed by the section's
 * kebab-cased title). The dev AI gets the full text injected as system
 * context (one-shot, no tool loop), while the in-game GM gets the `summary`
 * up-front and pulls specific sections via the `lookup_setting` tool on
 * demand.
 */
export interface SettingDef {
  /** Stable id, drawn from frontmatter. Used in paths and save persistence. */
  id: string;
  /** Display name shown to the player. */
  name: string;
  /** Author-supplied version string; bumped when the setting markdown changes
   *  in a meaningful way. Pinned into the save on creation. */
  version: string;
  /** Optional ruleset tag (e.g. `srd-5.2.1`) for future cross-system support. */
  ruleset?: string;
  /** One-paragraph summary. Always injected into AI prompts when the setting
   *  is active; covers tone, central conflict, and one or two specific cues. */
  summary: string;
  /** Kebab-cased H2 section ids found in the setting.md body (e.g.
   *  `history`, `political-structure`). These are the **core canon** — always
   *  in scope; the GM looks them up via `lookup_setting`. */
  sections: string[];
  /** Full text of each H2 section, keyed by section id. Carries the raw
   *  markdown body (excluding the H2 heading line itself). */
  sectionsByName: Record<string, string>;
  /** Supplementary entries loaded from `<settingDir>/worldbook/*.md`. Each
   *  file is one topic (faction, named NPC, location, event) the AIGM fetches
   *  on demand via `lookup_worldbook`. Empty when the setting has no
   *  worldbook folder. */
  worldbook: WorldbookEntry[];
  /** Same entries keyed by id for quick lookup. */
  worldbookById: Record<string, WorldbookEntry>;
}

/**
 * One supplementary worldbook topic — a faction dossier, named-NPC backstory,
 * location entry, or world event that's too specific for the always-listed
 * `setting.md` canon. Loaded from `<settingDir>/worldbook/*.md`.
 */
export interface WorldbookEntry {
  /** Stable kebab-case id from frontmatter (falls back to the filename). */
  id: string;
  /** Display title (e.g. "The Concordat"). Defaults to `id` when absent. */
  title: string;
  /** Free-form category — common values: `"faction"`, `"npc"`,
   *  `"location"`, `"event"`, `"system"`. Used for grouping in the prompt. */
  type?: string;
  /** Optional cross-link to a `factions/<id>.json` def so the worldbook
   *  prose and the mechanical faction definition can find each other. */
  relatedFactionId?: string;
  /** Optional cross-link to an `npcs/<id>.json` def for named-NPC entries. */
  relatedNpcId?: string;
  /** Optional tags for grouping / search (e.g. `["magic-regulation"]`). */
  tags?: string[];
  /** Raw markdown body (everything after the closing `---` of the
   *  frontmatter). Returned verbatim by `lookup_worldbook`. */
  body: string;
}

/**
 * AI-facing tile legend loaded from server/data/tilesets/*_legend.json. The
 * legend describes each tile's semantics for both AI authoring (so an LLM can
 * generate maps) and as a passability fallback for encounters that don't
 * declare every GID in their `tileProperties`.
 *
 * Legend keys are GIDs assuming the tileset is referenced at `firstgid: 1`.
 * If a map ever loads the tileset at a different firstgid, the keys must be
 * offset accordingly.
 */
export interface TileLegendEntry {
  name: string;
  /** When true, creatures cannot walk onto this tile (wall, tree, chasm). */
  blocksMovement: boolean;
  /** When true, line-of-sight cannot pass through this tile. Independent of
   *  movement: a chasm blocks movement but not sight; a glass wall blocks
   *  sight but not movement. */
  blocksSight: boolean;
  /** Which layer this tile belongs on. `"ground"` is drawn first; `"object"` is overlaid on top. */
  layer: 'ground' | 'object';
  description: string;
  tags: string[];
  /** SRD Cover the tile provides by default (Vision/combat). Encounter
   *  `tileProperties` overrides this per-encounter. */
  cover?: 'half' | 'three-quarters' | 'total';
  /** SRD Obscurance the tile imposes by default. */
  obscurance?: 'lightly' | 'heavily';
}
export interface TileLegend {
  notes: string;
  /** Map of GID string -> legend entry. */
  tiles: Record<string, TileLegendEntry>;
}

/**
 * Per-encounter spawn-zone overlay in a Tiled-compatible tile-layer shape.
 * `data` is a flat row-major array of GIDs of length `width × height`.
 *
 * GID encoding (fixed, implicit "spawn zones" tileset):
 *   0 = no spawn here (default)
 *   1 = player spawn       (was 'P' in the old ASCII overlay)
 *   2 = ally spawn         (was 'A')
 *   3 = neutral NPC spawn  (was 'N')
 *   4 = enemy spawn        (was 'E')
 *
 * Only passable map tiles are eligible for spawning regardless of zone GID.
 */
export interface StartingZonesLayer {
  width: number;
  height: number;
  data: number[];
}

/**
 * Exact spawn binding for a single entity slot. Consumed only when the
 * encounter's `placementMode === "exact"`. See `EncounterDef.placements`
 * for the binding rules. The player role has no `index` (singleton); every
 * other role's `index` is the position in `enemyIds[]` / `allyIds[]` /
 * `npcIds[]` (0-based, ordering matches the encounter JSON).
 */
export type EncounterPlacement =
  | { role: 'player'; x: number; y: number }
  | { role: 'enemy';   index: number; x: number; y: number }
  | { role: 'ally';    index: number; x: number; y: number }
  | { role: 'neutral'; index: number; x: number; y: number };

/**
 * Authored trap placement in an encounter JSON. SessionBuilder turns each one
 * into a runtime `TrapState`. `hidden` (default true) starts the trap concealed
 * so it must be detected; `disarmDC` defaults to the SRD Thieves' Tools DC 15.
 */
export interface EncounterTrapDef {
  id: string;
  name: string;
  x: number;
  y: number;
  hidden?: boolean;
  detectDC: number;
  disarmDC?: number;
  trigger: {
    saveAbility?: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';
    saveDC: number;
    damageDice: number;
    damageSides: number;
    damageBonus?: number;
    damageType: string;
    halfOnSave?: boolean;
    condition?: string;
  };
  triggeredMessage?: string;
  tintHex?: string;
}

// Encounter card definition (the JSON files in server/data/encounters/).
export interface EncounterDef {
  id: string;
  encounterTitle: string;
  description: string;
  mapId: string;
  npcIds?: string[];
  allyIds?: string[];
  /**
   * Creature def ids spawned as hostile combatants. Each id is resolved
   * against the NPC roster first, then the monster roster, so encounters
   * can mix named NPCs (e.g. `bridge_bandit`) and raw monster defs
   * (`bandit`, `wolf`) freely. Unlike `npcIds`, these spawn regardless of
   * encounter type and get `disposition: 'enemy'` plus an assigned
   * combat label. Used by the deterministic compose-encounter flow on
   * `GenerateSetupScene` so the player's hand-picked enemies appear
   * exactly as chosen (instead of the legacy random-monster spawn that
   * keys off `encounterContext.enemyCount`).
   */
  enemyIds?: string[];
  /**
   * GMPC `PlayerDef` ids (US-130) — full player characters the GM controls and
   * roleplays. Spawned as party members (ally disposition) with their complete
   * kit (class, spells with slots, features, fighting styles). Resolved against
   * the character roster (`defs.playerDefs`). Each gets a `gmpc_<defId>` id; the
   * GM drives them via the `gmpc_act` AIGM tool.
   */
  gmpcIds?: string[];
  customIntroduction?: string;
  customContext?: string;
  /**
   * When true the encounter offers Long Rest — the Player Panel surfaces a
   * LONG REST button during exploration. SRD: a Long Rest is "8 hours of
   * extended downtime" so the gate should match settings where that fits
   * (taverns, safehouses, established camps). Defaults to false.
   */
  allowsLongRest?: boolean;
  /**
   * Per-NPC conversation overrides — keyed by NPC def id, value is a
   * `ConversationDef.id`. Lets one encounter give a recurring NPC a
   * scene-specific dialogue without editing the NPC's default conversation.
   * Falls back to `NPCDef.conversationId` when an override isn't set.
   */
  conversationOverrides?: Record<string, string>;
  /**
   * Per-GID semantics for the referenced map's tiles in this encounter.
   * Required to make any tile of the map passable; tiles without a matching
   * entry are treated as impassable by SessionBuilder.
   */
  tileProperties?: EncounterTileProperty[];
  startingZones?: StartingZonesLayer;
  /**
   * Starting-location mode for this encounter:
   *   • `"zones"` (default) — entities spawn randomly inside the rectangles
   *     painted in `startingZones`. The current behaviour for every existing
   *     encounter.
   *   • `"exact"` — entities listed in `placements[]` spawn at the exact
   *     tile they're bound to; any entity NOT in `placements` falls back to
   *     the `"zones"` path (so partial exact authoring works without
   *     reauthoring zone rectangles for every NPC).
   * Omitted = `"zones"`.
   */
  placementMode?: 'zones' | 'exact';
  /**
   * Per-entity exact placements (consumed only when `placementMode: "exact"`).
   * Each entry binds one entity slot to a tile. The `role` selects the
   * relevant slot list; `index` is the position in that list (0-based) and
   * matches `enemyIds[]` / `allyIds[]` / `npcIds[]` ordering. Player slots
   * have no index — there's only one player per encounter.
   *
   *   { role: 'player', x, y }                  // player start tile
   *   { role: 'enemy',   index: 0, x, y }       // enemyIds[0]
   *   { role: 'ally',    index: 1, x, y }       // allyIds[1]
   *   { role: 'neutral', index: 2, x, y }       // npcIds[2]
   *
   * Indices that don't have a matching slot are silently ignored. Slots
   * without a placement entry fall back to the zone-based spawn search.
   */
  placements?: EncounterPlacement[];
  /**
   * Authored gameplay scripts (ambushes, reinforcements, scripted reveals).
   * Each trigger declares a condition (player enters a tile region, an NPC
   * dies, etc.) and a list of actions to fire when the condition matches.
   * See `server/src/engine/TriggerSystem.ts` for the runtime evaluator.
   */
  triggers?: EncounterTrigger[];
  /**
   * Concealed tile traps placed in this encounter. Each is spotted via
   * Perception, removed via the Disarm action, or springs when the player
   * steps onto its tile. Instantiated into `GameState.traps` by SessionBuilder.
   */
  traps?: EncounterTrapDef[];
  /**
   * Player-facing one-line objective for this encounter
   * ("OBJECTIVE: Defeat the bandits", "OBJECTIVE: Investigate the dungeon").
   * Optional — when omitted, a generic "Complete the encounter" default is
   * supplied by `buildEncounter` in `encounterService.ts`.
   */
  objective?: string;
  /**
   * True when the encounter file was authored by the AI generator (see
   * `server/src/encounterGenerator.ts`). Renders a `✦ GENERATED` badge on
   * the Encounter Setup card so the player can distinguish hand-authored
   * scenarios from one-offs.
   */
  generated?: boolean;
  /**
   * Marks this encounter as a **demo** built to exercise a specific engine
   * implementation (a new system, mechanic, or content shape). The Encounter
   * Setup picker groups all `demo` encounters under a dedicated "Demo" section,
   * separate from authored scenarios and adventure chapters.
   */
  demo?: boolean;
  /**
   * Marks this encounter as a Bureau mission **hub** (e.g. the station where
   * the player takes/turns-in contracts). Hubs drive the MissionTopBar: while
   * the player is in one they get LEAVE ADVENTURE (and TO MISSION when a
   * contract is pending), and the chapter-complete wrap-up is suppressed
   * because navigation runs through the top bar instead. Multiple encounters
   * may be hubs; the LEAVE MISSION button returns to whichever hub issued the
   * contract (tracked in the `mission_hub_id` world flag).
   */
  missionHub?: boolean;
  /**
   * Environmental flags consulted by combat resolvers. Today only `sunlit`
   * is used — it triggers Sunlight Sensitivity (Disadvantage on attacks) for
   * creatures whose `traits` include `sunlight_sensitivity`.
   */
  environment?: EncounterEnvironment;
  /**
   * Per-encounter overrides for the global faction-relation matrix. Layered on
   * top of `defs.factions[*].defaultRelations` at session boot — only the
   * pairs declared here are changed, everything else falls back to the
   * global default. Use this to express scene-specific politics: e.g.
   *
   *     "factionRelations": { "town_guard": { "bandits": 80 } }
   *
   * for an encounter where the guards have been bought off and now back the
   * bandits.
   */
  factionRelations?: Record<string, Record<string, number>>;
  /**
   * Optional world-flag name that marks the encounter complete when set. When
   * a `set_flag` action (or AIGM `set_world_flag` tool) writes this flag, the
   * engine publishes the `encounter_completed` event and authored triggers
   * fire their closing actions. Combat encounters auto-complete on enemy
   * defeat regardless of this field.
   */
  completionFlag?: string;
}

export interface EncounterEnvironment {
  /** True if the encounter takes place in direct sunlight. */
  sunlit?: boolean;
  /** SRD 5.2.1 ambient light level for tiles that don't declare their own.
   *  `bright` (default) — normal sight. `dim` — tiles are Lightly Obscured
   *  by default (Disadv on Perception sight checks). `dark` — tiles are
   *  Heavily Obscured by default (Blinded into them) unless the observer
   *  has Darkvision (which steps darkness → dim within range). */
  lightLevel?: 'bright' | 'dim' | 'dark';
}
