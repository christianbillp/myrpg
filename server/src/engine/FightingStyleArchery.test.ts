/**
 * US-119 — Archery Fighting Style wiring.
 *
 * The Archery fighting style grants +2 to attack rolls with ranged weapons.
 * It's carried as the modifier flag `fighting-style-archery` (the same pattern
 * as Defense) and consumed in `resolvePlayerAttack`. Since
 * `attackTotal - naturalRoll === attackBonus`, the bonus is checkable
 * deterministically regardless of the d20 roll. Archery applies only to ranged
 * weapons, never melee.
 */
import { describe, it, expect } from 'vitest';
import { playerThrowAttack } from './CombatSystem.js';
import type { PlayerDef, PlayerAttack, MonsterDef } from './types.js';

function player(withArchery: boolean): PlayerDef {
  return {
    name: 'Archer', str: 10, dex: 16, proficiencyBonus: 3,
    sneakAttackDice: 0,
    modifiers: withArchery ? [{ type: 'flag', name: 'fighting-style-archery' }] : [],
  } as unknown as PlayerDef;
}

const SHORTBOW: PlayerAttack = {
  name: 'Shortbow', statKey: 'dex', damageDice: 1, damageSides: 6, damageType: 'piercing',
  rangeNormal: 80, rangeLong: 320, ammunitionType: 'arrow',
  savageAttacker: false, finesse: false, graze: false, vex: false, sap: false, slow: false,
  push: false, topple: false,
} as PlayerAttack;

const DAGGER_MELEE: PlayerAttack = {
  name: 'Dagger', statKey: 'dex', damageDice: 1, damageSides: 4, damageType: 'piercing',
  savageAttacker: false, finesse: true, graze: false, vex: false, sap: false, slow: false,
  push: false, topple: false,
} as PlayerAttack;

function dummy(): MonsterDef {
  return { id: 'd', name: 'D', type: 'Medium', maxHp: 50, ac: 10,
    str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10,
    proficiencyBonus: 2, initiativeBonus: 0, stealthBonus: 0, passivePerception: 10,
    speed: 30, attacks: [], xp: 0, cr: '0', color: 0, tokenAsset: 'x', size: 'medium' } as MonsterDef;
}

describe('Archery Fighting Style (US-119)', () => {
  it('adds +2 to ranged attack rolls when the style is active', () => {
    const r = playerThrowAttack(player(true), SHORTBOW, dummy(), false);
    // dex mod +3, PB +3, archery +2 = +8
    expect(r.attackTotal - r.naturalRoll).toBe(8);
  });

  it('does not add the bonus without the style', () => {
    const r = playerThrowAttack(player(false), SHORTBOW, dummy(), false);
    expect(r.attackTotal - r.naturalRoll).toBe(6);  // +3 dex, +3 PB
  });

  it('does not apply to melee weapons even with the style', () => {
    const r = playerThrowAttack(player(true), DAGGER_MELEE, dummy(), false);
    expect(r.attackTotal - r.naturalRoll).toBe(6);  // no archery bonus on melee
  });
});
