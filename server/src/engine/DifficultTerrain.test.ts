/**
 * US-044 — player Difficult Terrain movement cost.
 *
 * Entering a difficult-terrain tile costs the player 2 movement tiles (SRD:
 * 2 ft per foot), mirroring the cost enemies already pay. Difficult-terrain
 * zones (Web / Grease) are the current source.
 */
import { describe, it, expect } from 'vitest';
import { doMove } from './ExplorationActions.js';
import { buildTestContext } from '../test/buildTestContext.js';
import type { ActiveZone } from './types.js';

function webZone(tiles: Array<[number, number]>): ActiveZone {
  return {
    id: 'z1', spellId: 'web', name: 'Web', shape: 'cube', sizeFeet: 5,
    originX: 1, originY: 0, tiles, difficultTerrain: true,
    affectedNpcIds: [], affectedPlayer: false, roundsRemaining: 10, casterId: 'player',
  };
}

describe('Player Difficult Terrain cost (US-044)', () => {
  it('costs 2 movement tiles to enter a difficult-terrain tile', () => {
    const { ctx, state, events } = buildTestContext({
      phase: 'player_turn',
      player: { tileX: 0, tileY: 0, movesLeft: 6 },
    });
    state.traps = []; state.activeZones = [webZone([[1, 0]])];
    doMove(ctx, 1, 0, events);            // step into the web tile (1,0)
    expect(state.player.tileX).toBe(1);
    expect(state.player.movesLeft).toBe(4);  // 6 − 2
  });

  it('costs 1 for ordinary terrain', () => {
    const { ctx, state, events } = buildTestContext({
      phase: 'player_turn',
      player: { tileX: 0, tileY: 0, movesLeft: 6 },
    });
    state.traps = []; state.activeZones = [];
    doMove(ctx, 1, 0, events);
    expect(state.player.movesLeft).toBe(5);  // 6 − 1
  });

  it('clamps movement at 0 when entering difficult terrain with little left', () => {
    const { ctx, state, events } = buildTestContext({
      phase: 'player_turn',
      player: { tileX: 0, tileY: 0, movesLeft: 1 },
    });
    state.traps = []; state.activeZones = [webZone([[1, 0]])];
    doMove(ctx, 1, 0, events);
    expect(state.player.tileX).toBe(1);       // still allowed to enter
    expect(state.player.movesLeft).toBe(0);   // clamped, not negative
  });
});
