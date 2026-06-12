/**
 * Spell-resolution primitives shared by every resolver layer — caster math
 * (DC / attack bonus / spell mod), damage rolling and application, player
 * saves, and the small condition-text helpers. Extracted from the
 * SpellSystem god-file; SpellSystem re-exports the public pieces so
 * existing imports keep working.
 */
import type { GameContext } from './GameContext.js';
import { combatantDisplayName } from './DisplayNames.js';
import type { GameEvent, NpcState, SpellDef, LogEntry, MonsterDef } from './types.js';
import { d, d20, mod, rollAdvantage, applyHalflingLuck, rollDiceBonus } from './Dice.js';
import { chebyshev } from './EnemyAI.js';
import { canCastSpell } from './ActionGuards.js';
import { computeEquippedSlotLabels } from './EquipmentSystem.js';
import { isMagicInitiateSpell, magicInitiateResourceId } from './MagicInitiate.js';
import { startConcentration, endConcentration } from './ConcentrationSystem.js';
import { castSpiritGuardians } from './SpiritGuardiansSystem.js';
import { resolveSpiritualWeaponAttack } from './SummonSystem.js';
import { publishNpcDamage } from './ThresholdPublisher.js';
import { applyDamageWithTempHp, npcBanePenalty } from './CombatSystem.js';
import { applyNpcDamageInstance } from './NpcDamage.js';

import { requestCombatStart } from './CombatStartPrompt.js';
import { emitNoise, NOISE_SPELL_VERBAL } from './Sound.js';
import { Logger } from '../Logger.js';
import { canSee as visCanSee } from './Vision.js';
import { hasModifierFlag, hasAdvantageOn } from './Modifiers.js';
import { applySelfBuff, applyBuffTo, removeSpellBuffsFrom } from './Buffs.js';
import { applyInvisibilityConcealment, logInvisibilityFind } from './InvisibilitySystem.js';
import { SPEED_ZERO_CONDITIONS, isIncapacitated, shieldAcBonus } from './ConditionSystem.js';
import {
  tilesInArea, playerInArea, creaturesInArea,
  sphereRadiusTiles, chebyshevDiscTiles,
} from './SpellGeometry.js';


/** Cover the target benefits from against the player's spell attack. */
export function visCanSeeTargetCover(ctx: GameContext, target: NpcState): 'none' | 'half' | 'three-quarters' | 'total' {
  const v = visCanSee(
    ctx.state,
    { tileX: ctx.state.player.tileX, tileY: ctx.state.player.tileY, senses: ctx.playerDef.senses },
    { tileX: target.tileX, tileY: target.tileY, conditions: target.conditions, id: target.id },
  );
  return v.cover;
}

/** Ability mod for the player's spellcasting ability (defaults to 0 if unset). */
export function spellMod(ctx: GameContext): number {
  const ab = ctx.playerDef.spellcastingAbility;
  if (!ab) return 0;
  return mod(ctx.playerDef[ab]);
}

/** Spell save DC = 8 + PB + spellMod. */
export function spellSaveDC(ctx: GameContext): number {
  return 8 + ctx.playerDef.proficiencyBonus + spellMod(ctx);
}

/** Spell attack bonus = PB + spellMod. */
export function spellAttackBonus(ctx: GameContext): number {
  return ctx.playerDef.proficiencyBonus + spellMod(ctx);
}

/**
 * Cantrip damage scaling per SRD: damage dice count increases at character
 * levels 5, 11, and 17. Levelled spells don't scale through this — they
 * scale by being cast in a higher slot (handled in resolve()).
 */
export function cantripDiceMultiplier(level: number): number {
  if (level >= 17) return 4;
  if (level >= 11) return 3;
  if (level >= 5)  return 2;
  return 1;
}

export function rollDamage(dice: number, sides: number, bonus = 0): { total: number; rolls: number[] } {
  const rolls: number[] = [];
  for (let i = 0; i < dice; i++) rolls.push(d(sides));
  return { total: rolls.reduce((a, b) => a + b, 0) + bonus, rolls };
}

