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
  /** Finesse weapon (Daggers, Rapiers, Scimitars, …). Lets DEX replace STR
   *  for attack and damage rolls (`makePlayerAttack` already picks the
   *  higher mod) — and qualifies the weapon for Sneak Attack. */
  finesse: boolean;
  graze: boolean;
  vex: boolean;
  sap: boolean;
  slow: boolean;
  /** Push mastery — on hit, the attacker can shove the target 10 ft away. */
  push: boolean;
  /** Topple mastery — on hit, target makes a Con save or falls Prone. */
  topple: boolean;
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
  /** Starting coin purse this character spawns with, denominated in Copper
   *  Pieces (SRD: 1 GP = 100 CP, 1 SP = 10 CP). Defaults to 0 when omitted. */
  defaultCp?: number;
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
  /** One-line tagline shown on the character carousel selector card. */
  shortDescription?: string;
  description?: string;
  /** Path to the SVG used as this character's token sprite. Required — every
   *  character JSON must declare its token explicitly (no naming-convention
   *  fallback). */
  tokenAsset: string;
  /** Per-character scaling track values resolved from `ClassDef.tracksByLevel`
   *  at each level-up. Engine subsystems consult this map instead of
   *  hard-coded class knowledge — e.g. the attack resolver reads
   *  `tracks['extra-attacks']` to decide the loop count, the Rogue resolver
   *  reads `tracks['sneak-attack-dice']`. Per-feature use pools (Second Wind
   *  uses, Action Surge uses, …) land in `tracks['<feature-id>-uses']`. */
  tracks?: Record<string, number | string>;
  /** Subclass id picked at the class's subclass-choice level (typically L3).
   *  References a `SubclassDef.id` in `defs.subclasses`. The level-up
   *  resolver walks the subclass progression in addition to the class's own
   *  every time the character reaches one of the parent's `subclassLevels`. */
  subclassId?: string;
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

/**
 * Token Creator spec — the editable JSON record that backs every author-built
 * token. The scene composes a flat SVG at save time and writes both files
 * to disk: the SVG goes to `data/tokens/<id>.svg` (so any `tokenAsset` field
 * pointing there resolves through the existing static-file route) and the
 * spec goes to `data/tokens/specs/<id>.json` so the user can re-open the
 * Token Creator and tweak instead of starting over.
 */
export interface TokenSpec {
  /** Filename stem — produces `token_<id>.svg` + `token_<id>.json` on disk. */
  id: string;
  slots: {
    body?:       string;
    ears?:       string;
    face?:       string;
    beard?:      string;
    eyes?:       string;
    mouth?:      string;
    hair?:       string;
    accessory?: string;
  };
  /** Palette colours stamped into the part fragments at compose time. */
  palette: {
    /** Coin background fill — typically matches the NPC's `color` field. */
    body?: string;
    /** Face + ears fill. */
    skin?: string;
    /** Hair + beard fill. */
    hair?: string;
  };
}

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
  /**
   * Default conversation graph id this NPC opens when the player initiates
   * dialogue. Resolves against `server/data/settings/<setting>/conversations/`.
   * Encounter authors can override per-encounter via
   * `EncounterDef.conversationOverrides` (see EncounterDef).
   */
  conversationId?: string;
  /**
   * When true, the engine maintains a per-character `NpcSave` file recording
   * this NPC's relationship, memories, and stateful overrides across sessions,
   * encounters, and adventures. Most NPCs are throwaway and leave this false
   * — flip it on for named characters the player is expected to interact with
   * again. Save file path: `<setting>/saves/<characterId>_npcs/<npcId>.json`.
   * See `NpcSave` for the schema.
   */
  persistent?: boolean;
}

// ── Conversation system ─────────────────────────────────────────────────────
//
// Deterministic dialogue graphs that let an encounter play through scripted
// social beats without invoking the AIGM. Designed participant-agnostic from
// day one so simulation-mode NPC-vs-NPC conversations (future scope) reuse
// the same runtime: `participants` is an array (`["player", "npc_bram"]`
// today; `["npc_bram", "npc_overseer"]` once the sim runs), choices carry
// an optional `actor` ref, and effects can target any entity. Today the UI
// only renders when the player is a participant, but the data model and the
// engine don't bake in that assumption.

/** Entity reference. `"player"` is the player; `"npc_<id>"` is an NPC instance
 *  by def id; `"enemy_A"` / `"ally_A"` are combat-label refs the AIGM already
 *  understands. New code MUST accept all four — old data that hard-codes
 *  `"player"` keeps working. */
export type EntityRef = string;

export interface ConversationDef {
  /** Snake_case slug — used as the filename and as the lookup key. */
  id: string;
  /** Id of the first node entered when the conversation starts. */
  startNode: string;
  /** Default participants when the conversation is opened. Today always
   *  `["player", "<npc-ref>"]`; the simulation runtime substitutes
   *  `["npc_a", "npc_b"]`. `start_conversation` may override at call time. */
  defaultParticipants: EntityRef[];
  /** All nodes in the graph. The loader validates that every `next` field
   *  references a real id and that no node is unreachable from `startNode`. */
  nodes: ConversationNode[];
}

export interface ConversationNode {
  id: string;
  /** Lines the speaker delivers when the node is entered. Multiple entries
   *  rotate with anti-repeat memory (mirrors the `narrate` action). */
  lines: string[];
  /** Optional speaker override — defaults to the NPC whose `conversationId`
   *  opened this graph. For multi-character scenes (or future NPC-vs-NPC),
   *  set this to the entity ref of the actual speaker. */
  speaker?: EntityRef;
  /** Effects fired the instant the node is entered (before the player sees
   *  any choices). Common uses: `set_flag`, `npc_speaks` for atmosphere
   *  lines, `npc_remember` for "the NPC noticed the player came back". */
  onEnter?: TriggerAction[];
  /** Player-facing choices. Empty array + `ends: true` makes a terminal node. */
  choices: ConversationChoice[];
  /** When true, the conversation ends after `onEnter` runs. Choices ignored. */
  ends?: boolean;
}

