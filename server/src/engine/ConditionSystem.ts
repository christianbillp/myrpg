/**
 * ConditionSystem — single source of truth for all condition effects.
 * Functions here apply equally to any creature: player, ally, or enemy.
 */

/** Conditions that prevent actions, bonus actions, and reactions. `dead`
 *  is included so any incapacitation gate (turn skipping, AOE saving-throw
 *  exclusion, etc.) treats corpses the same as unconscious creatures. */
export const INCAPACITATING_CONDITIONS = ['paralyzed', 'stunned', 'unconscious', 'incapacitated', 'dead'];

/** True when the creature is a corpse — `hp <= 0` is the canonical signal,
 *  but the `dead` tag is the authored marker (set by `set_npc_dead`) that
 *  also flags creatures spawned dead from the start (e.g. a found body) so
 *  the engine doesn't try to revive, target, or reveal them. */
export function isDead<T extends { hp: number; conditions: string[] }>(target: T): boolean {
  return target.hp <= 0 || target.conditions.includes('dead');
}

/** Conditions that give attackers Advantage against the creature (prone handled separately). */
export const ADVANTAGE_AGAINST_CONDITIONS = ['blinded', 'paralyzed', 'restrained', 'stunned', 'unconscious'];

/** Conditions that impose Disadvantage on the creature's own attack rolls.
 *  `heavily-obscured` is included because a creature standing in fog can't
 *  see out, treated as Blinded for attack purposes. */
export const ATTACK_DISADVANTAGE_CONDITIONS = ['blinded', 'frightened', 'grappled', 'poisoned', 'restrained', 'prone', 'vexed', 'heavily-obscured'];

/** Conditions that reduce the creature's speed to 0. */
export const SPEED_ZERO_CONDITIONS = ['grappled', 'paralyzed', 'restrained', 'unconscious'];

/** Conditions on a target that give attackers Disadvantage (regardless of range).
 *  SRD 5.2.1: a creature in a Heavily Obscured area is functionally Blinded
 *  to anyone trying to see into it, so attackers targeting them effectively
 *  attack a creature they can't see — Disadvantage. Listed alongside
 *  Invisible since the engine treatment is identical. */
export const GRANTS_ATTACKER_DISADVANTAGE_CONDITIONS = ['invisible', 'heavily-obscured'];

/** Conditions where a hit from within 1 tile is an automatic Critical Hit. */
export const AUTO_CRIT_CONDITIONS = ['paralyzed', 'unconscious'];

/** Conditions that expire at the end of the creature's own turn. */
export const TURN_CONDITIONS = ['dodging', 'disengaged', 'dashing', 'slowed'];

/** True when the creature cannot take actions, bonus actions, or reactions. */
export function isIncapacitated(conditions: string[]): boolean {
  return INCAPACITATING_CONDITIONS.some((c) => conditions.includes(c));
}

/**
 * True when the creature is observable to others. Hidden and invisible creatures
 * cannot be the target of reactions (e.g. Opportunity Attacks) — the SRD's
 * reaction triggers require "a creature you can see".
 */
export function isVisible(conditions: string[]): boolean {
  return !conditions.includes('hidden') && !conditions.includes('invisible');
}

/**
 * True when attackers targeting this creature have Advantage.
 * Prone grants advantage only within 1 tile; all other qualifying conditions always grant it.
 */
export function grantsAdvantageAgainst(conditions: string[], dist: number): boolean {
  return ADVANTAGE_AGAINST_CONDITIONS.some((c) => conditions.includes(c))
    || (conditions.includes('prone') && dist <= 1);
}

/**
 * True when attackers targeting this creature have Disadvantage.
 * Invisible targets impose Disadvantage at any range; prone targets impose it beyond 1 tile.
 */
export function grantsDisadvantageAgainst(conditions: string[], dist: number): boolean {
  return GRANTS_ATTACKER_DISADVANTAGE_CONDITIONS.some((c) => conditions.includes(c))
    || (conditions.includes('prone') && dist > 1);
}

/** True when this creature's own attack rolls have Disadvantage. */
export function hasAttackDisadvantage(conditions: string[]): boolean {
  return ATTACK_DISADVANTAGE_CONDITIONS.some((c) => conditions.includes(c));
}

/** True when this creature's own attack rolls have Advantage (e.g. invisible attacker). */
export function hasAttackAdvantage(conditions: string[]): boolean {
  return conditions.includes('invisible');
}

/** True when this creature's speed is forced to 0 by a condition. */
export function hasSpeedZero(conditions: string[]): boolean {
  return SPEED_ZERO_CONDITIONS.some((c) => conditions.includes(c));
}

/**
 * True when a hit against this creature from within 1 tile is a Critical Hit.
 * dist is the Chebyshev distance between attacker and target (1 tile = 5 ft).
 */
export function isAutoCrit(conditions: string[], dist: number): boolean {
  return AUTO_CRIT_CONDITIONS.some((c) => conditions.includes(c)) && dist <= 1;
}

/**
 * Movement cost (in tiles) for a prone creature to stand at the start of its turn.
 * Returns 0 if not prone. speedTiles is the creature's full speed in tiles.
 */
export function proneStandCost(conditions: string[], speedTiles: number): number {
  return conditions.includes('prone') ? Math.floor(speedTiles / 2) : 0;
}

/**
 * Clear a Hide-granted invisibility on a creature. SRD: the Hide action's
 * Invisible condition ends when the creature attacks, makes noise above a
 * whisper, or is spotted. We track that the invisibility came from Hide via
 * the matching `hideDC` field — magical Invisibility (Greater Invisibility,
 * etc.) does NOT set `hideDC` and therefore persists through these triggers.
 */
export function clearHide<T extends { conditions: string[]; hideDC?: number }>(target: T): void {
  if (typeof target.hideDC === 'number') {
    target.conditions = target.conditions.filter((c) => c !== 'hidden' && c !== 'invisible');
    target.hideDC = undefined;
  } else {
    // Defensive — if a caller flagged a creature as hidden without setting
    // hideDC (shouldn't happen post-Layer-D), just strip the 'hidden' marker.
    target.conditions = target.conditions.filter((c) => c !== 'hidden');
  }
}
