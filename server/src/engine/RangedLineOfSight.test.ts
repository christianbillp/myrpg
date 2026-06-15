/**
 * Ranged attacks respect line of sight — you can't shoot through a tile that
 * blocks vision, including the seam where two walls meet at a corner (SRD Total
 * Cover: "can't be targeted directly").
 *
 * The straight-line case was already handled (`walkLOS` treats a `blocksSight`
 * tile as total cover); these lock in the diagonal corner-cutting fix and the
 * attack-path gates (`canAttackTarget` disables the button; `doAttack` is a
 * no-op that wastes no ammunition).
 */
import { describe, it, expect } from 'vitest';
import { canSee } from './Vision.js';
import { doAttack } from './CombatActions.js';
import { canAttackTarget } from './ActionGuards.js';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import type { MonsterDef, PlayerAttack } from './types.js';

const BOW: PlayerAttack = {
  name: 'Bow', statKey: 'dex', damageDice: 1, damageSides: 8, damageType: 'piercing',
  rangeNormal: 80, rangeLong: 320, ammunitionType: 'arrow',
  savageAttacker: false, finesse: false, graze: false, vex: false, sap: false, slow: false, push: false, topple: false,
} as unknown as PlayerAttack;

function dummy(): MonsterDef {
  return {
    id: 'dummy', name: 'Dummy', type: 'Medium Humanoid', maxHp: 80, ac: 1,
    str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10, proficiencyBonus: 2, initiativeBonus: 0,
    stealthBonus: 0, passivePerception: 10, speed: 30, attacks: [], xp: 0, cr: '1', color: 0x888888, tokenAsset: 'x.svg', size: 'medium',
  } as MonsterDef;
}

function los(walls: Array<[number, number]>, target: [number, number]) {
  const { state } = buildTestContext({ player: { tileX: 0, tileY: 0 } });
  state.environment = { lightLevel: 'bright' };
  for (const [wx, wy] of walls) state.map.blocksSight[wy][wx] = true;
  return canSee(
    state,
    { tileX: 0, tileY: 0, senses: undefined },
    { tileX: target[0], tileY: target[1], conditions: [], id: 'x' },
  );
}

describe('ranged line of sight (Vision corner-cutting)', () => {
  it('blocks a straight line through a sight-blocking tile', () => {
    expect(los([[2, 0]], [4, 0]).cover).toBe('total');
  });

  it('blocks a diagonal squeeze between two walls meeting at a corner', () => {
    // Shooter (0,0) → target (2,2); walls at (1,0) and (0,1) flank the diagonal.
    expect(los([[1, 0], [0, 1]], [2, 2]).cover).toBe('total');
    // Same seam at point-blank diagonal.
    expect(los([[1, 0], [0, 1]], [1, 1]).cover).toBe('total');
  });

  it('still allows shooting PAST a single off-line wall corner', () => {
    // Only one flanking wall — the shot threads past it legitimately.
    expect(los([[1, 1]], [2, 1]).sees).toBe(true);
  });
});

describe('ranged attack respects line of sight (attack-path gates)', () => {
  function scenario(walls: Array<[number, number]>, enemyTile: [number, number]) {
    const r = buildTestContext({
      phase: 'player_turn',
      player: { tileX: 0, tileY: 0, inventoryIds: ['arrow', 'arrow', 'arrow'] },
      playerDef: { mainAttack: BOW, dex: 16, proficiencyBonus: 3 },
      monsters: [dummy()],
      npcs: [makeNpc({ id: 'enemy_x', defId: 'dummy', tileX: enemyTile[0], tileY: enemyTile[1], disposition: 'enemy', hp: 80, maxHp: 80 })],
    });
    r.state.environment = { lightLevel: 'bright' };
    r.state.selectedTargetId = 'enemy_x';
    for (const [wx, wy] of walls) r.state.map.blocksSight[wy][wx] = true;
    return r;
  }

  it('canAttackTarget is false when the target is behind total cover', () => {
    const { ctx } = scenario([[2, 0]], [4, 0]);
    expect(canAttackTarget(ctx, 'enemy_x')).toBe(false);
  });

  it('a blocked shot deals no damage and wastes no ammunition', () => {
    const { ctx, state, events } = scenario([[2, 0]], [4, 0]);
    const hp0 = state.npcs[0].hp;
    const arrows0 = state.player.inventoryIds.filter((i) => i === 'arrow').length;
    doAttack(ctx, 'enemy_x', events);
    expect(state.npcs[0].hp).toBe(hp0);                                              // no damage
    expect(state.player.inventoryIds.filter((i) => i === 'arrow').length).toBe(arrows0); // no ammo spent
  });

  it('the diagonal corner seam blocks the shot too', () => {
    const { ctx } = scenario([[1, 0], [0, 1]], [2, 2]);
    expect(canAttackTarget(ctx, 'enemy_x')).toBe(false);
  });

  it('a clear ranged shot still lands', () => {
    const { ctx, state, events } = scenario([], [4, 0]);
    let everHit = false;
    for (let i = 0; i < 40 && !everHit; i++) {
      const before = state.npcs[0].hp;
      doAttack(ctx, 'enemy_x', events);
      if (state.npcs[0].hp < before) everHit = true;
      state.player.actionUsed = false;                       // refresh for the next swing
      state.player.inventoryIds.push('arrow');
    }
    expect(everHit).toBe(true);
  });
});