export interface ConversationChoice {
  /** Display label. May contain a `[Skill DC N]` tag — purely cosmetic;
   *  the actual roll is configured under `check`. */
  label: string;
  /** Optional gate. ALL guards must hold for the choice to be visible. */
  visibleIf?: TriggerGuard[];
  /** Optional gate. ALL guards must hold for the choice to be enabled but
   *  visible — surfaced greyed-out otherwise so the player sees the
   *  branch exists. Use this for "you could try this if your relationship
   *  with them were higher" hints. */
  enabledIf?: TriggerGuard[];
  /** Ability / saving-throw check. When set, the engine rolls d20 + the
   *  matching modifier; `total >= dc` routes to `onPass`, otherwise to
   *  `onFail`. `actor` defaults to the player; future NPC-driven choices
   *  pass an explicit ref. */
  check?: {
    actor?: EntityRef;
    /** Mutually exclusive with `ability` — use the higher-level skill modifier. */
    skill?: string;
    /** Mutually exclusive with `skill` — use the raw ability modifier. */
    ability?: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';
    dc: number;
    advantage?: 'normal' | 'advantage' | 'disadvantage';
  };
  /** When `check` resolves true (or no check is configured), run these
   *  effects and jump to `next` / end the conversation. */
  onPass?: ConversationChoiceOutcome;
  /** When `check` resolves false, run these effects + jump. Allows
   *  "try to persuade and fail loudly" branches. */
  onFail?: ConversationChoiceOutcome;
  /** Effects + next when there's no check at all. Equivalent to onPass for
   *  uncheck'd choices; both forms accepted to keep authoring readable. */
  actions?: TriggerAction[];
  next?: string;
  end?: boolean;
  /** Hands off control to the AIGM with the full conversation transcript +
   *  the speaker's `NpcSave` context. The AIGM may re-anchor the player to
   *  a graph node via `set_conversation_node` or close the conversation. */
  openAigm?: boolean;
}

export interface ConversationChoiceOutcome {
  actions?: TriggerAction[];
  next?: string;
  end?: boolean;
}

/** Runtime conversation state stored on `GameState`. `null` when no
 *  conversation is active. The transcript is the canonical record handed to
 *  the AIGM on free-text handoff, and to the persistent NPC save when the
 *  conversation ends. */
export interface ActiveConversation {
  conversationId: string;
  /** Current node id; null briefly between effect dispatch and the next
   *  node entry while a long-running effect chain resolves. */
  currentNodeId: string;
  /** Entity refs of every participant. Today always includes `"player"`;
   *  future simulation runs may omit it. */
  participants: EntityRef[];
  /** Speaker for the most-recently rendered line. Drives the overlay's
   *  portrait + nameplate. */
  currentSpeaker: EntityRef;
  /** Linear transcript of what each participant has said / chosen so far.
   *  Capped at ~24 entries with oldest evicted to keep AIGM context bounded. */
  exchanges: ConversationExchange[];
  /** Set of node ids the conversation has visited this session — drives
   *  "first-visit only" effects and lets the UI tint repeat choices. */
  visitedNodeIds: string[];
  /** Per-node line-variant rotation memory (mirrors `narrationLastUsed`).
   *  Keyed by node id; value is the last variant index used. */
  lineLastUsed: Record<string, number>;
  /** Choice slots whose ability check the player has already rolled. Each
   *  key is `${nodeId}#${choiceIndex}`. The server rejects a second attempt
   *  on the same slot unless `devFlags.allowRetryChecks` is true; the client
   *  reads this to hide the choice (or surface it with a `[DEV]` tag when
   *  retry is dev-enabled). */
  attemptedCheckKeys: string[];
  /** Set when the conversation is paused awaiting an ability-check resolution.
   *  The engine writes the outcome and resumes via the choice's onPass/onFail. */
  pendingCheck?: {
    choiceIndex: number;
    actor: EntityRef;
    skill?: string;
    ability?: string;
    dc: number;
    advantage?: 'normal' | 'advantage' | 'disadvantage';
  };
}

export type ConversationExchangeKind = 'line' | 'choice' | 'roll' | 'aigm' | 'event';

export interface ConversationExchange {
  /** Who acted at this step. */
  speaker: EntityRef;
  /** Display name resolved at write time (so the transcript reads cleanly
   *  even after a `revealedName` flip). */
  speakerName: string;
  /** Kind drives how the AIGM context formatter renders the line. */
  kind: ConversationExchangeKind;
  text: string;
  /** ISO timestamp at write — used as a tiebreaker when sorting NPC saves
   *  by recency and as a recency hint for the AIGM. */
  at: string;
}

// ── NPC save layer ─────────────────────────────────────────────────────────
//
// Persistent NPCs maintain a per-character save file. Conversations write to
// it explicitly via the new `npc_remember` / `npc_adjust_relationship` /
// `npc_record_journal` actions; the engine also writes implicitly when the
// NPC is involved in canonical events (death, name reveal, faction flip).
// Future `WitnessSystem` will write inter-NPC observation records here too.

/** Fact values stored under `NpcSave.facts`. Booleans for binary memory
 *  ("met_the_player"), numbers for counters ("times_lied_to"), strings for
 *  free-form tags ("favorite_drink:dwarven_ale"), or a structured shape
 *  with an occurrence count + last-at timestamp. */
export type NpcFactValue =
  | boolean
  | number
  | string
  | { count: number; lastAt: string };

export interface NpcFactEntry {
  value: NpcFactValue;
  /** Provenance of the write. Drives future "how confident is the NPC?"
   *  reasoning — author-scripted facts are ground truth, witness facts are
   *  observational, AIGM facts are roleplay-driven. */
  source: 'authored' | 'aigm' | 'witness' | 'system';
  recordedAt: string;
}

export interface NpcJournalEntry {
  text: string;
  /** 1 = trivia, 3 = pivotal. Capacity-limited evictor uses salience first,
   *  age second when the journal is full. */
  salience?: 1 | 2 | 3;
  source: 'authored' | 'aigm' | 'witness' | 'system';
  recordedAt: string;
}

