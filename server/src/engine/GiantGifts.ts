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
import { d, mod } from './Dice.js';
import { sizeRank, parseCreatureSize } from '../../../shared/types.js';
import { chebyshev } from './EnemyAI.js';
import { publishNpcDamage } from './ThresholdPublisher.js';
import { npcConditionImmune } from './ConditionSystem.js';
import { applyNpcDamageInstance } from './NpcDamage.js';
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
    applyNpcDamageInstance(ctx, target, targetDef, finalDamage, effect.bonusDamageOnHit.damageType);
    ctx.state.player.resources[GIANT_GIFT_ID] -= 1;
    const chillNote = effect.speedReduction ? ', speed reduced' : '';
    ctx.addLog({ left: `Giant's gift — +${finalDamage} ${effect.bonusDamageOnHit.damageType}${chillNote}`, right: label, style: 'hit' });
    if (log) ctx.addLog(log);
    if (effect.speedReduction && target.hp > 0 && !target.conditions.includes('slowed')) target.conditions.push('slowed');
    return;
  }

  if (effect.conditionOnHit) {
    if (target.hp <= 0) return;  // no point knocking a corpse Prone
    if (npcConditionImmune(targetDef, effect.conditionOnHit.condition)) {
      ctx.addLog({ left: `Giant's gift — ${target.name} cannot be ${effect.conditionOnHit.condition}`, style: 'normal' });
      return;  // immune — don't spend the use
    }
    const maxSize = effect.conditionOnHit.targetSizeMax;
    const targetSize = target.size ?? parseCreatureSize(targetDef.size as string | undefined);
    if (maxSize && sizeRank(targetSize) > sizeRank(parseCreatureSize(maxSize))) return;  // too big — gift can't fire
    ctx.state.player.resources[GIANT_GIFT_ID] -= 1;
    if (!target.conditions.includes(effect.conditionOnHit.condition)) target.conditions.push(effect.conditionOnHit.condition);
    ctx.addLog({ left: `Giant's gift — ${target.name} is ${effect.conditionOnHit.condition}`, style: 'status' });
  }
}

/**
 * Cloud's Jaunt (Cloud Giant). A Bonus Action teleport up to the gift's range
 * (30 ft) to an unoccupied, passable tile. Validates range / passability /
 * occupancy (mirroring Misty Step); spends one use + the Bonus Action only on a
 * successful jump. Returns whether the teleport happened.
 */
export function applyCloudsJaunt(ctx: GameContext, tile: { x: number; y: number } | undefined): boolean {
  const s = ctx.state;
  if ((s.player.resources[GIANT_GIFT_ID] ?? 0) <= 0) return false;
  const teleport = chosenGiftEffect(ctx.playerDef, ctx.defs.species)?.teleport;
  if (!teleport) return false;
  if (!tile) { ctx.addLog({ left: `Cloud's Jaunt — no destination tile`, style: 'miss' }); return false; }
  const rangeTiles = Math.max(1, Math.ceil(teleport.feet / 5));
  if (Math.max(Math.abs(tile.x - s.player.tileX), Math.abs(tile.y - s.player.tileY)) > rangeTiles) {
    ctx.addLog({ left: `Cloud's Jaunt — destination is out of range (${teleport.feet} ft)`, style: 'miss' });
    return false;
  }
  const { cols, rows, blocksMovement } = s.map;
  if (tile.x < 0 || tile.x >= cols || tile.y < 0 || tile.y >= rows || blocksMovement[tile.y][tile.x]) {
    ctx.addLog({ left: `Cloud's Jaunt — destination is impassable`, style: 'miss' });
    return false;
  }
  if (s.npcs.some((n) => n.hp > 0 && n.tileX === tile.x && n.tileY === tile.y)) {
    ctx.addLog({ left: `Cloud's Jaunt — destination is occupied`, style: 'miss' });
    return false;
  }
  const fromX = s.player.tileX, fromY = s.player.tileY;
  s.player.tileX = tile.x;
  s.player.tileY = tile.y;
  s.player.resources[GIANT_GIFT_ID] -= 1;
  s.player.bonusActionUsed = true;
  ctx.addLog({ left: `${ctx.playerDef.name} steps through the clouds — (${fromX},${fromY}) → (${tile.x},${tile.y})`, style: 'status' });
  return true;
}

