/**
 * AlertTask — NPCs in the `alert` state move aggressively toward the
 * source of the alert. Distinct from InvestigateTask in two ways:
 *
 *   • **Priority** is `'critical'`. An alerted NPC drops their routine
 *     instantly — no waiting for the current task to finish.
 *   • **Tolerance** is `0` (the task only ends when the NPC stands on
 *     the source tile). An NPC in alert mode commits to the destination
 *     instead of stopping at a cautious distance.
 *
 * **Movement only, no threat conversion.** This task does NOT flip the
 * NPC's disposition. A neutral disguised-faction member who gets pinged
 * by `pingFactionAlert` walks to the source tile and stops; they only
 * become hostile if the faction-relation matrix (`isHostileTo`) already
 * says they are. The world-tick's `anyHostileToParty` check escalates
 * to combat for NPCs whose factions ARE hostile to the party — so a
 * bandit who was already going to attack the player just gets there
 * faster. For an alerted-but-friendly NPC, the visible effect is purely
 * the movement nudge + the orange/red ALERTNESS chip on the Target
 * Panel; a separate system (future: investigation dialogue, threat
 * detection) would have to decide whether they actually engage.
 */
import type { NpcTask, SimContext, TaskStep } from '../NpcAction.js';
import { WalkOneTileAction } from '../actions/WalkOneTileAction.js';

export const AlertTask: NpcTask = {
  id: 'alert_move',
  priority: 'critical',

  score(sim: SimContext): number {
    if (sim.npc.alertness !== 'alert') return 0;
    const tile = sim.npc.memory?.lastAlertTile;
    if (!tile) return 0;
    const dx = Math.abs(sim.npc.tileX - tile.x);
    const dy = Math.abs(sim.npc.tileY - tile.y);
    return Math.max(dx, dy) + 100; // priority-band already wins; +100 dominates ties
  },

  nextAction(sim: SimContext): TaskStep {
    const tile = sim.npc.memory?.lastAlertTile;
    if (!tile) return 'done';
    const dx = Math.sign(tile.x - sim.npc.tileX) as -1 | 0 | 1;
    const dy = Math.sign(tile.y - sim.npc.tileY) as -1 | 0 | 1;
    if (dx === 0 && dy === 0) return 'done';
    return new WalkOneTileAction(dx, dy);
  },
};
