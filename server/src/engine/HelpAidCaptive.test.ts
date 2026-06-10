/**
 * SRD Help — aid-a-creature mode. Using Help on an adjacent NEUTRAL creature
 * (e.g. freeing a roped captive) publishes a `help_used` event carrying the
 * aided creature's instance id + defId, works out of combat (exploring), and
 * doesn't require an ally — unlike the distract-an-enemy mode.
 */
import { describe, it, expect } from 'vitest';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import { doHelp } from './CombatActions.js';
import type { EngineEvent } from './types.js';

function capture(ctx: ReturnType<typeof buildTestContext>['ctx']): EngineEvent[] {
  const seen: EngineEvent[] = [];
  ctx.bus.subscribe('help_used', (e) => seen.push(e));
  return seen;
}

describe('Help — aid an adjacent captive', () => {
  it('publishes help_used (with instance id + defId) when helping an adjacent neutral, out of combat', () => {
    const { ctx, state } = buildTestContext({
      phase: 'exploring',
      player: { tileX: 5, tileY: 5 },
      npcs: [makeNpc({ id: 'captive_elf_1', defId: 'captive_elf', tileX: 5, tileY: 6, disposition: 'neutral', hp: 6, maxHp: 6 })],
    });
    const events = capture(ctx);
    doHelp(ctx, 'captive_elf_1');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'help_used', targetId: 'captive_elf_1', targetDefId: 'captive_elf' });
    // No Action economy out of combat.
    expect(state.player.actionUsed).toBeFalsy();
  });

  it('does nothing when the captive is out of reach', () => {
    const { ctx } = buildTestContext({
      phase: 'exploring',
      player: { tileX: 1, tileY: 1 },
      npcs: [makeNpc({ id: 'captive_elf_1', defId: 'captive_elf', tileX: 20, tileY: 20, disposition: 'neutral', hp: 6, maxHp: 6 })],
    });
    const events = capture(ctx);
    doHelp(ctx, 'captive_elf_1');
    expect(events).toHaveLength(0);
  });
});
