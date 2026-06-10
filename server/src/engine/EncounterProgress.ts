import type { GameContext } from './GameContext.js';
import { isHostileTo } from './FactionRelations.js';
import { PLAYER_FACTION_ID, PLAYER_ID } from '../../../shared/types.js';
import { hasPendingRite } from './EncounterLifecycle.js';

/**
 * EncounterProgress — subscribes to the engine event bus and flips
 * `GameState.encounterComplete` to `true` when the active encounter has
 * resolved. Runs in both adventure and single-encounter modes; the client
 * `OverlayManager` branches on `adventureContext` to render the right
 * wrap-up overlay (chapter overlay vs single-encounter overlay).
 *
 * Triggers (in priority order):
 *  1. `encounter_completed` lifecycle event — fired by `EncounterLifecycle`
 *     whenever the encounter resolves (combat with no enemies left, OR the
 *     encounter's `completionFlag` getting set). Registered unconditionally
 *     so single-encounter sessions also surface a completion overlay.
 *  2. The chapter declared a `completionFlag` via its AdventureChapter def,
 *     and that worldFlag has just been set. Adventure-only — kept for
 *     chapters whose flag differs from the encounter's flag.
 *  3. Combat ends with no living enemies (legacy default — kept for
 *     symmetry / belt-and-braces, even though path 1 already handles it).
 *
 * The flag is one-way: subsequent events don't clear it. The chapter-advance
 * route on the server reads it (and `finishedState` in general) when the
 * player clicks NEXT CHAPTER; single-encounter mode just returns to the
 * menu without round-tripping the server's chapter machinery.
 */
export function registerEncounterProgress(ctx: GameContext): void {
  // Unconditional: a single-encounter session has no adventureContext but
  // still wants a completion event so the client can show the wrap-up
  // overlay + RETURN TO MENU button.
  ctx.bus.subscribe('encounter_completed', () => {
    ctx.state.encounterComplete = true;
    // Make the declared completion flag a reliable signal: when the encounter
    // resolves by ANY path (combat-clear included), set its `completionFlag` if
    // content hasn't already. Downstream consumers — notably quest steps keyed
    // on the flag via `completeWhen` — depend on the flag being WRITTEN, not just
    // on `encounterComplete`. Idempotent: skipped when content set it first
    // (a_posting / bridge / sage), so no duplicate `flag_set`.
    const flag = ctx.state.encounterCompletionFlag ?? ctx.state.adventureContext?.completionFlag;
    if (flag && ctx.state.worldFlags[flag] !== true) {
      ctx.state.worldFlags[flag] = true;
      ctx.bus.publish({ type: 'flag_set', name: flag, value: true });
    }
  }, /*priority*/ 40);

  ctx.bus.subscribe('combat_ended', () => {
    const s = ctx.state;
    const partyView = { id: PLAYER_ID, factionId: PLAYER_FACTION_ID } as const;
    const enemiesAlive = s.npcs.some((n) => n.hp > 0
      && isHostileTo(s, partyView, { id: n.id, factionId: n.factionId }));
    // Hold completion while a rite is still pending (see EncounterLifecycle), or
    // when the encounter opts into flag-only completion (combat is a step, not
    // the objective — only `completionFlag` finishes it).
    if (s.encounterCompleteOnFlagOnly) return;
    if (!enemiesAlive && !hasPendingRite(s)) s.encounterComplete = true;
  }, /*priority*/ 40);

  const completionFlag = ctx.state.adventureContext?.completionFlag;
  if (completionFlag) {
    ctx.bus.subscribe('flag_set', (e) => {
      if (e.name === completionFlag) ctx.state.encounterComplete = true;
    }, /*priority*/ 40);
  }
}
