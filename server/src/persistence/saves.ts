/**
 * Save persistence — world / character / adventure save files and their
 * load-time migrations. Extracted from the index.ts god-file; the index
 * injects its runtime singletons once at boot via `initSavesPersistence`
 * (the same dependency-injection shape as routes/ctx.ts) so this module has
 * no import-time coupling to the server bootstrap.
 */
import { z } from 'zod';
import { readFile, writeFile, mkdir, unlink, access } from 'fs/promises';
import { join } from 'path';
import { Logger } from '../Logger.js';
import { safeId } from '../util/requestValidation.js';
import { deriveRelationshipsFromDispositions } from '../engine/Relationships.js';
import { serialiseForSave as serialiseQuestsForSave, restoreFromSave as restoreQuestsFromSave } from '../quest/questRegistry.js';
import type { GeneratedQuest } from '../quest/questGenTypes.js';
import type { AigmMessage } from '../sessions.js';
import type { EncounterRecord, StorylogEntry } from '../storylog.js';
import type { GameDefs } from '../engine/types.js';
import type {
  GameState, PlayerState, EquipmentSlots, AdventureSave, QuestState, QuestDef,
} from '../../../shared/types.js';

interface SavesPersistenceDeps {
  dataDir: string;
  getDefs: () => GameDefs;
}
let deps: SavesPersistenceDeps;

/** Called once at boot, after defs are constructed. */
export function initSavesPersistence(d: SavesPersistenceDeps): void { deps = d; }

export function savesDir(): string {
  const setting = deps.getDefs().activeSetting;
  if (!setting) throw new Error("Cannot resolve saves path — no active setting.");
  return join(deps.dataDir, "settings", setting.id, "saves");
}
export function worldSavePath(): string {
  return join(savesDir(), "world.json");
}
export function saveFilePath(characterId: string): string {
  return join(savesDir(), `${safeId(characterId)}.json`);
}
export function adventureSaveFilePath(characterId: string): string {
  return join(savesDir(), `${safeId(characterId)}_adventure.json`);
}

// Persistent player stats live in the character save; the world save only keeps
// session-specific player fields (position, turn flags, death saves).
type SessionPlayerState = Pick<
  PlayerState,
  | "defId"
  | "tileX"
  | "tileY"
  | "actionUsed"
  | "bonusActionUsed"
  | "movesLeft"
  | "deathSaveSuccesses"
  | "deathSaveFailures"
>;
// WorldSave omits persistent player stats (stored in char save) and keeps session state.
// The 'enemies' field existed in the pre-disposition format — its presence signals an old save.
export type WorldSave = Omit<GameState, "player"> & {
  player: SessionPlayerState;
  enemies?: unknown;
  /** Legacy spelling of `encounterComplete` — read by the migration shim
   *  in `loadWorldSave` so saves written before the rename still resume. */
  chapterComplete?: boolean;
  aigmHistory?: AigmMessage[];
  /** Procedurally-generated quests live for the duration of one Vask
   *  contract cycle. Without this they'd evaporate on cold reload —
   *  the registry is in-memory only. Persisted as opaque blobs; the
   *  loader hands them straight back to `restoreQuestsFromSave`. */
  inFlightMissions?: GeneratedQuest[];
};

export interface CharSave {
  playerDefId: string;
  hp: number;
  xp: number;
  /** Coin purse balance in Copper Pieces — see `shared/currency.ts`. */
  balanceCp: number;
  inventoryIds: string[];
  equippedSlots?: EquipmentSlots;
  spellSlots?: number[];
  preparedSpellIds?: string[];
  /** Per-feature resource pools (Second Wind uses, Rage uses, Channel Divinity, …). */
  resources?: Record<string, number>;
  encounterLog?: EncounterRecord[];
  storylog?: StorylogEntry[];
  /** Level-up history — one entry per level above 1. Replayed at session
   *  start so the engine's per-session PlayerDef reaches the character's
   *  current level with the recorded choices. */
  levelUps?: import("../../../shared/types.js").LevelUpChoices[];
}

