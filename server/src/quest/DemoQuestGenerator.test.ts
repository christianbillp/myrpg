/**
 * End-to-end test of the generated-mission contract loop, driven through the
 * trigger system exactly as the demo_quest_generator hub encounter does it
 * (the demo JSON itself is a dev-only, git-ignored file, so this test drives the
 * actions directly rather than asserting the encounter's wiring):
 *   1. `generate_mission_contract` rolls a typed quest + registers it.
 *   2. `begin_generated_quest` (the stage's encounter_started trigger) starts it.
 *   3. The quest drives the objective; completing its stage flag resolves the
 *      contract (mission_complete) and grants the step XP.
 */
import { describe, it, expect } from 'vitest';
import { buildTestContext } from '../test/buildTestContext.js';
import { registerQuestSystem } from '../engine/QuestSystem.js';
import { fireAction } from '../engine/TriggerSystem.js';
import { setGeneratedMapTilesets, getQuest, clearQuestRegistry } from './questRegistry.js';

describe('generated-mission contract loop', () => {
  it('rolls a contract, starts the quest, and resolves it on stage completion', () => {
    setGeneratedMapTilesets([]);
    clearQuestRegistry();
    const { ctx, state } = buildTestContext({ playerDef: { level: 3 } });
    registerQuestSystem(ctx);

    // 1. Enter the hub → roll a contract.
    fireAction(ctx, { type: 'generate_mission_contract' });
    const pending = state.worldFlags['mission_pending'];
    expect(typeof pending).toBe('string');
    expect((pending as string).startsWith('mission_gen_')).toBe(true);
    const quest = getQuest(pending as string);
    expect(quest).toBeDefined();
    expect(state.worldFlags['mission_offer_objective']).toBeTruthy();
    expect(state.worldFlags['mission_offer_reward_cp']).toBeGreaterThan(0);

    // 2. Enter the generated stage-0 encounter → begin the quest.
    state.currentEncounterId = pending as string;
    fireAction(ctx, { type: 'begin_generated_quest' });
    expect(state.quests.some((q) => q.questId === quest!.questId && q.status === 'active')).toBe(true);
    expect(state.objective).toBe(quest!.questDef.steps[0].text);

    // begin again on a re-fire is a no-op (no duplicate quest).
    fireAction(ctx, { type: 'begin_generated_quest' });
    expect(state.quests.filter((q) => q.questId === quest!.questId)).toHaveLength(1);

    // 3. Complete the final stage flag → quest resolves the contract + grants XP.
    const xp0 = state.player.xp;
    const lastStep = quest!.questDef.steps[quest!.questDef.steps.length - 1];
    // Walk every stage flag in order so multi-stage quests advance to the end.
    for (const step of quest!.questDef.steps) {
      const flag = step.completeWhen!.find((g) => g.type === 'flag_equals')!.name as string;
      state.worldFlags[flag] = true;
      ctx.publish({ type: 'flag_set', name: flag, value: true });
    }
    expect(state.quests.find((q) => q.questId === quest!.questId)!.status).toBe('completed');
    expect(state.worldFlags['mission_complete']).toBe(true);
    expect(state.player.xp).toBeGreaterThan(xp0); // steps granted XP during play
    expect(lastStep).toBeDefined();
  });
});
