/**
 * NpcTickRunner — the per-NPC heartbeat of the simulation.
 *
 * Responsibilities
 * ----------------
 * - Hold the **currently-active task** per NPC across ticks.
 * - On each tick:
 *     1. Resume the active task (call `nextAction()` until it produces
 *        an action or signals `'done' | 'interrupted'`).
 *     2. If the task finishes, re-score every registered task and
 *        activate the highest-priority + highest-scoring one.
 *     3. Run the chosen action's `apply()` and emit events.
 * - Log every decision via `Logger.log('ai.decision', ...)` so the NDJSON
 *   stream captures the full reasoning chain (which task ran, with what
 *   score, why the previous task ended).
 *
 * Companion override
 * ------------------
 * Companions get a `CommandOverride` (set by the player via the COMPANION
 * chip — e.g. "FOLLOW", "ATTACK target", "WAIT"). When present, the
 * override produces a task directly and skips scoring. Cleared when the
 * task finishes naturally; the next tick falls back to the autonomous
 * scorer.
 *
 * Out-of-scope (yet)
 * ------------------
 * - LOD bands (foreground / background / frozen).
 * - World-state scope (this runs inside the existing GameContext per
 *   encounter; the persistent-world refactor is a later step).
 * - Migrating EnemyAI onto this engine. EnemyAI keeps its current path
 *   until we've validated this loop with a companion.
 */
import type { NpcState } from '../types.js';
import { Logger } from '../../Logger.js';
import type { NpcAction, NpcTask, SimContext, TaskPriority } from './NpcAction.js';

/** Registry of tasks that COULD run for a given NPC. Owned per-NPC so
 *  different creatures can carry different task pools (a wolf has no
 *  PATROL task, a tavern keeper has no ATTACK_MELEE task). */
export interface NpcTaskRegistry {
  tasks: NpcTask[];
  /** Optional command override (set by the player for companions). The
   *  runner consults this BEFORE scoring; when present it builds the
   *  matching task and runs it directly. Cleared when the task ends. */
  override?: CommandOverride;
}

/**
 * Player-issued instruction for a companion. The runner translates the
 * override into a task instance — typically one that already exists in
 * the companion's `tasks[]` registered with a tag — and runs it.
 */
export type CommandOverride =
  | { kind: 'follow'; mode: 'tight' | 'loose' }
  | { kind: 'wait' }
  | { kind: 'attack'; targetId: string }
  | { kind: 'cast'; spellId: string; targetId?: string }
  | { kind: 'move_to'; tileX: number; tileY: number };

/**
 * Per-NPC runtime state the runner owns across ticks. Persisted as part
 * of the GameState save — every field is plain JSON so a save round-trip
 * keeps the NPC mid-task.
 */
export interface NpcSimState {
  /** The task active at the end of the previous tick, or null if the
   *  runner needs to re-score. Identified by its `id`. */
  activeTaskId: string | null;
  /** Last tick the runner advanced this NPC. Used to drive cooldowns
   *  and to detect "stuck-NPC" watchdog cases. */
  lastTickId: number;
}

/** Priority ordering — higher band always wins over lower band. */
const PRIORITY_RANK: Record<TaskPriority, number> = {
  critical: 3,
  normal:   2,
  idle:     1,
};

