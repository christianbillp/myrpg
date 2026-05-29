import { config as loadEnv } from "dotenv";
import { resolve } from "path";
loadEnv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), "../../.env"),
});
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Anthropic from "@anthropic-ai/sdk";
import { readFile, readdir } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { buildEncounter } from "./encounterService.js";
import { generateEncounter, generateMap } from "./encounterGenerator.js";
import { registerGenerateRoutes } from "./routes/generate.js";
import { processAIGMChat, AIGMChatRequest } from "./aigm.js";
import {
  generateStorylog,
  type EncounterRecord,
  type StorylogEntry,
} from "./storylog.js";
import { GameEngine } from "./engine/GameEngine.js";
import { GameDefs } from "./engine/types.js";
import { isHostileTo } from "./engine/FactionRelations.js";
import { PLAYER_FACTION_ID } from "../../shared/types.js";
import {
  applyEquipment,
  applyFeats,
  applySpecies,
} from "./engine/EquipmentSystem.js";
import { CreateSessionRequest } from "./engine/types.js";
import type { MapTilesetInfo } from "../../shared/types.js";
import {
  createSession,
  getEngine,
  getAigmHistory,
  setAigmHistory,
  registerWebSocket,
  pushStateUpdate,
  push,
  deleteSession,
  pushAdventureLines,
  getAdventureData,
  setWorldPaused,
  setWorldTickHandle,
  isWorldTickEligible,
  tryAcquireAigmLock,
  releaseAigmLock,
  getAigmArchive,
  findSessionByCharacter,
} from "./sessions.js";
import type { AigmMessage } from "./sessions.js";
import type {
  PlayerAction,
  ServerWSMessage,
  GameState,
  PlayerState,
  PlayerDef,
  EquipmentSlots,
  AdventureDef,
  AdventureSave,
  AdventureSessionContext,
  WorldFlagValue,
  Rumor,
} from "./engine/types.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "../data");

async function readDir<T>(dir: string): Promise<T[]> {
  const files = await readdir(dir);
  return Promise.all(
    files
      .filter((f) => f.endsWith(".json"))
      .map(async (f) => JSON.parse(await readFile(join(dir, f), "utf-8")) as T),
  );
}

// ── Load all data at startup ───────────────────────────────────────────────────

const defs: GameDefs = {
  playerDefs: [],
  monsters: [],
  npcs: [],
  equipment: [],
  maps: [],
  feats: [],
  backgrounds: [],
  species: [],
  spells: [],
  features: [],
  narration: [],
  factions: [],
  tileLegend: { notes: "", tiles: {} },
};

async function loadDefs(): Promise<void> {
  const [
    playerDefs,
    monsters,
    npcs,
    equipment,
    rawMaps,
    feats,
    backgrounds,
    species,
    spells,
    features,
    narration,
    factions,
  ] = await Promise.all([
    readDir<GameDefs["playerDefs"][0]>(join(DATA_DIR, "characters")),
    readDir<GameDefs["monsters"][0]>(join(DATA_DIR, "monsters")),
    readDir<GameDefs["npcs"][0]>(join(DATA_DIR, "npcs")),
    readDir<GameDefs["equipment"][0]>(join(DATA_DIR, "equipment")),
    readDir<TiledMapFile>(join(DATA_DIR, "maps")),
    readDir<GameDefs["feats"][0]>(join(DATA_DIR, "feats")),
    readDir<GameDefs["backgrounds"][0]>(join(DATA_DIR, "backgrounds")),
    readDir<GameDefs["species"][0]>(join(DATA_DIR, "species")),
    readDir<GameDefs["spells"][0]>(join(DATA_DIR, "spells")),
    readDir<GameDefs["features"][0]>(join(DATA_DIR, "features")),
    readDir<GameDefs["narration"][0]>(join(DATA_DIR, "narration")),
    readDir<GameDefs["factions"][0]>(join(DATA_DIR, "factions")),
  ]) as [
    GameDefs["playerDefs"], GameDefs["monsters"], GameDefs["npcs"], GameDefs["equipment"],
    TiledMapFile[], GameDefs["feats"], GameDefs["backgrounds"], GameDefs["species"],
    GameDefs["spells"], GameDefs["features"], GameDefs["narration"], GameDefs["factions"],
  ];
  defs.playerDefs = playerDefs;
  defs.monsters = monsters;
  defs.npcs = npcs;
  defs.equipment = equipment;
  defs.feats = feats;
  defs.backgrounds = backgrounds;
  defs.species = species;
  defs.spells = spells;
  defs.features = features;
  defs.narration = narration;
  defs.factions = factions;
  for (const p of defs.playerDefs) {
    applySpecies(p, defs.species);
    applyFeats(p, defs.feats);
    applyEquipment(p, p.defaultEquipment, defs.equipment);
  }
  defs.maps = await Promise.all(rawMaps.map(loadTiledMap));
  defs.tileLegend = await loadTileLegends();
}

/**
 * Load and merge every `*_legend.json` file under server/data/tilesets/ into a
 * single GID-keyed lookup. Used by SessionBuilder as a passability fallback
 * when an encounter omits a GID from its `tileProperties`.
 */
async function loadTileLegends(): Promise<GameDefs["tileLegend"]> {
  const files = await readdir(TILESETS_DIR);
  const legendFiles = files.filter((f) => f.endsWith("_legend.json"));
  const merged: GameDefs["tileLegend"] = { notes: "", tiles: {} };
  for (const file of legendFiles) {
    const raw = JSON.parse(await readFile(join(TILESETS_DIR, file), "utf-8")) as GameDefs["tileLegend"];
    if (raw.notes && !merged.notes) merged.notes = raw.notes;
    Object.assign(merged.tiles, raw.tiles);
  }
  return merged;
}

// ── Tiled-compatible map format ───────────────────────────────────────────────
//
// Each map JSON is a stripped-down Tiled JSON export:
//   - `width`, `height`: grid dimensions in tiles
//   - `tilesets[]`: tile palette. Each tile has an `id` (tileset-local); a
//     tile's GID = `firstgid + id`. GID 0 means empty / no tile. Maps carry
//     NO semantics on tiles — passability/cover/etc. belong to encounters.
//   - `layers[]`: tile layers. Each layer has a flat `data: number[]` of GIDs,
//     row-major (length = width × height). Reads naturally row-by-row when
//     hand-formatted with one row per source line.
//
// The engine still needs a `passable: boolean[][]` to do movement and pathing,
// but that grid is built at session-create time by combining the map's
// GID grid with the encounter's `tileProperties` declarations.

interface TiledTileProperty { name: string; type: string; value: unknown }
interface TiledTileDef { id: number; type?: string; properties?: TiledTileProperty[] }

