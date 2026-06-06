import { d, d20, mod, rollAdvantage, rollDisadvantage } from './Dice.js';
import { PlayerDef, PlayerAttack, MonsterDef, MonsterAttack, ConsumableDef, LogEntry, BonusDamage, RolledBonusDamage, ResolvedAttackSnapshot } from './types.js';
import { Logger } from '../Logger.js';
import { critFloor } from './Modifiers.js';

export type { RolledBonusDamage };

/** The full outcome of one resolved player attack roll (roll + rolled damage,
 *  pre-consequence). Captured in `pendingReroll` so a declined Heroic
 *  Inspiration reroll (US-109a) applies the exact roll the player saw. Aliases
 *  the shared `ResolvedAttackSnapshot` so it can ride in `GameState`. */
export type ResolvedPlayerAttack = ResolvedAttackSnapshot;

/**
 * Apply post-resistance `amount` damage to any creature carrying a Temporary HP
 * pool (US-109): the pool absorbs first, the remainder reduces real HP. Shared
 * by every NPC damage path so a future temp-HP source on an NPC is honoured
 * without touching each call site. Mutates `target.hp` / `target.tempHp`.
 */
export function applyDamageWithTempHp(target: { hp: number; tempHp?: number }, amount: number): void {
  if (amount <= 0) return;
  if (target.tempHp && target.tempHp > 0) {
    const absorbed = Math.min(target.tempHp, amount);
    target.tempHp -= absorbed;
    amount -= absorbed;
  }
  target.hp = Math.max(0, target.hp - amount);
}

function rollDice(count: number, sides: number): { total: number; rolls: number[] } {
  const rolls: number[] = [];
  for (let i = 0; i < count; i++) rolls.push(d(sides));
  return { total: rolls.reduce((a, b) => a + b, 0), rolls };
}

/**
 * Roll every bonus-damage rider attached to an attack. Crits double the
 * dice (matching SRD); the flat bonus is never doubled.
 */
function rollAllBonusDamage(riders: BonusDamage[] | undefined, isCrit: boolean): RolledBonusDamage[] {
  if (!riders || riders.length === 0) return [];
  return riders.map((r) => {
    const diceCount = isCrit ? r.dice * 2 : r.dice;
    const { total: diceTot, rolls } = rollDice(diceCount, r.sides);
    const damage = Math.max(0, diceTot + r.bonus);
    const diceLabel = isCrit ? `2×${r.dice}d${r.sides}` : `${r.dice}d${r.sides}`;
    const bonusPart = r.bonus ? (r.bonus >= 0 ? `+${r.bonus}` : `${r.bonus}`) : '';
    return { damage, damageType: r.damageType, rollStr: `${diceLabel}[${rolls.join(',')}]${bonusPart}` };
  });
}

/**
 * Roll one combatant's Initiative.
 * SRD ([Playing_The_Game §Initiative], [Rules Glossary §Surprise]):
 *   - Surprised → Disadvantage on the roll.
 *   - Invisible → Advantage on the roll.
 *   - Incapacitated → Disadvantage (Surprised condition implication).
 * Both can apply; they cancel per the standard Advantage/Disadvantage rule.
 */
export function rollOneInitiative(
  modifier: number,
  surprised: boolean,
  invisible: boolean,
  /** Extra Advantage source beyond Invisible — Champion's Remarkable
   *  Athlete (Fighter L3) is the SRD case. ORs with `invisible`; the
   *  Adv/Dis cancellation rule still applies if `surprised` is also true. */
  extraAdvantage = false,
): { roll: number; total: number; rollStr: string } {
  const wantAdv = invisible || extraAdvantage;
  const wantDis = surprised;
  const effAdv = wantAdv && !wantDis;
  const effDis = wantDis && !wantAdv;
  let roll: number, rollStr: string;
  if (effAdv) {
    const r = rollAdvantage();
    roll = r.result;
    rollStr = `adv(${r.rolls[0]},${r.rolls[1]}→${roll})`;
  } else if (effDis) {
    const r = rollDisadvantage();
    roll = r.result;
    rollStr = `dis(${r.rolls[0]},${r.rolls[1]}→${roll})`;
  } else {
    roll = d20();
    rollStr = `d20(${roll})`;
  }
  const sign = modifier >= 0 ? '+' : '';
  return { roll, total: roll + modifier, rollStr: `${rollStr}${sign}${modifier}` };
}

