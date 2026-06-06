/**
 * US-116 (Phase 4) — SRD Somatic/Material component free-hand gate.
 *
 * A spell with a Somatic OR Material component needs at least one free hand
 * (per SRD the Material "hand free to access" can be the same hand used for
 * Somatic gestures, so both reduce to ≥1 free hand). A Verbal-only spell needs
 * no free hand and stays castable with both hands occupied. A two-handed weapon
 * (or a versatile weapon without a shield) occupies both hands.
 */
import { describe, it, expect } from 'vitest';
import { canCastSpell, freeHandCount } from './ActionGuards.js';
import { buildTestContext } from '../test/buildTestContext.js';
import type { SpellDef, WeaponDef, ShieldDef } from './types.js';

function spell(overrides: Partial<SpellDef>): SpellDef {
  return {
    id: 'sp', name: 'Test Spell', level: 1, school: 'evocation', classes: ['wizard'],
    castingTime: 'action', range: 'Self', rangeFeet: 0,
    components: { verbal: true, somatic: true, material: null },
    duration: 'Instantaneous', concentration: false, ritual: false,
    ...overrides,
  } as SpellDef;
}

const DAGGER: WeaponDef = {
  id: 'dagger', name: 'Dagger', type: 'weapon', damageDice: 1, damageSides: 4,
  damageType: 'piercing', finesse: true, twoHanded: false, thrown: true,
  throwNormal: 20, throwLong: 60, rangeNormal: 0, rangeLong: 0,
} as WeaponDef;

const GREATSWORD: WeaponDef = {
  id: 'greatsword', name: 'Greatsword', type: 'weapon', damageDice: 2, damageSides: 6,
  damageType: 'slashing', finesse: false, twoHanded: true, thrown: false,
  throwNormal: 0, throwLong: 0, rangeNormal: 0, rangeLong: 0,
} as WeaponDef;

// Versatile weapon (the shipped casters wield a quarterstaff with no shield).
// It must count as ONE hand so a Somatic/Material spell stays castable.
const QUARTERSTAFF: WeaponDef = {
  id: 'quarterstaff', name: 'Quarterstaff', type: 'weapon', damageDice: 1, damageSides: 6,
  damageType: 'bludgeoning', finesse: false, twoHanded: false, thrown: false,
  throwNormal: 0, throwLong: 0, rangeNormal: 0, rangeLong: 0,
  versatile: { damageDice: 1, damageSides: 8 },
} as WeaponDef;

const SHIELD: ShieldDef = { id: 'shield', name: 'Shield', type: 'shield', acBonus: 2 } as ShieldDef;

function ctx(equipped: { weaponId?: string | null; shieldId?: string | null }, sp: SpellDef) {
  const r = buildTestContext({
    phase: 'player_turn',
    player: {
      spellSlots: [2],
      preparedSpellIds: [sp.id],
      equippedSlots: { armorId: null, weaponId: equipped.weaponId ?? null, shieldId: equipped.shieldId ?? null },
    },
    playerDef: { spellcastingAbility: 'int' },
  });
  r.ctx.defs.spells.push(sp);
  r.ctx.defs.equipment.push(DAGGER, GREATSWORD, QUARTERSTAFF, SHIELD);
  return r;
}

describe('Somatic/Material free-hand component gate (US-116)', () => {
  it('counts free hands from equipped weapon/shield', () => {
    expect(freeHandCount(ctx({}, spell({})).ctx)).toBe(2);                              // empty hands
    expect(freeHandCount(ctx({ weaponId: 'dagger' }, spell({})).ctx)).toBe(1);          // one-handed weapon
    expect(freeHandCount(ctx({ weaponId: 'dagger', shieldId: 'shield' }, spell({})).ctx)).toBe(0); // weapon + shield
    expect(freeHandCount(ctx({ weaponId: 'greatsword' }, spell({})).ctx)).toBe(0);      // two-handed weapon
    expect(freeHandCount(ctx({ weaponId: 'quarterstaff' }, spell({})).ctx)).toBe(1);    // versatile, no shield → one hand
  });

  it('keeps a Somatic spell castable for a versatile-weapon caster (no shield)', () => {
    const somatic = spell({ components: { verbal: true, somatic: true, material: null } });
    expect(canCastSpell(ctx({ weaponId: 'quarterstaff' }, somatic).ctx, 'sp')).toBe(true);
  });

  it('blocks a Somatic spell when both hands are occupied', () => {
    const somatic = spell({ components: { verbal: false, somatic: true, material: null } });
    expect(canCastSpell(ctx({ weaponId: 'dagger', shieldId: 'shield' }, somatic).ctx, 'sp')).toBe(false);
    expect(canCastSpell(ctx({ weaponId: 'dagger' }, somatic).ctx, 'sp')).toBe(true);  // a hand is free
  });

  it('blocks a Material spell when both hands are occupied', () => {
    const material = spell({ components: { verbal: true, somatic: false, material: 'a bit of fleece' } });
    expect(canCastSpell(ctx({ weaponId: 'greatsword' }, material).ctx, 'sp')).toBe(false);
    expect(canCastSpell(ctx({}, material).ctx, 'sp')).toBe(true);
  });

  it('allows a Verbal-only spell with both hands occupied', () => {
    const verbalOnly = spell({ components: { verbal: true, somatic: false, material: null } });
    expect(canCastSpell(ctx({ weaponId: 'dagger', shieldId: 'shield' }, verbalOnly).ctx, 'sp')).toBe(true);
  });
});
