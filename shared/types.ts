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

/**
 * A secondary damage component riding along with an attack. Used for SRD
 * attacks like the Cultist's *Ritual Sickle* (1d4+1 slashing **+ 1 necrotic**)
 * or Cockatrice's beak (piercing + petrification). Each component rolls its
 * own dice, applies its own damage type through the resistance / vulnerability
 * / immunity lookup, and contributes a distinct log line. On a crit the dice
 * double (matching SRD), the flat bonus does not.
 */
export interface BonusDamage {
  dice: number;
  sides: number;
  bonus: number;
  damageType: string;
}

/**
 * The result of rolling a single bonus-damage rider on an attack — the value
 * resolvers thread through to callers so each rider gets applied with its own
 * per-type resistance lookup and log line.
 */
export interface RolledBonusDamage {
  damage: number;
  damageType: string;
  /** Log-table right-hand side, e.g. `1d4[3]+0`. */
  rollStr: string;
}

export interface PlayerAttack {
  name: string;
  statKey: 'str' | 'dex';
  damageDice: number;
  damageSides: number;
  damageType: string;
  /** Optional secondary damage riders applied alongside the primary roll. */
  bonusDamage?: BonusDamage[];
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
  /** Special senses (SRD): darkvision / blindsight / tremorsense / truesight.
   *  Seeded from species traits when the character is built. Absent means
   *  "normal sight only". Read by `Vision.canSee` and the Hide gate. */
  senses?: Senses;
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
  /** Path to the SVG used as this character's token sprite. Required — every
   *  character JSON must declare its token explicitly (no naming-convention
   *  fallback). */
  tokenAsset: string;
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
  /** Optional secondary damage riders — see `BonusDamage`. */
  bonusDamage?: BonusDamage[];
  /** Optional on-hit effects applied after damage lands (attach, grapple, etc.). */
  onHit?: AttackOnHitEffect[];
}

/**
 * An effect triggered when this attack lands a hit. The `kind` discriminates:
 *   - `attach` — the attacker latches onto the target. Each time the
 *     attacker's turn begins, the target takes the `dot` damage. While
 *     attached, the attacker skips its normal attack action. The effect ends
 *     when the target (or an adjacent ally) takes the Detach action.
 */
export type AttackOnHitEffect =
  | { kind: 'attach'; dot: PeriodicDamage };

export interface PeriodicDamage {
  dice: number;
  sides: number;
  bonus: number;
  damageType: string;
}

/**
 * A periodic damage effect currently active on a creature. The `sourceNpcId`
 * field names the NPC that authored the effect — periodic damage fires at the
 * start of that NPC's turn (or when the source is removed from the encounter).
 */
export interface OngoingEffect {
  id: string;
  kind: 'attach';
  sourceNpcId: string;
  dot: PeriodicDamage;
}

/**
 * Special senses block — SRD 5.2.1 "Vision and Light". Ranges in feet. All
 * fields are optional; absence means "normal sight only". Used by the
 * Vision module to decide whether an observer can see through Darkness /
 * Heavily Obscured tiles / Invisible targets / Total Cover.
 *   - darkvision: see in Dim Light as Bright; in Darkness as Dim (gray).
 *   - blindsight: see within range without sight (pierces Darkness +
 *     Invisible; blocked only by Total Cover).
 *   - tremorsense: pinpoint creatures on the same surface (ground / wall /
 *     liquid) within range; not a form of sight, so does not pierce cover
 *     or perceive airborne creatures.
 *   - truesight: pierces Darkness + Invisible + magical concealment +
 *     transmutation disguises within range.
 */
export interface Senses {
  darkvision?: number;
  blindsight?: number;
  tremorsense?: number;
  truesight?: number;
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
  /** Special senses (SRD): darkvision / blindsight / tremorsense / truesight.
   *  Absent means "normal sight only". Read by `Vision.canSee`. */
  senses?: Senses;
  speed: number;
  attacks: MonsterAttack[];
  xp: number;
  cr: string;
  color: number;
  /** Default faction membership for raw-monster spawns (i.e. when the spawn
   *  has no NPC wrapper to declare a faction). `SpawnHelpers` reads this
   *  first; if absent it falls back to the def id as a faction-of-one. Use
   *  this when the bare monster def already belongs to one of the world's
   *  factions in `defs.factions/` — e.g. `cultist` → `cultists` so the
   *  Target Panel renders the faction row instead of hiding it. */
  factionId?: string;
  resistances?: string[];
  vulnerabilities?: string[];
  immunities?: string[];
  conditionImmunities?: string[];
  nimbleEscape?: boolean;
  combatSpawn?: boolean;
  /** Trait identifiers that adjust how this monster's attacks resolve. Each
   *  trait is interpreted by the engine (see CombatSystem.collectAttackModifiers).
   *  Supported today:
   *    - 'pack_tactics' — Advantage on an attack if at least one of the
   *      attacker's allies is within 5 ft of the target and not incapacitated.
   *    - 'sunlight_sensitivity' — Disadvantage on attacks while in direct
   *      sunlight (governed by EncounterDef.environment.sunlit).
   */
  traits?: MonsterTrait[];
  /** Authored defensive reactions the creature may trigger when targeted.
   *  Resolved automatically by the engine — there is no NPC reaction prompt.
   *  See CombatActions.tryNpcDefensiveReaction.
   */
  reactions?: MonsterReaction[];
  /** Path to the SVG used as this monster's token sprite. Required — every
   *  monster JSON must declare its token explicitly (no naming-convention
   *  fallback). */
  tokenAsset: string;
}