function resolvePlayerAttack(
  player: PlayerDef,
  attack: PlayerAttack,
  enemy: MonsterDef,
  withAdvantage: boolean,
  withDisadvantage: boolean,
  profBonus = player.proficiencyBonus,
  autoCrit = false,
  playerHidden = false,
  /** SRD Cover AC bonus: half +2, three-quarters +5, total = auto-miss. */
  coverAcBonus = 0,
  /** Caller-computed flag: SRD Sneak Attack eligibility for THIS attack.
   *  Encapsulates Finesse/Ranged weapon check, once-per-turn gate, ally-
   *  adjacent alternative, and the "no Disadvantage" rider. When `false`,
   *  Sneak dice are NOT added even if the attack has Advantage. */
  sneakAttackAllowed = false,
  /** Flat modifier to the attack roll from caller-side state the resolver can't
   *  see — currently the SRD Exhaustion penalty (−2 × level, a D20 Test;
   *  US-113). Negative lowers the roll. */
  extraAttackMod = 0,
): ResolvedPlayerAttack {
  const statMod = attack.statKey === 'str' ? mod(player.str) : mod(player.dex);
  // SRD Magic Weapon spell — flat bonus to attack rolls (consumed below
  // when damage is rolled).
  const magicWeaponBonus = attack.magicWeaponBonus ?? 0;
  const attackBonus = statMod + profBonus + magicWeaponBonus + extraAttackMod;
  const logs: LogEntry[] = [];

  const effAdv = withAdvantage && !withDisadvantage;
  const effDis = withDisadvantage && !withAdvantage;

  let naturalRoll: number, rollPart: string;
  if (effAdv) {
    const { result, rolls } = rollAdvantage();
    naturalRoll = result;
    rollPart = `adv(${rolls[0]},${rolls[1]}→${naturalRoll})`;
    if (playerHidden) logs.push({ left: `${player.name} strikes from the shadows`, style: 'normal' });
  } else if (effDis) {
    const { result, rolls } = rollDisadvantage();
    naturalRoll = result;
    rollPart = `dis(${rolls[0]},${rolls[1]}→${naturalRoll})`;
  } else {
    naturalRoll = d20();
    rollPart = `d20(${naturalRoll})`;
  }

  const total = naturalRoll + attackBonus;
  const natural1 = naturalRoll === 1;
  const effectiveAc = enemy.ac + coverAcBonus;
  // SRD Champion Improved Critical (L3): crit on 19-20. Superior Critical
  // (L15): crit on 18-20. The crit-range floor comes from the character's
  // aggregated `crit-range` modifiers (lowest min wins). Crits always hit
  // regardless of AC, so the floor expands `wouldHit` too.
  const critFloorVal = critFloor(player);
  const inCritRange = naturalRoll >= critFloorVal;
  const wouldHit = inCritRange || total >= effectiveAc;
  const isHit = wouldHit && !natural1;
  const isCrit = inCritRange || (autoCrit && isHit);
  const coverNote = coverAcBonus > 0 ? ` (+${coverAcBonus} cover)` : '';
  const atkPart = `${rollPart}+${attackBonus}=${total} vs AC ${effectiveAc}${coverNote}`;

  let damage = 0, vexApplied = false, slowApplied = false;
  let sneakAttackFired = false;
  // SRD Sneak Attack: extra damage only fires on a hit, only if the caller
  // has declared the attack eligible (Finesse / Ranged + once-per-turn +
  // (Advantage OR (ally-adjacent && !Disadvantage)) — see
  // `sneakAttackEligible` in CombatActions).
  const wantsSneak = (isHit || isCrit) && sneakAttackAllowed && player.sneakAttackDice > 0;

  if (isCrit) {
    const { total: diceTot, rolls: diceRolls } = rollDice(attack.damageDice * 2, attack.damageSides);
    let sneakTot = 0, sneakRolls: number[] = [];
    if (wantsSneak) {
      const s = rollDice(player.sneakAttackDice * 2, 6);
      sneakTot = s.total; sneakRolls = s.rolls;
      sneakAttackFired = true;
    }
    damage = diceTot + statMod + magicWeaponBonus + sneakTot;
    const sneakPart = sneakTot > 0 ? ` + sneak[${sneakRolls.join(',')}]=${sneakTot}` : '';
    const mwPart = magicWeaponBonus > 0 ? ` +${magicWeaponBonus}(magic)` : '';
    const dicePart = `2×${attack.damageDice}d${attack.damageSides}[${diceRolls.join(',')}]+${statMod}${mwPart}${sneakPart}`;
    logs.push({ left: `⚡ Critical hit with ${attack.name} — ${damage} ${attack.damageType}`, right: `${atkPart} · ${dicePart}`, style: 'crit' });
    vexApplied = attack.vex || attack.sap;
    slowApplied = attack.slow;

  } else if (isHit) {
    let diceTotal: number, diceRolls: number[];
    if (attack.savageAttacker) {
      const r1 = rollDice(attack.damageDice, attack.damageSides);
      const r2 = rollDice(attack.damageDice, attack.damageSides);
      const kept = r1.total >= r2.total ? r1 : r2;
      diceTotal = kept.total; diceRolls = kept.rolls;
    } else {
      const r = rollDice(attack.damageDice, attack.damageSides);
      diceTotal = r.total; diceRolls = r.rolls;
    }
    let sneakTot = 0, sneakRolls: number[] = [];
    if (wantsSneak) {
      const s = rollDice(player.sneakAttackDice, 6);
      sneakTot = s.total; sneakRolls = s.rolls;
      sneakAttackFired = true;
    }
    damage = diceTotal + statMod + magicWeaponBonus + sneakTot;
    const sneakSuffix = sneakTot > 0 ? ` (+${sneakTot} sneak)` : '';
    const sneakRightPart = sneakTot > 0 ? ` + sneak[${sneakRolls.join(',')}]=${sneakTot}` : '';
    const savPart = attack.savageAttacker ? ' Savage' : '';
    const mwHitPart = magicWeaponBonus > 0 ? ` +${magicWeaponBonus}(magic)` : '';
    const dicePart = `${attack.damageDice}d${attack.damageSides}[${diceRolls.join(',')}]+${statMod}${mwHitPart}${savPart}${sneakRightPart}`;
    logs.push({ left: `Hit with ${attack.name} — ${damage} ${attack.damageType}${sneakSuffix}`, right: `${atkPart} · ${dicePart}`, style: 'hit' });
    vexApplied = attack.vex || attack.sap;
    slowApplied = attack.slow;

  } else {
    if (attack.graze) {
      damage = Math.max(0, statMod);
      logs.push(damage > 0
        ? { left: `Graze with ${attack.name} — ${damage} ${attack.damageType}`, right: atkPart, style: 'miss' }
        : { left: `Miss with ${attack.name}`, right: atkPart, style: 'miss' });
    } else {
      logs.push({ left: `Miss with ${attack.name}`, right: atkPart, style: 'miss' });
    }
  }

  // Roll secondary damage riders (e.g. weapon-with-fire-enchant, future
  // monk Open Hand riders). Only fires on a Hit or Crit — misses with `graze`
  // still skip bonusDamage since they're flavour residue from missing
  // entirely, not a full "the weapon connected" outcome.
  const bonusComponents = (isHit || isCrit)
    ? rollAllBonusDamage(attack.bonusDamage, isCrit)
    : [];

  Logger.log('combat.attack_roll', {
    attacker: 'player',
    weapon: attack.name,
    statKey: attack.statKey,
    statMod, profBonus, attackBonus,
    naturalRoll, total,
    adv: effAdv, dis: effDis,
    targetAc: enemy.ac, coverAcBonus, effectiveAc,
    critFloor: critFloorVal, inCritRange,
    isHit, isCrit,
    sneakAttackAllowed, sneakAttackFired,
    damage,
  });
  return { damage, isHit, isCrit, attackTotal: total, naturalRoll, logs, vexApplied, slowApplied, bonusComponents, sneakAttackFired };
}

