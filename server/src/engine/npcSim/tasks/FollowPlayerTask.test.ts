/**
 * Pure-function tests for FollowPlayerTask.
 *
 * The task layer is the leaf of the sim — no I/O, no bus, no engine
 * lifecycle. A `SimContext` is enough; we don't even need an EventBus
 * since `score`/`nextAction` don't publish events.
 */
import { describe, it, expect } from 'vitest';
import { FollowPlayerTask } from './FollowPlayerTask.js';
import { WalkOneTileAction } from '../actions/WalkOneTileAction.js';
import { buildTestContext, makeNpc } from '../../../test/buildTestContext.js';
import { SimRng } from '../SimRng.js';

function makeSim(playerXY: [number, number], npcXY: [number, number]) {
  const { ctx, events } = buildTestContext({
    player: { tileX: playerXY[0], tileY: playerXY[1] },
    npcs: [makeNpc({ id: 'companion', tileX: npcXY[0], tileY: npcXY[1] })],
  });
  const npc = ctx.state.npcs[0]!;
  return {
    ctx,
    npc,
    events,
    sim: {
      ctx, npc,
      rng: SimRng.forNpcTick(1, npc.id),
      events,
      tickId: 1,
    },
  };
}

describe('FollowPlayerTask.score', () => {
  it('returns 0 when companion is on the player tile (tight)', () => {
    const { sim } = makeSim([5, 5], [5, 5]);
    const task = new FollowPlayerTask('tight');
    expect(task.score(sim)).toBe(0);
  });

  it('returns 0 when companion is within tight tolerance (1 tile)', () => {
    const { sim } = makeSim([5, 5], [6, 5]);
    expect(new FollowPlayerTask('tight').score(sim)).toBe(0);
  });

  it('returns positive score when companion is outside tight tolerance', () => {
    const { sim } = makeSim([5, 5], [8, 5]);
    expect(new FollowPlayerTask('tight').score(sim)).toBe(2); // cheby 3, tol 1
  });

  it('honors loose tolerance (4 tiles)', () => {
    const { sim } = makeSim([5, 5], [9, 5]);
    expect(new FollowPlayerTask('loose').score(sim)).toBe(0); // cheby 4, tol 4
  });

  it('uses Chebyshev distance (diagonals count as 1)', () => {
    const { sim } = makeSim([5, 5], [8, 8]);
    expect(new FollowPlayerTask('tight').score(sim)).toBe(2); // cheby 3, tol 1
  });
});

describe('FollowPlayerTask.nextAction', () => {
  it('returns "done" when already within tolerance', () => {
    const { sim } = makeSim([5, 5], [5, 5]);
    expect(new FollowPlayerTask('loose').nextAction(sim)).toBe('done');
  });

  it('returns a WalkOneTileAction toward the player when out of range', () => {
    const { sim } = makeSim([5, 5], [10, 5]);
    const step = new FollowPlayerTask('tight').nextAction(sim);
    expect(step).toBeInstanceOf(WalkOneTileAction);
  });

  it('moves diagonally when both axes differ', () => {
    const { sim } = makeSim([5, 5], [10, 10]);
    const action = new FollowPlayerTask('tight').nextAction(sim) as WalkOneTileAction;
    // Apply and check the NPC's new tile.
    action.apply(sim);
    expect(sim.npc.tileX).toBe(9);
    expect(sim.npc.tileY).toBe(9);
  });

  it('stops moving once it reaches the player tile (tight, same tile)', () => {
    const { sim } = makeSim([5, 5], [5, 5]);
    expect(new FollowPlayerTask('tight').nextAction(sim)).toBe('done');
  });
});
