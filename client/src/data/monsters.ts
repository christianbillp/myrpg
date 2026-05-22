export interface MonsterAttack {
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

export interface NPCDef {
  id: string;
  name: string;
  monsterClass: string;
  color: number;
  persona?: string;
}

export interface MonsterDef {
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
  savingThrows: Record<string, number>;
  initiativeBonus: number;
  stealthBonus: number;
  passivePerception: number;
  speed: number;
  speedFt: number;
  attacks: MonsterAttack[];
  xp: number;
  cr: string;
  color: number;
}