// A tileset can be either inline (with `tiles`, `image` etc.) or an external
// reference (`source: "../tilesets/xxx.tsj"`) that the loader must resolve.
interface TiledTilesetInline {
  firstgid: number;
  name?: string;
  image?: string;
  imagewidth?: number;
  imageheight?: number;
  tilewidth?: number;
  tileheight?: number;
  spacing?: number;
  margin?: number;
  columns?: number;
  tilecount?: number;
  tiles?: TiledTileDef[];
}
interface TiledTilesetExternal { firstgid: number; source: string }
type TiledTileset = TiledTilesetInline | TiledTilesetExternal;

interface TiledLayer { type: "tilelayer"; name: string; width: number; height: number; data: number[] }
interface TiledMapFile {
  id: string;
  name: string;
  mapdescription: string;
  width: number;
  height: number;
  tilesets: TiledTileset[];
  layers: TiledLayer[];
}

// Tileset metadata surfaced to the client so it can preload the image and
// slice it correctly. The `imageUrl` is a relative URL the server serves
// from /tilesets/<filename> (see the static route below).
/**
 * Build a tileset-local `{ tileId → passable }` map from a Tiled .tsj's
 * `tiles[].properties[]`. Tiles without a `passable` property are omitted —
 * SessionBuilder treats absence as passable (Tiled's convention).
 */
function extractTilePassability(tiles: TiledTileDef[] | undefined): Record<number, boolean> {
  const out: Record<number, boolean> = {};
  for (const t of tiles ?? []) {
    const prop = t.properties?.find((p) => p.name === "passable");
    if (prop && typeof prop.value === "boolean") out[t.id] = prop.value;
  }
  return out;
}

const TILESETS_DIR = join(DATA_DIR, "tilesets");
const TOKENS_DIR = join(DATA_DIR, "tokens");
const SOUNDS_DIR = join(DATA_DIR, "sounds");

/**
 * Resolve an inline-or-external tileset entry to the merged inline form,
 * reading the external file from server/data/tilesets/ when needed.
 */
async function resolveTileset(ts: TiledTileset): Promise<TiledTilesetInline> {
  if ("source" in ts) {
    // Tiled writes `source` as a path relative to the map file. Our maps live
    // in server/data/maps/ and reference ../tilesets/xxx.tsj, so we resolve
    // against the maps directory.
    const basename = ts.source.split("/").pop() ?? ts.source;
    const filepath = join(TILESETS_DIR, basename);
    const raw = JSON.parse(await readFile(filepath, "utf-8")) as TiledTilesetInline;
    return { ...raw, firstgid: ts.firstgid };
  }
  return ts;
}

async function loadTiledMap(file: TiledMapFile) {
  // Ground layer: required. Prefer a layer literally named "terrain"; fall back
  // to the first tile layer.
  const terrain = file.layers.find((l) => l.name === "terrain")
    ?? file.layers.find((l) => l.type === "tilelayer");
  if (!terrain) throw new Error(`Map ${file.id} has no tile layer`);
  if (terrain.data.length !== file.width * file.height) {
    throw new Error(`Map ${file.id}: layer "${terrain.name}" data length ${terrain.data.length} ≠ ${file.width}×${file.height}`);
  }

  // Object layer: optional. By convention named "objects"; we also accept any
  // additional tile layer that isn't the ground layer.
  const objects = file.layers.find((l) => l !== terrain && l.type === "tilelayer" && (l.name === "objects" || l.name === "object"))
    ?? file.layers.find((l) => l !== terrain && l.type === "tilelayer");
  if (objects && objects.data.length !== file.width * file.height) {
    throw new Error(`Map ${file.id}: layer "${objects.name}" data length ${objects.data.length} ≠ ${file.width}×${file.height}`);
  }

  // Promote each flat row-major GID array to a 2D grid for convenient access.
  const toGrid = (data: number[]): number[][] => {
    const grid: number[][] = [];
    for (let y = 0; y < file.height; y++) {
      const row: number[] = [];
      for (let x = 0; x < file.width; x++) row.push(data[y * file.width + x]);
      grid.push(row);
    }
    return grid;
  };
  const gidGrid = toGrid(terrain.data);
  const objectGidGrid = objects ? toGrid(objects.data) : undefined;

  // Resolve external tilesets and produce client-facing metadata for each one.
  const tilesetInfo: MapTilesetInfo[] = [];
  for (const ts of file.tilesets) {
    const inline = await resolveTileset(ts);
    if (!inline.image || !inline.imagewidth || !inline.imageheight || !inline.tilewidth || !inline.tileheight || !inline.columns) {
      console.warn(`Map ${file.id}: tileset has incomplete image metadata; skipping`);
      continue;
    }
    tilesetInfo.push({
      firstgid: inline.firstgid,
      name: inline.name ?? "default",
      imageUrl: `/tilesets/${inline.image.split("/").pop()}`,
      imagewidth: inline.imagewidth,
      imageheight: inline.imageheight,
      tilewidth: inline.tilewidth,
      tileheight: inline.tileheight,
      spacing: inline.spacing ?? 0,
      margin: inline.margin ?? 0,
      columns: inline.columns,
      tilePassability: extractTilePassability(inline.tiles),
    });
  }

  return {
    id: file.id,
    name: file.name,
    mapdescription: file.mapdescription,
    cols: file.width,
    rows: file.height,
    gidGrid,
    objectGidGrid,
    tilesets: tilesetInfo,
  };
}

// ── Server setup ───────────────────────────────────────────────────────────────

const server = Fastify({ logger: false });
await server.register(cors, { origin: "http://localhost:5173" });
await server.register(websocket);

// ── Static data routes (unchanged) ────────────────────────────────────────────

server.get("/characters", async () => defs.playerDefs);
server.get("/monsters", async () => defs.monsters);
server.get("/npcs", async () => defs.npcs);
server.get("/factions", async () => defs.factions);
server.get("/equipment", async () => defs.equipment);
server.get("/feats", async () => defs.feats);
server.get("/backgrounds", async () => defs.backgrounds);
server.get("/species", async () => defs.species);
server.get("/spells", async () => defs.spells);
server.get("/features", async () => defs.features);
server.get("/encounters", async () => readDir(join(DATA_DIR, "encounters")));
server.get("/adventures", async () => readDir(join(DATA_DIR, "adventures")));

// All /generate/* routes live in their own module — see routes/generate.ts.
registerGenerateRoutes(server, {
  anthropic,
  getDefs: () => defs,
  loadDefs,
  dataDir: DATA_DIR,
});


// Adventure routes — see types AdventureDef / AdventureSave in shared/types.ts.
server.get<{ Params: { characterId: string } }>(
  "/adventure/:characterId",
  async (req) => (await readAdventureSave(req.params.characterId)) ?? null,
);

