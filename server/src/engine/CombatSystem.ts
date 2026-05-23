import { d, d20, mod, rollAdvantage, rollDisadvantage } from './Dice.js';
import { PlayerDef, MonsterDef, MonsterAttack, ConsumableDef } from './types.js';

export function rollInitiative(
  player: PlayerDef,
  enemy: MonsterDef,
): { playerFirst: boolean; logs: string[] } {
  const pRoll = d20(), eRoll = d20();
  const pMod = mod(player.dex), eMod = enemy.initiativeBonus;
  const pTotal = pRoll + pMod, eTotal = eRoll + eMod;
  const playerFirst = pTotal >= eTotal;
  return {
    playerFirst,
    logs: [
      '⚔ COMBAT BEGINS',
      `${player.name}: d20(${pRoll})+${pMod} = ${pTotal}`,
      `${enemy.name}: d20(${eRoll})+${eMod} = ${eTotal}`,
      playerFirst ? `${player.name} acts first!` : `${enemy.name} acts first!`,
    ],
  };
}

export function playerMeleeAttack(
  player: PlayerDef,
  enemy: MonsterDef,
  withAdvantage: boolean,
  withDisadvantage = false,
): { damage: number; logs: string[]; vexApplied: boolean } {
  const attack = player.mainAttack;
  const statMod = attack.statKey === 'str' ? mod(player.str) : mod(player.dex);
  const attackBonus = statMod + player.proficiencyBonus;
  const logs: string[] = [];

  const effAdv = withAdvantage && !withDisadvantage;
  const effDis = withDisadvantage && !withAdvantage;

  let naturalRoll: number, rollDesc: string;
  if (effAdv) {
    const { result, rolls } = rollAdvantage();
    naturalRoll = result;
    rollDesc = `advantage (${rolls[0]}, ${rolls[1]}) → ${naturalRoll}`;
    logs.push(`${player.name} attacks from the shadows!`);
  } else if (effDis) {
    const { result, rolls } = rollDisadvantage();
    naturalRoll = result;
    rollDesc = `disadvantage (${rolls[0]}, ${rolls[1]}) → ${naturalRoll}`;
  } else {
    naturalRoll = d20();
    rollDesc = `${naturalRoll}`;
  }

  const total = naturalRoll + attackBonus;
  const isCrit = naturalRoll === 20;
  const isHit = isCrit || total >= enemy.ac;
  logs.push(`Attack: d20(${rollDesc})+${attackBonus} = ${total} vs AC ${enemy.ac}`);

  let damage = 0, vexApplied = false;
  if (isCrit) {
    let dice = 0;
    for (let i = 0; i < attack.damageDice * 2; i++) dice += d(attack.damageSides);
    let sneakDice = 0;
    if (withAdvantage && player.sneakAttackDice > 0)
      for (let i = 0; i < player.sneakAttackDice * 2; i++) sneakDice += d(6);
    damage = dice + statMod + sneakDice;
    const sneakPart = sneakDice > 0 ? ` + ${sneakDice} Sneak Attack` : '';
    logs.push(`⚡ CRITICAL HIT! ${dice}+${statMod}${sneakPart} = ${damage}`);
    vexApplied = attack.vex;
  } else if (isHit) {
    let dice = 0;
    if (attack.savageAttacker) {
      let r1 = 0, r2 = 0;
      for (let i = 0; i < attack.damageDice; i++) { r1 += d(attack.damageSides); r2 += d(attack.damageSides); }
      dice = Math.max(r1, r2);
      logs.push(`HIT! Savage Attacker: [${r1}] vs [${r2}] → ${dice}+${statMod}`);
    } else {
      for (let i = 0; i < attack.damageDice; i++) dice += d(attack.damageSides);
      logs.push(`HIT! ${dice}+${statMod}`);
    }
    let sneakDice = 0;
    if (withAdvantage && player.sneakAttackDice > 0) {
      for (let i = 0; i < player.sneakAttackDice; i++) sneakDice += d(6);
      logs.push(`Sneak Attack: +${sneakDice}`);
    }
    damage = dice + statMod + sneakDice;
    logs.push(`Total: ${damage} damage`);
    vexApplied = attack.vex;
  } else {
    if (attack.graze) {
      damage = Math.max(0, statMod);
      logs.push(damage > 0 ? `Miss! Graze: ${damage} damage` : `Miss! (${total} vs AC ${enemy.ac})`);
    } else {
      logs.push(`Miss! (${total} vs AC ${enemy.ac})`);
    }
  }
  return { damage, logs, vexApplied };
}