export function playerMeleeAttack(
  player: PlayerDef,
  enemy: MonsterDef,
  withAdvantage: boolean,
  withDisadvantage = false,
  autoCrit = false,
  playerHidden = false,
  coverAcBonus = 0,
  sneakAttackAllowed = false,
  extraAttackMod = 0,
): ResolvedPlayerAttack {
  return resolvePlayerAttack(player, player.mainAttack, enemy, withAdvantage, withDisadvantage, player.proficiencyBonus, autoCrit, playerHidden, coverAcBonus, sneakAttackAllowed, extraAttackMod);
}

export function playerThrowAttack(
  player: PlayerDef,
  attack: PlayerAttack,
  enemy: MonsterDef,
  withAdvantage: boolean,
  withDisadvantage = false,
  profBonus?: number,
  autoCrit = false,
  playerHidden = false,
  coverAcBonus = 0,
  sneakAttackAllowed = false,
  extraAttackMod = 0,
): ResolvedPlayerAttack {
  return resolvePlayerAttack(player, attack, enemy, withAdvantage, withDisadvantage, profBonus ?? player.proficiencyBonus, autoCrit, playerHidden, coverAcBonus, sneakAttackAllowed, extraAttackMod);
}

/**
 * SRD 5.2.1 Hide [Action]. Rolls a Dexterity (Stealth) check; success is a
 * total of at least DC 15. On success the total becomes the per-creature DC
 * for Wisdom (Perception) checks to find the hider — Vision.runPerceptionSweep
 * opposes that DC. The gate (Heavily Obscured / Cover / LOS) is enforced by
 * the caller (CombatActions.doHide) before this is invoked.
 */
