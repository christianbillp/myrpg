export interface EnemyAttack {
  name: string;
  bonus: number;
  damageDice: number;
  damageSides: number;
  damageBonus: number;
  damageType: string;
}

export interface EnemyDef {
  id: string;
  name: string;
  maxHp: number;
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
  maxHp: 7,
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
      bonus: 4,
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