server.delete<{ Params: { characterId: string } }>(
  "/adventure/:characterId",
  async (req, reply) => {
    await deleteAdventureSave(req.params.characterId);
    reply.code(204).send();
  },
);

server.post<{ Body: { characterId: string; adventureId: string } }>(
  "/adventure/start",
  async (req, reply) => {
    const { characterId, adventureId } = req.body;
    const adv = await loadAdventureDef(adventureId);
    if (!adv) return reply.code(404).send({ error: "Unknown adventureId" });
    let save = await readAdventureSave(characterId);
    if (!save || save.adventureId !== adventureId) {
      save = makeAdventureSave(characterId, adventureId);
      await writeAdventureSave(save);
    }
    const result = await startAdventureChapter(characterId, adv, save);
    if ("error" in result) return reply.code(400).send(result);
    return reply.send(result);
  },
);

server.post<{ Params: { characterId: string } }>(
  "/adventure/:characterId/advance",
  async (req, reply) => {
    const { characterId } = req.params;
    const save = await readAdventureSave(characterId);
    if (!save) return reply.code(404).send({ error: "No active adventure for this character" });
    const adv = await loadAdventureDef(save.adventureId);
    if (!adv) return reply.code(404).send({ error: "Adventure definition missing" });
    const chapter = adv.chapters[save.currentChapterIndex];
    if (!chapter) return reply.code(400).send({ error: "No current chapter" });

    // Pull the AIGM history of the just-completed chapter from the active
    // session (if still in memory) for summarization, and capture the final
    // state of cross-chapter fields so they carry forward.
    const found = findSessionByCharacter(characterId);
    const aigmHistory = found?.session.aigmHistory ?? [];
    if (found) {
      const finishedState = found.session.engine.getState();
      save.worldFlags = { ...finishedState.worldFlags };
      save.factionStandings = { ...finishedState.factionStandings };
      save.factionRelations = structuredClone(finishedState.factionRelations);
      save.discoveredFactions = [...finishedState.discoveredFactions];
      save.rumors = [...finishedState.rumors];
      deleteSession(found.sessionId);
    }

    // Summarize + mark complete.
    const summary = await summarizeChapter(chapter.title, aigmHistory);
    save.priorChapterSummaries.push({ chapterId: chapter.id, chapterTitle: chapter.title, summary });
    if (!save.completedChapterIds.includes(chapter.id)) save.completedChapterIds.push(chapter.id);
    save.currentChapterIndex += 1;

    // Wipe the just-completed world save so resume routing doesn't snap back.
    await deleteWorldSave();

    if (save.currentChapterIndex >= adv.chapters.length) {
      // Adventure complete — keep the save around so the client can show a
      // completion overlay but signal done to the client.
      await writeAdventureSave(save);
      return reply.send({ complete: true, save });
    }

    await writeAdventureSave(save);
    const result = await startAdventureChapter(characterId, adv, save);
    if ("error" in result) return reply.code(400).send(result);
    return reply.send({ complete: false, ...result });
  },
);
server.get("/maps", async () => defs.maps);
server.get("/health", async () => ({ ok: true }));

// Directory listing — returns image metadata for every .tsj in the tilesets
// dir so the client can preload every spritesheet at boot (including ones
// not yet referenced by any saved map, e.g. a fresh tileset that's only
// going to be used by the next composed preview).
server.get("/tilesets", async (_req, reply) => {
  try {
    const files = await readdir(TILESETS_DIR);
    const out: Array<{
      imageUrl: string; tilewidth: number; tileheight: number;
      margin: number; spacing: number; columns: number;
    }> = [];
    for (const file of files) {
      if (!file.endsWith(".tsj")) continue;
      const raw = JSON.parse(await readFile(join(TILESETS_DIR, file), "utf-8")) as TiledTilesetInline;
      if (!raw.image || !raw.tilewidth || !raw.tileheight || !raw.columns) continue;
      out.push({
        imageUrl: `/tilesets/${raw.image.split("/").pop()}`,
        tilewidth: raw.tilewidth,
        tileheight: raw.tileheight,
        margin: raw.margin ?? 0,
        spacing: raw.spacing ?? 0,
        columns: raw.columns,
      });
    }
    return reply.send(out);
  } catch {
    return reply.send([]);
  }
});

// Static tileset images. Whitelisted by filename pattern so this can't be
// turned into a directory traversal. Currently only `.png` is served from
// the canonical tilesets directory.
server.get<{ Params: { filename: string } }>(
  "/tilesets/:filename",
  async (req, reply) => {
    const { filename } = req.params;
    if (!/^[A-Za-z0-9_-]+\.png$/.test(filename)) {
      return reply.code(400).send({ error: "invalid tileset filename" });
    }
    try {
      const data = await readFile(join(TILESETS_DIR, filename));
      return reply.type("image/png").send(data);
    } catch {
      return reply.code(404).send({ error: "tileset not found" });
    }
  },
);

// Static sound assets — referenced by `client/src/ui/ScreenEffects` for the
// supertitle stinger and any future cinematic SFX. Drop `.mp3`, `.ogg`, or
// `.wav` files into `server/data/sounds/`; the client requests them by name
// (e.g. `/sounds/supertitle.mp3`). Filenames are validated against the same
// character class as tokens to stop arbitrary path access.
server.get<{ Params: { filename: string } }>(
  "/sounds/:filename",
  async (req, reply) => {
    const { filename } = req.params;
    const match = filename.match(/^([A-Za-z0-9_-]+)\.(mp3|ogg|wav)$/);
    if (!match) {
      return reply.code(400).send({ error: "invalid sound filename" });
    }
    const ext = match[2];
    const mimeType = ext === "mp3" ? "audio/mpeg" : ext === "ogg" ? "audio/ogg" : "audio/wav";
    try {
      const data = await readFile(join(SOUNDS_DIR, filename));
      return reply.type(mimeType).send(data);
    } catch {
      return reply.code(404).send({ error: "sound not found" });
    }
  },
);

// Static token SVGs — referenced from `PlayerDef.tokenAsset`,
// `MonsterDef.tokenAsset`, and optionally `NPCDef.tokenAsset`. Loaded by the
// client's `BootScene.preload` and rendered by Player + NpcToken.
server.get<{ Params: { filename: string } }>(
  "/tokens/:filename",
  async (req, reply) => {
    const { filename } = req.params;
    if (!/^[A-Za-z0-9_-]+\.svg$/.test(filename)) {
      return reply.code(400).send({ error: "invalid token filename" });
    }
    try {
      const data = await readFile(join(TOKENS_DIR, filename));
      return reply.type("image/svg+xml").send(data);
    } catch {
      return reply.code(404).send({ error: "token not found" });
    }
  },
);