export function playerHide(player: PlayerDef, disadvantage = false): { hidden: boolean; dc: number; logs: LogEntry[] } {
  const stealthBonus = player.skills['stealth'] ?? 0;
  // SRD armor Stealth penalty (US-111): Disadvantage on the Hide roll.
  const natural = disadvantage ? rollDisadvantage().result : d20();
  const stealthRoll = natural + stealthBonus;
  const hidden = stealthRoll >= 15;
  const right = `Stealth ${disadvantage ? 'dis ' : ''}d20+${stealthBonus}=${stealthRoll} vs DC 15`;
  if (hidden) {
    return { hidden: true, dc: stealthRoll, logs: [{ left: `${player.name} slips into the shadows`, right: `${right} ✓`, style: 'status' }] };
  }
  return { hidden: false, dc: 0, logs: [{ left: `${player.name} fails to hide`, right: `${right} ✗`, style: 'miss' }] };
}

export function enemyAttack(
  attack: MonsterAttack,
  playerAc: number,
  withAdvantage: boolean,
  withDisadvantage = false,
  /** SRD Cover the player benefits from against this NPC's attack. */
  coverAcBonus = 0,
): { damage: number; isHit: boolean; isCrit: boolean; attackTotal: number; naturalRoll: number; logs: LogEntry[]; bonusComponents: RolledBonusDamage[] } {
  const logs: LogEntry[] = [];
  const effAdv = withAdvantage && !withDisadvantage;
  const effDis = withDisadvantage && !withAdvantage;

  let naturalRoll: number, rollPart: string;
  if (effAdv) {
    const { result, rolls } = rollAdvantage();
    naturalRoll = result; rollPart = `adv(${rolls[0]},${rolls[1]}→${naturalRoll})`;
  } else if (effDis) {
    const { result, rolls } = rollDisadvantage();
    naturalRoll = result; rollPart = `dis(${rolls[0]},${rolls[1]}→${naturalRoll})`;
  } else {
    naturalRoll = d20(); rollPart = `d20(${naturalRoll})`;
  }

  const attackTotal = naturalRoll + attack.bonus;
  const effectiveAc = playerAc + coverAcBonus;
  const isCrit = naturalRoll === 20;
  const isHit = (isCrit || attackTotal >= effectiveAc) && naturalRoll !== 1;
  const coverNote = coverAcBonus > 0 ? ` (+${coverAcBonus} cover)` : '';
  const atkPart = `${rollPart}+${attack.bonus}=${attackTotal} vs AC ${effectiveAc}${coverNote}`;

  let damage = 0;
  if (isHit) {
    const diceCount = isCrit ? attack.damageDice * 2 : attack.damageDice;
    const { total: diceTot, rolls: diceRolls } = rollDice(diceCount, attack.damageSides);
    damage = diceTot + attack.damageBonus;
    const diceLabel = isCrit ? `2×${attack.damageDice}d${attack.damageSides}` : `${attack.damageDice}d${attack.damageSides}`;
    const dicePart = `${diceLabel}[${diceRolls.join(',')}]+${attack.damageBonus}`;
    logs.push(isCrit
      ? { left: `⚡ Critical hit with ${attack.name} — ${damage} ${attack.damageType}`, right: `${atkPart} · ${dicePart}`, style: 'crit' }
      : { left: `Hit with ${attack.name} — ${damage} ${attack.damageType}`, right: `${atkPart} · ${dicePart}`, style: 'hit' });
  } else {
    logs.push({ left: `Miss with ${attack.name}`, right: atkPart, style: 'miss' });
  }

  const bonusComponents = isHit ? rollAllBonusDamage(attack.bonusDamage, isCrit) : [];

  return { damage, isHit, isCrit, attackTotal, naturalRoll, logs, bonusComponents };
}

