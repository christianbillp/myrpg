/**
 * US-125 — CR ≤ 1 humanoid & goblinoid mechanics: Advantage-rider bonus
 * damage (Goblin Warrior/Boss), Grab-then-hammer attack selection (Bugbear),
 * attack-replacement save actions (Pirate's Enthralling Panache), and the
 * Bless attack/save bonus (Priest Acolyte).
 */
import { describe, it, expect } from 'vitest';
import { enemyAttack, npcBlessBonus, npcSaveMod } from './CombatSystem.js';
import { runEnemyTurn, type EnemyTurnConfig } from './EnemyAI.js';
import { makeNpc } from '../test/buildTestContext.js';
import type { MonsterDef, MonsterAttack } from './types.js';

const GOBLIN_SCIMITAR: MonsterAttack = {
  name: 'Scimitar', attackType: 'melee', bonus: 100, reach: 5,
  damageDice: 1, damageSides: 6, damageBonus: 2, damageType: 'slashing',
  bonusDamage: [{ dice: 1, sides: 4, bonus: 0, damageType: 'slashing', onAdvantageOnly: true }],
};

function bugbear(): MonsterDef {
  return {
    id: 'bugbear_warrior', name: 'Bugbear', type: 'Medium Fey (Goblinoid), Chaotic Evil',
    maxHp: 33, ac: 14, str: 15, dex: 14, con: 13, int: 8, wis: 11, cha: 9,
    proficiencyBonus: 2, initiativeBonus: 2, stealthBonus: 6, passivePerception: 10, speed: 30,
    attacks: [
      { name: 'Light Hammer', attackType: 'both', bonus: 4, reach: 10, rangeNormal: 20, rangeLong: 60, damageDice: 3, damageSides: 4, damageBonus: 2, damageType: 'bludgeoning', advantageVsGrappledTarget: true },
      { name: 'Grab', attackType: 'melee', bonus: 4, reach: 10, damageDice: 2, damageSides: 6, damageBonus: 2, damageType: 'bludgeoning', onHit: [{ kind: 'condition', condition: 'grappled', escapeDc: 12, maxTargetSize: 'medium' }] },
    ],
    xp: 200, cr: '1', color: 0, tokenAsset: 'x.svg', size: 'medium',
  } as MonsterDef;
}

function pirate(): MonsterDef {
  return {
    id: 'pirate', name: 'Pirate', type: 'Medium or Small Humanoid, Neutral',
    maxHp: 33, ac: 14, str: 10, dex: 16, con: 12, int: 8, wis: 12, cha: 14,
    proficiencyBonus: 2, initiativeBonus: 5, stealthBonus: 3, passivePerception: 11, speed: 30,
    attacks: [
      { name: 'Dagger', attackType: 'both', bonus: 5, reach: 5, rangeNormal: 20, rangeLong: 60, damageDice: 1, damageSides: 4, damageBonus: 3, damageType: 'piercing' },
    ],
    multiattack: 2,
    saveActions: [{ name: 'Enthralling Panache', ability: 'wis', dc: 12, condition: 'charmed', rangeFeet: 30 }],
    xp: 200, cr: '1', color: 0, tokenAsset: 'x.svg', size: 'medium',
  } as MonsterDef;
}

function config(conditions: string[] = [], grappledByAttacker = false): EnemyTurnConfig {
  const grid = Array.from({ length: 5 }, () => new Array<boolean>(8).fill(false));
  return {
    displayName: 'Attacker',
    target: {
      id: 'player', displayName: 'Hero', tileX: 1, tileY: 0, ac: 10, hp: 50,
      hidden: false, dodging: false, invisible: false, conditions, grappledByAttacker, passivePerception: 10,
    },
    blocksMovement: grid, mapCols: 8, mapRows: 5, occupiedTiles: [],
  };
}

describe('Advantage-rider bonus damage (US-125, Goblin Warrior)', () => {
  it('adds the rider only when the roll had Advantage', () => {
    const withAdv = enemyAttack(GOBLIN_SCIMITAR, 10, true, false);
    expect(withAdv.isHit).toBe(true);
    expect(withAdv.bonusComponents.length).toBe(1);
    const without = enemyAttack(GOBLIN_SCIMITAR, 10, false, false);
    expect(without.isHit).toBe(true);
    expect(without.bonusComponents.length).toBe(0);
  });

  it('Advantage cancelled by Disadvantage does not trigger the rider', () => {
    const cancelled = enemyAttack(GOBLIN_SCIMITAR, 10, true, true);
    expect(cancelled.isHit).toBe(true);
    expect(cancelled.bonusComponents.length).toBe(0);
  });
});

describe('Bugbear Grab-then-hammer (US-125)', () => {
  it('opens with Grab while the target is ungrappled', () => {
    const enemy = makeNpc({ id: 'b', defId: 'bugbear_warrior', tileX: 0, tileY: 0, disposition: 'enemy' });
    const result = runEnemyTurn(enemy, bugbear(), config([]));
    expect(result.attacked).toBe(true);
    expect(result.attackOnHit?.[0]?.kind).toBe('condition');
  });

  it('switches to the Light Hammer once the target is grappled', () => {
    const enemy = makeNpc({ id: 'b', defId: 'bugbear_warrior', tileX: 0, tileY: 0, disposition: 'enemy' });
    const result = runEnemyTurn(enemy, bugbear(), config(['grappled'], true));
    expect(result.attacked).toBe(true);
    expect(result.attackOnHit).toBeUndefined();
  });
});

describe('Attack-replacement save actions (US-125, Enthralling Panache)', () => {
  it('replaces one Multiattack swing with the save action when the target is uncharmed', () => {
    const enemy = makeNpc({ id: 'p', defId: 'pirate', tileX: 0, tileY: 0, disposition: 'enemy' });
    const result = runEnemyTurn(enemy, pirate(), config([]));
    expect(result.attacked).toBe(true);
    expect(result.saveAction?.condition).toBe('charmed');
    expect(result.extraAttacks?.length ?? 0).toBe(0);  // 2 attacks − 1 replaced = 1 primary
  });

  it('makes the full Multiattack once the target is charmed', () => {
    const enemy = makeNpc({ id: 'p', defId: 'pirate', tileX: 0, tileY: 0, disposition: 'enemy' });
    const result = runEnemyTurn(enemy, pirate(), config(['charmed']));
    expect(result.saveAction).toBeUndefined();
    expect(result.extraAttacks?.length).toBe(1);
  });
});

describe('Bless (US-125, Priest Acolyte Divine Aid)', () => {
  it('grants a d4 bonus to attack rolls and saves for a blessed creature', () => {
    const blessed = makeNpc({ id: 'a', defId: 'tough', activeBuffs: [{ spellId: 'bless', concentration: true, sourceNpcId: 'priest' }] });
    const plain = makeNpc({ id: 'b', defId: 'tough' });
    const bonus = npcBlessBonus(blessed);
    expect(bonus).toBeGreaterThanOrEqual(1);
    expect(bonus).toBeLessThanOrEqual(4);
    expect(npcBlessBonus(plain)).toBe(0);
    const def = bugbear();
    expect(npcSaveMod(blessed, def, 'wis')).toBeGreaterThanOrEqual(1);  // +0 wis mod + 1d4 bless
  });
});
