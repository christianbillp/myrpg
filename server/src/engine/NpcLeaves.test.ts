/**
 * `npc_leaves` + the WorldTick leaving pass. A flagged NPC walks toward the
 * nearest map edge on each exploration tick (emitting entity_move steps the
 * client animates) and is removed from the encounter once it reaches the edge —
 * a visible exit, not an in-place vanish. Used for non-lethal "the bandits
 * withdraw" resolutions.
 */
import { describe, it, expect } from 'vitest';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import { runOffCameraTick } from './WorldTick.js';
import { fireAction } from './TriggerSystem.js';
import type { GameEvent } from './types.js';

describe('npc_leaves — walk to the edge, then remove', () => {
  it('steps the NPC to the nearest edge over ticks, emitting moves, then removes it', () => {
    // 20-wide map; NPC near the right edge (x:16) so "nearest edge" is the right
    // side. Place the player far away so nothing interferes.
    const { ctx, state } = buildTestContext({
      phase: 'exploring',
      player: { tileX: 1, tileY: 1 },
      npcs: [makeNpc({ id: 'bandit_1', defId: 'bandit', tileX: 16, tileY: 10, disposition: 'neutral' })],
    });

    // Flag it to leave via the real trigger action.
    fireAction(ctx, { type: 'npc_leaves', defId: 'bandit' });
    expect(state.npcs[0].leaving).toBe(true);

    const moves: GameEvent[] = [];
    let removed = false;
    for (let i = 0; i < 6 && !removed; i++) {
      const events = runOffCameraTick(ctx);
      moves.push(...events.filter((e) => e.type === 'entity_move' && (e as { entityId: string }).entityId === 'bandit_1'));
      removed = !state.npcs.some((n) => n.id === 'bandit_1');
    }

    // It animated its way out (at least one step) and is gone from the encounter.
    expect(moves.length).toBeGreaterThan(0);
    expect(removed).toBe(true);
    expect(state.npcs.some((n) => n.id === 'bandit_1')).toBe(false);
  });

  it('reaches the edge within a single tick when close enough (brisk exit)', () => {
    const { ctx, state } = buildTestContext({
      phase: 'exploring',
      player: { tileX: 1, tileY: 1 },
      npcs: [makeNpc({ id: 'bandit_1', defId: 'bandit', tileX: 16, tileY: 10, disposition: 'neutral' })],
    });
    fireAction(ctx, { type: 'npc_leaves', defId: 'bandit' });
    // Map default is 20x20 → right edge is x:19, three tiles away, well under the
    // per-tick budget, so one tick clears it.
    runOffCameraTick(ctx);
    expect(state.npcs.some((n) => n.id === 'bandit_1')).toBe(false);
  });
});
