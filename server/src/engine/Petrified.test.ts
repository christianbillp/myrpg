/**
 * US-058 — Petrified condition (full treatment).
 *
 * Petrified = Incapacitated (can't act), Speed 0, attacks against have
 * Advantage, auto-fail Str/Dex saves, and Resistance to all damage (+ poison
 * immunity, player path).
 */
import { describe, it, expect } from 'vitest';
import {
  isIncapacitated, hasSpeedZero, grantsAdvantageAgainst,
  autoFailsStrDexSave, resistsAllDamage,
} from './ConditionSystem.js';

describe('Petrified (US-058)', () => {
  const c = ['petrified'];
  it('is incapacitated (cannot act) and has Speed 0', () => {
    expect(isIncapacitated(c)).toBe(true);
    expect(hasSpeedZero(c)).toBe(true);
  });
  it('grants Advantage to attackers', () => {
    expect(grantsAdvantageAgainst(c, 5)).toBe(true);
  });
  it('auto-fails Str/Dex saves', () => {
    expect(autoFailsStrDexSave(c)).toBe(true);
  });
  it('resists all damage', () => {
    expect(resistsAllDamage(c)).toBe(true);
    expect(resistsAllDamage(['blinded'])).toBe(false);
  });
  it('autoFailsStrDexSave still covers paralyzed / unconscious / stunned', () => {
    expect(autoFailsStrDexSave(['paralyzed'])).toBe(true);
    expect(autoFailsStrDexSave(['unconscious'])).toBe(true);
    expect(autoFailsStrDexSave(['stunned'])).toBe(true);
    expect(autoFailsStrDexSave(['poisoned'])).toBe(false);
  });
});
