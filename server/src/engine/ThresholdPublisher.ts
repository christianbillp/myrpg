import type { GameContext } from './GameContext.js';
import type { NpcState } from './types.js';

/**
 * Publishes `hp_threshold_crossed` events when an entity's HP ratio crosses
 * one of the canonical thresholds (50%, 25%) in either direction.
 *
 * `direction` is `below` when crossing downward, `above` when upward (heal).
 * Triggers keyed off `hp_threshold_crossed` with `direction: 'below'` and a
 * specific `ratio` give you "boss enrages at 50%" or "morale check at 25%"
 * without re-evaluating each turn.
 */
const THRESHOLDS = [0.75, 0.5, 0.25];

export function publishHpThresholdCrossings(
  ctx: GameContext,
  target: 'player' | string,
  hpBefore: number,
  hpAfter: number,
  maxHp: number,
): void {
  if (maxHp <= 0) return;
  const before = hpBefore / maxHp;
  const after = hpAfter / maxHp;
  for (const ratio of THRESHOLDS) {
    if (before > ratio && after <= ratio) {
      ctx.publish({ type: 'hp_threshold_crossed', target, ratio, direction: 'below' });
    } else if (before <= ratio && after > ratio) {
      ctx.publish({ type: 'hp_threshold_crossed', target, ratio, direction: 'above' });
    }
  }
}

/**
 * Convenience wrapper: publishes `damage_dealt` and any threshold crossings
 * for an NPC after its HP has been mutated. Caller is responsible for the
 * actual HP write — this only emits events.
 */
export function publishNpcDamage(ctx: GameContext, npc: NpcState, hpBefore: number, hpAfter: number): void {
  const dmg = hpBefore - hpAfter;
  if (dmg <= 0) return;
  ctx.publish({ type: 'damage_dealt', target: npc.id, amount: dmg });
  publishHpThresholdCrossings(ctx, npc.id, hpBefore, hpAfter, npc.maxHp);
}
