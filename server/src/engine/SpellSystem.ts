// Generic spell resolver — drives spell casting from the JSON `SpellDef`
// fields rather than per-spell hardcoded logic. Branches on the spell's
// `attack` / `save` / `effect` shape:
//
//   • attack: 'ranged-spell' | 'melee-spell' → roll d20 + PB + spellMod vs AC
//   • attack: 'auto-hit'                     → Magic Missile-style dart spread
//   • save: { ability, halfOnSuccess }       → each target rolls; full/half damage
//   • otherwise                              → utility (no roll); log + flag effect
//
// Damage is routed through ctx.resistMod for resist/vuln/immune handling.
// Cantrip damage scales with character level per SRD ("Cantrip Upgrade").
// Concentration tracking lives in ConcentrationSystem.ts.

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

import { requestCombatStart } from './CombatStartPrompt.js';
import { emitNoise, NOISE_SPELL_VERBAL } from './Sound.js';
import { Logger } from '../Logger.js';
import { canSee as visCanSee } from './Vision.js';
import { hasModifierFlag, hasAdvantageOn } from './Modifiers.js';
import { applySelfBuff, applyBuffTo, removeSpellBuffsFrom } from './Buffs.js';
import { applyInvisibilityConcealment, logInvisibilityFind } from './InvisibilitySystem.js';
import { SPEED_ZERO_CONDITIONS, isIncapacitated, shieldAcBonus, npcConditionImmune } from './ConditionSystem.js';
import {
  tilesInArea, playerInArea, creaturesInArea,
  sphereRadiusTiles, chebyshevDiscTiles,
} from './SpellGeometry.js';

// ── Extracted layers (see SpellPrimitives / SpellZones / SpellUtilityResolvers) ──
import {
  visCanSeeTarget, spellMod, spellSaveDC, spellAttackBonus,
  cantripDiceMultiplier, rollDamage, applyDamageToNpc, rollPlayerSaveAndDamage,
  normaliseConditionList, onHitConditionNote, conditionLogText, pushNpcAway,
  damageAfterSave,
} from './SpellPrimitives.js';
import {
  applyZoneCondition, registerActiveZone, stripZoneAffectedConditions,
} from './SpellZones.js';
import { resolveUtilitySpell, castEnlargeReduce } from './SpellUtilityResolvers.js';
import { npcSaveMod } from './CombatSystem.js';
import { tryNpcCounterspell, tryNpcShieldVsSpellAttack } from './NpcSpellcasting.js';
export { npcSaveMod };
export { spellMod, spellSaveDC, spellAttackBonus, applyDamageToNpc } from './SpellPrimitives.js';
export { tickZoneEnterSaves, runGustOfWindEndOfTurnSaves, tickActiveZones, registerActiveZone } from './SpellZones.js';
export { resolveUtilitySpell } from './SpellUtilityResolvers.js';



// ── Action-economy + slot consumption ────────────────────────────────────────

function consumeCastingResources(ctx: GameContext, spell: SpellDef, slotLevel: number, asRitual: boolean, fromScroll = false): void {
  const s = ctx.state;
  // Ritual casts don't consume a spell slot (SRD: the spell is cast over 10
  // minutes from the spellbook). They also don't spend the action/bonus
  // action — they're a fictional time cost, only legal out of combat.
  if (asRitual) return;
  // Scroll casts (US-124): expend no spell slot — the scroll itself is the
  // resource (consumed by the caller) — but still cost the spell's action.
  // US-116: spend the slot at the chosen upcast level, NOT the spell's base
  // level. `doCastSpell` has already clamped slotLevel to [spell.level, 9] and
  // verified a free slot at that level, so this consumption is always valid.
  if (spell.level > 0 && !fromScroll && s.player.pactMagic) {
    // Warlock Pact Magic — spend from the single short-rest pool. Magic Initiate
    // free casts (rare on a Warlock) still fall back to their own resource.
    const pact = s.player.pactMagic;
    if (pact.remaining > 0) {
      pact.remaining -= 1;
      Logger.log('spell.pact_slot_consumed', { spellId: spell.id, level: spell.level, slotLevel, before: pact.remaining + 1, after: pact.remaining });
    } else if (isMagicInitiateSpell(ctx.playerDef, spell.id)) {
      const rid = magicInitiateResourceId(spell.id);
      const had = s.player.resources[rid] ?? 0;
      if (had > 0) s.player.resources[rid] = had - 1;
    }
  } else if (spell.level > 0 && !fromScroll) {
    const slotIdx = slotLevel - 1;
    const before = s.player.spellSlots[slotIdx] ?? 0;
    if (before > 0) {
      s.player.spellSlots[slotIdx] = before - 1;
      Logger.log('spell.slot_consumed', { spellId: spell.id, level: spell.level, slotLevel, before, after: s.player.spellSlots[slotIdx] });
    } else if (isMagicInitiateSpell(ctx.playerDef, spell.id)) {
      // SRD Magic Initiate: with no slot available, spend the once-per-Long-Rest
      // free cast instead.
      const rid = magicInitiateResourceId(spell.id);
      const had = s.player.resources[rid] ?? 0;
      if (had > 0) {
        s.player.resources[rid] = had - 1;
        Logger.log('spell.magic_initiate_free_cast', { spellId: spell.id, before: had, after: s.player.resources[rid] });
      }
    }
  }
  spendCastingAction(ctx, spell);
}

/** Spend only the cast's action economy (no slot) — shared by the normal
 *  consumption path and the Counterspell waste branch (SRD 5.2.1: a countered
 *  spell wastes the action but not the slot). */
function spendCastingAction(ctx: GameContext, spell: SpellDef): void {
  const s = ctx.state;
  if (s.phase === 'player_turn') {
    switch (spell.castingTime) {
      case 'action':       s.player.actionUsed = true; break;
      case 'bonus-action': s.player.bonusActionUsed = true; break;
      case 'reaction':     s.player.reactionUsed = true; break;
    }
  }
}

// ── Resolution branches ─────────────────────────────────────────────────────

/**
 * Result of a single spell attack roll. `hit` mirrors the legacy boolean
 * return; `damageRolls` is the raw die-by-die spread (post-multipliers) so
 * callers can inspect for spell-specific effects like Chromatic Orb's
 * chain-on-matching-dice rider.
 */
interface AttackRollResult {
  hit: boolean;
  damageRolls: number[];
}

