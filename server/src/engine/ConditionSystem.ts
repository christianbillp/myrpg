/**
 * ConditionSystem — single source of truth for all condition effects.
 * Functions here apply equally to any creature: player, ally, or enemy.
 */

/** Conditions that prevent actions, bonus actions, and reactions. */
export const INCAPACITATING_CONDITIONS = ['paralyzed', 'stunned', 'unconscious', 'incapacitated'];

/** Conditions that give attackers Advantage against the creature (prone handled separately). */
export const ADVANTAGE_AGAINST_CONDITIONS = ['blinded', 'paralyzed', 'restrained', 'stunned', 'unconscious'];

/** Conditions that impose Disadvantage on the creature's own attack rolls. */
export const ATTACK_DISADVANTAGE_CONDITIONS = ['blinded', 'poisoned', 'restrained', 'prone', 'vexed'];

/** Conditions that reduce the creature's speed to 0. */
export const SPEED_ZERO_CONDITIONS = ['paralyzed', 'restrained', 'unconscious'];

/** Conditions where a hit from within 1 tile is an automatic Critical Hit. */
export const AUTO_CRIT_CONDITIONS = ['paralyzed', 'unconscious'];

/** True when the creature cannot take actions, bonus actions, or reactions. */
export function isIncapacitated(conditions: string[]): boolean {
  return INCAPACITATING_CONDITIONS.some((c) => conditions.includes(c));
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
 * Only prone at range (dist > 1) qualifies.
 */
export function grantsDisadvantageAgainst(conditions: string[], dist: number): boolean {
  return conditions.includes('prone') && dist > 1;
}

/** True when this creature's own attack rolls have Disadvantage. */
export function hasAttackDisadvantage(conditions: string[]): boolean {
  return ATTACK_DISADVANTAGE_CONDITIONS.some((c) => conditions.includes(c));
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