// ── Save routes (unchanged) ────────────────────────────────────────────────────

const SAVES_DIR = join(DATA_DIR, "saves");
const WORLD_SAVE_PATH = join(SAVES_DIR, "world.json");
import { writeFile, mkdir, unlink, access } from "fs/promises";

function saveFilePath(characterId: string): string {
  return join(SAVES_DIR, `${characterId}.json`);
}

function adventureSaveFilePath(characterId: string): string {
  return join(SAVES_DIR, `${characterId}_adventure.json`);
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
type WorldSave = Omit<GameState, "player"> & {
  player: SessionPlayerState;
  enemies?: unknown;
  aigmHistory?: AigmMessage[];
};

interface CharSave {
  playerDefId: string;
  hp: number;
  xp: number;
  gold: number;
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
  levelUps?: import("../../shared/types.js").LevelUpChoices[];
}

async function saveWorldState(
  state: GameState,
  aigmHistory: AigmMessage[] = [],
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const {
    hp: _hp,
    xp: _xp,
    gold: _gold,
    inventoryIds: _inv,
    equippedSlots: _eq,
    resources: _r,
    spellSlots: _ss,
    preparedSpellIds: _ps,
    ...sessionPlayer
  } = state.player;
  const worldSave: WorldSave = { ...state, player: sessionPlayer, aigmHistory };
  await mkdir(SAVES_DIR, { recursive: true });
  await writeFile(WORLD_SAVE_PATH, JSON.stringify(worldSave));
}

async function loadWorldState(): Promise<{
  state: GameState;
  aigmHistory: AigmMessage[];
} | null> {
  let worldSave: WorldSave;
  try {
    const rawJson = JSON.parse(
      await readFile(WORLD_SAVE_PATH, "utf-8"),
    ) as Record<string, unknown>;
    // Migrate older saves authored before `combatLog` → `eventLog` rename.
    // Reading state always carries the new field name so downstream code
    // (HUD, AIGM context builder, etc.) doesn't blow up on undefined.
    if ("combatLog" in rawJson && !("eventLog" in rawJson)) {
      rawJson.eventLog = rawJson.combatLog;
      delete rawJson.combatLog;
    }
    worldSave = rawJson as unknown as WorldSave;
  } catch {
    return null;
  }
  // Reject pre-disposition saves that still carry a separate 'enemies' array
  if ("enemies" in worldSave) return null;

  const charSave = (await readSave(worldSave.player.defId)) as CharSave;
  const fullPlayer: PlayerState = {
    ...worldSave.player,
    hp: charSave.hp,
    xp: charSave.xp,
    gold: charSave.gold,
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
    triggers: worldSave.triggers ?? [],
    firedTriggerIds: worldSave.firedTriggerIds ?? [],
    pendingAigmEvents: worldSave.pendingAigmEvents ?? [],
    worldFlags: worldSave.worldFlags ?? {},
    narrationLastUsed: worldSave.narrationLastUsed ?? {},
    factionStandings: worldSave.factionStandings ?? {},
    // New in Pass 1 — older saves migrate by projecting the legacy `factionStandings`
    // into the party row of an otherwise-empty matrix. Pass 2 will use this matrix
    // as the source of truth.
    factionRelations: worldSave.factionRelations ?? (
      worldSave.factionStandings && Object.keys(worldSave.factionStandings).length > 0
        ? { party: { ...worldSave.factionStandings } }
        : {}
    ),
    discoveredFactions: worldSave.discoveredFactions ?? [],
    rumors: worldSave.rumors ?? [],
    adventureContext: worldSave.adventureContext ?? null,
    chapterComplete: worldSave.chapterComplete ?? false,
    objective: worldSave.objective ?? '',
    environment: worldSave.environment ?? {},
    npcs: (worldSave.npcs ?? []).map((n) => ({ ...n, ongoingEffects: n.ongoingEffects ?? [] })),
  };
  return { state, aigmHistory };
}

async function deleteWorldSave(): Promise<void> {
  try {
    await unlink(WORLD_SAVE_PATH);
  } catch {
    /* already gone */
  }
}

async function readSave(characterId: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(saveFilePath(characterId), "utf-8"));
  } catch {
    return defaultSave(characterId);
  }
}

async function readSaveIfExists(characterId: string): Promise<CharSave | null> {
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
    defs.playerDefs.find((c) => c.id === characterId) ?? defs.playerDefs[0];
  return {
    playerDefId: char?.id ?? characterId,
    hp: char?.maxHp ?? 1,
    xp: char?.xp ?? 0,
    gold: char?.defaultGold ?? 0,
    inventoryIds: [...(char?.defaultInventoryIds ?? [])],
    resources: Object.fromEntries(
      (char?.defaultFeatureIds ?? [])
        .map((fid) => defs.features.find((f) => f.id === fid))
        .filter((f): f is NonNullable<typeof f> => !!f && !!f.resource && f.resource.kind !== 'unlimited')
        .map((f) => [f.id, f.resource!.max] as const),
    ),
    spellSlots: [...(char?.defaultSpellSlots ?? [])],
    preparedSpellIds: [...(char?.defaultPreparedSpellIds ?? [])],
  };
}

async function writeSave(characterId: string, data: unknown): Promise<void> {
  await mkdir(SAVES_DIR, { recursive: true });
  await writeFile(saveFilePath(characterId), JSON.stringify(data, null, 2));
}

async function ensureSaveExists(characterId: string): Promise<void> {
  try {
    await access(saveFilePath(characterId));
  } catch {
    await writeSave(characterId, await defaultSave(characterId));
  }
}

// ── Adventure save (cross-chapter state) ───────────────────────────────────
async function readAdventureSave(characterId: string): Promise<AdventureSave | null> {
  try {
    return JSON.parse(await readFile(adventureSaveFilePath(characterId), "utf-8")) as AdventureSave;
  } catch {
    return null;
  }
}

async function writeAdventureSave(save: AdventureSave): Promise<void> {
  await mkdir(SAVES_DIR, { recursive: true });
  await writeFile(adventureSaveFilePath(save.characterId), JSON.stringify(save, null, 2));
}

async function deleteAdventureSave(characterId: string): Promise<void> {
  try {
    await unlink(adventureSaveFilePath(characterId));
  } catch {
    /* already gone */
  }
}

