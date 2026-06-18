/**
 * PresentationHooks — projects internal engine events into the ordered client
 * animation timeline (`GameEvent`s on `ctx.eventSink`).
 *
 * The engine already publishes `damage_dealt` and `npc_killed` synchronously at
 * the exact resolution moment, interleaved with the `entity_move` pushes that
 * the movement code writes directly to the same `events` buffer. By converting
 * those engine events into client `damage` / `death` beats here, the client
 * receives a single, correctly-ordered timeline (move → … → damage → death)
 * without every resolver having to know about presentation. `ctx.eventSink` is
 * set for the duration of an action; when it's null (off-action world ticks)
 * the pushes are harmless no-ops.
 *
 * `damage_dealt` fires *after* HP has been applied, so the target's current HP
 * is the post-damage value the client animates the bar down to.
 */
import type { GameContext } from './GameContext.js';

export function registerPresentationHooks(ctx: GameContext): void {
  ctx.bus.subscribe('damage_dealt', (e) => {
    if (e.type !== 'damage_dealt') return;
    const newHp = e.target === 'player'
      ? ctx.state.player.hp
      : ctx.state.npcs.find((n) => n.id === e.target)?.hp;
    if (newHp === undefined) return;
    ctx.eventSink?.push({ type: 'damage', entityId: e.target, amount: e.amount, newHp });
  });

  ctx.bus.subscribe('npc_killed', (e) => {
    if (e.type !== 'npc_killed') return;
    ctx.eventSink?.push({ type: 'death', entityId: e.npcId });
  });

  // Turn boundaries → timeline beats, so the client's Turn Order Bar highlight and
  // the "turn breath" between combatants ride the animation timeline rather than
  // snapping to the final state (Roadmap · M1). Already published to the bus by
  // the combat-flow / NPC-turn runners — this only projects them to the client.
  ctx.bus.subscribe('turn_started', (e) => {
    if (e.type !== 'turn_started') return;
    ctx.eventSink?.push({ type: 'turn_started', combatantId: e.combatantId });
  });
  ctx.bus.subscribe('turn_ended', (e) => {
    if (e.type !== 'turn_ended') return;
    ctx.eventSink?.push({ type: 'turn_ended', combatantId: e.combatantId });
  });

  // A noise → a "sound ring" beat at its origin, so audible events out of the
  // player's line of sight get visual feedback on the timeline (Roadmap · M1).
  ctx.bus.subscribe('noise', (e) => {
    if (e.type !== 'noise') return;
    ctx.eventSink?.push({ type: 'sound_ring', x: e.x, y: e.y, intensity: e.intensity });
  });
}