function resolveAttackRollSpell(
  ctx: GameContext,
  spell: SpellDef,
  target: NpcState,
  slotLevel: number,
  options?: { advantage?: boolean; suppressRiders?: boolean; isChainHop?: boolean },
): AttackRollResult {
  const def = ctx.resolveMonsterDef(target.defId);
  if (!def) return { hit: false, damageRolls: [] };
  if (!spell.damage) return { hit: false, damageRolls: [] };

  // SRD cover for spell attack rolls. Total cover blocks the cast entirely
  // before any roll happens — refunds nothing (the slot was already
  // consumed by consumeCastingResources, which mirrors the player's choice
  // to commit). The defender's cover bonus stacks onto effective AC.
  const targetVision = visCanSeeTarget(ctx, target);
  if (targetVision.cover === 'total' || !targetVision.sees) {
    ctx.addLog({
      left: `${ctx.playerDef.name} casts ${spell.name} — ${combatantDisplayName(target, ctx.state.npcs)} is ${targetVision.cover === 'total' ? 'behind total cover' : 'beyond sight (darkness or concealment)'}`,
      style: 'miss',
    });
    return { hit: false, damageRolls: [] };
  }
  const visionCover = targetVision.cover;
  const coverAcBonus = visionCover === 'three-quarters' ? 5 : visionCover === 'half' ? 2 : 0;
  const effectiveAc = def.ac + coverAcBonus + shieldAcBonus(target.conditions);

  const bonus = spellAttackBonus(ctx) + rollDiceBonus(ctx.state.player.attackDiceBonus);
  // Shocking Grasp grants Advantage if the target wears metal armor. The
  // engine doesn't model armor material yet, so we surface this only when
  // explicitly enabled. Other callers may pass options.advantage too.
  const r1 = d20();
  const r2 = options?.advantage ? d20() : r1;
  const roll = applyHalflingLuck(options?.advantage ? Math.max(r1, r2) : r1, ctx.playerDef.halflingLuck).natural;
  const isCrit = roll === 20;
  const total = roll + bonus;
  let hit = isCrit || (roll !== 1 && total >= effectiveAc);
  // US-117 Protective Magic: a hit on a stat-block caster may be met with a
  // reaction-cast Shield (+5 AC, persists via the shielded condition).
  if (hit && tryNpcShieldVsSpellAttack(ctx, target, def, total, effectiveAc, isCrit).deflected) hit = false;
  const coverNote = coverAcBonus > 0 ? ` (+${coverAcBonus} cover)` : '';
  const advNote = options?.advantage ? ` (advantage)` : '';
  const chainNote = options?.isChainHop ? ` [chain]` : '';

  if (!hit) {
    ctx.addLog({
      left: `${ctx.playerDef.name} casts ${spell.name} at ${combatantDisplayName(target, ctx.state.npcs)}${chainNote} — miss`,
      right: `d20(${roll})+${bonus}=${total} vs AC ${effectiveAc}${coverNote}${advNote}`,
      style: 'miss',
    });
    // SRD Evoker Potent Cantrip — on a miss with a damaging cantrip, the
    // target still takes half the cantrip's damage. The rider applies to
    // every damaging cantrip (no school restriction per SRD 5.2.1).
    if (spell.level === 0 && spell.damage && hasModifierFlag(ctx.playerDef, 'potent-cantrip')) {
      const dieMult = cantripDiceMultiplier(ctx.playerDef.level);
      const dice = spell.damage.dice * dieMult;
      const { total: rawDmg } = rollDamage(dice, spell.damage.sides, spell.damage.bonus ?? 0);
      const halfDmg = Math.floor(rawDmg / 2);
      if (halfDmg > 0) {
        ctx.addLog({
          left: `↪ Potent Cantrip — ${combatantDisplayName(target, ctx.state.npcs)} still takes ${halfDmg} ${spell.damage.type}`,
          style: 'status',
        });
        applyDamageToNpc(ctx, target, halfDmg, spell.damage.type);
      }
    }
    // SRD half-damage-on-miss rider (Acid Arrow). Distinct from Potent
    // Cantrip: this is spell-authored (not feature-gated) and applies to
    // leveled spells too. Suppresses the delayedSelfDamage rider per RAW.
    if (spell.halfDamageOnMiss && spell.damage) {
      const upcast = Math.max(0, slotLevel - spell.level);
      const dice = spell.damage.dice + upcast;
      const { total: rawDmg } = rollDamage(dice, spell.damage.sides, spell.damage.bonus ?? 0);
      const halfDmg = Math.floor(rawDmg / 2);
      if (halfDmg > 0) {
        ctx.addLog({
          left: `↪ ${spell.name} splashes — ${combatantDisplayName(target, ctx.state.npcs)} still takes ${halfDmg} ${spell.damage.type}`,
          style: 'status',
        });
        applyDamageToNpc(ctx, target, halfDmg, spell.damage.type);
      }
    }
    return { hit: false, damageRolls: [] };
  }

  // Cantrip scaling: extra dice at character L5/11/17. Leveled spells get
  // upcast bonus dice via slotLevel > spell.level (one extra die per level
  // above base for damage-cantrip-shaped attacks; we apply a generic +1d
  // per upcast tier as a placeholder — Aelar is L1 so it doesn't trigger).
  const dieMult = spell.level === 0 ? cantripDiceMultiplier(ctx.playerDef.level) : 1;
  const upcastBonus = Math.max(0, slotLevel - spell.level);
  const baseDice = spell.damage.dice * dieMult + upcastBonus;
  const dice = isCrit ? baseDice * 2 : baseDice;
  // Warlock Agonizing Blast invocation — add the Charisma modifier to Eldritch
  // Blast's damage (a flat bonus, not doubled on a crit).
  const agonizingBonus = spell.id === 'eldritch-blast' && hasModifierFlag(ctx.playerDef, 'agonizing-blast') ? spellMod(ctx) : 0;
  const { total: dmg, rolls } = rollDamage(dice, spell.damage.sides, (spell.damage.bonus ?? 0) + agonizingBonus);

  ctx.addLog({
    left: `${ctx.playerDef.name} casts ${spell.name}${chainNote} — ${isCrit ? 'CRIT' : 'hit'}, ${dmg} ${spell.damage.type}`,
    right: `d20(${roll})+${bonus}=${total} vs AC ${effectiveAc}${coverNote}${advNote} · ${dice}d${spell.damage.sides}[${rolls.join(',')}]`,
    style: isCrit ? 'crit' : 'hit',
  });
  applyDamageToNpc(ctx, target, dmg, spell.damage.type);

  // On-hit condition riders (Ray of Frost → slowed, Chill Touch → no-healing,
  // Shocking Grasp → no-reactions) — applied from `effect.onHit`, no save.
  // Suppressed when this resolution is itself a follow-up (e.g. a chain hop)
  // to avoid stacking the same rider twice.
  if (!options?.suppressRiders) {
    for (const c of normaliseConditionList(spell.effect?.onHit)) {
      if (!target.conditions.includes(c)) target.conditions.push(c);
      ctx.addLog({ left: `${combatantDisplayName(target, ctx.state.npcs)} ${onHitConditionNote(c)}`, style: 'status' });
    }
    // Delayed-self-damage rider (Acid Arrow). Scheduled at the end of the
    // target's NEXT turn — `turnsRemaining = 1` so the first end-of-turn
    // tick (in finalizeNpcTurn) decrements to 0 and fires.
    if (spell.delayedSelfDamage && target.hp > 0) {
      const upcast = Math.max(0, slotLevel - spell.level);
      const damageType = spell.damage.type;
      target.ongoingEffects.push({
        id: `${spell.id}-${target.id}-${Date.now()}`,
        kind: 'delayed-self-damage',
        spellId: spell.id,
        damageType,
        dice: spell.delayedSelfDamage.dice + upcast,
        sides: spell.delayedSelfDamage.sides,
        bonus: 0,
        turnsRemaining: 1,
      });
      ctx.addLog({
        left: `${combatantDisplayName(target, ctx.state.npcs)} is coated in lingering ${damageType} (${spell.delayedSelfDamage.dice + upcast}d${spell.delayedSelfDamage.sides} at end of its next turn)`,
        style: 'status',
      });
    }
  }
  return { hit: true, damageRolls: rolls };
}

/**
 * Chromatic Orb's "leap on matching dice" rider. Scans the just-rolled damage
 * spread for any pair of dice that match; if found, picks the nearest valid
 * enemy other than the original target within `chainOnDoubles.rangeFeet` and
 * makes a fresh attack roll against it (no rider, no chain re-fire). Logs a
 * no-op when no extra target is in range so the player understands the spell
 * "fizzled" the leap.
 */
function maybeChainOnDoubles(
  ctx: GameContext,
  spell: SpellDef,
  primary: NpcState,
  damageRolls: number[],
  slotLevel: number,
): void {
  if (!spell.chainOnDoubles) return;
  if (damageRolls.length < 2) return;
  const seen = new Set<number>();
  let matched = false;
  for (const r of damageRolls) {
    if (seen.has(r)) { matched = true; break; }
    seen.add(r);
  }
  if (!matched) return;
  const rangeTiles = Math.max(1, Math.ceil(spell.chainOnDoubles.rangeFeet / 5));
  const candidates = ctx.state.npcs
    .filter((n) => n.id !== primary.id && n.hp > 0 && n.disposition !== 'ally')
    .map((n) => ({ n, dist: chebyshev(primary.tileX, primary.tileY, n.tileX, n.tileY) }))
    .filter((c) => c.dist <= rangeTiles)
    .sort((a, b) => a.dist - b.dist);
  if (candidates.length === 0) {
    ctx.addLog({ left: `Chromatic Orb leaps — no second target within ${spell.chainOnDoubles.rangeFeet} ft`, style: 'status' });
    return;
  }
  ctx.addLog({ left: `Chromatic Orb leaps to ${combatantDisplayName(candidates[0].n, ctx.state.npcs)}`, style: 'status' });
  resolveAttackRollSpell(ctx, spell, candidates[0].n, slotLevel, { suppressRiders: true, isChainHop: true });
}

/**
 * Roll a save on a single target after an attack-roll spell hits. Applies
 * `spell.effect.onFail` conditions on failure; logs the outcome either way.
 * Used by Ray of Sickness (Con save → Poisoned). Returns whether any
 * condition was applied so callers can mark the spell as "produced effect".
 */
function resolveOnHitSave(ctx: GameContext, spell: SpellDef, target: NpcState): boolean {
  if (!spell.save || !spell.effect) return false;
  const def = ctx.resolveMonsterDef(target.defId);
  if (!def) return false;
  const dc = spellSaveDC(ctx);
  const saveBonus = npcSaveMod(target, def, spell.save.ability);
  const roll = d20();
  const total = roll + saveBonus;
  const success = total >= dc;
  if (success) {
    ctx.addLog({
      left: `${combatantDisplayName(target, ctx.state.npcs)} resists`,
      right: `${spell.save.ability.toUpperCase()} d20(${roll})+${saveBonus}=${total} vs DC ${dc}`,
      style: 'normal',
    });
    return false;
  }
  const conds = normaliseConditionList(spell.effect.onFail);
  for (const c of conds) {
    if (!target.conditions.includes(c)) target.conditions.push(c);
  }
  ctx.addLog({
    left: `${combatantDisplayName(target, ctx.state.npcs)} ${conditionLogText(spell, conds)}`,
    right: `${spell.save.ability.toUpperCase()} d20(${roll})+${saveBonus}=${total} vs DC ${dc}`,
    style: 'status',
  });
  return conds.length > 0;
}

/**
 * SRD True Strike: make one attack with the equipped weapon, using the
 * caster's spellcasting ability mod (not Str/Dex) for both the attack and
 * damage rolls. On hit, the weapon's damage is dealt; at character L5/11/17
 * an extra 1d6/2d6/3d6 Radiant damage rides along. No-op if the caster
 * isn't holding a valid weapon.
 */
