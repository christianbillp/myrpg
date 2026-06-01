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
import { d, d20, mod } from './Dice.js';
import { chebyshev } from './EnemyAI.js';
import { canCastSpell } from './ActionGuards.js';
import { startConcentration } from './ConcentrationSystem.js';
import { applyEquipment } from './EquipmentSystem.js';
import { publishNpcDamage } from './ThresholdPublisher.js';
import { combatantDisplayName } from './CombatFlow.js';
import { emitNoise, NOISE_SPELL_VERBAL } from './Sound.js';
import { canSee as visCanSee } from './Vision.js';

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
function spellMod(ctx: GameContext): number {
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

function npcSaveMod(target: NpcState, def: MonsterDef, ability: string): number {
  // Use the monster's saving throw map if present; otherwise raw ability mod.
  if (def.savingThrows && def.savingThrows[ability] !== undefined) return def.savingThrows[ability];
  const score = (def as unknown as Record<string, number>)[ability];
  return typeof score === 'number' ? mod(score) : 0;
}

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
  target.hp = Math.max(0, target.hp - finalDamage);
  publishNpcDamage(ctx, target, hpBefore, target.hp);
  if (target.hp <= 0) ctx.killWithReward(target, def, `☠ ${combatantDisplayName(target, ctx.state.npcs)} is slain!`);
}

// ── Action-economy + slot consumption ────────────────────────────────────────

