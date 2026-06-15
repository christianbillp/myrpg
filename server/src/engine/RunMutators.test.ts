/**
 * Run mutators (Tactical Crucible #29) — the pure scaling math behind the
 * opt-in challenge knobs. The wiring (SessionBuilder enemy spawn, GameEngine
 * player-damage) just calls these.
 */
import { describe, it, expect } from 'vitest';
import { scaledEnemyHp, scaledIncomingDamage } from './RunMutators.js';

describe('scaledEnemyHp (#29 — Tougher Foes)', () => {
  it('scales and rounds, with a floor of 1', () => {
    expect(scaledEnemyHp(20, { enemyHpMult: 1.5 })).toBe(30);
    expect(scaledEnemyHp(7, { enemyHpMult: 1.5 })).toBe(11);   // 10.5 → 11
    expect(scaledEnemyHp(1, { enemyHpMult: 0.1 })).toBe(1);    // never below 1
  });

  it('is a no-op without an active multiplier', () => {
    expect(scaledEnemyHp(20, undefined)).toBe(20);
    expect(scaledEnemyHp(20, {})).toBe(20);
    expect(scaledEnemyHp(20, { enemyHpMult: 1 })).toBe(20);
    expect(scaledEnemyHp(20, { enemyHpMult: 0 })).toBe(20);    // invalid → ignored
  });
});

describe('scaledIncomingDamage (#29 — Deadly)', () => {
  it('scales and rounds, with a floor of 0', () => {
    expect(scaledIncomingDamage(10, { incomingDamageMult: 1.5 })).toBe(15);
    expect(scaledIncomingDamage(5, { incomingDamageMult: 1.5 })).toBe(8);   // 7.5 → 8
    expect(scaledIncomingDamage(0, { incomingDamageMult: 2 })).toBe(0);
  });

  it('is a no-op without an active multiplier', () => {
    expect(scaledIncomingDamage(10, undefined)).toBe(10);
    expect(scaledIncomingDamage(10, { enemyHpMult: 2 })).toBe(10); // unrelated knob
    expect(scaledIncomingDamage(10, { incomingDamageMult: 1 })).toBe(10);
  });
});
