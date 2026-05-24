import { d, d20, mod, rollAdvantage, rollDisadvantage } from './Dice.js';
import { PlayerDef, PlayerAttack, MonsterDef, MonsterAttack, ConsumableDef, LogEntry } from './types.js';

function rollDice(count: number, sides: number): { total: number; rolls: number[] } {
  const rolls: number[] = [];
  for (let i = 0; i < count; i++) rolls.push(d(sides));
  return { total: rolls.reduce((a, b) => a + b, 0), rolls };
}

export function rollInitiative(
  player: PlayerDef,
  enemy: MonsterDef,
  enemyDisplayName: string,
): { playerFirst: boolean; logs: LogEntry[] } {
  const pRoll = d20(), eRoll = d20();
  const pMod = mod(player.dex), eMod = enemy.initiativeBonus;
  const pTotal = pRoll + pMod, eTotal = eRoll + eMod;
  const playerFirst = pTotal >= eTotal;
  return {
    playerFirst,
    logs: [
      { left: '⚔ Combat begins', style: 'header' },
      {
        left: playerFirst ? `${player.name} acts first` : `${enemyDisplayName} acts first`,
        right: `${player.name} d20(${pRoll})+${pMod}=${pTotal} · ${enemyDisplayName} d20(${eRoll})+${eMod}=${eTotal}`,
        style: 'normal',
      },
    ],
  };
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
): { damage: number; isHit: boolean; logs: LogEntry[]; vexApplied: boolean; slowApplied: boolean } {
  const statMod = attack.statKey === 'str' ? mod(player.str) : mod(player.dex);
  const attackBonus = statMod + profBonus;
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
  const natural20 = naturalRoll === 20;
  const natural1 = naturalRoll === 1;
  const wouldHit = natural20 || total >= enemy.ac;
  const isHit = wouldHit && !natural1;
  const isCrit = natural20 || (autoCrit && isHit);
  const atkPart = `${rollPart}+${attackBonus}=${total} vs AC ${enemy.ac}`;

  let damage = 0, vexApplied = false, slowApplied = false;

  if (isCrit) {
    const { total: diceTot, rolls: diceRolls } = rollDice(attack.damageDice * 2, attack.damageSides);
    let sneakTot = 0, sneakRolls: number[] = [];
    if (withAdvantage && player.sneakAttackDice > 0) {
      const s = rollDice(player.sneakAttackDice * 2, 6);
      sneakTot = s.total; sneakRolls = s.rolls;
    }
    damage = diceTot + statMod + sneakTot;
    const sneakPart = sneakTot > 0 ? ` + sneak[${sneakRolls.join(',')}]=${sneakTot}` : '';
    const dicePart = `2×${attack.damageDice}d${attack.damageSides}[${diceRolls.join(',')}]+${statMod}${sneakPart}`;
    logs.push({ left: `⚡ Critical hit — ${damage} ${attack.damageType}`, right: `${atkPart} · ${dicePart}`, style: 'crit' });
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
    if (withAdvantage && player.sneakAttackDice > 0) {
      const s = rollDice(player.sneakAttackDice, 6);
      sneakTot = s.total; sneakRolls = s.rolls;
    }
    damage = diceTotal + statMod + sneakTot;
    const sneakSuffix = sneakTot > 0 ? ` (+${sneakTot} sneak)` : '';
    const sneakRightPart = sneakTot > 0 ? ` + sneak[${sneakRolls.join(',')}]=${sneakTot}` : '';
    const savPart = attack.savageAttacker ? ' Savage' : '';
    const dicePart = `${attack.damageDice}d${attack.damageSides}[${diceRolls.join(',')}]+${statMod}${savPart}${sneakRightPart}`;
    logs.push({ left: `Hit — ${damage} ${attack.damageType}${sneakSuffix}`, right: `${atkPart} · ${dicePart}`, style: 'hit' });
    vexApplied = attack.vex || attack.sap;
    slowApplied = attack.slow;

  } else {
    if (attack.graze) {
      damage = Math.max(0, statMod);
      logs.push(damage > 0
        ? { left: `Graze — ${damage} ${attack.damageType}`, right: atkPart, style: 'miss' }
        : { left: 'Miss', right: atkPart, style: 'miss' });
    } else {
      logs.push({ left: 'Miss', right: atkPart, style: 'miss' });
    }
  }

  return { damage, isHit, logs, vexApplied, slowApplied };
}

