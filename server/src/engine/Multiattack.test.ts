/**
 * US-112 — NPC Multiattack.
 *
 * `runEnemyTurn` rolls `MonsterDef.multiattack` separate attacks against the
 * target with the same Advantage state, returning the extras for the caller to
 * apply after the primary. The count is deterministic regardless of hit/miss.
 */
import { describe, it, expect } from 'vitest';
import { runEnemyTurn, type EnemyTurnConfig } from './EnemyAI.js';
import { makeNpc } from '../test/buildTestContext.js';
import type { MonsterDef } from './types.js';

function claws(multiattack?: number): MonsterDef {
  return {
    id: 'bear', name: 'Bear', type: 'Large Beast', maxHp: 40, ac: 12,
    str: 18, dex: 10, con: 14, int: 2, wis: 12, cha: 6,
    proficiencyBonus: 2, initiativeBonus: 0, stealthBonus: 0, passivePerception: 13,
    speed: 40,
    attacks: [{ name: 'Claw', attackType: 'melee', bonus: 100, reach: 5, damageDice: 1, damageSides: 4, damageBonus: 2, damageType: 'slashing' }],
    multiattack, xp: 200, cr: '1', color: 0x664422, tokenAsset: 'x.svg', size: 'large',
  } as MonsterDef;
}

function config(): EnemyTurnConfig {
  const grid = Array.from({ length: 5 }, () => new Array<boolean>(5).fill(false));
  return {
    displayName: 'Bear',
    target: {
      id: 'player', displayName: 'Hero', tileX: 1, tileY: 0, ac: 10, hp: 50,
      hidden: false, dodging: false, invisible: false, conditions: [], passivePerception: 10,
    },
    blocksMovement: grid, mapCols: 5, mapRows: 5, occupiedTiles: [],
  };
}

describe('NPC Multiattack (US-112)', () => {
  it('rolls multiattack − 1 extra attacks beyond the primary', () => {
    const enemy = makeNpc({ id: 'bear', tileX: 0, tileY: 0, disposition: 'enemy' });
    const result = runEnemyTurn(enemy, claws(3), config());
    expect(result.attacked).toBe(true);
    expect(result.extraAttacks?.length).toBe(2);
  });

  it('produces no extra attacks for a single-attack creature', () => {
    const enemy = makeNpc({ id: 'bear', tileX: 0, tileY: 0, disposition: 'enemy' });
    const result = runEnemyTurn(enemy, claws(), config());
    expect(result.extraAttacks?.length ?? 0).toBe(0);
  });

  it('treats multiattack 1 the same as no multiattack', () => {
    const enemy = makeNpc({ id: 'bear', tileX: 0, tileY: 0, disposition: 'enemy' });
    const result = runEnemyTurn(enemy, claws(1), config());
    expect(result.extraAttacks?.length ?? 0).toBe(0);
  });

  it('all attacks share the primary damage type', () => {
    const enemy = makeNpc({ id: 'bear', tileX: 0, tileY: 0, disposition: 'enemy' });
    const result = runEnemyTurn(enemy, claws(2), config());
    expect(result.damageType).toBe('slashing');
    expect(result.extraAttacks![0].damageType).toBe('slashing');
  });
});