/** Quests that survive a chapter boundary: adventure/world scope only (encounter
 *  scope dies with the encounter), plus the runtime defs they reference. */
export function carryForwardQuests(state: GameState): { quests: QuestState[]; runtimeQuestDefs: QuestDef[] } {
  const scopeOf = (id: string): string | undefined =>
    state.runtimeQuestDefs.find((d) => d.id === id)?.scope ?? deps.getDefs().quests.find((d) => d.id === id)?.scope;
  const quests = state.quests.filter((q) => { const sc = scopeOf(q.questId); return sc === 'adventure' || sc === 'world'; });
  const keep = new Set(quests.map((q) => q.questId));
  return { quests, runtimeQuestDefs: state.runtimeQuestDefs.filter((d) => keep.has(d.id)) };
}

export async function saveWorldState(
  state: GameState,
  aigmHistory: AigmMessage[] = [],
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const {
    hp: _hp,
    xp: _xp,
    balanceCp: _balanceCp,
    inventoryIds: _inv,
    equippedSlots: _eq,
    resources: _r,
    spellSlots: _ss,
    preparedSpellIds: _ps,
    ...sessionPlayer
  } = state.player;
  const worldSave: WorldSave = {
    ...state,
    player: sessionPlayer,
    aigmHistory,
    inFlightMissions: serialiseQuestsForSave(),
  };
  await mkdir(savesDir(), { recursive: true });
  const path = worldSavePath();
  await writeFile(path, JSON.stringify(worldSave));
  Logger.log('persist.save_written', {
    kind: 'world',
    path,
    npcs: state.npcs.length,
    phase: state.phase,
    eventLogLength: (state.eventLog ?? []).length,
  });
}