function resolveTrueStrike(ctx: GameContext, spell: SpellDef, target: NpcState, damageTypeChoice: string | undefined): boolean {
  const s = ctx.state;
  const def = ctx.resolveMonsterDef(target.defId);
  if (!def) return false;
  const weaponId = s.player.equippedSlots.weaponId;
  const item = weaponId ? ctx.defs.equipment.find((e) => e.id === weaponId) : undefined;
  const weapon = item && item.type === 'weapon' ? item : undefined;
  if (!weapon) {
    ctx.addLog({ left: `${spell.name}: no valid weapon equipped`, style: 'miss' });
    return false;
  }
  const targetVision = visCanSeeTarget(ctx, target);
  if (targetVision.cover === 'total' || !targetVision.sees) {
    ctx.addLog({ left: `${spell.name} — ${combatantDisplayName(target, s.npcs)} is ${targetVision.cover === 'total' ? 'behind total cover' : 'beyond sight (darkness or concealment)'}`, style: 'miss' });
    return false;
  }
  const visionCover = targetVision.cover;
  const coverAcBonus = visionCover === 'three-quarters' ? 5 : visionCover === 'half' ? 2 : 0;
  const effectiveAc = def.ac + coverAcBonus + shieldAcBonus(target.conditions);
  const sm = spellMod(ctx);
  const bonus = ctx.playerDef.proficiencyBonus + sm;
  const roll = d20();
  const isCrit = roll === 20;
  const total = roll + bonus;
  let hit = isCrit || (roll !== 1 && total >= effectiveAc);
  // US-117 Protective Magic: a hit on a stat-block caster may be met with a
  // reaction-cast Shield (+5 AC, persists via the shielded condition).
  if (hit && tryNpcShieldVsSpellAttack(ctx, target, def, total, effectiveAc, isCrit).deflected) hit = false;
  const coverNote = coverAcBonus > 0 ? ` (+${coverAcBonus} cover)` : '';
  if (!hit) {
    ctx.addLog({
      left: `${ctx.playerDef.name} casts ${spell.name} at ${combatantDisplayName(target, s.npcs)} — miss`,
      right: `d20(${roll})+${bonus}=${total} vs AC ${effectiveAc}${coverNote}`,
      style: 'miss',
    });
    return false;
  }
  // SRD True Strike damage-type pick: "Radiant" or the weapon's normal
  // damage type, caster's choice at cast time. The picker passes `radiant`
  // or `weapon`; default to the weapon's type when nothing was passed in
  // (resolver still works without the client picker — e.g. AIGM cast).
  const wantsRadiant = damageTypeChoice === 'radiant';
  const primaryDamageType = wantsRadiant ? 'radiant' : weapon.damageType;
  // Weapon damage scaled with spellMod. On crit, weapon dice double per SRD
  // critical hit rules; the Radiant rider also doubles since it's part of
  // the same attack's damage.
  const baseDice = isCrit ? weapon.damageDice * 2 : weapon.damageDice;
  const wRoll = rollDamage(baseDice, weapon.damageSides, sm);
  const wDmg = Math.max(0, wRoll.total);
  // Cantrip-tier Radiant rider at L5/11/17.
  const radiantDice = ctx.playerDef.level >= 17 ? 3 : ctx.playerDef.level >= 11 ? 2 : ctx.playerDef.level >= 5 ? 1 : 0;
  let radiantDmg = 0;
  let radiantNote = '';
  if (radiantDice > 0) {
    const rDice = isCrit ? radiantDice * 2 : radiantDice;
    const rRoll = rollDamage(rDice, 6);
    radiantDmg = rRoll.total;
    radiantNote = ` + ${rDice}d6[${rRoll.rolls.join(',')}]=${radiantDmg} radiant`;
  }
  ctx.addLog({
    left: `${ctx.playerDef.name} casts ${spell.name} — ${isCrit ? 'CRIT' : 'hit'}, ${wDmg} ${primaryDamageType}${radiantDmg > 0 ? ` + ${radiantDmg} radiant` : ''}`,
    right: `d20(${roll})+${bonus}=${total} vs AC ${effectiveAc}${coverNote} · ${baseDice}d${weapon.damageSides}[${wRoll.rolls.join(',')}]+${sm}=${wDmg}${radiantNote}`,
    style: isCrit ? 'crit' : 'hit',
  });
  applyDamageToNpc(ctx, target, wDmg, primaryDamageType);
  if (radiantDmg > 0 && target.hp > 0) {
    applyDamageToNpc(ctx, target, radiantDmg, 'radiant');
  }
  return true;
}

/**
 * Resolve a secondary AOE save around the primary target's tile (Ice Knife's
 * "hit or miss, the shard explodes" clause). Independent of whether the
 * primary attack hit. Excludes the primary target so the shard doesn't
 * double-dip — SRD wording is "each creature within 5 feet of the target",
 * not "the target and creatures within 5 feet".
 */
function resolveSecondaryAoe(
  ctx: GameContext,
  spell: SpellDef,
  primary: NpcState,
  slotLevel: number,
  events: GameEvent[],
): boolean {
  if (!spell.secondaryDamage || !spell.save || !spell.area) return false;
  const dc = spellSaveDC(ctx);
  // SRD Ice Knife: "each creature within 5 feet of the target". This is a
  // proximity check from the target's tile centre (chebyshev distance),
  // NOT a placed sphere — the SRD grid-intersection rule for spheres
  // doesn't apply here. `chebyshevDiscTiles` of radius `sizeFeet/5` around
  // the target tile gives the correct 3×3 area for a 5-ft burst.
  const radiusTiles = sphereRadiusTiles(spell);
  const tiles = chebyshevDiscTiles(primary.tileX, primary.tileY, radiusTiles);
  const targets = ctx.state.npcs.filter((n) =>
    n.hp > 0 && n.id !== primary.id && tiles.has(`${n.tileX},${n.tileY}`),
  );
  const playerHit = tiles.has(`${ctx.state.player.tileX},${ctx.state.player.tileY}`);
  if (targets.length === 0 && !playerHit) {
    ctx.addLog({ left: `${spell.name} explodes — no other creatures within ${spell.area.sizeFeet} ft`, style: 'status' });
    return false;
  }
  const upcastBonus = Math.max(0, slotLevel - spell.level);
  const dice = spell.secondaryDamage.dice + upcastBonus;
  const dmgRoll = rollDamage(dice, spell.secondaryDamage.sides, spell.secondaryDamage.bonus ?? 0);
  ctx.addLog({
    left: `${spell.name} explodes — ${spell.save.ability.toUpperCase()} save DC ${dc}`,
    right: `${dice}d${spell.secondaryDamage.sides}[${dmgRoll.rolls.join(',')}]=${dmgRoll.total}`,
    style: 'header',
  });
  let any = false;
  for (const t of targets) {
    const def = ctx.resolveMonsterDef(t.defId);
    if (!def) continue;
    const saveBonus = npcSaveMod(t, def, spell.save.ability);
    const roll = d20();
    const total = roll + saveBonus;
    const success = total >= dc;
    const dmg = damageAfterSave(ctx, spell, success, spell.save.halfOnSuccess, dmgRoll.total);
    ctx.addLog({
      left: `${combatantDisplayName(t, ctx.state.npcs)} ${success ? 'saves' : 'fails'} — ${dmg} ${spell.secondaryDamage.type}`,
      right: `d20(${roll})+${saveBonus}=${total} vs DC ${dc}`,
      style: success ? 'normal' : 'hit',
    });
    applyDamageToNpc(ctx, t, dmg, spell.secondaryDamage.type);
    if (dmg > 0) any = true;
  }
  // The caster gets a save too if their tile sits inside the AOE — Ice
  // Knife doesn't spare its own caster, and SRD wording is "each creature
  // within 5 ft" with no caster exemption.
  if (playerHit) {
    any = rollPlayerSaveAndDamage(ctx, spell, spell.save, spell.secondaryDamage, dmgRoll.total, events) || any;
  }
  return any;
}


function resolveAutoHitSpell(
  ctx: GameContext,
  spell: SpellDef,
  targetIds: string[],
  slotLevel: number,
): boolean {
  if (!spell.damage || !spell.darts) return false;
  const s = ctx.state;
  const darts = spell.darts + Math.max(0, slotLevel - spell.level);

  // Distribute darts: if no targetIds given, fire all at first selected target.
  // If fewer targetIds than darts, extras pile onto the LAST one (caller's choice).
  const assignments: NpcState[] = [];
  if (targetIds.length === 0) {
    const t = s.npcs.find((n) => n.id === s.selectedTargetId && n.hp > 0 && n.disposition !== 'ally');
    if (!t) return false;
    for (let i = 0; i < darts; i++) assignments.push(t);
  } else {
    // Round-robin then pile on last.
    for (let i = 0; i < darts; i++) {
      const id = targetIds[Math.min(i, targetIds.length - 1)];
      const t = s.npcs.find((n) => n.id === id && n.hp > 0 && n.disposition !== 'ally');
      if (t) assignments.push(t);
    }
  }

  if (assignments.length === 0) return false;

  // SRD: all darts strike simultaneously. Pool damage per target so a single
  // application resolves the entire spell — prevents duplicate kill rewards
  // when 2+ darts target the same creature.
  const perTarget = new Map<string, { target: NpcState; darts: number; total: number }>();
  for (const target of assignments) {
    const { total } = rollDamage(spell.damage.dice, spell.damage.sides, spell.damage.bonus ?? 0);
    const acc = perTarget.get(target.id) ?? { target, darts: 0, total: 0 };
    acc.darts += 1;
    acc.total += total;
    perTarget.set(target.id, acc);
  }

  let grandTotal = 0;
  for (const { target, total } of perTarget.values()) {
    grandTotal += total;
    applyDamageToNpc(ctx, target, total, spell.damage.type);
  }
  const summary = [...perTarget.values()].map((v) => `${combatantDisplayName(v.target, ctx.state.npcs)}×${v.darts}`).join(', ');
  ctx.addLog({
    left: `${ctx.playerDef.name} casts ${spell.name} → ${summary} (${grandTotal} ${spell.damage.type})`,
    right: `${darts} darts × 1d${spell.damage.sides}+${spell.damage.bonus ?? 0}`,
    style: 'hit',
  });
  return true;
}




