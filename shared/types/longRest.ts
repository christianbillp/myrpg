/**
 * Long Rest preview + choices.
 *
 * Extracted from the original god-file `shared/types.ts` (now a barrel that
 * re-exports every domain module under `shared/types/`).
 */

// Cross-domain imports — keep these explicit so the dependency graph is visible.
import type { AdventureChapter, AdventureDef } from "./adventures.js";
import type { LogEntry } from "./combatLog.js";
import type { ActiveConversation } from "./conversation.js";
import type { EncounterDef, EncounterEnvironment, EncounterTileProperty, MapTilesetInfo, SecretDef } from "./encounter.js";
import type { WorldFlagValue } from "./engineEvents.js";
import type { Attitude, CreatureSize, NPCDef, OngoingEffect } from "./entities.js";
import type { ActiveBuff } from "./gameState.js";
import type { PLAYER_FACTION_ID, Rumor } from "./factions.js";
import type { AvailableActions, CombatMode, Disposition, PlayerState } from "./gameState.js";
import type { PlayerAction } from "./playerActions.js";
import type { PendingReaction, PendingReroll, PendingCombatStart } from "./reaction.js";
import type { CreateSessionRequest } from "./session.js";
import type { EncounterTrigger } from "./triggers.js";

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
  /** Living companions that benefit from the rest (HP restored to full and any
   *  rest-clearable conditions removed). One entry per companion with something
   *  to gain — surfaced on the Long Rest screen so the player sees the party
   *  rest, not just themselves. */
  companionsRestored?: Array<{ id: string; name: string; hpRestored: number; conditionsCleared: string[] }>;
  /** Prepared-spell picker state for prepare-casters (Wizard rebuilds from the
   *  spellbook; Cleric and other `from-class-list` casters rebuild from the
   *  whole class list of castable level). Omitted for non-preparing classes. */
  spellPrep?: {
    /** The pool the player may prepare from — the spellbook (Wizard) or the
     *  full class list of castable level (Cleric). Field name kept for the
     *  client's renderer; not literally a spellbook for `from-class-list`. */
    spellbookSpells: Array<{ id: string; name: string; level: number; school: string }>;
    /** Currently prepared ids. The client seeds the picker with these. */
    currentlyPrepared: string[];
    /** Maximum allowed prepared spells (SRD class Features table, or higher when feats grant extras). */
    maxPrepared: number;
    /** Where the pool comes from, so the client can word the help text. */
    source: 'spellbook' | 'class-list';
  };
}

