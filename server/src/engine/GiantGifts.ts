/**
 * Goliath Giant Ancestry boons (US-122). At character creation the player picks
 * one supernatural gift (`PlayerDef.speciesLineage` = the option id); all gifts
 * draw from one shared pool — uses equal to Proficiency Bonus, refilled on a
 * Long Rest — held in `player.resources['giant-gift']` (seeded by
 * `SessionBuilder` / refilled by `applyLongRest` through the species-ability
 * resource seam).
 *
 * Each gift's mechanics are read data-driven from the chosen option's `effect`
 * in `species/goliath.json`, so adding/retuning a gift is mostly data:
 *   • `bonusDamageOnHit` + optional `speedReduction` — Fire's Burn, Frost's Chill
 *   • `conditionOnHit` — Hill's Tumble (knock Prone)
 *   • `damageReduction` (reaction) — Stone's Endurance        [separate slice]
 *   • `retaliationDamage` (reaction) — Storm's Thunder         [separate slice]
 *   • `teleport` (bonus action) — Cloud's Jaunt                [separate slice]
 *
 * The on-hit gifts auto-fire on a damaging hit while a use remains (the limited
 * per-Long-Rest pool is the real constraint); the caller publishes the NPC
 * damage delta after this returns.
 */
import { d } from './Dice.js';
import { sizeRank, parseCreatureSize } from '../../../shared/types.js';
import type { GameContext } from './GameContext.js';
import type { NpcState, MonsterDef, PlayerDef, SpeciesDef } from './types.js';

export const GIANT_GIFT_ID = 'giant-gift';

interface GiftEffect {
  bonusDamageOnHit?: { dice: string; damageType: string };
  speedReduction?: { feet: number; duration: string };
  conditionOnHit?: { condition: string; targetSizeMax?: string };
  damageReduction?: { trigger: string; action: string; roll: string };
  retaliationDamage?: { trigger: string; action: string; dice: string; damageType: string };
  teleport?: { feet: number; action: string };
}

/** Resolve the chosen Giant Ancestry option's `effect`, or undefined when the
 *  character isn't a gift-bearing Goliath. */
export function chosenGiftEffect(playerDef: PlayerDef, allSpecies: SpeciesDef[]): GiftEffect | undefined {
  const lineage = playerDef.speciesLineage;
  if (!lineage) return undefined;
  const species = allSpecies.find((s) => s.id === playerDef.speciesId);
  for (const trait of species?.traits ?? []) {
    const ac = (trait.effects as { ancestryChoice?: { usesPerLongRest?: number | string; options?: Array<{ id?: string; effect?: GiftEffect }> } }).ancestryChoice;
    if (!ac?.usesPerLongRest) continue;  // only the Giant-Ancestry choice has a pool (not Dragonborn's)
    const opt = ac.options?.find((o) => o.id === lineage);
    if (opt?.effect) return opt.effect;
  }
  return undefined;
}

/** The shared Giant-Ancestry pool size (= Proficiency Bonus), or null when the
 *  character has no chosen gift. */
export function giantGiftPoolMax(playerDef: PlayerDef, allSpecies: SpeciesDef[]): number | null {
  const species = allSpecies.find((s) => s.id === playerDef.speciesId);
  for (const trait of species?.traits ?? []) {
    const ac = (trait.effects as { ancestryChoice?: { usesPerLongRest?: number | string } }).ancestryChoice;
    if (ac?.usesPerLongRest && playerDef.speciesLineage) {
      return ac.usesPerLongRest === 'proficiencyBonus' ? playerDef.proficiencyBonus : Number(ac.usesPerLongRest);
    }
  }
  return null;
}

function rollDiceString(spec: string): { total: number; label: string } {
  const [countStr, sidesStr] = spec.split('d');
  const count = Number(countStr) || 1;
  const sides = Number(sidesStr) || 6;
  let total = 0;
  const rolls: number[] = [];
  for (let i = 0; i < count; i++) { const r = d(sides); rolls.push(r); total += r; }
  return { total, label: `${spec}[${rolls.join(',')}]` };
}

/**
 * Apply the Goliath on-hit gift (Fire's Burn / Frost's Chill / Hill's Tumble)
 * after a damaging hit lands, spending one use from the shared pool. The caller
 * is responsible for publishing the resulting NPC damage delta and the kill
 * check; this only adjusts `target.hp` / conditions and logs.
 */
export function applyGiantGiftOnHit(ctx: GameContext, target: NpcState, targetDef: MonsterDef): void {
  if ((ctx.state.player.resources[GIANT_GIFT_ID] ?? 0) <= 0) return;
  const effect = chosenGiftEffect(ctx.playerDef, ctx.defs.species);
  if (!effect) return;

  if (effect.bonusDamageOnHit) {
    const { total, label } = rollDiceString(effect.bonusDamageOnHit.dice);
    const { finalDamage, log } = ctx.resistMod(total, effect.bonusDamageOnHit.damageType, targetDef, target.name);
    target.hp = Math.max(0, target.hp - finalDamage);
    ctx.state.player.resources[GIANT_GIFT_ID] -= 1;
    const chillNote = effect.speedReduction ? ', speed reduced' : '';
    ctx.addLog({ left: `Giant's gift — +${finalDamage} ${effect.bonusDamageOnHit.damageType}${chillNote}`, right: label, style: 'hit' });
    if (log) ctx.addLog(log);
    if (effect.speedReduction && target.hp > 0 && !target.conditions.includes('slowed')) target.conditions.push('slowed');
    return;
  }

  if (effect.conditionOnHit) {
    if (target.hp <= 0) return;  // no point knocking a corpse Prone
    const maxSize = effect.conditionOnHit.targetSizeMax;
    const targetSize = target.size ?? parseCreatureSize(targetDef.size as string | undefined);
    if (maxSize && sizeRank(targetSize) > sizeRank(parseCreatureSize(maxSize))) return;  // too big — gift can't fire
    ctx.state.player.resources[GIANT_GIFT_ID] -= 1;
    if (!target.conditions.includes(effect.conditionOnHit.condition)) target.conditions.push(effect.conditionOnHit.condition);
    ctx.addLog({ left: `Giant's gift — ${target.name} is ${effect.conditionOnHit.condition}`, style: 'status' });
  }
}
