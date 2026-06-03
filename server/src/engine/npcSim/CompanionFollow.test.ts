/**
 * Integration test: registerCompanionFollowHooks should subscribe to
 * `player_moved` and step the companion one tile toward the new player
 * tile (when outside follow tolerance), pushing an `entity_move` event
 * into `ctx.eventSink`.
 */
import { describe, it, expect } from 'vitest';
import { registerCompanionFollowHooks } from './CompanionFollow.js';
import { buildTestContext, makeNpc } from '../../test/buildTestContext.js';
import type { NpcState } from '../types.js';

function withCompanion(npc: Partial<NpcState> & { id: string }, mode: 'tight' | 'loose' = 'loose'): NpcState {
  return makeNpc({
    ...npc,
    companion: npc.companion ?? {
      followMode: mode,
      simState: { activeTaskId: null, lastTickId: 0 },
    },
  });
}

describe('registerCompanionFollowHooks', () => {
  it('steps the companion 1 tile toward player on player_moved (loose, outside tol)', () => {
    const { ctx, state, events } = buildTestContext({
      player: { tileX: 10, tileY: 10 },
      npcs: [withCompanion({ id: 'c', tileX: 4, tileY: 10 }, 'loose')],
    });
    registerCompanionFollowHooks(ctx);
    ctx.publish({ type: 'player_moved', x: 10, y: 10 });
    const npc = state.npcs[0]!;
    expect(npc.tileX).toBe(5);
    expect(npc.tileY).toBe(10);
    expect(events).toContainEqual({ type: 'entity_move', entityId: 'c', toX: 5, toY: 10 });
  });

  it('does not step when companion is within tolerance', () => {
    const { ctx, state, events } = buildTestContext({
      player: { tileX: 10, tileY: 10 },
      npcs: [withCompanion({ id: 'c', tileX: 13, tileY: 10 }, 'loose')], // cheby 3, tol 4
    });
    registerCompanionFollowHooks(ctx);
    ctx.publish({ type: 'player_moved', x: 10, y: 10 });
    expect(state.npcs[0]!.tileX).toBe(13);
    expect(events).toHaveLength(0);
  });

  it('respects WAIT override (no movement even when far)', () => {
    const { ctx, state, events } = buildTestContext({
      player: { tileX: 10, tileY: 10 },
      npcs: [withCompanion({
        id: 'c',
        tileX: 1, tileY: 10,
        companion: {
          followMode: 'loose',
          override: { kind: 'wait' },
          simState: { activeTaskId: null, lastTickId: 0 },
        },
      })],
    });
    registerCompanionFollowHooks(ctx);
    ctx.publish({ type: 'player_moved', x: 10, y: 10 });
    expect(state.npcs[0]!.tileX).toBe(1);
    expect(events).toHaveLength(0);
  });

  it('does nothing during combat phase (sim only ticks in exploring)', () => {
    const { ctx, state, events } = buildTestContext({
      phase: 'player_turn',
      player: { tileX: 10, tileY: 10 },
      npcs: [withCompanion({ id: 'c', tileX: 1, tileY: 10 }, 'loose')],
    });
    registerCompanionFollowHooks(ctx);
    ctx.publish({ type: 'player_moved', x: 10, y: 10 });
    expect(state.npcs[0]!.tileX).toBe(1);
    expect(events).toHaveLength(0);
  });

  it('skips dead companions', () => {
    const { ctx, state, events } = buildTestContext({
      player: { tileX: 10, tileY: 10 },
      npcs: [withCompanion({ id: 'c', tileX: 1, tileY: 10, hp: 0 }, 'loose')],
    });
    registerCompanionFollowHooks(ctx);
    ctx.publish({ type: 'player_moved', x: 10, y: 10 });
    expect(state.npcs[0]!.tileX).toBe(1);
    expect(events).toHaveLength(0);
  });

  it('refuses to step onto another NPC', () => {
    const { ctx, state, events } = buildTestContext({
      player: { tileX: 10, tileY: 10 },
      npcs: [
        withCompanion({ id: 'c', tileX: 1, tileY: 10 }, 'loose'),
        makeNpc({ id: 'blocker', tileX: 2, tileY: 10 }),
      ],
    });
    registerCompanionFollowHooks(ctx);
    ctx.publish({ type: 'player_moved', x: 10, y: 10 });
    expect(state.npcs[0]!.tileX).toBe(1); // unchanged
    expect(events).toHaveLength(0);
  });

  it('honors tight tolerance (1 tile gap allowed)', () => {
    const { ctx, state, events } = buildTestContext({
      player: { tileX: 10, tileY: 10 },
      npcs: [withCompanion({ id: 'c', tileX: 12, tileY: 10 }, 'tight')],
    });
    registerCompanionFollowHooks(ctx);
    ctx.publish({ type: 'player_moved', x: 10, y: 10 });
    expect(state.npcs[0]!.tileX).toBe(11); // cheby 2 > tol 1 → step
    expect(events).toHaveLength(1);
  });
});
