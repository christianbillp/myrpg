export interface ConsumableDef {
  id: string;
  name: string;
  type: 'consumable';
  healDice: number;
  healSides: number;
  healBonus: number;
}

export type ItemDef = ConsumableDef;

