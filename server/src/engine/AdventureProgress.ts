import type { GameContext } from './GameContext.js';
import { isHostileTo } from './FactionRelations.js';
import { PLAYER_FACTION_ID } from '../../../shared/types.js';

/**
 * AdventureProgress — subscribes to the engine event bus and flips
 * `GameState.encounterComplete` to `true` when the active encounter has
 * resolved. The name predates single-encounter mode; the flag now means
 * "the encounter is done" in both adventure and one-off modes, and the
 * client OverlayManager branches on `adventureContext` to render the
 * right wrap-up overlay (chapter overlay vs single-encounter overlay).
 *
 * Triggers (in priority order):
 *  1. `encounter_completed` lifecycle event — fired by EncounterLifecycle
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
 * route on the server reads it (and finishedState in general) when the
 * player clicks NEXT CHAPTER; single-encounter mode just returns to the
 * menu without round-tripping the server's chapter machinery.
 */
export function registerAdventureProgress(ctx: GameContext): void {
  // Unconditional: a single-encounter session has no adventureContext but
  // still wants a completion event so the client can show the wrap-up
  // overlay + RETURN TO MENU button.
  ctx.bus.subscribe('encounter_completed', () => {
    ctx.state.encounterComplete = true;
  }, /*priority*/ 40);

  ctx.bus.subscribe('combat_ended', () => {
    const s = ctx.state;
    const partyView = { factionId: PLAYER_FACTION_ID } as const;
    const enemiesAlive = s.npcs.some((n) => n.hp > 0
      && isHostileTo(s, partyView, { factionId: n.factionId, disposition: n.disposition }));
    if (!enemiesAlive) s.encounterComplete = true;
  }, /*priority*/ 40);

  const completionFlag = ctx.state.adventureContext?.completionFlag;
  if (completionFlag) {
    ctx.bus.subscribe('flag_set', (e) => {
      if (e.name === completionFlag) ctx.state.encounterComplete = true;
    }, /*priority*/ 40);
  }
}
