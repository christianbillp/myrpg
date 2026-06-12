/**
 * US-124 — NPC ranged attacks. `runEnemyTurn` charges into melee when it can
 * reach adjacency this turn, and otherwise shoots a ranged option: holding at
 * normal range, taking long shots (Disadvantage) out to long range, refusing
 * shots through Total Cover, and falling back to point-blank shots only for
 * ranged-only creatures. `runAllyTurn` gets the same fallback when its target
 * is out of melee reach.
 */
import { describe, it, expect } from 'vitest';
import { runEnemyTurn, runAllyTurn, type EnemyTurnConfig } from './EnemyAI.js';
import { makeNpc } from '../test/buildTestContext.js';
import type { MonsterDef, MonsterAttack } from './types.js';

const SWORD: MonsterAttack = { name: 'Shortsword', attackType: 'melee', bonus: 5, reach: 5, damageDice: 1, damageSides: 6, damageBonus: 3, damageType: 'slashing' };
const BOW: MonsterAttack = { name: 'Shortbow', attackType: 'ranged', bonus: 5, reach: 5, rangeNormal: 80, rangeLong: 320, damageDice: 1, damageSides: 6, damageBonus: 3, damageType: 'piercing' };

function archer(attacks: MonsterAttack[], speed = 30): MonsterDef {
  return {
    id: 'archer', name: 'Archer', type: 'Medium Undead, Lawful Evil', maxHp: 13, ac: 14,
    str: 10, dex: 16, con: 15, int: 6, wis: 8, cha: 5,
    proficiencyBonus: 2, initiativeBonus: 3, stealthBonus: 3, passivePerception: 9,
    speed, attacks, xp: 50, cr: '1/4', color: 0, tokenAsset: 'x.svg', size: 'medium',
  } as MonsterDef;
}

function config(targetX: number, coverAc?: number): EnemyTurnConfig {
  const cols = 24;
  const grid = Array.from({ length: 5 }, () => new Array<boolean>(cols).fill(false));
  return {
    displayName: 'Archer',
    target: {
      id: 'player', displayName: 'Hero', tileX: targetX, tileY: 0, ac: 10, hp: 50,
      hidden: false, dodging: false, invisible: false, conditions: [], passivePerception: 10,
    },
    blocksMovement: grid, mapCols: cols, mapRows: 5, occupiedTiles: [],
    coverFor: coverAc === undefined ? undefined : () => coverAc,
  };
}

describe('NPC ranged attacks (US-124)', () => {
  it('shoots from range instead of marching when melee is unreachable this turn', () => {
    const enemy = makeNpc({ id: 'a', tileX: 0, tileY: 0, disposition: 'enemy' });
    const result = runEnemyTurn(enemy, archer([SWORD, BOW]), config(10));  // dist 10, speed 6 tiles
    expect(result.attacked).toBe(true);
    expect(result.attackKind).toBe('ranged');
    expect(result.damageType).toBe('piercing');
    expect(result.finalTileX).toBe(0);  // already inside normal range — holds position
  });

  it('charges into melee when adjacency is reachable this turn', () => {
    const enemy = makeNpc({ id: 'a', tileX: 0, tileY: 0, disposition: 'enemy' });
    const result = runEnemyTurn(enemy, archer([SWORD, BOW]), config(4));  // dist 4, speed 6 tiles
    expect(result.attacked).toBe(true);
    expect(result.attackKind).toBe('melee');
    expect(result.damageType).toBe('slashing');
  });

  it('uses melee when starting adjacent', () => {
    const enemy = makeNpc({ id: 'a', tileX: 0, tileY: 0, disposition: 'enemy' });
    const result = runEnemyTurn(enemy, archer([SWORD, BOW]), config(1));
    expect(result.attackKind).toBe('melee');
  });

  it('takes the long shot between normal and long range', () => {
    const shortBow: MonsterAttack = { ...BOW, rangeNormal: 10, rangeLong: 60 };  // 2 / 12 tiles
    const enemy = makeNpc({ id: 'a', tileX: 0, tileY: 0, disposition: 'enemy' });
    const result = runEnemyTurn(enemy, archer([shortBow], 5), config(10));  // 1 step → dist 9 > normal 2, ≤ long 12
    expect(result.attacked).toBe(true);
    expect(result.attackKind).toBe('ranged');
  });

  it('makes no attack beyond long range', () => {
    const shortBow: MonsterAttack = { ...BOW, rangeNormal: 10, rangeLong: 20 };  // 2 / 4 tiles
    const enemy = makeNpc({ id: 'a', tileX: 0, tileY: 0, disposition: 'enemy' });
    const result = runEnemyTurn(enemy, archer([shortBow], 5), config(15));
    expect(result.attacked).toBe(false);
  });

  it('refuses to shoot through Total Cover', () => {
    const enemy = makeNpc({ id: 'a', tileX: 0, tileY: 0, disposition: 'enemy' });
    const result = runEnemyTurn(enemy, archer([BOW]), config(10, 99));
    expect(result.attacked).toBe(false);
  });

  it('a ranged-only creature shoots point-blank when adjacent', () => {
    const enemy = makeNpc({ id: 'a', tileX: 0, tileY: 0, disposition: 'enemy' });
    const result = runEnemyTurn(enemy, archer([BOW]), config(1));
    expect(result.attacked).toBe(true);
    expect(result.attackKind).toBe('ranged');
  });

  it('allies fall back to a ranged attack when melee is out of reach', () => {
    const ally = makeNpc({ id: 'b', tileX: 0, tileY: 0, disposition: 'ally' });
    const grid = Array.from({ length: 5 }, () => new Array<boolean>(24).fill(false));
    const result = runAllyTurn(ally, archer([SWORD, BOW], 5), {
      displayName: 'Archer',
      enemyTargets: [{ id: 'e1', tileX: 8, tileY: 0, ac: 10, conditions: [] }],
      blocksMovement: grid, mapCols: 24, mapRows: 5, occupiedTiles: [],
    });
    expect(result.attacked).toBe(true);
    expect(result.attackedTargetId).toBe('e1');
  });
});
