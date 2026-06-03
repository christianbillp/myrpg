/**
 * IdleTask — the fallback every NPC carries. Scores at a minimum value
 * that's lower than any meaningful task, so it only wins when nothing
 * else fires. Produces a single `IdleAction` per tick: do nothing,
 * emit no events, finish immediately.
 *
 * Serves three purposes:
 *   1. Proves the runner end-to-end without any other tasks registered.
 *   2. Gives every NPC SOMETHING to do, so the runner never logs
 *      `ai.no_task_available` once a registry has been populated.
 *   3. Acts as a zero-cost baseline the future stuck-NPC watchdog can
 *      use to detect "this NPC has been idling for N ticks — something
 *      upstream broke."
 */
import type { NpcAction, NpcTask, SimContext, TaskStep } from '../NpcAction.js';

const IdleAction: NpcAction = {
  id: 'idle',
  preconditions(_sim: SimContext): boolean { return true; },
  apply(_sim: SimContext): void { /* intentional no-op */ },
};

export const IdleTask: NpcTask = {
  id: 'idle',
  priority: 'idle',
  /** Constant tiny score — any normal-band task with score > 0 outranks
   *  this. Within the idle band ties on this score; the runner's RNG
   *  pick handles that. */
  score(_sim: SimContext): number { return 1; },
  nextAction(_sim: SimContext): TaskStep { return IdleAction; },
};