export function tryNimbleEscape(
  enemy: MonsterDef,
  passivePerception: number,
): { hidden: boolean; logs: LogEntry[] } {
  const stealthRoll = d20() + enemy.stealthBonus;
  const success = stealthRoll > passivePerception;
  const right = `Stealth d20+${enemy.stealthBonus}=${stealthRoll} vs PP ${passivePerception}`;
  if (success) {
    return { hidden: true, logs: [{ left: `${enemy.name} slips into the shadows`, right: `${right} ✓`, style: 'status' }] };
  }
  return { hidden: false, logs: [{ left: `${enemy.name} fails to hide`, right: `${right} ✗`, style: 'miss' }] };
}

export function playerSecondWind(level: number): { healed: number; logs: LogEntry[] } {
  const roll = d(10);
  const healed = roll + level;
  return { healed, logs: [{ left: `Second Wind — +${healed} HP restored`, right: `1d10+${level}=[${roll}]+${level}`, style: 'heal' }] };
}

export function drinkPotion(item: ConsumableDef): { healed: number; tempHp: number; logs: LogEntry[] } {
  const logs: LogEntry[] = [];
  let healed = 0;
  if (item.healDice || item.healBonus) {
    const { total, rolls } = rollDice(item.healDice ?? 0, item.healSides ?? 0);
    healed = total + (item.healBonus ?? 0);
    logs.push({ left: `Drinks ${item.name} — +${healed} HP`, right: `${item.healDice ?? 0}d${item.healSides ?? 0}[${rolls.join(',')}]+${item.healBonus ?? 0}`, style: 'heal' });
  }
  // US-124 potions beyond healing: temporary HP.
  let tempHp = 0;
  if (item.tempHpDice || item.tempHpBonus) {
    const { total, rolls } = rollDice(item.tempHpDice ?? 0, item.tempHpSides ?? 0);
    tempHp = total + (item.tempHpBonus ?? 0);
    logs.push({ left: `Drinks ${item.name} — +${tempHp} temporary HP`, right: `${item.tempHpDice ?? 0}d${item.tempHpSides ?? 0}[${rolls.join(',')}]+${item.tempHpBonus ?? 0}`, style: 'heal' });
  }
  if (logs.length === 0) logs.push({ left: `Drinks ${item.name}`, style: 'status' });
  return { healed, tempHp, logs };
}

