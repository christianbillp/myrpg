export interface NPCDef {
  id: string;
  name: string;
  type: string;
  color: number;
  ac: number;
  maxHp: number;
  speedFt: number;
  str: number;
  dex: number;
  con: number;
  int: number;
  wis: number;
  cha: number;
  cr: string;
}

export const COMMONER: NPCDef = {
  id: "commoner",
  name: "Commoner",
  type: "Medium Humanoid",
  color: 0xd4a57a,
  ac: 10,
  maxHp: 4,
  speedFt: 30,
  str: 10,
  dex: 10,
  con: 10,
  int: 10,
  wis: 10,
  cha: 10,
  cr: "0",
};