/** Player-supplied answers to the long-rest preview. Prepare-casters pass their chosen prepared-spell list. */
export interface LongRestChoices {
  preparedSpellPicks?: string[];
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
  /**
   * Live social attitude (US-092). Seeded from `NPCDef.attitude` at spawn;
   * default `'indifferent'`. Mutable via AIGM `set_attitude` and the
   * `set_npc_attitude` trigger action. Charm Person sets it to
   * `'friendly'` while the spell is active and restores the prior value
   * on spell end (`attitudePreCharm`).
   */
  attitude: Attitude;
  /** Captured attitude prior to a Charm-induced friendly override, so the
   *  pre-cast attitude can be restored when the spell ends. */
  attitudePreCharm?: Attitude;
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
  /** Slot level the summon was cast at — carries upcast scaling to a
   *  summon's recurring effect (Spiritual Weapon: +1d8 force per slot above
   *  2). Absent for summons whose effect doesn't scale. */
  summonSlotLevel?: number;
  hp: number;
  maxHp: number;
  /** Temporary HP pool (US-109) — a buffer that absorbs damage before real HP.
   *  Absent/0 means none. Lost at the end of a Long Rest. Mirrors
   *  `PlayerState.tempHp`; nothing grants it to NPCs yet, but the damage path
   *  honours it so future temp-HP sources (e.g. False Life on a companion)
   *  work without further wiring. */
  tempHp?: number;
  /** SRD creature size (US-107), seeded at spawn from the resolved `MonsterDef`.
   *  Read by size-gated rules (Grapple/Shove eligibility, Squeezing). Optional
   *  so saves written before US-107 load without migration (default `'medium'`). */
  size?: CreatureSize;
  isActive: boolean;
  reactionUsed: boolean;
  conditions: string[];
  /** Active buffs this creature carries (e.g. Invisibility cast on it by the
   *  player). Creature-agnostic — the same `ActiveBuff` shape the player uses.
   *  Cleaned up generically by `endConcentration` when the source spell ends. */
  activeBuffs?: ActiveBuff[];
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
  corpseSearch?: { dc: number; successText: string; failureText: string; rewardItemId?: string };
  /** When true, this NPC (typically a corpse — the `hidden` condition is
   *  living-only) is withheld from the client until the player has line of
   *  sight to it. The passive-perception sweep flips `seen` true the first
   *  time `canSee` reaches it; once seen it stays rendered. */
  hiddenUntilSeen?: boolean;
  /** Set true once the player has had line of sight to a `hiddenUntilSeen`
   *  NPC. Sticky. The client renders the NPC only when this is true. */
  seen?: boolean;
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
  /** Effective conversation graph id for the player's TALK button.
   *  Resolved at spawn time from the encounter's
   *  `conversationOverrides[defId]` first, then `NPCDef.conversationId`.
   *  Letting the same NPC carry different conversations across
   *  encounters (e.g. Vask defaults to no chat in the field but opens
   *  `bureau_office_chat` when spawned in the bureau hub). */
  conversationId?: string;
  /** Companion state — present only on NPCs the player has explicit command
   *  over. Drives the COMPANION chip in the Player Panel + opts this NPC
   *  into the `NpcTickRunner` exploration loop. Absent on every other NPC. */
  companion?: CompanionState;
  /** Per-NPC daily routine — when present, the world tick consults this
   *  to pick a task each phase. Authored on `NPCDef.routine` and seeded
   *  onto every spawned instance at session create time. Companions ignore
   *  their routine while a player override is active. */
  routine?: RoutineEntry[];
  /** Per-NPC sim-runner state. Used by routine-bearing AND companion NPCs
   *  so the tick runner can resume an in-flight task across save/load.
   *  Companions hold this on `companion.simState`; ambient NPCs hold it
   *  here. Both paths feed the same runner. */
  simState?: { activeTaskId: string | null; lastTickId: number };
  /** Awareness state — sim NPCs read this each tick to decide whether
   *  to override their routine with `InvestigateTask` / `AlertTask`.
   *  Absent on NPCs the sim doesn't tick (combatants in combat phase,
   *  summons, etc.). Defaults to `calm` when an NPC enters the sim
   *  loop and they have no prior alert. */
  alertness?: NpcAlertness;
  /** Most-recent stimulus the NPC remembers. Drives the alertness chip
   *  on the target panel and the InvestigateTask's walk target. */
  memory?: NpcMemory;
}

/**
 * Per-companion runtime state. Held on the `NpcState` so it persists
 * naturally through the existing save layer. The fields here cover step
 * 2 of the sim plan (exploration follower); combat + autoCast will
 * extend this in step 3.
 */
export interface CompanionState {
  /** Default follow mode when no other command is active. */
  followMode: 'tight' | 'loose';
  /** Player-issued override that takes priority over autonomous selection.
   *  Cleared when the override's task finishes naturally; the next tick
   *  falls back to the autonomous scorer. */
  override?: CompanionCommand;
  /** Persistent runtime state the tick runner owns across ticks. */
  simState: { activeTaskId: string | null; lastTickId: number };
}

/** Player-issued command for a companion. Step 2 supports `follow` and
 *  `wait`; `attack` and `cast` ship with step 3. `move_to` (step 6) lets
 *  the player direct the companion to a specific tile — useful for set
 *  positioning before a fight or unsticking a companion that's pathed
 *  itself into a chokepoint. Cleared once the destination tile is
 *  reached; the companion then falls back to autonomous follow. */
