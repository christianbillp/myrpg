/**
 * QuestSystem — structured quests: start, auto-advance off the trigger-guard
 * evaluator, XP-only rewards, fail conditions, cascades, and the AIGM-driven
 * advance/complete/fail levers.
 */
import { describe, it, expect } from 'vitest';
import { buildTestContext } from '../test/buildTestContext.js';
import { registerQuestSystem, startQuest, advanceQuest, completeQuest, failQuest } from './QuestSystem.js';
import { fireAction } from './TriggerSystem.js';
import type { QuestDef } from '../../../shared/types.js';

function quest(overrides: Partial<QuestDef> = {}): QuestDef {
  return {
    id: 'q1', title: 'Recover the Ledger', description: '', scope: 'encounter',
    steps: [
      { id: 's1', text: 'Find the ledger', completeWhen: [{ type: 'flag_equals', name: 'ledger_found', value: true }], xpReward: 50 },
      { id: 's2', text: 'Escape the way-house', completeWhen: [{ type: 'flag_equals', name: 'escaped', value: true }], xpReward: 100 },
    ],
    xpReward: 200,
    runtime: true,
    ...overrides,
  };
}

const setFlag = (ctx: ReturnType<typeof buildTestContext>['ctx'], state: ReturnType<typeof buildTestContext>['state'], name: string): void => {
  state.worldFlags[name] = true;
  ctx.publish({ type: 'flag_set', name, value: true });
};

describe('QuestSystem', () => {
  it('starts a quest, drives the OBJECTIVE, auto-advances off flags, and grants XP only', () => {
    const { ctx, state } = buildTestContext();
    registerQuestSystem(ctx);
    const xp0 = state.player.xp;
    const cp0 = state.player.balanceCp;

    startQuest(ctx, quest());
    expect(state.quests).toHaveLength(1);
    expect(state.quests[0].status).toBe('active');
    expect(state.objective).toBe('Find the ledger');

    setFlag(ctx, state, 'ledger_found');                 // step 1 condition holds
    expect(state.quests[0].currentStepId).toBe('s2');
    expect(state.objective).toBe('Escape the way-house');
    expect(state.player.xp).toBe(xp0 + 50);

    setFlag(ctx, state, 'escaped');                       // last step → quest completes
    expect(state.quests[0].status).toBe('completed');
    expect(state.player.xp).toBe(xp0 + 50 + 100 + 200);  // step + step + quest XP
    expect(state.player.balanceCp).toBe(cp0);            // no tangible reward — XP only
  });

  it('auto-fails when failWhen holds', () => {
    const { ctx, state } = buildTestContext();
    registerQuestSystem(ctx);
    startQuest(ctx, quest({ failWhen: [{ type: 'flag_equals', name: 'alarm', value: true }] }));
    setFlag(ctx, state, 'alarm');
    expect(state.quests[0].status).toBe('failed');
  });

  it('cascades when a step onComplete satisfies the next step (no double-award / no loop)', () => {
    const { ctx, state } = buildTestContext();
    registerQuestSystem(ctx);
    const xp0 = state.player.xp;
    startQuest(ctx, quest({
      steps: [
        { id: 's1', text: 'A', completeWhen: [{ type: 'flag_equals', name: 'a', value: true }], xpReward: 10, onComplete: [{ type: 'set_flag', name: 'b', value: true }] },
        { id: 's2', text: 'B', completeWhen: [{ type: 'flag_equals', name: 'b', value: true }], xpReward: 20 },
      ],
      xpReward: 0,
    }));
    setFlag(ctx, state, 'a');                             // a → s1 done → sets b → s2 done
    expect(state.quests[0].status).toBe('completed');
    expect(state.player.xp).toBe(xp0 + 10 + 20);          // each step XP exactly once
  });

  it('AIGM advance / complete / fail drive quest state directly', () => {
    const { ctx, state } = buildTestContext();
    registerQuestSystem(ctx);
    startQuest(ctx, quest());
    expect(advanceQuest(ctx, 'q1')).toBe(true);           // complete s1 → s2
    expect(state.quests[0].currentStepId).toBe('s2');
    expect(completeQuest(ctx, 'q1')).toBe(true);
    expect(state.quests[0].status).toBe('completed');

    startQuest(ctx, quest({ id: 'q2' }));
    expect(failQuest(ctx, 'q2')).toBe(true);
    expect(state.quests.find((q) => q.questId === 'q2')!.status).toBe('failed');
  });

  it('the demo path: start_quest trigger action starts an authored quest that auto-completes on its conditions', () => {
    const { ctx, state } = buildTestContext();  // no npcs → enemies_alive == 0 holds
    ctx.defs.quests.push(quest({ id: 'demo_clear_the_camp', runtime: false, steps: [
      { id: 'scout', text: 'Scout the bandit camp', completeWhen: [{ type: 'flag_equals', name: 'camp_scouted', value: true }], xpReward: 25 },
      { id: 'defeat', text: 'Defeat the bandits', completeWhen: [{ type: 'enemies_alive', op: 'eq', count: 0 }], xpReward: 100 },
    ], xpReward: 50 }));
    registerQuestSystem(ctx);
    const xp0 = state.player.xp;

    fireAction(ctx, { type: 'start_quest', questId: 'demo_clear_the_camp' });
    expect(state.quests[0].currentStepId).toBe('scout');   // 'defeat' guard holds but we're on 'scout'
    expect(state.objective).toBe('Scout the bandit camp');

    setFlag(ctx, state, 'camp_scouted');                   // scout done → defeat's guard already holds → cascade
    expect(state.quests[0].status).toBe('completed');
    expect(state.player.xp).toBe(xp0 + 25 + 100 + 50);
  });

  it('resolves authored quests from defs.quests (non-runtime)', () => {
    const { ctx, state } = buildTestContext();
    const def = quest({ id: 'authored', runtime: false });
    ctx.defs.quests.push(def);
    registerQuestSystem(ctx);
    startQuest(ctx, def);
    expect(state.runtimeQuestDefs).toHaveLength(0);       // authored defs aren't stashed
    expect(state.objective).toBe('Find the ledger');
    setFlag(ctx, state, 'ledger_found');
    expect(state.quests[0].currentStepId).toBe('s2');
  });
});