export async function loadWorldState(): Promise<{
  state: GameState;
  aigmHistory: AigmMessage[];
} | null> {
  let worldSave: WorldSave;
  const migrationsApplied: string[] = [];
  try {
    const rawJson = JSON.parse(
      await readFile(worldSavePath(), "utf-8"),
    ) as Record<string, unknown>;
    // Migrate older saves authored before `combatLog` → `eventLog` rename.
    // Reading state always carries the new field name so downstream code
    // (HUD, AIGM context builder, etc.) doesn't blow up on undefined.
    if ("combatLog" in rawJson && !("eventLog" in rawJson)) {
      rawJson.eventLog = rawJson.combatLog;
      delete rawJson.combatLog;
      migrationsApplied.push('combatLog→eventLog');
    }
    // Migrate saves authored before the `passable` → `blocksMovement` rename.
    // The old grid stored walkability (true = walkable); the new model stores
    // blocking (true = blocked). Sight blocking mirrors movement for migrated
    // walls (the "all walls block sight" conversion).
    const savedMap = rawJson.map as Record<string, unknown> | undefined;
    if (savedMap && Array.isArray(savedMap.passable) && !savedMap.blocksMovement) {
      const passable = savedMap.passable as boolean[][];
      const inverted = passable.map((row) => row.map((p) => !p));
      savedMap.blocksMovement = inverted;
      savedMap.blocksSight = inverted.map((row) => [...row]);
      delete savedMap.passable;
      migrationsApplied.push('passable→blocksMovement/blocksSight');
    }
    // Shape-light runtime check — a corrupt save shouldn't crash with a
    // mysterious "Cannot read X of undefined" at use time. The full type is
    // a 100+ field GameState; we validate only the fields the loader path
    // actually touches before handing the rest off to downstream code.
    const SaveShape = z.object({
      eventLog:    z.array(z.unknown()).optional(),
      phase:       z.string(),
      npcs:        z.array(z.unknown()),
      playerDefId: z.string().optional(),
      aigmHistory: z.array(z.unknown()).optional(),
    }).passthrough();
    const parsed = SaveShape.safeParse(rawJson);
    if (!parsed.success) {
      Logger.log('persist.save_load_failed', { kind: 'world', reason: 'shape_mismatch', issues: parsed.error.issues }, 'error');
      return null;
    }
    worldSave = parsed.data as WorldSave;
  } catch {
    Logger.log('persist.save_load_failed', { kind: 'world', path: worldSavePath(), reason: 'parse_or_missing' });
    return null;
  }
  // Reject pre-disposition saves that still carry a separate 'enemies' array
  if ("enemies" in worldSave) {
    Logger.warn('persist.save_load_rejected', { kind: 'world', reason: 'pre_disposition_format' });
    return null;
  }
  Logger.log('persist.save_loaded', {
    kind: 'world',
    path: worldSavePath(),
    migrationsApplied,
    npcs: (worldSave.npcs ?? []).length,
  });

  const charSave = (await readSave(worldSave.player.defId)) as CharSave;
  const fullPlayer: PlayerState = {
    ...worldSave.player,
    hp: charSave.hp,
    xp: charSave.xp,
    balanceCp: charSave.balanceCp,
    inventoryIds: charSave.inventoryIds ?? [],
    equippedSlots: charSave.equippedSlots ?? {
      armorId: null,
      weaponId: null,
      shieldId: null,
    },
    resources: charSave.resources ?? {},
    // Recomputed by GameEngine constructor's `applyEquipment` pass — initial
    // value just has to be present and type-correct.
    ac: 10,
    reactionUsed: false,
    freeObjectInteractionUsed: false,
    initiativeRoll: 0,
    hitDiceUsed: 0,
    tempHp: 0,
    heroicInspiration: false,
    exhaustionLevel: 0,
    conditions: [],
    equippedSlotLabels: { armor: null, weapon: null, shield: null },
    spellSlots: charSave.spellSlots ?? [],
    preparedSpellIds: charSave.preparedSpellIds ?? [],
    concentratingOn: null,
    mageArmor: false,
    shieldActive: false,
    speedBonus: 0,
    expeditiousRetreat: false,
    jumpMultiplier: 1,
    magicWeaponBonus: 0,
    seeInvisible: false,
    ongoingEffects: [],
  };
  const aigmHistory = worldSave.aigmHistory ?? [];
  // Backfill GameState fields added since the save was written. World saves
  // from before the living-world layer landed lack these — without defaults,
  // first publish on the bus would crash on undefined.
  const state: GameState = {
    ...worldSave,
    player: fullPlayer,
    pendingReaction: worldSave.pendingReaction ?? null,
    pendingReroll: worldSave.pendingReroll ?? null,
    pendingCombatStart: worldSave.pendingCombatStart ?? null,
    triggers: worldSave.triggers ?? [],
    firedTriggerIds: worldSave.firedTriggerIds ?? [],
    pendingAigmEvents: worldSave.pendingAigmEvents ?? [],
    worldFlags: worldSave.worldFlags ?? {},
    quests: worldSave.quests ?? [],
    runtimeQuestDefs: worldSave.runtimeQuestDefs ?? [],
    narrationLastUsed: worldSave.narrationLastUsed ?? {},
    activeZones: worldSave.activeZones ?? [],
    traps: worldSave.traps ?? [],
    factionStandings: worldSave.factionStandings ?? {},
    // New in Pass 1 — older saves migrate by projecting the legacy `factionStandings`
    // into the party row of an otherwise-empty matrix. Pass 2 will use this matrix
    // as the source of truth.
    factionRelations: worldSave.factionRelations ?? (
      worldSave.factionStandings && Object.keys(worldSave.factionStandings).length > 0
        ? { party: { ...worldSave.factionStandings } }
        : {}
    ),
    // New in the relationship pass — older saves migrate by deriving each NPC's
    // individual link to the player from its stored disposition (enemy → −100,
    // ally → +100), so resume produces the same hostility outcomes.
    relationships: worldSave.relationships ?? deriveRelationshipsFromDispositions(worldSave.npcs ?? []),
    discoveredFactions: worldSave.discoveredFactions ?? [],
    rumors: worldSave.rumors ?? [],
    adventureContext: worldSave.adventureContext ?? null,
    // Save-shape migration: older saves stored this as `chapterComplete`
    // before the field was renamed to `encounterComplete` (the same flag
    // now also drives single-encounter wrap-up). Read either spelling.
    encounterComplete: worldSave.encounterComplete ?? worldSave.chapterComplete ?? false,
    objective: worldSave.objective ?? '',
    environment: worldSave.environment ?? {},
    npcs: (worldSave.npcs ?? []).map((n) => ({
      ...n,
      ongoingEffects: n.ongoingEffects ?? [],
      // US-092 backfill: pre-attitude saves default to SRD's Indifferent.
      attitude: n.attitude ?? 'indifferent',
    })),
  };
  return { state, aigmHistory };
}