export type MonsterTrait = 'pack_tactics' | 'sunlight_sensitivity';

/**
 * A defensive reaction the engine may trigger on behalf of an NPC. The
 * `kind` discriminates the effect:
 *   - `parry` — when hit by a melee attack roll while not incapacitated, the
 *     NPC adds `acBonus` to its AC against that attack (possibly turning the
 *     hit into a miss). One reaction per round per SRD.
 */
export type MonsterReaction =
  | { kind: 'parry'; acBonus: number };

export interface NPCDef {
  id: string;
  name: string;
  monsterClass: string;
  color: number;
  persona?: string;
  /** Optional per-NPC SVG override. When unset, the NPC falls back to the
   *  token of its `monsterClass`. */
  tokenAsset?: string;
  /**
   * Default faction membership for this NPC. Same role as `MonsterDef.factionId`
   * — overrides the monster-class default and falls back to the NPC's own id
   * when omitted (legacy NPCs preserve current implicit faction behaviour).
   */
  factionId?: string;
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
export interface SpellArea {
  shape: 'cone' | 'sphere' | 'cube' | 'line';
  sizeFeet: number;
  /** SRD "each creature of your choice in the area" — when true the client
   *  surfaces a second-step picker after the AOE is placed so the caster
   *  decides which creatures in the area to affect (defaults to every
   *  non-ally). Sleep uses this; Color Spray / Thunderwave / Grease do not. */
  creaturesOfYourChoice?: boolean;
}
export interface SpellEffect {
  /** Condition(s) applied to the target on a failed save. Accepts either a
   *  single condition name (Sleep's `incapacitated`) or an array
   *  (Hideous Laughter's `["prone", "incapacitated"]`). */
  onFail?: string | string[];
  /** Sleep's escalation: a second failed save replaces `onFail` with this. */
  onSecondFail?: string;
}

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
  /** Damage types the caster may choose from at cast time (Chromatic Orb,
   *  Dragon's Breath, …). When present, the engine ignores `damage.type` and
   *  uses the player's pick from this list instead. */
  damageTypeChoices?: string[];
  /** Spell that conjures a player-owned entity on the map (Mage Hand,
   *  Unseen Servant). The cast targets a tile within `rangeFeet`; the
   *  spawned NPC carries `summonSpellId` so the engine can route the
   *  `commandSummon` action correctly and enforce tether / damage lifecycle. */
  summon?: {
    /** `MonsterDef.id` to instantiate at the targeted tile. */
    monsterId: string;
    /** Per-command movement allowance, in feet. Each command moves the
     *  summon at most this far. */
    moveRangeFeet: number;
    /** Optional max distance the caster may stray from the summon before
     *  the spell ends (Mage Hand's 30 ft tether). Omit for spells without
     *  a tether (Unseen Servant). */
    tetherFeet?: number;
  };
  description: string;
  scaling?: string;
}

// ── Encounter / quest types ──────────────────────────────────────────────────

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
  /**
   * Per-tile passability extracted from the source .tsj's `tiles[].properties`.
   * Keyed by tileset-local tile id (i.e. `gid - firstgid`). Tiles absent from
   * this map default to passable, matching Tiled's convention that unmarked
   * tiles have no restrictions.
   */
  tilePassability: Record<number, boolean>;
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
 *   2. The source tileset's per-tile passability declared in its .tsj
 *      and carried on `MapTilesetInfo.tilePassability`.
 *   3. Default `true` (Tiled convention: unmarked tiles have no restrictions).
 */
