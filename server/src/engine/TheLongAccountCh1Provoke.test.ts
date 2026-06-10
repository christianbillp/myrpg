/**
 * The Roadside Cage — runtime provoke wiring. Loads the REAL encounter triggers
 * and confirms that casting a spell in front of the (neutral) bandit slavers
 * flips them to `enemy` and kicks off combat. This exercises the same
 * `set_disposition_by_def_id` + `trigger_combat` machinery the parley's
 * "to_blows" branch uses, so it covers the conversation's fight path too.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import { registerTriggers } from './TriggerSystem.js';
import type { EncounterTrigger } from './types.js';

const enc = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'data', 'settings', 'the_sundered_reach', 'encounters', 'the_long_account_ch1.json'), 'utf8'),
);

describe('The Roadside Cage — casting provokes the neutral bandits', () => {
  it('spell_cast flips both bandits to enemy and starts combat', () => {
    const { ctx, state } = buildTestContext({
      phase: 'exploring',
      npcs: [
        makeNpc({ id: 'bandit_1', defId: 'bandit', tileX: 23, tileY: 10, disposition: 'neutral' }),
        makeNpc({ id: 'bandit_2', defId: 'bandit', tileX: 23, tileY: 12, disposition: 'neutral' }),
      ],
    });
    let combatStarted = false;
    ctx.doStartCombat = () => { combatStarted = true; };
    state.triggers = enc.triggers as EncounterTrigger[];
    registerTriggers(ctx);

    // Sanity: bandits start neutral, so nothing is hostile yet.
    expect(state.npcs.every((n) => n.disposition === 'neutral')).toBe(true);

    ctx.bus.publish({ type: 'spell_cast', spellId: 'eldritch-blast', school: 'evocation', level: 0 });

    expect(state.npcs.filter((n) => n.defId === 'bandit').every((n) => n.disposition === 'enemy')).toBe(true);
    expect(combatStarted).toBe(true);
  });
});
