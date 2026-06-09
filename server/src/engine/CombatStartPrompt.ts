/**
 * Combat-start confirmation. A player action (attack / aggressive cast) in the
 * exploring phase that WOULD start combat pauses here instead of acting: the
 * engine surfaces `state.pendingCombatStart` and waits for `resolveCombatStart`.
 *   • decline → nothing happens (the action is discarded, no combat).
 *   • accept  → promote the would-be combatants, aggro their factions, and roll
 *               initiative. The triggering action is NOT performed — the player
 *               acts normally on their turn.
 */
import type { GameContext } from './GameContext.js';
import type { GameEvent } from './types.js';

export function requestCombatStart(ctx: GameContext, promoteIds: string[], label: string): void {
  ctx.state.pendingCombatStart = { promoteIds, label };
}

export function doResolveCombatStart(ctx: GameContext, accept: boolean, events: GameEvent[]): void {
  const s = ctx.state;
  const pending = s.pendingCombatStart;
  if (!pending) return;
  s.pendingCombatStart = null;
  if (!accept) return; // declined — nothing happens

  for (const id of pending.promoteIds) {
    const npc = s.npcs.find((n) => n.id === id && n.hp > 0);
    if (npc && npc.disposition !== 'ally') {
      npc.disposition = 'enemy';
      if (!npc.combatLabel) ctx.assignCombatLabel(npc);
    }
  }
  const first = s.npcs.find((n) => n.id === pending.promoteIds[0] && n.hp > 0);
  if (first) ctx.aggroFaction(first);
  ctx.doStartCombat(events);
}