function buildAdventureSeed(adv: AdventureDef, chapterIndex: number, save: AdventureSave): AdventureSessionContext & {
  seedWorldFlags?: Record<string, WorldFlagValue>;
  seedFactionStandings?: Record<string, number>;
  seedFactionRelations?: Record<string, Record<string, number>>;
  seedDiscoveredFactions?: string[];
  seedRumors?: Rumor[];
} {
  const chapter = adv.chapters[chapterIndex];
  return {
    adventureId: adv.id,
    adventureTitle: adv.title,
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    chapterIndex,
    totalChapters: adv.chapters.length,
    completionFlag: chapter.completionFlag,
    priorChapterSummaries: save.priorChapterSummaries,
    seedWorldFlags: { ...save.worldFlags },
    seedFactionStandings: { ...save.factionStandings },
    // Carry the full pair-wise faction matrix across chapters when present.
    // Older saves without this field fall back to seeding the `party` row
    // from `seedFactionStandings` + faction-def defaults.
    seedFactionRelations: save.factionRelations
      ? structuredClone(save.factionRelations)
      : undefined,
    seedDiscoveredFactions: save.discoveredFactions
      ? [...save.discoveredFactions]
      : undefined,
    seedRumors: [...save.rumors],
  };
}

function makeAdventureSave(characterId: string, adventureId: string): AdventureSave {
  return {
    characterId,
    adventureId,
    currentChapterIndex: 0,
    completedChapterIds: [],
    worldFlags: {},
    factionStandings: {},
    factionRelations: {},
    discoveredFactions: [],
    rumors: [],
    priorChapterSummaries: [],
  };
}

interface EncounterDefJson {
  id: string;
  encounterTitle: string;
  description?: string;
  mapId: string;
  npcIds?: string[];
  allyIds?: string[];
  enemyIds?: string[];
  customIntroduction?: string;
  customContext?: string;
  objective?: string;
  /** When true the encounter offers Long Rest (tavern, safehouse, etc.). */
  allowsLongRest?: boolean;
  /** Optional world-flag name that, when set, marks the encounter complete.
   *  Mirrored into `GameState.encounterCompletionFlag` so the
   *  `encounter_completed` engine event fires when the flag is set. */
  completionFlag?: string;
  tileProperties?: import("./engine/types.js").EncounterTileProperty[];
  startingZones?: import("./engine/types.js").StartingZonesLayer;
  triggers?: import("./engine/types.js").EncounterTrigger[];
  environment?: import("./engine/types.js").EncounterEnvironment;
  /** Optional per-encounter override for the global faction-relation matrix. */
  factionRelations?: Record<string, Record<string, number>>;
}

async function loadAdventureDef(adventureId: string): Promise<AdventureDef | null> {
  const all = await readDir<AdventureDef>(join(DATA_DIR, "adventures"));
  return all.find((a) => a.id === adventureId) ?? null;
}

async function loadEncounterDef(encounterId: string): Promise<EncounterDefJson | null> {
  const all = await readDir<EncounterDefJson>(join(DATA_DIR, "encounters"));
  return all.find((e) => e.id === encounterId) ?? null;
}

/**
 * Build and register a GameEngine for one chapter of an adventure. Reuses the
 * existing buildEncounter / GameEngine.createSession path; the only addition
 * is the `adventureSeed` field that carries cross-chapter state (worldFlags,
 * factionStandings, rumors, prior summaries) into SessionBuilder.
 */
async function startAdventureChapter(
  characterId: string,
  adv: AdventureDef,
  save: AdventureSave,
): Promise<{ sessionId: string; state: GameState; playerDef: PlayerDef } | { error: string }> {
  const chapter = adv.chapters[save.currentChapterIndex];
  if (!chapter) return { error: "No chapter at currentChapterIndex" };
  const playerDef = defs.playerDefs.find((p) => p.id === characterId);
  if (!playerDef) return { error: "Unknown character" };
  const encDef = await loadEncounterDef(chapter.encounterId);
  if (!encDef) return { error: `Unknown encounterId "${chapter.encounterId}"` };
  const savedMap = defs.maps.find((m) => m.id === encDef.mapId);

  const charSave = await readSaveIfExists(characterId);

  const encounterContext = buildEncounter({
    mapType: "saved",
    playerDefId: playerDef.id,
    playerName: playerDef.name,
    playerSpeciesName: playerDef.speciesName,
    playerClassName: playerDef.className,
    playerLevel: playerDef.level,
    playerMaxHp: charSave?.hp ?? playerDef.maxHp,
    playerAc: playerDef.ac,
    savedMapName: savedMap?.name,
    savedMapDescription: savedMap?.mapdescription,
    npcIds: encDef.npcIds,
    allyIds: encDef.allyIds,
    enemyIds: encDef.enemyIds,
    customIntroduction: encDef.customIntroduction,
    customContext: encDef.customContext,
    customObjective: encDef.objective,
    startingZones: encDef.startingZones,
    environment: encDef.environment,
    factionRelations: encDef.factionRelations,
    allowsLongRest: encDef.allowsLongRest,
  });

  const adventureSeed = buildAdventureSeed(adv, save.currentChapterIndex, save);

  const sessionId = randomUUID();
  const req: CreateSessionRequest = {
    mapType: "saved",
    playerDefId: playerDef.id,
    savedMapId: savedMap?.id,
    encounterTitle: encDef.encounterTitle,
    savedMapName: savedMap?.name,
    savedMapDescription: savedMap?.mapdescription,
    npcIds: encDef.npcIds,
    allyIds: encDef.allyIds,
    enemyIds: encDef.enemyIds,
    customIntroduction: encDef.customIntroduction,
    customContext: encDef.customContext,
    customObjective: encDef.objective,
    completionFlag: encDef.completionFlag,
    tileProperties: encDef.tileProperties,
    startingZones: encDef.startingZones,
    triggers: encDef.triggers,
    adventureSeed,
    resumeHp: charSave?.hp,
    resumeXp: charSave?.xp,
    resumeGold: charSave?.gold,
    resumeInventoryIds: charSave?.inventoryIds,
    resumeEquippedSlots: charSave?.equippedSlots,
    resumeResources: charSave?.resources,
    resumeSpellSlots: charSave?.spellSlots,
    resumePreparedSpellIds: charSave?.preparedSpellIds,
    resumeLevelUps: charSave?.levelUps,
  };

  const engine = GameEngine.createSession(sessionId, { ...req, encounterContext }, defs, savedMap);
  createSession(sessionId, engine);
  installWorldTick(sessionId, engine);
  await ensureSaveExists(playerDef.id);
  // Auto-start combat — see comment on the main session-create route above.
  if (anyHostileToParty(engine.getState())) {
    engine.triggerCombat();
  }
  return { sessionId, state: engine.getState(), playerDef: engine.getPlayerDef() };
}

/**
 * True when any living NPC in the state is hostile to the player party. Used
 * by the auto-start-combat guards on session creation — reads through the
 * faction matrix (with legacy `disposition` fallback) so encounter content
 * authored with either source-of-truth lands the player in combat correctly.
 */