export function rollDeathSave(): { roll: number; outcome: 'nat20' | 'success' | 'failure' | 'nat1' } {
  const roll = d20();
  if (roll === 20) return { roll, outcome: 'nat20' };
  if (roll === 1) return { roll, outcome: 'nat1' };
  return { roll, outcome: roll >= 10 ? 'success' : 'failure' };
}

export function rollSkillCheck(
  skillMod: number,
  dc: number,
  withAdvantage = false,
  withDisadvantage = false,
): { roll: number; total: number; success: boolean } {
  const effAdv = withAdvantage && !withDisadvantage;
  const effDis = withDisadvantage && !withAdvantage;
  let roll: number;
  if (effAdv) {
    roll = rollAdvantage().result;
  } else if (effDis) {
    roll = rollDisadvantage().result;
  } else {
    roll = d20();
  }
  const total = roll + skillMod;
  return { roll, total, success: total >= dc };
}

export function rollPlayerAttackVsAc(
  player: PlayerDef,
  targetAc: number,
): { roll: number; total: number; isHit: boolean; isCrit: boolean; damage: number; rollStr: string } {
  const attack = player.mainAttack;
  const statMod = attack.statKey === 'str' ? mod(player.str) : mod(player.dex);
  const bonus = statMod + player.proficiencyBonus;
  const roll = d20();
  const isCrit = roll === 20;
  const isHit = (isCrit || roll + bonus >= targetAc) && roll !== 1;
  let damage = 0;
  let rollStr = `d20(${roll})+${bonus}=${roll + bonus} vs AC ${targetAc}`;
  if (isHit) {
    const diceCount = isCrit ? attack.damageDice * 2 : attack.damageDice;
    const { total: diceTot, rolls: diceRolls } = rollDice(diceCount, attack.damageSides);
    damage = Math.max(0, diceTot + statMod);
    rollStr += ` · ${diceCount}d${attack.damageSides}[${diceRolls.join(',')}]+${statMod}=${damage} ${attack.damageType}`;
  }
  return { roll, total: roll + bonus, isHit, isCrit, damage, rollStr };
}

export function rollNpcAttackVsAc(
  def: MonsterDef,
  targetAc: number,
): { roll: number; total: number; isHit: boolean; isCrit: boolean; damage: number; rollStr: string } {
  const atk = def.attacks[0];
  if (!atk) return { roll: 0, total: 0, isHit: false, isCrit: false, damage: 0, rollStr: 'No attack available.' };
  const roll = d20();
  const total = roll + atk.bonus;
  const isCrit = roll === 20;
  const isHit = (isCrit || total >= targetAc) && roll !== 1;
  let damage = 0;
  let rollStr = `d20(${roll})+${atk.bonus}=${total} vs AC ${targetAc}`;
  if (isHit) {
    const diceCount = isCrit ? atk.damageDice * 2 : atk.damageDice;
    const { total: diceTot, rolls: diceRolls } = rollDice(diceCount, atk.damageSides);
    damage = Math.max(0, diceTot + atk.damageBonus);
    rollStr += ` · ${diceCount}d${atk.damageSides}[${diceRolls.join(',')}]+${atk.damageBonus}=${damage} ${atk.damageType}`;
  }
  return { roll, total, isHit, isCrit, damage, rollStr };
}

export function rollSavingThrow(
  saveMod: number,
  dc: number,
  withAdvantage = false,
  withDisadvantage = false,
): { roll: number; total: number; success: boolean } {
  return rollSkillCheck(saveMod, dc, withAdvantage, withDisadvantage);
}
