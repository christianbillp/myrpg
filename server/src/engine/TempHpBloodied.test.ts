/**
 * US-109 b/c — Temporary HP pool (shared drain) and the Bloodied helper.
 */
import { describe, it, expect } from 'vitest';
import { applyDamageWithTempHp } from './CombatSystem.js';
import { isBloodied } from '../../../shared/types.js';

describe('applyDamageWithTempHp (US-109b)', () => {
  it('drains the temp-HP pool before real HP', () => {
    const t = { hp: 20, tempHp: 5 };
    applyDamageWithTempHp(t, 3);
    expect(t).toEqual({ hp: 20, tempHp: 2 });
  });

  it('spills overflow into real HP once temp HP is exhausted', () => {
    const t = { hp: 20, tempHp: 5 };
    applyDamageWithTempHp(t, 8);
    expect(t).toEqual({ hp: 17, tempHp: 0 });
  });

  it('reduces real HP directly when there is no temp-HP pool', () => {
    const t = { hp: 20 } as { hp: number; tempHp?: number };
    applyDamageWithTempHp(t, 6);
    expect(t.hp).toBe(14);
  });

  it('never drops HP below 0 and ignores non-positive amounts', () => {
    const t = { hp: 4, tempHp: 0 };
    applyDamageWithTempHp(t, 10);
    expect(t.hp).toBe(0);
    const u = { hp: 5, tempHp: 5 };
    applyDamageWithTempHp(u, 0);
    expect(u).toEqual({ hp: 5, tempHp: 5 });
  });
});

describe('isBloodied (US-109c)', () => {
  it('is true at exactly half HP or below, while alive', () => {
    expect(isBloodied(5, 10)).toBe(true);   // exactly half
    expect(isBloodied(4, 10)).toBe(true);
    expect(isBloodied(6, 10)).toBe(false);  // above half
  });

  it('is false at full HP and false when dead (0 HP)', () => {
    expect(isBloodied(10, 10)).toBe(false);
    expect(isBloodied(0, 10)).toBe(false);
  });

  it('handles odd maxima (half rounds via maxHp/2)', () => {
    expect(isBloodied(3, 7)).toBe(true);    // 3 <= 3.5
    expect(isBloodied(4, 7)).toBe(false);   // 4 > 3.5
  });
});
