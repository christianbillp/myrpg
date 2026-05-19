export interface ConsumableDef {
  id: string;
  name: string;
  type: 'consumable';
  healDice: number;
  healSides: number;
  healBonus: number;
}

export type ItemDef = ConsumableDef;

export const HEALTH_POTION: ConsumableDef = {
  id: 'health_potion',
  name: 'Health Potion',
  type: 'consumable',
  healDice: 2,
  healSides: 4,
  healBonus: 2,
};