export type CompanionCommand =
  | { kind: 'follow'; mode: 'tight' | 'loose' }
  | { kind: 'wait' }
  | { kind: 'attack'; targetId: string }
  | { kind: 'cast'; spellId: string; targetId?: string }
  | { kind: 'move_to'; tileX: number; tileY: number };

/** Coarse-grained day phase the world tick advances. Routine entries are
 *  keyed by phase, so a tavern keeper's `morning` row activates when the
 *  world rolls into morning and runs until noon. */
export type DayPhase = 'morning' | 'noon' | 'evening' | 'night';

/** NPC awareness state.
 *
 *   • `calm`       — default. Follows routine. Default-RAM 0.
 *   • `suspicious` — heard / saw something out of place. Pauses routine to
 *     glance toward last alert tile. Decays back to `calm` over a few
 *     ticks unless re-alerted.
 *   • `alert`      — something hostile is happening. Walks toward last
 *     alert tile aggressively. Becomes combat-ready if a hostile is
 *     visible. Decays to `suspicious` then `calm` unless renewed.
 *
 * Drives the InvestigateTask / AlertTask priority bands so an alerted NPC
 * outranks their routine without code-level special-casing.
 */
export type NpcAlertness = 'calm' | 'suspicious' | 'alert';

/** Decay schedule — ticks an NPC stays in each non-calm state before
 *  dropping a level when no new alert renews it. Tuned in one place so
 *  the worldtick decay loop and the awareness pass agree. */
export const ALERT_DECAY_TICKS: Readonly<Record<Exclude<NpcAlertness, 'calm'>, number>> = {
  alert: 15,        // ~90 sim-seconds of alertness before fading to suspicious
  suspicious: 25,   // ~150 sim-seconds of looking around before going calm
};

/** Per-NPC memory of the most recent stimulus. Slim today — extends in
 *  awareness step 6+ as we model "remembers seeing the player here on
 *  tick X" and "knows faction Y attacked us last morning." */
export interface NpcMemory {
  /** Most recent tick when this NPC was alerted (any source). */
  lastAlertTick?: number;
  /** Tile the alert pointed at — combat origin, noise source, sight
   *  contact. Drives the InvestigateTask's walk target. */
  lastAlertTile?: { x: number; y: number };
  /** Entity that triggered the alert: `'player'`, an `npc.id`, or
   *  `'unknown'` for ambient sources (a Thunderwave with no clear
   *  origin tile). Used by the target panel chip to say "noticed
   *  Grim Cohort" etc. */
  lastAlertSource?: string;
  /** What kind of stimulus alerted them. Drives narration + decay rate.
   *   • `combat`  — a fight kicked off nearby.
   *   • `noise`   — a loud sound (spellcast, casted spell, breaking glass).
   *   • `sight`   — they saw a hostile.
   *   • `faction` — a same-faction member pinged them. */
  lastAlertKind?: 'combat' | 'noise' | 'sight' | 'faction';
}

/** Ordered cycle the world tick advances through. */
export const DAY_PHASE_CYCLE: readonly DayPhase[] = ['morning', 'noon', 'evening', 'night'] as const;

/** How many world ticks fit in one day phase. 60 ticks × 6 sim-seconds per
 *  tick ≈ 6 real minutes per phase ≈ 24 real minutes per day. Tune in one
 *  place; every routine consumer reads from here. */
export const TICKS_PER_DAY_PHASE = 60;

/** One row in an NPC's routine. The first entry whose `phase` matches the
 *  current day phase wins; the rest are evaluated each phase boundary as
 *  the cycle advances. */
