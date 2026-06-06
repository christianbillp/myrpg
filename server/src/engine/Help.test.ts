/**
 * US-057 — Help (Assist an Attack).
 *
 * Spend the Action to distract an adjacent enemy: it gains the `helped` marker,
 * which grants Advantage to the next attack against it (player or ally) and is
 * consumed by that attack. Requires a living ally to benefit.
 */
import { describe, it, expect } from 'vitest';
import { doHelp } from './CombatActions.js';
import { grantsAdvantageAgainst } from './ConditionSystem.js';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import type { MonsterDef } from './types.js';

function orc(): MonsterDef {
  return {
    id: 'orc', name: 'Orc', type: 'Medium Humanoid', maxHp: 15, ac: 13,
    str: 14, dex: 10, con: 12, int: 8, wis: 10, cha: 8,
    proficiencyBonus: 2, initiativeBonus: 0, stealthBonus: 0, passivePerception: 10,
    speed: 30, attacks: [], xp: 50, cr: '1/2', color: 0x556b2f, tokenAsset: 'x.svg', size: 'medium',
  } as MonsterDef;
}

function scenario(withAlly: boolean) {
  const npcs = [makeNpc({ id: 'enemy_x', defId: 'orc', tileX: 1, tileY: 0, disposition: 'enemy', hp: 15, maxHp: 15 })];
  if (withAlly) npcs.push(makeNpc({ id: 'ally_1', defId: 'orc', tileX: 0, tileY: 1, disposition: 'ally', hp: 15, maxHp: 15 }));
  const r = buildTestContext({
    phase: 'player_turn',
    player: { tileX: 0, tileY: 0 },
    monsters: [orc()],
    npcs,
  });
  return r;
}

describe('Help — Assist an Attack (US-057)', () => {
  it('marks the adjacent enemy `helped` (Advantage) and spends the Action', () => {
    const { ctx, state } = scenario(true);
    doHelp(ctx, 'enemy_x');
    expect(state.npcs[0].conditions).toContain('helped');
    expect(grantsAdvantageAgainst(state.npcs[0].conditions, 1)).toBe(true);
    expect(state.player.actionUsed).toBe(true);
  });

  it('does nothing without a living ally to benefit', () => {
    const { ctx, state } = scenario(false);
    doHelp(ctx, 'enemy_x');
    expect(state.npcs[0].conditions).not.toContain('helped');
    expect(state.player.actionUsed).toBe(false);
  });
});
