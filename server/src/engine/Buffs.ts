/**
 * Self-buff registry — data-driven replacement for the per-spell
 * `switch(spell.id)` buff applications + the per-spell concentration cleanup.
 *
 * A self-buff spell records an `ActiveBuff` (its contributed `modifiers` +
 * any conditions it applied) on `PlayerState.activeBuffs`. `recomputeBuffs`
 * then DERIVES the legacy buff fields the rest of the engine already reads
 * (`magicWeaponBonus`, `speedBonus`, `seeInvisible`) — and rebuilds AC/attack
 * via `applyEquipment` — so no consumer changes. `removeBuffsForSpell` drops a
 * buff (e.g. on concentration end), strips its conditions, and recomputes.
 *
 * Buffs that are parameterised or stateful (Enhance Ability's chosen ability,
 * Mirror Image's counter) and Mage Armor (persisted across resume) stay on
 * their existing paths for now.
 */
import type { GameContext } from './GameContext.js';
import type { ActiveBuff } from './types.js';
import { applyEquipment } from './EquipmentSystem.js';

/** Derive the legacy buff fields from the active-buff modifier list and rebuild
 *  AC + main attack. The derived fields are sourced SOLELY from buffs, so this
 *  also resets them to their no-buff defaults when a buff is removed. */
export function recomputeBuffs(ctx: GameContext): void {
  const p = ctx.state.player;
  const mods = (p.activeBuffs ?? []).flatMap((b) => b.modifiers ?? []);
  p.seeInvisible = mods.some((m) => m.type === 'flag' && m.name === 'see-invisible');
  p.expeditiousRetreat = mods.some((m) => m.type === 'flag' && m.name === 'expeditious-retreat');
  p.speedBonus = mods.reduce((max, m) => (m.type === 'speed-bonus' ? Math.max(max, m.value) : max), 0);
  p.magicWeaponBonus = mods.reduce((max, m) => (m.type === 'weapon-bonus' ? Math.max(max, m.value) : max), 0);
  // mageArmor + shieldActive are owned outside the buff list (Mage Armor is
  // resumed; Shield is a reaction) — pass them through unchanged.
  applyEquipment(ctx.playerDef, p.equippedSlots, ctx.defs.equipment, p.mageArmor, p.shieldActive, p.magicWeaponBonus);
}

/** Apply a self-buff: record it, apply any conditions it grants to the player,
 *  then recompute the derived fields. Replaces a buff with the same spellId. */
export function applySelfBuff(ctx: GameContext, buff: ActiveBuff): void {
  const p = ctx.state.player;
  p.activeBuffs = [...(p.activeBuffs ?? []).filter((b) => b.spellId !== buff.spellId), buff];
  for (const c of buff.playerConditions ?? []) {
    if (!p.conditions.includes(c)) p.conditions.push(c);
  }
  recomputeBuffs(ctx);
}

/** Remove every active buff cast by `spellId`, strip the conditions it applied
 *  from the player, and recompute. Called from `endConcentration` (and could be
 *  called on duration expiry). No-op when the spell granted no tracked buff. */
export function removeBuffsForSpell(ctx: GameContext, spellId: string): void {
  const p = ctx.state.player;
  const ending = (p.activeBuffs ?? []).filter((b) => b.spellId === spellId);
  if (ending.length === 0) return;
  for (const b of ending) {
    for (const c of b.playerConditions ?? []) {
      p.conditions = p.conditions.filter((x) => x !== c);
    }
  }
  p.activeBuffs = (p.activeBuffs ?? []).filter((b) => b.spellId !== spellId);
  recomputeBuffs(ctx);
}
