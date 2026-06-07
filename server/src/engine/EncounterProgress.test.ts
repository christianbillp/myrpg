/**
 * EncounterProgress — completion handling. The key invariant: when an encounter
 * resolves (combat-clear, lifecycle, or content flag), its declared
 * `completionFlag` is WRITTEN to worldFlags so quest steps keyed on it via
 * `completeWhen` actually fire — not just `encounterComplete`.
 */
import { describe, it, expect } from 'vitest';
import { buildTestContext } from '../test/buildTestContext.js';
import { registerEncounterProgress } from './EncounterProgress.js';
import { registerQuestSystem, startQuest } from './QuestSystem.js';
import type { QuestDef } from '../../../shared/types.js';

describe('EncounterProgress', () => {
  it('writes the declared completionFlag when the encounter completes', () => {
    const { ctx, state } = buildTestContext();
    state.encounterCompletionFlag = 'wardstone_one_cleared';
    registerEncounterProgress(ctx);
    expect(state.worldFlags.wardstone_one_cleared).toBeUndefined();

    ctx.publish({ type: 'encounter_completed' });

    expect(state.encounterComplete).toBe(true);
    expect(state.worldFlags.wardstone_one_cleared).toBe(true);
  });

  it('a combat-clear chapter completes the quest step keyed on its completionFlag', () => {
    const { ctx, state } = buildTestContext();
    state.encounterCompletionFlag = 'wardstone_one_cleared';
    registerEncounterProgress(ctx);
    registerQuestSystem(ctx);
    const def: QuestDef = {
      id: 'q', title: 'Q', description: '', scope: 'adventure', runtime: true,
      steps: [{
        id: 's', text: 'Clear the wardstone',
        completeWhen: [{ type: 'flag_equals', name: 'wardstone_one_cleared', value: true }], xpReward: 300,
      }],
    };
    const xp0 = state.player.xp;
    startQuest(ctx, def);
    expect(state.quests[0].status).toBe('active');

    ctx.publish({ type: 'encounter_completed' });   // what combat-clear ultimately fires

    expect(state.quests[0].status).toBe('completed');
    expect(state.player.xp).toBe(xp0 + 300);
  });

  it('does not re-publish a completionFlag content already set (idempotent)', () => {
    const { ctx, state } = buildTestContext();
    state.encounterCompletionFlag = 'already_set';
    state.worldFlags.already_set = true;
    let publishes = 0;
    ctx.bus.subscribe('flag_set', (e) => { if (e.name === 'already_set') publishes++; });
    registerEncounterProgress(ctx);

    ctx.publish({ type: 'encounter_completed' });

    expect(publishes).toBe(0);
  });
});