export function playerMeleeAttack(
  player: PlayerDef,
  enemy: MonsterDef,
  withAdvantage: boolean,
  withDisadvantage = false,
  autoCrit = false,
  playerHidden = false,
): { damage: number; logs: LogEntry[]; vexApplied: boolean; slowApplied: boolean } {
  return resolvePlayerAttack(player, player.mainAttack, enemy, withAdvantage, withDisadvantage, player.proficiencyBonus, autoCrit, playerHidden);
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
): { damage: number; isHit: boolean; logs: LogEntry[]; vexApplied: boolean; slowApplied: boolean } {
  return resolvePlayerAttack(player, attack, enemy, withAdvantage, withDisadvantage, profBonus ?? player.proficiencyBonus, autoCrit, playerHidden);
}

export function playerHide(
  player: PlayerDef,
  enemyPassivePerception: number,
): { hidden: boolean; logs: LogEntry[] } {
  const stealthBonus = player.skills['stealth'] ?? 0;
  const stealthRoll = d20() + stealthBonus;
  const success = stealthRoll > enemyPassivePerception;
  const right = `Stealth d20+${stealthBonus}=${stealthRoll} vs PP ${enemyPassivePerception}`;
  if (success) {
    return { hidden: true, logs: [{ left: `${player.name} slips into the shadows`, right: `${right} ✓`, style: 'status' }] };
  }
  return { hidden: false, logs: [{ left: `${player.name} fails to hide`, right: `${right} ✗`, style: 'miss' }] };
}

export function enemyAttack(
  attack: MonsterAttack,
  playerAc: number,
  withAdvantage: boolean,
  withDisadvantage = false,
): { damage: number; isHit: boolean; isCrit: boolean; logs: LogEntry[] } {
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
  const isCrit = naturalRoll === 20;
  const isHit = (isCrit || attackTotal >= playerAc) && naturalRoll !== 1;
  const atkPart = `${rollPart}+${attack.bonus}=${attackTotal} vs AC ${playerAc}`;

  let damage = 0;
  if (isHit) {
    const diceCount = isCrit ? attack.damageDice * 2 : attack.damageDice;
    const { total: diceTot, rolls: diceRolls } = rollDice(diceCount, attack.damageSides);
    damage = diceTot + attack.damageBonus;
    const diceLabel = isCrit ? `2×${attack.damageDice}d${attack.damageSides}` : `${attack.damageDice}d${attack.damageSides}`;
    const dicePart = `${diceLabel}[${diceRolls.join(',')}]+${attack.damageBonus}`;
    logs.push(isCrit
      ? { left: `⚡ Critical hit — ${damage} ${attack.damageType}`, right: `${atkPart} · ${dicePart}`, style: 'crit' }
      : { left: `Hit — ${damage} ${attack.damageType}`, right: `${atkPart} · ${dicePart}`, style: 'hit' });
  } else {
    logs.push({ left: 'Miss', right: atkPart, style: 'miss' });
  }

  return { damage, isHit, isCrit, logs };
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

export function drinkPotion(item: ConsumableDef): { healed: number; logs: LogEntry[] } {
  const { total: healed, rolls } = rollDice(item.healDice, item.healSides);
  const total = healed + item.healBonus;
  return { healed: total, logs: [{ left: `Drinks ${item.name} — +${total} HP`, right: `${item.healDice}d${item.healSides}[${rolls.join(',')}]+${item.healBonus}`, style: 'heal' }] };
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
