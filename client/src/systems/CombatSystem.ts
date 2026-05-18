import { d, d20, mod } from './Dice';
import { PlayerDef } from '../data/player';
import { EnemyDef } from '../data/enemies';

export function rollInitiative(
  player: PlayerDef,
  enemy: EnemyDef,
): { playerFirst: boolean; logs: string[] } {
  const pRoll = d20();
  const eRoll = d20();
  const pMod = mod(player.dex);
  const eMod = mod(enemy.dex);
  const pTotal = pRoll + pMod;
  const eTotal = eRoll + eMod;
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
  enemy: EnemyDef,
): { damage: number; logs: string[] } {
  const strMod = mod(player.str);
  const attackBonus = strMod + player.proficiencyBonus;
  const naturalRoll = d20();
  const total = naturalRoll + attackBonus;
  const isCrit = naturalRoll === 20;
  const isHit = isCrit || total >= enemy.ac;
  const logs: string[] = [];

  logs.push(`${player.name} swings the Greatsword!`);
  logs.push(`Attack: d20(${naturalRoll})+${attackBonus} = ${total} vs AC ${enemy.ac}`);

  let damage = 0;

  if (isCrit) {
    const dice = d(6) + d(6) + d(6) + d(6);
    damage = dice + strMod;
    logs.push(`⚡ CRITICAL HIT! 4d6+${strMod} = ${dice}+${strMod} = ${damage} slashing`);
  } else if (isHit) {
    const roll1 = d(6) + d(6);
    const roll2 = d(6) + d(6);
    const best = Math.max(roll1, roll2);
    damage = best + strMod;
    logs.push(`HIT! Savage Attacker: [${roll1}] vs [${roll2}] → ${best}+${strMod} = ${damage} slashing`);
  } else {
    damage = Math.max(0, strMod);
    if (damage > 0) {
      logs.push(`Miss! (${total} vs AC ${enemy.ac}) — Graze: ${damage} slashing`);
    } else {
      logs.push(`Miss! (${total} vs AC ${enemy.ac})`);
    }
  }

  return { damage, logs };
}

export function enemyDaggerAttack(
  enemy: EnemyDef,
  playerAc: number,
  withAdvantage: boolean,
): { damage: number; isHit: boolean; isCrit: boolean; logs: string[] } {
  const attack = enemy.attacks[0];
  const logs: string[] = [];

  let naturalRoll: number;
  let rollDesc: string;

  if (withAdvantage) {
    const r1 = d20();
    const r2 = d20();
    naturalRoll = Math.max(r1, r2);
    rollDesc = `advantage (${r1}, ${r2}) → ${naturalRoll}`;
  } else {
    naturalRoll = d20();
    rollDesc = `${naturalRoll}`;
  }

  const attackTotal = naturalRoll + attack.bonus;
  const isCrit = naturalRoll === 20;
  const isHit = isCrit || attackTotal >= playerAc;

  logs.push(`${enemy.name} attacks with ${attack.name}!`);
  logs.push(`d20(${rollDesc})+${attack.bonus} = ${attackTotal} vs AC ${playerAc}`);

  let damage = 0;
  if (isHit) {
    if (isCrit) {
      damage = d(attack.damageSides) + d(attack.damageSides) + attack.damageBonus;
      logs.push(`⚡ CRITICAL HIT! ${damage} ${attack.damageType}`);
    } else {
      damage = d(attack.damageSides) + attack.damageBonus;
      logs.push(`Hit! ${damage} ${attack.damageType}`);
    }
  } else {
    logs.push(`Miss! (${attackTotal} vs AC ${playerAc})`);
  }

  return { damage, isHit, isCrit, logs };
}

export function tryNimbleEscape(
  enemy: EnemyDef,
  passivePerception: number,
): { hidden: boolean; logs: string[] } {
  const stealthRoll = d20() + enemy.stealthBonus;
  if (stealthRoll > passivePerception) {
    return {
      hidden: true,
      logs: [
        `${enemy.name} uses Nimble Escape → Hide!`,
        `Stealth: d20+${enemy.stealthBonus} = ${stealthRoll} vs Perception ${passivePerception} ✓`,
      ],
    };
  }
  return {
    hidden: false,
    logs: [`${enemy.name} tries to hide... ${stealthRoll} vs ${passivePerception} — spotted!`],
  };
}

export function playerSecondWind(level: number): { healed: number; logs: string[] } {
  const healRoll = d(10);
  const healed = healRoll + level;
  return {
    healed,
    logs: [`Second Wind! 1d10+${level}: ${healRoll}+${level} = ${healed} HP restored`],
  };
}

export function rollDeathSave(): { roll: number; outcome: 'nat20' | 'success' | 'failure' | 'nat1' } {
  const roll = d20();
  if (roll === 20) return { roll, outcome: 'nat20' };
  if (roll === 1) return { roll, outcome: 'nat1' };
  return { roll, outcome: roll >= 10 ? 'success' : 'failure' };
}
