/**
 * QuestSystem — the engine half of the structured quest model (review Option B).
 *
 * A quest is an ordered list of steps; each step's completion condition is a
 * `TriggerGuard[]` (`completeWhen`). This system subscribes to the event bus and,
 * on any state-changing event, re-evaluates each active quest's current step
 * with the SAME guard evaluator the trigger system uses (`guardHolds`) — so the
 * engine decides mechanics deterministically, the AIGM only narrates. Steps may
 * also be advanced explicitly by the AIGM (`advanceQuest`).
 *
 * Effects (`onComplete` / `onFail`) reuse the trigger action applier
 * (`fireAction`). Rewards are XP-only by design — no gold/items are spawned by a
 * quest (tangible loot must come from the world to keep the fiction intact).
 *
 * The active quest's current step text drives `GameState.objective`, so the
 * Player Panel's OBJECTIVE line tracks the live quest step.
 */
import type { GameContext } from './GameContext.js';
import type { QuestDef, QuestState, QuestStepDef } from '../../../shared/types.js';
import { guardHolds, fireAction } from './TriggerSystem.js';

/** Bus events that can change a guard's truth value — re-evaluate quests on each. */
const QUEST_EVENTS = [
  'flag_set', 'npc_killed', 'combat_ended', 'combat_started',
  'faction_changed', 'turn_ended', 'damage_dealt',
] as const;

export function registerQuestSystem(ctx: GameContext): void {
  for (const ev of QUEST_EVENTS) {
    ctx.bus.subscribe(ev, () => evaluateQuests(ctx), /*priority*/ 35);
  }
}

/** Resolve a quest's definition — runtime (AIGM-created) defs first, then the
 *  authored registry. */
function resolveQuestDef(ctx: GameContext, questId: string): QuestDef | undefined {
  return ctx.state.runtimeQuestDefs.find((d) => d.id === questId)
    ?? ctx.defs.quests.find((d) => d.id === questId);
}

function stepOf(def: QuestDef, stepId: string): QuestStepDef | undefined {
  return def.steps.find((s) => s.id === stepId);
}

/** The ordered "spine" is the non-optional steps; they drive the OBJECTIVE and
 *  quest completion. Optional steps are bonus side-goals evaluated independently. */
function firstSpineStep(def: QuestDef): QuestStepDef | undefined {
  return def.steps.find((s) => !s.optional);
}
function nextSpineStep(def: QuestDef, afterStepId: string): QuestStepDef | undefined {
  const idx = def.steps.findIndex((s) => s.id === afterStepId);
  return def.steps.slice(idx + 1).find((s) => !s.optional);
}

function allHold(ctx: GameContext, guards: readonly import('../../../shared/types.js').TriggerGuard[] | undefined): boolean {
  return !!guards && guards.length > 0 && guards.every((g) => guardHolds(ctx, g));
}

function awardXp(ctx: GameContext, amount: number | undefined, label: string): void {
  const xp = Math.max(0, Math.floor(amount ?? 0));
  if (xp <= 0) return;
  ctx.state.player.xp += xp;
  ctx.addLog({ left: `+${xp} XP — ${label}`, style: 'status' });
}

/** The most-recently-started active quest drives the OBJECTIVE line. When none is
 *  active the objective is left as-is (legacy / `set_objective` text). */
function syncObjective(ctx: GameContext): void {
  for (let i = ctx.state.quests.length - 1; i >= 0; i--) {
    const qs = ctx.state.quests[i];
    if (qs.status !== 'active') continue;
    const def = resolveQuestDef(ctx, qs.questId);
    const step = def && stepOf(def, qs.currentStepId);
    if (step) { ctx.state.objective = step.text; return; }
  }
}

/** Start a quest. Runtime defs are stashed on the state so they survive reload.
 *  A no-op if the quest is already active/known. Returns the new state or null. */
export function startQuest(ctx: GameContext, def: QuestDef): QuestState | null {
  if (def.steps.length === 0) return null;
  if (ctx.state.quests.some((q) => q.questId === def.id)) return null;
  if (def.runtime && !ctx.state.runtimeQuestDefs.some((d) => d.id === def.id)) {
    ctx.state.runtimeQuestDefs.push(def);
  }
  const qs: QuestState = { questId: def.id, status: 'active', currentStepId: (firstSpineStep(def) ?? def.steps[0]).id, completedStepIds: [] };
  ctx.state.quests.push(qs);
  ctx.addLog({ left: `New quest: ${def.title}`, style: 'header' });
  syncObjective(ctx);
  // A step may already be satisfiable — evaluate immediately.
  evaluateActiveQuest(ctx, qs);
  return qs;
}

/** Complete the current step of an active quest (granting XP + firing effects)
 *  and advance to the next step, or finish the quest if it was the last. */
