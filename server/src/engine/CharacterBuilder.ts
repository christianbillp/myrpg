/**
 * Character creation (US-122) — server-side assembly of a `PlayerDef` from the
 * player's creation choices. Slice 1 covers the random ability-score roll; the
 * full `buildPlayerDef` lands in a later slice.
 *
 * The shared constants + validators (Standard Array, Point Buy cost/budget,
 * background ability-increase rules) live in `shared/abilityScores.ts` so the
 * client preview and this module agree. Only the random roll lives here,
 * because it needs a dice source.
 */
import { d } from './Dice.js';

/** SRD 4d6-drop-lowest: roll four d6, discard the lowest, sum the rest. */
export function rollAbilityScore(): number {
  const rolls = [d(6), d(6), d(6), d(6)].sort((a, b) => a - b);
  return rolls[1] + rolls[2] + rolls[3];  // drop rolls[0], the lowest
}

/** Roll a full set of six unassigned ability scores (4d6-drop-lowest each).
 *  The player assigns these to STR/DEX/… in the creator UI. */
export function rollAbilityScoreSet(): number[] {
  return Array.from({ length: 6 }, () => rollAbilityScore());
}