function consumeCastingResources(ctx: GameContext, spell: SpellDef, slotLevel: number, asRitual: boolean): void {
  const s = ctx.state;
  // Ritual casts don't consume a spell slot (SRD: the spell is cast over 10
  // minutes from the spellbook). They also don't spend the action/bonus
  // action — they're a fictional time cost, only legal out of combat.
  if (asRitual) return;
  if (spell.level > 0) {
    s.player.spellSlots[spell.level - 1] = Math.max(0, (s.player.spellSlots[spell.level - 1] ?? 0) - 1);
  }
  // We don't gate by slotLevel here — the picker passes spell.level by default;
  // upcast support is wired in but not yet exposed by the UI.
  if (s.phase === 'player_turn') {
    switch (spell.castingTime) {
      case 'action':       s.player.actionUsed = true; break;
      case 'bonus-action': s.player.bonusActionUsed = true; break;
      case 'reaction':     s.player.reactionUsed = true; break;
    }
  }
  void slotLevel;
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
  const effectiveAc = def.ac + coverAcBonus;

  const bonus = spellAttackBonus(ctx);
  // Shocking Grasp grants Advantage if the target wears metal armor. The
  // engine doesn't model armor material yet, so we surface this only when
  // explicitly enabled. Other callers may pass options.advantage too.
  const r1 = d20();
  const r2 = options?.advantage ? d20() : r1;
  const roll = options?.advantage ? Math.max(r1, r2) : r1;
  const isCrit = roll === 20;
  const total = roll + bonus;
  const hit = isCrit || (roll !== 1 && total >= effectiveAc);
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
    if (spell.level === 0 && spell.damage && ctx.playerDef.defaultFeatureIds?.includes('potent-cantrip')) {
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
  const { total: dmg, rolls } = rollDamage(dice, spell.damage.sides, spell.damage.bonus ?? 0);

  ctx.addLog({
    left: `${ctx.playerDef.name} casts ${spell.name}${chainNote} — ${isCrit ? 'CRIT' : 'hit'}, ${dmg} ${spell.damage.type}`,
    right: `d20(${roll})+${bonus}=${total} vs AC ${effectiveAc}${coverNote}${advNote} · ${dice}d${spell.damage.sides}[${rolls.join(',')}]`,
    style: isCrit ? 'crit' : 'hit',
  });
  applyDamageToNpc(ctx, target, dmg, spell.damage.type);

  // Riders — engine-side recognition by spell id, kept short to avoid
  // sprawling per-spell logic. Suppressed when this resolution is itself a
  // follow-up (e.g. a chain hop) to avoid stacking the same rider twice.
  if (!options?.suppressRiders) {
    if (spell.id === 'ray-of-frost') {
      if (!target.conditions.includes('slowed')) target.conditions.push('slowed');
      ctx.addLog({ left: `${combatantDisplayName(target, ctx.state.npcs)} is slowed (Speed −10 ft until end of next turn)`, style: 'status' });
    } else if (spell.id === 'chill-touch') {
      if (!target.conditions.includes('no-healing')) target.conditions.push('no-healing');
      ctx.addLog({ left: `${combatantDisplayName(target, ctx.state.npcs)} can't regain HP until the start of your next turn`, style: 'status' });
    } else if (spell.id === 'shocking-grasp') {
      if (!target.conditions.includes('no-reactions')) target.conditions.push('no-reactions');
      ctx.addLog({ left: `${combatantDisplayName(target, ctx.state.npcs)} can't take Reactions until the start of its next turn`, style: 'status' });
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
  const effectiveAc = def.ac + coverAcBonus;
  const sm = spellMod(ctx);
  const bonus = ctx.playerDef.proficiencyBonus + sm;
  const roll = d20();
  const isCrit = roll === 20;
  const total = roll + bonus;
  const hit = isCrit || (roll !== 1 && total >= effectiveAc);
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
  const roll = d20();
  const total = roll + saveBonus;
  const success = total >= dc;
  const dmg = damageAfterSave(ctx, spell, success, save.halfOnSuccess, rawDamage);
  ctx.addLog({
    left: `${ctx.playerDef.name} ${success ? 'saves' : 'fails'} — ${dmg} ${damageMeta.type}`,
    right: `${save.ability.toUpperCase()} d20(${roll})+${saveBonus}=${total} vs DC ${dc}`,
    style: success ? 'normal' : 'hit',
  });
  if (dmg > 0) ctx.applyDamageToPlayer(dmg, events);
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
 * Compute the set of tile coordinates affected by a cone of `lengthTiles`
 * originating at `(ox, oy)` pointing toward `(targetX, targetY)`. Models a
 * SRD 5.2.1 cone (length = base diameter, ~53° total angle): at distance d along
 * the cone's axis, tiles within perpendicular distance ≤ d/2 + 0.5 are in.
 * Returns "x,y" strings for O(1) membership lookup.
 */
function coneTileSet(
  ox: number, oy: number,
  targetX: number, targetY: number,
  lengthTiles: number,
): Set<string> {
  let dx = targetX - ox;
  let dy = targetY - oy;
  const len = Math.hypot(dx, dy);
  if (len === 0) { dx = 1; dy = 0; } else { dx /= len; dy /= len; }
  const out = new Set<string>();
  for (let ry = -lengthTiles; ry <= lengthTiles; ry++) {
    for (let rx = -lengthTiles; rx <= lengthTiles; rx++) {
      if (rx === 0 && ry === 0) continue;                      // skip origin
      const along = rx * dx + ry * dy;                         // signed scalar projection
      if (along <= 0 || along > lengthTiles + 0.5) continue;
      const perp = Math.abs(-rx * dy + ry * dx);               // perpendicular distance
      if (perp > along * 0.5 + 0.5) continue;                  // cone half-angle ~27°
      out.add(`${ox + rx},${oy + ry}`);
    }
  }
  return out;
}

/**
 * Tile-side count for a cube area whose anchor is the clicked tile (i.e. a
 * Grease-style ground-placed cube). `sizeFeet` is the cube's side length;
 * each 5 ft → 1 tile. Exported only so other helpers can derive the bounds.
 */
function cubeSideTiles(spell: SpellDef): number {
  const sizeFeet = spell.area?.sizeFeet ?? 5;
  return Math.max(1, Math.ceil(sizeFeet / 5));
}

/**
 * Tile-radius for a sphere area. SRD spheres are specified by radius in
 * feet; the engine treats `sizeFeet` as the radius and rounds up to the
 * nearest 5 ft → 1 tile (5 ft = 1, 20 ft = 4). The full footprint is a
 * chebyshev disc of `2*radius + 1` tiles per side, centred on the anchor.
 */
function sphereRadiusTiles(spell: SpellDef): number {
  const sizeFeet = spell.area?.sizeFeet ?? 5;
  return Math.max(1, Math.ceil(sizeFeet / 5));
}

/**
 * 3×3-style cube originating from the caster, extending in the cursor
 * direction (Thunderwave). The caster's tile is **not** in the cube. For a
 * cardinal direction the perpendicular axis spans `sideTiles` tiles centred
 * on the caster; for a diagonal direction the cube is a `sideTiles ×
 * sideTiles` block in that quadrant. With `sideTiles = 3` and direction east
 * this gives the canonical 3×3 grid touching the caster's east face.
 */
function cubeFromCasterTiles(
  casterX: number, casterY: number,
  cursorX: number, cursorY: number,
  sideTiles: number,
): Set<string> {
  let dx = Math.sign(cursorX - casterX);
  let dy = Math.sign(cursorY - casterY);
  if (dx === 0 && dy === 0) dx = 1;
  const halfLow  = Math.floor((sideTiles - 1) / 2);
  const halfHigh = Math.ceil((sideTiles - 1) / 2);
  let xMin: number, xMax: number;
  if (dx === 0)      { xMin = casterX - halfLow; xMax = casterX + halfHigh; }
  else if (dx > 0)   { xMin = casterX + 1;       xMax = casterX + sideTiles; }
  else               { xMin = casterX - sideTiles; xMax = casterX - 1; }
  let yMin: number, yMax: number;
  if (dy === 0)      { yMin = casterY - halfLow; yMax = casterY + halfHigh; }
  else if (dy > 0)   { yMin = casterY + 1;       yMax = casterY + sideTiles; }
  else               { yMin = casterY - sideTiles; yMax = casterY - 1; }
  const out = new Set<string>();
  for (let y = yMin; y <= yMax; y++) {
    for (let x = xMin; x <= xMax; x++) out.add(`${x},${y}`);
  }
  return out;
}

/**
 * Chebyshev disc of `radiusTiles` around a tile centre. Used for proximity
 * checks ("within X ft of this creature") — distinct from the placed-sphere
 * rule below because the origin is a tile centre, not a grid intersection.
 */
function chebyshevDiscTiles(centerX: number, centerY: number, radiusTiles: number): Set<string> {
  const out = new Set<string>();
  for (let dy = -radiusTiles; dy <= radiusTiles; dy++) {
    for (let dx = -radiusTiles; dx <= radiusTiles; dx++) {
      out.add(`${centerX + dx},${centerY + dy}`);
    }
  }
  return out;
}

/**
 * SRD 5.2.1 placed-sphere rule: the sphere's origin is a grid-line
 * intersection (the corner shared by four tiles), and the radius extends
 * from there. On a tile grid this produces a `2 * radius` tile square
 * (5 ft sphere → 2×2 = 4 tiles, 10 ft → 4×4, 20 ft → 8×8). Convention: the
 * clicked tile is the top-left of the square, mirroring how cones and even-
 * sided cubes anchor at the click — moving the cursor one tile shifts the
 * area one tile, with no surprise mirroring across an axis.
 */
function placedSphereTiles(intersectionX: number, intersectionY: number, radiusTiles: number): Set<string> {
  const out = new Set<string>();
  const side = 2 * radiusTiles;
  for (let dy = 0; dy < side; dy++) {
    for (let dx = 0; dx < side; dx++) {
      out.add(`${intersectionX + dx},${intersectionY + dy}`);
    }
  }
  return out;
}

/**
 * Full set of tile coordinates a spell's area covers. Single source of truth
 * for placement of "what's in the AOE" — used by the saved-creature sweep
 * and the player-in-area check. Proximity-based AOEs (Ice Knife "within
 * 5 ft of target") build their tile set inline via `chebyshevDiscTiles`
 * because the origin is a tile centre, not a grid intersection. Shapes:
 *
 *   - cone: 53° expanding triangle from caster toward `click`.
 *   - sphere + self-range: chebyshev disc centred on the caster's tile —
 *     the caster occupies a tile, so the origin is the tile centre.
 *   - sphere + placed: SRD grid-intersection rule — 2*r tiles per side,
 *     anchored at the clicked tile (top-left).
 *   - cube + self-range: `cubeFromCasterTiles` (Thunderwave — caster NOT
 *     in area).
 *   - cube + placed: anchored at the clicked tile, extends right + down
 *     for even sides (Grease) or centres for odd sides.
 */
function tilesInArea(
  ctx: GameContext,
  spell: SpellDef,
  click: { x: number; y: number } | undefined,
): Set<string> {
  const s = ctx.state;
  const out = new Set<string>();
  if (!spell.area) return out;

  if (spell.area.shape === 'cone') {
    const radiusTiles = Math.max(1, Math.ceil(spell.area.sizeFeet / 5));
    const tx = click?.x ?? s.player.tileX + 1;
    const ty = click?.y ?? s.player.tileY;
    return coneTileSet(s.player.tileX, s.player.tileY, tx, ty, radiusTiles);
  }

  if (spell.area.shape === 'sphere') {
    const r = sphereRadiusTiles(spell);
    if (spell.range === 'self') {
      return chebyshevDiscTiles(s.player.tileX, s.player.tileY, r);
    }
    return placedSphereTiles(click?.x ?? s.player.tileX, click?.y ?? s.player.tileY, r);
  }

  // Cube.
  const side = cubeSideTiles(spell);
  if (spell.range === 'self') {
    const tx = click?.x ?? s.player.tileX + 1;
    const ty = click?.y ?? s.player.tileY;
    return cubeFromCasterTiles(s.player.tileX, s.player.tileY, tx, ty, side);
  }
  // Click-anchored cube — Grease-style. Even sides extend right+down from
  // the clicked tile; odd sides centre on it.
  const cx = click?.x ?? s.player.tileX;
  const cy = click?.y ?? s.player.tileY;
  let xMin: number, xMax: number, yMin: number, yMax: number;
  if (side % 2 === 1) {
    const r = (side - 1) / 2;
    xMin = cx - r; xMax = cx + r; yMin = cy - r; yMax = cy + r;
  } else {
    const offset = side - 1;
    xMin = cx; xMax = cx + offset; yMin = cy; yMax = cy + offset;
  }
  for (let y = yMin; y <= yMax; y++) {
    for (let x = xMin; x <= xMax; x++) out.add(`${x},${y}`);
  }
  return out;
}

/** True when the player's tile sits inside the spell's AOE. */
function playerInArea(
  ctx: GameContext,
  spell: SpellDef,
  click: { x: number; y: number } | undefined,
): boolean {
  const s = ctx.state;
  const tiles = tilesInArea(ctx, spell, click);
  return tiles.has(`${s.player.tileX},${s.player.tileY}`);
}

/**
 * Living NPCs in a spell's area. Routes through `tilesInArea` so every
 * AOE-shape rule lives in one place. Includes allies — AOE spells like
 * Burning Hands are indiscriminate per SRD.
 */
function creaturesInArea(
  ctx: GameContext,
  spell: SpellDef,
  tile: { x: number; y: number } | undefined,
): NpcState[] {
  const tiles = tilesInArea(ctx, spell, tile);
  return ctx.state.npcs.filter((n) => n.hp > 0 && tiles.has(`${n.tileX},${n.tileY}`));
}

/**
 * Normalise `SpellEffect.onFail` (which the schema allows as either a single
 * string or an array of strings) to a plain list of condition names.
 */
function normaliseConditionList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value.slice() : [value];
}

/**
 * Flavour line for a failed save. Recognises a handful of spells with
 * iconic narration; falls back to a generic "is &lt;condition&gt;" / "is affected"
 * for everything else.
 */
function conditionLogText(spell: SpellDef, conds: string[]): string {
  if (conds.length === 0) return 'is affected';
  if (spell.id === 'hideous-laughter') return 'collapses, helpless with laughter';
  if (spell.id === 'sleep')            return 'falls into a magical slumber';
  if (spell.id === 'charm-person')     return 'is charmed';
  return 'is ' + conds.join(' and ');
}

/**
 * SRD push effect (Thunderwave). Shoves `npc` `feet` feet directly away from
 * the caster, stopping at the first impassable tile or another creature.
 * One tile = 5 ft. No-op when the spell would push back into the caster.
 */
function pushNpcAway(ctx: GameContext, npc: NpcState, feet: number): void {
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
    if (!s.map.passable[ny][nx]) break;
    if (s.player.tileX === nx && s.player.tileY === ny) break;
    if (s.npcs.some((other) => other.id !== npc.id && other.hp > 0 && other.tileX === nx && other.tileY === ny)) break;
    npc.tileX = nx;
    npc.tileY = ny;
    moved++;
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
  if (spell.level === 0 && spell.damage && ctx.playerDef.defaultFeatureIds?.includes('potent-cantrip')) {
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
        pushNpcAway(ctx, target, spell.push.feet);
      }
      if (dmg > 0) anyAffected = true;
    } else if (spell.effect) {
      // Pure condition save (Sleep). `onFail` may be a single condition or an
      // array — Hideous Laughter applies both Prone and Incapacitated.
      const conds = !success ? normaliseConditionList(spell.effect.onFail) : [];
      for (const c of conds) {
        if (!target.conditions.includes(c)) target.conditions.push(c);
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
    ctx.addLog({
      left: `${combatantDisplayName(target, ctx.state.npcs)} ${success ? 'resists' : conditionLogText(spell, conds)}`,
      right: `d20(${roll})+${saveBonus}=${total} vs DC ${dc}`,
      style: success ? 'normal' : 'status',
    });
    return !success && conds.length > 0;
  } else {
    // Pure narrative single-target save (Charm Person, Hideous Laughter). The
    // outcome is logged but no engine-tracked condition is set yet — content
    // can wire one via spell.effect.onFail when needed.
    ctx.addLog({
      left: `${combatantDisplayName(target, ctx.state.npcs)} ${success ? 'resists' : 'is affected'}`,
      right: `d20(${roll})+${saveBonus}=${total} vs DC ${dc}`,
      style: success ? 'normal' : 'status',
    });
    return !success;
  }
}

function resolveUtilitySpell(ctx: GameContext, spell: SpellDef, tile?: { x: number; y: number }): void {
  // No roll; just narrate. Specific lasting effects (Mage Armor, Shield as
  // reaction) handled by spell-id switch — kept here, not as separate files,
  // since each is one-line semantic flag flips.
  const s = ctx.state;
  switch (spell.id) {
    case 'mage-armor':
      // Self/touch: target self (the only valid target without an ally system).
      if (s.player.equippedSlots.armorId) {
        ctx.addLog({ left: `Mage Armor fizzles — already wearing armor`, style: 'miss' });
        return;
      }
      s.player.mageArmor = true;
      applyEquipment(ctx.playerDef, s.player.equippedSlots, ctx.defs.equipment, true, s.player.shieldActive);
      s.player.ac = ctx.playerDef.ac;
      ctx.addLog({ left: `${ctx.playerDef.name} casts Mage Armor — AC ${ctx.playerDef.ac} for 8 hours`, style: 'status' });
      break;
    case 'detect-magic':
      ctx.addLog({ left: `${ctx.playerDef.name} casts Detect Magic — senses magical effects within 30 ft`, style: 'status' });
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
      // SRD: +10 ft speed for the duration. The bonus lives on PlayerState
      // so tile-speed calculations at turn start can read it without
      // mutating the immutable PlayerDef. When cast mid-turn, also bump
      // `movesLeft` by the new ft difference so the player can spend the
      // extra tiles this turn — `enterPlayerTurn` already seeded
      // `movesLeft` from the base speed before the buff existed.
      const prevBonus = s.player.speedBonus;
      s.player.speedBonus = Math.max(s.player.speedBonus, 10);
      if (s.phase === 'player_turn') {
        const deltaTiles = Math.floor((s.player.speedBonus - prevBonus) / 5);
        if (deltaTiles > 0) s.player.movesLeft += deltaTiles;
      }
      ctx.addLog({ left: `${ctx.playerDef.name} casts Longstrider — Speed +10 ft for 1 hour`, style: 'status' });
      break;
    }
    case 'expeditious-retreat': {
      // SRD: cast as bonus action; you Dash this turn and may Dash as a bonus
      // action on each subsequent turn. We grant the upfront Dash immediately
      // (adds `speed/5` extra tiles to `movesLeft`) and flag the runtime so
      // CombatFlow can grant the bonus-action Dash each turn while active.
      s.player.expeditiousRetreat = true;
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
    case 'fog-cloud': {
      // SRD: 20-ft-radius Sphere of Heavily Obscured fog at the chosen point.
      // We don't model persistent vision-zone geometry yet, so apply the
      // `heavily-obscured` condition to every creature standing in the
      // sphere at cast time. `endConcentration` strips it when the spell
      // ends. Mobile creatures stepping in/out are not updated — a known
      // limitation until per-tile obscurance zones land.
      if (!tile) {
        ctx.addLog({ left: `${spell.name}: no target tile`, style: 'miss' });
        break;
      }
      const inArea = creaturesInArea(ctx, spell, tile);
      for (const t of inArea) {
        if (!t.conditions.includes('heavily-obscured')) t.conditions.push('heavily-obscured');
      }
      const casterIn = playerInArea(ctx, spell, tile);
      if (casterIn && !s.player.conditions.includes('heavily-obscured')) {
        s.player.conditions.push('heavily-obscured');
      }
      const total = inArea.length + (casterIn ? 1 : 0);
      ctx.addLog({
        left: `${ctx.playerDef.name} casts Fog Cloud — ${total} creature(s) Heavily Obscured`,
        style: 'status',
      });
      break;
    }
    default:
      ctx.addLog({ left: `${ctx.playerDef.name} casts ${spell.name}`, style: 'status' });
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

/** A spell is "aggressive" if it can damage or impose a harmful condition on a creature. */
function isAggressiveSpell(spell: SpellDef): boolean {
  return !!(spell.attack || spell.damage || spell.save || spell.darts);
}

/**
 * If we're in exploring phase and the cast is aggressive, promote any neutral
 * targets to enemy, aggro their faction, and start combat — mirroring the
 * behaviour of the ATTACK button. Returns the list of affected NPCs so the
 * caller doesn't have to recompute them.
 */
function maybeAggroOnCast(
  ctx: GameContext,
  spell: SpellDef,
  targetIds: string[] | undefined,
  tile: { x: number; y: number } | undefined,
  events: GameEvent[],
): NpcState[] {
  const s = ctx.state;
  if (s.phase !== 'exploring') return [];
  if (!isAggressiveSpell(spell)) return [];

  // Identify the non-ally NPCs affected by the cast. Attack-roll and
  // single-target save spells (Hideous Laughter, Charm Person) key off the
  // selected creature; AOE save spells use the area sweep.
  let affected: NpcState[] = [];
  if (spell.attack === 'ranged-spell' || spell.attack === 'melee-spell' || spell.attack === 'auto-hit'
    || (spell.save && !spell.area)) {
    const ids = targetIds && targetIds.length > 0 ? targetIds : (s.selectedTargetId ? [s.selectedTargetId] : []);
    affected = ids
      .map((id) => s.npcs.find((n) => n.id === id))
      .filter((n): n is NpcState => !!n && n.hp > 0 && n.disposition !== 'ally');
  } else if (spell.save) {
    // For aggro-trigger purposes we still filter to non-allies — allies in the
    // area take damage in the resolver but don't influence faction aggro.
    affected = creaturesInArea(ctx, spell, tile).filter((n) => n.disposition !== 'ally');
  }

  if (affected.length === 0) return [];

  // Promote any neutrals → enemy and assign combat labels.
  for (const npc of affected) {
    if (npc.disposition === 'neutral') {
      npc.disposition = 'enemy';
      if (!npc.combatLabel) ctx.assignCombatLabel(npc);
    }
  }
  // Aggro shared-faction neutrals on the first promoted target (matches doAttack).
  ctx.aggroFaction(affected[0]);
  ctx.doStartCombat(events);
  return affected;
}

/**
 * Resolve a player spell cast. Validates eligibility, consumes resources,
 * dispatches to the right resolution branch based on the spell's JSON shape.
 */
export function doCastSpell(
  ctx: GameContext,
  spellId: string,
  slotLevel: number,
  targetIds: string[] | undefined,
  tile: { x: number; y: number } | undefined,
  asRitual: boolean,
  events: GameEvent[],
  damageTypeChoice?: string,
): void {
  const baseSpell = ctx.defs.spells.find((sp) => sp.id === spellId);
  if (!baseSpell) return;

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
  } else if (!canCastSpell(ctx, spellId)) {
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
  } else if (spell.save && !spell.area) {
    // Single-target save spell (Hideous Laughter, Charm Person, …).
    // Validate target + range up front so we don't consume a slot / action on
    // a no-target cast or an out-of-range pick.
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

  // Aggressive casts in exploring phase trigger combat first — same as the
  // ATTACK button. Neutrals turn enemy before the spell resolves so attack
  // rolls and area effects see them as valid hostiles.
  maybeAggroOnCast(ctx, spell, targetIds, tile, events);

  consumeCastingResources(ctx, spell, slotLevel, asRitual);

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
      const result = resolveAttackRollSpell(ctx, spell, preResolvedTarget, slotLevel);
      anyEffect = result.hit;
      // On-hit save (Ray of Sickness): rolls a save against the same target
      // when the attack landed and the spell carries `save + effect` but no
      // area. Independent of the secondary-AOE path below.
      if (result.hit && spell.save && spell.effect && !spell.area) {
        if (resolveOnHitSave(ctx, spell, preResolvedTarget)) anyEffect = true;
      }
      // Chromatic Orb chain: matching dice → leap to a nearby second target.
      if (result.hit) maybeChainOnDoubles(ctx, spell, preResolvedTarget, result.damageRolls, slotLevel);
      // Ice Knife's "hit or miss, the shard explodes" — runs regardless of
      // the primary attack's outcome.
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
    resolveUtilitySpell(ctx, spell, tile);
    anyEffect = true;
  }

  // Concentration only kicks in after a real effect lands — every target
  // saved or the spell missed → no ongoing effect → no concentration cost.
  // A new concentration spell drops any previous one first.
  if (spell.concentration && anyEffect) startConcentration(ctx, spell.id);
}

// Export labels useful for the UI.
export function spellLabel(spell: SpellDef): string {
  return spell.level === 0 ? `${spell.name} (cantrip)` : `${spell.name} (L${spell.level})`;
}

// Expose a simple "log opener" for narrative GM hooks if needed later.
function _logOpenerStub(_log: LogEntry): void { /* intentionally empty */ }
void _logOpenerStub;