export interface EncounterTileProperty {
  gid: number;
  passable?: boolean;
  /** SRD 5.2.1 Cover — tiles between an attacker and a target contribute to
   *  the target's effective cover. The `Vision.canSee` LOS walker collects
   *  the worst cover along the line and the combat resolver translates it
   *  to an AC bonus: half (+2), three-quarters (+5), total (untargetable
   *  AND blocks sight). */
  cover?: 'half' | 'three-quarters' | 'total';
  /** When the tile is **impassable** but `transparent: true` is set, the LOS
   *  walker does NOT auto-promote it to Total Cover. Use for chasms, deep
   *  water, low walls — terrain you can see across but cannot walk onto.
   *  Default: false. When false, every impassable tile that has no explicit
   *  `cover` declaration is treated as Total Cover by the Vision module so
   *  walls block sight without authors having to tag every wall GID. */
  transparent?: boolean;
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
  /** SRD Cover the tile provides by default (Vision/combat). Encounter
   *  `tileProperties` overrides this per-encounter. */
  cover?: 'half' | 'three-quarters' | 'total';
  /** SRD Obscurance the tile imposes by default. */
  obscurance?: 'lightly' | 'heavily';
  /** Whether an impassable tile is see-through (chasms, water, windows).
   *  Opts the tile out of SessionBuilder's "impassable → Total Cover"
   *  auto-promotion. */
  transparent?: boolean;
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
  /**
   * Player-facing one-line objective shown at the top of the Quests panel
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
  /** Published once at session start AFTER triggers register, so encounter authors
   *  can attach lifecycle reactions (intro supertitles, scripted lines, etc.).
   *  The events emitted by these triggers are buffered into the engine's
   *  startup event sink and flushed on the first WS state_update. */
  | { type: 'encounter_started' }
  /** Published once when the encounter resolves — combat ends with no enemies
   *  left alive, OR the encounter's `completionFlag` is set. Authors can hook
   *  closing cinematics, awards, or summary announcements off this. */
  | { type: 'encounter_completed' }
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
  | { type: 'custom'; name: string; payload?: Record<string, unknown> }
  /** A noise was emitted at a tile (footstep, attack, spell with V component,
   *  shout). `intensity` is the audible radius in tiles; SRD-rough
   *  conversion: whisper=1, footstep=2, normal speech=3, attack/cast=5.
   *  Sound subscribers use this to break Hide on the source and alert
   *  hostile NPCs within the radius. */
  | { type: 'noise'; x: number; y: number; intensity: number; sourceId?: string };

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
  /** Fires once at session start, after all engine subscribers register. Use
   *  to attach intro cinematics (supertitle, fade-in, opening announcement). */
  | { event: 'encounter_started' }
  /** Fires once when the encounter resolves — combat-victory OR completionFlag
   *  set. Use for closing announcements, post-victory supertitles, etc. */
  | { event: 'encounter_completed' }
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
  /** True when the number of living NPCs with the matching `defId` satisfies the comparison. Use to gate ambush triggers on "at least one bandit is still alive" or to detect "the boss is dead" regardless of disposition. */
  | { type: 'npcs_alive'; defId: string; op: ComparisonOp; count: number }
  | { type: 'phase'; in: CombatMode[] }
  /** True when the player's standing with `factionId` satisfies the comparison. Unknown factions default to 0. */
  | { type: 'faction_standing'; factionId: string; op: ComparisonOp; value: number };

export type TriggerAction =
  | { type: 'spawn_enemy_near_player'; monsterId: string; minDist?: number; maxDist?: number }
  | { type: 'spawn_enemy_at'; monsterId: string; x: number; y: number }
  | { type: 'show_log'; message: string }
  | { type: 'send_aigm_message'; message: string }
  /** Picks a canned variant from `server/data/narration/{narrationId}.json` and pushes it into the Event Log. The picker avoids repeating the last-used variant per id. */
  | { type: 'narrate'; narrationId: string }
  | { type: 'set_flag'; name: string; value: WorldFlagValue }
  /** Applies a 5e condition to the player. Future scope: arbitrary target selectors. */
  | { type: 'apply_condition_to_player'; condition: string }
  /** Re-publishes a custom event on the bus, allowing one trigger to fan out into others. Only `custom` events are allowed — engine-canonical events (`npc_killed`, `damage_dealt`, …) cannot be forged from authored data. */
  | { type: 'emit_event'; name: string; payload?: Record<string, unknown> }
  | { type: 'adjust_faction_standing'; factionId: string; delta: number }
  /**
   * Shift the standing between any two factions by `delta`, clamped to ±100.
   * Mirrors to both directions by default — set `mirror: false` for a
   * one-sided shift (one faction's opinion of the other moves without
   * reciprocation). Generalises `adjust_faction_standing` to the full
   * pair-wise matrix.
   */
  | { type: 'adjust_faction_relation'; a: string; b: string; delta: number; mirror?: boolean }
  /** Set the standing between two factions to an absolute value (clamped to ±100). Mirroring behaves like `adjust_faction_relation`. */
  | { type: 'set_faction_relation'; a: string; b: string; value: number; mirror?: boolean }
  /** Mark a faction as identified by the player — its name will render in the Target Panel of every member from now on (Pass 3 UI work). Idempotent. */
  | { type: 'reveal_faction'; factionId: string }
  | { type: 'record_rumor'; id: string; text: string; salience?: number }
  /** Promotes (or demotes) every NPC currently in the encounter whose `defId` matches. Faction-mates of a newly hostile NPC are auto-aggroed via the existing `aggroFaction` path. Use together with `trigger_combat` to turn a peaceful scene hostile when the player crosses a threshold. */
  | { type: 'set_disposition_by_def_id'; defId: string; disposition: 'ally' | 'neutral' | 'enemy' }
  /** Kicks off combat when the engine is in the exploring phase and at least one enemy is alive. Idempotent — no-ops if either precondition fails. */
  | { type: 'trigger_combat' }
  /** Award XP to the player. Use for trigger-fired story rewards (parley success, scouted clue, riddle solved) where no kill rolled the XP automatically. */
  | { type: 'award_xp'; amount: number }
  /** Roll a player ability check server-side (d20 + the player's `skills[<skill>]` bonus) against `dc`. Fires `onPass` actions if the total ≥ DC, otherwise `onFail`. Either branch may be empty — an empty `onFail` is the standard way to write "perception check that silently does nothing on a miss". The roll itself is NOT logged so failed perception/stealth checks don't leak information about hidden content. */
  | { type: 'player_ability_check'; skill: string; dc: number; onPass: TriggerAction[]; onFail: TriggerAction[] }
  /** Centre-screen announcement card; also appended to the Event Log so the message persists. Mirrors the `show_announcement` AIGM tool.
   *  `mode` defaults to `'focused'` (orange-bordered card; hides Player/Target/HUD panels; locks input; pauses world). Use `'unfocused'` for borderless atmospheric announcements that leave the UI and game running. */
  | { type: 'show_announcement'; text: string; durationMs?: number; mode?: 'focused' | 'unfocused' }
  /** Speech bubble above the named entity's token (same renderer the `npc_speaks` AIGM tool drives). `entity` accepts `player` or an NPC entity ref (`enemy_A`, `npc_<id>`). No-op when the entity can't be resolved. */
  | { type: 'npc_speaks'; entity: string; text: string }
  /** Black-out fade overlay. `mode: 'out'` fades to full black; `mode: 'in'` fades back to clear; `mode: 'dim'` fades to a 50% black overlay (atmospheric dim, world still visible). The overlay is sticky — pair every darkening fade ('out' or 'dim') with a matching `in`. Mirrors the `fade_screen` AIGM tool. */
  | { type: 'fade_screen'; mode: 'in' | 'out' | 'dim'; durationMs?: number };

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
// prose feels different on each play without invoking the generative GM.

export interface NarrationDef {
  id: string;
  variants: string[];
  /** Optional per-variant weight (parallel array to `variants`). When omitted, picks are uniform. */
  weights?: number[];
}

// ── Factions & rumors ────────────────────────────────────────────────────────
//
// Factions are referenced by string id on `NpcState.factionId` and held as a
// numeric **pair-wise relation matrix** on `GameState.factionRelations`. Each
// relation is a standing in the range −100..+100; the engine derives discrete
// states (`hostile`/`neutral`/`friendly`) via fixed thresholds (≤ −30, ≥ +30,
// else neutral). The player is a first-class faction (`PLAYER_FACTION_ID`
// `'party'`) — what used to be "the player's standing with faction X" is now
// `factionRelations.party.X`. Triggers/guards still read this view via the
// existing `adjust_faction_standing` / `faction_standing` plumbing.
//
// Defaults come from per-faction JSON files in `server/data/factions/`;
// individual encounters may override specific pairs via the optional
// `EncounterDef.factionRelations` block.
//
// **Discovery.** The player's identification of each faction is gated:
// `GameState.discoveredFactions` lists faction ids the player has identified
// (via an Insight check on combat-start, or an explicit AIGM
// `reveal_faction` tool). The Target Panel renders `Faction: ???` until the
// id appears in this set.
//
// Rumors are timestamped world events recorded into a global memory log so
// the GM and triggers can reference them later ("the bandit captain heard
// what you did to her brothers").

/** The reserved faction id every player party is a member of. */
export const PLAYER_FACTION_ID = 'party';
/** Standing threshold at or below which a relation reads as `hostile`. */
export const FACTION_HOSTILE_THRESHOLD = -30;
/** Standing threshold at or above which a relation reads as `friendly`. */
export const FACTION_FRIENDLY_THRESHOLD = 30;

/** Discrete view of a faction-pair relation, derived from the numeric standing. */
export type FactionStance = 'hostile' | 'neutral' | 'friendly';

/**
 * A faction the world knows about. One JSON file per faction in
 * `server/data/factions/`. The shipped roster covers the encounter content
 * (party, town_guard, bandits, cultists, undead, monsters, wildlife,
 * townsfolk); adding a new faction is a JSON drop with no code change.
 */
export interface FactionDef {
  /** Stable kebab/snake-case id referenced from `NpcState.factionId`. */
  id: string;
  /** Player-facing display name once discovered ("Town Guard", "Skein Cultists"). */
  name: string;
  /**
   * One-line description shown alongside the name in the Target Panel after
   * discovery. Helps an author keep faction identities distinct.
   */
  description?: string;
  /** Hex display colour used by the UI to tint the faction tag. */
  displayColor: string;
  /**
   * 1..30 renown rating. The Insight DC to identify a member of this faction
   * is `max(1, renown)` — well-known factions are trivially identified,
   * obscure ones require a high check. Ships at 1 across the board so the
   * mechanic is in place but always passes.
   */
  renown: number;
  /**
   * Default standings with other factions, keyed by other-faction id. Values
   * are the `−100..+100` matrix entries. Omitted ids default to 0.
   *
   * Asymmetric — a faction can dislike another without that other faction
   * disliking them back. The engine merges both directions when computing
   * effective relation (`getRelation(a, b)` takes the *minimum* of a→b and
   * b→a so a one-sided hostility still bites).
   */
  defaultRelations?: Record<string, number>;
}

export interface Rumor {
  /** Stable id — used as the dedupe key when authoring triggers off `rumor_propagated`. */
  id: string;
  /** Short human-readable text shown to the GM in CURRENT STATE. */
  text: string;
  /** 1–10 importance score. Determines whether the GM should reference it in narration. */
  salience: number;
  /** Server-relative timestamp (Date.now() at creation). Lets the GM order references chronologically. */
  recordedAt: number;
}

// ── Adventures ───────────────────────────────────────────────────────────────
//
// An adventure is a string of encounters with overarching narrative and
// cross-chapter state (world flags, faction standings, rumors, GM-summary
// memory). Each chapter references an existing `EncounterDef`; chapters are
// linear by default and an optional `unlockedBy` guard lets later chapters
// gate on world flags for soft branching. Authored in
// `server/data/adventures/*.json`; the live adventure save for a character
// lives in `server/data/saves/{characterId}_adventure.json`.

export interface AdventureChapter {
  /** Unique within the adventure. Used in save files and chapter-advance routes. */
  id: string;
  /** Title shown in HUD + setup-screen progress dots. */
  title: string;
  /** Encounter id from `server/data/encounters/`. */
  encounterId: string;
  /**
   * Optional guard: if present, the chapter only unlocks when the guard
   * holds. `flag_set: name` means worldFlags[name] is defined; `flag_equals`
   * checks value. Lets adventure authors gate chapters on choices in
   * earlier chapters.
   */
  unlockedBy?:
    | { flag_set: string }
    | { flag_equals: { name: string; value: WorldFlagValue } };
  /**
   * Optional named flag that, when set, marks this chapter complete (in
   * addition to the default combat-ended detection). Lets exploration /
   * dialogue chapters define their own completion condition.
   */
  completionFlag?: string;
}

export interface AdventureDef {
  id: string;
  title: string;
  description: string;
  /** Player-facing prose shown on the adventure card and in the intro overlay before chapter 1. */
  introduction: string;
  chapters: AdventureChapter[];
}

/** Persisted at `server/data/saves/{characterId}_adventure.json`. Holds the cross-chapter state that survives a chapter transition. */
export interface AdventureSave {
  characterId: string;
  adventureId: string;
  /** Index into `AdventureDef.chapters` for the chapter currently in progress (or just completed). */
  currentChapterIndex: number;
  /** Ids of chapters that have been completed. */
  completedChapterIds: string[];
  /** Cross-chapter world flags. Seeds `GameState.worldFlags` when each chapter session starts. */
  worldFlags: Record<string, WorldFlagValue>;
  /**
   * Cross-chapter faction standings. **Kept for backward compatibility** —
   * stores the player's standing with each faction (`factionRelations.party.*`).
   * On chapter boot the session seeds `factionRelations.party` from this map
   * and persists the updated `party` row back here on chapter advance.
   */
  factionStandings: Record<string, number>;
  /**
   * Full pair-wise faction-relation matrix carried between chapters. When
   * present at chapter boot, seeds `GameState.factionRelations` (after layering
   * the encounter override on top). When the chapter ends, persists the live
   * matrix back so faction politics survive across chapters.
   *
   * Older saves without this field fall back to deriving `party`'s row from
   * `factionStandings` plus the faction-def defaults.
   */
  factionRelations?: Record<string, Record<string, number>>;
  /**
   * Cross-chapter discovered factions. Seeds `GameState.discoveredFactions`
   * on chapter boot; persisted back when the chapter ends so identity
   * reveals survive.
   */
  discoveredFactions?: string[];
  /** Cross-chapter rumors. Seeds `GameState.rumors`. */
  rumors: Rumor[];
  /** Short GM-authored summaries of completed chapters, surfaced to the AIGM in later chapters under PRIOR CHAPTERS. */
  priorChapterSummaries: Array<{ chapterId: string; chapterTitle: string; summary: string }>;
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
  /** SRD Hide outcome — the total of the Stealth check that became the
   *  player's `hidden` condition. Every subsequent Perception attempt
   *  (passive sweep on turn boundary / movement, or active Search) opposes
   *  this DC. Cleared together with the `hidden` condition. */
  hideDC?: number;
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
  /** Currently active periodic effects (DoTs, attach bites, …). Each fires at the start of its `sourceNpcId`'s turn — see OngoingEffectsSystem. */
  ongoingEffects: OngoingEffect[];
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
  /** True when the player has at least one attached creature they could
   *  Detach as an action (consumes the action and removes the attach effects
   *  from that source). */
  canDetach: boolean;
  /** True when the player's XP has reached the threshold to advance to the next level (per SRD Character Advancement). The Player Panel surfaces this as a `LEVEL UP` button. */
  canLevelUp: boolean;
  /** True when the current encounter permits Long Rest (`GameState.allowsLongRest`) AND the player is in the exploration phase. */
  canLongRest: boolean;
}

// ── Level-up preview + choices ────────────────────────────────────────────────

/**
 * Server-computed preview of what a single level-up applies + which choices
 * the player must make. The client fetches one via `GET /game/session/:id/level-up`
 * to render the LevelUpOverlay; on CONFIRM the client POSTs the chosen
 * `LevelUpChoices` back to `POST /game/session/:id/level-up`. The server
 * applies the changes atomically.
 */
export interface LevelUpPreview {
  /** Current level (the level the character is at *before* the level-up). */
  fromLevel: number;
  /** New level the character will reach. Always `fromLevel + 1`. */
  toLevel: number;
  /** Class name (display, taken from `PlayerDef.className`). */
  className: string;
  /** HP delta added to `maxHp` — `fixedHpForClass(className) + conMod`, minimum 1. */
  hpGain: number;
  /** Proficiency bonus before/after. Equal when no change at this level. */
  proficiencyBefore: number;
  proficiencyAfter: number;
  /** Spell-slot deltas, indexed by `spellLevel − 1`. Empty for non-casters or no change. */
  spellSlotDeltas: number[];
  /** Class features the character gains at the new level (id + name + SRD description). */
  newFeatures: Array<{ id: string; name: string; description: string }>;
  /** Player-facing prompts; `LevelUpChoices` must answer every prompt's `kind`. */
  choices: LevelUpChoicePrompt[];
}

/**
 * Discriminated union of every choice prompt the SRD can require at a level
 * boundary. Add new variants here when adding higher-level choice handling
 * (subclass at L3, ASI/Feat at L4, fighting-style upgrade, etc.).
 */
export type LevelUpChoicePrompt =
  | {
      kind: 'scholar-expertise';
      label: string;
      description: string;
      /** Skill ids the player has proficiency in AND that the SRD Scholar feature allows. */
      options: string[];
    }
  | {
      kind: 'wizard-spellbook-add';
      label: string;
      description: string;
      /** Spell ids the player may add. Filtered to wizard spells of a level the
       *  character can cast that aren't already in the spellbook. May be empty
       *  if the player already knows every available option, in which case the
       *  prompt is purely informational and `count` is 0. */
      options: Array<{ id: string; name: string; level: number; school: string }>;
      /** Number of spells the player must add. Typically 2 (Wizard L2+). */
      count: number;
    };

/** Player-supplied answers to a `LevelUpPreview`. Each chosen value matches its prompt's `kind`. */
export interface LevelUpChoices {
  scholarExpertise?: string;
  wizardSpellbookAdd?: string[];
}

// ── Long Rest preview + choices ──────────────────────────────────────────────

/**
 * Server-computed summary of what a Long Rest will restore for the active
 * character. Drives the `LongRestOverlay` — the client renders one row per
 * non-zero delta plus a Wizard spell-prep picker when applicable. The SRD
 * grants every standard benefit (full HP / Hit Dice / spell slots / class
 * features, exhaustion -1); the only authored choice surfaced here is the
 * Wizard's prepared-spell list, which the SRD lets the player rebuild each
 * Long Rest.
 */
export interface LongRestPreview {
  /** HP that will be restored (maxHp − currentHp). */
  hpRestored: number;
  /** Hit Dice the rest will restore — SRD 5.2.1 restores ALL spent Hit Dice. */
  hitDiceRestored: number;
  /** Spell-slot delta to restore per slot level. `spellSlotsRestored[i]` is the change to slot level `i+1`. */
  spellSlotsRestored: number[];
  /** Feature resources to refill: `{ id, name, before, max }` per affected pool. */
  featuresRestored: Array<{ id: string; name: string; before: number; max: number }>;
  /** Whether the player has at least one Exhaustion level to remove. */
  exhaustionReduced: boolean;
  /** Wizard-only: prepared-spell picker state. Omitted for non-Wizard classes. */
  wizardSpellPrep?: {
    spellbookSpells: Array<{ id: string; name: string; level: number; school: string }>;
    /** Currently prepared ids. The client seeds the picker with these. */
    currentlyPrepared: string[];
    /** Maximum allowed prepared spells (SRD Wizard Features table, or higher when feats grant extras). */
    maxPrepared: number;
  };
}

/** Player-supplied answers to the long-rest preview. Wizards must pass their chosen prepared-spell list. */
export interface LongRestChoices {
  wizardPreparedSpellIds?: string[];
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
  /** When set, this NPC was conjured by a spell — Mage Hand, Unseen Servant.
   *  Summons skip the normal NPC turn loop (they don't act on their own; the
   *  caster commands them with the `commandSummon` PlayerAction), aren't
   *  added to combat initiative, and use a `<spell-id>` faction. The value is
   *  the spell id that spawned them. */
  summonSpellId?: string;
  /** Player def id of the caster — used to enforce range tethers (Mage Hand
   *  ends when the caster ends a turn more than 30 ft from the hand). */
  summonOwnerId?: string;
  hp: number;
  maxHp: number;
  isActive: boolean;
  reactionUsed: boolean;
  conditions: string[];
  /** SRD Hide outcome for this NPC — Stealth roll total recorded when the
   *  creature took the Hide action. Opposed by player / other NPC Perception. */
  hideDC?: number;
  /** Last tile the player observed this NPC on. Set whenever `Vision.canSee`
   *  reports the player saw this creature. Used by the client to render the
   *  NPC's last-known position as a faded ghost when the player loses sight
   *  (SRD "out of sight, not out of mind"). Cleared when the player sees
   *  the creature again at its current tile. */
  lastSeenTile?: { x: number; y: number };
  inventoryIds: string[];
  // Initiative roll total for the current combat (d20 + initiativeBonus, with
  // optional Disadvantage if Surprised). Cleared when combat ends.
  initiativeRoll?: number;
  /** Currently active periodic effects (DoTs, attach bites, …). See OngoingEffectsSystem. */
  ongoingEffects: OngoingEffect[];
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
  /** Per-tile cover (SRD 5.2.1). `null` = no cover. Authored via
   *  `EncounterTileProperty.cover` and baked at session-build time so the
   *  Vision LOS walker and combat resolver can read it in O(1). */
  cover?: (null | 'half' | 'three-quarters' | 'total')[][];
  /** Per-tile obscurance (SRD 5.2.1). `null` = clear; `lightly` imposes
   *  Disadv on Perception (sight); `heavily` Blinds the observer into the
   *  tile and counts as Hide-eligible cover. Baked from
   *  `EncounterTileProperty.obscurance`. Encounter-wide light defaults
   *  (`EncounterEnvironment.lightLevel`) are NOT baked in here — they are
   *  layered on top at read time so darkvision can override them per
   *  observer. */
  obscurance?: (null | 'lightly' | 'heavily')[][];
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
  eventLog: LogEntry[];
  logScrollOffset: number;
  mapName: string;
  encounterTitle: string;
  /** Player-facing one-line goal for this encounter, shown atop the Quests panel. */
  objective: string;
  quests: QuestState[];
  selectedTargetId: string | null;
  activeNpcIndex: number;
  turnOrderIds: string[];
  introduction: string;
  encounterContext: string;
  /** Carried from `EncounterDef.allowsLongRest` (default `false`) — drives `AvailableActions.canLongRest`. */
  allowsLongRest: boolean;
  npcPersonas: NpcPersona[];
  availableActions: AvailableActions;
  /** Set when the engine has paused on a reaction-eligible trigger. The next player action must be `resolveReaction`. Cleared on resolution. */
  pendingReaction: PendingReaction | null;
  /** Authored encounter triggers active for this session. Sourced from `EncounterDef.triggers` at session creation. */
  triggers: EncounterTrigger[];
  /** Ids of triggers that have already fired. Persisted in `world.json` so `once` semantics survive save/load. */
  firedTriggerIds: string[];
  /** Scripted-event lines queued by `send_aigm_message` actions. Surfaced to the next AIGM turn under the SCRIPTED EVENTS block and cleared once consumed. */
  pendingAigmEvents: string[];
  /** Authored world flags keyed by name. Written by `set_flag` trigger actions, read by `flag_set` / `flag_unset` / `flag_equals` guards. Persisted with the world save. */
  worldFlags: Record<string, WorldFlagValue>;
  /** Last variant index picked per `narrationId`. Used by NarrationSystem to avoid back-to-back repeats. */
  narrationLastUsed: Record<string, number>;
  /**
   * Legacy player-relative view of standings. **Kept for backward compatibility**
   * with existing `faction_standing` guards, `adjust_faction_standing` AIGM
   * tool calls, and adventure-save seeding — internally this is just a
   * projection of `factionRelations[PLAYER_FACTION_ID]` and the engine keeps
   * it in sync.
   *
   * New code should read / write via `factionRelations` directly.
   */
  factionStandings: Record<string, number>;
  /**
   * Full pair-wise relation matrix between every faction the session is aware
   * of. `factionRelations[a][b]` is faction `a`'s standing with faction `b`
   * in the range −100..+100. The matrix is **symmetric when first built**
   * (we mirror each declared default), but runtime triggers / AIGM tool calls
   * may break that symmetry. `getRelation(state, a, b)` resolves the
   * effective standing by taking the worse of the two directions, so one
   * faction can read another as hostile without the second reciprocating.
   *
   * Seeded at session creation from `defs.factions[*].defaultRelations` and
   * the optional `EncounterDef.factionRelations` override block.
   */
  factionRelations: Record<string, Record<string, number>>;
  /**
   * Faction ids the player has identified through play (Insight check on
   * combat-start, or the AIGM's `reveal_faction` tool). The Target Panel
   * renders the faction name + colour for ids in this set, `???` otherwise.
   * Persisted with the world save and seeded from adventure saves so identity
   * reveals carry across chapters.
   */
  discoveredFactions: string[];
  /** World memory log of significant events, recorded by AIGM `create_rumor` tool or trigger `record_rumor` action. Surfaced to the GM in CURRENT STATE. */
  rumors: Rumor[];
  /** Set when the current session is a chapter of an adventure. Drives the END CHAPTER button and the chapter-advance flow. Null for single-encounter sessions. */
  adventureContext: AdventureSessionContext | null;
  /** Set true when the active chapter has been resolved (combat-ended or `completionFlag` set). Drives the END CHAPTER button. */
  chapterComplete: boolean;
  /** Optional world-flag name that, when set, marks the encounter complete. Mirrors `EncounterDef.completionFlag` for standalone (non-adventure) encounters so the `encounter_completed` engine event can fire on flag-driven resolutions. */
  encounterCompletionFlag?: string;
  /** Environmental flags consulted by combat resolvers — sourced from EncounterDef.environment at session creation. */
  environment: EncounterEnvironment;
}

export interface AdventureSessionContext {
  adventureId: string;
  adventureTitle: string;
  chapterId: string;
  chapterTitle: string;
  chapterIndex: number;
  totalChapters: number;
  /** Short summaries of previously completed chapters; surfaced to the AIGM under PRIOR CHAPTERS. Empty for chapter 1. */
  priorChapterSummaries: Array<{ chapterId: string; chapterTitle: string; summary: string }>;
  /** Optional named flag that, when set, marks the chapter complete in addition to the default combat-ended detection. Mirrors `AdventureChapter.completionFlag`. */
  completionFlag?: string;
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
  /** Secondary damage riders that also land if Shield is declined. */
  incomingBonusComponents: RolledBonusDamage[];
  /** The attack roll total — exposed so the UI can explain what Shield would convert. */
  attackTotal: number;
  /** What the player's AC would become with Shield up. */
  shieldedAc: number;
}

export type PendingReaction = PendingReactionOA | PendingReactionShield;

// ── Animation events ─────────────────────────────────────────────────────────

export type GameEvent =
  | { type: 'entity_move'; entityId: string; toX: number; toY: number }
  | { type: 'log'; lines: string[] }
  /** Show a speech-bubble above the named entity for a few seconds. Pushed by
   *  the AIGM `npc_speaks` tool (and future trigger actions); the client
   *  resolves the entity ref (`player` / `enemy_A` / `npc_<id>`) to a token
   *  position and renders an absolutely-positioned bubble. */
  | { type: 'npc_speech'; entityId: string; text: string }
  /** A noise was emitted at the given tile. The client renders a brief
   *  expanding circle (a "sound ring") at the source so the player gets
   *  visual feedback of audible events — useful when the noise came from
   *  outside the player's line of sight. `intensity` is in tiles (matches
   *  the server-side EngineEvent radius). */
  | { type: 'sound_ring'; x: number; y: number; intensity: number }
  /** Play a one-off sound effect. The `sound` field is a logical id the
   *  client maps to an audio file (see `SoundLibrary` in
   *  `client/src/ui/SoundLibrary.ts`). Reserved for cinematic SFX cues
   *  (physical-attack hit, spell impact, …) — NOT for the per-tile noise
   *  events fed into the Hide/Perception model, which use `sound_ring`
   *  plus the engine-side `noise` event. */
  | { type: 'play_sound'; sound: string }
  /** Black-out fade overlay covering the entire canvas + every UI panel.
   *  `mode: 'out'` runs opacity → 1 (full black); `mode: 'in'` runs → 0
   *  (fully clear); `mode: 'dim'` runs → 0.5 (50% black — atmospheric dim
   *  where the world remains visible underneath). The event blocks the
   *  event queue for `durationMs` so subsequent events (e.g. a supertitle
   *  during a fade-out hold) play in sequence. */
  | { type: 'screen_fade'; mode: 'in' | 'out' | 'dim'; durationMs: number }
  /** Movie-style location title — huge centred white text holding the screen
   *  for `durationMs` (defaults applied client-side). Blocks the event queue
   *  for the duration so callers can chain fade_out → supertitle → fade_in. */
  | { type: 'supertitle'; text: string; durationMs?: number }
  /** Centre-screen announcement intended to mirror the event log. The server
   *  is responsible for also appending the text to `state.eventLog` so the
   *  message persists after the announcement fades.
   *
   *  `mode` controls how the announcement integrates with the live game:
   *    - `focused` (default for cinematic beats): orange-bordered card; the
   *      Player Panel, Target Panel, and HUD are hidden; player movement /
   *      actions are locked; world-tick is paused for the duration.
   *    - `unfocused`: borderless card with a soft edge-fade gradient. The UI
   *      stays visible, the world keeps ticking, the player can keep playing. */
  | { type: 'announcement'; text: string; durationMs?: number; mode?: 'focused' | 'unfocused' };

// ── Player actions ───────────────────────────────────────────────────────────

export type PlayerAction =
  | { type: 'move'; dx: number; dy: number }
  | { type: 'moveTo'; tileX: number; tileY: number }
  | { type: 'attack'; targetId?: string }
  | { type: 'throw'; itemId: string; targetId?: string }
  | { type: 'castSpell'; spellId: string; slotLevel: number; targetIds?: string[]; tile?: { x: number; y: number }; asRitual?: boolean; damageTypeChoice?: string }
  | { type: 'hide' }
  | { type: 'useFeature'; featureId: string; targetId?: string; tile?: { x: number; y: number } }
  /** Command a player-owned summon (Mage Hand, Unseen Servant) to move to `tile`.
   *  The server validates the move range per spell and ends the spell if the
   *  range / lifecycle conditions are violated. Consumes the player's Action. */
  | { type: 'commandSummon'; summonNpcId: string; tile: { x: number; y: number } }
  | { type: 'resolveReaction'; accept: boolean }
  | { type: 'dash' }
  | { type: 'dodge' }
  | { type: 'disengage' }
  | { type: 'detach' }
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
  | { type: 'aigm_reply'; reply: string }
  // Streaming AIGM protocol — emitted during processAIGMChat:
  //   aigm_start: a new AIGM turn has begun; the client opens a fresh
  //     assistant bubble (baseline = 0).
  //   aigm_chunk: text delta appended to the current assistant bubble.
  //   aigm_checkpoint: the chunks since the last checkpoint are canonical —
  //     the client advances its discard baseline to the current text length.
  //   aigm_speculative_discard: the chunks since the last checkpoint were
  //     written before a roll-requesting tool and must be removed from the
  //     visible bubble. Client rolls back to the discard baseline.
  //   aigm_done: the final, persisted reply text + roll-result strings.
  | { type: 'aigm_start' }
  | { type: 'aigm_chunk'; text: string }
  | { type: 'aigm_checkpoint' }
  | { type: 'aigm_speculative_discard' }
  | { type: 'aigm_done'; reply: string; rollResults: string[] }
  | { type: 'error'; message: string };

// ── Session creation ─────────────────────────────────────────────────────────

export interface CreateSessionRequest {
  mapType: 'open' | 'rooms' | 'saved';
  playerDefId: string;
  savedMapId?: string;
  encounterTitle?: string;
  savedMapName?: string;
  savedMapDescription?: string;
  npcIds?: string[];
  allyIds?: string[];
  /** Hand-picked hostile creature ids — see EncounterDef.enemyIds. */
  enemyIds?: string[];
  customIntroduction?: string;
  customContext?: string;
  customObjective?: string;
  /** Mirror of `EncounterDef.allowsLongRest`. Carried through to `GameState.allowsLongRest`. */
  allowsLongRest?: boolean;
  /** Mirror of `EncounterDef.completionFlag`. Seeded onto `GameState.encounterCompletionFlag` for the `encounter_completed` lifecycle event. */
  completionFlag?: string;
  tileProperties?: EncounterTileProperty[];
  startingZones?: StartingZonesLayer;
  triggers?: EncounterTrigger[];
  /** Seed adventure-scope state on session creation. Set when the new session is a chapter of an in-progress adventure. */
  adventureSeed?: AdventureSessionContext & {
    seedWorldFlags?: Record<string, WorldFlagValue>;
    seedFactionStandings?: Record<string, number>;
    /** Cross-chapter full faction-relation matrix (Pass 1+). When absent we fall back to seeding from `seedFactionStandings` (`party` row only). */
    seedFactionRelations?: Record<string, Record<string, number>>;
    /** Cross-chapter discovered factions (Pass 1+). Empty when absent. */
    seedDiscoveredFactions?: string[];
    seedRumors?: Rumor[];
  };
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
  /** Level-up history — one `LevelUpChoices` per level above 1. Replayed at
   *  session start so the per-session `playerDef` clone reaches its current
   *  level with the player's recorded feature / spell / Expertise picks. */
  resumeLevelUps?: LevelUpChoices[];
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
