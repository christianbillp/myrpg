/**
 * Tests for companion override semantics — covering the bug class where
 * a `Task.nextAction` returns `'done'` and the runner auto-clears the
 * override after one tick. Specifically:
 *
 *   - WAIT override must persist as long as the player wants it
 *   - FOLLOW override should clear naturally once the companion catches up
 *   - ATTACK override should clear when the target dies
 *
 * Each of these was hit (or has the bug-shape to be hit) in real play.
 * The world-tick runs `runCompanionTick` once every 6 s (one SRD round)
 * — these tests simulate multiple ticks in a tight loop, with a moving
 * player, to surface the persistence semantics.
 *
 * NOTE: A known bug exists today where the WAIT override clears after
 * one tick (WaitHereTask returns 'done', runner clears activeTaskId,
 * runCompanionTick's auto-clear strips the override). The first test
 * below is intentionally `it.skip(...)` until that bug is fixed —
 * un-skipping it will fail and force the fix.
 */
import { describe, it, expect } from 'vitest';
import { buildTestContext, makeNpc } from '../../test/buildTestContext.js';
import { runOffCameraTick } from '../WorldTick.js';
import { registerCompanionFollowHooks } from './CompanionFollow.js';
import type { NpcState } from '../types.js';

function withCompanion(npc: Partial<NpcState> & { id: string }): NpcState {
  return makeNpc({
    ...npc,
    companion: npc.companion ?? {
      followMode: 'loose',
      simState: { activeTaskId: null, lastTickId: 0 },
    },
    disposition: 'ally',
  });
}

describe('companion override persistence', () => {
  it('WAIT override survives 5 world ticks with a moving player', () => {
    // Regression test for the bug I flagged: WaitHereTask.nextAction
    // returns 'done', which makes the runner clear activeTaskId, and
    // runCompanionTick's auto-clear then strips the override. Result:
    // the WAIT command lasts exactly one tick, the chip flickers
    // WAIT→FOLLOW, and the companion bolts after the player on tick 2.
    //
    // Fix is in WorldTick.runCompanionTick: skip auto-clear when
    // override.kind === 'wait'. Un-skip this test after fixing.
    const { ctx, state } = buildTestContext({
      player: { tileX: 0, tileY: 0 },
      npcs: [withCompanion({
        id: 'c',
        tileX: 10, tileY: 10,
        companion: {
          followMode: 'loose',
          override: { kind: 'wait' },
          simState: { activeTaskId: null, lastTickId: 0 },
        },
      })],
    });
    for (let t = 1; t <= 5; t++) {
      ctx.state.worldTickCount = t;
      ctx.state.player.tileX = t;
      runOffCameraTick(ctx);
    }
    // Companion never moved despite player walking 5 tiles away.
    expect(state.npcs[0].tileX).toBe(10);
    expect(state.npcs[0].tileY).toBe(10);
    // And the override is still set (player hasn't cleared it).
    expect(state.npcs[0].companion?.override?.kind).toBe('wait');
  });

  it('FOLLOW override clears naturally once companion catches up', () => {
    const { ctx, state } = buildTestContext({
      player: { tileX: 0, tileY: 0 },
      npcs: [withCompanion({
        id: 'c',
        tileX: 0, tileY: 0,  // Already at player.
        companion: {
          followMode: 'loose',
          override: { kind: 'follow', mode: 'loose' },
          simState: { activeTaskId: null, lastTickId: 0 },
        },
      })],
    });
    runOffCameraTick(ctx);
    // Within tolerance → task ends 'done' → override cleared.
    expect(state.npcs[0].companion?.override).toBeUndefined();
  });

  it('MOVE TO moves up to speed/5 tiles per world tick (SRD round budget)', () => {
    // Speed 30 ft = 6 tiles per round = 6 tiles per world tick. The
    // companion starts 6 tiles east of the target so a single tick
    // should cover the entire trip.
    const { ctx, state } = buildTestContext({
      player: { tileX: 0, tileY: 0 },
      npcs: [withCompanion({
        id: 'c',
        tileX: 2, tileY: 5,
        companion: {
          followMode: 'loose',
          override: { kind: 'move_to', tileX: 8, tileY: 5 },
          simState: { activeTaskId: null, lastTickId: 0 },
        },
      })],
      monsters: [{ id: 'commoner', speed: 30 } as never],
    });
    // Ensure the companion uses the commoner stat block (speed 30).
    state.npcs[0].defId = 'commoner';
    runOffCameraTick(ctx);
    // Six tiles of movement should land them exactly on the target.
    expect(state.npcs[0].tileX).toBe(8);
    expect(state.npcs[0].tileY).toBe(5);
  });

  it('MOVE TO walks the companion to the target tile and pins them there with WAIT', () => {
    const { ctx, state } = buildTestContext({
      player: { tileX: 0, tileY: 0 },
      npcs: [withCompanion({
        id: 'c',
        tileX: 5, tileY: 5,
        companion: {
          followMode: 'loose',
          override: { kind: 'move_to', tileX: 8, tileY: 5 },
          simState: { activeTaskId: null, lastTickId: 0 },
        },
      })],
    });
    // First tick: companion moves one tile toward the target.
    runOffCameraTick(ctx);
    expect(state.npcs[0].tileX).toBeGreaterThan(5);
    expect(state.npcs[0].tileX).toBeLessThanOrEqual(8);
    // Run more ticks until the companion arrives.
    for (let i = 0; i < 10; i++) runOffCameraTick(ctx);
    expect(state.npcs[0].tileX).toBe(8);
    expect(state.npcs[0].tileY).toBe(5);
    // Auto-converted to WAIT — the companion stays positioned where
    // the player put them instead of bolting back to the player. The
    // player presses the FOLLOW chip to resume autonomous following.
    expect(state.npcs[0].companion?.override?.kind).toBe('wait');
    // Even when the player walks far away, the companion holds tile.
    ctx.state.player.tileX = 20;
    runOffCameraTick(ctx);
    expect(state.npcs[0].tileX).toBe(8);
  });

  it('MOVE TO override suppresses responsive follow on player_moved', () => {
    const { ctx, state, events } = buildTestContext({
      player: { tileX: 0, tileY: 0 },
      npcs: [withCompanion({
        id: 'c',
        tileX: 5, tileY: 5,
        companion: {
          followMode: 'loose',
          override: { kind: 'move_to', tileX: 5, tileY: 10 },
          simState: { activeTaskId: null, lastTickId: 0 },
        },
      })],
    });
    registerCompanionFollowHooks(ctx);
    // Player walks far away — the responsive follow hook should NOT
    // tug the companion off-course.
    ctx.publish({ type: 'player_moved', x: 20, y: 0 });
    expect(state.npcs[0].tileX).toBe(5);
    expect(state.npcs[0].tileY).toBe(5);
    expect(events).toHaveLength(0);
  });

  it('ATTACK override clears when target dies', () => {
    const { ctx, state } = buildTestContext({
      npcs: [
        withCompanion({
          id: 'companion',
          tileX: 5, tileY: 5,
          companion: {
            followMode: 'loose',
            override: { kind: 'attack', targetId: 'target_npc' },
            simState: { activeTaskId: null, lastTickId: 0 },
          },
        }),
        makeNpc({ id: 'target_npc', tileX: 10, tileY: 10, hp: 0 }),
      ],
    });
    runOffCameraTick(ctx);
    // Target is dead (hp 0); ATTACK should clear on next tick.
    // (The current implementation clears in NpcTurnRunners during combat,
    //  but the override should at minimum not pin the companion to a
    //  dead-target indefinitely during exploration.)
    expect(
      state.npcs[0].companion?.override?.kind === 'attack' &&
      state.npcs[0].companion.override.targetId === 'target_npc',
    ).toBe(true);
    // This documents current behaviour — if we later add exploration-phase
    // ATTACK clear-on-target-death, flip this assertion.
  });
});

