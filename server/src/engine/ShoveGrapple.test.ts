/**
 * US-050 Shove + US-110 Grapple — Unarmed Strike options.
 *
 * Target makes the better of its STR/DEX save vs DC 8 + player STR mod + PB,
 * and must be ≤ one size larger than the player. Save outcomes are forced
 * deterministically: a huge DC (high player STR/PB, save mod 0) always fails;
 * a huge save mod always succeeds.
 */
import { describe, it, expect } from 'vitest';
import { doShove, doGrapple } from './CombatActions.js';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import type { MonsterDef } from './types.js';

function monster(extra: Partial<MonsterDef> = {}): MonsterDef {
  return {
    id: 'orc', name: 'Orc', type: 'Medium Humanoid', maxHp: 30, ac: 13,
    str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10,
    proficiencyBonus: 2, initiativeBonus: 0, stealthBonus: 0, passivePerception: 10,
    speed: 30, attacks: [], xp: 50, cr: '1/2', color: 0x556b2f, tokenAsset: 'x.svg',
    size: 'medium', ...extra,
  } as MonsterDef;
}

/** Scenario where the target ALWAYS fails the save (DC 24 vs save mod 0). */
function failScenario(monsterExtra: Partial<MonsterDef> = {}) {
  const r = buildTestContext({
    phase: 'player_turn',
    player: { tileX: 0, tileY: 0 },
    playerDef: { str: 30, proficiencyBonus: 6, size: 'medium' },  // DC = 8 + 10 + 6 = 24
    monsters: [monster(monsterExtra)],
    npcs: [makeNpc({ id: 'enemy_x', defId: 'orc', tileX: 1, tileY: 0, disposition: 'enemy', hp: 30, maxHp: 30, size: monsterExtra.size as never ?? 'medium' })],
  });
  r.state.environment = { lightLevel: 'bright' };
  return r;
}

describe('Shove (US-050)', () => {
  it('pushes the target 5 ft (1 tile) directly away on a failed save', () => {
    const { ctx, state, events } = failScenario();
    doShove(ctx, 'enemy_x', 'push');
    expect(state.npcs[0].tileX).toBe(2);   // pushed from (1,0) → (2,0)
    expect(state.player.actionUsed).toBe(true);
    void events;
  });

  it('knocks the target Prone on a failed save when prone is chosen', () => {
    const { ctx, state } = failScenario();
    doShove(ctx, 'enemy_x', 'prone');
    expect(state.npcs[0].conditions).toContain('prone');
    expect(state.npcs[0].tileX).toBe(1);   // not moved
  });

  it('does nothing to a target that succeeds the save', () => {
    const r = buildTestContext({
      phase: 'player_turn',
      player: { tileX: 0, tileY: 0 },
      playerDef: { str: 10, proficiencyBonus: 2, size: 'medium' },  // DC 10
      monsters: [monster({ savingThrows: { str: 20, dex: 20, con: 0, int: 0, wis: 0, cha: 0 } })],
      npcs: [makeNpc({ id: 'enemy_x', defId: 'orc', tileX: 1, tileY: 0, disposition: 'enemy', hp: 30, maxHp: 30, size: 'medium' })],
    });
    r.state.environment = { lightLevel: 'bright' };
    doShove(r.ctx, 'enemy_x', 'push');
    expect(r.state.npcs[0].tileX).toBe(1);  // held firm
    expect(r.state.player.actionUsed).toBe(true);  // action still spent
  });
});

describe('Grapple (US-110)', () => {
  it('applies the Grappled condition on a failed save', () => {
    const { ctx, state } = failScenario();
    doGrapple(ctx, 'enemy_x');
    expect(state.npcs[0].conditions).toContain('grappled');
    expect(state.player.actionUsed).toBe(true);
  });

  it('refuses a target more than one size larger (size gate)', () => {
    const { ctx, state } = failScenario({ size: 'gargantuan' });
    doGrapple(ctx, 'enemy_x');
    expect(state.npcs[0].conditions).not.toContain('grappled');
    expect(state.player.actionUsed).toBe(false);  // no eligible target → action not spent
  });

  it('won\'t re-grapple an already-grappled target', () => {
    const { ctx, state } = failScenario();
    state.npcs[0].conditions.push('grappled');
    doGrapple(ctx, 'enemy_x');
    expect(state.player.actionUsed).toBe(false);  // no eligible target
  });
});