function anyHostileToParty(state: GameState): boolean {
  const partyView = { factionId: PLAYER_FACTION_ID } as const;
  return state.npcs.some((n) => n.hp > 0
    && isHostileTo(state, partyView, { factionId: n.factionId, disposition: n.disposition }));
}

/**
 * Generate a short prose summary of a completed chapter from its AIGM history.
 * Uses Haiku for speed/cost. On failure, falls back to a static placeholder so
 * the adventure flow never blocks on summarization.
 */
async function summarizeChapter(
  chapterTitle: string,
  aigmHistory: AigmMessage[],
): Promise<string> {
  if (aigmHistory.length === 0) {
    return `${chapterTitle} was resolved with no recorded dialogue.`;
  }
  try {
    const transcript = aigmHistory
      .map((m) => {
        const text = m.role === "user"
          ? (/\[PLAYER\]\n([\s\S]+)$/.exec(m.content)?.[1]?.trim() ?? m.content)
          : m.content;
        return `${m.role.toUpperCase()}: ${text}`;
      })
      .join("\n\n");
    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 160,
      system: "Summarize the following D&D chapter transcript in 2 short sentences for a later chapter's GM context. Focus on outcomes, NPCs involved, and any moral / political choices the player made. Use past tense, third-person. Do not use mechanical numbers.",
      messages: [{ role: "user", content: transcript.slice(-8000) }],
    });
    const block = resp.content.find((b) => b.type === "text");
    return block && block.type === "text" ? block.text.trim() : `${chapterTitle} resolved.`;
  } catch (err) {
    console.warn("[adventure] summarizeChapter failed; using placeholder", err);
    return `${chapterTitle} resolved.`;
  }
}

server.get("/save/:characterId", async (req) =>
  readSaveIfExists((req.params as { characterId: string }).characterId),
);
server.post("/save/:characterId", async (req, reply) => {
  await writeSave(
    (req.params as { characterId: string }).characterId,
    req.body,
  );
  return reply.code(200).send({ ok: true });
});
server.delete("/save/:characterId", async (req, reply) => {
  try {
    await unlink(
      saveFilePath((req.params as { characterId: string }).characterId),
    );
  } catch {
    /* gone */
  }
  return reply.code(200).send({ ok: true });
});

// ── World save (resume) ────────────────────────────────────────────────────────

server.get("/world", async (_req, reply) => {
  const loaded = await loadWorldState();
  if (!loaded) return reply.code(404).send({ error: "No world save" });

  const { state, aigmHistory } = loaded;
  // Re-use the existing engine if the session is still alive (e.g. hot-reload),
  // otherwise restore from the saved GameState.
  let engine = getEngine(state.sessionId);
  if (!engine) {
    engine = new GameEngine(state, defs);
    createSession(state.sessionId, engine);
    setAigmHistory(state.sessionId, aigmHistory);
  }
  return reply.send({
    sessionId: state.sessionId,
    state: engine.getState(),
    gmHistory: buildGmDisplayHistory(aigmHistory),
  });
});

function buildGmDisplayHistory(
  history: AigmMessage[],
): { role: "user" | "assistant"; content: string }[] {
  const result: { role: "user" | "assistant"; content: string }[] = [];
  for (const msg of history) {
    if (msg.role === "assistant") {
      result.push({ role: "assistant", content: msg.content });
    } else {
      const match = /\[PLAYER\]\n([\s\S]+)$/.exec(msg.content);
      if (match) result.push({ role: "user", content: match[1].trim() });
    }
  }
  return result;
}

// ── Game session routes ────────────────────────────────────────────────────────

server.post("/game/session", async (req, reply) => {
  const body = req.body as CreateSessionRequest & {
    savedMapId?: string;
    playerName?: string;
    playerSpeciesName?: string;
    playerClassName?: string;
    playerLevel?: number;
    playerMaxHp?: number;
    playerAc?: number;
    savedMapName?: string;
    savedMapDescription?: string;
    npcIds?: string[];
  };

  const playerDef = defs.playerDefs.find((p) => p.id === body.playerDefId);
  if (!playerDef) return reply.code(400).send({ error: "Unknown playerDefId" });

  const encounterContext = buildEncounter({
    mapType: body.mapType,
    playerDefId: body.playerDefId,
    playerName: playerDef.name,
    playerSpeciesName: playerDef.speciesName,
    playerClassName: playerDef.className,
    playerLevel: playerDef.level,
    playerMaxHp: body.resumeHp ?? playerDef.maxHp,
    playerAc: playerDef.ac,
    savedMapName: body.savedMapName,
    savedMapDescription: body.savedMapDescription,
    npcIds: body.npcIds,
    allyIds: body.allyIds,
    enemyIds: body.enemyIds,
    customIntroduction: body.customIntroduction,
    customContext: body.customContext,
    customObjective: body.customObjective,
    startingZones: body.startingZones,
    allowsLongRest: body.allowsLongRest,
  });

  const savedMap = body.savedMapId
    ? (defs.maps.find((m) => m.id === body.savedMapId) ?? undefined)
    : undefined;

  // Server save is the source of truth for persistent character state —
  // level-up history, prepared spells, spell slots, resource pools, HP.
  // Fall back to whatever the client sent (legacy / freshly-imported
  // characters with no server save).
  const charSaveForResume = await readSaveIfExists(body.playerDefId);
  const resumeLevelUps        = charSaveForResume?.levelUps        ?? body.resumeLevelUps;
  const resumeSpellSlots      = charSaveForResume?.spellSlots      ?? body.resumeSpellSlots;
  const resumePreparedSpellIds = charSaveForResume?.preparedSpellIds ?? body.resumePreparedSpellIds;
  const resumeResources       = charSaveForResume?.resources       ?? body.resumeResources;
  const resumeHp              = charSaveForResume?.hp              ?? body.resumeHp;
  const resumeXp              = charSaveForResume?.xp              ?? body.resumeXp;
  const resumeGold            = charSaveForResume?.gold            ?? body.resumeGold;
  const resumeInventoryIds    = charSaveForResume?.inventoryIds    ?? body.resumeInventoryIds;
  const resumeEquippedSlots   = charSaveForResume?.equippedSlots   ?? body.resumeEquippedSlots;

  const sessionId = randomUUID();
  const engine = GameEngine.createSession(
    sessionId,
    {
      ...body,
      encounterContext,
      resumeLevelUps,
      resumeSpellSlots,
      resumePreparedSpellIds,
      resumeResources,
      resumeHp,
      resumeXp,
      resumeGold,
      resumeInventoryIds,
      resumeEquippedSlots,
    },
    defs,
    savedMap,
  );
  createSession(sessionId, engine);
  installWorldTick(sessionId, engine);
  await ensureSaveExists(playerDef.id);

  // Auto-start combat when the encounter spawned any hostile creatures, so the
  // player lands directly in the turn-order UI as soon as the introduction
  // overlay is dismissed. Deferred to *after* the engine is registered in the
  // sessions map so any bus events published during the transition have
  // somewhere to land (today the events are unsubscribed-to; this guards the
  // ordering for future bus consumers). Encounters that want a delayed
  // hostile reveal should keep all NPCs neutral at spawn and use triggers to
  // flip dispositions later.
  if (anyHostileToParty(engine.getState())) {
    engine.triggerCombat();
  }

  // Include the engine's per-session PlayerDef (with any level-up history
  // already replayed) so the client renders the HUD against the character's
  // current level rather than the L1 starting state from the cached registry.
  return reply.send({ sessionId, state: engine.getState(), playerDef: engine.getPlayerDef() });
});