/**
 * Color Spray's HP-pool resolver. Distinct from save-based AOE because
 * targets aren't given a save — the pool itself gates who's affected.
 * Sorts living creatures in the cone by current HP ascending and applies
 * `effect.onFail` conditions (Blinded) until the pool is exhausted.
 * Cantrip/upcast scaling adds dice the same way damage spells do.
 */
function resolveHpPoolSpell(
  ctx: GameContext,
  spell: SpellDef,
  tile: { x: number; y: number } | undefined,
  slotLevel: number,
): boolean {
  if (!spell.hpPool) return false;
  const upcastBonus = Math.max(0, slotLevel - spell.level);
  const dieMult = spell.level === 0 ? cantripDiceMultiplier(ctx.playerDef.level) : 1;
  // SRD scaling for Color Spray is "+2d10 per slot above 1" rather than +1d10,
  // but the difference vanishes once the pool covers all in-cone creatures.
  // We keep it simple: +N dice per upcast tier where N = pool.dice's base count
  // would over-grow; use a flat +pool.dice scaling per tier instead.
  const dice = spell.hpPool.dice * dieMult + upcastBonus * spell.hpPool.dice;
  const { total: pool, rolls } = rollDamage(dice, spell.hpPool.sides);
  ctx.addLog({
    left: `${ctx.playerDef.name} casts ${spell.name} — pool ${pool}`,
    right: `${dice}d${spell.hpPool.sides}[${rolls.join(',')}]=${pool}`,
    style: 'header',
  });
  // SRD: Color Spray affects creatures in the area indiscriminately; allies
  // and enemies alike consume the pool. Sorted by current HP ascending so
  // the lowest-HP creature is gated first.
  const targets = creaturesInArea(ctx, spell, tile)
    .slice()
    .sort((a, b) => a.hp - b.hp);
  if (targets.length === 0) {
    ctx.addLog({ left: `${spell.name} — no creatures in area`, style: 'miss' });
    return false;
  }
  let remaining = pool;
  let any = false;
  const conds = normaliseConditionList(spell.effect?.onFail);
  for (const t of targets) {
    if (t.hp > remaining) {
      ctx.addLog({ left: `${combatantDisplayName(t, ctx.state.npcs)} resists — HP ${t.hp} exceeds pool ${remaining}`, style: 'normal' });
      continue;
    }
    remaining -= t.hp;
    const tDef = ctx.resolveMonsterDef(t.defId);
    const applicable = tDef ? conds.filter((c) => !npcConditionImmune(tDef, c)) : conds;
    for (const c of applicable) {
      if (!t.conditions.includes(c)) t.conditions.push(c);
    }
    // SRD Color Spray: "until the end of your next turn". Schedule the
    // condition strip via the existing ongoingEffects pipeline so the
    // end-of-player-turn tick in CombatFlow lifts it after two end-of-turn
    // hooks fire (this turn's end → 2→1, next turn's end → 1→0 → strip).
    if (spell.durationRounds === 1 && applicable.length > 0) {
      t.ongoingEffects = t.ongoingEffects ?? [];
      for (const c of applicable) {
        t.ongoingEffects.push({
          id: ctx.uid(),
          kind: 'spell-condition',
          spellId: spell.id,
          condition: c,
          turnsRemaining: 2,
        });
      }
    }
    ctx.addLog({
      left: `${combatantDisplayName(t, ctx.state.npcs)} ${conditionLogText(spell, conds)}`,
      right: `pool ${remaining + t.hp} − ${t.hp} = ${remaining}`,
      style: 'status',
    });
    if (conds.length > 0) any = true;
  }
  return any;
}


function resolveSaveSpell(
  ctx: GameContext,
  spell: SpellDef,
  tile: { x: number; y: number } | undefined,
  slotLevel: number,
  selectedIds?: string[],
  events?: GameEvent[],
): boolean {
  if (!spell.save) return false;
  const dc = spellSaveDC(ctx);

  let targets = creaturesInArea(ctx, spell, tile);
  // SRD: AOE spells are indiscriminate by default — the caster can land in
  // their own area when they place it on their own tile (or use a
  // self-anchored sphere). Cube-from-caster shapes (Thunderwave) explicitly
  // exclude the caster's tile so this flag stays false for them.
  let playerHit = playerInArea(ctx, spell, tile);

  // SRD "creature of your choice" spells (Sleep) pair the AOE click with a
  // second-step picker — the client sends the chosen ids in `selectedIds`,
  // and only those are saved against. When the picker isn't used (default
  // path or non-selective AOEs), every creature in the area is targeted.
  if (spell.area?.creaturesOfYourChoice && selectedIds) {
    const allowed = new Set(selectedIds);
    targets = targets.filter((n) => allowed.has(n.id));
    if (!allowed.has('player')) playerHit = false;
  }

  if (targets.length === 0 && !playerHit) {
    // Ground-zone spells (Grease, Silent Image, …) succeed even on empty
    // terrain — the zone is the point, and creatures who step in later
    // trigger the save during movement. `doCastSpell` auto-registers the
    // zone in its tail block; we just need to return success here so the
    // slot consumes and concentration starts. Driven by the spell's
    // `zone.groundPlaceable` descriptor rather than an id list.
    const isGroundZone = !!spell.area && spell.zone?.groundPlaceable === true;
    if (isGroundZone) {
      ctx.addLog({ left: `${ctx.playerDef.name} casts ${spell.name}`, style: 'header' });
      return true;
    }
    ctx.addLog({ left: `${ctx.playerDef.name} casts ${spell.name} — no creatures in area`, style: 'miss' });
    return false;
  }

  // Damage roll — scale dice for cantrip level or upcast slot. SRD says save-
  // based damage spells are rolled ONCE and split — we do the same.
  const upcastBonus = Math.max(0, slotLevel - spell.level);
  const dieMult = spell.level === 0 ? cantripDiceMultiplier(ctx.playerDef.level) : 1;
  let dmgRoll: { total: number; rolls: number[] } | null = null;
  if (spell.damage) {
    const dice = spell.damage.dice * dieMult + upcastBonus;
    dmgRoll = rollDamage(dice, spell.damage.sides, spell.damage.bonus ?? 0);
  }

  ctx.addLog({
    left: `${ctx.playerDef.name} casts ${spell.name} (${spell.save.ability.toUpperCase()} save DC ${dc})`,
    right: dmgRoll && spell.damage ? `${spell.damage.dice * dieMult + upcastBonus}d${spell.damage.sides}[${dmgRoll.rolls.join(',')}]=${dmgRoll.total}` : '',
    style: 'header',
  });

  let anyAffected = false;
  for (const target of targets) {
    const def = ctx.resolveMonsterDef(target.defId);
    if (!def) continue;
    const saveBonus = npcSaveMod(target, def, spell.save.ability);
    const roll = d20();
    const total = roll + saveBonus;
    const success = total >= dc;

    if (dmgRoll && spell.damage) {
      const dmg = damageAfterSave(ctx, spell, success, spell.save.halfOnSuccess, dmgRoll.total);
      ctx.addLog({
        left: `${combatantDisplayName(target, ctx.state.npcs)} ${success ? 'saves' : 'fails'} — ${dmg} ${spell.damage.type}`,
        right: `d20(${roll})+${saveBonus}=${total} vs DC ${dc}`,
        style: success ? 'normal' : 'hit',
      });
      applyDamageToNpc(ctx, target, dmg, spell.damage.type);
      // Thunderwave-style push only triggers on a failed save (SRD). Damage
      // is applied first; if the creature died, the push is a no-op since
      // applyDamageToNpc gates on hp > 0.
      if (!success && spell.push && target.hp > 0) {
        pushNpcAway(ctx, target, spell.push.feet, events);
      }
      if (dmg > 0) anyAffected = true;
    } else if (spell.effect) {
      // Pure condition save (Sleep). `onFail` may be a single condition or an
      // array — Hideous Laughter applies both Prone and Incapacitated.
      const targetDef = ctx.resolveMonsterDef(target.defId);
      const immuneFilter = (c: string) => !targetDef || !npcConditionImmune(targetDef, c);
      const conds = !success ? normaliseConditionList(spell.effect.onFail).filter(immuneFilter) : [];
      for (const c of conds) {
        if (!target.conditions.includes(c)) target.conditions.push(c);
      }
      // On-success rider (same descriptor as the single-target path) — applied
      // without counting toward `anyAffected`, so a fully-saved AOE still won't
      // start concentration.
      if (success) {
        for (const c of normaliseConditionList(spell.effect.onSuccess).filter(immuneFilter)) {
          if (!target.conditions.includes(c)) target.conditions.push(c);
        }
      }
      // Bounded-duration condition spells (Color Spray "until end of your
      // next turn") schedule an ongoingEffect so the end-of-player-turn
      // tick strips the condition. Long-duration spells (Sleep
      // concentration) don't fall into this branch — their `durationRounds`
      // is well above 1.
      if (!success && spell.durationRounds === 1 && conds.length > 0) {
        target.ongoingEffects = target.ongoingEffects ?? [];
        for (const c of conds) {
          target.ongoingEffects.push({
            id: ctx.uid(),
            kind: 'spell-condition',
            spellId: spell.id,
            condition: c,
            turnsRemaining: 2,
          });
        }
      }
      // US-092: Charm Person additionally flips the target's social Attitude
      // to Friendly while charmed, satisfying the SRD Charmed condition's
      // "Social Advantage" branch (the charmer has Advantage on Influence-type
      // checks against the charmed creature). The pre-cast attitude is
      // captured in `attitudePreCharm` so spell-end can restore it.
      if (!success && spell.id === 'charm-person' && conds.includes('charmed')) {
        if (target.attitudePreCharm === undefined) target.attitudePreCharm = target.attitude;
        target.attitude = 'friendly';
      }
      ctx.addLog({
        left: `${combatantDisplayName(target, ctx.state.npcs)} ${success ? 'resists' : conditionLogText(spell, conds)}`,
        right: `d20(${roll})+${saveBonus}=${total} vs DC ${dc}`,
        style: success ? 'normal' : 'status',
      });
      if (!success && conds.length > 0) anyAffected = true;
    } else if (spell.push) {
      // Save vs. push only — no damage, no condition (Gust of Wind).
      ctx.addLog({
        left: `${combatantDisplayName(target, ctx.state.npcs)} ${success ? 'resists' : 'is pushed by ' + spell.name}`,
        right: `d20(${roll})+${saveBonus}=${total} vs DC ${dc}`,
        style: success ? 'normal' : 'status',
      });
      if (!success && target.hp > 0) {
        pushNpcAway(ctx, target, spell.push.feet, events);
        anyAffected = true;
      }
    }
  }
  // Player in the AOE — roll the save, apply damage through the central
  // `applyDamageToPlayer` path so tempHp absorption, concentration breaks
  // and unconscious transitions all fire consistently.
  if (playerHit && dmgRoll && spell.damage) {
    if (rollPlayerSaveAndDamage(ctx, spell, spell.save, spell.damage, dmgRoll.total, events ?? [])) {
      anyAffected = true;
    }
  }
  return anyAffected;
}

