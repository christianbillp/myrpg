/**
 * InvestigateTask — NPCs in the `suspicious` alertness state walk toward
 * the tile their last alert came from and look around.
 *
 * Scoring: returns a strong score whenever the NPC is suspicious AND has
 * a known `lastAlertTile`. Zero otherwise, so calm NPCs never pick this.
 * Priority `'normal'` — sits at the same band as routines, so an NPC's
 * suspicion will eclipse a `walk_to` routine row while the alert is fresh
 * and yield back once it decays to `calm`.
 *
 * Behaviour: greedy walk toward `lastAlertTile`. When the NPC is within
 * tolerance (Chebyshev distance ≤ 1), the task returns `'done'` so the
 * runner re-scores; the awareness decay tick is responsible for stepping
 * `suspicious → calm` after a few quiet ticks.
 *
 * The task carries no internal state — it reads `npc.memory` on every
 * `nextAction()` call. That means if a NEW alert comes in mid-walk (a
 * second noise event), the NPC pivots to the new tile automatically.
 */
import type { NpcTask, SimContext, TaskStep } from '../NpcAction.js';
import { WalkOneTileAction } from '../actions/WalkOneTileAction.js';

export const InvestigateTask: NpcTask = {
  id: 'investigate',
  priority: 'normal',

  score(sim: SimContext): number {
    if (sim.npc.alertness !== 'suspicious') return 0;
    const tile = sim.npc.memory?.lastAlertTile;
    if (!tile) return 0;
    const dx = Math.abs(sim.npc.tileX - tile.x);
    const dy = Math.abs(sim.npc.tileY - tile.y);
    return Math.max(dx, dy) + 5; // +5 so even an at-tile suspicion beats routine
  },

  nextAction(sim: SimContext): TaskStep {
    const tile = sim.npc.memory?.lastAlertTile;
    if (!tile) return 'done';
    const dx = Math.sign(tile.x - sim.npc.tileX) as -1 | 0 | 1;
    const dy = Math.sign(tile.y - sim.npc.tileY) as -1 | 0 | 1;
    const cheby = Math.max(Math.abs(sim.npc.tileX - tile.x), Math.abs(sim.npc.tileY - tile.y));
    if (cheby <= 1) return 'done';
    if (dx === 0 && dy === 0) return 'done';
    return new WalkOneTileAction(dx, dy);
  },
};
