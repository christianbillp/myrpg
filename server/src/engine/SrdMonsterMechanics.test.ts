/**
 * US-123 — SRD monster mechanics: Undead Fortitude (Zombie), condition
 * immunities, and the on-hit save / rider attack selection (Ghoul Claw).
 */
import { describe, it, expect } from 'vitest';
import { tryUndeadFortitude } from './CombatSystem.js';
import { npcConditionImmune, onHitExempt } from './ConditionSystem.js';
import { runEnemyTurn, type EnemyTurnConfig } from './EnemyAI.js';
import { makeNpc } from '../test/buildTestContext.js';
import type { MonsterDef } from './types.js';

function zombie(): MonsterDef {
  return {
    id: 'zombie', name: 'Zombie', type: 'Medium Undead, Neutral Evil', maxHp: 15, ac: 8,
    str: 13, dex: 6, con: 16, int: 3, wis: 6, cha: 5,
    proficiencyBonus: 2, initiativeBonus: -2, stealthBonus: -2, passivePerception: 8,
    savingThrows: { str: 1, dex: -2, con: 100, int: -4, wis: 0, cha: -3 },
    speed: 20,
    attacks: [{ name: 'Slam', attackType: 'melee', bonus: 3, reach: 5, damageDice: 1, damageSides: 8, damageBonus: 1, damageType: 'bludgeoning' }],
    conditionImmunities: ['exhaustion', 'poisoned'],
    traits: ['undead_fortitude'],
    xp: 50, cr: '1/4', color: 0, tokenAsset: 'x.svg', size: 'medium',
  } as MonsterDef;
}

function ghoul(): MonsterDef {
  return {
    id: 'ghoul', name: 'Ghoul', type: 'Medium Undead, Chaotic Evil', maxHp: 22, ac: 12,
    str: 13, dex: 15, con: 10, int: 7, wis: 10, cha: 6,
    proficiencyBonus: 2, initiativeBonus: 2, stealthBonus: 2, passivePerception: 10,
    speed: 30,
    attacks: [
      { name: 'Bite', attackType: 'melee', bonus: 4, reach: 5, damageDice: 1, damageSides: 6, damageBonus: 2, damageType: 'piercing' },
      {
        name: 'Claw', attackType: 'melee', bonus: 4, reach: 5, damageDice: 1, damageSides: 4, damageBonus: 2, damageType: 'slashing',
        onHit: [{ kind: 'save', ability: 'con', dc: 10, condition: 'paralyzed', exemptTypes: ['undead', 'elf'] }],
      },
    ],
    multiattack: 2,
    xp: 200, cr: '1', color: 0, tokenAsset: 'x.svg', size: 'medium',
  } as MonsterDef;
}

function configWithConditions(conditions: string[]): EnemyTurnConfig {
  const grid = Array.from({ length: 5 }, () => new Array<boolean>(5).fill(false));
  return {
    displayName: 'Ghoul',
    target: {
      id: 'player', displayName: 'Hero', tileX: 1, tileY: 0, ac: 10, hp: 50,
      hidden: false, dodging: false, invisible: false, conditions, passivePerception: 10,
    },
    blocksMovement: grid, mapCols: 5, mapRows: 5, occupiedTiles: [],
  };
}

describe('Undead Fortitude (SRD Zombie)', () => {
  it('drops to 1 HP instead of 0 on a successful CON save', () => {
    const npc = makeNpc({ id: 'z', defId: 'zombie', hp: 0, maxHp: 15 });
    const { survived, log } = tryUndeadFortitude(npc, zombie(), 5, 'bludgeoning', false);
    expect(survived).toBe(true);  // con save +100 always beats DC 10
    expect(npc.hp).toBe(1);
    expect(log).toBeDefined();
  });

  it('is bypassed by radiant damage and by critical hits', () => {
    const npc = makeNpc({ id: 'z', defId: 'zombie', hp: 0, maxHp: 15 });
    expect(tryUndeadFortitude(npc, zombie(), 5, 'radiant', false).survived).toBe(false);
    expect(tryUndeadFortitude(npc, zombie(), 5, 'bludgeoning', true).survived).toBe(false);
    expect(npc.hp).toBe(0);
  });

  it('does nothing for creatures without the trait or above 0 HP', () => {
    const def = { ...zombie(), traits: [] } as MonsterDef;
    const downed = makeNpc({ id: 'z', defId: 'zombie', hp: 0, maxHp: 15 });
    expect(tryUndeadFortitude(downed, def, 5, 'bludgeoning', false).survived).toBe(false);
    const standing = makeNpc({ id: 'z2', defId: 'zombie', hp: 5, maxHp: 15 });
    expect(tryUndeadFortitude(standing, zombie(), 4, 'bludgeoning', false).survived).toBe(false);
  });
});

describe('Condition immunities', () => {
  it('matches the stat-block list case-insensitively', () => {
    expect(npcConditionImmune(zombie(), 'poisoned')).toBe(true);
    expect(npcConditionImmune(zombie(), 'Poisoned')).toBe(true);
    expect(npcConditionImmune(zombie(), 'prone')).toBe(false);
    expect(npcConditionImmune({ conditionImmunities: undefined }, 'poisoned')).toBe(false);
  });
});

describe('On-hit save riders (SRD Ghoul Claw)', () => {
  it('exempts creature types named by the effect', () => {
    expect(onHitExempt(['undead', 'elf'], 'Medium Undead, Lawful Evil')).toBe(true);
    expect(onHitExempt(['undead', 'elf'], 'High Elf wood-elf')).toBe(true);
    expect(onHitExempt(['undead', 'elf'], 'Human soldier')).toBe(false);
    expect(onHitExempt(undefined, 'Medium Undead')).toBe(false);
  });

  it('opens with the rider attack (single attack) while the target lacks the condition', () => {
    const enemy = makeNpc({ id: 'g', defId: 'ghoul', tileX: 0, tileY: 0, disposition: 'enemy' });
    const result = runEnemyTurn(enemy, ghoul(), configWithConditions([]));
    expect(result.attacked).toBe(true);
    expect(result.damageType).toBe('slashing');               // Claw, not Bite
    expect(result.extraAttacks?.length ?? 0).toBe(0);          // rider attack is single
    expect(result.attackOnHit?.[0]?.kind).toBe('save');
  });

  it('switches to the Multiattack weapon once the condition has landed', () => {
    const enemy = makeNpc({ id: 'g', defId: 'ghoul', tileX: 0, tileY: 0, disposition: 'enemy' });
    const result = runEnemyTurn(enemy, ghoul(), configWithConditions(['paralyzed']));
    expect(result.damageType).toBe('piercing');                // Bite
    expect(result.extraAttacks?.length).toBe(1);               // multiattack 2
  });
});
