/**
 * SRD 5.2.1 ability-score generation for character creation (US-122).
 *
 * Three methods, per "Creating a Character → Determine Ability Scores":
 *   • Standard Array — assign the fixed set 15, 14, 13, 12, 10, 8.
 *   • Point Buy      — 27 points; each score 8..15 costs per the table below.
 *   • 4d6-drop-lowest — roll four d6, drop the lowest, six times (rolled
 *     server-side; see `rollAbilityScoreSet` in the engine).
 *
 * This module is the shared source of truth for the constants + validators so
 * the client (creator UI preview) and server (create-character validation)
 * agree. The random roll itself lives server-side (it needs a dice source).
 */
import type { AbilityKey } from "./types/classes.js";
export type { AbilityKey };

export const ABILITY_KEYS: readonly AbilityKey[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

/** A complete set of six assigned ability scores (pre-background-increase). */
export type AbilityScores = Record<AbilityKey, number>;

export type AbilityScoreMethod = 'standard-array' | 'point-buy' | 'roll';

/** SRD Standard Array. */
export const STANDARD_ARRAY: readonly number[] = [15, 14, 13, 12, 10, 8];

/** SRD Point Buy budget + per-score cost table (scores 8..15). */
export const POINT_BUY_BUDGET = 27;
export const POINT_BUY_MIN = 8;
export const POINT_BUY_MAX = 15;
const POINT_BUY_COST: Readonly<Record<number, number>> = {
  8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9,
};

/** Point cost of a single score (Infinity for an out-of-range score). */
export function pointBuyCost(score: number): number {
  return POINT_BUY_COST[score] ?? Infinity;
}

/** Total point cost of an ability-score set under Point Buy. */
export function pointBuyTotalCost(scores: AbilityScores): number {
  return ABILITY_KEYS.reduce((sum, k) => sum + pointBuyCost(scores[k]), 0);
}

/** Whether a score set is a legal Point Buy spend: every score 8..15 and the
 *  total cost within the 27-point budget. */
export function isValidPointBuy(scores: AbilityScores): boolean {
  for (const k of ABILITY_KEYS) {
    const v = scores[k];
    if (v < POINT_BUY_MIN || v > POINT_BUY_MAX) return false;
  }
  return pointBuyTotalCost(scores) <= POINT_BUY_BUDGET;
}

/** Whether a score set is exactly the Standard Array, in some assignment
 *  (a permutation of 15/14/13/12/10/8). */
export function isStandardArrayAssignment(scores: AbilityScores): boolean {
  const assigned = ABILITY_KEYS.map((k) => scores[k]).sort((a, b) => a - b);
  const array = [...STANDARD_ARRAY].sort((a, b) => a - b);
  return assigned.length === array.length && assigned.every((v, i) => v === array[i]);
}

/** SRD 5.2.1 background ability-increase rule: either +2 to one of the
 *  background's three abilities and +1 to another, OR +1 to all three. */
export type BackgroundAbilityChoice =
  | { kind: 'two-one'; plusTwo: AbilityKey; plusOne: AbilityKey }
  | { kind: 'one-one-one' };

/**
 * Validate a background ability-increase choice against the background's three
 * allowed abilities. `two-one` must pick two distinct abilities, both in the
 * allowed set; `one-one-one` always applies +1 to each of the three.
 */
export function isValidBackgroundAbilityChoice(
  choice: BackgroundAbilityChoice,
  allowed: readonly AbilityKey[],
): boolean {
  if (allowed.length !== 3) return false;
  if (choice.kind === 'one-one-one') return true;
  const set = new Set(allowed);
  return choice.plusTwo !== choice.plusOne && set.has(choice.plusTwo) && set.has(choice.plusOne);
}

/** Apply a background ability-increase choice to a base score set, returning a
 *  new set (the base set is not mutated). */
export function applyBackgroundAbilityChoice(
  base: AbilityScores,
  choice: BackgroundAbilityChoice,
  allowed: readonly AbilityKey[],
): AbilityScores {
  const out: AbilityScores = { ...base };
  if (choice.kind === 'one-one-one') {
    for (const k of allowed) out[k] += 1;
  } else {
    out[choice.plusTwo] += 2;
    out[choice.plusOne] += 1;
  }
  return out;
}

/** Standard ability modifier: floor((score - 10) / 2). */
export function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}