export async function deleteWorldSave(): Promise<void> {
  try {
    await unlink(worldSavePath());
  } catch {
    /* already gone */
  }
}

export async function readSave(characterId: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(saveFilePath(characterId), "utf-8"));
  } catch {
    return defaultSave(characterId);
  }
}

export async function readSaveIfExists(characterId: string): Promise<CharSave | null> {
  try {
    return JSON.parse(
      await readFile(saveFilePath(characterId), "utf-8"),
    ) as CharSave;
  } catch {
    return null;
  }
}

async function defaultSave(characterId: string): Promise<unknown> {
  const char =
    deps.getDefs().playerDefs.find((c) => c.id === characterId) ?? deps.getDefs().playerDefs[0];
  return {
    playerDefId: char?.id ?? characterId,
    hp: char?.maxHp ?? 1,
    xp: char?.xp ?? 0,
    balanceCp: char?.defaultCp ?? 0,
    inventoryIds: [...(char?.defaultInventoryIds ?? [])],
    resources: Object.fromEntries(
      (char?.defaultFeatureIds ?? [])
        .map((fid) => deps.getDefs().features.find((f) => f.id === fid))
        .filter((f): f is NonNullable<typeof f> => !!f && !!f.resource && f.resource.kind !== 'unlimited')
        .map((f) => [f.id, f.resource!.max] as const),
    ),
    spellSlots: [...(char?.defaultSpellSlots ?? [])],
    preparedSpellIds: [...(char?.defaultPreparedSpellIds ?? [])],
  };
}

export async function writeSave(characterId: string, data: unknown): Promise<void> {
  await mkdir(savesDir(), { recursive: true });
  const path = saveFilePath(characterId);
  await writeFile(path, JSON.stringify(data, null, 2));
  Logger.log('persist.save_written', {
    kind: 'character',
    characterId,
    path,
    fields: data && typeof data === 'object' ? Object.keys(data as Record<string, unknown>) : [],
  });
}

export async function ensureSaveExists(characterId: string): Promise<void> {
  try {
    await access(saveFilePath(characterId));
  } catch {
    await writeSave(characterId, await defaultSave(characterId));
  }
}

// ── Adventure save (cross-chapter state) ───────────────────────────────────
export async function readAdventureSave(characterId: string): Promise<AdventureSave | null> {
  try {
    return JSON.parse(await readFile(adventureSaveFilePath(characterId), "utf-8")) as AdventureSave;
  } catch {
    return null;
  }
}

export async function writeAdventureSave(save: AdventureSave): Promise<void> {
  await mkdir(savesDir(), { recursive: true });
  await writeFile(adventureSaveFilePath(save.characterId), JSON.stringify(save, null, 2));
}

export async function deleteAdventureSave(characterId: string): Promise<void> {
  try {
    await unlink(adventureSaveFilePath(characterId));
  } catch {
    /* already gone */
  }
}

