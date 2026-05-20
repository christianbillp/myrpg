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
  id: string;
  name: string;
  speciesName: string;
  className: string;
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
  speedFt: number;
  color: number;
  xp: number;
  mainAttack: PlayerAttack;
}
