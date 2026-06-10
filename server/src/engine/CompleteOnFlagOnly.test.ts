/**
 * `completeOnFlagOnly` — for encounters where defeating the enemies is a STEP,
 * not the objective (e.g. The Roadside Cage: kill the captors, THEN free the
 * captives). With the flag set, a `combat_ended` with no living enemies must
 * NOT mark the encounter complete; only the declared `completionFlag` being set
 * finishes it. Without the flag, combat-clear completes as before.
 */
import { describe, it, expect } from 'vitest';
import { buildTestContext } from '../test/buildTestContext.js';
import { registerEncounterProgress } from './EncounterProgress.js';
import { registerEncounterLifecycle } from './EncounterLifecycle.js';

describe('completeOnFlagOnly — combat-clear does not finish the encounter', () => {
  it('holds completion on combat-clear, then completes when the flag is set', () => {
    const { ctx, state } = buildTestContext({ phase: 'player_turn' });
    state.encounterCompletionFlag = 'objective_done';
    state.encounterCompleteOnFlagOnly = true;
    registerEncounterLifecycle(ctx);
    registerEncounterProgress(ctx);

    // No hostiles on the map → combat-clear. Must NOT complete.
    ctx.bus.publish({ type: 'combat_ended' });
    expect(state.encounterComplete).toBe(false);

    // The real objective resolves and sets the flag → now it completes.
    state.worldFlags['objective_done'] = true;
    ctx.bus.publish({ type: 'flag_set', name: 'objective_done', value: true });
    expect(state.encounterComplete).toBe(true);
  });

  it('without the flag, combat-clear completes the encounter (default behaviour)', () => {
    const { ctx, state } = buildTestContext({ phase: 'player_turn' });
    registerEncounterLifecycle(ctx);
    registerEncounterProgress(ctx);

    ctx.bus.publish({ type: 'combat_ended' });
    expect(state.encounterComplete).toBe(true);
  });
});
