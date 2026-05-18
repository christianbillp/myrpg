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
  xp: number;
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
  xp: 0,
};
