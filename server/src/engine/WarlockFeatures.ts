/**
 * Warlock passive-feature hooks that need an engine event subscription rather
 * than a player-triggered handler.
 *
 * Dark One's Blessing (Fiend Patron L3): when the player reduces an enemy to 0
 * Hit Points, they gain Temporary Hit Points equal to CHA modifier + Warlock
 * level (minimum 1). The engine publishes `npc_killed` at the kill site (kills
 * in this single-player engine are the player's or an ally's doing), so we
 * grant the temp HP there. Gated on the `dark-ones-blessing` modifier flag the
 * feature folds onto `playerDef.modifiers`. Temp HP doesn't stack — take the
 * higher value.
 */
import type { GameContext } from './GameContext.js';
import { mod } from './Dice.js';
import { hasModifierFlag } from './Modifiers.js';

export function registerWarlockHooks(ctx: GameContext): void {
  ctx.bus.subscribe('npc_killed', (e) => {
    if (e.type !== 'npc_killed') return;
    if (!hasModifierFlag(ctx.playerDef, 'dark-ones-blessing')) return;
    const amount = Math.max(1, mod(ctx.playerDef.cha) + ctx.playerDef.level);
    if (amount <= (ctx.state.player.tempHp ?? 0)) return;  // SRD: don't stack, keep the higher
    ctx.state.player.tempHp = amount;
    ctx.addLog({
      left: `Dark One's Blessing — ${ctx.playerDef.name} draws ${amount} Temporary HP from the kill.`,
      style: 'status',
    });
  });
}