export function playerHide(
  player: PlayerDef,
  enemyPassivePerception: number,
): { hidden: boolean; logs: string[] } {
  const stealthBonus = player.skills['stealth'] ?? 0;
  const stealthRoll = d20() + stealthBonus;
  if (stealthRoll > enemyPassivePerception) {
    return { hidden: true, logs: [`${player.name} hides!`, `Stealth: d20+${stealthBonus} = ${stealthRoll} vs Perception ${enemyPassivePerception} ✓`] };
  }
  return { hidden: false, logs: [`${player.name} tries to hide... ${stealthRoll} vs ${enemyPassivePerception} — spotted!`] };
}

export function enemyAttack(
  enemy: MonsterDef,
  attack: MonsterAttack,
  playerAc: number,
  withAdvantage: boolean,
  withDisadvantage = false,
): { damage: number; isHit: boolean; isCrit: boolean; logs: string[] } {
  const logs: string[] = [];
  const effAdv = withAdvantage && !withDisadvantage;
  const effDis = withDisadvantage && !withAdvantage;

  let naturalRoll: number, rollDesc: string;
  if (effAdv) {
    const { result, rolls } = rollAdvantage();
    naturalRoll = result; rollDesc = `advantage (${rolls[0]}, ${rolls[1]}) → ${naturalRoll}`;
  } else if (effDis) {
    const { result, rolls } = rollDisadvantage();
    naturalRoll = result; rollDesc = `disadvantage (${rolls[0]}, ${rolls[1]}) → ${naturalRoll}`;
  } else {
    naturalRoll = d20(); rollDesc = `${naturalRoll}`;
  }

  const attackTotal = naturalRoll + attack.bonus;
  const isCrit = naturalRoll === 20;
  const isHit = isCrit || attackTotal >= playerAc;
  logs.push(`${enemy.name} attacks with ${attack.name}!`);
  logs.push(`d20(${rollDesc})+${attack.bonus} = ${attackTotal} vs AC ${playerAc}`);

  let damage = 0;
  if (isHit) {
    let dice = 0;
    const diceCount = isCrit ? attack.damageDice * 2 : attack.damageDice;
    for (let i = 0; i < diceCount; i++) dice += d(attack.damageSides);
    damage = dice + attack.damageBonus;
    logs.push(isCrit
      ? `⚡ CRITICAL HIT! ${dice}+${attack.damageBonus} = ${damage} ${attack.damageType}`
      : `Hit! ${dice}+${attack.damageBonus} = ${damage} ${attack.damageType}`);
  } else {
    logs.push(`Miss! (${attackTotal} vs AC ${playerAc})`);
  }
  return { damage, isHit, isCrit, logs };
}

export function tryNimbleEscape(
  enemy: MonsterDef,
  passivePerception: number,
): { hidden: boolean; logs: string[] } {
  const stealthRoll = d20() + enemy.stealthBonus;
  if (stealthRoll > passivePerception) {
    return { hidden: true, logs: [`${enemy.name} uses Nimble Escape → Hide!`, `Stealth: d20+${enemy.stealthBonus} = ${stealthRoll} vs Perception ${passivePerception} ✓`] };
  }
  return { hidden: false, logs: [`${enemy.name} tries to hide... ${stealthRoll} vs ${passivePerception} — spotted!`] };
}

export function playerSecondWind(level: number): { healed: number; logs: string[] } {
  const healRoll = d(10);
  const healed = healRoll + level;
  return { healed, logs: [`Second Wind! 1d10+${level}: ${healRoll}+${level} = ${healed} HP restored`] };
}

export function drinkPotion(item: ConsumableDef): { healed: number; logs: string[] } {
  const rolls: number[] = [];
  for (let i = 0; i < item.healDice; i++) rolls.push(d(item.healSides));
  const healed = rolls.reduce((a, b) => a + b, 0) + item.healBonus;
  return { healed, logs: [`Drinks ${item.name}! ${item.healDice}d${item.healSides}+${item.healBonus}: [${rolls.join(', ')}]+${item.healBonus} = ${healed} HP`] };
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
): { roll: number; total: number; success: boolean } {
  const roll = d20();
  const total = roll + skillMod;
  return { roll, total, success: total >= dc };
}
