// Single source of truth for "can the player take action X right now?".
// Both computeAvailableActions (UI hint) and the action handlers (server
// enforcement) call into these — never re-derive the same preconditions.

import type { GameContext } from './GameContext.js';
import { isIncapacitated } from './ConditionSystem.js';
import { chebyshev } from './EnemyAI.js';

/** Can the player spend their Action right now (any Action — Attack, Dash, etc.)? */
export function canSpendAction(ctx: GameContext): boolean {
  const s = ctx.state;
  return s.phase === 'player_turn'
    && !s.player.actionUsed
    && !isIncapacitated(s.player.conditions);
}

/** Can the player spend their Bonus Action right now? */
export function canSpendBonusAction(ctx: GameContext): boolean {
  const s = ctx.state;
  return s.phase === 'player_turn'
    && !s.player.bonusActionUsed
    && !isIncapacitated(s.player.conditions);
}

/** Are there any living enemies the player can be targeted by / can target? */
export function hasLivingEnemies(ctx: GameContext): boolean {
  return ctx.state.npcs.some((n) => n.disposition === 'enemy' && n.hp > 0);
}

/** Can the player Hide via Cunning Action (Rogue)? */
export function canHide(ctx: GameContext): boolean {
  const p = ctx.state.player;
  return canSpendBonusAction(ctx)
    && ctx.playerDef.sneakAttackDice > 0
    && !p.conditions.includes('hidden')
    && hasLivingEnemies(ctx);
}

/** Can the player spend Second Wind right now? */
export function canSecondWind(ctx: GameContext): boolean {
  const p = ctx.state.player;
  return canSpendBonusAction(ctx)
    && ctx.playerDef.secondWindMaxUses > 0
    && p.secondWindUses > 0
    && p.hp < ctx.playerDef.maxHp;
}

/** Can the player Dash this turn? */
export function canDash(ctx: GameContext): boolean { return canSpendAction(ctx); }

/** Can the player Dodge this turn? */
export function canDodge(ctx: GameContext): boolean { return canSpendAction(ctx); }

/** Can the player Disengage this turn? Requires a living enemy to be meaningful. */
export function canDisengage(ctx: GameContext): boolean {
  return canSpendAction(ctx) && hasLivingEnemies(ctx);
}

/** Can the player take a Short Rest right now (always in exploring phase)? */
export function canShortRest(ctx: GameContext): boolean {
  const s = ctx.state;
  const hitDiceRemaining = ctx.playerDef.level - s.player.hitDiceUsed;
  return s.phase === 'exploring'
    && s.player.hp > 0
    && s.player.hp < ctx.playerDef.maxHp
    && hitDiceRemaining > 0;
}

/**
 * Can the player attack the given target (or, if none, the currently selected target)?
 * In `exploring` phase, this triggers combat — no action-economy check applies.
 * In `player_turn`, the player must have an Action available and be adjacent.
 */
export function canAttackTarget(ctx: GameContext, targetId?: string): boolean {
  const s = ctx.state;
  const id = targetId ?? s.selectedTargetId;
  if (!id) return false;
  const target = s.npcs.find((n) => n.id === id && n.hp > 0 && n.disposition !== 'ally');
  if (!target) return false;
  const adjacent = chebyshev(s.player.tileX, s.player.tileY, target.tileX, target.tileY) <= 1;
  if (!adjacent) return false;
  if (s.phase === 'exploring') return true;
  return canSpendAction(ctx);
}
