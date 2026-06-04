/**
 * In-memory registry for procedurally-generated missions.
 *
 * Lifecycle:
 *   • `recordMission(m)` — called by the trigger action that rolls a
 *     mission. Adds to the live Map, refreshes the LRU recency.
 *   • `getMission(id)` — looked up by the transition endpoint when the
 *     id starts with `mission_gen_`. Hand-authored missions skip this
 *     and load from disk via `loadEncounterDef`.
 *   • `dropMission(id)` — called when the world tick observes
 *     `mission_complete && mission_reward_claimed`. The contract is
 *     paid; the generated content can be released.
 *   • `serialiseForSave()` / `restoreFromSave(...)` — write the live
 *     mission alongside the WorldSave so a player who quits mid-mission
 *     can reload to find Vask's slip + the procedural map intact.
 *
 * Capacity guard: missions are small (~tens of KB) but a long-running
 * dev session with many TO MISSION → LEAVE MISSION cycles could pile
 * up unclaimed missions. Capped at `MAX_MISSIONS_IN_FLIGHT` with LRU
 * eviction. Hand-authored content never enters the registry so the cap
 * only affects procedural rollouts.
 *
 * Tileset metadata is captured once at startup via
 * `setGeneratedMapTilesets` (called from the defs-load path) so the
 * generator doesn't have to read .tsj files itself.
 */
import type { MapTilesetInfo } from "../../../shared/types.js";
import type { GeneratedMission } from "./missionGenerator.js";

const MAX_MISSIONS_IN_FLIGHT = 32;

/** Live registry of generated missions keyed by mission id. Insertion
 *  order is preserved (Map semantics), which gives us free LRU. */
const missions = new Map<string, GeneratedMission>();

/** Cached tileset metadata for procedural maps. Populated by
 *  `setGeneratedMapTilesets` at server startup; the generator reads
 *  it via `getGeneratedMapTilesets`. */
let cachedTilesets: MapTilesetInfo[] | null = null;
let cachedDisabledScribble: Set<number> = new Set();

export function setGeneratedMapTilesets(tilesets: MapTilesetInfo[]): void {
  cachedTilesets = tilesets;
}

export function setGeneratedMapDisabledScribble(ids: Set<number>): void {
  cachedDisabledScribble = ids;
}

export function getGeneratedMapTilesets(): MapTilesetInfo[] {
  if (!cachedTilesets) {
    throw new Error('Generated map tilesets not initialised. Call setGeneratedMapTilesets() at server startup.');
  }
  return cachedTilesets;
}

export function getGeneratedMapDisabledScribble(): Set<number> {
  return cachedDisabledScribble;
}

export function recordMission(m: GeneratedMission): void {
  // LRU touch — delete then re-insert so the most-recent entry sits at
  // the end of the Map's insertion order.
  missions.delete(m.missionId);
  missions.set(m.missionId, m);
  // Cap enforcement — drop the oldest entries (front of insertion order).
  while (missions.size > MAX_MISSIONS_IN_FLIGHT) {
    const first = missions.keys().next();
    if (first.done) break;
    missions.delete(first.value);
  }
}

export function getMission(missionId: string): GeneratedMission | undefined {
  return missions.get(missionId);
}

export function dropMission(missionId: string): void {
  missions.delete(missionId);
}

/** True when an id looks like a generated mission (saves a string
 *  prefix check from leaking into every call site). */
export function isGeneratedMissionId(id: string | undefined): boolean {
  return typeof id === 'string' && id.startsWith('mission_gen_');
}

/** Serialise the live missions to a JSON-safe shape. Embedded in the
 *  WorldSave so a player who reloads finds Vask's contract intact. */
export function serialiseForSave(): GeneratedMission[] {
  return Array.from(missions.values());
}

/** Replace the live registry with the saved snapshot. Called on world
 *  load. Idempotent — clears prior in-memory state first. */
export function restoreFromSave(entries: GeneratedMission[] | undefined): void {
  missions.clear();
  if (!entries) return;
  for (const m of entries) {
    // Defensive: only restore entries that look well-formed.
    if (m && typeof m.missionId === 'string' && m.encounterDef && m.savedMap) {
      missions.set(m.missionId, m);
    }
  }
}

/** Test-only — wipe the registry between vitest suites. */
export function clearMissionRegistry(): void {
  missions.clear();
}
