/**
 * A neutral-disposition NPC whose FACTION is hostile to the party must not drag
 * the player into combat off-camera. The exploration world-tick escalates to
 * turn-based combat via `anyHostileToParty`, which resolves the relationship
 * layer (individual → faction baseline). The Roadside Cage bug: the bandits were
 * spawned `neutral` but their `bandits` faction baseline (party = -40) is
 * hostile, so the first world tick "discovered" the hidden player and started a
 * fight. Pinning bandits↔party to neutral (the encounter faction override) fixes
 * it; a provoke writes an individual hostile link that overrides the baseline.
 */
import { describe, it, expect } from 'vitest';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import { runOffCameraTick } from './WorldTick.js';

function neutralBanditCtx(banditsToParty: number) {
  const { ctx, state } = buildTestContext({
    phase: 'exploring',
    player: { tileX: 3, tileY: 3 },
    npcs: [makeNpc({ id: 'bandit_1', defId: 'bandit', factionId: 'bandits', tileX: 16, tileY: 16, disposition: 'neutral' })],
  });
  state.factionRelations = {
    bandits: { party: banditsToParty },
    party: { bandits: banditsToParty },
  };
  state.relationships = {};
  let combatStarted = false;
  ctx.doStartCombat = () => { combatStarted = true; };
  return { ctx, state, started: () => combatStarted };
}

describe('neutral NPC, hostile faction — no off-camera auto-aggro', () => {
  it('does NOT start combat when bandits↔party is pinned neutral (the fix)', () => {
    const { ctx, started } = neutralBanditCtx(0);
    runOffCameraTick(ctx);
    expect(started()).toBe(false);
  });

  it('control: WOULD start combat if the faction baseline stayed hostile', () => {
    // Demonstrates the bug the override prevents: a faction-hostile bandit
    // escalates on the very first tick regardless of disposition or sight.
    const { ctx, started } = neutralBanditCtx(-40);
    runOffCameraTick(ctx);
    expect(started()).toBe(true);
  });
});
