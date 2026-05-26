// Single source of truth for types shared between client and server.
// Server-only types (GameDefs) live in server/src/engine/types.ts.

// ── Reference data types (feats, backgrounds, species) ───────────────────────

export interface FeatEffects {
  savageAttacker?: boolean;
  armorAcBonus?: number;
  initiativeProficiency?: boolean;
  initiativeSwap?: boolean;
  rangedAttackBonus?: number;
  greatWeaponFighting?: boolean;
  twoWeaponFightingBonus?: boolean;
  abilityScoreIncrease?: { abilities: string[]; amount?: number; distribution?: string; maxScore: number };
  grappleFromStrike?: boolean;
  advantageVsGrappled?: boolean;
  fastWrestler?: boolean;
  peerlessAim?: boolean;
  overcomeDamageResistance?: string[];
  critBonusDamageEqualToAbilityScore?: boolean;
  freeCasting?: { maxSlotLevel: number };
  blinkSteps?: { feet: number; trigger: string };
  improveFate?: { dice: string; rangeInFeet: number; rechargeOn: string };
  truesight?: { feet: number };
  skillOrToolProficiencies?: { count: number; choices: string };
  learnedCantrips?: { count: number; lists: string[] };
  preparedSpell?: { level: number; lists: string[]; freeCastsPerLongRest: number };
  spellcastingAbility?: { choices: string[] };
  [key: string]: unknown;
}

export interface FeatDef {
  id: string;
  name: string;
  category: 'origin' | 'general' | 'fighting-style' | 'epic-boon';
  prerequisites: {
    minLevel: number | null;
    minAbilityScore: { abilities: string[]; minValue: number } | null;
    requiresFeature: string | null;
    repeatable: boolean;
    repeatableNote?: string | null;
  };
  description: string;
  effects: FeatEffects;
}

export interface BackgroundDef {
  id: string;
  name: string;
  abilityScores: string[];
  feat: { id: string; options: Record<string, unknown> | null };
  skillProficiencies: string[];
  toolProficiency: string | { choices: string[]; count: number };
  equipmentOptions: Array<{
    label: string;
    items: Array<{ itemId?: string; name?: string; count?: number }>;
    gold: number;
  }>;
}

export interface SpeciesTraitEffects {
  darkvision?: { feet: number };
  damageResistance?: string[];
  savingThrowAdvantage?: Array<{ condition?: string; ability?: string }>;
  hpMaxBonus?: { atLevel1: number; perLevel: number };
  lineageChoice?: {
    spellcastingAbility: { choices: string[] };
    options: Array<{ id: string; level1?: { speedBonus?: number; [k: string]: unknown }; [k: string]: unknown }>;
  };
  [key: string]: unknown;
}

export interface SpeciesTrait {
  name: string;
  description: string;
  effects: SpeciesTraitEffects;
}

export interface SpeciesDef {
  id: string;
  name: string;
  creatureType: string;
  size: string | { choices: string[] };
  speed: number;
  traits: SpeciesTrait[];
}

// ── Entity definitions (characters, monsters, NPCs) ──────────────────────────

export interface PlayerAttack {
  name: string;
  statKey: 'str' | 'dex';
  damageDice: number;
  damageSides: number;
  damageType: string;
  savageAttacker: boolean;
  graze: boolean;
  vex: boolean;
  sap: boolean;
  slow: boolean;
  // Ranged-weapon fields. Absence of rangeNormal means melee (5 ft / 1 tile reach).
  // For ranged weapons, rangeNormal/rangeLong are in feet (1 tile = 5 ft); beyond
  // normal range imposes Disadvantage, beyond long range cannot fire.
  rangeNormal?: number;
  rangeLong?: number;
  ammunitionType?: string;  // e.g. "arrow", "bolt" — consumed from inventory per shot
  loading?: boolean;        // SRD Loading property — one shot per Action/Bonus/Reaction
  heavy?: boolean;          // SRD Heavy property — DEX < 13 imposes Disadvantage on ranged
}

export interface EquipmentSlots {
  armorId: string | null;
  weaponId: string | null;
  shieldId: string | null;
}

