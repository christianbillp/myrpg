import { ItemDef } from '../data/items';
import { ResumeState } from './EncounterManager';
import { EncounterContext, EncounterType } from '../data/encounterContext';

const LAST_CHAR_KEY = 'myrpg_last_character';
const saveKey = (characterId: string) => `myrpg_save_${characterId}`;
const API_URL = 'http://localhost:3000';

export interface SaveData {
  playerDefId: string;
  hp: number;
  xp: number;
  gold: number;
  inventoryIds: string[];
  secondWindUses: number;
  encounterContext?: EncounterContext;
}

export interface EncounterStartConfig {
  encounterTypes: EncounterType[];
  mapType: 'open' | 'rooms' | 'saved';
  playerDefId: string;
  playerName: string;
  playerSpeciesName: string;
  playerClassName: string;
  playerLevel: number;
  playerMaxHp: number;
  playerAc: number;
  savedMapName?: string;
  savedMapDescription?: string;
}

export function resumeFromSave(save: SaveData, items: ItemDef[]): ResumeState {
  const itemsById = Object.fromEntries(items.map((i) => [i.id, i]));
  return {
    hp: save.hp,
    xp: save.xp,
    gold: save.gold,
    inventory: save.inventoryIds.map((id) => itemsById[id]).filter(Boolean) as ItemDef[],
    secondWindUses: save.secondWindUses,
  };
}

export const SaveSystem = {
  /** Write to localStorage (keyed by character) and POST to server. */
  save(data: SaveData): void {
    localStorage.setItem(saveKey(data.playerDefId), JSON.stringify(data));
    localStorage.setItem(LAST_CHAR_KEY, data.playerDefId);
    fetch(`${API_URL}/save/${data.playerDefId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).catch(() => {});
  },

  load(characterId: string): SaveData | null {
    const raw = localStorage.getItem(saveKey(characterId));
    if (!raw) return null;
    try { return JSON.parse(raw) as SaveData; } catch { return null; }
  },

  async loadFromServer(characterId: string): Promise<SaveData | null> {
    try {
      const res = await fetch(`${API_URL}/save/${characterId}`);
      if (!res.ok) return null;
      const data = await res.json() as SaveData;
      localStorage.setItem(saveKey(characterId), JSON.stringify(data));
      localStorage.setItem(LAST_CHAR_KEY, characterId);
      return data;
    } catch {
      return null;
    }
  },

  hasExistingSave(characterId: string): boolean {
    return localStorage.getItem(saveKey(characterId)) !== null;
  },

  getLastCharacterId(): string | null {
    return localStorage.getItem(LAST_CHAR_KEY);
  },

  /** POST encounter config to server, which generates the context and persists it in the save file. */
  async startEncounter(config: EncounterStartConfig): Promise<EncounterContext | null> {
    try {
      const res = await fetch(`${API_URL}/encounter/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (!res.ok) return null;
      return await res.json() as EncounterContext;
    } catch {
      return null;
    }
  },

  clear(characterId: string): void {
    localStorage.removeItem(saveKey(characterId));
    localStorage.removeItem(LAST_CHAR_KEY);
  },
};
