/**
 * Enemy roles (Tactical Crucible #35) — role resolution + the three v1 behaviors:
 * target priority (brute/artillery focus the weakest), range-holding/kiting
 * movement, and leader morale.
 */
import { describe, it, expect } from 'vitest';
import { resolveMonsterRole, inferMonsterRole, rolePrefersRange, factionHasLivingLeader } from './MonsterRoles.js';
import { stepAwayFrom, runEnemyTurn, type EnemyAttackTarget } from './EnemyAI.js';
import { pickEnemyAttackTarget, npcWouldYield } from './NpcTurnRunners.js';
import { tryNpcRoleHeal } from './NpcSupportRole.js';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import type { MonsterDef, MonsterAttack } from './types.js';

function atk(o: Partial<MonsterAttack>): MonsterAttack {
  return { name: 'A', attackType: 'melee', bonus: 4, reach: 5, damageDice: 1, damageSides: 6, damageBonus: 2, damageType: 'slashing', ...o } as MonsterAttack;
}
function mdef(o: Partial<MonsterDef>): MonsterDef {
  return {
    id: 'm', name: 'M', type: 'Medium Humanoid', maxHp: 20, ac: 12,
    str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10, proficiencyBonus: 2, initiativeBonus: 1,
    stealthBonus: 0, passivePerception: 10, speed: 30, attacks: [atk({})], xp: 50, cr: '1/2',
    color: 0x999, tokenAsset: 'm.svg', size: 'medium', ...o,
  } as MonsterDef;
}

describe('role resolution (#35)', () => {
  it('authored role wins; otherwise inferred from the stat block', () => {
    expect(resolveMonsterRole(mdef({ role: 'leader', attacks: [atk({})] }))).toBe('leader');
    // pure shooter → artillery
    expect(inferMonsterRole(mdef({ attacks: [atk({ attackType: 'ranged', rangeNormal: 80 })] }))).toBe('artillery');
    // strong melee, no ranged → brute
    expect(inferMonsterRole(mdef({ attacks: [atk({ damageDice: 2, damageSides: 8, damageBonus: 4 })] }))).toBe('brute'); // 13 avg
    // weak mixed → soldier
    expect(inferMonsterRole(mdef({ attacks: [atk({}), atk({ attackType: 'ranged', rangeNormal: 30 })] }))).toBe('soldier');
  });

  it('rolePrefersRange: artillery always; skirmisher/support only with a ranged option', () => {
    expect(rolePrefersRange('artillery', false)).toBe(true);
    expect(rolePrefersRange('skirmisher', true)).toBe(true);
    expect(rolePrefersRange('skirmisher', false)).toBe(false);
    expect(rolePrefersRange('support', true)).toBe(true);
    expect(rolePrefersRange('support', false)).toBe(false);
    expect(rolePrefersRange('brute', true)).toBe(false);
  });
});

describe('controller targeting (#35 v2)', () => {
  it('fixates on the player over a nearer NPC foe', () => {
    const { ctx, state } = buildTestContext({
      player: { tileX: 8, tileY: 0, hp: 20 },              // far
      monsters: [mdef({ id: 'ctrl', role: 'controller' })],
      npcs: [
        makeNpc({ id: 'atkr', defId: 'ctrl', tileX: 0, tileY: 0, disposition: 'enemy', hp: 20, maxHp: 20 }),
        makeNpc({ id: 'foe1', defId: 'x', tileX: 1, tileY: 0, disposition: 'ally', factionId: 'party', hp: 20, maxHp: 20 }), // nearer
      ],
    });
    const pick = pickEnemyAttackTarget(ctx, state.npcs[0]);
    expect(pick.id).toBe('player');   // locks the spellcaster, not the nearest body
  });

  it('sticks to a target it has already grappled', () => {
    const { ctx, state } = buildTestContext({
      player: { tileX: 1, tileY: 0, hp: 20 },              // adjacent, NOT grappled
      monsters: [mdef({ id: 'ctrl', role: 'controller' })],
      npcs: [
        makeNpc({ id: 'atkr', defId: 'ctrl', tileX: 0, tileY: 0, disposition: 'enemy', hp: 20, maxHp: 20 }),
        makeNpc({ id: 'victim', defId: 'x', tileX: 5, tileY: 0, disposition: 'ally', factionId: 'party', hp: 20, maxHp: 20, grappledBy: 'atkr' }),
      ],
    });
    const pick = pickEnemyAttackTarget(ctx, state.npcs[0]);
    expect(pick.id).toBe('victim');   // stays on the one it has locked down
  });
});

