import type { GameContext } from './GameContext.js';

/**
 * AdventureProgress — subscribes to the engine event bus and flips
 * `GameState.chapterComplete` to `true` when the active chapter has resolved.
 *
 * Triggers (in priority order):
 *  1. The chapter declared a `completionFlag` via its AdventureChapter def,
 *     and that worldFlag has just been set.
 *  2. Combat ends with no living enemies (default detection — covers most
 *     authored chapters without requiring an explicit flag).
 *
 * Once `chapterComplete` is true, the client renders the END CHAPTER button.
 * The flag is one-way: subsequent events don't clear it. The chapter-advance
 * route on the server reads it (and finishedState in general) when the
 * player clicks END CHAPTER.
 */
export function registerAdventureProgress(ctx: GameContext): void {
  if (!ctx.state.adventureContext) return;
  const completionFlag = ctx.state.adventureContext.completionFlag;

  ctx.bus.subscribe('combat_ended', () => {
    // The bus fires this from `endCombat` AFTER enemies have been filtered
    // out. If no enemies remain alive, the chapter is resolved.
    const enemiesAlive = ctx.state.npcs.some((n) => n.disposition === 'enemy' && n.hp > 0);
    if (!enemiesAlive) ctx.state.chapterComplete = true;
  }, /*priority*/ 40);

  if (completionFlag) {
    ctx.bus.subscribe('flag_set', (e) => {
      if (e.name === completionFlag) ctx.state.chapterComplete = true;
    }, /*priority*/ 40);
  }
}