export class NpcTickRunner {
  /**
   * Advance one NPC by one tick.
   *
   *   1. If an active task remains from last tick and is still in the
   *      registry, resume it. The task decides whether to keep going
   *      or signal completion.
   *   2. On completion / interruption (or no prior task), pick a fresh
   *      task by scoring.
   *   3. Run the chosen task's first action, apply it, log the decision.
   */
  static run(
    sim: SimContext,
    registry: NpcTaskRegistry,
    simState: NpcSimState,
  ): void {
    simState.lastTickId = sim.tickId;

    // 1. Command override short-circuits autonomous selection. The
    // override is consumed when the task finishes — the next tick
    // re-enters the scorer.
    const overrideTask = registry.override ? findOverrideTask(registry, registry.override) : null;
    if (overrideTask) {
      runOneTick(sim, overrideTask, simState, /* viaOverride */ true);
      return;
    }

    // 2. Try to resume the prior task.
    if (simState.activeTaskId !== null) {
      const resumed = registry.tasks.find((t) => t.id === simState.activeTaskId) ?? null;
      if (resumed) {
        const result = runOneTick(sim, resumed, simState, false);
        if (result === 'continue') return;
        // Otherwise fall through and pick a new task.
      } else {
        // Active task was unregistered between ticks — log and re-score.
        Logger.log('ai.task_unregistered', { npcId: sim.npc.id, taskId: simState.activeTaskId });
        simState.activeTaskId = null;
      }
    }

    // 3. Score every task and pick the winner. Highest priority band
    // wins; within the band, highest score; ties broken by `rng.pick`.
    const winner = selectTask(sim, registry);
    if (!winner) {
      Logger.log('ai.no_task_available', { npcId: sim.npc.id });
      return;
    }
    winner.onActivate?.(sim);
    runOneTick(sim, winner, simState, false);
  }
}

/** Internal — score every task, sort by priority band then score, pick
 *  the winner (with RNG tie-break). Logs the full score sheet at debug. */
function selectTask(sim: SimContext, registry: NpcTaskRegistry): NpcTask | null {
  if (registry.tasks.length === 0) return null;
  const scored = registry.tasks.map((t) => ({
    task: t,
    score: t.score(sim),
    rank: PRIORITY_RANK[t.priority],
  }));
  // Highest rank first, then highest score.
  scored.sort((a, b) => (b.rank - a.rank) || (b.score - a.score));
  Logger.log('ai.decision', {
    npcId: sim.npc.id,
    tickId: sim.tickId,
    chose: scored[0].task.id,
    scores: scored.map((s) => ({ id: s.task.id, score: s.score, priority: s.task.priority })),
  }, 'debug');
  // Resolve ties within the winning (rank, score) bucket via the seeded RNG.
  const top = scored[0];
  const tied = scored.filter((s) => s.rank === top.rank && s.score === top.score);
  if (tied.length === 1) return tied[0].task;
  return sim.rng.pick(tied.map((s) => s.task));
}

/** Internal — run one tick of the given task. Updates `simState`,
 *  applies the action, returns whether the task wants another tick
 *  (`'continue'`) or signalled its end (`'ended'`). */
function runOneTick(
  sim: SimContext,
  task: NpcTask,
  simState: NpcSimState,
  viaOverride: boolean,
): 'continue' | 'ended' {
  simState.activeTaskId = task.id;
  const step = task.nextAction(sim);
  if (step === 'done' || step === 'interrupted') {
    task.onDeactivate?.(sim, step);
    simState.activeTaskId = null;
    Logger.log('ai.task_ended', { npcId: sim.npc.id, taskId: task.id, reason: step, viaOverride }, 'debug');
    return 'ended';
  }
  const action: NpcAction = step;
  if (!action.preconditions(sim)) {
    // The world changed under us between selection and application —
    // mark the task interrupted so the runner re-scores next tick.
    task.onDeactivate?.(sim, 'interrupted');
    simState.activeTaskId = null;
    Logger.log('ai.action_preconditions_failed', { npcId: sim.npc.id, taskId: task.id, actionId: action.id }, 'debug');
    return 'ended';
  }
  action.apply(sim);
  return 'continue';
}

/** Internal — translate a CommandOverride into the matching task from
 *  the registry. Tasks tag themselves by id (`'follow_player'`,
 *  `'wait_here'`, etc.) so the override lookup is a simple find by id.
 *  Returns null if the override references a task the NPC doesn't have. */
function findOverrideTask(registry: NpcTaskRegistry, override: CommandOverride): NpcTask | null {
  const id = (() => {
    switch (override.kind) {
      case 'follow':  return 'follow_player';
      case 'wait':    return 'wait_here';
      case 'attack':  return 'attack_target';
      case 'cast':    return 'cast_spell';
      case 'move_to': return 'companion_move_to';
    }
  })();
  return registry.tasks.find((t) => t.id === id) ?? null;
}
