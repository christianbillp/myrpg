/**
 * WaitHereTask — companion holds its current cell.
 *
 * Used as the target of the player's `wait` command override. Score is
 * zero by default so it never wins via autonomous selection — only the
 * override path activates it. Once active, `nextAction` returns `'done'`
 * every tick, which causes the runner to re-score; the override keeps it
 * pinned at zero until the player clears the wait command.
 *
 * No movement, no event emission. The companion simply stops where it is.
 */
import type { NpcTask, SimContext, TaskStep } from '../NpcAction.js';

export const WaitHereTask: NpcTask = {
  id: 'wait_here',
  priority: 'normal',
  score(_sim: SimContext): number { return 0; },
  nextAction(_sim: SimContext): TaskStep { return 'done'; },
};
