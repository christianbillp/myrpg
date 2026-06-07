/**
 * Buff registry — data-driven replacement for the per-spell `switch(spell.id)`
 * buff applications + the per-spell concentration cleanup.
 *
 * A buff records an `ActiveBuff` (its contributed `modifiers`, any `conditions`
 * it applied, and an optional `charges` counter) on a creature's `activeBuffs`.
 * The store is **creature-agnostic** — `applyBuffTo` / `removeSpellBuffsFrom`
 * operate on the player OR any NPC (Invisibility cast on another creature), so
 * the same primitive backs self-buffs and creature-targeted buffs.
 *
 * For the PLAYER, `recomputeBuffs` additionally DERIVES the legacy buff fields
 * the rest of the engine reads (`magicWeaponBonus`, `speedBonus`, `seeInvisible`,
 * `expeditiousRetreat`, `enhancedAbility`, `mageArmor`, `mirrorImages`) and
 * rebuilds AC/attack via `applyEquipment` — so no consumer changes.
 */
import type { GameContext } from './GameContext.js';
import type { ActiveBuff } from './types.js';
import { sizeRank } from '../../../shared/types.js';
import { applyEquipment } from './EquipmentSystem.js';

/** Anything that can carry buffs — the player or an NPC. Both expose a
 *  `conditions` list and an optional `activeBuffs` store. */
export interface BuffTarget {
  conditions: string[];
  activeBuffs?: ActiveBuff[];
}

/** Apply a buff to any creature: replace any existing buff from the same spell,
 *  record it, and apply the conditions it grants. Creature-agnostic — no
 *  player-specific derivation (call `recomputeBuffs` afterwards for the player). */
export function applyBuffTo(target: BuffTarget, buff: ActiveBuff): void {
  target.activeBuffs = [...(target.activeBuffs ?? []).filter((b) => b.spellId !== buff.spellId), buff];
  for (const c of buff.conditions ?? []) {
    if (!target.conditions.includes(c)) target.conditions.push(c);
  }
}

/** Remove every buff a creature carries from `spellId`, stripping the
 *  conditions they applied. Returns true when something was removed. */
export function removeSpellBuffsFrom(target: BuffTarget, spellId: string): boolean {
  const ending = (target.activeBuffs ?? []).filter((b) => b.spellId === spellId);
  if (ending.length === 0) return false;
  for (const b of ending) {
    for (const c of b.conditions ?? []) {
      target.conditions = target.conditions.filter((x) => x !== c);
    }
  }
  target.activeBuffs = (target.activeBuffs ?? []).filter((b) => b.spellId !== spellId);
  return true;
}

/** Derive the player's legacy buff fields from its active-buff list and rebuild
 *  AC + main attack. The derived fields are sourced SOLELY from buffs, so this
 *  also resets them to their no-buff defaults when a buff is removed. */
export function recomputeBuffs(ctx: GameContext): void {
  const p = ctx.state.player;
  const buffs = p.activeBuffs ?? [];
  const mods = buffs.flatMap((b) => b.modifiers ?? []);
  p.seeInvisible = mods.some((m) => m.type === 'flag' && m.name === 'see-invisible');
  p.expeditiousRetreat = mods.some((m) => m.type === 'flag' && m.name === 'expeditious-retreat');
  p.mageArmor = mods.some((m) => m.type === 'flag' && m.name === 'mage-armor');
  const enhanced = mods.find((m) => m.type === 'enhanced-ability');
  p.enhancedAbility = enhanced && enhanced.type === 'enhanced-ability' ? enhanced.ability : undefined;
  p.speedBonus = mods.reduce((max, m) => (m.type === 'speed-bonus' ? Math.max(max, m.value) : max), 0);
  p.magicWeaponBonus = mods.reduce((max, m) => (m.type === 'weapon-bonus' ? Math.max(max, m.value) : max), 0);
  // Sense-granting buffs (Stonecunning → Tremorsense): merge the longest range
  // per sense into `buffSenses`; the Vision layer overlays it on the static
  // species senses. Cleared to undefined when no sense buff remains.
  const senseMods = mods.filter((m): m is Extract<typeof m, { type: 'sense' }> => m.type === 'sense');
  if (senseMods.length) {
    const bs: Record<string, number> = {};
    for (const m of senseMods) bs[m.sense] = Math.max(bs[m.sense] ?? 0, m.range);
    p.buffSenses = bs;
  } else {
    p.buffSenses = undefined;
  }
  // Size-setting buffs (Large Form → Large): the largest wins.
  const sizeMods = mods.filter((m): m is Extract<typeof m, { type: 'size' }> => m.type === 'size');
  p.buffSize = sizeMods.length ? sizeMods.map((m) => m.size).reduce((a, b) => (sizeRank(b) > sizeRank(a) ? b : a)) : undefined;
  p.mirrorImages = buffs.find((b) => b.spellId === 'mirror-image')?.charges ?? 0;

  // Flat AC bonuses (Shield of Faith, Haste) stack additively.
  p.acBonus = mods.reduce((sum, m) => (m.type === 'ac-bonus' ? sum + m.value : sum), 0);
  // Per-category d20 dice bonuses (Bless attack+save, Guidance check). Same-
  // category buffs don't stack — keep the largest die (count × sides).
  const bestDie = (on: 'attack' | 'save' | 'check'): { count: number; sides: number } | undefined => {
    const ds = mods.filter((m): m is Extract<typeof m, { type: 'dice-bonus' }> => m.type === 'dice-bonus' && m.on === on);
    if (!ds.length) return undefined;
    return ds.reduce((best, m) => (m.count * m.sides > best.count * best.sides ? { count: m.count, sides: m.sides } : best), { count: 0, sides: 0 });
  };
  p.attackDiceBonus = bestDie('attack');
  p.saveDiceBonus = bestDie('save');
  p.checkDiceBonus = bestDie('check');
  // Save advantages granted by buffs (Haste → dex, Beacon of Hope → wis).
  const saveAdv = mods.filter((m): m is Extract<typeof m, { type: 'advantage' }> => m.type === 'advantage' && m.on === 'save').map((m) => m.key).filter((k): k is string => !!k);
  p.buffSaveAdvantage = saveAdv.length ? [...new Set(saveAdv)] : undefined;
  // Damage resistances granted by buffs (Protection from Energy).
  const resist = mods.filter((m): m is Extract<typeof m, { type: 'resistance' }> => m.type === 'resistance').map((m) => m.damageType);
  p.buffResistances = resist.length ? [...new Set(resist)] : undefined;

  // shieldActive is owned outside the buff list (Shield is a reaction) — pass
  // it through unchanged; mageArmor now comes from the derived flag above.
  applyEquipment(ctx.playerDef, p.equippedSlots, ctx.defs.equipment, p.mageArmor, p.shieldActive, p.magicWeaponBonus, p.attunedItemIds ?? [], p.acBonus);
  p.ac = ctx.playerDef.ac;
}

/** Apply a self-buff to the player: record it, apply any conditions it grants,
 *  then recompute the derived fields. Replaces a buff with the same spellId. */
export function applySelfBuff(ctx: GameContext, buff: ActiveBuff): void {
  applyBuffTo(ctx.state.player, buff);
  recomputeBuffs(ctx);
}

/** Remove every player buff cast by `spellId`, strip the conditions it applied,
 *  and recompute. Called from `endConcentration` (and on duration expiry). No-op
 *  when the spell granted no tracked player buff. */
export function removeBuffsForSpell(ctx: GameContext, spellId: string): void {
  if (removeSpellBuffsFrom(ctx.state.player, spellId)) recomputeBuffs(ctx);
}
