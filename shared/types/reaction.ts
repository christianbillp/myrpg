/**
 * Reaction prompts.
 *
 * Extracted from the original god-file `shared/types.ts` (now a barrel that
 * re-exports every domain module under `shared/types/`).
 */

// Cross-domain imports — keep these explicit so the dependency graph is visible.
import type { RolledBonusDamage } from "./entities.js";
import type { LogEntry } from "./combatLog.js";

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
  /** Damage type of the primary hit, so species resistances (US-108) still
   *  apply when Shield is declined or fails to block. */
  incomingDamageType?: string;
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

//
// Heroic Inspiration reroll prompt (US-109a). SRD: a player may expend Heroic
// Inspiration to reroll a die immediately after rolling it, keeping the new
// roll. When the player has inspiration and rolls an eligible d20, the engine
// computes the outcome but PAUSES before applying any consequence and surfaces
// a `pendingReroll`. The next action MUST be `resolveReroll { accept }`:
//   • decline → the already-rolled `resolved` outcome is applied as-is;
//   • accept  → inspiration is spent, the roll is re-resolved fresh, and that
//     new outcome is applied.
// The attack roll is the first wired site; saves / checks plug in later.

/** Snapshot of a fully-resolved player attack (roll + rolled damage,
 *  pre-consequence). Shared so it can ride in `GameState.pendingReroll`; the
 *  server's `ResolvedPlayerAttack` is an alias of this shape. */
export interface ResolvedAttackSnapshot {
  damage: number;
  isHit: boolean;
  isCrit: boolean;
  attackTotal: number;
  naturalRoll: number;
  logs: LogEntry[];
  vexApplied: boolean;
  slowApplied: boolean;
  bonusComponents: RolledBonusDamage[];
  sneakAttackFired: boolean;
}

/** Inputs needed to re-resolve the paused attack when the player accepts the
 *  reroll. Recaptured rather than recomputed so resume is independent of any
 *  state the pause might touch. */
export interface RerollAttackParams {
  withAdvantage: boolean;
  withDisadvantage: boolean;
  autoCrit: boolean;
  playerHidden: boolean;
  coverBonus: number;
  sneakAttackAllowed: boolean;
}

export interface PendingReroll {
  /** D20 site offering the reroll. Attack is the first wired site. */
  kind: 'attack';
  /** Prompt label, e.g. "Attack vs Bandit (A)". */
  label: string;
  /** The natural d20 (after Advantage/Disadvantage) the player just rolled. */
  rolledNatural: number;
  /** Human outcome preview at the current roll, e.g. "HIT — 7 slashing" or
   *  "MISS (14 vs AC 15)". Lets the player decide whether to spend the reroll. */
  outcomePreview: string;
  /** Target NPC id, refetched on resume. */
  targetId: string;
  /** Parameters to re-resolve the attack on accept. */
  params: RerollAttackParams;
  /** The exact rolled outcome, applied as-is on decline. */
  resolved: ResolvedAttackSnapshot;
}