/**
 * Single-target save spell (Hideous Laughter, Charm Person, …). The caller
 * has already validated target + range; we just roll the save and apply the
 * effect / damage to the one creature.
 */
function resolveSingleTargetSaveSpell(
  ctx: GameContext,
  spell: SpellDef,
  target: NpcState,
  slotLevel: number,
): boolean {
  if (!spell.save) return false;
  const dc = spellSaveDC(ctx);

  const def = ctx.resolveMonsterDef(target.defId);
  if (!def) return false;
  const saveBonus = npcSaveMod(target, def, spell.save.ability);
  const roll = d20();
  const total = roll + saveBonus;
  const success = total >= dc;

  const upcastBonus = Math.max(0, slotLevel - spell.level);
  const dieMult = spell.level === 0 ? cantripDiceMultiplier(ctx.playerDef.level) : 1;
  let dmgRoll: { total: number; rolls: number[] } | null = null;
  if (spell.damage) {
    const dice = spell.damage.dice * dieMult + upcastBonus;
    dmgRoll = rollDamage(dice, spell.damage.sides, spell.damage.bonus ?? 0);
  }

  ctx.addLog({
    left: `${ctx.playerDef.name} casts ${spell.name} on ${combatantDisplayName(target, ctx.state.npcs)} (${spell.save.ability.toUpperCase()} save DC ${dc})`,
    right: dmgRoll && spell.damage ? `${spell.damage.dice * dieMult + upcastBonus}d${spell.damage.sides}[${dmgRoll.rolls.join(',')}]=${dmgRoll.total}` : '',
    style: 'header',
  });

  if (dmgRoll && spell.damage) {
    const dmg = damageAfterSave(ctx, spell, success, spell.save.halfOnSuccess, dmgRoll.total);
    ctx.addLog({
      left: `${combatantDisplayName(target, ctx.state.npcs)} ${success ? 'saves' : 'fails'} — ${dmg} ${spell.damage.type}`,
      right: `d20(${roll})+${saveBonus}=${total} vs DC ${dc}`,
      style: success ? 'normal' : 'hit',
    });
    applyDamageToNpc(ctx, target, dmg, spell.damage.type);
    return dmg > 0;
  } else if (spell.effect) {
    const targetDef = ctx.resolveMonsterDef(target.defId);
    const immuneFilter = (c: string) => !targetDef || !npcConditionImmune(targetDef, c);
    const conds = !success ? normaliseConditionList(spell.effect.onFail).filter(immuneFilter) : [];
    for (const c of conds) {
      if (!target.conditions.includes(c)) target.conditions.push(c);
    }
    // Single-turn save spells (Command → Incapacitated until the end of the
    // target's next turn) schedule their own strip via the ongoingEffects
    // pipeline — same mechanism Color Spray uses. Concentration spells
    // (Suggestion, Levitate) instead rely on endConcentration's effect.onFail
    // cleanup, so they're deliberately excluded here.
    if (spell.durationRounds === 1 && !spell.concentration && conds.length > 0) {
      target.ongoingEffects = target.ongoingEffects ?? [];
      for (const c of conds) {
        target.ongoingEffects.push({ id: ctx.uid(), kind: 'spell-condition', spellId: spell.id, condition: c, turnsRemaining: 2 });
      }
    }
    // SRD on-success rider (Ray of Enfeeblement: even on a save the target has
    // Disadvantage on its next attack roll — the engine's one-shot `vexed`).
    // Applied from `effect.onSuccess`; the failure return value is unchanged so
    // a fully-saved cast still doesn't trip concentration.
    if (success) {
      for (const c of normaliseConditionList(spell.effect.onSuccess).filter(immuneFilter)) {
        if (!target.conditions.includes(c)) target.conditions.push(c);
      }
    }
    ctx.addLog({
      left: `${combatantDisplayName(target, ctx.state.npcs)} ${success ? 'resists' : conditionLogText(spell, conds)}`,
      right: `d20(${roll})+${saveBonus}=${total} vs DC ${dc}`,
      style: success ? 'normal' : 'status',
    });
    return !success && conds.length > 0;
  } else {
    // SRD Bane: a creature that fails the save subtracts 1d4 from its attack
    // rolls and saving throws for the duration. Recorded as a creature buff the
    // enemy attack/save paths consume via `npcBanePenalty`; stripped when the
    // caster's Concentration ends.
    if (spell.id === 'bane' && !success) {
      applyBuffTo(target, { spellId: 'bane', concentration: true });
    }
    // Pure narrative single-target save (Charm Person, Hideous Laughter). The
    // outcome is logged but no engine-tracked condition is set yet — content
    // can wire one via spell.effect.onFail when needed.
    ctx.addLog({
      left: `${combatantDisplayName(target, ctx.state.npcs)} ${success ? 'resists' : (spell.id === 'bane' ? 'is baned — −1d4 to attacks and saves' : 'is affected')}`,
      right: `d20(${roll})+${saveBonus}=${total} vs DC ${dc}`,
      style: success ? 'normal' : 'status',
    });
    return !success;
  }
}

/**
 * SRD healing spell (Cure Wounds, Healing Word). Restores HP = roll(dice +
 * upcast, sides) + the caster's spellcasting ability modifier to the caster or
 * a chosen ally (a creature at 0 HP can be healed — reviving it clears
 * Unconscious/Stable). Clamped to the target's max HP. Returns whether any HP
 * was actually restored (so a full-HP self-cast doesn't claim concentration).
 */
