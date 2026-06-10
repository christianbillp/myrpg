import type { GameContext } from './GameContext.js';
import type { NpcState } from './types.js';
import { d20, mod } from './Dice.js';
import { combatantDisplayName } from './CombatFlow.js';
import { breakNpcConcentrationOnDamage } from './NpcConcentration.js';

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
  maybeHideousLaughterDamageSave(ctx, npc);
  // SRD concentration (US-117): an NPC caster sustaining its own spell
  // (self-Invisibility, Fly) checks concentration on every damage instance.
  breakNpcConcentrationOnDamage(ctx, npc, dmg);
}

/**
 * SRD Hideous Laughter: every time an affected creature takes damage, it
 * makes a new Wisdom save with Advantage; on success the spell ends on it
 * (Prone + Incapacitated stripped). The damage-triggered save is in
 * addition to the end-of-turn save handled in `finalizeNpcTurn`. We gate
 * on the player concentrating on the spell and the target carrying the
 * spell's signature condition set so other Prone+Incapacitated sources
 * (Sleep, etc.) don't accidentally trigger this path.
 */
function maybeHideousLaughterDamageSave(ctx: GameContext, npc: NpcState): void {
  const s = ctx.state;
  if (s.player.concentratingOn !== 'hideous-laughter') return;
  if (!npc.conditions.includes('incapacitated') || !npc.conditions.includes('prone')) return;
  const def = ctx.resolveMonsterDef(npc.defId);
  if (!def) return;
  const dc = 8 + ctx.playerDef.proficiencyBonus + (
    ctx.playerDef.spellcastingAbility ? mod(ctx.playerDef[ctx.playerDef.spellcastingAbility]) : 0
  );
  const saveMod = (def.savingThrows && def.savingThrows['wis'] !== undefined)
    ? def.savingThrows['wis']
    : mod(def.wis);
  // Advantage when triggered by damage.
  const r1 = d20();
  const r2 = d20();
  const roll = Math.max(r1, r2);
  const total = roll + saveMod;
  const success = total >= dc;
  ctx.addLog({
    left: `${combatantDisplayName(npc, s.npcs)} ${success ? 'shakes off the laughter' : 'keeps laughing through the pain'}`,
    right: `WIS d20(${r1},${r2})+${saveMod}=${total} vs DC ${dc} (adv)`,
    style: success ? 'status' : 'miss',
  });
  if (success) {
    npc.conditions = npc.conditions.filter((c) => c !== 'incapacitated' && c !== 'prone');
  }
}
