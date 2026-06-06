/**
 * US-122 Slice 1 — ability-score generation.
 *
 * Shared validators (Standard Array, Point Buy cost/budget, background ability
 * increases) + the server-side 4d6-drop-lowest roller.
 */
import { describe, it, expect } from 'vitest';
import {
  STANDARD_ARRAY, POINT_BUY_BUDGET, pointBuyCost, pointBuyTotalCost,
  isValidPointBuy, isStandardArrayAssignment, abilityModifier,
  applyBackgroundAbilityChoice, isValidBackgroundAbilityChoice,
  type AbilityScores,
} from '../../../shared/abilityScores.js';
import { rollAbilityScore, rollAbilityScoreSet } from './CharacterBuilder.js';

const scores = (str: number, dex: number, con: number, int: number, wis: number, cha: number): AbilityScores =>
  ({ str, dex, con, int, wis, cha });

describe('Ability-score generation (US-122)', () => {
  it('Point Buy: costs match the SRD table and the 27-point budget', () => {
    expect(pointBuyCost(8)).toBe(0);
    expect(pointBuyCost(14)).toBe(7);
    expect(pointBuyCost(15)).toBe(9);
    expect(pointBuyCost(16)).toBe(Infinity);  // out of range
    // 15,15,15,8,8,8 → 9+9+9 = 27 exactly.
    const maxed = scores(15, 15, 15, 8, 8, 8);
    expect(pointBuyTotalCost(maxed)).toBe(27);
    expect(isValidPointBuy(maxed)).toBe(true);
    expect(POINT_BUY_BUDGET).toBe(27);
  });

  it('Point Buy: rejects over-budget and out-of-range spreads', () => {
    expect(isValidPointBuy(scores(15, 15, 15, 15, 8, 8))).toBe(false);  // 36 > 27
    expect(isValidPointBuy(scores(16, 8, 8, 8, 8, 8))).toBe(false);     // 16 out of range
    expect(isValidPointBuy(scores(7, 8, 8, 8, 8, 8))).toBe(false);      // 7 out of range
  });

  it('Standard Array: accepts any permutation, rejects anything else', () => {
    expect(isStandardArrayAssignment(scores(15, 14, 13, 12, 10, 8))).toBe(true);
    expect(isStandardArrayAssignment(scores(8, 10, 12, 13, 14, 15))).toBe(true);  // permuted
    expect(isStandardArrayAssignment(scores(15, 15, 13, 12, 10, 8))).toBe(false); // duplicate 15
    expect([...STANDARD_ARRAY]).toEqual([15, 14, 13, 12, 10, 8]);
  });

  it('ability modifier follows floor((score-10)/2)', () => {
    expect(abilityModifier(8)).toBe(-1);
    expect(abilityModifier(10)).toBe(0);
    expect(abilityModifier(15)).toBe(2);
    expect(abilityModifier(16)).toBe(3);
  });

  it('background ability increase: +2/+1 and +1/+1/+1', () => {
    const allowed = ['int', 'wis', 'cha'] as const;
    const base = scores(10, 10, 10, 12, 13, 8);
    const twoOne = applyBackgroundAbilityChoice(base, { kind: 'two-one', plusTwo: 'wis', plusOne: 'int' }, allowed);
    expect(twoOne.wis).toBe(15);
    expect(twoOne.int).toBe(13);
    expect(twoOne.cha).toBe(8);  // untouched
    const all = applyBackgroundAbilityChoice(base, { kind: 'one-one-one' }, allowed);
    expect([all.int, all.wis, all.cha]).toEqual([13, 14, 9]);
    expect(all.str).toBe(10);  // outside the allowed set — untouched
  });

  it('caps a background increase at 20 (SRD: cannot raise a score above 20)', () => {
    const allowed = ['str', 'con', 'dex'] as const;
    // A rolled 19 + 2 would be 21 → capped to 20; a 20 + 1 stays 20.
    const base = scores(19, 10, 20, 8, 8, 8);
    const out = applyBackgroundAbilityChoice(base, { kind: 'two-one', plusTwo: 'str', plusOne: 'con' }, allowed);
    expect(out.str).toBe(20);  // 19 + 2 capped at 20
    expect(out.con).toBe(20);  // already 20, +1 stays 20
    const all = applyBackgroundAbilityChoice(base, { kind: 'one-one-one' }, allowed);
    expect(all.str).toBe(20);  // 19 + 1 = 20
    expect(all.con).toBe(20);  // 20 + 1 capped
    expect(all.dex).toBe(11);  // 10 + 1, no cap
  });

  it('rejects a two-one choice that picks an ability outside the background set or repeats one', () => {
    const allowed = ['int', 'wis', 'cha'] as const;
    expect(isValidBackgroundAbilityChoice({ kind: 'two-one', plusTwo: 'str', plusOne: 'int' }, allowed)).toBe(false);
    expect(isValidBackgroundAbilityChoice({ kind: 'two-one', plusTwo: 'wis', plusOne: 'wis' }, allowed)).toBe(false);
    expect(isValidBackgroundAbilityChoice({ kind: 'two-one', plusTwo: 'wis', plusOne: 'int' }, allowed)).toBe(true);
    expect(isValidBackgroundAbilityChoice({ kind: 'one-one-one' }, allowed)).toBe(true);
  });

  it('4d6-drop-lowest stays within 3..18 and produces six scores', () => {
    for (let i = 0; i < 200; i++) {
      const s = rollAbilityScore();
      expect(s).toBeGreaterThanOrEqual(3);
      expect(s).toBeLessThanOrEqual(18);
    }
    expect(rollAbilityScoreSet()).toHaveLength(6);
  });
});