function resolveHealSpell(ctx: GameContext, spell: SpellDef, targetIds: string[] | undefined, slotLevel: number): boolean {
  if (!spell.heal) return false;
  const s = ctx.state;
  const upcast = Math.max(0, slotLevel - spell.level);
  const perLevel = spell.heal.perLevel ?? spell.heal.dice;
  const { total } = rollDamage(spell.heal.dice + perLevel * upcast, spell.heal.sides);
  // SRD Life Domain — Disciple of Life: a level-1+ healing spell restores an
  // extra 2 + the slot level to the target.
  const discipleBonus = spell.level >= 1 && hasModifierFlag(ctx.playerDef, 'disciple-of-life') ? 2 + slotLevel : 0;
  const amount = Math.max(1, total + spellMod(ctx) + discipleBonus);

  const tid = targetIds?.[0] ?? s.selectedTargetId ?? 'player';
  const ally = tid !== 'player' ? s.npcs.find((n) => n.id === tid && n.disposition === 'ally') : undefined;

  if (ally) {
    const before = ally.hp;
    ally.hp = Math.min(ally.maxHp, ally.hp + amount);
    if (before <= 0 && ally.hp > 0) {
      ally.conditions = ally.conditions.filter((c) => c !== 'unconscious' && c !== 'stable');
    }
    ctx.addLog({ left: `${ctx.playerDef.name} casts ${spell.name} — ${combatantDisplayName(ally, s.npcs)} regains ${ally.hp - before} HP`, style: 'heal' });
    if (ally.hp > before) ctx.eventSink?.push({ type: 'heal', entityId: ally.id, amount: ally.hp - before, newHp: ally.hp });
    return ally.hp > before;
  }

  // Self (explicit 'player' target, no target, or an invalid/non-ally id).
  const before = s.player.hp;
  s.player.hp = Math.min(ctx.playerDef.maxHp, s.player.hp + amount);
  ctx.addLog({ left: `${ctx.playerDef.name} casts ${spell.name} — regains ${s.player.hp - before} HP`, style: 'heal' });
  if (s.player.hp > before) ctx.eventSink?.push({ type: 'heal', entityId: 'player', amount: s.player.hp - before, newHp: s.player.hp });
  return s.player.hp > before;
}




// ── Entry point ─────────────────────────────────────────────────────────────

/** A spell is "aggressive" if it can damage or impose a harmful condition on a creature. */
function isAggressiveSpell(spell: SpellDef): boolean {
  return !!(spell.attack || spell.damage || spell.save || spell.darts);
}

/**
 * If we're in exploring phase and the cast is aggressive, return the non-ally
 * NPCs the cast would affect (so casting at them would start combat). Pure —
 * promotes / aggros nothing; the caller routes these through the combat-start
 * confirmation prompt. Returns [] when the cast wouldn't start combat.
 */
function castAggroTargets(
  ctx: GameContext,
  spell: SpellDef,
  targetIds: string[] | undefined,
  tile: { x: number; y: number } | undefined,
): NpcState[] {
  const s = ctx.state;
  if (s.phase !== 'exploring') return [];
  if (!isAggressiveSpell(spell)) return [];

  // Identify the non-ally NPCs affected by the cast. Attack-roll and
  // single-target save spells (Hideous Laughter, Charm Person) key off the
  // selected creature; AOE save spells use the area sweep.
  if (spell.attack === 'ranged-spell' || spell.attack === 'melee-spell' || spell.attack === 'auto-hit'
    || (spell.save && !spell.area)) {
    const ids = targetIds && targetIds.length > 0 ? targetIds : (s.selectedTargetId ? [s.selectedTargetId] : []);
    return ids
      .map((id) => s.npcs.find((n) => n.id === id))
      .filter((n): n is NpcState => !!n && n.hp > 0 && n.disposition !== 'ally');
  }
  if (spell.save) {
    // For aggro-trigger purposes we still filter to non-allies — allies in the
    // area take damage in the resolver but don't influence faction aggro.
    return creaturesInArea(ctx, spell, tile).filter((n) => n.disposition !== 'ally');
  }
  return [];
}


export function doUseScroll(ctx: GameContext, scrollItemId: string, events: GameEvent[]): void {
  if (!ctx.state.player.inventoryIds.includes(scrollItemId)) return;
  const scroll = ctx.defs.equipment.find((i) => i.id === scrollItemId);
  if (!scroll || scroll.type !== 'scroll') return;
  const spellId = (scroll as { spellId: string }).spellId;
  const spell = ctx.defs.spells.find((sp) => sp.id === spellId);
  if (!spell) return;
  // Action economy: casting from a scroll still costs the spell's action. In
  // combat, refuse when the required economy slot is already spent (the scroll
  // path bypasses canCastSpell, so guard here).
  const s = ctx.state;
  if (s.phase === 'player_turn') {
    if (isIncapacitated(s.player.conditions)) return;
    if (spell.castingTime === 'action' && s.player.actionUsed) { ctx.addLog({ left: `No action left to read the scroll.`, style: 'miss' }); return; }
    if (spell.castingTime === 'bonus-action' && s.player.bonusActionUsed) { ctx.addLog({ left: `No bonus action left to read the scroll.`, style: 'miss' }); return; }
    if (spell.castingTime === 'reaction') return;  // reaction-cast scrolls aren't player-triggerable here
  }
  doCastSpell(ctx, spellId, spell.level, undefined, undefined, false, events, undefined, undefined, undefined, scrollItemId);
}

