/**
 * Quest generator — structural integrity (every step's completion flag is one
 * the generated encounters actually set), lifecycle (a generated quest drives
 * the objective and resolves the contract), multi-stage chaining, and the
 * registry's stage resolution.
 */
import { describe, it, expect } from 'vitest';
import { buildTestContext } from '../test/buildTestContext.js';
import { registerQuestSystem, startQuest } from '../engine/QuestSystem.js';
import { generateQuest } from './questGenerator.js';
import { QUEST_TYPE_MODULES } from './questTypes.js';
import { questBudgetXp, pickEnemies } from './questDifficulty.js';
import { recordQuest, getQuestEncounter, serialiseForSave, restoreFromSave, clearQuestRegistry } from './questRegistry.js';
import type { QuestGenContext, GeneratedQuest } from './questGenTypes.js';
import type { TriggerGuard } from '../../../shared/types.js';

/** Deterministic LCG so the rolls are stable across runs. */
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; };
}

function ctx(level = 1, seed = 1): QuestGenContext {
  return { playerLevel: level, monsters: [], tilesets: [], rng: seededRng(seed) };
}

/** Collect every `set_flag` name emitted by a quest's encounter triggers. */
function flagsSetByEncounters(q: GeneratedQuest): Set<string> {
  const names = new Set<string>();
  for (const enc of q.encounters) {
    for (const t of (enc.encounterDef.triggers ?? []) as Array<{ then?: Array<{ type: string; name?: string }> }>) {
      for (const a of t.then ?? []) if (a.type === 'set_flag' && a.name) names.add(a.name);
    }
  }
  return names;
}

const stepFlag = (g: TriggerGuard[] | undefined): string | undefined =>
  g?.find((x) => x.type === 'flag_equals')?.name as string | undefined;

describe('Quest generator — difficulty', () => {
  it('budget rises with level and pickEnemies honours min/max', () => {
    expect(questBudgetXp(1)).toBeLessThan(questBudgetXp(5));
    expect(questBudgetXp(5)).toBeLessThan(questBudgetXp(10));
    const rng = seededRng(7);
    expect(pickEnemies([], ['bandit'], 1000, rng, { min: 1, max: 3 }).length).toBe(3);   // capped at max
    expect(pickEnemies([], ['bandit'], 0, rng, { min: 2, max: 5 }).length).toBe(2);       // floored at min
  });
});

describe('Quest generator — structural integrity', () => {
  for (const mod of QUEST_TYPE_MODULES) {
    it(`${mod.id}: every step's completion flag is set by an encounter trigger`, () => {
      const q = mod.generate(ctx(3, mod.id.length * 13 + 1));
      expect(q.encounters.length).toBeGreaterThan(0);
      expect(q.questDef.steps.length).toBeGreaterThan(0);
      // ordinals are 0..n-1
      expect(q.encounters.map((e) => e.ordinal)).toEqual(q.encounters.map((_, i) => i));
      const set = flagsSetByEncounters(q);
      for (const step of q.questDef.steps) {
        const flag = stepFlag(step.completeWhen);
        expect(flag, `${mod.id} step ${step.id} has a flag_equals guard`).toBeTruthy();
        expect(set.has(flag!), `${mod.id} step ${step.id} flag "${flag}" is set by a trigger`).toBe(true);
      }
      // The quest resolves the contract on completion.
      const resolves = (q.questDef.onComplete ?? []).some((a) => a.type === 'set_flag' && a.name === 'mission_complete');
      expect(resolves).toBe(true);
    });
  }

  it('generateQuest avoids repeating the last type', () => {
    const c = { ...ctx(3, 99), lastType: 'bounty' as const };
    for (let i = 0; i < 20; i++) {
      const q = generateQuest({ ...c, rng: seededRng(i + 1) });
      expect(q.type).not.toBe('bounty');
    }
  });
});

describe('Quest generator — lifecycle', () => {
  it('a single-stage generated quest drives the objective and resolves the contract', () => {
    const bounty = QUEST_TYPE_MODULES.find((m) => m.id === 'bounty')!;
    const q = bounty.generate(ctx(2, 5));
    const { ctx: tctx, state } = buildTestContext();
    registerQuestSystem(tctx);
    startQuest(tctx, q.questDef);
    expect(state.objective).toBe(q.questDef.steps[0].text);

    const flag = stepFlag(q.questDef.steps[0].completeWhen)!;
    state.worldFlags[flag] = true;
    tctx.publish({ type: 'flag_set', name: flag, value: true });

    expect(state.quests[0].status).toBe('completed');
    expect(state.worldFlags['mission_complete']).toBe(true);   // contract resolved
    expect(state.worldFlags['mission_pending']).toBe(false);
  });

  it('a two-stage quest chains: stage 0 points mission_pending at stage 1, then completes', () => {
    const strike = QUEST_TYPE_MODULES.find((m) => m.id === 'two_stage_strike')!;
    const q = strike.generate(ctx(3, 11));
    expect(q.encounters).toHaveLength(2);
    const stage1Id = q.encounters[1].encounterDef.id;

    const { ctx: tctx, state } = buildTestContext();
    registerQuestSystem(tctx);
    startQuest(tctx, q.questDef);
    expect(state.objective).toBe(q.questDef.steps[0].text);

    const f0 = stepFlag(q.questDef.steps[0].completeWhen)!;
    state.worldFlags[f0] = true;
    tctx.publish({ type: 'flag_set', name: f0, value: true });
    // Stage 0 done → objective advances + mission_pending points at stage 1.
    expect(state.objective).toBe(q.questDef.steps[1].text);
    expect(state.worldFlags['mission_pending']).toBe(stage1Id);
    expect(state.quests[0].status).toBe('active');

    const f1 = stepFlag(q.questDef.steps[1].completeWhen)!;
    state.worldFlags[f1] = true;
    tctx.publish({ type: 'flag_set', name: f1, value: true });
    expect(state.quests[0].status).toBe('completed');
    expect(state.worldFlags['mission_complete']).toBe(true);
  });
});

describe('Quest registry', () => {
  it('resolves stage ids and round-trips through save', () => {
    clearQuestRegistry();
    const strike = QUEST_TYPE_MODULES.find((m) => m.id === 'two_stage_strike')!;
    const q = strike.generate(ctx(3, 21));
    recordQuest(q);

    expect(getQuestEncounter(q.baseEncounterId)?.encounter.ordinal).toBe(0);
    expect(getQuestEncounter(`${q.baseEncounterId}#1`)?.encounter.ordinal).toBe(1);
    expect(getQuestEncounter('mission_gen_nope')).toBeUndefined();

    const saved = serialiseForSave();
    clearQuestRegistry();
    expect(getQuestEncounter(q.baseEncounterId)).toBeUndefined();
    restoreFromSave(saved);
    expect(getQuestEncounter(`${q.baseEncounterId}#1`)?.encounter.ordinal).toBe(1);
  });
});
