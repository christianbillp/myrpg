/**
 * FollowPlayerTask — companion stays within follow-distance of the player.
 *
 * Scoring
 * -------
 * Score is the Chebyshev distance from the NPC to the player MINUS the
 * follow band's tolerance. When the NPC is already within tolerance the
 * score is 0 (any other task with score > 0 wins); when it's far the
 * score rises linearly so the runner picks this task over Idle / Wander
 * automatically.
 *
 *   • `tight`: 1 tile tolerance (companion stays glued to the player).
 *   • `loose`: 4 tile tolerance (companion trails by 3-5 tiles).
 *
 * `nextAction`
 * ------------
 * Returns a `WalkOneTileAction` toward the player's current tile each
 * tick. When already within tolerance, returns `'done'`. The runner then
 * re-scores and (typically) re-activates the same task on the next tick
 * once the player moves — keeping the companion paced.
 *
 * Pathing is greedy (sign-toward-player), not BFS. Walls and other NPCs
 * are handled by `WalkOneTileAction.preconditions` — when blocked, the
 * runner logs `action_preconditions_failed` and re-scores. A future
 * pass can promote this to a BFS pathfinder if the player drags the
 * companion through a chokepoint and the greedy logic loses.
 *
 * Determinism note — when the NPC and player share a row or column the
 * greedy move is unambiguous; when both axes differ the action moves
 * diagonally (which we already allow elsewhere). No RNG is consumed.
 */
import type { NpcTask, SimContext, TaskStep } from '../NpcAction.js';
import { WalkOneTileAction } from '../actions/WalkOneTileAction.js';

export type FollowMode = 'tight' | 'loose';

const TOLERANCE: Record<FollowMode, number> = {
  tight: 1,
  loose: 4,
};

export class FollowPlayerTask implements NpcTask {
  readonly id = 'follow_player';
  readonly priority = 'normal' as const;

  constructor(public mode: FollowMode = 'loose') {}

  score(sim: SimContext): number {
    const s = sim.ctx.state;
    const dx = Math.abs(sim.npc.tileX - s.player.tileX);
    const dy = Math.abs(sim.npc.tileY - s.player.tileY);
    const cheby = Math.max(dx, dy);
    const tol = TOLERANCE[this.mode];
    return Math.max(0, cheby - tol);
  }

  nextAction(sim: SimContext): TaskStep {
    const s = sim.ctx.state;
    const dx = Math.sign(s.player.tileX - sim.npc.tileX) as -1 | 0 | 1;
    const dy = Math.sign(s.player.tileY - sim.npc.tileY) as -1 | 0 | 1;
    const cheby = Math.max(Math.abs(sim.npc.tileX - s.player.tileX), Math.abs(sim.npc.tileY - s.player.tileY));
    if (cheby <= TOLERANCE[this.mode]) return 'done';
    if (dx === 0 && dy === 0) return 'done';
    return new WalkOneTileAction(dx, dy);
  }
}