export function doCastSpell(
  ctx: GameContext,
  spellId: string,
  slotLevel: number,
  targetIds: string[] | undefined,
  tile: { x: number; y: number } | undefined,
  asRitual: boolean,
  events: GameEvent[],
  damageTypeChoice?: string,
  onFailChoice?: string,
  abilityChoice?: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha',
  /** When set, this cast comes from a Spell Scroll (US-124): no slot is spent
   *  (the scroll is consumed instead) and the prepared/known + slot gates are
   *  bypassed. The scroll's action cost still applies. */
  scrollItemId?: string,
): void {
  const baseSpell = ctx.defs.spells.find((sp) => sp.id === spellId);
  if (!baseSpell) return;
  // Validate the scroll up front: must be in inventory and cast its spell.
  if (scrollItemId !== undefined) {
    if (!ctx.state.player.inventoryIds.includes(scrollItemId)) return;
    const scroll = ctx.defs.equipment.find((i) => i.id === scrollItemId);
    if (!scroll || scroll.type !== 'scroll' || (scroll as { spellId: string }).spellId !== spellId) return;
  }

  // Spells that let the caster pick a damage type at cast time (Chromatic
  // Orb, …) carry a `damageTypeChoices` list. Apply the player's choice by
  // swapping `damage.type` on a shallow clone so the rest of the resolver
  // doesn't need a per-call override path.
  let spell = baseSpell;
  if (baseSpell.damageTypeChoices && baseSpell.damageTypeChoices.length > 0 && baseSpell.damage) {
    const fallback = baseSpell.damage.type;
    const picked = damageTypeChoice && baseSpell.damageTypeChoices.includes(damageTypeChoice)
      ? damageTypeChoice
      : fallback;
    spell = { ...baseSpell, damage: { ...baseSpell.damage, type: picked } };
  }
  // SRD onFailChoice (Blindness/Deafness — caster picks Blinded or Deafened).
  // The cast can pass a `onFailChoice` from the cast action; the engine
  // narrows `effect.onFail` to the chosen condition before resolution. If
  // the pick is missing or invalid, default to the first option.
  if (baseSpell.onFailChoice && baseSpell.onFailChoice.length > 0) {
    const picked = onFailChoice && baseSpell.onFailChoice.includes(onFailChoice)
      ? onFailChoice
      : baseSpell.onFailChoice[0];
    spell = { ...spell, effect: { ...(spell.effect ?? {}), onFail: picked } };
  }

  // Ritual casting has its own eligibility rules: spell must have the Ritual
  // tag, must be known (spellbook OR cantrip — cantrips can't really be cast
  // as rituals but we don't gate on level here), and it can only happen
  // outside combat (10-minute fictional cast). It does NOT require the spell
  // be prepared, and it does NOT consume a slot.
  if (asRitual) {
    if (!spell.ritual) { ctx.addLog({ left: `${spell.name} cannot be cast as a ritual`, style: 'miss' }); return; }
    if (ctx.state.phase !== 'exploring') { ctx.addLog({ left: `Ritual casting requires 10 minutes — not possible in combat`, style: 'miss' }); return; }
    const known = ctx.playerDef.defaultSpellbookIds?.includes(spellId)
      ?? ctx.playerDef.defaultCantripIds?.includes(spellId);
    if (!known) { ctx.addLog({ left: `${spell.name} is not in your spellbook`, style: 'miss' }); return; }
  } else if (scrollItemId === undefined && !canCastSpell(ctx, spellId)) {
    // Scroll casts bypass the prepared/known + slot gate (the scroll IS the
    // resource); a normal cast must pass `canCastSpell`.
    return;
  }

  // ── Pre-cast validation — bail BEFORE consuming any slot/action ───────────
  // For attack-roll spells, resolve target and range up front; for AOE spells
  // there's no useful pre-check (any tile is valid; empty-area is the caller's
  // own miss). If a check fails here we return silently — no slot spent, no
  // action used.
  let preResolvedTarget: NpcState | null = null;
  if (spell.attack === 'ranged-spell' || spell.attack === 'melee-spell' || spell.weaponAttack) {
    const tid = targetIds?.[0] ?? ctx.state.selectedTargetId;
    if (!tid) { ctx.addLog({ left: `${spell.name}: no target`, style: 'miss' }); return; }
    const target = ctx.state.npcs.find((n) => n.id === tid && n.hp > 0 && n.disposition !== 'ally');
    if (!target) { ctx.addLog({ left: `${spell.name}: invalid target`, style: 'miss' }); return; }
    // True Strike (weaponAttack) uses the equipped weapon's range, not the
    // spell's rangeFeet. We approximate by looking up the weapon's
    // attack to derive a reach in feet; melee defaults to 5 ft if absent.
    const dist = chebyshev(ctx.state.player.tileX, ctx.state.player.tileY, target.tileX, target.tileY);
    let rangeTiles: number;
    if (spell.weaponAttack) {
      const wId = ctx.state.player.equippedSlots.weaponId;
      const item = wId ? ctx.defs.equipment.find((e) => e.id === wId) : undefined;
      const w = item && item.type === 'weapon' ? item : undefined;
      // Ranged-weapon reach if the equipped weapon shoots (longbow, sling);
      // otherwise melee 5 ft. Thrown range is ignored — True Strike makes
      // an attack, not a throw.
      const weaponRangeFeet = w?.rangeNormal && w.rangeNormal > 0 ? w.rangeNormal : 5;
      rangeTiles = Math.max(1, Math.ceil(weaponRangeFeet / 5));
    } else {
      rangeTiles = Math.max(1, Math.ceil(spell.rangeFeet / 5));
    }
    if (dist > rangeTiles) {
      ctx.addLog({ left: `${spell.name}: target out of range`, style: 'miss' });
      return;
    }
    preResolvedTarget = target;
  } else if (spell.attack === 'auto-hit') {
    const tid = targetIds?.[0] ?? ctx.state.selectedTargetId;
    const target = tid ? ctx.state.npcs.find((n) => n.id === tid && n.hp > 0 && n.disposition !== 'ally') : null;
    if (!target) { ctx.addLog({ left: `${spell.name}: no target`, style: 'miss' }); return; }
    preResolvedTarget = target;
  } else if (spell.save && !spell.area && spell.id !== 'enlarge-reduce') {
    // Single-target save spell (Hideous Laughter, Charm Person, …).
    // Validate target + range up front so we don't consume a slot / action on
    // a no-target cast or an out-of-range pick. Enlarge/Reduce is excluded: it
    // can self-target (no NPC), so its own handler does the range/target check.
    const tid = targetIds?.[0] ?? ctx.state.selectedTargetId;
    const target = tid ? ctx.state.npcs.find((n) => n.id === tid && n.hp > 0 && n.disposition !== 'ally') : null;
    if (!target) { ctx.addLog({ left: `${spell.name}: no target`, style: 'miss' }); return; }
    const dist = chebyshev(ctx.state.player.tileX, ctx.state.player.tileY, target.tileX, target.tileY);
    if (dist > Math.max(1, Math.ceil(spell.rangeFeet / 5))) {
      ctx.addLog({ left: `${spell.name}: target out of range`, style: 'miss' });
      return;
    }
    preResolvedTarget = target;
  }

  // ── US-116 upcasting: resolve the effective slot level ────────────────────
  // Cantrips, ritual casts, and scroll casts always resolve at the spell's
  // base level (cantrips spend no slot; rituals spend no slot; a scroll stores
  // a fixed-level spell). A normal levelled cast may upcast: clamp the request
  // to [spell.level, 9] — no downcasting — and require a free slot at that
  // level, bailing before any resource is spent if none is available.
  if (spell.level === 0 || asRitual || scrollItemId !== undefined) {
    slotLevel = spell.level;
  } else if (ctx.state.player.pactMagic) {
    // Warlock Pact Magic: every levelled spell is cast at the single pact slot
    // level (auto-upcast), spending one slot from the one pool.
    slotLevel = ctx.state.player.pactMagic.level;
    if (ctx.state.player.pactMagic.remaining <= 0 && !isMagicInitiateSpell(ctx.playerDef, spell.id)) {
      ctx.addLog({ left: `${spell.name}: no Pact Magic slot remaining (Short Rest to recover)`, style: 'miss' });
      return;
    }
  } else {
    slotLevel = Math.max(spell.level, Math.min(9, slotLevel || spell.level));
    if ((ctx.state.player.spellSlots[slotLevel - 1] ?? 0) <= 0) {
      ctx.addLog({ left: `${spell.name}: no level-${slotLevel} slot available`, style: 'miss' });
      return;
    }
  }

  // An aggressive cast out of combat WOULD start it — pause for confirmation
  // instead of casting. On accept the engine rolls initiative; the player then
  // casts normally on their turn (this cast is NOT auto-performed, so no slot /
  // resource is spent here). Same gate as the ATTACK button.
  const aggroTargets = castAggroTargets(ctx, spell, targetIds, tile);
  if (aggroTargets.length > 0) {
    requestCombatStart(ctx, aggroTargets.map((n) => n.id), `Casting ${spell.name} will start combat.`);
    return;
  }

  // SRD Sanctuary ends the moment the warded creature casts a spell at a foe.
  // An aggressive cast strips the caster's own ward before the spell resolves.
  if (isAggressiveSpell(spell) && ctx.state.player.conditions.includes('sanctuary')) {
    ctx.state.player.conditions = ctx.state.player.conditions.filter((c) => c !== 'sanctuary');
    ctx.addLog({ left: `${ctx.playerDef.name}'s Sanctuary fades — casting at a foe breaks the ward.`, style: 'status' });
  }

  // SRD 5.2.1 Counterspell (US-117 Protective Magic): a hostile stat-block
  // caster may interrupt this cast. On a failed player CON save the spell
  // dissipates — the action is wasted, the slot is NOT expended. Ritual
  // casts (10 fictional minutes, out of combat) are not interruptible.
  if (!asRitual && tryNpcCounterspell(ctx, spell, events)) {
    spendCastingAction(ctx, spell);
    return;
  }

  consumeCastingResources(ctx, spell, slotLevel, asRitual, scrollItemId !== undefined);

  // The player has used magic — let encounter triggers react (e.g. NPCs
  // startled to see an elf cast in a land where it's suppressed).
  ctx.publish({ type: 'spell_cast', spellId: spell.id, school: spell.school, level: spell.level });

  // Cast VFX — the projectile / beam / burst / glow that plays BEFORE the
  // damage / heal / condition beats (which the resolvers and the
  // PresentationHooks bridge emit during resolution). Pushed here so the
  // timeline order is cast → impact. Data-driven from `spell.vfx`.
  if (spell.vfx) {
    const targetNpc = preResolvedTarget
      ?? (targetIds && targetIds[0] && targetIds[0] !== 'player'
        ? ctx.state.npcs.find((n) => n.id === targetIds[0])
        : undefined);
    const toTile = tile ?? (targetNpc ? { x: targetNpc.tileX, y: targetNpc.tileY } : undefined);
    events.push({
      type: 'spell_vfx', style: spell.vfx.style, palette: spell.vfx.palette,
      fromId: 'player',
      toId: targetNpc?.id,
      toX: toTile?.x, toY: toTile?.y,
      shape: spell.vfx.shape, radiusFeet: spell.vfx.radiusFeet, count: spell.vfx.count,
    });
  }

  // US-124: the scroll is expended on casting (regardless of hit/miss).
  if (scrollItemId !== undefined) {
    const idx = ctx.state.player.inventoryIds.indexOf(scrollItemId);
    if (idx !== -1) ctx.state.player.inventoryIds.splice(idx, 1);
    ctx.addLog({ left: `The scroll crumbles to ash as ${spell.name} is cast.`, style: 'status' });
  }

  // SRD: a spell with a Verbal component spoken aloud breaks Hide on the
  // caster. We emit a `noise` event at the caster's tile; the Sound bus
  // subscriber will clear the hide. Subtle Spell / silent-cast metamagic
  // would later set `components.verbal = false` to suppress this.
  if (spell.components.verbal) {
    emitNoise(ctx, ctx.state.player.tileX, ctx.state.player.tileY, NOISE_SPELL_VERBAL, 'player');
  }

  // Summon spells (Mage Hand, Unseen Servant) take the AOE-click tile and
  // conjure the spell's `summon.monsterId` there. Handled before the
  // mechanical-shape branch since these are neither attack rolls nor saves.
  if (spell.summon) {
    if (!tile) {
      ctx.addLog({ left: `${spell.name}: no target tile`, style: 'miss' });
      return;
    }
    const dist = chebyshev(ctx.state.player.tileX, ctx.state.player.tileY, tile.x, tile.y);
    if (dist > Math.max(1, Math.ceil(spell.rangeFeet / 5))) {
      ctx.addLog({ left: `${spell.name}: target tile out of range`, style: 'miss' });
      return;
    }
    const summoned = ctx.spawnSummon(spell.summon.monsterId, spell.id, tile.x, tile.y);
    if (!summoned) {
      ctx.addLog({ left: `${spell.name}: no space to summon`, style: 'miss' });
      return;
    }
    ctx.addLog({ left: `${ctx.playerDef.name} casts ${spell.name} — ${summoned.name} appears`, style: 'status' });
    // SRD Spiritual Weapon: the spell carries its cast slot level so the
    // recurring strike scales, and immediately makes one melee spell attack
    // against a creature within 5 ft of where it appeared.
    if (spell.id === 'spiritual-weapon') {
      summoned.summonSlotLevel = slotLevel;
      const adj = ctx.state.npcs.find((n) => n.hp > 0 && n.disposition === 'enemy'
        && chebyshev(summoned.tileX, summoned.tileY, n.tileX, n.tileY) <= 1);
      if (adj) resolveSpiritualWeaponAttack(ctx, summoned, adj, events);
    }
    // Concentration-bound summons (Flaming Sphere) need to start
    // concentration here — the bottom-of-function check is skipped
    // because the summon branch returns early.
    if (spell.concentration) startConcentration(ctx, spell.id);
    return;
  }

  // Spirit Guardians — a caster-anchored damaging aura, not a thrown AOE.
  // Handled before the generic save/area branch so the persistent emanation
  // (slow + recurring per-turn save) is raised instead of a one-shot blast.
  if (spell.id === 'spirit-guardians') {
    castSpiritGuardians(ctx, slotLevel);
    return;
  }

  // Enlarge/Reduce — a dual-mode buff/debuff, not a plain condition-save.
  // Mode is driven by the target: self / ally → Enlarge (buff); enemy →
  // Reduce (unwilling, CON save). Handled before the generic save branch.
  if (spell.id === 'enlarge-reduce') {
    castEnlargeReduce(ctx, spell, targetIds);
    return;
  }

  // Branch by mechanical shape; each resolver returns whether the spell
  // actually produced a lasting effect (any target affected, damage dealt,
  // etc.) so we can suppress concentration on a "spell fizzled" outcome.
  let anyEffect = false;
  if (spell.weaponAttack) {
    // True Strike — weapon attack using spellMod (custom path, distinct
    // from the generic spell-attack roll because the damage dice + type
    // come from the equipped weapon).
    if (preResolvedTarget) {
      anyEffect = resolveTrueStrike(ctx, spell, preResolvedTarget, damageTypeChoice);
    }
  } else if (spell.attack === 'ranged-spell' || spell.attack === 'melee-spell') {
    if (preResolvedTarget) {
      // SRD Scorching Ray and similar multi-roll attack spells (`attackCount`)
      // make N independent ranged spell attacks. Each ray rolls its own
      // d20 + damage. Per-ray re-targeting: when the client sends a
      // `targetIds` array of length ≥ 2, each ray fires at the matching
      // index (Ray 1 → targetIds[0], Ray 2 → targetIds[1], …); extras pile
      // onto the last entry. With no array (or length 1) every ray hits
      // `preResolvedTarget` — the legacy single-target behaviour. Upcasting
      // adds one ray per slot level above the spell's base level per SRD.
      const baseCount = spell.attackCount ?? 1;
      const totalCount = baseCount + (spell.attackCount ? Math.max(0, slotLevel - spell.level) : 0);
      let hitsAny = false;
      const resolveRayTarget = (i: number): NpcState | null => {
        if (!targetIds || targetIds.length <= 1) return preResolvedTarget;
        const id = targetIds[Math.min(i, targetIds.length - 1)];
        const t = ctx.state.npcs.find((n) => n.id === id && n.hp > 0 && n.disposition !== 'ally');
        return t ?? preResolvedTarget;
      };
      for (let i = 0; i < totalCount; i++) {
        const rayTarget = resolveRayTarget(i);
        if (!rayTarget || rayTarget.hp <= 0) continue;
        if (totalCount > 1) ctx.addLog({ left: `── Ray ${i + 1} of ${totalCount} → ${combatantDisplayName(rayTarget, ctx.state.npcs)} ──`, style: 'normal' });
        const result = resolveAttackRollSpell(ctx, spell, rayTarget, slotLevel);
        if (result.hit) hitsAny = true;
        // Per-ray riders only fire on hits — same as the single-attack path.
        if (result.hit && spell.save && spell.effect && !spell.area) {
          if (resolveOnHitSave(ctx, spell, rayTarget)) hitsAny = true;
        }
        if (result.hit) maybeChainOnDoubles(ctx, spell, rayTarget, result.damageRolls, slotLevel);
      }
      anyEffect = hitsAny;
      // Ice Knife's "hit or miss, the shard explodes" — runs once regardless
      // of the volley's outcome. Single-ray spells skip the loop above
      // for `i = 0` and reach this branch normally.
      if (spell.secondaryDamage && spell.area && spell.save) {
        if (resolveSecondaryAoe(ctx, spell, preResolvedTarget, slotLevel, events)) anyEffect = true;
      }
    }
  } else if (spell.attack === 'auto-hit') {
    anyEffect = resolveAutoHitSpell(ctx, spell, targetIds ?? [], slotLevel);
  } else if (spell.hpPool && spell.area) {
    // Color Spray: HP-pool gated AOE with no saves. Dispatched ahead of the
    // generic save branch so spells with hpPool aren't forced to also carry
    // a `save` block they wouldn't actually use.
    anyEffect = resolveHpPoolSpell(ctx, spell, tile, slotLevel);
  } else if (spell.heal) {
    anyEffect = resolveHealSpell(ctx, spell, targetIds, slotLevel);
  } else if (spell.save) {
    if (preResolvedTarget) {
      anyEffect = resolveSingleTargetSaveSpell(ctx, spell, preResolvedTarget, slotLevel);
    } else {
      anyEffect = resolveSaveSpell(ctx, spell, tile, slotLevel, targetIds, events);
    }
  } else {
    // Utility / self spells (Mage Armor, Detect Magic, …) always produce
    // their effect by definition — they don't roll for it. Tile is passed
    // through so AOE-shaped utility spells (Fog Cloud) can read it.
    resolveUtilitySpell(ctx, spell, slotLevel, tile, targetIds, abilityChoice, damageTypeChoice);
    anyEffect = true;
  }

  // SRD Gust of Wind: "The gust disperses gas or vapor". Walk the active
  // zones and drop any Fog Cloud whose tile-set overlaps the gust's line —
  // the visible cloud is blown away, conditions on creatures still standing
  // in those tiles are stripped (mirrors zone-expiry behaviour). Other
  // dispersible clouds plug in here by listing their spell id.
  if (spell.id === 'gust-of-wind' && spell.area && tile) {
    const gustTiles = tilesInArea(ctx, spell, tile);
    const DISPERSIBLE = new Set(['fog-cloud']);
    if (ctx.state.activeZones && ctx.state.activeZones.length > 0) {
      const survivors: typeof ctx.state.activeZones = [];
      const dispersedSpellIds: string[] = [];
      for (const z of ctx.state.activeZones) {
        if (!DISPERSIBLE.has(z.spellId)) { survivors.push(z); continue; }
        const overlap = z.tiles.some(([x, y]) => gustTiles.has(`${x},${y}`));
        if (!overlap) { survivors.push(z); continue; }
        stripZoneAffectedConditions(ctx, z);
        ctx.addLog({ left: `Gust of Wind disperses ${z.name}`, style: 'status' });
        if (z.casterId === 'player') dispersedSpellIds.push(z.spellId);
      }
      ctx.state.activeZones = survivors;
      // SRD: a concentration spell ends when its area is destroyed. End
      // concentration on any dispersed cloud the caster was sustaining so
      // the slot isn't wasted on a ghost spell. `endConcentration` will
      // also no-op on the zone strip since we just dropped the zone.
      for (const sid of dispersedSpellIds) {
        if (ctx.state.player.concentratingOn === sid) {
          endConcentration(ctx, `${sid} dispersed by Gust of Wind`);
        }
      }
    }
  }

  // Concentration only kicks in after a real effect lands — every target
  // saved or the spell missed → no ongoing effect → no concentration cost.
  // A new concentration spell drops any previous one first.
  if (spell.concentration && anyEffect) startConcentration(ctx, spell.id);

  // Ground-placeable persistent zones (Grease, Silent Image, Minor Illusion,
  // Gust of Wind) — data-driven from `spell.zone.groundPlaceable`. The zone
  // IS the spell, so it registers even with no creature in the area at cast
  // time (the `anyEffect` gate is dropped); creatures who later enter trigger
  // the zone's `enterSave` during movement / turn-start, or — for Gust — at
  // end of turn via `runGustOfWindEndOfTurnSaves`. Cast-time zones (Fog Cloud,
  // Darkness, Web) register inside `resolveUtilitySpell`'s zone handler and do
  // NOT carry `groundPlaceable`, so they skip this block. Recasting a non-
  // concentration variant stacks (multiple Grease patches); a concentration
  // variant drops the prior instance inside `registerActiveZone`. Spells whose
  // area is just a cast-time picker (Sleep) carry no `zone` and are skipped.
  if (spell.area && spell.zone?.groundPlaceable && tile) {
    const enterSave = spell.zone.enterSave
      ? { ability: spell.zone.enterSave.ability, dc: spellSaveDC(ctx) }
      : undefined;
    registerActiveZone(ctx, spell, tile, spell.zone.enterSave?.condition, spell.zone.tintHex, enterSave);
  }
}

// Export labels useful for the UI.
export function spellLabel(spell: SpellDef): string {
  return spell.level === 0 ? `${spell.name} (cantrip)` : `${spell.name} (L${spell.level})`;
}

// Expose a simple "log opener" for narrative GM hooks if needed later.
function _logOpenerStub(_log: LogEntry): void { /* intentionally empty */ }
void _logOpenerStub;
