export function crGoldReward(cr: string): number {
  if (cr.includes('/')) {
    const [num, den] = cr.split('/').map(Number);
    return Math.floor(10 * num / den);
  }
  return 10 * Number(cr);
}

export interface EnemyAttack {
  name: string;
  attackType: 'melee' | 'ranged' | 'both';
  bonus: number;
  reach: number;
  rangeNormal?: number;
  rangeLong?: number;
  damageDice: number;
  damageSides: number;
  damageBonus: number;
  damageType: string;
}

export interface EnemyDef {
  id: string;
  name: string;
  type: string;
  maxHp: number;
  hpFormula: string;
  ac: number;
  str: number;
  dex: number;
  con: number;
  int: number;
  wis: number;
  cha: number;
  proficiencyBonus: number;
  stealthBonus: number;
  passivePerception: number;
  speed: number;
  speedFt: number;
  attacks: EnemyAttack[];
  xp: number;
  cr: string;
  color: number;
}

export const GOBLIN_MINION: EnemyDef = {
  id: 'goblin_minion',
  name: 'Goblin Minion',
  type: 'Small Fey (Goblinoid), Chaotic Neutral',
  maxHp: 7,
  hpFormula: '2d6',
  ac: 12,
  str: 8,
  dex: 15,
  con: 10,
  int: 10,
  wis: 8,
  cha: 8,
  proficiencyBonus: 2,
  stealthBonus: 6,
  passivePerception: 9,
  speed: 6,
  speedFt: 30,
  attacks: [
    {
      name: 'Dagger',
      attackType: 'both',
      bonus: 4,
      reach: 5,
      rangeNormal: 20,
      rangeLong: 60,
      damageDice: 1,
      damageSides: 4,
      damageBonus: 2,
      damageType: 'piercing',
    },
  ],
  xp: 25,
  cr: '1/8',
  color: 0xe74c3c,
};

export const BANDIT: EnemyDef = {
  id: 'bandit',
  name: 'Bandit',
  type: 'Medium or Small Humanoid, Neutral',
  maxHp: 11,
  hpFormula: '2d8+2',
  ac: 12,
  str: 11,
  dex: 12,
  con: 12,
  int: 10,
  wis: 10,
  cha: 10,
  proficiencyBonus: 2,
  stealthBonus: 1,
  passivePerception: 10,
  speed: 6,
  speedFt: 30,
  attacks: [
    {
      name: 'Scimitar',
      attackType: 'melee',
      bonus: 3,
      reach: 5,
      damageDice: 1,
      damageSides: 6,
      damageBonus: 1,
      damageType: 'slashing',
    },
    {
      name: 'Light Crossbow',
      attackType: 'ranged',
      bonus: 3,
      reach: 5,
      rangeNormal: 80,
      rangeLong: 320,
      damageDice: 1,
      damageSides: 8,
      damageBonus: 1,
      damageType: 'piercing',
    },
  ],
  xp: 25,
  cr: '1/8',
  color: 0xe67e22,
};
