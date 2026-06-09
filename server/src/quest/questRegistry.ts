/**
 * In-memory registry for procedurally-generated quests (replaces
 * `mission/missionRegistry.ts`). Keyed by the quest's base encounter id; a
 * single entry holds the whole quest, including all its stage encounters.
 *
 * Lifecycle mirrors the old mission registry: `recordQuest` on contract roll,
 * `getQuestEncounter` from the transition endpoint (resolving a `#<ordinal>`
 * suffix to the right stage), `dropQuest` on pay-out, and serialise/restore so
 * an in-flight quest survives a reload. Tileset metadata is captured once at
 * startup.
 */
import type { MapTilesetInfo } from '../../../shared/types.js';
import type { GeneratedQuest, GeneratedQuestEncounter } from './questGenTypes.js';
import { parseStageEncounterId, isGeneratedEncounterId } from './questIds.js';

const MAX_QUESTS_IN_FLIGHT = 32;

/** Live registry keyed by base encounter id. Insertion order = free LRU. */
const quests = new Map<string, GeneratedQuest>();

let cachedTilesets: MapTilesetInfo[] | null = null;

export function setGeneratedMapTilesets(tilesets: MapTilesetInfo[]): void {
  cachedTilesets = tilesets;
}

export function getGeneratedMapTilesets(): MapTilesetInfo[] {
  if (!cachedTilesets) {
    throw new Error('Generated map tilesets not initialised. Call setGeneratedMapTilesets() at server startup.');
  }
  return cachedTilesets;
}

export function recordQuest(q: GeneratedQuest): void {
  quests.delete(q.baseEncounterId);
  quests.set(q.baseEncounterId, q);
  while (quests.size > MAX_QUESTS_IN_FLIGHT) {
    const first = quests.keys().next();
    if (first.done) break;
    quests.delete(first.value);
  }
}

export function getQuest(baseEncounterId: string): GeneratedQuest | undefined {
  return quests.get(baseEncounterId);
}

/** Resolve a (possibly `#<ordinal>`-suffixed) generated encounter id to its
 *  quest + the specific stage encounter. */
export function getQuestEncounter(encounterId: string): { quest: GeneratedQuest; encounter: GeneratedQuestEncounter } | undefined {
  const { baseId, ordinal } = parseStageEncounterId(encounterId);
  const quest = quests.get(baseId);
  if (!quest) return undefined;
  const encounter = quest.encounters.find((e) => e.ordinal === ordinal);
  if (!encounter) return undefined;
  return { quest, encounter };
}

export function dropQuest(encounterId: string): void {
  quests.delete(parseStageEncounterId(encounterId).baseId);
}

export { isGeneratedEncounterId };

export function serialiseForSave(): GeneratedQuest[] {
  return Array.from(quests.values());
}

export function restoreFromSave(entries: GeneratedQuest[] | undefined): void {
  quests.clear();
  if (!entries) return;
  for (const q of entries) {
    if (q && typeof q.baseEncounterId === 'string' && Array.isArray(q.encounters) && q.questDef) {
      quests.set(q.baseEncounterId, q);
    }
  }
}

/** Test-only — wipe the registry between vitest suites. */
export function clearQuestRegistry(): void {
  quests.clear();
}