function completeCurrentStep(ctx: GameContext, qs: QuestState, def: QuestDef): void {
  const step = stepOf(def, qs.currentStepId);
  if (!step) return;
  if (!qs.completedStepIds.includes(step.id)) qs.completedStepIds.push(step.id);
  awardXp(ctx, step.xpReward, `${def.title}: ${step.text}`);

  // Advance (or finish) BEFORE firing onComplete: those effects can publish
  // events that re-enter the quest evaluation, and we want re-entry to see the
  // NEW current step — not re-complete the one we just finished.
  const next = nextSpineStep(def, step.id);
  if (next) {
    qs.currentStepId = next.id;
    ctx.addLog({ left: `Objective: ${next.text}`, style: 'status' });
    syncObjective(ctx);
  } else {
    finishQuest(ctx, qs, def);
  }
  for (const a of step.onComplete ?? []) fireAction(ctx, a);
}

function finishQuest(ctx: GameContext, qs: QuestState, def: QuestDef): void {
  qs.status = 'completed';
  qs.currentStepId = '';
  awardXp(ctx, def.xpReward, `${def.title} complete`);
  for (const a of def.onComplete ?? []) fireAction(ctx, a);
  ctx.addLog({ left: `Quest complete: ${def.title}`, style: 'header' });
  syncObjective(ctx);
}

/** Award any optional side-goals whose guards now hold. Independent of the spine:
 *  they grant XP + fire onComplete once, never touch currentStep or finish the
 *  quest. Marked complete BEFORE firing onComplete (re-entrancy, mirrors the spine). */
function completeReadyOptionalSteps(ctx: GameContext, qs: QuestState, def: QuestDef): void {
  for (const step of def.steps) {
    if (!step.optional || qs.completedStepIds.includes(step.id)) continue;
    if (!allHold(ctx, step.completeWhen)) continue;
    qs.completedStepIds.push(step.id);
    awardXp(ctx, step.xpReward, `${def.title}: ${step.text}`);
    for (const a of step.onComplete ?? []) fireAction(ctx, a);
  }
}

/** Evaluate one active quest: fail it if `failWhen` holds, else complete any ready
 *  optional side-goals and auto-advance the spine as far as its guards allow. */
function evaluateActiveQuest(ctx: GameContext, qs: QuestState): void {
  const def = resolveQuestDef(ctx, qs.questId);
  if (!def || qs.status !== 'active') return;
  if (allHold(ctx, def.failWhen)) { failQuest(ctx, qs.questId); return; }
  completeReadyOptionalSteps(ctx, qs, def);
  // A step whose guards already hold completes; its onComplete may satisfy the
  // next step too, so loop (bounded) rather than wait for the next event.
  for (let guard = 0; guard < def.steps.length + 1 && qs.status === 'active'; guard++) {
    const step = stepOf(def, qs.currentStepId);
    if (!step || !allHold(ctx, step.completeWhen)) break;
    completeCurrentStep(ctx, qs, def);
  }
}

export function evaluateQuests(ctx: GameContext): void {
  // Snapshot the list — completing a quest can push nothing, but be safe.
  for (const qs of [...ctx.state.quests]) evaluateActiveQuest(ctx, qs);
}

/** AIGM-driven: complete the current step and advance (to `toStepId` if given and
 *  valid, else the next step). Used by the `advance_quest` tool. */
export function advanceQuest(ctx: GameContext, questId: string, toStepId?: string): boolean {
  const qs = ctx.state.quests.find((q) => q.questId === questId && q.status === 'active');
  const def = qs && resolveQuestDef(ctx, questId);
  if (!qs || !def) return false;
  if (toStepId && stepOf(def, toStepId)) {
    const cur = stepOf(def, qs.currentStepId);
    if (cur && !qs.completedStepIds.includes(cur.id)) {
      qs.completedStepIds.push(cur.id);
      awardXp(ctx, cur.xpReward, `${def.title}: ${cur.text}`);
    }
    qs.currentStepId = toStepId;  // advance before firing onComplete (re-entrancy)
    ctx.addLog({ left: `Objective: ${stepOf(def, toStepId)!.text}`, style: 'status' });
    syncObjective(ctx);
    for (const a of cur?.onComplete ?? []) fireAction(ctx, a);
  } else {
    completeCurrentStep(ctx, qs, def);
  }
  return true;
}

/** AIGM-driven: finish a quest immediately (e.g. narrative resolution). */
export function completeQuest(ctx: GameContext, questId: string): boolean {
  const qs = ctx.state.quests.find((q) => q.questId === questId && q.status === 'active');
  const def = qs && resolveQuestDef(ctx, questId);
  if (!qs || !def) return false;
  finishQuest(ctx, qs, def);
  return true;
}

/** AIGM-driven (or `failWhen`): mark a quest failed. */
export function failQuest(ctx: GameContext, questId: string): boolean {
  const qs = ctx.state.quests.find((q) => q.questId === questId && q.status === 'active');
  const def = qs && resolveQuestDef(ctx, questId);
  if (!qs || !def) return false;
  qs.status = 'failed';
  qs.currentStepId = '';
  for (const a of def.onFail ?? []) fireAction(ctx, a);
  ctx.addLog({ left: `Quest failed: ${def.title}`, style: 'miss' });
  syncObjective(ctx);
  return true;
}
