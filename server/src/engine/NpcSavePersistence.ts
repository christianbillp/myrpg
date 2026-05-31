import { readFile, writeFile, mkdir, readdir, unlink, rmdir } from "fs/promises";
import { join } from "path";
import type { NpcSave, NPCDef, NpcFactValue, EntityRef } from "../../../shared/types.js";

/**
 * NpcSavePersistence — disk layer for per-character, per-NPC save files.
 *
 * Layout: `<setting-data-dir>/saves/<characterId>_npcs/<npcId>.json`. Scoped
 * per-character so each playthrough builds its own memory tree of every
 * persistent NPC. Saves are loaded into the GameEngine on session create
 * (one per persistent NPC spawned), mutated in-memory during play, and
 * flushed back at session end / chapter advance.
 *
 * The format is participant-agnostic from day one — `relationship` is keyed
 * by entity ref so future NPC-vs-NPC simulation runs use the same shape
 * without a migration. Today the conversation system writes only `"party"`.
 */

const JOURNAL_CAP = 20;

/** Resolve the directory holding one character's NPC saves. */
function npcSavesDir(settingDataDir: string, characterId: string): string {
  return join(settingDataDir, "saves", `${characterId}_npcs`);
}

/** Build a blank save for an NPC the engine just spawned for the first
 *  time. Used by `loadOrCreateNpcSave` when no file exists yet. */
export function createDefaultNpcSave(npcDef: NPCDef, characterId: string): NpcSave {
  const now = new Date().toISOString();
  return {
    npcId: npcDef.id,
    characterId,
    status: "alive",
    lastSeen: { at: now },
    nameKnownToPlayer: false,
    stateOverrides: {},
    relationship: {},
    facts: {},
    journal: [],
    conversationHistory: [],
  };
}

/** Read an NPC save from disk. Returns `null` when no file exists yet. */
export async function loadNpcSave(settingDataDir: string, characterId: string, npcId: string): Promise<NpcSave | null> {
  const path = join(npcSavesDir(settingDataDir, characterId), `${npcId}.json`);
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as NpcSave;
  } catch {
    return null;
  }
}

/** Read on disk, or create a default save when missing. Always returns a
 *  usable save. Does NOT write to disk — the caller mutates the returned
 *  object in memory; the flush at session end persists. */
export async function loadOrCreateNpcSave(
  settingDataDir: string,
  characterId: string,
  npcDef: NPCDef,
): Promise<NpcSave> {
  const existing = await loadNpcSave(settingDataDir, characterId, npcDef.id);
  return existing ?? createDefaultNpcSave(npcDef, characterId);
}

/** Atomic-ish write — ensures the per-character `_npcs` directory exists
 *  and persists the save. Caller is responsible for stamping `lastSeen`
 *  before calling. */
export async function writeNpcSave(settingDataDir: string, save: NpcSave): Promise<void> {
  const dir = npcSavesDir(settingDataDir, save.characterId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${save.npcId}.json`);
  await writeFile(path, JSON.stringify(save, null, 2) + "\n", "utf-8");
}

/** Bulk-flush — used at session end to push every dirty save in one pass.
 *  The engine tracks dirty status; this helper just writes whatever it's
 *  given. */
export async function flushNpcSaves(settingDataDir: string, saves: NpcSave[]): Promise<void> {
  await Promise.all(saves.map((s) => writeNpcSave(settingDataDir, s)));
}

/** Wipe every NPC save for one character — called when the character save
 *  is deleted so their memory tree doesn't leak into a future replay with
 *  the same id. Best-effort: missing directory is fine. */
export async function deleteAllNpcSavesForCharacter(settingDataDir: string, characterId: string): Promise<void> {
  const dir = npcSavesDir(settingDataDir, characterId);
  try {
    const files = await readdir(dir);
    await Promise.all(files.map((f) => unlink(join(dir, f)).catch(() => undefined)));
    await rmdir(dir).catch(() => undefined);
  } catch { /* dir doesn't exist — nothing to do */ }
}

// ── Mutation helpers ───────────────────────────────────────────────────────
//
// Engine code mutates NpcSave instances in memory; these helpers enforce the
// invariants (clamp ranges, evict on capacity, etc.) so the conversation
// system and AIGM tools can call into a single API.

export function writeFact(
  save: NpcSave,
  fact: string,
  value: NpcFactValue = true,
  source: NpcSave["facts"][string]["source"] = "system",
): void {
  save.facts[fact] = { value, source, recordedAt: new Date().toISOString() };
}

export function clearFact(save: NpcSave, fact: string): void {
  delete save.facts[fact];
}

export function adjustRelationship(save: NpcSave, target: EntityRef, delta: number): number {
  const prev = save.relationship[target] ?? 0;
  const next = Math.max(-100, Math.min(100, prev + delta));
  save.relationship[target] = next;
  return next;
}

export function setRelationship(save: NpcSave, target: EntityRef, value: number): void {
  save.relationship[target] = Math.max(-100, Math.min(100, value));
}

/** Push a journal entry, evicting when capacity is full. Eviction policy:
 *  drop the oldest entry at the lowest salience tier — `1`s go first.
 *  Salience defaults to `2` (notable) so unimportant entries should pass
 *  `salience: 1` explicitly. */
export function pushJournal(
  save: NpcSave,
  text: string,
  source: NpcSave["journal"][number]["source"] = "system",
  salience: 1 | 2 | 3 = 2,
): void {
  save.journal.push({ text, source, salience, recordedAt: new Date().toISOString() });
  while (save.journal.length > JOURNAL_CAP) {
    // Evict the lowest-salience oldest entry. Index 0 is oldest.
    let evictIndex = 0;
    let lowest = save.journal[0].salience ?? 2;
    for (let i = 1; i < save.journal.length; i++) {
      const s = save.journal[i].salience ?? 2;
      if (s < lowest) { lowest = s; evictIndex = i; }
    }
    save.journal.splice(evictIndex, 1);
  }
}

export function setArcPhase(save: NpcSave, phase: string): void {
  save.arc = { phase, updatedAt: new Date().toISOString() };
}

/** Stamp `lastSeen` with the current adventure/chapter/encounter context.
 *  Called at session end and any time the save is flushed mid-session. */
export function stampLastSeen(
  save: NpcSave,
  ctx: { adventureId?: string; chapterId?: string; encounterId?: string },
): void {
  save.lastSeen = {
    at: new Date().toISOString(),
    ...(ctx.adventureId ? { adventureId: ctx.adventureId } : {}),
    ...(ctx.chapterId   ? { chapterId:   ctx.chapterId   } : {}),
    ...(ctx.encounterId ? { encounterId: ctx.encounterId } : {}),
  };
}