export interface RoutineEntry {
  phase: DayPhase;
  /** What the NPC tries to do during this phase. Atomic task kinds for
   *  step 5: `walk_to` (move to a tile and stay) and `idle` (stay put).
   *  Larger vocabulary (`patrol`, `talk_to`, `use_object`) ships with
   *  awareness in step 6. */
  task:
    | { kind: 'walk_to'; tileX: number; tileY: number }
    | { kind: 'idle' };
  /** Optional one-liner the NPC can drop into the log when this entry
   *  activates ("the keeper sweeps the bar"). Off by default to avoid
   *  spamming the event log every phase change. */
  flavour?: string;
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
  /** Per-tile movement blocking. `blocksMovement[y][x] === true` means the
   *  tile cannot be walked onto (wall, tree, chasm). Baked at session-build
   *  from each tile's `blocksMovement` flag (object-overrides-terrain). */
  blocksMovement: boolean[][];
  /** Per-tile sight blocking. `blocksSight[y][x] === true` means line-of-sight
   *  cannot pass through the tile. Baked from each tile's `blocksSight` flag,
   *  ORing the ground and object features so either one blocks the cell. */
  blocksSight: boolean[][];
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

/**
 * A persistent area-of-effect zone on the map (Fog Cloud, Web, Darkness,
 * Grease, Silent Image, …). Created by spells that author an `area` plus a
 * duration; lifetime decoupled from concentration so the visible zone stays
 * up until `roundsRemaining` hits zero. Rendered on the client as a
 * shape-appropriate tile overlay; consulted by the engine for re-tag-on-
 * enter behaviour as future spells land.
 */
export interface ActiveZone {
  id: string;
  spellId: string;
  /** Display label rendered on the map (e.g. "Fog Cloud", "Web"). */
  name: string;
  shape: 'sphere' | 'cube' | 'cone' | 'line';
  sizeFeet: number;
  /** Anchor tile — center for sphere/cube, origin for cone/line. */
  originX: number;
  originY: number;
  /** For cone/line shapes: the tile the area points toward (lets the client
   *  re-derive orientation without re-running the shape sweep). */
  targetX?: number;
  targetY?: number;
  /** Pre-computed list of tiles the zone covers. The client renders these
   *  directly; the engine reads them for in-zone checks without re-running
   *  `creaturesInArea`. */
  tiles: Array<[number, number]>;
  /** Engine condition applied to creatures in the zone (heavily-obscured,
   *  restrained, …). Absent for purely visual zones (illusions, gust). */
  condition?: string;
  /** Re-tag-on-enter save (Web): when a creature enters the zone on a turn
   *  or starts its turn there, it rolls `ability` vs `dc`; on a failed save
   *  the zone's `condition` is applied. Absent for auto-tag zones (Fog
   *  Cloud — heavily-obscured applies on entry without a save). */
  enterSave?: { ability: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'; dc: number };
  /** Flat damage dealt on a failed `enterSave` (deployed caltrops: 1
   *  Piercing). Applied in addition to `condition`. Absent for non-damaging
   *  zones. */
  enterDamage?: { amount: number; type: string };
  /** True when the zone's tiles are Difficult Terrain (Web, Spike Growth,
   *  Plant Growth, Sleet Storm). Movement consumed by a tile inside the
   *  zone is doubled for the moving creature. */
  difficultTerrain?: boolean;
  /** Ids of NPCs the zone has applied its `condition` to. Used at zone end
   *  to reliably strip the condition even if the creature has since been
   *  pushed / teleported outside the original tile set. */
  affectedNpcIds: string[];
  /** True when the zone has applied its condition to the player. */
  affectedPlayer: boolean;
  /** Rounds left until expiry. Decremented at end of each round; zone is
   *  removed (and `condition` stripped from any creature still inside)
   *  when this reaches 0. */
  roundsRemaining: number;
  /** Caster id — `'player'` or an NPC id. Used by re-cast / Dispel paths. */
  casterId: string;
  /** Visual tint colour (CSS hex). The client falls back to a default if
   *  absent. Lets each spell pick its own atmosphere — fog grey, web white,
   *  darkness near-black. */
  tintHex?: string;
  /** Slot level the zone was cast at — carries upcast scaling to the
   *  recurring per-turn effect (Spirit Guardians: +1d8 radiant per slot
   *  above 3). Absent for zones whose effect doesn't scale. */
  castSlotLevel?: number;
}

/**
 * A first-class trap placed on a tile. Distinct from area-denial gear zones
 * (those are `ActiveZone`s): a trap is a single concealed hazard that must be
 * spotted (Perception vs `detectDC`), disarmed (Dexterity / Sleight of Hand
 * with Thieves' Tools vs `disarmDC`, SRD default 15), or it springs when a
 * creature steps on its tile — rolling `trigger.saveAbility` vs `trigger.saveDC`
 * for damage (half on save when `halfOnSave`) and an optional `condition`.
 *
 * SRD basis: detecting/understanding traps is Intelligence (Investigation) /
 * Wisdom (Perception); disarming a trap with Thieves' Tools is a DC 15
 * Dexterity (Sleight of Hand) check (Tools.md, Rogue L1).
 */
export interface TrapState {
  id: string;
  name: string;
  tileX: number;
  tileY: number;
  /** False once disarmed or sprung — an inert trap never triggers again. */
  armed: boolean;
  /** False while concealed; flips true once detected (passive or Search). */
  discovered: boolean;
  /** Passive/active Perception needed to notice the trap. */
  detectDC: number;
  /** Dexterity (Sleight of Hand) DC to disarm with Thieves' Tools (SRD 15). */
  disarmDC: number;
  trigger: TrapTrigger;
  /** One-line flavour shown when the trap springs. */
  triggeredMessage?: string;
  /** Visual tint (CSS hex) for the map marker; falls back to a default. */
  tintHex?: string;
}

export interface TrapTrigger {
  saveAbility: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';
  saveDC: number;
  damageDice: number;
  damageSides: number;
  damageBonus: number;
  damageType: string;
  /** Half damage on a successful save (SRD trap convention). */
  halfOnSave: boolean;
  /** Condition applied on a failed save (e.g. 'restrained', 'poisoned'). */
  condition?: string;
}

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
  /** Id of the authored `EncounterDef` driving this session, when one
   *  exists. Procedurally-generated / ad-hoc sessions leave this
   *  undefined. The client reads it to drive encounter-aware UI such
   *  as the Mission Top Bar (TO MISSION / LEAVE MISSION buttons in the
   *  Bureau-office mission cycle). */
  currentEncounterId?: string;
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
  /** Set when the engine has paused to offer a Heroic Inspiration reroll
   *  (US-109a). The next player action must be `resolveReroll`. Cleared on
   *  resolution. */
  pendingReroll: PendingReroll | null;
  /** Set when a player action in the exploring phase would start combat — the
   *  engine pauses for confirmation. The next player action must be
   *  `resolveCombatStart`. Cleared on resolution. */
  pendingCombatStart: PendingCombatStart | null;
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
  /** Active/completed/failed quests for this character (structured quest system).
   *  Persisted with the world save; adventure/world-scope quests also carry across
   *  chapters via `AdventureSave`. The `QuestSystem` advances these off bus events. */
  quests: import('./quests.js').QuestState[];
  /** Defs for quests the AIGM created at runtime (not loaded from JSON). Stored
   *  here so a runtime quest's definition survives reload alongside its state. */
  runtimeQuestDefs: import('./quests.js').QuestDef[];
  /** Last variant index picked per `narrationId`. Used by NarrationSystem to avoid back-to-back repeats. */
  narrationLastUsed: Record<string, number>;
  /** Monotonic counter incremented once per off-camera `WorldTick`. Used as
   *  the `tickId` for the NPC sim engine's seeded RNG — combined with each
   *  NPC's id it produces a deterministic stream that reproduces across
   *  runs (unlike `Date.now()`). Survives save/load so loading a saved
   *  session mid-tick gives the same companion decisions on the next tick
   *  it would have given pre-save. */
  worldTickCount: number;
  /** Coarse-grained time of day for NPC routines. Advances on a fixed tick
   *  cadence (see TICKS_PER_DAY_PHASE) and wraps morning → noon → evening →
   *  night → morning. Per-encounter scope: every encounter starts at
   *  `morning` and the cycle runs while the player explores. Persistence
   *  across encounters is part of the WorldState refactor (step 7). */
  dayPhase: DayPhase;
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
  /** Persistent area-of-effect zones currently in play (Fog Cloud, Web,
   *  Darkness, Grease, illusions, future Walls + Spirit Guardians + Cloudkill).
   *  Lifetime is driven by `roundsRemaining`, not by concentration — the
   *  visible cloud stays on the map until its duration expires so the player
   *  can plan around it. Rendered on the client as a tile overlay. */
  activeZones: ActiveZone[];
  /** Concealed tile traps placed by the encounter. Detected via Perception,
   *  removed via the Disarm action, or sprung when a creature steps onto the
   *  trap tile. Rendered on the client once `discovered`. */
  traps: TrapState[];
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
   *  every L1+ spell of their class, their `defaultCantripIds` is widened
   *  to every cantrip of their class (so cantrip-gated knowledge checks
   *  pass), and the spell-slot pool is replaced with **4 slots of every
   *  level represented in the shipped spell roster** (capped at L9) so
   *  the prepared L2 / L3 / … spells are actually castable, not just
   *  visible. Lets the tester invoke any spell without a level-up
   *  rebuild. Combine with `unlimitedSpellSlots` to keep the pool full
   *  between casts. */
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
  /** Surfaces a "★ COMPLETE OBJECTIVE" button (inside the DevTools panel
   *  when `showDevToolsPanel` is on, or as a fallback button below the
   *  Player Panel's CHARACTER button when it is not) that fires the
   *  encounter's completion path — sets the `completionFlag` if one is
   *  authored, or ends combat by clearing every enemy — so a tester can
   *  blast through adventures without playing them out. Off by default. */
  completePrimaryObjective?: boolean;
  /** Show the DevTools panel — a small bottom-anchored bar to the right of
   *  the Player Panel that hosts dev-only buttons (Reload Encounter,
   *  Complete Objective, …). Off by default so non-developers never see
   *  the panel. Client-only — server ignores this field. */
  showDevToolsPanel?: boolean;
  /**
   * Clean Mode — when on, the server wipes every player progress
   * artefact under `server/data/settings/<setting>/saves/` at startup:
   *   • the world save (`saves/world.json`)
   *   • every character save (`saves/<characterId>.json`)
   *   • every persistent NPC save tree (`saves/<characterId>_npcs/`)
   *   • every adventure save (`saves/*_adventure.json`)
   * Logged loudly via `Logger.log('server.clean_mode_wipe', { … })`
   * and to stdout. The flag stays ON across restarts — disable it
   * explicitly from the Configuration screen when done.
   *
   * Server-only — the wipe runs in the startup path before any session
   * restoration. Off by default so a normal player can't accidentally
   * scrub their progress.
   */
  cleanModeOnStart?: boolean;
  /**
   * Server-side structured-logging verbosity. Controls how much the
   * `Logger` writes per session — high-volume logging on the request path
   * is a measurable source of in-encounter lag, so this lets a developer
   * dial it down (or off) without a code change.
   *   • `none`    — only `error` events are emitted; everything else is
   *                 dropped before it touches stdout or the NDJSON file.
   *   • `regular` — info / warn / error (debug dropped). The default.
   *   • `maximum` — everything, including `debug` (= legacy MYRPG_LOG_DEBUG=1).
   * Server-only, applied globally on boot and on every Configuration save.
   * Absent means `regular`.
   */
  logLevel?: LogLevel;
}

/** Server logging verbosity — see `DevFlags.logLevel`. */
export type LogLevel = "none" | "regular" | "maximum";

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
