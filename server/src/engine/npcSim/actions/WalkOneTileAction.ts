/**
 * WalkOneTileAction — move an NPC by one tile in a target direction.
 *
 * Generic atomic step used by any task that needs to traverse a path
 * (FollowPlayer, PatrolRoute, WalkTo, …). Tasks decide the direction
 * each tick by re-reading the world; the action just commits the step.
 *
 * Movement rules:
 *   • Respect map bounds + per-cell `passable` grid (same source as the
 *     engine's other movement code paths).
 *   • Refuse to step onto another living NPC's tile or the player's tile.
 *   • Emit one `entity_move` event so the client animates the step the
 *     same way it animates EnemyAI movement.
 *
 * Direction is encoded as `(dx, dy)` in `-1 | 0 | 1`. Diagonal allowed
 * — the engine's other movement code already treats diagonals as legal
 * single-tile steps (Chebyshev distance).
 *
 * The action is constructed once per use (it carries the direction), but
 * the underlying object is otherwise cheap. Tasks typically allocate a
 * fresh instance per `nextAction()` call.
 */
import type { NpcAction, SimContext } from '../NpcAction.js';

export class WalkOneTileAction implements NpcAction {
  readonly id = 'walk_step';

  constructor(private readonly dx: -1 | 0 | 1, private readonly dy: -1 | 0 | 1) {}

  preconditions(sim: SimContext): boolean {
    if (this.dx === 0 && this.dy === 0) return false;
    const s = sim.ctx.state;
    const nx = sim.npc.tileX + this.dx;
    const ny = sim.npc.tileY + this.dy;
    if (nx < 0 || nx >= s.map.cols || ny < 0 || ny >= s.map.rows) return false;
    if (!s.map.passable[ny][nx]) return false;
    if (s.player.tileX === nx && s.player.tileY === ny) return false;
    if (s.npcs.some((n) => n !== sim.npc && n.hp > 0 && n.tileX === nx && n.tileY === ny)) return false;
    return true;
  }

  apply(sim: SimContext): void {
    const nx = sim.npc.tileX + this.dx;
    const ny = sim.npc.tileY + this.dy;
    sim.npc.tileX = nx;
    sim.npc.tileY = ny;
    sim.events.push({ type: 'entity_move', entityId: sim.npc.id, toX: nx, toY: ny });
  }
}
