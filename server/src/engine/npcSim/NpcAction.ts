/**
 * NpcAction + NpcTask + SimContext — the engine spine for the NPC
 * simulation. Every NPC decision (whether the entity is a companion, an
 * ambient townsperson, or a hostile monster) flows through these
 * interfaces.
 *
 * Design notes
 * ------------
 * - **Two-level model.** Top-level decisions are TASKS — multi-tick goals
 *   like `WalkTo(target)` or `AttackUntilDead(targetId)`. Tasks decompose
 *   at runtime into per-tick atomic ACTIONS. This produces NPCs that look
 *   purposeful (they pursue a goal across many ticks) while remaining
 *   trivially interruptible (any tick the scorer can decide a new task
 *   has higher utility).
 *
 * - **One scorer for everyone.** Companions and ambient NPCs use the same
 *   `score()` pipeline; the only difference is that companions can be
 *   given a CommandOverride that short-circuits selection. This means
 *   when we tune NPC behaviour we're tuning it for the entire world.
 *
 * - **No engine state writes in `score`.** Score functions MUST be pure:
 *   inspect state, return a number. Mutation only happens in
 *   `NpcAction.apply` and `NpcTask.nextAction`'s state machine. This
 *   keeps the scorer testable and the determinism story clean.
 *
 * - **Determinism.** Every random pick goes through `SimRng` carried on
 *   the `SimContext`. Direct `Math.random` calls are a bug.
 */
import type { GameContext } from '../GameContext.js';
import type { GameEvent, NpcState } from '../types.js';
import type { SimRng } from './SimRng.js';

/**
 * Per-tick context handed to every score + apply call. Wraps the live
 * `GameContext` and the NPC under consideration, plus the seeded RNG and
 * a place to append client-facing animation events.
 */
export interface SimContext {
  /** The live engine context — read state, mutate via its helpers. */
  ctx: GameContext;
  /** The NPC whose tick is being evaluated. */
  npc: NpcState;
  /** Deterministic RNG keyed by (tickId, npc.id). */
  rng: SimRng;
  /** Animation / WS events the action produces. Same array the engine
   *  flushes at the end of the tick. */
  events: GameEvent[];
  /** Monotonic tick id. Useful for cooldowns ("can re-cast after tick + 60"). */
  tickId: number;
}

/**
 * Atomic per-tick step. Returned by a task's `nextAction()`; the engine
 * checks `preconditions` (in case the world moved between selection and
 * application), then calls `apply` if they still hold.
 *
 * Most actions are stateless singletons — declare once at module scope
 * and reuse. Stateful steps (e.g. partial swings) belong inside the
 * owning task, not on the action.
 */
export interface NpcAction {
  /** Short identifier for logging. `walk_step`, `attack_melee`, `idle`. */
  readonly id: string;
  /** Returns false if the action can no longer be executed right now
   *  (target died, path blocked, etc.). The runner will ask the task
   *  for another action OR force a re-score. */
  preconditions(sim: SimContext): boolean;
  /** Execute the step. Mutates engine state, pushes events. Must NOT
   *  re-score or pick a follow-up action — that's the task's job. */
  apply(sim: SimContext): void;
}

/**
 * Possible results of a task asking "what should the NPC do this tick?".
 *
 *   • An `NpcAction` to execute.
 *   • `'done'` — the task completed; the runner re-scores all tasks for
 *     the next tick.
 *   • `'interrupted'` — the task can no longer make progress (lost sight
 *     of the target, ally died, condition prevents movement). Same
 *     effect as `'done'` from the runner's POV but logged differently
 *     so we can see in the decision log whether tasks tend to finish
 *     cleanly or get yanked.
 */
export type TaskStep = NpcAction | 'done' | 'interrupted';

/**
 * Multi-tick goal. Stateful — the task instance holds whatever state it
 * needs to resume on the next tick (the cell it's walking toward, the
 * target id it's attacking, the number of steps remaining).
 *
 * Tasks are picked by `NpcTickRunner` via their `score()` function. The
 * winner's `nextAction()` runs once per tick until it returns 'done' or
 * 'interrupted'. Tasks declare their `priority` band so a critical task
 * (FLEE on low HP) can outrank a high-utility but routine task (PATROL).
 */
export interface NpcTask {
  /** Short identifier for logging. `idle`, `walk_to_target`, `follow_player`. */
  readonly id: string;
  /**
   * Priority band — coarse-grained importance. Tasks in a higher band
   * always beat tasks in a lower band, regardless of `score`. Three
   * bands today; more can be added without touching the runner.
   *
   *   • `'critical'` — life-or-death (FLEE_LOW_HP, RESPOND_TO_PLAYER_COMMAND)
   *   • `'normal'`   — combat, patrolling, following — most behaviour
   *   • `'idle'`     — fallback when nothing else fires; should always score
   */
  readonly priority: TaskPriority;
  /**
   * Utility score for THIS NPC, THIS tick. Higher = more attractive.
   * Pure function of state — must not write. The runner only consults
   * the highest-priority band; ties within the band are broken by score,
   * further ties by `rng.pick`.
   */
  score(sim: SimContext): number;
  /**
   * Drive the task forward one tick. The runner calls this in a loop
   * (well — once per tick) until it returns 'done' or 'interrupted'.
   * Implementations are typically a small switch on internal phase.
   */
  nextAction(sim: SimContext): TaskStep;
  /**
   * Optional hook called once when this task becomes active (replaces
   * the previous task). Use to capture starting state (e.g. anchor
   * position for a PATROL task).
   */
  onActivate?(sim: SimContext): void;
  /**
   * Optional hook called once when the task ends ('done' / 'interrupted')
   * OR when a higher-priority task preempts it. Use to release locks
   * (drop a held item, release a reserved tile).
   */
  onDeactivate?(sim: SimContext, reason: 'done' | 'interrupted' | 'preempted'): void;
}

export type TaskPriority = 'critical' | 'normal' | 'idle';
