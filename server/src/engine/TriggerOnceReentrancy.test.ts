/**
 * A `once` trigger must fire exactly once even when its own actions publish an
 * event that re-matches it within the same synchronous cascade. The Roadside
 * Cage hit this: `ch1_both_freed` fires on `flag_set`, and its `set_flag`
 * (tla_ch1_done) re-publishes `flag_set` — whose guards still hold — so the
 * "Both elves are free" log printed twice. The fix marks the trigger fired
 * BEFORE running its actions.
 */
import { describe, it, expect } from 'vitest';
import { buildTestContext } from '../test/buildTestContext.js';
import { registerTriggers } from './TriggerSystem.js';
import type { EncounterTrigger } from './types.js';

describe('once-trigger re-entrancy', () => {
  it('fires exactly once even when its set_flag re-publishes a matching flag_set', () => {
    const { ctx, state, logs } = buildTestContext({ phase: 'exploring' });
    const trigger: EncounterTrigger = {
      id: 'both_freed',
      when: { event: 'flag_set' },
      if: [{ type: 'flag_equals', name: 'elf1', value: true }],
      then: [
        { type: 'show_log', message: 'Both elves are free.' },
        { type: 'set_flag', name: 'done', value: true },
      ],
      once: true,
    };
    state.triggers = [trigger];
    state.worldFlags['elf1'] = true;
    registerTriggers(ctx);

    // Kick the cascade: setting elf1 (already true) publishes flag_set, which
    // matches the trigger; its own set_flag('done') re-publishes flag_set.
    ctx.bus.publish({ type: 'flag_set', name: 'elf1', value: true });

    const freedLogs = logs.filter((l) => l.left?.includes('Both elves are free'));
    expect(freedLogs).toHaveLength(1);
    expect(state.firedTriggerIds.filter((id) => id === 'both_freed')).toHaveLength(1);
  });
});
