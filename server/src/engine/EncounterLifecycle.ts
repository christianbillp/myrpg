import type { GameContext } from './GameContext.js';
import { isHostileTo } from './FactionRelations.js';
import { PLAYER_FACTION_ID } from '../../../shared/types.js';

/**
 * EncounterLifecycle — publishes the two lifecycle EngineEvents that encounter
 * authors can hook from triggers:
 *
 *   - `encounter_started`   fires ONCE at session boot, after every other
 *                           subsystem has registered. Use to attach intro
 *                           cinematics (supertitle, fade-in, opening
 *                           announcement). The engine routes any GameEvents
 *                           the triggers emit into a startup-event sink that
 *                           is flushed on the first WS state_update — so the
 *                           cinematic plays the moment the client connects.
 *
 *   - `encounter_completed` fires ONCE when the encounter resolves. Two
 *                           detection paths (whichever happens first):
 *                              a) `combat_ended` with no living enemies left
 *                                 (combat victory)
 *                              b) `flag_set` whose name matches the encounter's
 *                                 `completionFlag` (peaceful resolution,
 *                                 adventure-chapter resolution, …)
 *
 * Dedup is local to this subsystem — once the lifecycle event has been
 * published, subsequent matching engine events do not re-fire it.
 */
export function registerEncounterLifecycle(ctx: GameContext): void {
  let completedFired = false;

  const fireCompleted = (): void => {
    if (completedFired) return;
    completedFired = true;
    ctx.publish({ type: 'encounter_completed' });
  };

  ctx.bus.subscribe('combat_ended', () => {
    const s = ctx.state;
    const partyView = { factionId: PLAYER_FACTION_ID } as const;
    const enemiesAlive = s.npcs.some((n) => n.hp > 0
      && isHostileTo(s, partyView, { factionId: n.factionId, disposition: n.disposition }));
    if (!enemiesAlive) fireCompleted();
  }, /*priority*/ 30);

  ctx.bus.subscribe('flag_set', (e) => {
    const flag = ctx.state.encounterCompletionFlag
      ?? ctx.state.adventureContext?.completionFlag;
    if (!flag) return;
    if (e.name === flag) fireCompleted();
  }, /*priority*/ 30);
}

/**
 * Fires `encounter_started`. Called by GameEngine AFTER every subscriber has
 * registered, with `ctx.eventSink` pointed at the engine's startup-event
 * buffer so any trigger-emitted GameEvents (supertitle, fade, …) are
 * captured for the first WS state_update.
 */
export function publishEncounterStarted(ctx: GameContext): void {
  ctx.publish({ type: 'encounter_started' });
}