/**
 * Pause / resume the off-camera world tick (Pass 3c). The client posts this
 * whenever the player focuses the GM chat box or opens a blocking overlay —
 * so the world doesn't advance under typing time or while a modal is up.
 */
server.post("/game/session/:id/world-paused", async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = req.body as { paused?: boolean };
  if (typeof body?.paused !== 'boolean') {
    return reply.code(400).send({ error: "world-paused requires { paused: boolean }" });
  }
  if (!getEngine(id)) return reply.code(404).send({ error: "Session not found" });
  setWorldPaused(id, body.paused);
  return reply.send({ paused: body.paused });
});

/**
 * Build the SRD level-up preview for the session's character. Returns 200
 * with `{ preview: null }` when the character isn't eligible yet (so the
 * client can refresh without surfacing an error).
 */
server.get("/game/session/:id/level-up", async (req, reply) => {
  const { id } = req.params as { id: string };
  const engine = getEngine(id);
  if (!engine) return reply.code(404).send({ error: "Session not found" });
  try {
    return reply.send({ preview: engine.buildLevelUpPreview() });
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Build the Long Rest preview for the active session's character. Returns
 * `{ preview: null }` when the encounter doesn't permit Long Rest or the
 * player is in combat — the client treats both the same (no button).
 */
server.get("/game/session/:id/long-rest", async (req, reply) => {
  const { id } = req.params as { id: string };
  const engine = getEngine(id);
  if (!engine) return reply.code(404).send({ error: "Session not found" });
  return reply.send({ preview: engine.buildLongRestPreview() });
});

/**
 * Apply a confirmed Long Rest. Body: `{ choices: LongRestChoices }`. Updates
 * the runtime state (HP / hit dice / slots / resources / wizard prep / etc.)
 * and persists the new running totals to the character save so the rested
 * character survives a session restart.
 */
server.post("/game/session/:id/long-rest", async (req, reply) => {
  const { id } = req.params as { id: string };
  const engine = getEngine(id);
  if (!engine) return reply.code(404).send({ error: "Session not found" });
  const body = req.body as { choices?: import("../../shared/types.js").LongRestChoices } | undefined;
  const choices = body?.choices ?? {};

  let preview;
  try {
    preview = engine.commitLongRest(choices);
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  }

  // Persist the post-rest state to the character save so the rested
  // character survives session restart / chapter advance.
  const playerDef = engine.getPlayerDef();
  const state = engine.getState();
  const existing = (await readSaveIfExists(playerDef.id)) ?? {
    playerDefId: playerDef.id,
    hp: state.player.hp,
    xp: state.player.xp,
    gold: state.player.gold,
    inventoryIds: state.player.inventoryIds,
  } as CharSave;
  const updated: CharSave = {
    ...existing,
    hp: state.player.hp,
    xp: state.player.xp,
    gold: state.player.gold,
    inventoryIds: state.player.inventoryIds,
    equippedSlots: state.player.equippedSlots,
    spellSlots: state.player.spellSlots,
    preparedSpellIds: state.player.preparedSpellIds,
    resources: state.player.resources,
  };
  await writeFile(saveFilePath(playerDef.id), JSON.stringify(updated, null, 2));

  pushStateUpdate(id, [], state);

  return reply.send({ preview, state, playerDef });
});

/**
 * Apply a confirmed level-up. Body shape: `{ choices: LevelUpChoices }`.
 * On success, persists the new level-up to the character save and broadcasts
 * a `state_update` so connected clients refresh their playerDef + HUD.
 */
server.post("/game/session/:id/level-up", async (req, reply) => {
  const { id } = req.params as { id: string };
  const engine = getEngine(id);
  if (!engine) return reply.code(404).send({ error: "Session not found" });
  const body = req.body as { choices?: import("../../shared/types.js").LevelUpChoices } | undefined;
  const choices = body?.choices ?? {};

  let preview;
  try {
    preview = engine.commitLevelUp(choices);
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  }

  // Persist the new level-up to the character save so the change survives
  // session restart / chapter advance / app reload.
  const playerDef = engine.getPlayerDef();
  const existing = (await readSaveIfExists(playerDef.id)) ?? {
    playerDefId: playerDef.id,
    hp: engine.getState().player.hp,
    xp: engine.getState().player.xp,
    gold: engine.getState().player.gold,
    inventoryIds: engine.getState().player.inventoryIds,
  } as CharSave;
  const history = (existing.levelUps ?? []).slice();
  history.push(choices);
  const updated: CharSave = {
    ...existing,
    hp: engine.getState().player.hp,
    xp: engine.getState().player.xp,
    gold: engine.getState().player.gold,
    inventoryIds: engine.getState().player.inventoryIds,
    equippedSlots: engine.getState().player.equippedSlots,
    spellSlots: engine.getState().player.spellSlots,
    preparedSpellIds: engine.getState().player.preparedSpellIds,
    resources: engine.getState().player.resources,
    levelUps: history,
  };
  await writeFile(saveFilePath(playerDef.id), JSON.stringify(updated, null, 2));

  // Push a state_update so any connected websocket clients re-render the HUD
  // with the new HP / spell slots.
  pushStateUpdate(id, [], engine.getState());

  return reply.send({ preview, state: engine.getState(), playerDef });
});

/**
 * Install the per-session 6-second world-tick interval. Called from every
 * session-creation path (the manual `/game/session` route + the chapter
 * advancer). The handle is cleared by `deleteSession`.
 */
function installWorldTick(sessionId: string, engine: GameEngine): void {
  const tickMs = 6000;  // One SRD round per real-time tick.
  const handle = setInterval(() => {
    if (!isWorldTickEligible(sessionId)) return;
    const events = engine.runOffCameraTick();
    if (events.length > 0) {
      pushStateUpdate(sessionId, events, engine.getState());
    }
  }, tickMs);
  setWorldTickHandle(sessionId, handle);
}

server.post("/game/session/:id/action", async (req, reply) => {
  const { id } = req.params as { id: string };
  const engine = getEngine(id);
  if (!engine) return reply.code(404).send({ error: "Session not found" });

  const logLengthBefore = engine.getState().eventLog.length;
  const action = req.body as PlayerAction;
  const { events, state } = engine.processAction(action);

  const newEventEntries = state.eventLog.slice(logLengthBefore);
  pushAdventureLines(
    id,
    newEventEntries.map((e) => ({
      type: "combat" as const,
      text: e.right ? `${e.left}  [${e.right}]` : e.left,
    })),
  );

  // Auto-save after each action — spread existing save to preserve adventureLog.
  const player = state.player;
  const existingSave = (await readSave(player.defId)) as CharSave;
  await writeSave(player.defId, {
    ...existingSave,
    playerDefId: player.defId,
    hp: player.hp,
    xp: player.xp,
    gold: player.gold,
    inventoryIds: player.inventoryIds,
    resources: player.resources,
    equippedSlots: player.equippedSlots,
    spellSlots: player.spellSlots,
    preparedSpellIds: player.preparedSpellIds,
  });

  pushStateUpdate(id, events, state);
  await saveWorldState(state, getAigmHistory(id) ?? []);
  return reply.send({ events, state });
});

server.post("/game/session/:id/aigm", async (req, reply) => {
  const { id } = req.params as { id: string };
  const engine = getEngine(id);
  if (!engine) return reply.code(404).send({ error: "Session not found" });

  const body = req.body as AIGMChatRequest;
  if (!body.playerMessage)
    return reply.code(400).send({ error: "Missing playerMessage" });

  const history = getAigmHistory(id);
  if (!history) return reply.code(404).send({ error: "Session not found" });

  // Per-session mutex — defends against concurrent AIGM requests on the same
  // session (double-clicks, dueling tabs) which would otherwise interleave
  // engine mutations and history writes.
  if (!tryAcquireAigmLock(id)) {
    return reply.code(429).send({ error: "An AIGM request is already in progress for this session." });
  }

  try {
    pushAdventureLines(id, [{ type: "dm_player", text: body.playerMessage }]);

    // `[<player> says to <target>]: <line>` is the wrapper the HUD chat (and
    // the Player Panel TALK button) emits when the player addresses an NPC.
    // Surface the spoken line in the Event Log immediately and push a state
    // update so the player sees their dialogue land in the log right away
    // rather than waiting for the GM's response to ship the next state.
    const saytoMatch = body.playerMessage.match(/^\[(.+?) says to (.+?)\]:\s*(.+)$/s);
    if (saytoMatch) {
      const [, sayer, target, line] = saytoMatch;
      engine.addLog({ left: `💬 ${sayer} → ${target}: "${line.trim()}"`, style: 'status' });
      pushStateUpdate(id, [], engine.getState());
    }

    const logLengthBefore = engine.getState().eventLog.length;
    const archive = getAigmArchive(id);

    // E. Open the streaming AIGM channel on the WebSocket.
    push(id, { type: "aigm_start" });

    const {
      reply: aigmReply,
      events,
      rollResults,
    } = await processAIGMChat(engine, body, anthropic, history, archive, {
      onChunk: (text) => push(id, { type: "aigm_chunk", text }),
      onCheckpoint: () => push(id, { type: "aigm_checkpoint" }),
      onSpeculativeDiscard: () => push(id, { type: "aigm_speculative_discard" }),
    });
    const state = engine.getState();
    const newEventEntries = state.eventLog.slice(logLengthBefore);
    pushAdventureLines(id, [
      ...newEventEntries.map((e) => ({
        type: "combat" as const,
        text: e.right ? `${e.left}  [${e.right}]` : e.left,
      })),
      { type: "dm_reply" as const, text: aigmReply },
    ]);
    pushStateUpdate(id, events, state);
    push(id, { type: "aigm_done", reply: aigmReply, rollResults });
    await saveWorldState(state, history);
    return reply.send({ reply: aigmReply, rollResults });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("AIGM API error:", message);
    return reply.code(502).send({ error: message });
  } finally {
    releaseAigmLock(id);
  }
});

server.delete("/game/session/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const adventureData = getAdventureData(id);
  if (adventureData) {
    const { meta, lines, state } = adventureData;
    const record: EncounterRecord = {
      id,
      timestamp: meta.timestamp,
      description: meta.description,
      encounterTitle: meta.encounterTitle,
      xpGained: state.player.xp - meta.xpStart,
      goldGained: state.player.gold - meta.goldStart,
      outcome:
        state.phase === "defeat" || state.player.hp <= 0
          ? "defeated"
          : "survived",
      lines,
    };
    const existingSave = await readSaveIfExists(state.player.defId);
    if (existingSave) {
      await writeSave(state.player.defId, {
        ...existingSave,
        encounterLog: [record, ...(existingSave.encounterLog ?? [])],
      });
    }
  }
  deleteSession(id);
  await deleteWorldSave();
  return reply.code(200).send({ ok: true });
});

// ── Storylog generation ────────────────────────────────────────────────────────

server.post("/save/:characterId/storylog", async (req, reply) => {
  const { characterId } = req.params as { characterId: string };
  const { rewrite } = req.query as Record<string, string>;
  const save = (await readSave(characterId)) as CharSave;
  const storylog = await generateStorylog(
    anthropic,
    save.encounterLog ?? [],
    save.storylog ?? [],
    rewrite === "true",
  );
  await writeSave(characterId, { ...save, storylog });
  return reply.send({ storylog });
});

// ── WebSocket endpoint ─────────────────────────────────────────────────────────

server.get("/game/session/:id/ws", { websocket: true }, (socket, req) => {
  const { id } = req.params as { id: string };
  const engine = getEngine(id);
  if (!engine) {
    socket.send(
      JSON.stringify({
        type: "error",
        message: "Session not found",
      } satisfies ServerWSMessage),
    );
    socket.close();
    return;
  }
  registerWebSocket(id, socket);
  socket.send(
    JSON.stringify({
      type: "state_update",
      // Flush any events queued during session construction — notably the
      // intro cinematic emitted by `encounter_started` triggers (supertitle,
      // fade-in, opening announcement). The buffer is consumed once, so a
      // mid-session WS reconnect doesn't re-replay the intro.
      events: engine.consumeStartupEvents(),
      state: engine.getState(),
    } satisfies ServerWSMessage),
  );
});

// ── Start ──────────────────────────────────────────────────────────────────────

await loadDefs();
await server.listen({ port: 3000, host: "0.0.0.0" });
console.log("Server listening on http://localhost:3000");