/** Roll a "1d12+con"-style spec: dice plus an optional ability modifier. */
function rollReductionSpec(spec: string, ctx: GameContext): { total: number; label: string } {
  const [dicePart, abilityPart] = spec.split('+');
  const { total: diceTot, label } = rollDiceString(dicePart);
  const abilityMod = abilityPart === 'con' ? mod(ctx.playerDef.con) : 0;
  return { total: diceTot + abilityMod, label: abilityPart ? `${label}+${abilityMod}` : label };
}

/**
 * Stone's Endurance (Stone Giant). A Reaction when the player takes damage:
 * reduce that damage by 1d12 + CON. Spends one use from the shared pool and the
 * player's Reaction (so it can't stack with Shield in the same round, and only
 * the first damage instance of a multi-part hit is reduced). Auto-fires while a
 * use and the Reaction remain. Returns the (possibly reduced) damage.
 */
export function applyStoneEndurance(ctx: GameContext, effective: number): number {
  if (effective <= 0 || ctx.state.player.reactionUsed) return effective;
  if ((ctx.state.player.resources[GIANT_GIFT_ID] ?? 0) <= 0) return effective;
  const dr = chosenGiftEffect(ctx.playerDef, ctx.defs.species)?.damageReduction;
  if (!dr) return effective;
  const { total: reduction, label } = rollReductionSpec(dr.roll, ctx);
  const reduced = Math.max(0, effective - reduction);
  ctx.state.player.resources[GIANT_GIFT_ID] -= 1;
  ctx.state.player.reactionUsed = true;
  ctx.addLog({ left: `Stone's Endurance — damage reduced by ${reduction} (${effective} → ${reduced})`, right: label, style: 'status' });
  return reduced;
}

/**
 * Storm's Thunder (Storm Giant). A Reaction when the player takes damage from a
 * creature within 60 ft: deal `dice` thunder damage back to it. Spends one use
 * and the Reaction. Fires from the melee monster-attack path (the common
 * trigger) where the attacker is known.
 */
export function applyStormsThunder(ctx: GameContext, attacker: NpcState): void {
  const s = ctx.state;
  if (s.player.hp <= 0 || s.player.reactionUsed) return;
  if ((s.player.resources[GIANT_GIFT_ID] ?? 0) <= 0) return;
  if (attacker.hp <= 0) return;
  const rt = chosenGiftEffect(ctx.playerDef, ctx.defs.species)?.retaliationDamage;
  if (!rt) return;
  if (chebyshev(s.player.tileX, s.player.tileY, attacker.tileX, attacker.tileY) * 5 > 60) return;
  const attackerDef = ctx.resolveMonsterDef(attacker.defId);
  if (!attackerDef) return;
  const { total, label } = rollDiceString(rt.dice);
  const { finalDamage, log } = ctx.resistMod(total, rt.damageType, attackerDef, attacker.name);
  const before = attacker.hp;
  applyNpcDamageInstance(ctx, attacker, attackerDef, finalDamage, rt.damageType);
  s.player.resources[GIANT_GIFT_ID] -= 1;
  s.player.reactionUsed = true;
  ctx.addLog({ left: `Storm's Thunder — ${finalDamage} thunder lashes back at ${attacker.name}`, right: label, style: 'hit' });
  if (log) ctx.addLog(log);
  publishNpcDamage(ctx, attacker, before, attacker.hp);
  if (attacker.hp <= 0 && before > 0) ctx.killWithReward(attacker, attackerDef, `☠ ${attacker.name} is felled by Storm's Thunder!`);
}