// `npcSaveMod` moved to CombatSystem (the pure math layer) so NPC-side
// casters (NpcSpellcasting, US-117) can use it without importing this
// player-centric module; re-exported here for the existing consumers.
import { npcSaveMod } from './CombatSystem.js';
import { tryNpcCounterspell, tryNpcShieldVsSpellAttack } from './NpcSpellcasting.js';
export { npcSaveMod };

/**
 * Apply damage to a single NPC, routing through resistMod. Idempotent on
 * already-dead targets — repeated calls do nothing instead of re-firing kill
 * rewards (which would otherwise grant duplicate XP for e.g. extra Magic
 * Missile darts that strike a corpse).
 */
export function applyDamageToNpc(
  ctx: GameContext,
  target: NpcState,
  amount: number,
  damageType: string,
): void {
  if (amount <= 0) return;
  if (target.hp <= 0) return;
  const def = ctx.resolveMonsterDef(target.defId);
  if (!def) return;
  const { finalDamage, log: resistLog } = ctx.resistMod(amount, damageType, def, target.name);
  if (resistLog) ctx.addLog(resistLog);
  const hpBefore = target.hp;
  // Spell damage carries no crit through this path, so Undead Fortitude is
  // only bypassed by its damage type (Radiant).
  applyNpcDamageInstance(ctx, target, def, finalDamage, damageType);
  Logger.log('combat.damage_dealt', {
    target: target.id,
    defId: target.defId,
    raw: amount,
    damageType,
    effective: finalDamage,
    hpBefore,
    hpAfter: target.hp,
    maxHp: target.maxHp,
    source: 'spell',
  });
  publishNpcDamage(ctx, target, hpBefore, target.hp);
  if (target.hp <= 0) {
    Logger.log('combat.npc_killed', { npcId: target.id, defId: target.defId, source: 'spell' });
    ctx.killWithReward(target, def, `☠ ${combatantDisplayName(target, ctx.state.npcs)} is slain!`);
  }
}

/**
 * Roll a save for the player against an AOE save spell and apply the
 * damage. Shared between `resolveSecondaryAoe` and `resolveSaveSpell` so the
 * player's tempHp / concentration / unconscious paths all run consistently
 * via `ctx.applyDamageToPlayer`. Returns whether real damage landed.
 */
