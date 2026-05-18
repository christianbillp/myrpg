export interface PlayerAttack {
  name: string;
  statKey: 'str' | 'dex';
  damageDice: number;
  damageSides: number;
  savageAttacker: boolean;
  graze: boolean;
  vex: boolean;
}

export interface PlayerDef {
  name: string;
  level: number;
  maxHp: number;
  ac: number;
  str: number;
  dex: number;
  con: number;
  int: number;
  wis: number;
  cha: number;
  proficiencyBonus: number;
  perceptionBonus: number;
  secondWindMaxUses: number;
  sneakAttackDice: number;
  stealthBonus: number;
  speed: number;
  color: number;
  xp: number;
  mainAttack: PlayerAttack;
}

export const ALDRIC: PlayerDef = {
  name: 'Aldric Vane',
  level: 1,
  maxHp: 12,
  ac: 17,
  str: 17,
  dex: 14,
  con: 14,
  int: 8,
  wis: 10,
  cha: 12,
  proficiencyBonus: 2,
  perceptionBonus: 2,
  secondWindMaxUses: 2,
  sneakAttackDice: 0,
  stealthBonus: 2,
  speed: 6,
  color: 0x4fc3f7,
  xp: 0,
  mainAttack: {
    name: 'Greatsword',
    statKey: 'str',
    damageDice: 2,
    damageSides: 6,
    savageAttacker: true,
    graze: true,
    vex: false,
  },
};

export const MIRIEL: PlayerDef = {
  name: 'Miriel Duskwhisper',
  level: 1,
  maxHp: 9,
  ac: 14,
  str: 12,
  dex: 17,
  con: 13,
  int: 15,
  wis: 10,
  cha: 8,
  proficiencyBonus: 2,
  perceptionBonus: 2,
  secondWindMaxUses: 0,
  sneakAttackDice: 1,
  stealthBonus: 7,
  speed: 7,
  color: 0x9b59b6,
  xp: 0,
  mainAttack: {
    name: 'Shortsword',
    statKey: 'dex',
    damageDice: 1,
    damageSides: 6,
    savageAttacker: false,
    graze: false,
    vex: true,
  },
};
