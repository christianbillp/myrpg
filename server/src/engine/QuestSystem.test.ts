/**
 * QuestSystem — structured quests: start, auto-advance off the trigger-guard
 * evaluator, XP-only rewards, fail conditions, cascades, and the AIGM-driven
 * advance/complete/fail levers.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildTestContext } from '../test/buildTestContext.js';
import { registerQuestSystem, startQuest, advanceQuest, completeQuest, failQuest } from './QuestSystem.js';
import { fireAction, registerTriggers } from './TriggerSystem.js';
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

  it('integration: an encounter_started trigger fires start_quest, then the quest auto-completes through the encounter', () => {
    const { ctx, state } = buildTestContext();  // no npcs → enemies_alive == 0
    ctx.defs.quests.push(quest({ id: 'demo_clear_the_camp', runtime: false, steps: [
      { id: 'scout', text: 'Scout the bandit camp', completeWhen: [{ type: 'flag_equals', name: 'camp_scouted', value: true }], xpReward: 25 },
      { id: 'defeat', text: 'Defeat the bandits', completeWhen: [{ type: 'enemies_alive', op: 'eq', count: 0 }], xpReward: 100 },
    ], xpReward: 50 }));
    // The demo encounter's two triggers, driven through the real trigger system.
    state.triggers = [
      { id: 'demo_start_quest', when: { event: 'encounter_started' }, then: [{ type: 'start_quest', questId: 'demo_clear_the_camp' }], once: true },
      { id: 'demo_scouted', when: { event: 'combat_started' }, then: [{ type: 'set_flag', name: 'camp_scouted', value: true }], once: true },
    ];
    registerTriggers(ctx);
    registerQuestSystem(ctx);
    const xp0 = state.player.xp;

    ctx.publish({ type: 'encounter_started' });
    expect(state.quests[0]?.status).toBe('active');
    expect(state.objective).toBe('Scout the bandit camp');   // started by the trigger

    ctx.publish({ type: 'combat_started' });                 // camp_scouted set → cascades to completion
    expect(state.quests[0].status).toBe('completed');
    expect(state.player.xp).toBe(xp0 + 25 + 100 + 50);
  });

  it('optional side-goals complete out of order, grant XP, and never drive the spine or finish the quest', () => {
    const { ctx, state } = buildTestContext();
    registerQuestSystem(ctx);
    const xp0 = state.player.xp;
    startQuest(ctx, quest({
      steps: [
        { id: 's1', text: 'Spine A', completeWhen: [{ type: 'flag_equals', name: 'a', value: true }], xpReward: 10 },
        { id: 'opt', text: 'Bonus find', optional: true, completeWhen: [{ type: 'flag_equals', name: 'bonus', value: true }], xpReward: 40 },
        { id: 's2', text: 'Spine B', completeWhen: [{ type: 'flag_equals', name: 'b', value: true }], xpReward: 20 },
      ],
      xpReward: 0,
    }));
    expect(state.quests[0].currentStepId).toBe('s1');        // optional isn't the spine start
    expect(state.objective).toBe('Spine A');

    setFlag(ctx, state, 'bonus');                            // optional completes out of order
    expect(state.quests[0].completedStepIds).toContain('opt');
    expect(state.quests[0].currentStepId).toBe('s1');        // spine untouched
    expect(state.quests[0].status).toBe('active');           // quest not finished by an optional
    expect(state.objective).toBe('Spine A');                 // objective still the current spine step
    expect(state.player.xp).toBe(xp0 + 40);

    setFlag(ctx, state, 'a');                                // spine advances s1 → s2 (skipping the optional)
    expect(state.quests[0].currentStepId).toBe('s2');
    setFlag(ctx, state, 'b');                                // last SPINE step → quest completes
    expect(state.quests[0].status).toBe('completed');
    expect(state.player.xp).toBe(xp0 + 40 + 10 + 20);
  });

  it('migrated adventure data: The Reach Circuit advances through its real chapter flags, including optional finds, for 1150 XP', () => {
    const dir = 'data/settings/the_sundered_reach/quests';
    const load = (name: string): QuestDef => JSON.parse(readFileSync(`${dir}/${name}.json`, 'utf8'));
    const reach = load('the_reach_circuit');
    const total = (d: QuestDef): number => d.steps.reduce((n, s) => n + (s.xpReward ?? 0), 0) + (d.xpReward ?? 0);
    expect(total(reach)).toBe(1150);             // XP preserved from the original encounter award_xp triggers
    expect(total(load('the_moons_ledger'))).toBe(900);
    expect(total(load('the_commission'))).toBe(150);
    expect(reach.steps.filter((s) => s.optional).map((s) => s.id)).toEqual(['dedication_stone', 'vael_seal']);

    const { ctx, state } = buildTestContext();
    ctx.defs.quests.push(reach);
    registerQuestSystem(ctx);
    const xp0 = state.player.xp;
    startQuest(ctx, reach);
    expect(state.objective).toBe(reach.steps[0].text);   // first spine step drives the objective

    for (const f of [
      'wardstone_lead_confirmed', 'waystation_leads_gathered', 'wardstone_one_cleared', 'blackgorge_bridge_crossed',
      'dedication_stone_examined', 'vael_seal_examined', 'sage_way_down_given', 'keystone_ward_sealed',
    ]) setFlag(ctx, state, f);

    expect(state.quests[0].status).toBe('completed');
    expect(state.quests[0].completedStepIds).toEqual(expect.arrayContaining(['dedication_stone', 'vael_seal']));
    expect(state.player.xp).toBe(xp0 + 1150);
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