export function rollPlayerSaveAndDamage(
  ctx: GameContext,
  spell: SpellDef,
  save: { ability: string; halfOnSuccess: boolean },
  damageMeta: { type: string },
  rawDamage: number,
  events: GameEvent[],
): boolean {
  const dc = spellSaveDC(ctx);
  const abMod = mod(ctx.playerDef[save.ability as 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha']);
  const profBonus = ctx.playerDef.savingThrowProficiencies.includes(save.ability)
    ? ctx.playerDef.proficiencyBonus
    : 0;
  const saveBonus = abMod + profBonus;
  // US-108: species traits can grant Advantage on this save (e.g. Gnomish
  // Cunning on INT saves). Condition-keyed advantages (Dwarf vs Poisoned) are
  // collected too but only apply where a save is keyed by that condition.
  const adv = hasAdvantageOn(ctx.playerDef, 'save', save.ability);
  const rolled = adv ? rollAdvantage() : null;
  const roll = rolled ? rolled.result : d20();
  const rollLabel = rolled ? `${rolled.rolls[0]},${rolled.rolls[1]}→${roll} [ADV]` : `${roll}`;
  const total = roll + saveBonus;
  const success = total >= dc;
  const dmg = damageAfterSave(ctx, spell, success, save.halfOnSuccess, rawDamage);
  ctx.addLog({
    left: `${ctx.playerDef.name} ${success ? 'saves' : 'fails'} — ${dmg} ${damageMeta.type}`,
    right: `${save.ability.toUpperCase()} d20(${rollLabel})+${saveBonus}=${total} vs DC ${dc}`,
    style: success ? 'normal' : 'hit',
  });
  if (dmg > 0) ctx.applyDamageToPlayer(dmg, events, damageMeta.type);
  void spell;
  return dmg > 0;
}

/**
 * Normalise `SpellEffect.onFail` (which the schema allows as either a single
 * string or an array of strings) to a plain list of condition names.
 */
export function normaliseConditionList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value.slice() : [value];
}

/** Log-flavour predicate for an on-hit condition rider, e.g. `slowed` →
 *  "is slowed (Speed −10 ft until end of next turn)". Falls back to "is <c>"
 *  so a new on-hit condition reads sensibly without a bespoke entry. */
const ON_HIT_CONDITION_NOTE: Record<string, string> = {
  slowed: 'is slowed (Speed −10 ft until end of next turn)',
  'no-healing': "can't regain HP until the start of your next turn",
  'no-reactions': "can't take Reactions until the start of its next turn",
};
export function onHitConditionNote(condition: string): string {
  return ON_HIT_CONDITION_NOTE[condition] ?? `is ${condition}`;
}

/**
 * Flavour line for a failed save. Recognises a handful of spells with
 * iconic narration; falls back to a generic "is &lt;condition&gt;" / "is affected"
 * for everything else.
 */
export function conditionLogText(spell: SpellDef, conds: string[]): string {
  if (conds.length === 0) return 'is affected';
  if (spell.effect?.failNote) return spell.effect.failNote;
  return 'is ' + conds.join(' and ');
}

/**
 * SRD push effect (Thunderwave). Shoves `npc` `feet` feet directly away from
 * the caster, stopping at the first impassable tile or another creature.
 * One tile = 5 ft. No-op when the spell would push back into the caster.
 */
export function pushNpcAway(ctx: GameContext, npc: NpcState, feet: number, events?: GameEvent[]): void {
  const tiles = Math.floor(feet / 5);
  if (tiles <= 0) return;
  const s = ctx.state;
  // Direction from caster to creature. Sign per axis — clamped to 8-way grid.
  const dx = Math.sign(npc.tileX - s.player.tileX);
  const dy = Math.sign(npc.tileY - s.player.tileY);
  if (dx === 0 && dy === 0) return;
  let moved = 0;
  for (let step = 0; step < tiles; step++) {
    const nx = npc.tileX + dx;
    const ny = npc.tileY + dy;
    if (ny < 0 || ny >= s.map.rows || nx < 0 || nx >= s.map.cols) break;
    if (s.map.blocksMovement[ny][nx]) break;
    if (s.player.tileX === nx && s.player.tileY === ny) break;
    if (s.npcs.some((other) => other.id !== npc.id && other.hp > 0 && other.tileX === nx && other.tileY === ny)) break;
    npc.tileX = nx;
    npc.tileY = ny;
    moved++;
    // Emit one `entity_move` per step so the client animates the push the
    // same way it animates a regular walk. Without this the NPC silently
    // teleports to the final tile on the next state update (US-bug: gust
    // of wind looked broken because nothing visibly happened).
    events?.push({ type: 'entity_move', entityId: npc.id, toX: nx, toY: ny });
  }
  if (moved > 0) {
    ctx.addLog({ left: `${combatantDisplayName(npc, s.npcs)} pushed ${moved * 5} ft`, style: 'status' });
  }
}

/**
 * SRD Evoker Potent Cantrip — a damaging cantrip deals half damage on a
 * successful save instead of zero. Pure helper consumed by every save-
 * branch resolver below. When the spell isn't a cantrip with damage, or
 * the caster doesn't have Potent Cantrip, the rider doesn't kick in and
 * the normal `success && halfOnSuccess ? half : success ? 0 : full`
 * outcome wins.
 */
export function damageAfterSave(
  ctx: GameContext,
  spell: SpellDef,
  success: boolean,
  halfOnSuccess: boolean,
  fullDamage: number,
): number {
  if (!success) return fullDamage;
  if (halfOnSuccess) return Math.floor(fullDamage / 2);
  if (spell.level === 0 && spell.damage && hasModifierFlag(ctx.playerDef, 'potent-cantrip')) {
    return Math.floor(fullDamage / 2);
  }
  return 0;
}