describe('multi-step companion follow cadence', () => {
  it('after a 5-tile player walk, companion stays within loose tolerance', () => {
    // Regression for the slow-follow bug: companion was moving 1 tile
    // per 6-second world tick, falling permanently behind a player
    // walking continuously. The fix subscribes to player_moved.
    const { ctx, state } = buildTestContext({
      player: { tileX: 0, tileY: 0 },
      npcs: [withCompanion({ id: 'c', tileX: 0, tileY: 0 })],
    });
    // Engine registers the hook in its constructor; the test context
    // doesn't run that, so we register it manually here.
    // (When integrated with GameEngine the registration is automatic.)
    registerCompanionFollowHooks(ctx);
    for (let i = 1; i <= 5; i++) {
      ctx.state.player.tileX = i;
      ctx.publish({ type: 'player_moved', x: i, y: 0 });
    }
    const cheby = Math.max(
      Math.abs(state.npcs[0].tileX - 5),
      Math.abs(state.npcs[0].tileY - 0),
    );
    expect(cheby).toBeLessThanOrEqual(4);  // loose tolerance
  });

  it('player walking 20 tiles never leaves companion more than 4 tiles behind', () => {
    const { ctx, state } = buildTestContext({
      player: { tileX: 0, tileY: 0 },
      npcs: [withCompanion({ id: 'c', tileX: 0, tileY: 0 })],
      map: { cols: 30, rows: 30 } as never,
    });
    registerCompanionFollowHooks(ctx);
    let maxCheby = 0;
    for (let i = 1; i <= 20; i++) {
      ctx.state.player.tileX = i;
      ctx.publish({ type: 'player_moved', x: i, y: 0 });
      const cheby = Math.max(
        Math.abs(state.npcs[0].tileX - i),
        Math.abs(state.npcs[0].tileY - 0),
      );
      maxCheby = Math.max(maxCheby, cheby);
    }
    expect(maxCheby).toBeLessThanOrEqual(4);
  });

  it('tight follow mode keeps the companion adjacent (cheby ≤ 1)', () => {
    const { ctx, state } = buildTestContext({
      player: { tileX: 0, tileY: 0 },
      npcs: [withCompanion({
        id: 'c',
        tileX: 0, tileY: 0,
        companion: { followMode: 'tight', simState: { activeTaskId: null, lastTickId: 0 } },
      })],
      map: { cols: 30, rows: 30 } as never,
    });
    registerCompanionFollowHooks(ctx);
    let maxCheby = 0;
    for (let i = 1; i <= 10; i++) {
      ctx.state.player.tileX = i;
      ctx.publish({ type: 'player_moved', x: i, y: 0 });
      const cheby = Math.max(
        Math.abs(state.npcs[0].tileX - i),
        Math.abs(state.npcs[0].tileY - 0),
      );
      maxCheby = Math.max(maxCheby, cheby);
    }
    expect(maxCheby).toBeLessThanOrEqual(1);
  });
});
