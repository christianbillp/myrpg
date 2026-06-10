/**
 * NPC runtime state + the off-camera simulation contracts (US-094):
 * `NpcState` itself, companions, alertness/memory, and daily routines.
 *
 * Extracted from the former `longRest.ts` grab-bag so the documented
 * concepts are findable by name.
 */
// Cross-domain imports — keep these explicit so the dependency graph is visible.
import type { Attitude, CreatureSize, OngoingEffect } from "./entities.js";
import type { ActiveBuff, Disposition, DayPhase } from "./gameState.js";

export interface NpcState {
  id: string;
  defId: string;
  name: string;
  tileX: number;
  tileY: number;
  /**
   * Party-relative combat label (ally / neutral / enemy). **Projection** of the
   * relationship layer (`GameState.relationships` → `engine/Relationships.ts`
   * `projectDisposition`): `enemy` when the NPC is hostile to the player, `ally`
   * when it's a committed friendly combatant (companion), else `neutral`.
   * Recomputed at spawn, at combat start, and after any relationship mutation —
   * direct hostility decisions go through `isHostileTo`, which reads the
   * relationship layer, not this field.
   */
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
  /** Remaining limited-use casts (US-117), keyed by spell id — seeded at
   *  spawn from `MonsterDef.spellcasting` (perDay + bonusAction). Monsters
   *  don't rest: per-day = per-spawn, and the field persists on the world
   *  save so a reload doesn't refill it. Absent for non-casters. */
  spellUses?: Record<string, number>;
  /** Remaining limited-use reactions (US-117), keyed by `MonsterReaction.kind`
   *  — e.g. the Mage's shared 3/day Protective Magic pool. Same per-spawn /
   *  persistence semantics as `spellUses`. */
  reactionUses?: Record<string, number>;
  /** Spell id this NPC caster is concentrating on (US-117 — its OWN cast:
   *  self-Invisibility, Fly). One at a time; `breakNpcConcentrationOnDamage`
   *  rolls the SRD CON save when the caster takes damage. Distinct from
   *  buffs the PLAYER sustains on the NPC (those live on `buffs` and end via
   *  the player's `endConcentration`). */
  concentratingOn?: string;
  /** Simplified SRD Fly (US-117): +30 ft of speed while true — the engine
   *  has no elevation model. Set/cleared with the `fly` concentration. */
  flying?: boolean;
  conditions: string[];
  /** Active buffs this creature carries (e.g. Invisibility cast on it by the
   *  player). Creature-agnostic — the same `ActiveBuff` shape the player uses.
   *  Cleaned up generically by `endConcentration` when the source spell ends. */
  activeBuffs?: ActiveBuff[];
  /** SRD Hide outcome for this NPC — Stealth roll total recorded when the
   *  creature took the Hide action. Opposed by player / other NPC Perception. */
  hideDC?: number;
  /** Ids of enemies that have lost track of this creature while it has the
   *  Invisible condition (Invisibility cast on it). Mirrors `PlayerState.unseenBy`
   *  — each failed a Perception check vs the creature's Stealth total and cannot
   *  make direct attack rolls against it. Cleared when Invisibility ends. */
  unseenBy?: string[];
  /** When true, the passive Perception movement-sweep skips this NPC
   *  entirely — they can only be revealed by an explicit
   *  `set_npc_hidden { hidden: false }` action. Used by encounter authors
   *  for narrative reveals (the dead rising, a wall sliding open) where
   *  no roll should be able to surface the creature early. Set via the
   *  `set_npc_hidden` action with `revealedBy: 'trigger'`. */
  revealedByTrigger?: boolean;
  /** When true the NPC is walking off the map (set by the `npc_leaves` trigger
   *  action). The exploration world-tick steps it toward the nearest map edge
   *  each tick and removes it from the encounter once it reaches the edge, so
   *  a departing NPC visibly exits rather than vanishing in place. */
  leaving?: boolean;
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

export interface NpcPersona { id: string; name: string; persona: string; }

/**
 * A persistent area-of-effect zone on the map (Fog Cloud, Web, Darkness,
 * Grease, Silent Image, …). Created by spells that author an `area` plus a
 * duration; lifetime decoupled from concentration so the visible zone stays
 * up until `roundsRemaining` hits zero. Rendered on the client as a
 * shape-appropriate tile overlay; consulted by the engine for re-tag-on-
 * enter behaviour as future spells land.
 */