export interface PlayerDef {
  id: string;
  name: string;
  speciesName: string;
  speciesId: string;
  speciesLineage: string | null;
  className: string;
  backgroundId: string;
  featIds: string[];
  level: number;
  maxHp: number;
  ac: number;
  str: number; dex: number; con: number; int: number; wis: number; cha: number;
  proficiencyBonus: number;
  skills: Record<string, number>;
  savingThrowProficiencies: string[];
  savingThrows: Record<string, number>;
  /** Ids of class features this character knows (e.g. `["second-wind"]` for Fighter L1). Features grant resource pools, action buttons, and effect handlers — see `features/`. */
  defaultFeatureIds?: string[];
  hitDieType: number;
  sneakAttackDice: number;
  speed: number;
  color: number;
  xp: number;
  savageAttacker: boolean;
  fightingStyleDefense: boolean;
  defaultEquipment: EquipmentSlots;
  defaultInventoryIds: string[];
  /** Starting gold this character spawns with (per class + background bundle). Defaults to 0 when omitted. */
  defaultGold?: number;
  // ── Spellcasting (optional — omit for non-casters) ──────────────────────────
  /** INT / WIS / CHA. Drives spell save DC, attack bonus, and damage-mod adds. */
  spellcastingAbility?: SpellcastingAbility;
  /** Always-known cantrips (level 0 spells). Cantrips are not prepared and do not consume slots. */
  defaultCantripIds?: string[];
  /** Full known list (wizard's spellbook). Subset is "prepared" at any time. */
  defaultSpellbookIds?: string[];
  /** Subset of `defaultSpellbookIds` (or fixed-list classes) currently castable. */
  defaultPreparedSpellIds?: string[];
  /** Starting spell slots, indexed by `spell.level − 1`. e.g. `[2]` = 2 × L1, no higher slots. */
  defaultSpellSlots?: number[];
  mainAttack: PlayerAttack;
  description?: string;
}

export interface MonsterAttack {
  name: string;
  attackType: 'melee' | 'ranged' | 'both';
  bonus: number;
  reach: number;
  rangeNormal?: number;
  rangeLong?: number;
  damageDice: number;
  damageSides: number;
  damageBonus: number;
  damageType: string;
}

export interface MonsterDef {
  id: string;
  name: string;
  type: string;
  maxHp: number;
  hpFormula?: string;
  ac: number;
  str: number; dex: number; con: number; int: number; wis: number; cha: number;
  proficiencyBonus: number;
  savingThrows?: Record<string, number>;
  initiativeBonus: number;
  stealthBonus: number;
  passivePerception: number;
  speed: number;
  attacks: MonsterAttack[];
  xp: number;
  cr: string;
  color: number;
  resistances?: string[];
  vulnerabilities?: string[];
  immunities?: string[];
  conditionImmunities?: string[];
  nimbleEscape?: boolean;
  combatSpawn?: boolean;
}

export interface NPCDef {
  id: string;
  name: string;
  monsterClass: string;
  color: number;
  persona?: string;
}

// ── Equipment item types ─────────────────────────────────────────────────────

export interface ConsumableDef {
  id: string; name: string; type: 'consumable';
  healDice: number; healSides: number; healBonus: number;
}

export type ArmorCategory = 'light' | 'medium' | 'heavy';

export interface ArmorDef {
  id: string; name: string; type: 'armor';
  category: ArmorCategory;
  baseAc: number; addDex: boolean; maxDex: number | null;
  stealthDisadv?: boolean;
  minStr?: number | null;
  cost?: number;
}

export interface ShieldDef {
  id: string; name: string; type: 'shield';
  acBonus: number;
  cost?: number;
}

export type WeaponMastery = 'graze' | 'vex' | 'sap' | 'nick' | 'topple' | 'push' | 'cleave' | 'slow';

export interface WeaponDef {
  id: string; name: string; type: 'weapon';
  statKey: 'str' | 'dex';
  damageDice: number; damageSides: number; damageType: string;
  mastery: WeaponMastery | string | null;
  finesse: boolean; twoHanded: boolean;
  thrown: boolean; throwNormal: number; throwLong: number;
  // Ranged-weapon fields (omit / 0 / false for melee weapons).
  rangeNormal?: number;       // feet — normal ranged range
  rangeLong?: number;         // feet — maximum ranged range
  ammunitionType?: string;    // e.g. "arrow", "bolt", "bullet", "needle"
  loading?: boolean;          // one shot per Action/Bonus/Reaction
  heavy?: boolean;            // Disadvantage on ranged attacks if DEX < 13
  cost?: number;
}

// Ammunition is its own equipment subtype so it's distinct from health potions
// (consumables) but still represented as inventory items (stackable by id).
export interface AmmunitionDef {
  id: string; name: string; type: 'ammunition';
  ammunitionType: string;  // canonical key matching WeaponDef.ammunitionType
  cost?: number;
}

