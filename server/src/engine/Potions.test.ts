/**
 * US-124 (Phase 9) Slice 3 — potions beyond healing.
 *
 * `drinkPotion` now rolls optional healing AND optional temporary HP, so a
 * non-healing potion (e.g. Potion of Heroism) grants temp HP instead of / in
 * addition to HP.
 */
import { describe, it, expect } from 'vitest';
import { drinkPotion } from './CombatSystem.js';
import type { ConsumableDef } from './types.js';

describe('drinkPotion (US-124 potions beyond healing)', () => {
  it('still heals a classic healing potion', () => {
    const p: ConsumableDef = { id: 'h', name: 'Health Potion', type: 'consumable', healDice: 0, healSides: 0, healBonus: 5 };
    const r = drinkPotion(p);
    expect(r.healed).toBe(5);
    expect(r.tempHp).toBe(0);
  });

  it('grants temporary HP for a non-healing potion', () => {
    const p: ConsumableDef = { id: 'her', name: 'Potion of Heroism', type: 'consumable', tempHpDice: 0, tempHpSides: 0, tempHpBonus: 10 };
    const r = drinkPotion(p);
    expect(r.healed).toBe(0);
    expect(r.tempHp).toBe(10);
  });

  it('supports a potion that both heals and grants temp HP', () => {
    const p: ConsumableDef = { id: 'mix', name: 'Mixed', type: 'consumable', healBonus: 3, tempHpBonus: 4 };
    const r = drinkPotion(p);
    expect(r.healed).toBe(3);
    expect(r.tempHp).toBe(4);
  });
});
