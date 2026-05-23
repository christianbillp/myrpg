export interface ConsumableDef {
  id: string;
  name: string;
  type: 'consumable';
  healDice: number;
  healSides: number;
  healBonus: number;
}

export type ArmorCategory = 'light' | 'medium' | 'heavy';

export interface ArmorDef {
  id: string;
  name: string;
  type: 'armor';
  category: ArmorCategory;
  baseAc: number;
  addDex: boolean;
  maxDex: number | null;
  stealthDisadv: boolean;
  minStr: number | null;
  cost: number;
}

export interface ShieldDef {
  id: string;
  name: string;
  type: 'shield';
  acBonus: number;
  cost: number;
}

export type WeaponMastery = 'graze' | 'vex' | 'sap' | 'nick' | 'topple' | 'push' | 'cleave' | 'slow';

export interface WeaponDef {
  id: string;
  name: string;
  type: 'weapon';
  statKey: 'str' | 'dex';
  damageDice: number;
  damageSides: number;
  damageType: string;
  mastery: WeaponMastery | null;
  finesse: boolean;
  twoHanded: boolean;
  thrown: boolean;
  throwNormal: number;
  throwLong: number;
  cost: number;
}

export type EquipmentDef = ArmorDef | ShieldDef | WeaponDef;
export type ItemDef = ConsumableDef | EquipmentDef;
