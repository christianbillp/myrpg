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
import { combatantDisplayName } from './CombatFlow.js';
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
function visCanSeeTargetCover(ctx: GameContext, target: NpcState): 'none' | 'half' | 'three-quarters' | 'total' {
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
function cantripDiceMultiplier(level: number): number {
  if (level >= 17) return 4;
  if (level >= 11) return 3;
  if (level >= 5)  return 2;
  return 1;
}

function rollDamage(dice: number, sides: number, bonus = 0): { total: number; rolls: number[] } {
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
function applyDamageToNpc(
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
  applyDamageWithTempHp(target, finalDamage);
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
  const visionCover = visCanSeeTargetCover(ctx, target);
  if (visionCover === 'total') {
    ctx.addLog({
      left: `${ctx.playerDef.name} casts ${spell.name} — ${combatantDisplayName(target, ctx.state.npcs)} is behind total cover`,
      style: 'miss',
    });
    return { hit: false, damageRolls: [] };
  }
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
  const visionCover = visCanSeeTargetCover(ctx, target);
  if (visionCover === 'total') {
    ctx.addLog({ left: `${spell.name} — ${combatantDisplayName(target, s.npcs)} is behind total cover`, style: 'miss' });
    return false;
  }
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

/**
 * Roll a save for the player against an AOE save spell and apply the
 * damage. Shared between `resolveSecondaryAoe` and `resolveSaveSpell` so the
 * player's tempHp / concentration / unconscious paths all run consistently
 * via `ctx.applyDamageToPlayer`. Returns whether real damage landed.
 */
function rollPlayerSaveAndDamage(
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
 * Persistent-zone helper: tag every creature standing in the spell's AOE at
 * cast time with `condition`, and push a long-lived `ActiveZone` record onto
 * `state.activeZones` so the cloud stays visible on the map until its
 * duration expires.
 *
 * Lifetime is decoupled from concentration — the visible zone is driven by
 * `spell.durationRounds`, ticked down at end of round in `GameEngine`. The
 * caster losing concentration is no longer enough to strip the cloud; that
 * matches what players expect when they look at a Fog Cloud on the map and
 * is the right primitive for the upcoming Spirit Guardians / Cloudkill /
 * Wall spells, none of which want their geometry to vanish on a downstream
 * status change.
 */
function applyZoneCondition(
  ctx: GameContext,
  spell: SpellDef,
  tile: { x: number; y: number } | undefined,
  condition: string,
  effectLabel: string,
  tintHex?: string,
): void {
  const s = ctx.state;
  if (!tile) {
    ctx.addLog({ left: `${spell.name}: no target tile`, style: 'miss' });
    return;
  }
  const inArea = creaturesInArea(ctx, spell, tile);
  for (const t of inArea) {
    if (!t.conditions.includes(condition)) t.conditions.push(condition);
  }
  const casterIn = playerInArea(ctx, spell, tile);
  if (casterIn && !s.player.conditions.includes(condition)) {
    s.player.conditions.push(condition);
  }
  registerActiveZone(ctx, spell, tile, condition, tintHex);
  // Mark the zone with every creature it just tagged, so the end-of-zone
  // cleanup can strip the condition even from creatures that have since
  // been pushed / teleported outside the original tile set.
  const z = s.activeZones?.[s.activeZones.length - 1];
  if (z) {
    for (const t of inArea) if (!z.affectedNpcIds.includes(t.id)) z.affectedNpcIds.push(t.id);
    if (casterIn) z.affectedPlayer = true;
  }
  const total = inArea.length + (casterIn ? 1 : 0);
  ctx.addLog({
    left: `${ctx.playerDef.name} casts ${spell.name} — ${total} creature(s) ${effectLabel}`,
    style: 'status',
  });
}

/**
 * Persistent-zone helper with a save (Web). Each creature in the area rolls
 * `saveAbility` vs the spell save DC; on failure, `condition` is applied
 * AND the zone is registered on `state.activeZones` so the visual stays up
 * until the duration expires. See `applyZoneCondition` for the lifetime
 * model. SRD "first time entering on a turn" re-tagging is still TBD;
 * creatures present at cast time get the save today.
 */
function applyZoneSave(
  ctx: GameContext,
  spell: SpellDef,
  tile: { x: number; y: number } | undefined,
  saveAbility: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha',
  condition: string,
  effectLabel: string,
): void {
  const s = ctx.state;
  if (!tile) {
    ctx.addLog({ left: `${spell.name}: no target tile`, style: 'miss' });
    return;
  }
  const inArea = creaturesInArea(ctx, spell, tile);
  const dc = spellSaveDC(ctx);
  ctx.addLog({
    left: `${ctx.playerDef.name} casts ${spell.name} (${saveAbility.toUpperCase()} save DC ${dc})`,
    style: 'header',
  });
  let affected = 0;
  for (const t of inArea) {
    const def = ctx.resolveMonsterDef(t.defId);
    if (!def) continue;
    const saveBonus = npcSaveMod(t, def, saveAbility);
    const roll = d20();
    const total = roll + saveBonus;
    const success = total >= dc;
    if (!success && !t.conditions.includes(condition)) {
      t.conditions.push(condition);
      affected++;
    }
    ctx.addLog({
      left: `${combatantDisplayName(t, ctx.state.npcs)} ${success ? 'breaks free' : effectLabel}`,
      right: `${saveAbility.toUpperCase()} d20(${roll})+${saveBonus}=${total} vs DC ${dc}`,
      style: success ? 'normal' : 'status',
    });
  }
  // Player in area too — roll the save inline (no damage, so we don't
  // route through rollPlayerSaveAndDamage which requires a damage type).
  if (playerInArea(ctx, spell, tile)) {
    const dc = spellSaveDC(ctx);
    const abMod = mod(ctx.playerDef[saveAbility]);
    const profBonus = ctx.playerDef.savingThrowProficiencies.includes(saveAbility)
      ? ctx.playerDef.proficiencyBonus
      : 0;
    const saveBonus = abMod + profBonus;
    const roll = d20();
    const total = roll + saveBonus;
    const success = total >= dc;
    if (!success && !s.player.conditions.includes(condition)) {
      s.player.conditions.push(condition);
      affected++;
    }
    ctx.addLog({
      left: `${ctx.playerDef.name} ${success ? 'breaks free' : effectLabel}`,
      right: `${saveAbility.toUpperCase()} d20(${roll})+${saveBonus}=${total} vs DC ${dc}`,
      style: success ? 'normal' : 'status',
    });
  }
  registerActiveZone(ctx, spell, tile, condition);
  // Same affected-id tracking as `applyZoneCondition` — see comment there.
  const zoneAdded = s.activeZones?.[s.activeZones.length - 1];
  if (zoneAdded) {
    for (const t of inArea) {
      if (t.conditions.includes(condition) && !zoneAdded.affectedNpcIds.includes(t.id)) {
        zoneAdded.affectedNpcIds.push(t.id);
      }
    }
    if (s.player.conditions.includes(condition) && playerInArea(ctx, spell, tile)) {
      zoneAdded.affectedPlayer = true;
    }
  }
  void affected;
}

/**
 * Push an `ActiveZone` record onto the session state. Idempotent on
 * (`spellId`, `casterId`) — recasting the same spell replaces the prior
 * entry. The zone outlives the caster's concentration (per the user's
 * explicit ruling); lifetime is whatever the spell's `durationRounds`
 * dictates, and the engine's end-of-round tick decrements it.
 */
function registerActiveZone(
  ctx: GameContext,
  spell: SpellDef,
  tile: { x: number; y: number },
  condition: string | undefined,
  tintHex?: string,
  enterSave?: { ability: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'; dc: number },
): void {
  if (!spell.area) return;
  const s = ctx.state;
  s.activeZones = s.activeZones ?? [];
  const tilesSet = tilesInArea(ctx, spell, tile);
  const tiles: Array<[number, number]> = Array.from(tilesSet).map((k) => {
    const [x, y] = k.split(',').map(Number);
    return [x, y] as [number, number];
  });
  const isSelfAnchored = spell.range === 'self';
  const origin = isSelfAnchored
    ? { x: s.player.tileX, y: s.player.tileY }
    : { x: tile.x, y: tile.y };
  const target = (spell.area.shape === 'cone' || spell.area.shape === 'line') && !isSelfAnchored
    ? { x: tile.x, y: tile.y }
    : isSelfAnchored
      ? { x: tile.x, y: tile.y }
      : undefined;
  const zone = {
    id: ctx.uid(),
    spellId: spell.id,
    name: spell.name,
    shape: spell.area.shape,
    sizeFeet: spell.area.sizeFeet,
    originX: origin.x,
    originY: origin.y,
    targetX: target?.x,
    targetY: target?.y,
    tiles,
    condition,
    enterSave,
    difficultTerrain: spell.zone?.difficultTerrain ?? false,
    affectedNpcIds: [] as string[],
    affectedPlayer: false,
    roundsRemaining: Math.max(1, spell.durationRounds ?? 10),
    casterId: 'player',
    tintHex,
  };
  // Concentration spells (Fog Cloud, Web, Darkness, Silent Image) sustain
  // only one instance at a time — recasting drops the prior. Non-
  // concentration ground zones (Grease, Minor Illusion) stack: each cast
  // pushes a new zone with its own duration timer and tile-set, so the
  // player can lay multiple patches of Grease across the map.
  if (spell.concentration) {
    s.activeZones = s.activeZones.filter((z) => !(z.spellId === spell.id && z.casterId === 'player'));
  }
  s.activeZones.push(zone);
}

/**
 * SRD Web-style enter-save: roll the zone's `enterSave` against a creature
 * that is standing in a zone tile and doesn't already carry the zone's
 * condition. Fires at the start of an NPC's turn (so "starts its turn there"
 * is covered) and after the player moves into a new tile. Caller is
 * responsible for skipping creatures that have already been checked this
 * turn (we lean on the "doesn't already carry" gate as a cheap idempotency
 * check — once Restrained you stay Restrained until you break free).
 */
export function tickZoneEnterSaves(ctx: GameContext, subjectId: 'player' | string): void {
  const s = ctx.state;
  if (!s.activeZones || s.activeZones.length === 0) return;
  const subject = subjectId === 'player'
    ? { tileX: s.player.tileX, tileY: s.player.tileY, conditions: s.player.conditions, displayName: ctx.playerDef.name, def: null as null, isPlayer: true as const }
    : (() => {
        const npc = s.npcs.find((n) => n.id === subjectId && n.hp > 0);
        if (!npc) return null;
        const def = ctx.resolveMonsterDef(npc.defId);
        return { tileX: npc.tileX, tileY: npc.tileY, conditions: npc.conditions, displayName: combatantDisplayName(npc, s.npcs), def, isPlayer: false as const, npc };
      })();
  if (!subject) return;
  for (const z of s.activeZones) {
    if (!z.enterSave || !z.condition) continue;
    const inside = new Set(z.tiles.map(([x, y]) => `${x},${y}`));
    if (!inside.has(`${subject.tileX},${subject.tileY}`)) continue;
    if (subject.conditions.includes(z.condition)) continue;
    const ability = z.enterSave.ability;
    const dc = z.enterSave.dc;
    let saveBonus: number;
    if (subject.isPlayer) {
      const abMod = mod(ctx.playerDef[ability]);
      const profBonus = ctx.playerDef.savingThrowProficiencies.includes(ability) ? ctx.playerDef.proficiencyBonus : 0;
      saveBonus = abMod + profBonus;
    } else {
      const def = subject.def;
      if (!def) continue;
      saveBonus = (def.savingThrows && def.savingThrows[ability] !== undefined) ? def.savingThrows[ability] : mod(def[ability]);
    }
    const roll = d20();
    const total = roll + saveBonus;
    const success = total >= dc;
    ctx.addLog({
      left: `${subject.displayName} ${success ? 'avoids' : 'is caught by'} ${z.name}`,
      right: `${ability.toUpperCase()} d20(${roll})+${saveBonus}=${total} vs DC ${dc}`,
      style: success ? 'normal' : 'status',
    });
    if (!success) {
      if (subject.isPlayer) {
        if (!s.player.conditions.includes(z.condition)) s.player.conditions.push(z.condition);
        z.affectedPlayer = true;
        // Caltrops-style Speed 0: halt the rest of this turn's movement so the
        // player can't keep walking through the hazard once snared.
        if (SPEED_ZERO_CONDITIONS.includes(z.condition)) s.player.movesLeft = 0;
        if (z.enterDamage) ctx.applyDamageToPlayer(z.enterDamage.amount, ctx.eventSink ?? []);
      } else {
        if (!subject.npc.conditions.includes(z.condition)) subject.npc.conditions.push(z.condition);
        if (!z.affectedNpcIds.includes(subject.npc.id)) z.affectedNpcIds.push(subject.npc.id);
        if (z.enterDamage) applyDamageToNpc(ctx, subject.npc, z.enterDamage.amount, z.enterDamage.type);
      }
    }
  }
}

/** Pure helper: strip every condition this zone applied from the creatures
 *  it touched (regardless of where they're now standing). Used by the zone-
 *  expiry, concentration-end, and Gust-of-Wind dispersal paths so a creature
 *  that was Restrained by Web doesn't carry the condition forever just
 *  because the engine couldn't observe a current overlap. */
function stripZoneAffectedConditions(ctx: GameContext, zone: { condition?: string; affectedNpcIds: string[]; affectedPlayer: boolean }): void {
  if (!zone.condition) return;
  const s = ctx.state;
  for (const id of zone.affectedNpcIds) {
    const npc = s.npcs.find((n) => n.id === id);
    if (!npc) continue;
    npc.conditions = npc.conditions.filter((c) => c !== zone.condition);
  }
  if (zone.affectedPlayer) {
    s.player.conditions = s.player.conditions.filter((c) => c !== zone.condition);
  }
}

/**
 * SRD Gust of Wind end-of-turn save. Walk every Gust zone the player is
 * sustaining; any creature ending its turn on a zone tile rolls a fresh
 * STR save against the original DC and is pushed 15 ft away from the
 * caster on a failure. The caster's `spellSaveDC` at cast time is the
 * authoritative DC; we recompute here to keep the function self-contained.
 *
 * Caller passes the subject id (`'player'` or an NPC id). Idempotent — a
 * creature pushed clear of the zone in this tick won't keep re-rolling.
 */
export function runGustOfWindEndOfTurnSaves(ctx: GameContext, subjectId: 'player' | string, events?: GameEvent[]): void {
  const s = ctx.state;
  if (!s.activeZones || s.activeZones.length === 0) return;
  const gustZones = s.activeZones.filter((z) => z.spellId === 'gust-of-wind');
  if (gustZones.length === 0) return;
  const dc = spellSaveDC(ctx);
  if (subjectId === 'player') {
    for (const z of gustZones) {
      const inside = new Set(z.tiles.map(([x, y]) => `${x},${y}`));
      if (!inside.has(`${s.player.tileX},${s.player.tileY}`)) continue;
      const abMod = mod(ctx.playerDef.str);
      const profBonus = ctx.playerDef.savingThrowProficiencies.includes('str') ? ctx.playerDef.proficiencyBonus : 0;
      const saveBonus = abMod + profBonus;
      const roll = d20();
      const total = roll + saveBonus;
      const success = total >= dc;
      ctx.addLog({
        left: `${ctx.playerDef.name} ${success ? 'braces against' : 'is shoved by'} the Gust of Wind`,
        right: `STR d20(${roll})+${saveBonus}=${total} vs DC ${dc}`,
        style: success ? 'normal' : 'status',
      });
      // No engine pushPlayerAway helper today — the SRD direction is "away
      // from caster", but the caster IS the player here, so any push is a
      // no-op. Log only.
    }
    return;
  }
  const npc = s.npcs.find((n) => n.id === subjectId && n.hp > 0);
  if (!npc) return;
  const def = ctx.resolveMonsterDef(npc.defId);
  if (!def) return;
  for (const z of gustZones) {
    const inside = new Set(z.tiles.map(([x, y]) => `${x},${y}`));
    if (!inside.has(`${npc.tileX},${npc.tileY}`)) continue;
    const saveBonus = (def.savingThrows && def.savingThrows['str'] !== undefined)
      ? def.savingThrows['str']
      : mod(def.str);
    const roll = d20();
    const total = roll + saveBonus;
    const success = total >= dc;
    ctx.addLog({
      left: `${combatantDisplayName(npc, s.npcs)} ${success ? 'braces against' : 'is shoved by'} the Gust of Wind`,
      right: `STR d20(${roll})+${saveBonus}=${total} vs DC ${dc}`,
      style: success ? 'normal' : 'status',
    });
    if (!success) pushNpcAway(ctx, npc, 15, events);
  }
}

/**
 * End-of-round tick. Decrement `roundsRemaining` on every active zone and
 * remove expired ones. When a zone expires, strip its `condition` from any
 * creature still standing inside its tile set — that's the only condition
 * source the zone owns, so creatures outside the cloud are unaffected.
 *
 * Called from `enterPlayerTurn` (one tick per combat round) and from
 * `WorldTick.runOffCameraTick` (one tick per 6-second real-time interval
 * during exploration). Both paths are idempotent under no-zones.
 */
export function tickActiveZones(ctx: GameContext): void {
  const s = ctx.state;
  if (!s.activeZones || s.activeZones.length === 0) return;
  const expired: typeof s.activeZones = [];
  const survived: typeof s.activeZones = [];
  for (const z of s.activeZones) {
    z.roundsRemaining -= 1;
    if (z.roundsRemaining <= 0) expired.push(z);
    else survived.push(z);
  }
  if (expired.length === 0) return;
  s.activeZones = survived;
  for (const z of expired) {
    stripZoneAffectedConditions(ctx, z);
    ctx.addLog({ left: `${z.name} fades`, style: 'status' });
  }
}

/**
 * Normalise `SpellEffect.onFail` (which the schema allows as either a single
 * string or an array of strings) to a plain list of condition names.
 */
function normaliseConditionList(value: string | string[] | undefined): string[] {
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
function onHitConditionNote(condition: string): string {
  return ON_HIT_CONDITION_NOTE[condition] ?? `is ${condition}`;
}

/**
 * Flavour line for a failed save. Recognises a handful of spells with
 * iconic narration; falls back to a generic "is &lt;condition&gt;" / "is affected"
 * for everything else.
 */
function conditionLogText(spell: SpellDef, conds: string[]): string {
  if (conds.length === 0) return 'is affected';
  if (spell.effect?.failNote) return spell.effect.failNote;
  return 'is ' + conds.join(' and ');
}

/**
 * SRD push effect (Thunderwave). Shoves `npc` `feet` feet directly away from
 * the caster, stopping at the first impassable tile or another creature.
 * One tile = 5 ft. No-op when the spell would push back into the caster.
 */
function pushNpcAway(ctx: GameContext, npc: NpcState, feet: number, events?: GameEvent[]): void {
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
    for (const c of conds) {
      if (!t.conditions.includes(c)) t.conditions.push(c);
    }
    // SRD Color Spray: "until the end of your next turn". Schedule the
    // condition strip via the existing ongoingEffects pipeline so the
    // end-of-player-turn tick in CombatFlow lifts it after two end-of-turn
    // hooks fire (this turn's end → 2→1, next turn's end → 1→0 → strip).
    if (spell.durationRounds === 1 && conds.length > 0) {
      t.ongoingEffects = t.ongoingEffects ?? [];
      for (const c of conds) {
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

/**
 * SRD Evoker Potent Cantrip — a damaging cantrip deals half damage on a
 * successful save instead of zero. Pure helper consumed by every save-
 * branch resolver below. When the spell isn't a cantrip with damage, or
 * the caster doesn't have Potent Cantrip, the rider doesn't kick in and
 * the normal `success && halfOnSuccess ? half : success ? 0 : full`
 * outcome wins.
 */
function damageAfterSave(
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
      const conds = !success ? normaliseConditionList(spell.effect.onFail) : [];
      for (const c of conds) {
        if (!target.conditions.includes(c)) target.conditions.push(c);
      }
      // On-success rider (same descriptor as the single-target path) — applied
      // without counting toward `anyAffected`, so a fully-saved AOE still won't
      // start concentration.
      if (success) {
        for (const c of normaliseConditionList(spell.effect.onSuccess)) {
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
    const conds = !success ? normaliseConditionList(spell.effect.onFail) : [];
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
      for (const c of normaliseConditionList(spell.effect.onSuccess)) {
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

function resolveUtilitySpell(ctx: GameContext, spell: SpellDef, slotLevel: number, tile?: { x: number; y: number }, targetIds?: string[], abilityChoice?: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha', damageTypeChoice?: string): void {
  // No roll; just narrate. Specific lasting effects (Mage Armor, Shield as
  // reaction) handled by spell-id switch — kept here, not as separate files,
  // since each is one-line semantic flag flips.
  const s = ctx.state;
  // Cast-time persistent zones (Fog Cloud, Darkness, Web) — data-driven from
  // `spell.zone`. Each tags creatures in the area (with or without a save) and
  // registers the visible zone for its duration. Ground-placeable zones
  // (Grease, Silent Image, …) are registered by the trailing block in
  // `doCastSpell` instead, so they fall through to the switch's narration.
  if (spell.zone?.castSave) {
    const cs = spell.zone.castSave;
    applyZoneSave(ctx, spell, tile, cs.ability, cs.condition, cs.label ?? cs.condition);
    if (spell.zone.enterSave) {
      const z = s.activeZones?.[s.activeZones.length - 1];
      if (z && z.spellId === spell.id) z.enterSave = { ability: spell.zone.enterSave.ability, dc: spellSaveDC(ctx) };
    }
    return;
  }
  if (spell.zone?.castCondition) {
    applyZoneCondition(ctx, spell, tile, spell.zone.castCondition, spell.zone.castLabel ?? spell.zone.castCondition, spell.zone.tintHex);
    return;
  }
  switch (spell.id) {
    // ── Self-buff primitives (US-065 buff layer) ──────────────────────────────
    // Bless: +1d4 to the caster's attack rolls and saving throws.
    case 'bless':
      applySelfBuff(ctx, { spellId: 'bless', modifiers: [{ type: 'dice-bonus', on: 'attack', count: 1, sides: 4 }, { type: 'dice-bonus', on: 'save', count: 1, sides: 4 }], concentration: true });
      ctx.addLog({ left: `${ctx.playerDef.name} is blessed — +1d4 to attack rolls and saves`, style: 'status' });
      return;
    // Guidance: +1d4 to the caster's ability checks.
    case 'guidance':
      applySelfBuff(ctx, { spellId: 'guidance', modifiers: [{ type: 'dice-bonus', on: 'check', count: 1, sides: 4 }], concentration: true });
      ctx.addLog({ left: `${ctx.playerDef.name} channels Guidance — +1d4 to ability checks`, style: 'status' });
      return;
    // Shield of Faith: +2 AC.
    case 'shield-of-faith':
      applySelfBuff(ctx, { spellId: 'shield-of-faith', modifiers: [{ type: 'ac-bonus', value: 2 }], concentration: true });
      ctx.addLog({ left: `${ctx.playerDef.name} is warded — +2 AC (now ${ctx.state.player.ac})`, style: 'status' });
      return;
    // Haste: +2 AC, Advantage on DEX saves, doubled Speed (the extra action is
    // descriptive). Speed doubling is modelled as a +base-speed bonus.
    case 'haste':
      applySelfBuff(ctx, { spellId: 'haste', modifiers: [{ type: 'ac-bonus', value: 2 }, { type: 'advantage', on: 'save', key: 'dex' }, { type: 'speed-bonus', value: ctx.playerDef.speed }], concentration: true });
      ctx.addLog({ left: `${ctx.playerDef.name} is hasted — +2 AC, doubled Speed, Advantage on DEX saves`, style: 'status' });
      return;
    // Beacon of Hope: Advantage on WIS saves (the death-save advantage + max
    // healing riders are descriptive until those paths consume buffs).
    case 'beacon-of-hope':
      applySelfBuff(ctx, { spellId: 'beacon-of-hope', modifiers: [{ type: 'advantage', on: 'save', key: 'wis' }], concentration: true });
      ctx.addLog({ left: `${ctx.playerDef.name} radiates hope — Advantage on Wisdom saves`, style: 'status' });
      return;
    // Aid: raise the caster's HP maximum and current HP by 5 (+5 per slot level
    // above 2) for the duration. Implemented by directly raising the session
    // `playerDef.maxHp` (which every HP read site consumes) and current HP; the
    // bonus is recorded on the buff so a Long Rest reverses it exactly.
    case 'aid': {
      const amt = 5 + 5 * Math.max(0, slotLevel - 2);
      ctx.playerDef.maxHp += amt;
      s.player.hp += amt;
      applySelfBuff(ctx, { spellId: 'aid', modifiers: [{ type: 'max-hp', value: amt }] });
      ctx.addLog({ left: `${ctx.playerDef.name} is bolstered by Aid — +${amt} HP maximum (now ${s.player.hp}/${ctx.playerDef.maxHp})`, style: 'heal' });
      return;
    }
    // Resistance (cantrip): reduce damage of one chosen type by 1d4.
    case 'resistance': {
      const dt = (spell.damageTypeChoices?.includes(damageTypeChoice ?? '') ? damageTypeChoice : spell.damageTypeChoices?.[0]) ?? 'fire';
      applySelfBuff(ctx, { spellId: 'resistance', modifiers: [{ type: 'damage-reduction', damageType: dt, count: 1, sides: 4 }], concentration: true });
      ctx.addLog({ left: `${ctx.playerDef.name} is warded against ${dt} — reduce that damage by 1d4`, style: 'status' });
      return;
    }
    // Protection from Energy: Resistance to one chosen damage type for the
    // duration. The damage-type picker rides on `damageTypeChoice`.
    case 'protection-from-energy': {
      const dt = (spell.damageTypeChoices?.includes(damageTypeChoice ?? '') ? damageTypeChoice : spell.damageTypeChoices?.[0]) ?? 'fire';
      applySelfBuff(ctx, { spellId: 'protection-from-energy', modifiers: [{ type: 'resistance', damageType: dt }], concentration: true });
      ctx.addLog({ left: `${ctx.playerDef.name} is warded against ${dt} — Resistance for the duration`, style: 'status' });
      return;
    }
    case 'mage-armor':
      // Self/touch: target self (the only valid target without an ally system).
      if (s.player.equippedSlots.armorId) {
        ctx.addLog({ left: `Mage Armor fizzles — already wearing armor`, style: 'miss' });
        return;
      }
      // Recorded as a self-buff (`mage-armor` flag) → `recomputeBuffs` derives
      // `mageArmor` and rebuilds AC (base 13 + DEX). Donning armor or losing the
      // buff resets it. Persisted across resume by re-seeding the buff.
      applySelfBuff(ctx, { spellId: 'mage-armor', modifiers: [{ type: 'flag', name: 'mage-armor' }] });
      ctx.addLog({ left: `${ctx.playerDef.name} casts Mage Armor — AC ${ctx.playerDef.ac} for 8 hours`, style: 'status' });
      break;
    case 'detect-magic': {
      // Sense magical auras: flag magic items held or lying within 30 ft (6
      // tiles). Surfaces an aura in the inventory + on the map even while the
      // item is unidentified — knowing a thing is magical isn't knowing what it
      // does (that's Identify).
      const p = ctx.state.player;
      const detected = new Set(p.magicDetectedItemIds ?? []);
      const present = new Set<string>();
      const consider = (id: string): void => {
        const it = ctx.defs.equipment.find((i) => i.id === id) as { magic?: boolean } | undefined;
        if (it?.magic) { present.add(id); detected.add(id); }
      };
      for (const id of new Set(p.inventoryIds ?? [])) consider(id);
      for (const mi of ctx.state.mapItems ?? []) {
        if (chebyshev(p.tileX, p.tileY, mi.tileX, mi.tileY) <= 6) consider(mi.defId);
      }
      p.magicDetectedItemIds = [...detected];
      ctx.addLog({
        left: `${ctx.playerDef.name} casts Detect Magic — ${present.size ? `senses magic on ${present.size} item${present.size > 1 ? 's' : ''} nearby` : 'senses no magic nearby'}`,
        style: 'status',
      });
      break;
    }
    case 'identify': {
      // Identify the held unidentified items, revealing their true name and
      // properties. (SRD targets one item; we resolve all held unidentified
      // items per cast for simplicity — no per-item target picker.)
      const p = ctx.state.player;
      p.identifiedItemIds = p.identifiedItemIds ?? [];
      const named: string[] = [];
      for (const id of new Set(p.inventoryIds ?? [])) {
        const it = ctx.defs.equipment.find((i) => i.id === id) as { id: string; name: string; startsUnidentified?: boolean } | undefined;
        if (it?.startsUnidentified && !p.identifiedItemIds.includes(id)) {
          p.identifiedItemIds.push(id);
          named.push(it.name);
        }
      }
      if (named.length) {
        p.equippedSlotLabels = computeEquippedSlotLabels(ctx.playerDef, p.equippedSlots, ctx.defs.equipment);
        ctx.addLog({ left: `${ctx.playerDef.name} casts Identify — learns the properties of ${named.join(', ')}.`, style: 'status' });
      } else {
        ctx.addLog({ left: `${ctx.playerDef.name} casts Identify — nothing carried is unidentified.`, style: 'status' });
      }
      break;
    }
    // ── Cure / restore / dispel (US — Bucket 4 utility resolvers) ─────────────
    // Lesser Restoration: end one condition (Blinded, Deafened, Paralyzed, or
    // Poisoned) on the caster or a touched creature. The SRD lets the caster
    // pick; with no condition-picker plumbed we end the most debilitating one
    // present, in priority order. `targetIds[0] === 'player'` is the self-cast.
    case 'lesser-restoration': {
      const LESSER_RESTORE_ORDER = ['paralyzed', 'poisoned', 'blinded', 'deafened'];
      const targetId = targetIds?.[0] ?? s.selectedTargetId ?? 'player';
      const onSelf = targetId === 'player';
      const conds = onSelf ? s.player.conditions : (s.npcs.find((n) => n.id === targetId)?.conditions);
      if (!conds) { ctx.addLog({ left: `Lesser Restoration: no valid target.`, style: 'miss' }); break; }
      const who = onSelf ? ctx.playerDef.name : combatantDisplayName(s.npcs.find((n) => n.id === targetId)!, s.npcs);
      const removed = LESSER_RESTORE_ORDER.find((c) => conds.includes(c));
      if (removed) {
        if (onSelf) s.player.conditions = conds.filter((c) => c !== removed);
        else s.npcs.find((n) => n.id === targetId)!.conditions = conds.filter((c) => c !== removed);
        ctx.addLog({ left: `${ctx.playerDef.name} casts Lesser Restoration — ${who}'s ${removed} condition ends.`, style: 'heal' });
      } else {
        ctx.addLog({ left: `Lesser Restoration finds no Blinded/Deafened/Paralyzed/Poisoned condition on ${who} to end.`, style: 'miss' });
      }
      break;
    }
    // Spare the Dying: stabilise a creature at 0 HP (cast on a downed ally, not
    // the unconscious caster — the player can't act at 0 HP). Adds Stable so
    // the creature stops sliding toward death.
    case 'spare-the-dying': {
      const targetId = targetIds?.[0] ?? s.selectedTargetId;
      const npc = targetId && targetId !== 'player' ? s.npcs.find((n) => n.id === targetId) : undefined;
      if (!npc) { ctx.addLog({ left: `Spare the Dying: choose a creature at 0 HP within range.`, style: 'miss' }); break; }
      if (npc.hp > 0) { ctx.addLog({ left: `${combatantDisplayName(npc, s.npcs)} isn't dying.`, style: 'miss' }); break; }
      if (!npc.conditions.includes('stable')) npc.conditions.push('stable');
      ctx.addLog({ left: `${ctx.playerDef.name} casts Spare the Dying — ${combatantDisplayName(npc, s.npcs)} is stabilised.`, style: 'heal' });
      break;
    }
    // Dispel Magic: end the spell effects on a creature. Strips the spell-layer
    // magic the engine tracks — active buffs (Bless, Haste, …), and the
    // duration-bound conditions recorded as `spell-condition` ongoing effects
    // (Color Spray's Blinded, …). Level-gating (DC 10 + spell level for spells
    // above 3rd) is descriptive — every on-board effect here is ≤ the slot
    // level it's worth dispelling.
    case 'dispel-magic': {
      const targetId = targetIds?.[0] ?? s.selectedTargetId;
      const npc = targetId && targetId !== 'player' ? s.npcs.find((n) => n.id === targetId) : undefined;
      if (!npc) { ctx.addLog({ left: `Dispel Magic: choose a creature carrying a spell effect.`, style: 'miss' }); break; }
      let dispelled = 0;
      for (const sid of new Set((npc.activeBuffs ?? []).map((b) => b.spellId))) {
        if (removeSpellBuffsFrom(npc, sid)) dispelled++;
      }
      const ongoing = (npc.ongoingEffects ?? []).filter((oe) => oe.kind === 'spell-condition');
      for (const oe of ongoing) {
        npc.conditions = npc.conditions.filter((c) => c !== oe.condition);
        dispelled++;
      }
      npc.ongoingEffects = (npc.ongoingEffects ?? []).filter((oe) => oe.kind !== 'spell-condition');
      ctx.addLog({
        left: dispelled > 0
          ? `${ctx.playerDef.name} casts Dispel Magic — ${dispelled} effect${dispelled > 1 ? 's' : ''} on ${combatantDisplayName(npc, s.npcs)} ${dispelled > 1 ? 'end' : 'ends'}.`
          : `${ctx.playerDef.name} casts Dispel Magic — no dispellable magic on ${combatantDisplayName(npc, s.npcs)}.`,
        style: dispelled > 0 ? 'status' : 'miss',
      });
      break;
    }
    // Protection from Poison: end Poisoned on the target and (for the caster)
    // grant Resistance to Poison damage for the duration. Routed through the
    // self-buff layer like Protection from Energy; an ally target gets the
    // Poisoned cure (the buff layer is caster-centred, so ally resistance is
    // descriptive).
    case 'protection-from-poison': {
      const targetId = targetIds?.[0] ?? s.selectedTargetId ?? 'player';
      const onSelf = targetId === 'player';
      if (onSelf) {
        s.player.conditions = s.player.conditions.filter((c) => c !== 'poisoned');
        applySelfBuff(ctx, { spellId: 'protection-from-poison', modifiers: [{ type: 'resistance', damageType: 'poison' }] });
        ctx.addLog({ left: `${ctx.playerDef.name} casts Protection from Poison — Poisoned ends, Resistance to poison for the duration.`, style: 'status' });
      } else {
        const npc = s.npcs.find((n) => n.id === targetId);
        if (!npc) { ctx.addLog({ left: `Protection from Poison: no valid target.`, style: 'miss' }); break; }
        npc.conditions = npc.conditions.filter((c) => c !== 'poisoned');
        ctx.addLog({ left: `${ctx.playerDef.name} casts Protection from Poison on ${combatantDisplayName(npc, s.npcs)} — Poisoned ends.`, style: 'status' });
      }
      break;
    }
    // Sanctuary: ward a creature (self or ally). Recorded as a `sanctuary`
    // condition the enemy target-picker reads — an attacker must make a Wis
    // save to target the warded creature. The ward ends when the warded
    // creature attacks or casts at a foe (stripped in `doAttack` / the
    // aggressive-cast path); the 1-minute duration expiry is descriptive.
    case 'sanctuary': {
      const targetId = targetIds?.[0] ?? s.selectedTargetId ?? 'player';
      if (targetId === 'player') {
        if (!s.player.conditions.includes('sanctuary')) s.player.conditions.push('sanctuary');
        ctx.addLog({ left: `${ctx.playerDef.name} casts Sanctuary — warded until they strike or cast at a foe.`, style: 'status' });
      } else {
        const npc = s.npcs.find((n) => n.id === targetId);
        if (!npc) { ctx.addLog({ left: `Sanctuary: no valid target.`, style: 'miss' }); break; }
        if (!npc.conditions.includes('sanctuary')) npc.conditions.push('sanctuary');
        ctx.addLog({ left: `${ctx.playerDef.name} casts Sanctuary on ${combatantDisplayName(npc, s.npcs)} — warded against attacks.`, style: 'status' });
      }
      break;
    }
    // Remove Curse: end the Cursed condition (Bestow Curse, cursed items) on
    // the caster or a touched creature.
    case 'remove-curse': {
      const targetId = targetIds?.[0] ?? s.selectedTargetId ?? 'player';
      const onSelf = targetId === 'player';
      const conds = onSelf ? s.player.conditions : s.npcs.find((n) => n.id === targetId)?.conditions;
      if (!conds) { ctx.addLog({ left: `Remove Curse: no valid target.`, style: 'miss' }); break; }
      const who = onSelf ? ctx.playerDef.name : combatantDisplayName(s.npcs.find((n) => n.id === targetId)!, s.npcs);
      if (conds.includes('cursed')) {
        if (onSelf) s.player.conditions = conds.filter((c) => c !== 'cursed');
        else s.npcs.find((n) => n.id === targetId)!.conditions = conds.filter((c) => c !== 'cursed');
        ctx.addLog({ left: `${ctx.playerDef.name} casts Remove Curse — the curse on ${who} lifts.`, style: 'status' });
      } else {
        ctx.addLog({ left: `Remove Curse finds no curse on ${who} to lift.`, style: 'miss' });
      }
      break;
    }
    // Blink: self-buff flag. At the end of each of the caster's turns
    // (`endPlayerTurn`) a 1d6 roll of 4-6 phases them to the Ethereal Plane
    // (`ethereal` condition → untargetable) until the start of their next turn.
    case 'blink':
      applySelfBuff(ctx, { spellId: 'blink', modifiers: [{ type: 'flag', name: 'blink' }] });
      ctx.addLog({ left: `${ctx.playerDef.name} casts Blink — flickering half-here, half-away.`, style: 'status' });
      break;
    case 'feather-fall':
      ctx.addLog({ left: `${ctx.playerDef.name} casts Feather Fall`, style: 'status' });
      break;
    case 'shield':
      // Shield is a reaction interrupt — handled in ReactionSystem; if the
      // player triggers it through the CAST button outside that flow, log a no-op.
      ctx.addLog({ left: `Shield can only be cast as a Reaction to an incoming attack`, style: 'miss' });
      break;
    case 'false-life': {
      // Temporary HP grant. SRD: gain `1d4 + 4` temp HP for the duration.
      // `awardTempHp` already implements the higher-of-two rule, so casters
      // re-rolling within the window simply keep whichever roll was better.
      if (!spell.tempHpRoll) break;
      const { dice, sides, bonus = 0 } = spell.tempHpRoll;
      const roll = rollDamage(dice, sides, bonus);
      s.player.tempHp = Math.max(s.player.tempHp, roll.total);
      ctx.addLog({
        left: `${ctx.playerDef.name} casts ${spell.name} — +${roll.total} Temp HP (now ${s.player.tempHp})`,
        right: `${dice}d${sides}+${bonus}[${roll.rolls.join(',')}]=${roll.total}`,
        style: 'status',
      });
      break;
    }
    case 'longstrider': {
      // SRD: +10 ft speed for the duration. Recorded as a self-buff
      // (`speed-bonus` modifier) → `recomputeBuffs` derives `speedBonus`. When
      // cast mid-turn, also bump `movesLeft` by the new ft difference so the
      // player can spend the extra tiles this turn.
      const prevBonus = s.player.speedBonus;
      applySelfBuff(ctx, { spellId: 'longstrider', modifiers: [{ type: 'speed-bonus', value: 10 }] });
      if (s.phase === 'player_turn') {
        const deltaTiles = Math.floor((s.player.speedBonus - prevBonus) / 5);
        if (deltaTiles > 0) s.player.movesLeft += deltaTiles;
      }
      ctx.addLog({ left: `${ctx.playerDef.name} casts Longstrider — Speed +10 ft for 1 hour`, style: 'status' });
      break;
    }
    case 'expeditious-retreat': {
      // SRD: cast as bonus action; you Dash this turn and may Dash as a bonus
      // action on each subsequent turn. The `expeditious-retreat` flag (which
      // CombatFlow reads to grant the per-turn Dash) is derived from the active
      // buff by `recomputeBuffs`, so concentration-end cleanup is generic. We
      // still grant the upfront Dash immediately (adds `speed/5` extra tiles).
      applySelfBuff(ctx, { spellId: spell.id, modifiers: [{ type: 'flag', name: 'expeditious-retreat' }], concentration: true });
      if (s.phase === 'player_turn') {
        s.player.movesLeft += Math.floor((ctx.playerDef.speed + s.player.speedBonus) / 5);
      }
      ctx.addLog({ left: `${ctx.playerDef.name} casts Expeditious Retreat — Dash this turn and as a bonus action each round`, style: 'status' });
      break;
    }
    case 'jump':
      // SRD: triple jump distance for the duration. The engine doesn't model
      // jump distance per-tile yet — we surface the multiplier on PlayerState
      // so future jump-check code can read it.
      s.player.jumpMultiplier = 3;
      ctx.addLog({ left: `${ctx.playerDef.name} casts Jump — jump distance ×3 for 1 minute`, style: 'status' });
      break;
    case 'magic-weapon': {
      // SRD: +1 to attack and damage with a touched nonmagical weapon for
      // 1 hour. Higher-level upcasts grant +2 (L3-5) or +3 (L6+). The
      // bonus rides on PlayerAttack via applyEquipment.
      const bonus = slotLevel >= 6 ? 3 : slotLevel >= 3 ? 2 : 1;
      // Self-buff (`weapon-bonus` modifier) → `recomputeBuffs` derives
      // `magicWeaponBonus` and rebuilds the attack; concentration end removes it.
      applySelfBuff(ctx, { spellId: 'magic-weapon', modifiers: [{ type: 'weapon-bonus', value: bonus }], concentration: true });
      ctx.addLog({ left: `${ctx.playerDef.name} casts Magic Weapon — +${bonus} to attack and damage for 1 hour`, style: 'status' });
      break;
    }
    case 'see-invisibility':
      // SRD: see invisible creatures and the Ethereal Plane for 1 hour.
      // Self-buff `flag` → `recomputeBuffs` derives `seeInvisible`.
      applySelfBuff(ctx, { spellId: 'see-invisibility', modifiers: [{ type: 'flag', name: 'see-invisible' }] });
      ctx.addLog({ left: `${ctx.playerDef.name} casts See Invisibility — sees Invisible creatures for 1 hour`, style: 'status' });
      break;
    case 'darkvision':
      // SRD: target gains Darkvision 150 ft for 8 hours. Touch-self in our
      // single-character implementation. Writes to playerDef.senses so the
      // Vision module's effective-PP calculations factor it in.
      if (!ctx.playerDef.senses) ctx.playerDef.senses = {};
      ctx.playerDef.senses.darkvision = Math.max(ctx.playerDef.senses.darkvision ?? 0, 150);
      ctx.addLog({ left: `${ctx.playerDef.name} casts Darkvision — Darkvision 150 ft for 8 hours`, style: 'status' });
      break;
    case 'blur':
      // SRD: attackers have Disadvantage on attack rolls against you
      // (Concentration). Self-buff records the `blurred` condition; the generic
      // `removeBuffsForSpell` in endConcentration strips it when the spell ends.
      applySelfBuff(ctx, { spellId: 'blur', conditions: ['blurred'], concentration: true });
      ctx.addLog({ left: `${ctx.playerDef.name} casts Blur — attackers have Disadvantage`, style: 'status' });
      break;
    case 'mirror-image': {
      // SRD: three illusory duplicates appear in your space. Recorded as a buff
      // with `charges: 3`; `recomputeBuffs` derives `mirrorImages`, and the
      // damage path (CombatFlow) decrements the buff's charges per absorbed hit,
      // removing the buff at 0. Re-casting replaces the buff (refreshes to 3).
      applySelfBuff(ctx, { spellId: 'mirror-image', charges: 3 });
      ctx.addLog({ left: `${ctx.playerDef.name} casts Mirror Image — three duplicates shimmer into being`, style: 'status' });
      break;
    }
    case 'invisibility': {
      // SRD: a creature you touch has the Invisible condition until the
      // spell ends. Ends early when the target makes an attack roll, deals
      // damage, or casts a spell. Concentration up to 1 hour.
      // Target is `targetIds[0]` (NPC) or the caster (self-cast → empty
      // targetIds). The caster's `invisibilityTargetId` is set so the
      // attack-resolution paths know which creature to watch for the
      // end-on-attack trigger; concentration end strips the condition and
      // clears the field.
      // The buff (carrying the `invisible` condition) lives on whichever
      // creature is the recipient — the player (self-cast) or an NPC. The
      // creature-agnostic store handles both; `endConcentration` strips it from
      // the right host. `invisibilityTargetId` stays as the pointer the
      // end-on-attack triggers watch.
      const tid = targetIds?.[0];
      if (tid) {
        const target = s.npcs.find((n) => n.id === tid && n.hp > 0);
        if (!target) { ctx.addLog({ left: `${spell.name}: invalid target`, style: 'miss' }); break; }
        applyBuffTo(target, { spellId: 'invisibility', conditions: ['invisible'], concentration: true });
        s.player.invisibilityTargetId = target.id;
        ctx.addLog({ left: `${ctx.playerDef.name} casts Invisibility on ${target.revealedName ?? target.name}`, style: 'status' });
        logInvisibilityFind(ctx, applyInvisibilityConcealment(ctx, target.id), target.revealedName ?? target.name);
      } else {
        applySelfBuff(ctx, { spellId: 'invisibility', conditions: ['invisible'], concentration: true });
        s.player.invisibilityTargetId = 'player';
        ctx.addLog({ left: `${ctx.playerDef.name} casts Invisibility on themselves — they vanish`, style: 'status' });
        logInvisibilityFind(ctx, applyInvisibilityConcealment(ctx, 'player'), ctx.playerDef.name);
      }
      break;
    }
    case 'misty-step': {
      // SRD: bonus action, teleport up to 30 ft to an unoccupied tile you
      // can see. We validate range (Chebyshev distance ≤ rangeFeet/5),
      // passability (the target tile must be passable), and that the tile
      // is not occupied by another creature. Failures abort the cast
      // BEFORE consumeCastingResources has returned — but at this point the
      // bonus action is already spent. We log the failure and return; the
      // bonus action remains spent as the SRD penalty for an aborted cast.
      if (!spell.selfTeleport) { ctx.addLog({ left: `${spell.name} is missing selfTeleport metadata`, style: 'miss' }); break; }
      if (!tile) { ctx.addLog({ left: `${spell.name}: no target tile`, style: 'miss' }); break; }
      const rangeTiles = Math.max(1, Math.ceil(spell.selfTeleport.rangeFeet / 5));
      const dx = Math.abs(tile.x - s.player.tileX);
      const dy = Math.abs(tile.y - s.player.tileY);
      if (Math.max(dx, dy) > rangeTiles) {
        ctx.addLog({ left: `${spell.name} — destination is out of range (${spell.selfTeleport.rangeFeet} ft)`, style: 'miss' });
        break;
      }
      const { cols, rows, blocksMovement } = s.map;
      if (tile.x < 0 || tile.x >= cols || tile.y < 0 || tile.y >= rows || blocksMovement[tile.y][tile.x]) {
        ctx.addLog({ left: `${spell.name} — destination is impassable`, style: 'miss' });
        break;
      }
      const occupied = s.npcs.some((n) => n.hp > 0 && n.tileX === tile.x && n.tileY === tile.y);
      if (occupied) {
        ctx.addLog({ left: `${spell.name} — destination is occupied`, style: 'miss' });
        break;
      }
      const fromX = s.player.tileX;
      const fromY = s.player.tileY;
      s.player.tileX = tile.x;
      s.player.tileY = tile.y;
      ctx.addLog({
        left: `${ctx.playerDef.name} teleports — (${fromX},${fromY}) → (${tile.x},${tile.y})`,
        style: 'status',
      });
      break;
    }
    case 'enhance-ability': {
      // SRD: touch a willing creature, choose Bear's Endurance / Bull's
      // Strength / Cat's Grace / Eagle's Splendor / Fox's Cunning /
      // Owl's Wisdom. The chosen creature gains Advantage on ability
      // checks of the corresponding ability score for the duration.
      // Single-character implementation: self-target only. The
      // `enhanced-ability` modifier is projected onto `s.player.enhancedAbility`
      // by `recomputeBuffs` (which `rollAbilityCheck` reads), and concentration
      // end clears it generically via `removeBuffsForSpell`. The ability pick
      // rides on the cast action's `abilityChoice`; defaults to STR if missing.
      const pick = abilityChoice ?? spell.abilityChoices?.[0] ?? 'str';
      applySelfBuff(ctx, { spellId: spell.id, modifiers: [{ type: 'enhanced-ability', ability: pick }], concentration: true });
      const variant = ENHANCE_ABILITY_VARIANTS[pick] ?? pick.toUpperCase();
      ctx.addLog({ left: `${ctx.playerDef.name} casts Enhance Ability (${variant}) — Advantage on ${pick.toUpperCase()} ability checks`, style: 'status' });
      break;
    }
    default:
      ctx.addLog({ left: `${ctx.playerDef.name} casts ${spell.name}`, style: 'status' });
  }
}

/** SRD Enhance Ability — per-ability flavour names for the log line. */
const ENHANCE_ABILITY_VARIANTS: Record<string, string> = {
  str: "Bull's Strength",
  dex: "Cat's Grace",
  con: "Bear's Endurance",
  int: "Fox's Cunning",
  wis: "Owl's Wisdom",
  cha: "Eagle's Splendor",
};

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

/**
 * Resolve a player spell cast. Validates eligibility, consumes resources,
 * dispatches to the right resolution branch based on the spell's JSON shape.
 */
/**
 * US-124 — use a Spell Scroll from inventory. Resolves the scroll's spell and
 * casts it via the scroll path (no slot; scroll consumed). Targeting reuses the
 * normal resolver: attack / auto-hit spells fall back to the selected target,
 * self / utility spells need none. (AOE-tile scrolls that need a chosen tile
 * are not yet supported by this no-prompt path.)
 */
/**
 * SRD Enlarge/Reduce — dual-mode. The target's disposition picks the mode:
 *   • self or ally → ENLARGE: grow to Large, Advantage on STR checks (via
 *     `enhanced-ability`) and STR saves, +1d4 weapon damage (`weapon-damage-dice`).
 *     Applied as a self-buff for the caster; an ally target is marked `enlarged`
 *     (the +1d4 only flows through the player's own attacks, so the ally case is
 *     largely descriptive).
 *   • enemy → REDUCE: unwilling, so a CON save negates; on a fail the creature
 *     gains the `reduced` condition → its weapon hits deal 1d4 less
 *     (`npcReducedPenalty`). STR-save Disadvantage is descriptive.
 * Concentration is started only when the spell actually lands. The `reduced` /
 * `enlarged` conditions are stripped on Concentration-end via the spell's
 * `effect.onFail` cleanup list; the caster's self-buff is dropped by the
 * generic buff cleanup.
 */
function castEnlargeReduce(ctx: GameContext, spell: SpellDef, targetIds: string[] | undefined): void {
  const s = ctx.state;
  const targetId = targetIds?.[0] ?? s.selectedTargetId ?? 'player';
  const onSelf = targetId === 'player';
  const npc = !onSelf ? s.npcs.find((n) => n.id === targetId && n.hp > 0) : undefined;
  if (!onSelf && !npc) { ctx.addLog({ left: `Enlarge/Reduce: no valid target.`, style: 'miss' }); return; }

  const tx = onSelf ? s.player.tileX : npc!.tileX;
  const ty = onSelf ? s.player.tileY : npc!.tileY;
  if (chebyshev(s.player.tileX, s.player.tileY, tx, ty) > Math.max(1, Math.ceil(spell.rangeFeet / 5))) {
    ctx.addLog({ left: `Enlarge/Reduce: target out of range.`, style: 'miss' });
    return;
  }

  const enlarge = onSelf || npc!.disposition === 'ally';
  if (enlarge && onSelf) {
    applySelfBuff(ctx, {
      spellId: 'enlarge-reduce', concentration: true, modifiers: [
        { type: 'size', size: 'large' },
        { type: 'enhanced-ability', ability: 'str' },
        { type: 'advantage', on: 'save', key: 'str' },
        { type: 'weapon-damage-dice', count: 1, sides: 4 },
      ],
    });
    ctx.addLog({ left: `${ctx.playerDef.name} casts Enlarge — grows to Large: Advantage on STR checks & saves, +1d4 weapon damage.`, style: 'status' });
    startConcentration(ctx, 'enlarge-reduce');
  } else if (enlarge) {
    if (!npc!.conditions.includes('enlarged')) npc!.conditions.push('enlarged');
    ctx.addLog({ left: `${ctx.playerDef.name} casts Enlarge on ${combatantDisplayName(npc!, s.npcs)} — it grows to Large.`, style: 'status' });
    startConcentration(ctx, 'enlarge-reduce');
  } else {
    const def = ctx.resolveMonsterDef(npc!.defId);
    if (!def) return;
    const dc = spellSaveDC(ctx);
    const saveMod = (def.savingThrows && def.savingThrows.con !== undefined) ? def.savingThrows.con : mod(def.con);
    const roll = d20();
    const total = roll + saveMod;
    const success = total >= dc;
    ctx.addLog({
      left: `${combatantDisplayName(npc!, s.npcs)} ${success ? 'resists Reduce' : 'is reduced — weapons hit for 1d4 less'}`,
      right: `CON d20(${roll})+${saveMod}=${total} vs DC ${dc}`,
      style: success ? 'normal' : 'status',
    });
    if (!success) {
      if (!npc!.conditions.includes('reduced')) npc!.conditions.push('reduced');
      startConcentration(ctx, 'enlarge-reduce');
    }
  }
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
