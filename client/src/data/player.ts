export interface PlayerAttack {
  name: string;
  statKey: 'str' | 'dex';
  damageDice: number;
  damageSides: number;
  savageAttacker: boolean;
  graze: boolean;
  vex: boolean;
}

export interface EquipmentSlots {
  armorId: string | null;
  weaponId: string | null;
  shieldId: string | null;
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
  skills: Record<string, number>;
  savingThrowProficiencies: string[];
  savingThrows: Record<string, number>;
  secondWindMaxUses: number;
  sneakAttackDice: number;
  speed: number;
  speedFt: number;
  color: number;
  xp: number;
  savageAttacker: boolean;
  fightingStyleDefense: boolean;
  defaultEquipment: EquipmentSlots;
  defaultInventoryIds: string[];
  mainAttack: PlayerAttack;
}