export interface NpcConversationHistoryEntry {
  conversationId: string;
  /** Node where the conversation ended (terminal node id or last-rendered
   *  node when ended via AIGM `end_conversation`). */
  endedAtNodeId: string;
  /** Sequence of choice labels the player picked through the graph —
   *  surfaced to the AIGM so future free-text exchanges can reference
   *  "you said you'd come back for me". */
  chosenPath: string[];
  /** Every check rolled during the conversation. */
  rolledChecks: Array<{ skill: string; dc: number; total: number; passed: boolean }>;
  at: string;
}

export interface NpcSave {
  /** NPC def id this save belongs to. */
  npcId: string;
  /** Character def id this save is scoped to — each player keeps their own
   *  memory tree of every NPC. */
  characterId: string;
  /** Liveness. `dead` saves are retained so other NPCs / future scenes can
   *  reference "the NPC died" without the def needing special handling. */
  status: 'alive' | 'dead' | 'fled';
  /** Provenance of the last update. */
  lastSeen: {
    at: string;
    adventureId?: string;
    chapterId?: string;
    encounterId?: string;
  };
  /** Has the player's character learned this NPC's true name? Drives token
   *  nameplate + Target Panel display, mirrors `NpcState.revealedName`. */
  nameKnownToPlayer: boolean;
  /** Stateful overrides applied when the NPC is re-spawned in a future
   *  encounter. Only fields the design wants to persist live here; HP is
   *  optional (future "wounds persist between chapters" rule), conditions
   *  for long-term ones (cursed, etc.). The engine's spawn path layers
   *  these on top of the def's defaults. */
  stateOverrides: {
    currentHp?: number;
    conditions?: string[];
    addedItemIds?: string[];
    removedItemIds?: string[];
    factionId?: string;
    disposition?: 'ally' | 'neutral' | 'enemy';
  };
  /** Relationship scores keyed by entity ref. `"party"` is the player —
   *  conversation gates and the AIGM both read this. Other keys hold
   *  NPC-to-NPC standings (used by the future simulation runtime; the
   *  conversation system today writes only `"party"`). Bounded ±100. */
  relationship: Record<EntityRef, number>;
  /** Optional trust / respect axes — see plan. Kept optional so existing
   *  saves don't need a migration when the axes are introduced. */
  trust?: Record<EntityRef, number>;
  respect?: Record<EntityRef, number>;
  /** Queryable structured memory. Conversation `visibleIf` predicates and
   *  future AIGM `npc_remember` tool both read/write here. */
  facts: Record<string, NpcFactEntry>;
  /** Free-form narrative log surfaced to the AIGM for future conversations.
   *  Capacity-limited (default 20). */
  journal: NpcJournalEntry[];
  /** Per-conversation completion record. */
  conversationHistory: NpcConversationHistoryEntry[];
  /** Optional personal-arc state — for NPCs with their own storyline. */
  arc?: { phase: string; updatedAt: string };
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
  /** Shop price in Copper Pieces (SRD coin system — see `shared/currency.ts`). */
  costCp?: number;
}

export interface ShieldDef {
  id: string; name: string; type: 'shield';
  acBonus: number;
  costCp?: number;
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
  costCp?: number;
}

// Ammunition is its own equipment subtype so it's distinct from health potions
// (consumables) but still represented as inventory items (stackable by id).
export interface AmmunitionDef {
  id: string; name: string; type: 'ammunition';
  ammunitionType: string;  // canonical key matching WeaponDef.ammunitionType
  costCp?: number;
}