// Gear is a catch-all for non-functional inventory items — class artifacts
// like a wizard's spellbook, holy symbols, tools, books, etc. They appear in
// the inventory as flavour/lore objects with no UI action button. Distinct
// from ammunition (which is auto-consumed) and consumables (which have USE).
export interface GearDef {
  id: string; name: string; type: 'gear';
  description?: string;
  cost?: number;
}

export type EquipmentDef = ArmorDef | ShieldDef | WeaponDef;
export type ItemDef = ConsumableDef | AmmunitionDef | EquipmentDef | GearDef;

// ── Class features (Rage, Second Wind, Channel Divinity, …) ─────────────────
//
// Features are class abilities described as data + handler. Each character
// references a set of feature ids via `defaultFeatureIds`; at session start
// the engine initializes any pooled resources from the feature definitions.
// A FeatureRegistry on the server maps `handler` ids to TypeScript functions
// that execute the mechanical effect.

export type FeatureCostKind = 'action' | 'bonus-action' | 'reaction' | 'free' | 'attack-time' | 'passive';

export interface FeatureCost {
  kind: FeatureCostKind;
  /** Free-form trigger description for reactive features (e.g. "when hit by an attack roll"). */
  trigger?: string;
}

/**
 * Resource pool consumed by the feature. `max` is the starting / refilled value;
 * `kind` determines when it refills:
 *   - 'uses-per-long-rest'  : refilled on Long Rest (new encounter)
 *   - 'uses-per-short-rest' : refilled on Short Rest
 *   - 'pool'                : like uses-per-long-rest but the amount can vary (e.g. Lay on Hands)
 *   - 'unlimited'           : no resource (button always usable subject to action economy)
 */
export type FeatureResourceKind = 'uses-per-long-rest' | 'uses-per-short-rest' | 'pool' | 'unlimited';

export interface FeatureResource {
  kind: FeatureResourceKind;
  /** The starting / refill value. Constant for L1 features; future fields can compute from level. */
  max: number;
}

export interface FeatureUI {
  /** Display label on the action button. Omit for passive/attack-time features (no button). */
  buttonLabel?: string;
  /** Button background colour. Defaults to a class-button blue if omitted. */
  buttonColor?: string;
  /** Optional template for the resource chip in the Player Panel: "{name}: {remaining}/{max}". Use `{remaining}` and `{max}` placeholders. */
  resourceLabel?: string;
}

export interface FeatureDef {
  id: string;
  name: string;
  /** Class this feature belongs to (e.g. "fighter"). Display-only — no class registry yet. */
  classId: string;
  /** Minimum class level required for the character to know this feature. */
  minLevel: number;
  description: string;
  cost: FeatureCost;
  resource?: FeatureResource;
  ui?: FeatureUI;
  /**
   * Mechanic-handler key, looked up in the server-side FeatureRegistry. When
   * omitted, the feature is "data-only" — passive, ambient, or applied at
   * character-load (Unarmored Defense, Expertise, etc.).
   */
  handler?: string;
}

// ── Spell definitions ─────────────────────────────────────────────────────────

export type SpellSchool = 'abjuration' | 'conjuration' | 'divination' | 'enchantment'
                        | 'evocation' | 'illusion' | 'necromancy' | 'transmutation';

export type SpellcastingAbility = 'int' | 'wis' | 'cha';

export interface SpellComponents {
  verbal: boolean;
  somatic: boolean;
  material: string | null;
}

