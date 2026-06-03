/**
 * WalkToTask — generic "walk to a fixed tile" multi-tick task.
 *
 * Used by the routine system (a tavern keeper's `morning` task walks them
 * to the bar) and any other code path that needs to send an NPC to a
 * specific cell. Self-contained — picks atomic `WalkOneTileAction`
 * instances greedily until the NPC stands on the target tile, then
 * returns `'done'`.
 *
 * Scoring
 * -------
 * Same shape as `FollowPlayerTask`: returns the Chebyshev distance from
 * the NPC to the target tile. Zero when already there (any other task
 * with score > 0 wins). Walking-distance scoring keeps the task active
 * across many ticks, matching how routine providers expect it to work.
 *
 * Pathing is greedy (sign-toward-target) like FollowPlayerTask — chokepoints
 * will still confuse it. Future BFS upgrade will benefit both tasks.
 */
import type { NpcTask, SimContext, TaskStep } from '../NpcAction.js';
import { WalkOneTileAction } from '../actions/WalkOneTileAction.js';

export class WalkToTask implements NpcTask {
  readonly id: string;
  readonly priority = 'normal' as const;

  constructor(
    private readonly targetX: number,
    private readonly targetY: number,
    /** Task id used for sim-state tracking + logs. Defaults to
     *  `walk_to:<x>,<y>` so multiple WalkTo tasks in the same registry
     *  don't share an id. */
    idHint?: string,
  ) {
    this.id = idHint ?? `walk_to:${targetX},${targetY}`;
  }

  score(sim: SimContext): number {
    const dx = Math.abs(sim.npc.tileX - this.targetX);
    const dy = Math.abs(sim.npc.tileY - this.targetY);
    return Math.max(dx, dy);
  }

  nextAction(sim: SimContext): TaskStep {
    const dx = Math.sign(this.targetX - sim.npc.tileX) as -1 | 0 | 1;
    const dy = Math.sign(this.targetY - sim.npc.tileY) as -1 | 0 | 1;
    if (dx === 0 && dy === 0) return 'done';
    return new WalkOneTileAction(dx, dy);
  }
}