// Gear is a catch-all for non-functional inventory items — class artifacts
// like a wizard's spellbook, holy symbols, tools, books, etc. They appear in
// the inventory as flavour/lore objects with no UI action button. Distinct
// from ammunition (which is auto-consumed) and consumables (which have USE).
export interface GearDef {
  id: string; name: string; type: 'gear';
  description?: string;
  costCp?: number;
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

// ── Class definitions ────────────────────────────────────────────────────────
//
// SRD 5.2.1 class advancement encoded as data. The engine reads
// `server/data/classes/*.json` at boot and drives the level-up resolver,
// character build defaults, and resource-pool scaling off these. Subclasses
// live in `server/data/subclasses/*.json` and reference their parent class
// via `classId`; the engine walks both progression arrays at each level.

export type AbilityKey = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';

/** A per-level scaling value. `number` covers counts/feet/points; `string`
 *  covers dice expressions like `"1d6"` for Monk Martial Arts or Bard Bardic
 *  Die. The engine parses the dice form lazily — for arithmetic uses you'd
 *  still want numbers. */
export type TrackValue = number | string;

/** Track values that scale from an ability mod (Bardic Inspiration uses) or
 *  proficiency bonus (Druid Wild Companion). Resolved at level-up and on stat
 *  changes — the resolver substitutes the live value. Used when a per-level
 *  array would be wrong because the value depends on the character's stats. */
export type ClassResourceFormula =
  | { kind: 'ability-mod'; ability: AbilityKey; min?: number }
  | { kind: 'proficiency-bonus'; min?: number }
  | { kind: 'class-level'; multiplier?: number; offset?: number };

/** Per-level class spellcasting metadata. The two discriminators
 *  (`slotTableKind`, `learnModel`) cover every shape the SRD ships:
 *
 *  | Class                      | slotTableKind | learnModel        | recovery   |
 *  |----------------------------|---------------|-------------------|------------|
 *  | Wizard                     | full          | spellbook         | long-rest  |
 *  | Cleric / Druid / Bard      | full          | from-class-list   | long-rest  |
 *  | Sorcerer                   | full          | known             | long-rest  |
 *  | Paladin / Ranger           | half          | from-class-list   | long-rest  |
 *  | Warlock                    | pact-magic    | known             | short-rest |
 *  | Fighter / Rogue / Barb /…  | none          | innate            | (n/a)      | */
export interface ClassSpellcasting {
  ability: AbilityKey;
  slotTableKind: 'full' | 'half' | 'pact-magic' | 'none';
  learnModel: 'spellbook' | 'from-class-list' | 'known' | 'innate';
  recovery?: 'long-rest' | 'short-rest';
  /** Cosmetic — what the caster channels through. */
  focus?: string[];
  /** "always-prepared" (Wizard Ritual Adept): ritual tag spells can be cast
   *  from spellbook without preparing. "ritual-only" (Cleric/Druid/Bard):
   *  ritual tag spells are cast normally, just slower. "none": no ritual rule. */
  ritual?: 'always-prepared' | 'ritual-only' | 'none';
  /** 20-element array. Index by `level - 1`. */
  cantripsKnownByLevel?: number[];
  /** 20-element array — number of L1+ spells the caster can hold prepared. */
  preparedSpellsByLevel?: number[];
  /** 20-element array — number of L1+ spells the caster permanently "knows"
   *  (Sorcerer / Warlock). Mutually exclusive with `preparedSpellsByLevel`. */
  spellsKnownByLevel?: number[];
  /** Outer index = level-1; inner = slot-level-1. For half-casters the inner
   *  array is shorter (5 entries). Omitted for `slotTableKind: 'none'` and
   *  `'pact-magic'` (use `pactMagic` block instead). */
  spellSlotsByLevel?: number[][];
  /** Warlock Pact Magic — few same-level slots that refresh on Short Rest. */
  pactMagic?: {
    /** Number of pact slots at each character level. */
    slotsByLevel: number[];
    /** Spell level of every pact slot at each character level. */
    slotLevelByLevel: number[];
  };
  /** Warlock Mystic Arcanum — one L6/7/8/9 spell unlocked at the listed
   *  levels, each used once per Long Rest, not a slot. */
  mysticArcanum?: {
    atLevels: number[];
    spellLevels: number[];
  };
  /** Wizard-only — starting spellbook size at L1. */
  initialSpellbookSize?: number;
  /** Wizard-only — spells added to the spellbook on each level after 1. */
  spellbookGrowthPerLevel?: number;
  /** Most full casters can swap one cantrip on a Long Rest / level-up. */
  cantripSwapPerLevel?: boolean;
  /** Per-level swap allowance for known/prepared lists (Sorcerer = 1, Bard L10
   *  Magical Secrets adds more on specific levels via choices). */
  spellSwapPerLevel?: number;
}

/** Authored choice template stored in class/subclass JSONs. At level-up the
 *  resolver expands each template into a fully-populated `LevelUpChoicePrompt`
 *  (filling in `options` from the live character + game defs). Keeping the
 *  templates separate from the runtime prompt keeps JSONs static and lets the
 *  options list change as content grows (new feats, new spells, etc.). */
export type LevelUpChoiceTemplate =
  | { kind: 'scholar-expertise' }
  | { kind: 'wizard-spellbook-add'; count?: number }
  | { kind: 'asi-or-feat' }
  | { kind: 'subclass-choice' }
  | { kind: 'cantrip-known'; count?: number }
  | { kind: 'cantrip-swap' }
  | { kind: 'spell-swap'; count?: number }
  | { kind: 'expertise-pick'; count: number }
  | { kind: 'fighting-style-pick' }
  | { kind: 'metamagic-pick'; count: number }
  | { kind: 'invocation-pick'; count: number }
  | { kind: 'mystic-arcanum-pick'; spellLevel: number }
  | { kind: 'magical-secrets-pick'; count: number }
  | { kind: 'epic-boon-choice' };

/** A single entry in `ClassDef.progression` — what happens when the character
 *  reaches the given level. Features list ids that must exist in
 *  `defs.features`. `choices` are templates the resolver expands into runtime
 *  prompts surfaced by the LevelUpOverlay; their kinds map to handlers in
 *  `LevelUpChoiceHandlers.ts`. `subclass: true` marks levels at which the
 *  chosen subclass's own progression entry should fire. */
export interface ClassProgressionEntry {
  level: number;
  features?: string[];
  subclass?: boolean;
  choices?: LevelUpChoiceTemplate[];
}

export interface ClassDef {
  id: string;
  name: string;
  description: string;
  primaryAbility: AbilityKey[];
  /** Hit Point Die (Wizard = 6, Fighter = 10, …). Used for HP rolls; the
   *  engine uses `fixedHpPerLevel` for level-up so this is informational. */
  hitDie: number;
  /** SRD "Fixed Hit Points by Class" — added to CON mod on each level-up. */
  fixedHpPerLevel: number;
  savingThrows: AbilityKey[];
  skillChoices: { count: number; options: string[] };
  weaponProficiencies: string[];
  armorTraining: string[];
  toolProficiencies: string[];
  /** Class levels at which the chosen subclass grants a feature. Mirrors
   *  the subclass's `progression[].level` values so the level-up resolver
   *  knows when to look up subclass content. */
  subclassLevels: number[];
  spellcasting?: ClassSpellcasting;
  /** Per-level scaling values — every count/die/distance that varies with
   *  level lives here. Keys are class-specific track ids (e.g.
   *  `"sneak-attack-dice"`, `"second-wind-uses"`, `"martial-arts-die"`,
   *  `"rage-damage"`, `"unarmored-movement-feet"`). Engine consumers read
   *  via `trackAt(classDef, trackId, level)`. */
  tracksByLevel?: Record<string, TrackValue[]>;
  /** Tracks whose value can't be encoded as a per-level array because they
   *  depend on the live character (Bardic Inspiration uses = max(1, CHA mod)). */
  trackFormulas?: Record<string, ClassResourceFormula>;
  progression: ClassProgressionEntry[];
}

/** A single per-level entry for a subclass. Mirrors `ClassProgressionEntry`
 *  but adds the always-prepared spell lists granted by Domains / Oaths /
 *  Circles / Patrons (which extend the prepared list without counting toward
 *  the prep cap). */
export interface SubclassProgressionEntry {
  level: number;
  features?: string[];
  /** Spells that become always-prepared once this level is reached. */
  grantedSpells?: string[];
  /** Cantrips that become permanently known once this level is reached. */
  grantedCantrips?: string[];
  /** Per-level tracks the subclass overrides or adds (e.g. an Eldritch
   *  Invocation-style scaling). */
  tracksByLevel?: Record<string, TrackValue[]>;
}

export interface SubclassDef {
  id: string;
  classId: string;
  name: string;
  description: string;
  progression: SubclassProgressionEntry[];
  /** Some subclasses graft spellcasting onto an otherwise-non-caster class
   *  (Eldritch Knight, Arcane Trickster). When present this block overrides
   *  the class's own `spellcasting` for affected characters. Not used by any
   *  SRD 5.2.1 subclass we ship today but the engine honours it. */
  spellcasting?: ClassSpellcasting;
  /** When this subclass uses a different class's spell list (Eldritch Knight
   *  → Wizard, Arcane Trickster → Wizard), name the source class. */
  spellListClassId?: string;
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
  /** Independent AOE rider that fires after the primary attack roll
   *  resolves, regardless of hit or miss. Used by spells that "explode"
   *  around the target (Ice Knife). Combined with `save` + `area` to
   *  resolve creatures within `area.sizeFeet` of the targeted tile. */
  secondaryDamage?: SpellDamage;
  /** SRD push effect applied on a failed save (Thunderwave). The creature
   *  is shoved this many feet directly away from the caster (or, for
   *  spells without a clear origin, from the AOE centre). */
  push?: { feet: number };
  /** Color Spray's HP-pool gating. The caster rolls this pool once at cast
   *  time; targets are sorted by current HP ascending and consume from the
   *  pool until exhausted. Targets whose HP exceeds the remaining total
   *  are skipped. Affected targets receive `effect.onFail` conditions. */
  hpPool?: { dice: number; sides: number };
  /** Chromatic Orb chain: when two damage dice match, the orb leaps to a
   *  second creature within this range. */
  chainOnDoubles?: { rangeFeet: number };
  /** False Life-style temporary HP grant. The roll happens at cast time and
   *  is applied via `awardTempHp` (uses-higher-value semantics). */
  tempHpRoll?: { dice: number; sides: number; bonus?: number };
  /** SRD True Strike: the spell makes one attack with the caster's
   *  currently-equipped weapon using their spellcasting ability mod for
   *  both attack and damage rolls. On hit, the damage type defaults to the
   *  weapon's, plus extra Radiant dice at character levels 5 (1d6), 11
   *  (2d6), and 17 (3d6). Mutually exclusive with the standard
   *  attack/damage path. */
  weaponAttack?: boolean;
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

// ── Encounter types ──────────────────────────────────────────────────────────

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
  /** Fires when a world flag is set via `set_flag` (or any other path that
   *  publishes `flag_set`). `name` matches a specific flag; omitting it fires
   *  on every flag write. `value` further filters by the assigned value. */
  | { event: 'flag_set'; name?: string; value?: WorldFlagValue }
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
  | { type: 'faction_standing'; factionId: string; op: ComparisonOp; value: number }
  /** True when the player's coin purse (in copper pieces — see
   *  `PlayerState.balanceCp`) satisfies the comparison. Use to gate
   *  conversation choices on whether the player can afford something. */
  | { type: 'balance_cp'; op: ComparisonOp; value: number };

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
  /**
   * Hide (or reveal) every NPC currently in the encounter whose `defId`
   * matches. When `hidden: true`, the NPC starts invisible to the player —
   * the client skips rendering the token and the AIGM combatant list omits
   * it.
   *
   * Reveal modes:
   *   • `'perception'` (default) — the NPC stays hidden until the player's
   *     passive Perception meets the NPC's `hideDC` on a movement-time
   *     sweep (line-of-sight respected via the Vision system). `hideDC`
   *     defaults to `10 + monsterDef.stealthBonus`. Use for stealth
   *     creatures and scrub ambushers where skill matters.
   *   • `'trigger'` — the NPC is invisible to passive Perception sweeps
   *     entirely; it is only revealed by an explicit `set_npc_hidden
   *     { hidden: false }` action. Use for narratively-locked reveals
   *     (the dead rise from their niches, the wall slides open) where
   *     no roll should be able to spoil the beat.
   */
  | { type: 'set_npc_hidden'; defId: string; hidden: boolean; hideDC?: number; revealedBy?: 'perception' | 'trigger' }
  /**
   * Mark every living NPC currently in the encounter whose `defId` matches
   * as dead. Sets `hp = 0`, applies the `dead` condition, and (optionally)
   * attaches a `corpseSearch` payload — when set, the player's SEARCH
   * action picks the corpse up as a one-shot Perception target while
   * adjacent. Authors use this for found-bodies-as-clues setups: spawn an
   * NPC at a tile, then mark the def dead on `encounter_started` with a
   * tailored success/failure pair. Idempotent: if the NPC is already dead,
   * only the optional `corpseSearch` payload is applied.
   *
   * `dropInventory` (default `true`) mirrors the normal `killNpc` path —
   * the NPC's `inventoryIds` become map items at their tile. Set to
   * `false` for found bodies whose gear should NOT scatter (Vael's
   * licence-seal stays on his person, surfaced via `corpseSearch`).
   */
  | { type: 'set_npc_dead'; defId: string; corpseSearch?: { dc: number; successText: string; failureText: string }; dropInventory?: boolean }
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
  | { type: 'fade_screen'; mode: 'in' | 'out' | 'dim'; durationMs?: number }
  /** Toggle the encounter's `allowsLongRest` flag at runtime. Maps the
   *  `LONG REST` Player Panel action to either available or hidden — useful
   *  for "you've reached the inn" beats where the room becomes restable
   *  partway through the encounter, or for revoking a rest privilege when
   *  the situation turns hostile. Idempotent. */
  | { type: 'set_long_rest'; allowed: boolean }
  /** Add (positive) or deduct (negative) copper from the player's coin
   *  purse. Mirrors the AIGM `award_coins` tool. When `deltaCp` is negative
   *  and the player can't pay, the action becomes a no-op AND logs a
   *  configurable refusal message — gate on `balance_cp` upstream when the
   *  conversation needs to branch on the affordance. */
  | { type: 'adjust_player_balance_cp'; deltaCp: number; reason?: string }
  // ── Conversation system ────────────────────────────────────────────────
  /** Open a conversation. `npcRef` resolves to a live NPC instance (`npc_<id>`
   *  or a combat-label ref); `conversationId` defaults to that NPC's
   *  `NPCDef.conversationId` when omitted. No-op when another conversation
   *  is already active or the ref doesn't resolve. */
  | { type: 'start_conversation'; npcRef: string; conversationId?: string }
  /** Close the active conversation. No-op when none is open. Flushes the
   *  participating persistent NPCs' saves so the transcript persists. */
  | { type: 'end_conversation' }
  /** Jump the active conversation to a different node. Used by AIGM
   *  `set_conversation_node` tool calls + by author scripting to splice in
   *  an event mid-dialogue. No-op when no conversation is active or the
   *  node id doesn't exist. */
  | { type: 'set_conversation_node'; nodeId: string }
  // ── NPC persistence (writes to NpcSave) ────────────────────────────────
  /** Record a structured fact on the named NPC's save. `ref` accepts
   *  `"self"` (resolves to the speaker of the current conversation node),
   *  `npc_<id>`, or a combat-label ref. `value` defaults to `true`.
   *  No-op when the target NPC isn't persistent. */
  | { type: 'npc_remember'; ref: string; fact: string; value?: NpcFactValue; source?: 'authored' | 'aigm' | 'witness' | 'system' }
  /** Forget a previously-recorded fact. Rare — memory-wipe magic, retcons,
   *  AIGM corrections. */
  | { type: 'npc_forget'; ref: string; fact: string }
  /** Adjust an NPC's relationship axis with `target` by `delta` (clamped
   *  ±100). `target` is an entity ref — `"party"` for the player or
   *  `npc_<id>` for inter-NPC standings. `axis` defaults to `"party"`
   *  (the base relationship) — `"trust"` / `"respect"` reserved for the
   *  three-axis expansion. */
  | { type: 'npc_adjust_relationship'; ref: string; target: string; delta: number; axis?: 'party' | 'trust' | 'respect' }
  /** Append a free-form journal line to the NPC's save. Capacity-limited;
   *  the lowest-salience oldest entry is evicted when full. */
  | { type: 'npc_record_journal'; ref: string; text: string; salience?: 1 | 2 | 3; source?: 'authored' | 'aigm' | 'witness' | 'system' }
  /** Advance the NPC's personal-arc phase. */
  | { type: 'npc_set_arc_phase'; ref: string; phase: string };

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
  /** Optional AI Game Master context — backstory, factions, themes, plot
   *  hooks. Surfaced into the AIGM prompt for every encounter played as part
   *  of this adventure so the GM keeps cross-chapter narrative coherence. */
  aiContext?: string;
  /** Optional rest encounter id — the inn / campsite the player can return
   *  to between chapters when they pick REST. Resolves against the same
   *  encounters/ pool as chapters. */
  restEncounterId?: string;
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
  /** Rest-stop interlude state. When set, the player is mid-rest at the
   *  adventure's `restEncounterId`, sitting between `currentChapterIndex - 1`
   *  (just completed) and `currentChapterIndex` (queued). The next `/advance`
   *  call clears this and proceeds with the normal chapter-advance routing
   *  rather than offering rest again. Absent/null = not in rest. */
  inRest?: boolean;
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
  /** Coin purse balance in Copper Pieces. SRD: 1 PP = 1000 CP, 1 GP = 100
   *  CP, 1 SP = 10 CP. Display via `formatCoins` from `shared/currency.ts`. */
  balanceCp: number;
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
  /** Warlock Pact Magic — slots that recover on Short Rest. `level` is the
   *  spell-slot level every pact slot casts at (1 → 5). Absent for
   *  non-Warlocks. Distinct from `spellSlots` because the recovery rule and
   *  upcast semantics differ. */
  pactMagic?: { remaining: number; max: number; level: number };
  /** Warlock Mystic Arcanum — one L6/7/8/9 spell per slot, used once per
   *  Long Rest. Maps spell level → { spellId, used }. Absent for everyone
   *  else. The picker is fired from the LevelUpOverlay (`mystic-arcanum-pick`
   *  prompt) at L11/13/15/17. */
  mysticArcanum?: Record<number, { spellId: string; used: boolean }>;
  /** Currently prepared spell ids (mutable across Long Rests). */
  preparedSpellIds: string[];
  /** Spell currently concentrated on, or null. Cleared by damage CON save, casting another concentration spell, or incapacitation. */
  concentratingOn: string | null;
  /** Flag set by Mage Armor — `applyEquipment`-equivalent uses base AC 13 + DEX while no armor is worn. */
  mageArmor: boolean;
  /** True while the Shield reaction's +5 AC bonus is active — set when the
   *  reaction resolves with "accept", cleared at the start of the player's
   *  next turn. While set, `computeAC` adds 5 to the rolled AC so the
   *  triggering attack AND any further attack that lands before the
   *  start-of-turn reset both see the bonus per SRD wording. */
  shieldActive: boolean;
  /** Flat movement bonus in feet applied by self-buff spells (Longstrider).
   *  Added to base `playerDef.speed` when computing tile movement at the
   *  start of each player turn. Cleared on long rest. */
  speedBonus: number;
  /** Set true by Expeditious Retreat; while active, the player may take the
   *  Dash action as a bonus action and receives the upfront Dash on the
   *  casting turn. Cleared when concentration on the spell ends. */
  expeditiousRetreat: boolean;
  /** Multiplier on jump distance set by Jump (×3). Defaults to 1. */
  jumpMultiplier: number;
  /** SRD Sneak Attack — "Once per turn". Flag flips when the rider fires
   *  and resets at the start of the player's next turn. Reset is also
   *  implicit at combat start (every player turn boundary). */
  sneakAttackUsedThisTurn?: boolean;
  /** SRD Arcane Recovery — once per Long Rest. Set when the wizard uses the
   *  Short Rest recovery; cleared by `applyLongRest`. Wizard-only — absent
   *  on non-wizards. */
  arcaneRecoveryUsed?: boolean;
  /** Currently active periodic effects (DoTs, attach bites, …). Each fires at the start of its `sourceNpcId`'s turn — see OngoingEffectsSystem. */
  ongoingEffects: OngoingEffect[];
}

export interface AvailableActions {
  canAttack: boolean;
  throwableItemIds: string[];
  canHide: boolean;
  /** True when the player can take the SEARCH action right now — always available
   *  during exploration (no action economy); during combat, gated on the player
   *  having an Action to spend (Search costs the full Action per SRD). */
  canSearch: boolean;
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
    }
  | {
      kind: 'subclass-choice';
      label: string;
      description: string;
      /** Subclasses authored for the character's class, with their description
       *  surfaced so the picker can preview the playstyle. */
      options: Array<{ id: string; name: string; description: string }>;
    }
  | {
      kind: 'asi-or-feat';
      label: string;
      description: string;
      /** Feats the character is eligible for at this level (filtered server-
       *  side; the picker UI shows id+name+description). */
      featOptions: Array<{ id: string; name: string; description: string }>;
      /** Ability scores the player may increase, with the current value of
       *  each so the picker can grey out anything already at 20. */
      abilityScores: Array<{ key: AbilityKey; current: number }>;
    }
  | {
      kind: 'expertise-pick';
      label: string;
      description: string;
      /** Skill ids the player is currently proficient in (so Expertise can
       *  stack PB on them). Computed server-side from the character's
       *  pre-baked skill totals vs ability mod. */
      options: string[];
      /** How many skills the player must promote to Expertise (Rogue L1 / L6
       *  both grant 2). */
      count: number;
    }
  | {
      kind: 'fighting-style-pick';
      label: string;
      description: string;
      /** Fighting Style feat ids the player may take. Excludes any the
       *  character already has — Fighting Style can be swapped on later
       *  level-up but not duplicated. */
      options: Array<{ id: string; name: string; description: string }>;
    };

/** Player-supplied answers to a `LevelUpPreview`. Each chosen value matches
 *  its prompt's `kind`. Optional because not every level surfaces every
 *  prompt — the engine validates that every prompt the preview surfaces
 *  has a matching answer. */
export interface LevelUpChoices {
  scholarExpertise?: string;
  wizardSpellbookAdd?: string[];
  /** Subclass id picked at L3 (or whenever the parent class fires its
   *  `subclass-choice` template). Stored on `playerDef.subclassId` by the
   *  handler so subclass progression entries fire on subsequent levels. */
  subclassChoice?: string;
  /** Answer to the ASI-or-Feat prompt (every L4 / L8 / L12 / L16, plus
   *  Fighter L6 / L14 and class-19 boons). One of three shapes:
   *  - `{ kind: 'asi-plus-2', ability }` — +2 to a single ability (max 20).
   *  - `{ kind: 'asi-plus-1', abilities: [a, b] }` — +1 to two abilities.
   *  - `{ kind: 'feat', featId }` — take a feat instead of an ASI. */
  asiOrFeat?:
    | { kind: 'asi-plus-2'; ability: AbilityKey }
    | { kind: 'asi-plus-1'; abilities: [AbilityKey, AbilityKey] }
    | { kind: 'feat'; featId: string };
  /** Rogue Expertise picks. The handler stacks PB on each named skill so the
   *  total = ability mod + 2 * PB after this level-up. */
  expertisePick?: string[];
  /** Fighting Style feat id chosen at Fighter L1 or any later level-up that
   *  surfaces the prompt (Champion L7 Additional Fighting Style). */
  fightingStylePick?: string;
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
  /** When true, the passive Perception movement-sweep skips this NPC
   *  entirely — they can only be revealed by an explicit
   *  `set_npc_hidden { hidden: false }` action. Used by encounter authors
   *  for narrative reveals (the dead rising, a wall sliding open) where
   *  no roll should be able to surface the creature early. Set via the
   *  `set_npc_hidden` action with `revealedBy: 'trigger'`. */
  revealedByTrigger?: boolean;
  /** Last tile the player observed this NPC on. Set whenever `Vision.canSee`
   *  reports the player saw this creature. Used by the client to render the
   *  NPC's last-known position as a faded ghost when the player loses sight
   *  (SRD "out of sight, not out of mind"). Cleared when the player sees
   *  the creature again at its current tile. */
  lastSeenTile?: { x: number; y: number };
  /** Authored payload that turns this NPC's corpse into a one-shot search
   *  target — picked up by the player's SEARCH action when adjacent. The
   *  Perception roll is opposed by `dc`; the success / failure branches
   *  emit their texts to the Event Log. Single-use: the payload is cleared
   *  after the first resolution so a second search just reports "nothing
   *  found". Attached at spawn time via the `set_npc_dead` trigger action,
   *  so any encounter can author corpse-bound clues / loot prompts without
   *  engine code changes. */
  corpseSearch?: { dc: number; successText: string; failureText: string };
  /** Set true once the deterministic SEARCH action has resolved this
   *  corpse (regardless of pass/fail). The AIGM reads this flag in the
   *  CURRENT STATE corpses section: when true, the GM must NOT roll a
   *  second Perception check on this body — the engine already wrote
   *  the outcome to the Event Log. Stays true for the rest of the
   *  encounter. */
  corpseSearched?: boolean;
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
  /** Player-facing one-line goal for this encounter. */
  objective: string;
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
  /** Active conversation when one is open — `null` otherwise. The client
   *  renders the ConversationOverlay whenever this transitions non-null.
   *  Pauses world tick (`isWorldTickEligible` skips when set). */
  activeConversation: ActiveConversation | null;
  /** True when an `encounter_started` combat trigger fired during session
   *  construction and the engine deferred `advanceTurn` so the player has
   *  a chance to see the intro overlay / announcement before NPC turns
   *  run. Consumed by `GameEngine.runPendingTurnAdvance()` once the client
   *  signals readiness by releasing the world pause. */
  pendingTurnAdvance?: boolean;
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
  encounterComplete: boolean;
  /** Optional world-flag name that, when set, marks the encounter complete. Mirrors `EncounterDef.completionFlag` for standalone (non-adventure) encounters so the `encounter_completed` engine event can fire on flag-driven resolutions. */
  encounterCompletionFlag?: string;
  /** Environmental flags consulted by combat resolvers — sourced from EncounterDef.environment at session creation. */
  environment: EncounterEnvironment;
  /** Dev-mode overrides for the active session, copied from the
   *  `CreateSessionRequest` at session boot. Engine consumers consult these
   *  on every state push (see `GameEngine.getState`) to keep resources
   *  "topped up" so the player can test freely without rerunning encounters. */
  devFlags?: DevFlags;
}

/**
 * Dev-mode session overrides. Set via the Configuration scene's
 * "Development Mode" section. Persisted in the browser's localStorage and
 * spliced into every `CreateSessionRequest`. Intended for testing — disabled
 * by default in any normal play session. See `client/src/devMode.ts`.
 */
export interface DevFlags {
  /** Skip the IntroductionOverlay supertitle at encounter start. The intro
   *  text is still pushed to the GM chat so the narrative record is intact.
   *  Client-only — server ignores this field. */
  disableSupertitle?: boolean;
  /** Spell slots are refilled to their max on every server state push, so
   *  casting never decrements the visible slot counter. */
  unlimitedSpellSlots?: boolean;
  /** At session creation the player's `preparedSpellIds` is seeded with
   *  every spell in the game (cantrips + leveled), and Wizards additionally
   *  receive every spell in their spellbook. Lets the tester invoke any
   *  spell without a level-up rebuild. */
  unlockAllSpells?: boolean;
  /** `actionUsed` and `bonusActionUsed` are reset to `false` on every server
   *  state push, so a tester can spam attacks/spells in combat without
   *  ending their turn. */
  unlimitedActions?: boolean;
  /** Show the DELETE SAVE button on the character setup detail panel. Off by
   *  default so non-developers can't accidentally wipe a character's progress.
   *  Client-only — server ignores this field. */
  showDeleteSaveButton?: boolean;
  /** Allow the player to retry a failed (or already-attempted) conversation
   *  ability check. When OFF (default) the server rejects a second attempt
   *  on the same `node#choiceIndex` and the client hides the choice. When
   *  ON the choice remains clickable and the overlay flags it with a
   *  `[DEV]` tag so the player knows the option is only reachable because
   *  the dev override is active. */
  allowRetryChecks?: boolean;
  /** Surfaces a "★ COMPLETE OBJECTIVE" button on the Player Panel that
   *  fires the encounter's completion path (sets the `completionFlag` if
   *  one is authored, or ends combat by clearing every enemy) so a tester
   *  can blast through adventures without playing them out. Off by
   *  default. */
  completePrimaryObjective?: boolean;
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
  /** True when this session is the adventure's rest-stop interlude rather
   *  than an actual chapter. The client uses it to label the HUD and to
   *  route LEAVE ENCOUNTER through `/adventure/.../advance` rather than back
   *  to the setup screen — leaving rest means "I'm done, take me to the
   *  next chapter". */
  isRestSession?: boolean;
  /** Id of the adventure's optional rest-stop encounter. Mirrored from
   *  `AdventureDef.restEncounterId` so the client can decide whether to
   *  surface the "rest first?" prompt between chapters without having to
   *  fetch the full adventure registry. */
  restEncounterId?: string;
  /** Display title of the rest encounter (when `restEncounterId` is set).
   *  Used as the prompt's body so the player knows what they're walking
   *  into ("Drop in at the Sparrow's Nest before the next chapter?"). */
  restEncounterTitle?: string;
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
  /** Whether the triggering attack was a critical hit. Shield's +5 AC
   *  cannot convert a crit into a miss (crits ignore AC), but the player
   *  may still want to spend the reaction for the +5 / no-Magic-Missile
   *  buff over the rest of the round — so the prompt fires either way. */
  isCrit?: boolean;
}

export type PendingReaction = PendingReactionOA | PendingReactionShield;

// ── Animation events ─────────────────────────────────────────────────────────

export type GameEvent =
  | { type: 'entity_move'; entityId: string; toX: number; toY: number }
  | { type: 'log'; lines: string[] }
  /** Show a speech-bubble above the named entity for a few seconds. Pushed by
   *  the AIGM `npc_speaks` tool (and future trigger actions); the client
   *  resolves the entity ref (`player` / `enemy_A` / `npc_<id>`) to a token
   *  position and renders an absolutely-positioned bubble. `speakerName` is
   *  the display name as the player knows it (revealed name when set,
   *  otherwise the def's generic label) so the client can also mirror the
   *  line into the GM chat as a scrollable record of the conversation. */
  | { type: 'npc_speech'; entityId: string; text: string; speakerName: string }
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
  /** Voluntarily drop the spell currently in `PlayerState.concentratingOn`.
   *  No action cost per SRD. Strips any conditions the spell applied and
   *  clears self-buff flags it set. No-op when not concentrating. */
  | { type: 'releaseConcentration' }
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
  | { type: 'scrollLog'; delta: number }
  // ── Conversation system ─────────────────────────────────────────────
  /** Open a conversation with the named NPC. `npcRef` is a runtime entity
   *  ref (`npc_<id>` or a combat-label ref). `conversationId` defaults to
   *  the NPC's `NPCDef.conversationId` when omitted. */
  | { type: 'startConversation'; npcRef: EntityRef; conversationId?: string }
  /** Advance the active conversation by selecting the choice at the given
   *  index in the current node's choice list. */
  | { type: 'conversationChoice'; choiceIndex: number }
  /** Close the active conversation (cancel / × / "Goodbye"). */
  | { type: 'conversationEnd' }
  /** Dev-mode shortcut — completes the current encounter so the tester can
   *  fast-forward through an adventure. Server-side this sets the
   *  encounter's `completionFlag` (when authored) AND clears every living
   *  enemy so the combat-end path fires too; clients should only send it
   *  when `devFlags.completePrimaryObjective` is on. */
  | { type: 'devCompleteEncounter' };

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
  /** Mirrors `EncounterDef.placementMode` — see that field for the rules. */
  placementMode?: 'zones' | 'exact';
  /** Mirrors `EncounterDef.placements`. */
  placements?: EncounterPlacement[];
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
  resumeCp?: number;
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
  /** Dev-mode session overrides — see `DevFlags`. Copied straight onto
   *  `GameState.devFlags` at session boot; `unlockAllSpells` is consumed
   *  at boot to seed `preparedSpellIds`/`defaultSpellbookIds`. */
  devFlags?: DevFlags;
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
  /** Net change in the player's coin purse over this encounter, in CP. */
  cpGained: number;
  outcome: 'survived' | 'defeated';
  lines: EncounterLogLine[];
}

export interface StorylogEntry {
  encounterId: string;
  narrative: string;
}
