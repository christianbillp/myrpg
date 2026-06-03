/**
 * CompanionFollow — responsive follow tick driven by the player's own
 * movement, not the 6-second world tick.
 *
 * The world tick runs `runCompanionTick` once every 6 s (one SRD round),
 * which advances the companion at most one tile per round. That's fine
 * for routine NPCs and ambient sim, but a player walking continuously
 * leaves the companion permanently behind: by the time the world tick
 * fires, the player is already five tiles further away.
 *
 * This hook subscribes to the `player_moved` engine event and walks the
 * companion ONE tile toward the player's new position synchronously
 * inside `doMove`. Events ride along the current state update via
 * `ctx.eventSink`, so the client sees the companion's step in the same
 * frame as the player's. The world tick still runs in the background
 * — it serves as the catch-up path if the companion blocks behind
 * impassable terrain and needs an extra step when the player stops.
 *
 * Scope: exploration phase only. Combat companion behaviour routes
 * through `NpcTurnRunners.runSingleAllyTurn` on the companion's own
 * initiative slot.
 *
 * The hook respects the player's WAIT override (`companion.override.kind
 * === 'wait'`) — the companion stays put while the player walks.
 */
import type { GameContext } from '../GameContext.js';
import type { GameEvent, NpcState } from '../types.js';
import { Logger } from '../../Logger.js';

/** Follow-distance tolerance per mode. Mirrors `FollowPlayerTask`. */
const TOLERANCE = { tight: 1, loose: 4 } as const;

export function registerCompanionFollowHooks(ctx: GameContext): void {
  ctx.bus.subscribe('player_moved', (e) => {
    const s = ctx.state;
    if (s.phase !== 'exploring') return;
    for (const npc of s.npcs) {
      if (npc.hp <= 0) continue;
      if (!npc.companion) continue;
      // Player-issued WAIT keeps the companion pinned to their tile.
      if (npc.companion.override?.kind === 'wait') continue;
      stepCompanionToward(ctx, npc, e.x, e.y);
    }
  }, /*priority*/ 10);
}

/**
 * Take ONE greedy step toward the target tile. No-op when the companion
 * is already within follow tolerance. Skips silently when the next tile
 * is impassable, occupied, or off-map — the world tick's task scorer
 * will retry with a different direction on the next round, and the
 * player's next step gives this hook another chance.
 */
function stepCompanionToward(ctx: GameContext, npc: NpcState, targetX: number, targetY: number): void {
  const s = ctx.state;
  const tol = TOLERANCE[npc.companion!.followMode];
  const cheby = Math.max(Math.abs(npc.tileX - targetX), Math.abs(npc.tileY - targetY));
  if (cheby <= tol) return;
  const dx = Math.sign(targetX - npc.tileX) as -1 | 0 | 1;
  const dy = Math.sign(targetY - npc.tileY) as -1 | 0 | 1;
  if (dx === 0 && dy === 0) return;
  const nx = npc.tileX + dx;
  const ny = npc.tileY + dy;
  if (nx < 0 || nx >= s.map.cols || ny < 0 || ny >= s.map.rows) return;
  if (!s.map.passable[ny][nx]) return;
  if (s.player.tileX === nx && s.player.tileY === ny) return;
  if (s.npcs.some((n) => n !== npc && n.hp > 0 && n.tileX === nx && n.tileY === ny)) return;
  npc.tileX = nx;
  npc.tileY = ny;
  const move: GameEvent = { type: 'entity_move', entityId: npc.id, toX: nx, toY: ny };
  ctx.eventSink?.push(move);
  Logger.log('ai.companion_step', { npcId: npc.id, to: { x: nx, y: ny }, target: { x: targetX, y: targetY }, mode: npc.companion!.followMode }, 'debug');
}
