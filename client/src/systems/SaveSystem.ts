import { ItemDef } from '../data/items';
import { ResumeState } from './EncounterManager';
import { EncounterContext, EncounterType } from '../data/encounterContext';

const SAVE_KEY = 'myrpg_save';
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
  /** Write to localStorage and POST to server (fire-and-forget). */
  save(data: SaveData): void {
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    fetch(`${API_URL}/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).catch(() => {});
  },

  /** Fast synchronous read from localStorage. Returns null if no save exists. */
  load(): SaveData | null {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw) as SaveData; } catch { return null; }
  },

  /** Async load from server — used on first boot when localStorage is empty. */
  async loadFromServer(): Promise<SaveData | null> {
    try {
      const res = await fetch(`${API_URL}/save`);
      if (!res.ok) return null;
      const data = await res.json() as SaveData;
      localStorage.setItem(SAVE_KEY, JSON.stringify(data));
      return data;
    } catch {
      return null;
    }
  },

  hasExistingSave(): boolean {
    return localStorage.getItem(SAVE_KEY) !== null;
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

  clear(): void {
    localStorage.removeItem(SAVE_KEY);
    fetch(`${API_URL}/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerDefId: 'aldric', hp: 12, xp: 0, gold: 0, inventoryIds: [], secondWindUses: 2 }),
    }).catch(() => {});
  },
};
