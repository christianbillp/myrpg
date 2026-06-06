/**
 * US-057 — Ready (Ready an Attack).
 *
 * Spend the Action to reserve a melee strike against the first enemy that
 * closes into your reach this round. The strike fires through the reaction
 * prompt: when an enemy ends a move adjacent to the player, the engine raises
 * a `readied_attack` PendingReaction. Accepting makes the strike and clears the
 * reservation; declining keeps it for a later enemy this round.
 */
import { describe, it, expect } from 'vitest';
import { doReady } from './CombatActions.js';
import { doResolveReaction } from './CombatFlow.js';
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

describe('Ready an Attack (US-057)', () => {
  it('reserves the strike — spends the Action, keeps the Reaction', () => {
    const { ctx, state } = buildTestContext({
      phase: 'player_turn',
      player: { tileX: 0, tileY: 0 },
      monsters: [orc()],
      npcs: [makeNpc({ id: 'enemy_x', defId: 'orc', tileX: 5, tileY: 0, disposition: 'enemy', hp: 15, maxHp: 15 })],
    });
    doReady(ctx);
    expect(state.player.readiedAttack).toBe(true);
    expect(state.player.actionUsed).toBe(true);
    expect(state.player.reactionUsed).toBe(false);
  });

  it('cannot be readied when the Reaction is already spent', () => {
    const { ctx, state } = buildTestContext({
      phase: 'player_turn',
      player: { tileX: 0, tileY: 0, reactionUsed: true },
      monsters: [orc()],
      npcs: [makeNpc({ id: 'enemy_x', defId: 'orc', tileX: 5, tileY: 0, disposition: 'enemy', hp: 15, maxHp: 15 })],
    });
    doReady(ctx);
    expect(state.player.readiedAttack).toBeFalsy();
    expect(state.player.actionUsed).toBe(false);
  });

  it('resolving the readied_attack prompt: accept consumes the reservation', () => {
    const { ctx, state, events } = buildTestContext({
      phase: 'enemy_turn',
      player: { tileX: 0, tileY: 0 },
      monsters: [orc()],
      npcs: [makeNpc({ id: 'enemy_x', defId: 'orc', tileX: 1, tileY: 0, disposition: 'enemy', hp: 15, maxHp: 15, isActive: true })],
    });
    state.player.readiedAttack = true;
    state.pendingReaction = { kind: 'readied_attack', npcId: 'enemy_x', npcName: 'Orc' };
    doResolveReaction(ctx, true, events);
    expect(state.player.readiedAttack).toBe(false);
    expect(state.pendingReaction).toBeNull();
  });

  it('resolving the readied_attack prompt: decline keeps the reservation for a later enemy', () => {
    const { ctx, state, events } = buildTestContext({
      phase: 'enemy_turn',
      player: { tileX: 0, tileY: 0 },
      monsters: [orc()],
      npcs: [makeNpc({ id: 'enemy_x', defId: 'orc', tileX: 1, tileY: 0, disposition: 'enemy', hp: 15, maxHp: 15, isActive: true })],
    });
    state.player.readiedAttack = true;
    state.pendingReaction = { kind: 'readied_attack', npcId: 'enemy_x', npcName: 'Orc' };
    doResolveReaction(ctx, false, events);
    expect(state.player.readiedAttack).toBe(true);
    expect(state.pendingReaction).toBeNull();
  });
});