export interface SpellAttackOnly { kind: 'ranged-spell' | 'melee-spell' | 'auto-hit'; }
export interface SpellSave { ability: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'; halfOnSuccess: boolean; }
export interface SpellDamage { dice: number; sides: number; bonus?: number; type: string; }
export interface SpellArea { shape: 'cone' | 'sphere' | 'cube' | 'line'; sizeFeet: number; }
export interface SpellEffect { onFail?: string; onSecondFail?: string; }

export interface SpellDef {
  id: string;
  name: string;
  level: number;                   // 0 = cantrip
  school: SpellSchool;
  classes: string[];
  castingTime: string;             // human-readable
  castingTimeTrigger?: string;     // reactions only
  range: string;                   // human-readable
  rangeFeet: number;               // 0 = self/touch
  components: SpellComponents;
  duration: string;
  durationRounds?: number;
  concentration: boolean;
  ritual: boolean;
  attack?: 'ranged-spell' | 'melee-spell' | 'auto-hit';
  save?: SpellSave;
  damage?: SpellDamage;
  area?: SpellArea;
  darts?: number;                  // Magic Missile: guaranteed-hit projectile count
  rider?: string;                  // narrative one-line secondary effect on hit
  effect?: SpellEffect;            // condition outcomes (Sleep)
  description: string;
  scaling?: string;
}

// ── Encounter / quest types ──────────────────────────────────────────────────

export type EncounterType = 'simple_combat' | 'social_interaction' | 'exploration';
export type QuestGoalType = 'kill' | 'collect' | 'explore' | 'talk';

export type SecretReward =
  | { type: 'gold'; amount: number }
  | { type: 'item'; itemId: string }
  | { type: 'lore'; text: string };

export interface SecretDef {
  id: string; dc: number; reward: SecretReward; successText: string; failureText: string;
}

export interface QuestDef {
  id: string; title: string;
  goal: { type: QuestGoalType; target: number };
  rewardXp: number; rewardGp: number;
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
}

/**
 * Per-GID tile semantics declared by an encounter. Each entry describes how
 * the encounter wants a particular tile from the referenced map to behave
 * during this scenario. Encounters MAY reuse the same map with different
 * properties (e.g. one runs a bridge with broken walls passable, another
 * keeps them solid).
 *
 * Lookup priority for a tile's `passable` flag:
 *   1. Encounter's tileProperties (this type) — explicit override.
 *   2. The matching entry in the tileset legend (`TileLegend`).
 *   3. Default `false` (impassable).
 */
export interface EncounterTileProperty {
  gid: number;
  passable?: boolean;
  // Future, currently parsed-but-unused:
  // difficult?: boolean;     // costs 2 ft of movement per ft (US-044)
  // cover?: 'half' | 'three-quarters' | 'total';  // US-045
  // trapped?: { dc: number; damageDice: number; damageSides: number; damageType: string };
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
  passable: boolean;
  /** Which layer this tile belongs on. `"ground"` is drawn first; `"object"` is overlaid on top. */
  layer: 'ground' | 'object';
  description: string;
  tags: string[];
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

// Encounter card definition (the JSON files in server/data/encounters/).
export interface EncounterDef {
  id: string;
  encounterTitle: string;
  description: string;
  encounterTypes: EncounterType[];
  mapId: string;
  npcIds?: string[];
  allyIds?: string[];
  customIntroduction?: string;
  customContext?: string;
  /**
   * Per-GID semantics for the referenced map's tiles in this encounter.
   * Required to make any tile of the map passable; tiles without a matching
   * entry are treated as impassable by SessionBuilder.
   */
  tileProperties?: EncounterTileProperty[];
  startingZones?: StartingZonesLayer;
  /**
   * Authored gameplay scripts (ambushes, reinforcements, scripted reveals).
   * Each trigger declares a condition (player enters a tile region, an NPC
   * dies, etc.) and a list of actions to fire when the condition matches.
   * See `server/src/engine/TriggerSystem.ts` for the runtime evaluator.
   */
  triggers?: EncounterTrigger[];
}

// ── Engine event bus ─────────────────────────────────────────────────────────
//
// The deterministic substrate the rest of the living-world layer subscribes
// to. Engine systems publish events at well-defined moments; TriggerSystem,
// NPC brains, the Director, and rumor/faction systems all subscribe. The bus
// is synchronous with priority bands — subscribers run in the publisher's
// call stack, can mutate state, and may publish further events (bounded by
// a depth limit in EventBus.ts to catch malformed loops).

export type EngineEvent =
  | { type: 'player_moved'; x: number; y: number }
  | { type: 'npc_killed'; npcId: string; defId: string; killerId?: string }
  | { type: 'item_picked_up'; defId: string }
  | { type: 'turn_started'; combatantId: 'player' | string }
  | { type: 'turn_ended'; combatantId: 'player' | string }
  | { type: 'combat_started' }
  | { type: 'combat_ended' }
  | { type: 'flag_set'; name: string; value: WorldFlagValue }
  /** Published whenever an entity takes damage. `target` is 'player' or an NPC id. */
  | { type: 'damage_dealt'; target: 'player' | string; amount: number; sourceId?: string }
  /** Published once per crossing direction when an entity's HP ratio drops below or rises above a threshold (defaults: 0.5, 0.25). Listeners can author "boss enrages at 50%" triggers without re-checking each turn. */
  | { type: 'hp_threshold_crossed'; target: 'player' | string; ratio: number; direction: 'below' | 'above' }
  /** A faction's standing with the player changed. */
  | { type: 'faction_changed'; factionId: string; oldValue: number; newValue: number }
  /** A rumor was recorded into world memory. */
  | { type: 'rumor_propagated'; rumorId: string }
  /** Trigger-authored custom event. Lets authors chain triggers via `emit_event` without touching engine code. */
  | { type: 'custom'; name: string; payload?: Record<string, unknown> };

export type WorldFlagValue = number | string | boolean;

// ── Encounter triggers (WHEN / IF / THEN) ────────────────────────────────────
//
// Authorable rules of the form: WHEN <event matches> IF <world-state guards>
// THEN <ordered effects>. Triggers belong to an encounter (JSON in
// server/data/encounters/) and are registered as subscribers on session
// start. Each fired trigger's id is appended to GameState.firedTriggerIds
// so once-only semantics survive save/load.

export type WhenClause =
  | { event: 'player_moved'; in_area?: { x: number; y: number; w: number; h: number }; tile?: { x: number; y: number } }
  | { event: 'npc_killed'; defId?: string }
  | { event: 'item_picked_up'; defId?: string }
  | { event: 'turn_started'; combatantId?: 'player' | string }
  | { event: 'turn_ended'; combatantId?: 'player' | string }
  | { event: 'combat_started' }
  | { event: 'combat_ended' }
  | { event: 'damage_dealt'; target?: 'player' | string }
  | { event: 'hp_threshold_crossed'; target?: 'player' | string; ratio?: number; direction?: 'below' | 'above' }
  | { event: 'faction_changed'; factionId?: string }
  | { event: 'custom'; name: string };

export type ComparisonOp = 'lt' | 'le' | 'eq' | 'ge' | 'gt';

export type TriggerGuard =
  | { type: 'flag_set'; name: string }
  | { type: 'flag_unset'; name: string }
  | { type: 'flag_equals'; name: string; value: WorldFlagValue }
  | { type: 'hp_below'; ratio: number }
  | { type: 'enemies_alive'; op: ComparisonOp; count: number }
  | { type: 'allies_alive'; op: ComparisonOp; count: number }
  | { type: 'phase'; in: CombatMode[] }
  /** True when the player's standing with `factionId` satisfies the comparison. Unknown factions default to 0. */
  | { type: 'faction_standing'; factionId: string; op: ComparisonOp; value: number };

export type TriggerAction =
  | { type: 'spawn_enemy_near_player'; monsterId: string; minDist?: number; maxDist?: number }
  | { type: 'spawn_enemy_at'; monsterId: string; x: number; y: number }
  | { type: 'show_log'; message: string }
  | { type: 'send_aidm_message'; message: string }
  /** Picks a canned variant from `server/data/narration/{narrationId}.json` and pushes it into the Combat Log. The picker avoids repeating the last-used variant per id. */
  | { type: 'narrate'; narrationId: string }
  | { type: 'set_flag'; name: string; value: WorldFlagValue }
  /** Applies a 5e condition to the player. Future scope: arbitrary target selectors. */
  | { type: 'apply_condition_to_player'; condition: string }
  /** Re-publishes a custom event on the bus, allowing one trigger to fan out into others. Only `custom` events are allowed — engine-canonical events (`npc_killed`, `damage_dealt`, …) cannot be forged from authored data. */
  | { type: 'emit_event'; name: string; payload?: Record<string, unknown> }
  | { type: 'adjust_faction_standing'; factionId: string; delta: number }
  | { type: 'record_rumor'; id: string; text: string; salience?: number }
  /** Promotes (or demotes) every NPC currently in the encounter whose `defId` matches. Faction-mates of a newly hostile NPC are auto-aggroed via the existing `aggroFaction` path. Use together with `trigger_combat` to turn a peaceful scene hostile when the player crosses a threshold. */
  | { type: 'set_disposition_by_def_id'; defId: string; disposition: 'ally' | 'neutral' | 'enemy' }
  /** Kicks off combat when the engine is in the exploring phase and at least one enemy is alive. Idempotent — no-ops if either precondition fails. */
  | { type: 'trigger_combat' };

export interface EncounterTrigger {
  /** Unique within the encounter; used as the dedupe key in `firedTriggerIds`. */
  id: string;
  /** Event that wakes the trigger. */
  when: WhenClause;
  /** Optional list of world-state guards. ALL must hold for the trigger to fire (logical AND). */
  if?: TriggerGuard[];
  /** Ordered list of effects to apply when the trigger fires. */
  then: TriggerAction[];
  /** When omitted or true, the trigger fires at most once per session. When false, it re-fires on every match. */
  once?: boolean;
}

// ── Narration variants ───────────────────────────────────────────────────────
//
// One JSON file per narratable moment in server/data/narration/. The
// `narrate(narrationId)` trigger action picks a variant — avoiding the
// last-used index when more than one exists — so ordinary deterministic
// prose feels different on each play without invoking the generative DM.

export interface NarrationDef {
  id: string;
  variants: string[];
  /** Optional per-variant weight (parallel array to `variants`). When omitted, picks are uniform. */
  weights?: number[];
}

// ── Factions & rumors ────────────────────────────────────────────────────────
//
// Factions are referenced by string id on `NpcState.factionId` and tracked
// as numeric standings on the player. Authors can read standings via the
// `faction_standing` guard; the AIDM adjusts them via `adjust_faction_standing`.
// Rumors are timestamped world events recorded into a global memory log so
// the DM and triggers can reference them later ("the bandit captain heard
// what you did to her brothers").

export interface Rumor {
  /** Stable id — used as the dedupe key when authoring triggers off `rumor_propagated`. */
  id: string;
  /** Short human-readable text shown to the DM in CURRENT STATE. */
  text: string;
  /** 1–10 importance score. Determines whether the DM should reference it in narration. */
  salience: number;
  /** Server-relative timestamp (Date.now() at creation). Lets the DM order references chronologically. */
  recordedAt: number;
}

// ── Combat log ───────────────────────────────────────────────────────────────

export type LogEntryStyle = 'normal' | 'hit' | 'crit' | 'kill' | 'heal' | 'status' | 'header' | 'miss';

export interface LogEntry {
  left: string;
  right?: string;
  style?: LogEntryStyle;
}

// ── Game state ───────────────────────────────────────────────────────────────

export type CombatMode = 'exploring' | 'player_turn' | 'enemy_turn' | 'death_saves' | 'defeat';

export type Disposition = 'ally' | 'neutral' | 'enemy';

export interface PlayerState {
  defId: string;
  tileX: number;
  tileY: number;
  hp: number;
  xp: number;
  gold: number;
  inventoryIds: string[];
  equippedSlots: EquipmentSlots;
  /** Per-feature resource pools, keyed by feature id (Second Wind, Rage, Channel Divinity, …). Initialised from `FeatureDef.resource.max` on session start; decremented by feature handlers. */
  resources: Record<string, number>;
  actionUsed: boolean;
  bonusActionUsed: boolean;
  reactionUsed: boolean;
  // SRD "free object interaction" — one per turn, used implicitly when drawing
  // a sword as part of the Attack action OR explicitly when equip/unequip is
  // invoked during player_turn. A second equip/unequip in the same turn
  // requires the Utilize action and consumes actionUsed.
  freeObjectInteractionUsed: boolean;
  // Initiative roll total for the current combat (d20 + DEX mod, with optional
  // Advantage/Disadvantage from surprise/invisibility). Cleared when combat ends.
  initiativeRoll: number;
  movesLeft: number;
  deathSaveSuccesses: number;
  deathSaveFailures: number;
  hitDiceUsed: number;
  tempHp: number;
  heroicInspiration: boolean;
  exhaustionLevel: number;
  conditions: string[];
  equippedSlotLabels: { armor: string | null; weapon: string | null; shield: string | null };
  /** Current effective AC after armor / shield / Mage Armor / Defense fighting style. Synced from `playerDef.ac` after every `applyEquipment` call so the client doesn't have to recompute. */
  ac: number;
  // ── Spellcasting runtime state ───────────────────────────────────────────
  /** Currently remaining spell slots, indexed by `spell.level − 1`. Empty array for non-casters. */
  spellSlots: number[];
  /** Currently prepared spell ids (mutable across Long Rests). */
  preparedSpellIds: string[];
  /** Spell currently concentrated on, or null. Cleared by damage CON save, casting another concentration spell, or incapacitation. */
  concentratingOn: string | null;
  /** Flag set by Mage Armor — `applyEquipment`-equivalent uses base AC 13 + DEX while no armor is worn. */
  mageArmor: boolean;
}

export interface AvailableActions {
  canAttack: boolean;
  throwableItemIds: string[];
  canHide: boolean;
  /** Class-feature ids the player can use *right now* (action economy + remaining resource + class-level gating). */
  usableFeatureIds: string[];
  canDash: boolean;
  canDodge: boolean;
  canDisengage: boolean;
  canShortRest: boolean;
  /** Subset of `preparedSpellIds` + known cantrips that the player can cast *right now* given action economy and slot pool. Empty when the player isn't a caster or no spell is castable. */
  castableSpellIds: string[];
}

// Unified NPC state — covers neutral social NPCs, allied combatants, and enemies.
// disposition drives rendering (token colour, HP bar) and AI (who they attack).
export interface NpcState {
  id: string;
  defId: string;
  name: string;
  tileX: number;
  tileY: number;
  disposition: Disposition;
  factionId: string;
  combatLabel: string;
  revealedName?: string;
  combatPassive?: boolean;
  hp: number;
  maxHp: number;
  isActive: boolean;
  reactionUsed: boolean;
  conditions: string[];
  inventoryIds: string[];
  // Initiative roll total for the current combat (d20 + initiativeBonus, with
  // optional Disadvantage if Surprised). Cleared when combat ends.
  initiativeRoll?: number;
}

export interface MapItemState {
  id: string;
  defId: string;
  tileX: number;
  tileY: number;
}

export interface SecretState {
  tileX: number;
  tileY: number;
  def: SecretDef;
}

export interface QuestState {
  id: string;
  title: string;
  goalType: QuestGoalType;
  goalTarget: number;
  rewardXp: number;
  rewardGp: number;
  progress: number;
  completed: boolean;
}

export interface GameMap {
  passable: boolean[][];
  cols: number;
  rows: number;
  /** Ground-layer tile GIDs for rendering. Optional: procedural maps may omit. */
  gidGrid?: number[][];
  /** Object-layer tile GIDs (drawn over the ground layer). 0 = empty cell. */
  objectGidGrid?: number[][];
  /** Tileset metadata for rendering. Optional: procedural maps may omit. */
  tilesets?: MapTilesetInfo[];
}

export interface NpcPersona { id: string; name: string; persona: string; }

export interface GameState {
  sessionId: string;
  phase: CombatMode;
  map: GameMap;
  player: PlayerState;
  npcs: NpcState[];
  mapItems: MapItemState[];
  secrets: SecretState[];
  combatLog: LogEntry[];
  logScrollOffset: number;
  encounterTypes: EncounterType[];
  mapName: string;
  encounterTitle: string;
  quests: QuestState[];
  selectedTargetId: string | null;
  activeNpcIndex: number;
  turnOrderIds: string[];
  introduction: string;
  encounterContext: string;
  npcPersonas: NpcPersona[];
  availableActions: AvailableActions;
  /** Set when the engine has paused on a reaction-eligible trigger. The next player action must be `resolveReaction`. Cleared on resolution. */
  pendingReaction: PendingReaction | null;
  /** Authored encounter triggers active for this session. Sourced from `EncounterDef.triggers` at session creation. */
  triggers: EncounterTrigger[];
  /** Ids of triggers that have already fired. Persisted in `world.json` so `once` semantics survive save/load. */
  firedTriggerIds: string[];
  /** Scripted-event lines queued by `send_aidm_message` actions. Surfaced to the next AIDM turn under the SCRIPTED EVENTS block and cleared once consumed. */
  pendingAidmEvents: string[];
  /** Authored world flags keyed by name. Written by `set_flag` trigger actions, read by `flag_set` / `flag_unset` / `flag_equals` guards. Persisted with the world save. */
  worldFlags: Record<string, WorldFlagValue>;
  /** Last variant index picked per `narrationId`. Used by NarrationSystem to avoid back-to-back repeats. */
  narrationLastUsed: Record<string, number>;
  /** Player's standing with each faction (−100..+100). Read by `faction_standing` guards; written by `adjust_faction_standing` AIDM tool. Unknown faction → 0. */
  factionStandings: Record<string, number>;
  /** World memory log of significant events, recorded by AIDM `create_rumor` tool or trigger `record_rumor` action. Surfaced to the DM in CURRENT STATE. */
  rumors: Rumor[];
}

// ── Reaction prompts ─────────────────────────────────────────────────────────
//
// When an enemy turn produces a reaction-eligible trigger (a target moves out
// of the player's reach → potential Opportunity Attack; an incoming attack
// would land by ≤5 over AC → potential Shield), the engine STOPS the turn
// loop and surfaces a `pendingReaction` to the client. The next action MUST
// be a `resolveReaction { accept }`. After that the engine applies (or skips)
// the reaction and resumes advancing turns.

export interface PendingReactionOA {
  kind: 'opportunity_attack';
  /** Id of the NPC that moved out of reach and is now provoking the OA. */
  npcId: string;
  /** Display name of the provoking NPC (already disambiguated, e.g. "Bridge Bandit (A)"). */
  npcName: string;
}

export interface PendingReactionShield {
  kind: 'shield';
  /** Id of the attacking NPC. */
  attackerId: string;
  /** Display name of the attacker (disambiguated). */
  attackerName: string;
  /** Damage that lands if the player declines Shield. */
  incomingDamage: number;
  /** The attack roll total — exposed so the UI can explain what Shield would convert. */
  attackTotal: number;
  /** What the player's AC would become with Shield up. */
  shieldedAc: number;
}

export type PendingReaction = PendingReactionOA | PendingReactionShield;

// ── Animation events ─────────────────────────────────────────────────────────

export type GameEvent =
  | { type: 'entity_move'; entityId: string; toX: number; toY: number }
  | { type: 'log'; lines: string[] };

// ── Player actions ───────────────────────────────────────────────────────────

export type PlayerAction =
  | { type: 'move'; dx: number; dy: number }
  | { type: 'moveTo'; tileX: number; tileY: number }
  | { type: 'attack'; targetId?: string }
  | { type: 'throw'; itemId: string; targetId?: string }
  | { type: 'castSpell'; spellId: string; slotLevel: number; targetIds?: string[]; tile?: { x: number; y: number }; asRitual?: boolean }
  | { type: 'hide' }
  | { type: 'useFeature'; featureId: string; targetId?: string; tile?: { x: number; y: number } }
  | { type: 'resolveReaction'; accept: boolean }
  | { type: 'dash' }
  | { type: 'dodge' }
  | { type: 'disengage' }
  | { type: 'endTurn' }
  | { type: 'rollDeathSave' }
  | { type: 'shortRest' }
  | { type: 'search' }
  | { type: 'usePotion' }
  | { type: 'equip'; slot: 'armor' | 'weapon' | 'shield'; itemId: string }
  | { type: 'unequip'; slot: 'armor' | 'weapon' | 'shield' }
  | { type: 'selectTarget'; entityId: string | null }
  | { type: 'scrollLog'; delta: number };

// ── WebSocket protocol (server → client) ─────────────────────────────────────

export type ServerWSMessage =
  | { type: 'state_update'; state: GameState; events: GameEvent[] }
  | { type: 'aidm_reply'; reply: string }
  // Streaming AIDM protocol — emitted during processAIDMChat:
  //   aidm_start: a new AIDM turn has begun; the client opens a fresh
  //     assistant bubble (baseline = 0).
  //   aidm_chunk: text delta appended to the current assistant bubble.
  //   aidm_checkpoint: the chunks since the last checkpoint are canonical —
  //     the client advances its discard baseline to the current text length.
  //   aidm_speculative_discard: the chunks since the last checkpoint were
  //     written before a roll-requesting tool and must be removed from the
  //     visible bubble. Client rolls back to the discard baseline.
  //   aidm_done: the final, persisted reply text + roll-result strings.
  | { type: 'aidm_start' }
  | { type: 'aidm_chunk'; text: string }
  | { type: 'aidm_checkpoint' }
  | { type: 'aidm_speculative_discard' }
  | { type: 'aidm_done'; reply: string; rollResults: string[] }
  | { type: 'error'; message: string };

// ── Session creation ─────────────────────────────────────────────────────────

export interface CreateSessionRequest {
  encounterTypes: EncounterType[];
  mapType: 'open' | 'rooms' | 'saved';
  playerDefId: string;
  savedMapId?: string;
  encounterTitle?: string;
  savedMapName?: string;
  savedMapDescription?: string;
  npcIds?: string[];
  allyIds?: string[];
  customIntroduction?: string;
  customContext?: string;
  tileProperties?: EncounterTileProperty[];
  startingZones?: StartingZonesLayer;
  triggers?: EncounterTrigger[];
  resumeHp?: number;
  resumeXp?: number;
  resumeGold?: number;
  resumeInventoryIds?: string[];
  resumeEquippedSlots?: EquipmentSlots;
  resumeResources?: Record<string, number>;
  resumeSpellSlots?: number[];
  resumePreparedSpellIds?: string[];
  resumeConcentratingOn?: string | null;
  resumeMageArmor?: boolean;
}

export interface CreateSessionResponse {
  sessionId: string;
  state: GameState;
}

// ── Save / story log ─────────────────────────────────────────────────────────

export interface EncounterLogLine {
  type: 'combat' | 'dm_player' | 'dm_reply';
  text: string;
}

export interface EncounterRecord {
  id: string;
  timestamp: string;
  description: string;
  encounterTitle: string;
  xpGained: number;
  goldGained: number;
  outcome: 'survived' | 'defeated';
  lines: EncounterLogLine[];
}

export interface StorylogEntry {
  encounterId: string;
  narrative: string;
}
