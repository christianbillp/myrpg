/**
 * RoutineRegistry — translates an NPC's authored `routine: RoutineEntry[]`
 * + the current `dayPhase` into the task list the tick runner consumes.
 *
 * One row per phase wins. When the NPC's routine has no row for the
 * current phase, the registry just returns `IdleTask`. When the row's
 * `task.kind` is `walk_to`, the registry builds a `WalkToTask` pointed
 * at the target tile; when `idle`, the registry returns `IdleTask`.
 *
 * This module is the bridge between the AUTHORING shape (RoutineEntry)
 * and the RUNTIME shape (NpcTask) — adding a new routine `task.kind`
 * means extending this switch + adding the corresponding task class.
 */
import type { DayPhase, NpcState, RoutineEntry } from '../../types.js';
import type { NpcTask } from '../NpcAction.js';
import { IdleTask } from './IdleTask.js';
import { WalkToTask } from './WalkToTask.js';
import { InvestigateTask } from './InvestigateTask.js';
import { AlertTask } from './AlertTask.js';

/** Build the task list a routine-bearing NPC's `NpcTaskRegistry` should
 *  carry for the given day phase. Always includes `IdleTask` and the two
 *  awareness tasks (`InvestigateTask`, `AlertTask`) so an alerted NPC can
 *  break out of its routine row to chase the source. Then appends the
 *  task derived from the matching routine row, if any. */
export function tasksForRoutine(npc: NpcState, dayPhase: DayPhase): NpcTask[] {
  const tasks: NpcTask[] = [IdleTask, InvestigateTask, AlertTask];
  if (!npc.routine || npc.routine.length === 0) return tasks;
  const row = npc.routine.find((r) => r.phase === dayPhase);
  if (!row) return tasks;
  tasks.push(taskFromRoutineEntry(row));
  return tasks;
}

/** Turn one authored routine row into a live `NpcTask`. Public so the
 *  awareness pass in step 6 can compose routine tasks with `Investigate`
 *  / `Alert` etc. without going through the full `tasksForRoutine` path. */
export function taskFromRoutineEntry(row: RoutineEntry): NpcTask {
  switch (row.task.kind) {
    case 'walk_to':
      return new WalkToTask(row.task.tileX, row.task.tileY, `routine:walk_to:${row.phase}`);
    case 'idle':
      return IdleTask;
  }
}