describe('support-role heal (#35 v2)', () => {
  it('mends the most-wounded ally in reach and consumes a use', () => {
    const { ctx, state } = buildTestContext({
      monsters: [mdef({ id: 'shaman', role: 'support', supportHeal: { name: 'Bind Wounds', dice: 2, sides: 4, bonus: 2, uses: 1 } })],
      npcs: [
        makeNpc({ id: 'heal', defId: 'shaman', tileX: 5, tileY: 5, disposition: 'enemy', hp: 20, maxHp: 20, factionId: 'bandits' }),
        makeNpc({ id: 'hurt', defId: 'x', tileX: 6, tileY: 5, disposition: 'enemy', hp: 3, maxHp: 20, factionId: 'bandits' }),
      ],
    });
    const shaman = state.npcs[0];
    const def = mdef({ id: 'shaman', role: 'support', supportHeal: { name: 'Bind Wounds', dice: 2, sides: 4, bonus: 2, uses: 1 } });

    expect(tryNpcRoleHeal(ctx, shaman, def)).toBe(true);
    expect(state.npcs[1].hp).toBeGreaterThan(3);
    expect(shaman.supportHealUsed).toBe(1);

    // No uses left → no-op.
    expect(tryNpcRoleHeal(ctx, shaman, def)).toBe(false);
  });

  it('does nothing when no ally is bloodied', () => {
    const { ctx, state } = buildTestContext({
      monsters: [mdef({ id: 'shaman', role: 'support', supportHeal: { name: 'Bind Wounds', dice: 2, sides: 4 } })],
      npcs: [
        makeNpc({ id: 'heal', defId: 'shaman', tileX: 5, tileY: 5, disposition: 'enemy', hp: 20, maxHp: 20, factionId: 'bandits' }),
        makeNpc({ id: 'fine', defId: 'x', tileX: 6, tileY: 5, disposition: 'enemy', hp: 19, maxHp: 20, factionId: 'bandits' }),
      ],
    });
    const def = mdef({ id: 'shaman', role: 'support', supportHeal: { name: 'Bind Wounds', dice: 2, sides: 4 } });
    expect(tryNpcRoleHeal(ctx, state.npcs[0], def)).toBe(false);
  });
});

describe('target priority (#35)', () => {
  it('a brute targets the most-wounded foe, not the nearest', () => {
    const { ctx, state } = buildTestContext({
      player: { tileX: 1, tileY: 0, hp: 20 },             // nearest, healthy
      monsters: [mdef({ id: 'brute', role: 'brute' })],
      npcs: [
        makeNpc({ id: 'atkr', defId: 'brute', tileX: 0, tileY: 0, disposition: 'enemy', hp: 20, maxHp: 20 }),
        makeNpc({ id: 'ally1', defId: 'x', tileX: 4, tileY: 0, disposition: 'ally', factionId: 'party', hp: 3, maxHp: 20 }), // farther, wounded
      ],
    });
    const pick = pickEnemyAttackTarget(ctx, state.npcs[0]);
    expect(pick.id).toBe('ally1');   // focuses the bloodied one over the nearer healthy player
  });
});

describe('leader morale (#35)', () => {
  function squad(leaderAlive: boolean) {
    return buildTestContext({
      monsters: [mdef({ id: 'capt', role: 'leader' }), mdef({ id: 'grunt' })],
      npcs: [
        makeNpc({ id: 'g1', defId: 'grunt', tileX: 5, tileY: 5, disposition: 'enemy', hp: 3, maxHp: 20, factionId: 'bandits' }),  // bloodied, last grunt
        makeNpc({ id: 'cap', defId: 'capt', tileX: 6, tileY: 5, disposition: 'enemy', hp: leaderAlive ? 20 : 0, maxHp: 20, factionId: 'bandits' }),
      ],
    });
  }
  it('a grunt holds while its leader stands; yields once the leader falls', () => {
    const alive = squad(true);
    expect(factionHasLivingLeader(alive.ctx, alive.state.npcs[0])).toBe(true);
    expect(npcWouldYield(alive.ctx, alive.state.npcs[0], mdef({ id: 'grunt' }))).toBe(false);  // leader anchors morale

    const dead = squad(false);
    expect(factionHasLivingLeader(dead.ctx, dead.state.npcs[0])).toBe(false);
    expect(npcWouldYield(dead.ctx, dead.state.npcs[0], mdef({ id: 'grunt' }))).toBe(true);      // leaderless → breaks
  });
});

describe('kiting movement (#35)', () => {
  it('stepAwayFrom moves to a tile farther from the target', () => {
    const open = Array.from({ length: 10 }, () => new Array<boolean>(10).fill(false));
    const away = stepAwayFrom(5, 5, 6, 5, open, 10, 10, []);
    expect(away).not.toBeNull();
    expect(Math.max(Math.abs(away![0] - 6), Math.abs(away![1] - 5))).toBeGreaterThan(1);
  });

  it('an artillery shooter kites out of melee instead of standing adjacent', () => {
    const open = Array.from({ length: 12 }, () => new Array<boolean>(12).fill(false));
    const target: EnemyAttackTarget = {
      id: 'player', displayName: 'P', tileX: 6, tileY: 6, ac: 12, hp: 20,
      hidden: false, dodging: false, invisible: false, conditions: [], passivePerception: 10,
    };
    const enemy = makeNpc({ id: 'archer', defId: 'arch', tileX: 6, tileY: 5, disposition: 'enemy', hp: 13, maxHp: 13 }); // adjacent to target
    const def = mdef({ id: 'arch', role: 'artillery', speed: 30, attacks: [atk({ name: 'Bow', attackType: 'ranged', rangeNormal: 80, rangeLong: 320 })] });
    const r = runEnemyTurn(enemy, def, {
      displayName: 'Archer', target, role: 'artillery',
      blocksMovement: open, mapCols: 12, mapRows: 12, occupiedTiles: [[6, 6]],
    });
    expect(Math.max(Math.abs(r.finalTileX - 6), Math.abs(r.finalTileY - 6))).toBeGreaterThan(1); // backed away
  });
});
