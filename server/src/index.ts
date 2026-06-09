// Wall-clock at the very top of index.ts. Used by the "Ready in Xms"
// line printed once the server is listening. Includes everything from
// transpile-tax + module load through `loadDefs` and `server.listen`,
// so the number you see is what a developer waiting at the terminal
// actually waited.
const startupT0 = performance.now();

import { config as loadEnv } from "dotenv";
import { resolve } from "path";
loadEnv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), "../../.env"),
});
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { readFile, readdir, writeFile, mkdir, unlink, access, rm } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { buildEncounter } from "./encounterService.js";
import { generateEncounter } from "./encounterGenerator.js";
import { generateTile, GENERATED_TILE_SIZE, GENERATED_TILE_COLUMNS } from "./tileGenerator.js";
import {
  getQuestEncounter, isGeneratedEncounterId,
  setGeneratedMapTilesets,
  serialiseForSave as serialiseQuestsForSave,
  restoreFromSave as restoreQuestsFromSave,
} from "./quest/questRegistry.js";
import type { GeneratedQuest } from "./quest/questGenTypes.js";
import { registerGenerateRoutes } from "./routes/generate.js";
import { safeId, asString, asArray, InvalidPathSegmentError } from "./util/requestValidation.js";
import { processAIGMChat, AIGMChatRequest } from "./aigm.js";
import { loadSettings, settingPromptBlock } from "./settings.js";
import { loadServerConfig, saveServerConfig } from "./serverConfig.js";
import {
  generateStorylog,
  type EncounterRecord,
  type StorylogEntry,
} from "./storylog.js";
import { GameEngine } from "./engine/GameEngine.js";
import { GameDefs } from "./engine/types.js";
import { deriveRelationshipsFromDispositions } from "./engine/Relationships.js";
import { Logger } from "./Logger.js";
import { PLAYER_FACTION_ID, parseCreatureSize } from "../../shared/types.js";
import {
  applyEquipment,
  applySpecies,
} from "./engine/EquipmentSystem.js";
import { applyModifiers } from "./engine/Modifiers.js";
import { speciesFeatureIds } from "./engine/SpeciesAbilities.js";
import { CreateSessionRequest } from "./engine/types.js";
import type { MapTilesetInfo, TokenSpec } from "../../shared/types.js";
import {
  loadPartsLibrary, composeToken, listPartCatalog,
  type PartsLibrary, type TokenSlot, TOKEN_SLOTS,
} from "./tokenCompose.js";
import {
  loadOrCreateNpcSave, flushNpcSaves, deleteAllNpcSavesForCharacter,
} from "./engine/NpcSavePersistence.js";
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
  QuestState,
  QuestDef,
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

/**
 * Resolve the effective Development Mode flags for a session-create call.
 * Server-side file (in `server_config.json`) is the source of truth — it
 * persists across server restarts and across browsers. Any flag the client
 * also sent is OR-ed in so a one-off override still applies. Returns
 * `undefined` when no flags are active so the per-session GameState stays
 * clean and indistinguishable from a vanilla play session.
 */
async function resolveDevFlags(
  clientFlags: import("../../shared/types.js").DevFlags | undefined,
): Promise<import("../../shared/types.js").DevFlags | undefined> {
  const file = (await loadServerConfig(DATA_DIR)).devFlags ?? {};
  const merged: import("../../shared/types.js").DevFlags = {};
  if (file.disableSupertitle   || clientFlags?.disableSupertitle)   merged.disableSupertitle = true;
  if (file.unlimitedSpellSlots || clientFlags?.unlimitedSpellSlots) merged.unlimitedSpellSlots = true;
  if (file.unlockAllSpells     || clientFlags?.unlockAllSpells)     merged.unlockAllSpells = true;
  if (file.unlimitedActions    || clientFlags?.unlimitedActions)    merged.unlimitedActions = true;
  if (file.allowRetryChecks    || clientFlags?.allowRetryChecks)    merged.allowRetryChecks = true;
  if (file.completePrimaryObjective || clientFlags?.completePrimaryObjective) merged.completePrimaryObjective = true;
  return Object.keys(merged).length === 0 ? undefined : merged;
}

async function readDir<T>(dir: string): Promise<T[]> {
  const files = await readdir(dir);
  return Promise.all(
    files
      .filter((f) => f.endsWith(".json"))
      .map(async (f) => JSON.parse(await readFile(join(dir, f), "utf-8")) as T),
  );
}

/**
 * Resolve a setting-owned content directory under the active setting (e.g.
 * `settings/the_sundered_reach/encounters`). Returns null when there is no
 * active setting — callers treat that as "content unavailable" rather than
 * falling through to a removed top-level path. Used by the HTTP routes and
 * `loadEncounterDef` / `loadAdventureDef` to keep paths in one place.
 */
function settingSubDir(sub: string): string | null {
  if (!defs.activeSetting) return null;
  return join(DATA_DIR, "settings", defs.activeSetting.id, sub);
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
  quests: [],
  factions: [],
  settings: [],
  activeSetting: null,
  tileLegend: { notes: "", tiles: {} },
  tileLegendsByTileset: {},
  conversations: [],
  classes: [],
  subclasses: [],
};

async function loadDefs(): Promise<void> {
  // Step 1 — load settings + pick active. Setting-owned content
  // (characters, npcs, maps, factions, adventures, encounters, saves) is
  // sourced from `settings/<active>/`; without an active setting those
  // rosters stay empty (only shared SRD content loads).
  const settingsResult = await loadSettings(DATA_DIR);
  defs.settings = settingsResult.settings;
  defs.activeSetting = settingsResult.active;
  const settingSub = (sub: string): string | null =>
    defs.activeSetting ? join(DATA_DIR, "settings", defs.activeSetting.id, sub) : null;
  const readDirOrEmpty = async <T>(dir: string | null): Promise<T[]> => dir ? readDir<T>(dir) : [];

  // Step 2 — shared SRD content + setting-owned content, in parallel.
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
    conversations,
    classes,
    subclasses,
    quests,
  ] = await Promise.all([
    readDirOrEmpty<GameDefs["playerDefs"][0]>(settingSub("characters")),
    readDir<GameDefs["monsters"][0]>(join(DATA_DIR, "monsters")),
    readDirOrEmpty<GameDefs["npcs"][0]>(settingSub("npcs")),
    readDir<GameDefs["equipment"][0]>(join(DATA_DIR, "equipment")),
    readDirOrEmpty<TiledMapFile>(settingSub("maps")),
    readDir<GameDefs["feats"][0]>(join(DATA_DIR, "feats")),
    readDir<GameDefs["backgrounds"][0]>(join(DATA_DIR, "backgrounds")),
    readDir<GameDefs["species"][0]>(join(DATA_DIR, "species")),
    readDir<GameDefs["spells"][0]>(join(DATA_DIR, "spells")),
    readDir<GameDefs["features"][0]>(join(DATA_DIR, "features")),
    readDir<GameDefs["narration"][0]>(join(DATA_DIR, "narration")),
    readDirOrEmpty<GameDefs["factions"][0]>(settingSub("factions")),
    readDirOrEmpty<GameDefs["conversations"][0]>(settingSub("conversations")),
    readDirOrEmpty<GameDefs["classes"][0]>(join(DATA_DIR, "classes")),
    readDirOrEmpty<GameDefs["subclasses"][0]>(join(DATA_DIR, "subclasses")),
    readDirOrEmpty<GameDefs["quests"][0]>(settingSub("quests")).catch(() => []),
  ]) as [
    GameDefs["playerDefs"], GameDefs["monsters"], GameDefs["npcs"], GameDefs["equipment"],
    TiledMapFile[], GameDefs["feats"], GameDefs["backgrounds"], GameDefs["species"],
    GameDefs["spells"], GameDefs["features"], GameDefs["narration"], GameDefs["factions"],
    GameDefs["conversations"], GameDefs["classes"], GameDefs["subclasses"], GameDefs["quests"],
  ];
  defs.playerDefs = playerDefs;
  defs.monsters = monsters;
  // US-107: parse each monster's SRD size from the leading token of its
  // free-text `type` string ("Medium or Small Humanoid" → 'medium'), keeping
  // `type` for display. Done once at load so spawned NpcStates can inherit it.
  for (const m of defs.monsters) m.size = parseCreatureSize(m.type);
  defs.npcs = npcs;
  defs.equipment = equipment;
  defs.feats = feats;
  defs.backgrounds = backgrounds;
  defs.species = species;
  defs.spells = spells;
  defs.features = features;
  defs.narration = narration;
  defs.factions = factions;
  defs.conversations = conversations;
  defs.classes = classes;
  defs.subclasses = subclasses;
  defs.quests = quests;
  for (const p of defs.playerDefs) {
    applySpecies(p, defs.species);
    // Surface activated species abilities (Orc Adrenaline Rush, …) as known
    // features so the existing button / guard / dispatch pipeline drives them.
    for (const fid of speciesFeatureIds(p, defs.species)) {
      (p.defaultFeatureIds ??= []).push(fid);
    }
    applyModifiers(p, defs.feats, defs.features);
    applyEquipment(p, p.defaultEquipment, defs.equipment);
  }
  defs.maps = await Promise.all(rawMaps.map(loadTiledMap));
  const legends = await loadTileLegends();
  defs.tileLegend = legends.merged;
  defs.tileLegendsByTileset = legends.byTileset;
  // Snapshot the scribble + water tileset metadata for the mission
  // generator. Any outdoor map references both; we pick the first one
  // that has the union of needed tilesets. Procedural missions reuse
  // these refs unchanged so the generated maps render with the same
  // tiles as authored content.
  cacheGeneratedMapTilesetsFromDefs(defs.maps);
  // Token Creator parts library. Loaded once at boot — fragments don't
  // change without a server restart, so caching them in memory is fine and
  // makes each compose request a pure CPU op.
  tokenPartsLibrary = await loadPartsLibrary(TOKEN_PARTS_DIR);
}

let tokenPartsLibrary: PartsLibrary = { parts: {} as Record<TokenSlot, Record<string, string>> };

/**
 * Load and merge every `*_legend.json` file under server/data/tilesets/ into a
 * single GID-keyed lookup. Used by SessionBuilder as a passability fallback
 * when an encounter omits a GID from its `tileProperties`.
 */
async function loadTileLegends(): Promise<{ merged: GameDefs["tileLegend"]; byTileset: GameDefs["tileLegendsByTileset"] }> {
  const files = await readdir(TILESETS_DIR);
  const legendFiles = files.filter((f) => f.endsWith("_legend.json"));
  // `merged` flattens every tileset's tiles into one GID→entry map — convenient
  // for AI map-prompt listings, but lossy: tilesets share local GID keys, so a
  // later file overwrites an earlier one (scribble 8 = grass vs water 8 =
  // water_edge_w). `byTileset` keeps each tileset's legend separate, keyed by
  // its base name, so gameplay resolution (SessionBuilder) stays collision-free.
  const merged: GameDefs["tileLegend"] = { notes: "", tiles: {} };
  const byTileset: GameDefs["tileLegendsByTileset"] = {};
  for (const file of legendFiles) {
    const raw = JSON.parse(await readFile(join(TILESETS_DIR, file), "utf-8")) as GameDefs["tileLegend"] & { tileset?: string };
    if (raw.notes && !merged.notes) merged.notes = raw.notes;
    Object.assign(merged.tiles, raw.tiles);
    const name = (raw.tileset ?? file.replace(/_legend\.json$/i, "")).toLowerCase();
    byTileset[name] = raw.tiles;
  }
  return { merged, byTileset };
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
  /** Author-time named tile regions. Sibling field, NOT a Tiled object-
   *  group. The map editor reads / writes these via the SavedMapDef. */
  zones?: Array<{ id: string; name: string; color: string; cells: string[] }>;
}

// Tileset metadata surfaced to the client so it can preload the image and
// slice it correctly. The `imageUrl` is a relative URL the server serves
// from /tilesets/<filename> (see the static route below).
/**
 * Build a tileset-local `{ tileId → blocksMovement }` map from a Tiled .tsj's
 * `tiles[].properties[]`. Tiled authors the source property as `passable`
 * (its convention), so we read that name and invert it into the engine's
 * `blocksMovement` model. Tiles without the property are omitted — absence
 * means "does not block" (Tiled's convention: unmarked tiles are passable).
 */
function extractTileBlocksMovement(tiles: TiledTileDef[] | undefined): Record<number, boolean> {
  const out: Record<number, boolean> = {};
  for (const t of tiles ?? []) {
    const prop = t.properties?.find((p) => p.name === "passable");
    if (prop && typeof prop.value === "boolean") out[t.id] = !prop.value;
  }
  return out;
}

const TILESETS_DIR = join(DATA_DIR, "tilesets");
/** Source SVGs for AI-generated tiles, one file per gid (`<gid>.svg`). The
 *  assembled spritesheet lives in TILESETS_DIR as `generated.png`. */
const GENERATED_TILES_DIR = join(DATA_DIR, "tiles", "generated");
const GENERATED_TILESET = "generated";
const TOKENS_DIR = join(DATA_DIR, "tokens");
const TOKEN_PARTS_DIR = join(TOKENS_DIR, "parts");
const TOKEN_SPECS_DIR = join(TOKENS_DIR, "specs");
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
      tileBlocksMovement: extractTileBlocksMovement(inline.tiles),
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
    zones: file.zones,
  };
}

/**
 * Capture the scribble + water tileset metadata once at startup so the
 * mission generator can attach them to procedurally-composed maps
 * without re-reading .tsj files on every roll.
 *
 * Strategy: pick the first authored map whose tileset list is a
 * superset of what an outdoor procedural map will reference. Failing
 * that, fall back to the first map's tilesets — the renderer will only
 * see GIDs that map to one of these, so missing the water tileset
 * (used by coastline features which procedural missions don't request)
 * is harmless.
 */
/**
 * Clean Mode — when `devFlags.cleanModeOnStart` is on in the server
 * config, wipe every save artefact under each setting's `saves/`
 * directory before the server starts accepting requests. The flag
 * stays on across restarts; an operator disables it from the
 * Configuration screen when they're done iterating.
 *
 * What gets wiped (per setting):
 *   • `saves/world.json`          — in-progress encounter state
 *   • `saves/<charId>.json`        — character HP / XP / inventory / level-ups
 *   • `saves/<charId>_adventure.json` — adventure-level progress
 *   • `saves/<charId>_npcs/`       — persistent NPC saves
 *
 * Note: the `saves/` directory itself is preserved (recreated when
 * absent during first save write). Settings without a `saves/` dir
 * yet are skipped silently.
 *
 * Off-flag short-circuit — when the flag is unset, the function
 * returns immediately without touching disk.
 */
async function wipeAllSavesIfCleanMode(): Promise<void> {
  const flags = (await loadServerConfig(DATA_DIR)).devFlags ?? {};
  if (!flags.cleanModeOnStart) return;

  const settingsDir = join(DATA_DIR, "settings");
  let settings: string[];
  try {
    settings = await readdir(settingsDir);
  } catch {
    Logger.log('server.clean_mode_wipe', { skipped: 'no settings dir' }, 'warn');
    return;
  }

  const wiped: string[] = [];
  for (const setting of settings) {
    const savesDir = join(settingsDir, setting, "saves");
    let entries: string[];
    try {
      entries = await readdir(savesDir);
    } catch {
      // No saves dir for this setting — nothing to wipe.
      continue;
    }
    for (const name of entries) {
      // Skip dotfiles — `.gitkeep` sentinels are committed to keep
      // empty saves/ directories alive in git and should survive
      // Clean Mode. The wipe is about player progress, not VCS plumbing.
      if (name.startsWith('.')) continue;
      const full = join(savesDir, name);
      try {
        await rm(full, { recursive: true, force: true });
        wiped.push(`${setting}/saves/${name}`);
      } catch (err) {
        Logger.log('server.clean_mode_wipe_failed', { path: full, error: String(err) }, 'warn');
      }
    }
  }

  console.warn(`[clean-mode] wiped ${wiped.length} save artefact(s):`);
  for (const p of wiped) console.warn(`  • ${p}`);
  Logger.log('server.clean_mode_wipe', { count: wiped.length, paths: wiped });
}

function cacheGeneratedMapTilesetsFromDefs(maps: GameDefs['maps']): void {
  if (maps.length === 0) return;
  // Prefer a map that includes both scribble and water tilesets; else
  // any outdoor map; else the first map.
  const outdoor = maps.find((m) => m.tilesets.length >= 2)
    ?? maps.find((m) => /road|woods|ward|field|ruin/.test(m.id))
    ?? maps[0];
  setGeneratedMapTilesets(outdoor.tilesets);
}

// ── Server setup ───────────────────────────────────────────────────────────────

const server = Fastify({ logger: false });
await server.register(cors, { origin: "http://localhost:5173" });
await server.register(websocket);

// A rejected path segment (crafted id that fails the slug allowlist) is a bad
// request, not a server fault — map it to 400 so callers get a clear error.
server.setErrorHandler((err, _req, reply) => {
  if (err instanceof InvalidPathSegmentError) {
    return reply.code(400).send({ error: err.message });
  }
  return reply.send(err);
});

// ── Static data routes — see routes/defs.ts ───────────────────────────────────
//
// `/characters`, `/monsters`, `/npcs`, …, `/maps`, `/health` plus the
// dir-backed `/encounters` + `/adventures` live in their own module so this
// file stays focused on bootstrap + closure setup.

import { registerDefsRoutes } from "./routes/defs.js";
registerDefsRoutes(server, {
  anthropic,
  dataDir: DATA_DIR,
  getDefs: () => defs,
  loadDefs,
  settingSubDir,
  resolveDevFlags,
});

/**
 * Upsert an authored adventure. Writes `<active-setting>/adventures/<id>.json`
 * with the body as-is (after light shape validation) and reloads defs so
 * subsequent /adventures reads include the new file. Used by the Adventure
 * Creator's SAVE button.
 */
server.post<{
  Body: import("../../shared/types.js").AdventureDef;
}>("/adventure", async (req, reply) => {
  const dir = settingSubDir("adventures");
  if (!dir) return reply.code(400).send({ error: "No active setting" });
  const body = req.body;
  if (!body || typeof body !== "object") return reply.code(400).send({ error: "Body must be an AdventureDef object" });
  if (!body.id || !/^[a-z0-9_]+$/.test(body.id)) {
    return reply.code(400).send({ error: "adventure.id must be a snake_case slug (lowercase letters, digits, underscores)" });
  }
  if (!body.title || typeof body.title !== "string") return reply.code(400).send({ error: "adventure.title is required" });
  if (!Array.isArray(body.chapters) || body.chapters.length === 0) {
    return reply.code(400).send({ error: "adventure.chapters must be a non-empty array" });
  }
  const encountersDir = settingSubDir("encounters");
  const validEncounterIds = new Set(
    encountersDir
      ? (await readDir<{ id: string }>(encountersDir).catch(() => [])).map((e) => e.id)
      : [],
  );
  for (const ch of body.chapters) {
    if (!ch.id || !ch.encounterId) return reply.code(400).send({ error: `chapter missing id/encounterId` });
    if (validEncounterIds.size > 0 && !validEncounterIds.has(ch.encounterId)) {
      return reply.code(400).send({ error: `chapter "${ch.id}" references unknown encounter "${ch.encounterId}"` });
    }
  }
  if (body.restEncounterId && validEncounterIds.size > 0 && !validEncounterIds.has(body.restEncounterId)) {
    return reply.code(400).send({ error: `restEncounterId "${body.restEncounterId}" is not a known encounter` });
  }
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${safeId(body.id)}.json`), JSON.stringify(body, null, 2));
    await loadDefs();
    return reply.send({ adventureId: body.id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /adventure] failed", msg);
    return reply.code(500).send({ error: msg });
  }
});

/**
 * Upsert an authored NPC. Writes `<active-setting>/npcs/<id>.json` and
 * reloads defs so subsequent `/npcs` reads (and the next session's spawn
 * pass) pick up the new entry. Used by the NPC Creator's SAVE button.
 *
 * `monsterClass` must point at an existing monster id — the engine resolves
 * an NPC's stats by looking up its monsterClass in the monster roster
 * (`SpawnHelpers.spawnNpc` + `GameEngine.resolveMonsterDef`), so an NPC with
 * no monsterClass would spawn with default fallback HP and no attack.
 */
server.post<{
  Body: import("../../shared/types.js").NPCDef;
}>("/npc", async (req, reply) => {
  const dir = settingSubDir("npcs");
  if (!dir) return reply.code(400).send({ error: "No active setting" });
  const body = req.body;
  if (!body || typeof body !== "object") return reply.code(400).send({ error: "Body must be an NPCDef object" });
  if (!body.id || !/^[a-z0-9_]+$/.test(body.id)) {
    return reply.code(400).send({ error: "npc.id must be a snake_case slug (lowercase letters, digits, underscores)" });
  }
  if (!body.name || typeof body.name !== "string") return reply.code(400).send({ error: "npc.name is required" });
  if (!body.monsterClass || typeof body.monsterClass !== "string") {
    return reply.code(400).send({ error: "npc.monsterClass is required (id of a monster the NPC inherits stats from)" });
  }
  const validMonsterIds = new Set(defs.monsters.map((m) => m.id));
  if (!validMonsterIds.has(body.monsterClass)) {
    return reply.code(400).send({ error: `npc.monsterClass "${body.monsterClass}" is not a known monster id` });
  }
  if (body.factionId) {
    const validFactionIds = new Set(defs.factions.map((f) => f.id));
    if (validFactionIds.size > 0 && !validFactionIds.has(body.factionId)) {
      return reply.code(400).send({ error: `npc.factionId "${body.factionId}" is not a known faction id` });
    }
  }
  // Coerce optional fields to a clean serialisable shape — strip blank strings
  // so the written JSON doesn't carry empty placeholders the engine has to
  // treat specially.
  const clean: import("../../shared/types.js").NPCDef = {
    id: body.id,
    name: body.name.trim(),
    monsterClass: body.monsterClass,
    color: typeof body.color === "number" ? body.color : 0xAABBCC,
    ...(body.persona && body.persona.trim() ? { persona: body.persona.trim() } : {}),
    ...(body.tokenAsset && body.tokenAsset.trim() ? { tokenAsset: body.tokenAsset.trim() } : {}),
    ...(body.factionId ? { factionId: body.factionId } : {}),
  };
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${clean.id}.json`), JSON.stringify(clean, null, 2));
    await loadDefs();
    return reply.send({ npcId: clean.id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /npc] failed", msg);
    return reply.code(500).send({ error: msg });
  }
});

/**
 * POST /npc/test-chat — author-side preview of how Claude will roleplay an
 * NPC given a persona. No game session is required; the request carries the
 * draft directly. Returns a one-shot reply (the conversation history is
 * client-managed and echoed back on every call).
 *
 * Mirrors the in-game AIGM flow at the prompt level — same persona-driven
 * roleplay voice, same setting block — but strips combat / encounter
 * context that doesn't apply at authoring time. Use this to dial in voice
 * and persona before saving the NPC and running it in an encounter.
 */
server.post<{
  Body: {
    draft: {
      name: string;
      monsterClass?: string;
      factionId?: string;
      persona: string;
    };
    history: Array<{ role: "user" | "assistant"; content: string }>;
    prompt: string;
  };
}>("/npc/test-chat", async (req, reply) => {
  const { draft, history, prompt } = req.body;
  if (!draft || typeof draft !== "object") {
    return reply.code(400).send({ error: "draft must be an object" });
  }
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return reply.code(400).send({ error: "prompt is required" });
  }
  if (!Array.isArray(history)) {
    return reply.code(400).send({ error: "history must be an array" });
  }
  if (!draft.persona || draft.persona.trim().length === 0) {
    return reply.code(400).send({ error: "draft.persona is required for a test chat" });
  }

  const setting = settingPromptBlock(defs.activeSetting ?? null, "summary");
  const monsterDef = draft.monsterClass ? defs.monsters.find((m) => m.id === draft.monsterClass) : undefined;
  const faction = draft.factionId ? defs.factions.find((f) => f.id === draft.factionId) : undefined;
  const factionLine = faction ? `${faction.name} (${faction.id})` : draft.factionId || "none";
  const statLine = monsterDef
    ? `${monsterDef.name} — ${monsterDef.type ?? "—"} · CR ${monsterDef.cr ?? "0"} · HP ${monsterDef.maxHp}`
    : "(no monster class set — improvise their physicality if asked)";

  const system = `${setting ? setting + "\n\n" : ""}You are roleplaying a single NPC in a 2D tile-based SRD 5.2.1 RPG. This is an AUTHORING preview — the user (the author) is talking to you to test the NPC's voice before they save the NPC and run them in an encounter. Stay in character at all times; do not break the fourth wall.

CHARACTER SHEET:
  Name: ${draft.name || "(unnamed)"}
  Monster class (stat block they inherit): ${statLine}
  Faction: ${factionLine}

PERSONA — keep replies SHORT and in their voice. Reply in plain prose only; no system messages, no tool calls, no meta:
${draft.persona.trim()}

INSTRUCTIONS:
- Speak ONLY as the NPC. Keep replies to 1-3 sentences unless the author explicitly invites a longer answer.
- Stay grounded in the setting (above) and the persona (above). Do not invent setting facts that contradict it.
- The author may ask the NPC to talk about themselves, react to scenes, or play out a hypothetical exchange. Roleplay it.
- If the author asks an out-of-character question (e.g. "what's your stat block?"), answer it briefly and clearly — this is a preview, the author is checking their work.`;

  // Build the message history Claude will see. We capture only the most
  // recent ~16 exchanges to keep the API call lean; the client maintains the
  // full transcript locally.
  const trimmedHistory = history.slice(-16).filter((m) => m.content && m.content.trim().length > 0);
  const messages = [
    ...trimmedHistory.map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: prompt.trim() },
  ];

  try {
    const resp = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 512,
      system,
      messages,
    });
    const reply_text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("")
      .trim();
    return reply.send({ reply: reply_text || "(The NPC stays silent.)" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /npc/test-chat] failed", msg);
    return reply.code(500).send({ error: msg });
  }
});

/**
 * GET /server-config — single endpoint backing the Configuration page. Returns
 * the full persisted `ServerConfig` (active setting id + Development Mode
 * flags) AND the list of every loaded setting so the picker can render in one
 * round trip. Read once on scene mount.
 */
server.get("/server-config", async () => {
  const config = await loadServerConfig(DATA_DIR);
  return {
    activeSettingId: defs.activeSetting?.id ?? null,
    devFlags: config.devFlags ?? {},
    settings: defs.settings.map((s) => ({ id: s.id, name: s.name, version: s.version, ruleset: s.ruleset, summary: s.summary, sections: s.sections })),
  };
});

/**
 * PUT /server-config — replace the persisted Configuration in one shot. Body
 * accepts `activeSettingId` (string id, `null`, or omitted to leave
 * unchanged) and `devFlags` (a subset of the 4 Development Mode toggles).
 * Writes to `server_config.json` and reloads every JSON-backed def when the
 * active setting changes. Returns the updated config + settings list so the
 * client renders without an extra GET.
 */
server.put<{ Body: { activeSettingId?: string | null; devFlags?: import("../../shared/types.js").DevFlags } }>("/server-config", async (req, reply) => {
  const body = req.body ?? {};

  // Validate activeSettingId if the caller is changing it.
  if (body.activeSettingId !== undefined && body.activeSettingId !== null) {
    if (typeof body.activeSettingId !== 'string') {
      return reply.code(400).send({ error: "activeSettingId must be a string or null" });
    }
    if (!defs.settings.find((s) => s.id === body.activeSettingId)) {
      return reply.code(400).send({ error: `unknown setting id "${body.activeSettingId}"` });
    }
  }

  const current = await loadServerConfig(DATA_DIR);
  const next = { ...current };

  if (body.activeSettingId !== undefined) {
    next.activeSettingId = body.activeSettingId;
  }
  if (body.devFlags !== undefined) {
    // Sanitise — only the known flags, always booleans, omitted-when-false.
    const sanitised: import("../../shared/types.js").DevFlags = {};
    if (body.devFlags.disableSupertitle)    sanitised.disableSupertitle = true;
    if (body.devFlags.unlimitedSpellSlots)  sanitised.unlimitedSpellSlots = true;
    if (body.devFlags.unlockAllSpells)      sanitised.unlockAllSpells = true;
    if (body.devFlags.unlimitedActions)     sanitised.unlimitedActions = true;
    if (body.devFlags.showDeleteSaveButton) sanitised.showDeleteSaveButton = true;
    if (body.devFlags.allowRetryChecks)     sanitised.allowRetryChecks = true;
    if (body.devFlags.completePrimaryObjective) sanitised.completePrimaryObjective = true;
    if (body.devFlags.showDevToolsPanel)    sanitised.showDevToolsPanel = true;
    if (body.devFlags.cleanModeOnStart)     sanitised.cleanModeOnStart = true;
    if (body.devFlags.logLevel === "none" || body.devFlags.logLevel === "regular" || body.devFlags.logLevel === "maximum") {
      sanitised.logLevel = body.devFlags.logLevel;
    }
    next.devFlags = sanitised;
  }

  await saveServerConfig(DATA_DIR, next);
  Logger.setLevel(next.devFlags?.logLevel ?? "regular");

  // Reload all defs only when the active setting actually changed —
  // characters, NPCs, factions, adventures, encounters, maps re-source from
  // the new setting's folders. A dev-flag-only PUT skips this work.
  const settingChanged = body.activeSettingId !== undefined && body.activeSettingId !== current.activeSettingId;
  if (settingChanged) await loadDefs();

  return reply.send({
    activeSettingId: defs.activeSetting?.id ?? null,
    devFlags: next.devFlags ?? {},
    settings: defs.settings.map((s) => ({ id: s.id, name: s.name, version: s.version, ruleset: s.ruleset, summary: s.summary, sections: s.sections })),
  });
});

// All /generate/* routes live in their own module — see routes/generate.ts.
registerGenerateRoutes(server, {
  anthropic,
  getDefs: () => defs,
  loadDefs,
  getSettingDataDir: () => {
    if (!defs.activeSetting) throw new Error("Cannot generate content — no active setting.");
    return join(DATA_DIR, "settings", defs.activeSetting.id);
  },
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

server.post<{ Body: { characterId: string; adventureId: string; devFlags?: import("../../shared/types.js").DevFlags } }>(
  "/adventure/start",
  async (req, reply) => {
    const { characterId, adventureId, devFlags } = req.body;
    const adv = await loadAdventureDef(adventureId);
    if (!adv) return reply.code(404).send({ error: "Unknown adventureId" });
    let save = await readAdventureSave(characterId);
    if (!save || save.adventureId !== adventureId) {
      save = makeAdventureSave(characterId, adventureId);
      await writeAdventureSave(save);
    }
    // Booting a chapter fresh — clear any stale world save (e.g. left over from
    // a different adventure) so it can't shadow this start as an exact-resume.
    // Exact resume of an in-progress chapter goes through `GET /world`, not here.
    await deleteWorldSave();
    const result = await startAdventureChapter(characterId, adv, save, devFlags);
    if ("error" in result) return reply.code(400).send(result);
    return reply.send(result);
  },
);

/**
 * POST /adventure/:characterId/checkpoint — persist the in-progress chapter's
 * cross-chapter state into the AdventureSave WITHOUT advancing. Called when the
 * player leaves an adventure mid-chapter (the LEAVE ADVENTURE button) so the
 * adventure can be resumed from Adventure Setup with world flags, faction
 * standings, rumors and NPC memory intact — rather than replaying the chapter
 * from its last boundary. Mirrors the cross-chapter capture in `/advance`,
 * minus the chapter bump + summary. No-op (`ok:false`) when there's no active
 * adventure save or no live session.
 */
server.post<{ Params: { characterId: string } }>(
  "/adventure/:characterId/checkpoint",
  async (req, reply) => {
    const { characterId } = req.params;
    const save = await readAdventureSave(characterId);
    if (!save) return reply.send({ ok: false });
    const found = findSessionByCharacter(characterId);
    if (!found) return reply.send({ ok: false });
    const state = found.session.engine.getState();
    save.worldFlags = { ...state.worldFlags };
    Object.assign(save, carryForwardQuests(state));
    save.factionStandings = { ...state.factionStandings };
    save.factionRelations = structuredClone(state.factionRelations);
    save.relationships = structuredClone(state.relationships);
    save.discoveredFactions = [...state.discoveredFactions];
    save.rumors = [...state.rumors];
    await flushSessionNpcSaves(found.sessionId);
    await writeAdventureSave(save);
    // Persist the EXACT live state to the world save so returning restores the
    // encounter as it was left — positions, NPC HP, combat phase, zones, log.
    // (The AdventureSave capture above is the cross-chapter fallback used only
    // if the world save is ever missing.) Crucially we do NOT delete it here.
    await saveWorldState(state, getAigmHistory(found.sessionId) ?? []);
    return reply.send({ ok: true });
  },
);

server.post<{ Params: { characterId: string }; Body: { devFlags?: import("../../shared/types.js").DevFlags } }>(
  "/adventure/:characterId/advance",
  async (req, reply) => {
    const { characterId } = req.params;
    const advanceDevFlags = req.body?.devFlags;
    const save = await readAdventureSave(characterId);
    if (!save) return reply.code(404).send({ error: "No active adventure for this character" });
    const adv = await loadAdventureDef(save.adventureId);
    if (!adv) return reply.code(404).send({ error: "Adventure definition missing" });

    // Rest-stop handoff: if the player was in the rest interlude, "advance"
    // means "finish resting and go to the queued next chapter". Drop the
    // rest session and the flag, then fall through to the normal chapter
    // boot below. We do NOT summarize the rest, do NOT bump
    // `currentChapterIndex` (already bumped when rest started), and do NOT
    // append to `completedChapterIds`.
    if (save.inRest) {
      const found = findSessionByCharacter(characterId);
      if (found) {
        await flushSessionNpcSaves(found.sessionId);
        deleteSession(found.sessionId);
      }
      save.inRest = false;
      await deleteWorldSave();
      await writeAdventureSave(save);
      if (save.currentChapterIndex >= adv.chapters.length) {
        // Defensive — shouldn't happen because rest fires between chapters,
        // never after the last one.
        return reply.send({ complete: true, save });
      }
      const result = await startAdventureChapter(characterId, adv, save, advanceDevFlags);
      if ("error" in result) return reply.code(400).send(result);
      return reply.send({ complete: false, ...result });
    }

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
      Object.assign(save, carryForwardQuests(finishedState));
      save.factionStandings = { ...finishedState.factionStandings };
      save.factionRelations = structuredClone(finishedState.factionRelations);
      save.relationships = structuredClone(finishedState.relationships);
      save.discoveredFactions = [...finishedState.discoveredFactions];
      save.rumors = [...finishedState.rumors];
      await flushSessionNpcSaves(found.sessionId);
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
    const result = await startAdventureChapter(characterId, adv, save, advanceDevFlags);
    if ("error" in result) return reply.code(400).send(result);
    return reply.send({ complete: false, ...result });
  },
);

/**
 * Start the rest-stop interlude session. Called when the player accepts the
 * "rest first?" prompt between chapters. Tears down the just-finished chapter
 * session, bumps `currentChapterIndex` (the rest sits in the gap before the
 * next chapter), records `inRest=true` on the adventure save, and boots the
 * adventure's `restEncounterId` encounter as a session marked
 * `isRestSession=true` on its adventureContext.
 *
 * When the player leaves the rest session, the client calls
 * `/adventure/:characterId/advance`, which detects `inRest` and routes to the
 * next chapter without re-summarising the rest.
 */
server.post<{ Params: { characterId: string }; Body: { devFlags?: import("../../shared/types.js").DevFlags } }>(
  "/adventure/:characterId/rest",
  async (req, reply) => {
    const { characterId } = req.params;
    const restDevFlags = req.body?.devFlags;
    const save = await readAdventureSave(characterId);
    if (!save) return reply.code(404).send({ error: "No active adventure for this character" });
    const adv = await loadAdventureDef(save.adventureId);
    if (!adv) return reply.code(404).send({ error: "Adventure definition missing" });
    if (!adv.restEncounterId) return reply.code(400).send({ error: "Adventure has no restEncounterId" });
    const chapter = adv.chapters[save.currentChapterIndex];
    if (!chapter) return reply.code(400).send({ error: "No current chapter to rest after" });

    // Capture cross-chapter state from the just-completed chapter so it
    // survives the rest interlude. Mirrors the equivalent block in the
    // advance route.
    const found = findSessionByCharacter(characterId);
    const aigmHistory = found?.session.aigmHistory ?? [];
    if (found) {
      const finishedState = found.session.engine.getState();
      save.worldFlags = { ...finishedState.worldFlags };
      Object.assign(save, carryForwardQuests(finishedState));
      save.factionStandings = { ...finishedState.factionStandings };
      save.factionRelations = structuredClone(finishedState.factionRelations);
      save.relationships = structuredClone(finishedState.relationships);
      save.discoveredFactions = [...finishedState.discoveredFactions];
      save.rumors = [...finishedState.rumors];
      await flushSessionNpcSaves(found.sessionId);
      deleteSession(found.sessionId);
    }

    // Summarise + mark the just-completed chapter complete BEFORE entering
    // rest. That way the chapter index is already at "the chapter after rest"
    // and the subsequent `/advance` (from LEAVE on the rest screen) only has
    // to start the next chapter session — no double-summarisation.
    const summary = await summarizeChapter(chapter.title, aigmHistory);
    save.priorChapterSummaries.push({ chapterId: chapter.id, chapterTitle: chapter.title, summary });
    if (!save.completedChapterIds.includes(chapter.id)) save.completedChapterIds.push(chapter.id);
    save.currentChapterIndex += 1;
    save.inRest = true;
    await deleteWorldSave();
    await writeAdventureSave(save);

    const result = await startAdventureRest(characterId, adv, save, restDevFlags);
    if ("error" in result) return reply.code(400).send(result);
    return reply.send(result);
  },
);

// `/maps` and `/health` were moved into routes/defs.ts above.

// Directory listing — returns image metadata for every .tsj in the tilesets
// dir so the client can preload every spritesheet at boot (including ones
// not yet referenced by any saved map, e.g. a fresh tileset that's only
// going to be used by the next composed preview).
/**
 * Per-tileset legend payload for the Map Editor's EDIT tab. Each entry keeps
 * its own LOCAL gid keys (always 1-based within the tileset) so the client
 * can render thumbnails against the matching spritesheet without worrying
 * about firstgid offsets — those live on each saved map's `tilesets` array.
 *
 * Returns one entry per `*_legend.json` file in the tilesets dir, with
 * `tileset` derived from the filename. The legacy `/tilesets/legends-merged`
 * shape (a single flat map of GID → entry) collapsed scribble's "1" and
 * water's "1" into the same slot, which made it impossible to tell which
 * tileset a thumbnail should come from.
 */
server.get("/tilesets/legends", async (_req, reply) => {
  const files = await readdir(TILESETS_DIR);
  const legendFiles = files.filter((f) => f.endsWith("_legend.json"));
  const tilesets: Array<{
    tileset: string;
    image: string;
    notes: string;
    tiles: import("../../shared/types.js").TileLegend["tiles"];
  }> = [];
  for (const file of legendFiles) {
    const raw = JSON.parse(await readFile(join(TILESETS_DIR, file), "utf-8")) as {
      tileset?: string;
      image?: string;
      notes?: string;
      tiles: import("../../shared/types.js").TileLegend["tiles"];
    };
    // Filename is `<name>_legend.json`; derive the tileset name from it when
    // the JSON didn't bother to set it explicitly (scribble_legend.json).
    const name = raw.tileset ?? file.replace(/_legend\.json$/i, "");
    tilesets.push({
      tileset: name,
      image: `/tilesets/${raw.image ?? `${name}.png`}`,
      notes: raw.notes ?? "",
      tiles: raw.tiles,
    });
  }
  return reply.send({ tilesets });
});

/**
 * PUT /tilesets/:tileset/tiles/:gid — upsert a single tile's legend entry.
 * Backs the Tile Creator's SAVE button: the author selects a tileset frame
 * and edits its attributes (name, layer, blocksMovement, blocksSight, cover,
 * obscurance, tags, description). Writes the entry back into
 * `<tileset>_legend.json` (preserving notes + every other tile) and reloads
 * defs so subsequent sessions bake the new semantics. Creating an entry for a
 * frame that had none and editing an existing one are the same operation.
 */
server.put<{ Params: { tileset: string; gid: string }; Body: import("../../shared/types.js").TileLegendEntry }>(
  "/tilesets/:tileset/tiles/:gid",
  async (req, reply) => {
    const tileset = req.params.tileset;
    if (!/^[A-Za-z0-9_-]+$/.test(tileset)) {
      return reply.code(400).send({ error: "invalid tileset name" });
    }
    if (!/^[1-9][0-9]*$/.test(req.params.gid)) {
      return reply.code(400).send({ error: "gid must be a positive integer" });
    }
    const gid = req.params.gid;
    const b = req.body;
    if (!b || typeof b !== "object") return reply.code(400).send({ error: "Body must be a tile legend entry" });
    if (typeof b.name !== "string" || !b.name.trim()) return reply.code(400).send({ error: "tile.name is required" });
    if (b.layer !== "ground" && b.layer !== "object") return reply.code(400).send({ error: "tile.layer must be 'ground' or 'object'" });
    if (b.cover !== undefined && b.cover !== "half" && b.cover !== "three-quarters" && b.cover !== "total") {
      return reply.code(400).send({ error: "tile.cover must be half | three-quarters | total" });
    }
    if (b.obscurance !== undefined && b.obscurance !== "lightly" && b.obscurance !== "heavily") {
      return reply.code(400).send({ error: "tile.obscurance must be lightly | heavily" });
    }

    const legendPath = join(TILESETS_DIR, `${tileset}_legend.json`);
    let legend: { notes?: string; image?: string; tileset?: string; tiles: Record<string, unknown> };
    try {
      legend = JSON.parse(await readFile(legendPath, "utf-8"));
    } catch {
      return reply.code(404).send({ error: `tileset "${tileset}" has no legend file` });
    }

    // Build a clean entry — coerce types and drop blank optionals so the
    // written JSON stays tidy and matches the TileLegendEntry shape.
    const entry: import("../../shared/types.js").TileLegendEntry = {
      name: b.name.trim(),
      blocksMovement: b.blocksMovement === true,
      blocksSight: b.blocksSight === true,
      layer: b.layer,
      description: typeof b.description === "string" ? b.description : "",
      tags: Array.isArray(b.tags) ? b.tags.filter((t): t is string => typeof t === "string") : [],
      ...(b.cover ? { cover: b.cover } : {}),
      ...(b.obscurance ? { obscurance: b.obscurance } : {}),
    };
    legend.tiles ??= {};
    legend.tiles[gid] = entry;

    try {
      await writeFile(legendPath, JSON.stringify(legend, null, 2) + "\n");
      await loadDefs();
      return reply.send({ tileset, gid: Number(gid), entry });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[PUT /tilesets/:tileset/tiles/:gid] failed", msg);
      return reply.code(500).send({ error: msg });
    }
  },
);

// ── Tile generator ─────────────────────────────────────────────────────────
// The AIGM authors a tile as SVG; the client rasterises + composites it into
// the shared `generated` tileset, then saves the assembled sheet + legend here.

/** Existing generated tiles, in gid order — used by the client to re-assemble
 *  the spritesheet (it rasterises every source SVG, taint-free, and appends the
 *  new frame). */
server.get("/tiles/generated", async (_req, reply) => {
  const legendPath = join(TILESETS_DIR, `${GENERATED_TILESET}_legend.json`);
  let legend: { tiles?: Record<string, import("../../shared/types.js").TileLegendEntry> };
  try {
    legend = JSON.parse(await readFile(legendPath, "utf-8"));
  } catch {
    return reply.send({ tiles: [], tileSize: GENERATED_TILE_SIZE, columns: GENERATED_TILE_COLUMNS });
  }
  const gids = Object.keys(legend.tiles ?? {}).map(Number).filter((n) => n > 0).sort((a, b) => a - b);
  const tiles: Array<{ gid: number; svg: string; entry: unknown }> = [];
  for (const gid of gids) {
    let svg = "";
    try { svg = await readFile(join(GENERATED_TILES_DIR, `${gid}.svg`), "utf-8"); } catch { /* missing svg */ }
    tiles.push({ gid, svg, entry: legend.tiles![String(gid)] });
  }
  return reply.send({ tiles, tileSize: GENERATED_TILE_SIZE, columns: GENERATED_TILE_COLUMNS });
});

/** Generate a tile from a free-text description → SVG + suggested attributes. */
server.post<{ Body: { description?: string } }>("/tiles/generate", async (req, reply) => {
  const description = (req.body?.description ?? "").trim();
  if (!description) return reply.code(400).send({ error: "description is required" });
  try {
    // Send the primary tileset as a vision reference so generated tiles match
    // its art style + palette. Skipped gracefully if the image isn't present.
    let reference: { base64: string; mediaType: "image/png" } | undefined;
    try {
      const png = await readFile(join(TILESETS_DIR, "scribble.png"));
      reference = { base64: png.toString("base64"), mediaType: "image/png" };
    } catch { /* no reference tileset — generate without one */ }
    const result = await generateTile(anthropic, description, reference);
    return reply.send(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /tiles/generate] failed", msg);
    return reply.code(500).send({ error: msg });
  }
});

/** Persist a newly-generated tile: the client sends the source SVG, its legend
 *  entry, and the FULL re-assembled spritesheet PNG (existing frames + the new
 *  one, in gid order). The new tile is appended at gid = existingCount + 1 (the
 *  generated tileset is append-only). Writes png/.tsj/_legend.json/<gid>.svg and
 *  reloads defs so the tile is immediately part of the database. */
server.post<{ Body: { svg?: string; entry?: import("../../shared/types.js").TileLegendEntry; pngBase64?: string } }>(
  "/tiles/save",
  async (req, reply) => {
    const b = req.body ?? {};
    const svg = typeof b.svg === "string" ? b.svg : "";
    const e = b.entry;
    const pngBase64 = typeof b.pngBase64 === "string" ? b.pngBase64.replace(/^data:image\/png;base64,/, "") : "";
    if (!svg.includes("<svg")) return reply.code(400).send({ error: "svg is required" });
    if (!pngBase64) return reply.code(400).send({ error: "pngBase64 (assembled sheet) is required" });
    if (!e || typeof e !== "object" || typeof e.name !== "string" || !e.name.trim()) {
      return reply.code(400).send({ error: "entry.name is required" });
    }
    if (e.layer !== "ground" && e.layer !== "object") return reply.code(400).send({ error: "entry.layer must be ground|object" });

    const legendPath = join(TILESETS_DIR, `${GENERATED_TILESET}_legend.json`);
    let legend: { notes: string; tileset: string; image: string; tiles: Record<string, import("../../shared/types.js").TileLegendEntry> };
    try {
      legend = JSON.parse(await readFile(legendPath, "utf-8"));
      legend.tiles ??= {};
    } catch {
      legend = { notes: "AI-generated tiles. Appended via the Tile Creator's Generate panel.", tileset: GENERATED_TILESET, image: `${GENERATED_TILESET}.png`, tiles: {} };
    }

    const existingCount = Object.keys(legend.tiles).length;
    const gid = existingCount + 1; // append-only; standalone gid == frame + 1

    const entry: import("../../shared/types.js").TileLegendEntry = {
      name: e.name.trim(),
      blocksMovement: e.blocksMovement === true,
      blocksSight: e.blocksSight === true,
      layer: e.layer,
      description: typeof e.description === "string" ? e.description : "",
      tags: Array.isArray(e.tags) ? e.tags.filter((t): t is string => typeof t === "string") : [],
      ...(e.cover ? { cover: e.cover } : {}),
      ...(e.obscurance ? { obscurance: e.obscurance } : {}),
    };
    legend.tiles[String(gid)] = entry;

    const total = gid;
    const rows = Math.ceil(total / GENERATED_TILE_COLUMNS);
    const tsj = {
      name: GENERATED_TILESET,
      image: `${GENERATED_TILESET}.png`,
      tilewidth: GENERATED_TILE_SIZE,
      tileheight: GENERATED_TILE_SIZE,
      columns: GENERATED_TILE_COLUMNS,
      imagewidth: GENERATED_TILE_COLUMNS * GENERATED_TILE_SIZE,
      imageheight: rows * GENERATED_TILE_SIZE,
      tilecount: total,
      margin: 0,
      spacing: 0,
    };

    try {
      await mkdir(GENERATED_TILES_DIR, { recursive: true });
      await mkdir(TILESETS_DIR, { recursive: true });
      await writeFile(join(GENERATED_TILES_DIR, `${gid}.svg`), svg);
      await writeFile(join(TILESETS_DIR, `${GENERATED_TILESET}.png`), Buffer.from(pngBase64, "base64"));
      await writeFile(join(TILESETS_DIR, `${GENERATED_TILESET}.tsj`), JSON.stringify(tsj, null, 2) + "\n");
      await writeFile(legendPath, JSON.stringify(legend, null, 2) + "\n");
      await loadDefs();
      return reply.send({ gid, tileset: GENERATED_TILESET, entry });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[POST /tiles/save] failed", msg);
      return reply.code(500).send({ error: msg });
    }
  },
);

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

/** Token Creator — list every authored token SVG filename. The LOAD overlay
 *  uses this to populate its card grid. Excludes the `parts/` and `specs/`
 *  subdirectories; only top-level `*.svg` files in `data/tokens/`. */
server.get("/tokens", async (_req, reply) => {
  try {
    const files = await readdir(TOKENS_DIR);
    return reply.send(files.filter((f) => f.endsWith(".svg")));
  } catch {
    return reply.send([]);
  }
});

/** Token Creator — return the full parts library in a single payload so the
 *  scene can compose previews locally without round-tripping per slot
 *  change. Shape: `{ slots: { body: { plain: "<circle.../>", … }, … } }`.
 *  Fragments still carry the `{{COLOR}}` placeholders — the client stamps
 *  them at preview time. */
server.get("/tokens/parts", async (_req, reply) => {
  return reply.send({
    slots: tokenPartsLibrary.parts,
    catalog: listPartCatalog(tokenPartsLibrary),
  });
});

/** Token Creator — list every saved spec id (filename without `.json`). The
 *  LOAD overlay calls this BEFORE rendering its card grid so the cards know
 *  which SVG filenames are also editable specs (vs. legacy hand-authored
 *  tokens that don't have one). */
server.get("/token-specs", async (_req, reply) => {
  try {
    const files = await readdir(TOKEN_SPECS_DIR);
    return reply.send(files.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/i, "")));
  } catch {
    return reply.send([]);
  }
});

/** Token Creator — read back an authored spec for re-editing. Returns 404
 *  when the spec isn't on disk (e.g. the user just typed an id that doesn't
 *  exist yet). */
server.get<{ Params: { id: string } }>(
  "/token-specs/:id",
  async (req, reply) => {
    const { id } = req.params;
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      return reply.code(400).send({ error: "invalid token id" });
    }
    try {
      const raw = await readFile(join(TOKEN_SPECS_DIR, `${id}.json`), "utf-8");
      return reply.type("application/json").send(raw);
    } catch {
      return reply.code(404).send({ error: "token spec not found" });
    }
  },
);

// Static token SVGs — referenced from `PlayerDef.tokenAsset`,
// `MonsterDef.tokenAsset`, and optionally `NPCDef.tokenAsset`. Loaded by the
// client's `BootScene.preload` and rendered by Player + NpcToken. Registered
// AFTER `/tokens` and `/tokens/parts` so the static-segment routes are
// matched first and the parametric `:filename` only catches the rest.
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

/**
 * Token Creator — save (upsert) a token. Composes the SVG from the spec +
 * the in-memory parts library and writes BOTH:
 *   • `data/tokens/<id>.svg`        — the flattened SVG referenced via
 *     `NPCDef.tokenAsset` (no special engine handling needed).
 *   • `data/tokens/specs/<id>.json` — the editable spec, so re-opening the
 *     Token Creator restores every slot pick + palette choice.
 *
 * Returns the token's full asset path so the client can drop it straight
 * into the NPC Creator's `TOKEN ASSET PATH` field.
 */
server.post<{ Body: TokenSpec; Querystring: { overwrite?: string } }>("/token", async (req, reply) => {
  const spec = req.body;
  if (!spec || typeof spec !== "object") {
    return reply.code(400).send({ error: "Body must be a TokenSpec object" });
  }
  if (!spec.id || !/^[a-z0-9_]+$/.test(spec.id)) {
    return reply.code(400).send({ error: "token.id must be a snake_case slug (lowercase letters, digits, underscores)" });
  }
  if (!spec.slots || typeof spec.slots !== "object") {
    return reply.code(400).send({ error: "token.slots is required (slot → part id map)" });
  }
  // Reject unknown slot keys to avoid quietly losing data. The TOKEN_SLOTS
  // array is the canonical z-order — anything outside it would render at the
  // wrong layer and confuse a later edit pass.
  for (const k of Object.keys(spec.slots)) {
    if (!(TOKEN_SLOTS as readonly string[]).includes(k)) {
      return reply.code(400).send({ error: `unknown slot "${k}" — must be one of: ${TOKEN_SLOTS.join(", ")}` });
    }
  }
  // Validate each part id is in the loaded library so a typo doesn't silently
  // produce a missing-layer token. Empty slots are allowed (skipped at
  // compose time). Existence check uses `in` rather than truthiness so a
  // legitimate part whose SVG fragment happens to be empty (placeholder)
  // still passes — the truthy form rejected anything whose composed string
  // was "".
  for (const slot of TOKEN_SLOTS) {
    const partId = spec.slots[slot];
    if (!partId) continue;
    if (!(partId in (tokenPartsLibrary.parts[slot] ?? {}))) {
      return reply.code(400).send({ error: `slot "${slot}" references unknown part "${partId}"` });
    }
  }
  // Pre-flight overwrite check. The Token Creator should warn before
  // clobbering an existing token; the client retries with `?overwrite=true`
  // once the user has confirmed. We check both files so a stale-pair (only
  // SVG or only spec on disk) still surfaces the conflict.
  const overwrite = req.query.overwrite === "true";
  if (!overwrite) {
    const svgPath = join(TOKENS_DIR, `${spec.id}.svg`);
    const specPath = join(TOKEN_SPECS_DIR, `${spec.id}.json`);
    let svgExists = false;
    let specExists = false;
    try { await access(svgPath); svgExists = true; } catch { /* not there */ }
    try { await access(specPath); specExists = true; } catch { /* not there */ }
    if (svgExists || specExists) {
      return reply.code(409).send({
        error: `token "${spec.id}" already exists — retry with ?overwrite=true to replace it`,
        existing: { svg: svgExists, spec: specExists },
      });
    }
  }
  try {
    const svg = composeToken(spec, tokenPartsLibrary);
    await mkdir(TOKEN_SPECS_DIR, { recursive: true });
    await writeFile(join(TOKENS_DIR, `${spec.id}.svg`), svg);
    await writeFile(join(TOKEN_SPECS_DIR, `${spec.id}.json`), JSON.stringify(spec, null, 2));
    return reply.send({ id: spec.id, tokenAsset: `/tokens/${spec.id}.svg` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /token] failed", msg);
    return reply.code(500).send({ error: msg });
  }
});

// ── Save routes (unchanged) ────────────────────────────────────────────────────

/**
 * Saves live inside the active setting (`settings/<id>/saves/`). A character
 * created in The Sundered Reach can't be loaded in a generic-SRD game, and
 * vice versa — the save path enforces that binding mechanically. Helpers
 * throw when no setting is active so callers fail loudly rather than write
 * to a stale path.
 */
function savesDir(): string {
  if (!defs.activeSetting) throw new Error("Cannot resolve saves path — no active setting.");
  return join(DATA_DIR, "settings", defs.activeSetting.id, "saves");
}
function worldSavePath(): string {
  return join(savesDir(), "world.json");
}
function saveFilePath(characterId: string): string {
  return join(savesDir(), `${safeId(characterId)}.json`);
}
function adventureSaveFilePath(characterId: string): string {
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
type WorldSave = Omit<GameState, "player"> & {
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

interface CharSave {
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
  levelUps?: import("../../shared/types.js").LevelUpChoices[];
}

/** Quests that survive a chapter boundary: adventure/world scope only (encounter
 *  scope dies with the encounter), plus the runtime defs they reference. */
function carryForwardQuests(state: GameState): { quests: QuestState[]; runtimeQuestDefs: QuestDef[] } {
  const scopeOf = (id: string): string | undefined =>
    state.runtimeQuestDefs.find((d) => d.id === id)?.scope ?? defs.quests.find((d) => d.id === id)?.scope;
  const quests = state.quests.filter((q) => { const sc = scopeOf(q.questId); return sc === 'adventure' || sc === 'world'; });
  const keep = new Set(quests.map((q) => q.questId));
  return { quests, runtimeQuestDefs: state.runtimeQuestDefs.filter((d) => keep.has(d.id)) };
}

async function saveWorldState(
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

async function loadWorldState(): Promise<{
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

async function deleteWorldSave(): Promise<void> {
  try {
    await unlink(worldSavePath());
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
    balanceCp: char?.defaultCp ?? 0,
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
  await mkdir(savesDir(), { recursive: true });
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
  seedRelationships?: Record<string, Record<string, number>>;
  seedDiscoveredFactions?: string[];
  seedRumors?: Rumor[];
  seedQuests?: QuestState[];
  seedRuntimeQuestDefs?: QuestDef[];
} {
  const chapter = adv.chapters[chapterIndex];
  // Mirror the rest-stop fields so the client can decide whether to surface
  // the "rest first?" prompt at chapter-advance time without a separate
  // adventure-registry fetch. We only forward the id here; the title is
  // resolved client-side from the cached encounters registry so we don't
  // have to make `buildAdventureSeed` async just to read an encounter file.
  return {
    adventureId: adv.id,
    adventureTitle: adv.title,
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    chapterIndex,
    totalChapters: adv.chapters.length,
    completionFlag: chapter.completionFlag,
    priorChapterSummaries: save.priorChapterSummaries,
    restEncounterId: adv.restEncounterId,
    seedWorldFlags: { ...save.worldFlags },
    seedQuests: save.quests ?? [],
    seedRuntimeQuestDefs: save.runtimeQuestDefs ?? [],
    seedFactionStandings: { ...save.factionStandings },
    // Carry the full pair-wise faction matrix across chapters when present.
    // Older saves without this field fall back to seeding the `party` row
    // from `seedFactionStandings` + faction-def defaults.
    seedFactionRelations: save.factionRelations
      ? structuredClone(save.factionRelations)
      : undefined,
    seedRelationships: save.relationships
      ? structuredClone(save.relationships)
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
    relationships: {},
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
  placementMode?: 'zones' | 'exact';
  placements?: import("./engine/types.js").EncounterPlacement[];
  triggers?: import("./engine/types.js").EncounterTrigger[];
  traps?: import("./engine/types.js").EncounterTrapDef[];
  environment?: import("./engine/types.js").EncounterEnvironment;
  /** Optional per-encounter override for the global faction-relation matrix. */
  factionRelations?: Record<string, Record<string, number>>;
  /** Optional per-encounter conversation override — see
   *  `EncounterDef.conversationOverrides`. Threaded into the session via
   *  `CreateSessionRequest.conversationOverrides`. */
  conversationOverrides?: Record<string, string>;
}

async function loadAdventureDef(adventureId: string): Promise<AdventureDef | null> {
  const dir = settingSubDir("adventures");
  if (!dir) return null;
  const all = await readDir<AdventureDef>(dir);
  return all.find((a) => a.id === adventureId) ?? null;
}

async function loadEncounterDef(encounterId: string): Promise<EncounterDefJson | null> {
  const dir = settingSubDir("encounters");
  if (!dir) return null;
  const all = await readDir<EncounterDefJson>(dir);
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
  devFlags?: import("../../shared/types.js").DevFlags,
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
    placementMode: encDef.placementMode,
    placements: encDef.placements,
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
    encounterId: encDef.id,
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
    placementMode: encDef.placementMode,
    placements: encDef.placements,
    triggers: encDef.triggers,
    traps: encDef.traps,
    conversationOverrides: encDef.conversationOverrides,
    adventureSeed,
    resumeHp: charSave?.hp,
    resumeXp: charSave?.xp,
    resumeCp: charSave?.balanceCp,
    resumeInventoryIds: charSave?.inventoryIds,
    resumeEquippedSlots: charSave?.equippedSlots,
    resumeResources: charSave?.resources,
    resumeSpellSlots: charSave?.spellSlots,
    resumePreparedSpellIds: charSave?.preparedSpellIds,
    resumeLevelUps: charSave?.levelUps,
    devFlags: await resolveDevFlags(devFlags),
  };

  const engine = GameEngine.createSession(sessionId, { ...req, encounterContext }, defs, savedMap);
  await attachPersistentNpcSaves(engine, playerDef.id);
  createSession(sessionId, engine);
  installWorldTick(sessionId, engine);
  await ensureSaveExists(playerDef.id);
  // Combat auto-start now lives inside `GameEngine.createSession` — see the
  // matching comment on the main `/game/session` route. Keeps the chapter-
  // advance path consistent with single-encounter session creation.
  return { sessionId, state: engine.getState(), playerDef: engine.getPlayerDef() };
}

/**
 * Load the saves for every persistent NPC the engine spawned and attach them
 * to the engine. Mutations during the session land in the in-memory copies;
 * `flushSessionNpcSaves` writes them back at session boundaries.
 */
async function attachPersistentNpcSaves(engine: GameEngine, characterId: string): Promise<void> {
  const settingDir = settingSubDir("");
  if (!settingDir) return; // no active setting → no persistence
  const state = engine.getState();
  const seen = new Set<string>();
  const saves = [] as Awaited<ReturnType<typeof loadOrCreateNpcSave>>[];
  for (const npc of state.npcs) {
    if (seen.has(npc.defId)) continue;
    seen.add(npc.defId);
    const def = defs.npcs.find((n) => n.id === npc.defId);
    if (!def?.persistent) continue;
    // Use the parent setting dir (settingSubDir("") returns the trailing slash)
    const settingDataDir = join(DATA_DIR, "settings", safeId(defs.activeSetting!.id));
    saves.push(await loadOrCreateNpcSave(settingDataDir, safeId(characterId), def));
  }
  engine.attachNpcSaves(saves);
  // Apply stateOverrides onto the spawned NpcStates so prior HP / conditions /
  // disposition / faction carry across encounters.
  for (const save of saves) {
    const npc = state.npcs.find((n) => n.defId === save.npcId);
    if (!npc) continue;
    const o = save.stateOverrides;
    if (o.currentHp !== undefined && o.currentHp > 0) npc.hp = Math.min(npc.maxHp, o.currentHp);
    if (o.conditions) npc.conditions = [...o.conditions];
    if (o.disposition) npc.disposition = o.disposition;
    if (o.factionId)   npc.factionId   = o.factionId;
    if (save.nameKnownToPlayer && !npc.revealedName) npc.revealedName = npc.name;
  }
}

/** Flush every persistent NPC save attached to the session's engine, then
 *  release the in-memory copies. Idempotent — calling on a session without
 *  loaded saves is a no-op. */
async function flushSessionNpcSaves(sessionId: string): Promise<void> {
  const engine = getEngine(sessionId);
  if (!engine || !defs.activeSetting) return;
  const settingDataDir = join(DATA_DIR, "settings", safeId(defs.activeSetting.id));
  const saves = engine.collectNpcSavesForFlush();
  if (saves.length === 0) return;
  await flushNpcSaves(settingDataDir, saves);
}

/**
 * Boot the rest-stop interlude session — the adventure's `restEncounterId`
 * dressed up as a chapter so the existing GameScene plumbing (intro modal,
 * cinematic fade, world-tick, GM chat) just works. The session's
 * adventureContext carries `isRestSession=true` so the client can label the
 * HUD and route LEAVE ENCOUNTER through `/advance` rather than back to the
 * setup screen. `save.currentChapterIndex` should already point at the NEXT
 * chapter when this is called — the rest sits between the just-completed
 * chapter and that one.
 */
async function startAdventureRest(
  characterId: string,
  adv: AdventureDef,
  save: AdventureSave,
  devFlags?: import("../../shared/types.js").DevFlags,
): Promise<{ sessionId: string; state: GameState; playerDef: PlayerDef } | { error: string }> {
  if (!adv.restEncounterId) return { error: "Adventure has no rest encounter" };
  const playerDef = defs.playerDefs.find((p) => p.id === characterId);
  if (!playerDef) return { error: "Unknown character" };
  const encDef = await loadEncounterDef(adv.restEncounterId);
  if (!encDef) return { error: `Unknown rest encounterId "${adv.restEncounterId}"` };
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
    placementMode: encDef.placementMode,
    placements: encDef.placements,
    environment: encDef.environment,
    factionRelations: encDef.factionRelations,
    allowsLongRest: encDef.allowsLongRest,
  });

  // Use a synthetic AdventureSessionContext that points at the NEXT chapter
  // (the one the rest precedes) but with `isRestSession=true`. The chapter
  // labels feed the GM's "ADVENTURE: …" header so it stays oriented.
  const nextIdx = Math.min(save.currentChapterIndex, adv.chapters.length - 1);
  const nextChapter = adv.chapters[nextIdx];
  const adventureSeed = {
    ...buildAdventureSeed(adv, nextIdx, save),
    chapterId: `rest_before_${nextChapter.id}`,
    chapterTitle: encDef.encounterTitle,
    isRestSession: true,
  };

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
    placementMode: encDef.placementMode,
    placements: encDef.placements,
    triggers: encDef.triggers,
    traps: encDef.traps,
    conversationOverrides: encDef.conversationOverrides,
    adventureSeed,
    resumeHp: charSave?.hp,
    resumeXp: charSave?.xp,
    resumeCp: charSave?.balanceCp,
    resumeInventoryIds: charSave?.inventoryIds,
    resumeEquippedSlots: charSave?.equippedSlots,
    resumeResources: charSave?.resources,
    resumeSpellSlots: charSave?.spellSlots,
    resumePreparedSpellIds: charSave?.preparedSpellIds,
    resumeLevelUps: charSave?.levelUps,
    devFlags: await resolveDevFlags(devFlags),
  };

  const engine = GameEngine.createSession(sessionId, { ...req, encounterContext }, defs, savedMap);
  await attachPersistentNpcSaves(engine, playerDef.id);
  createSession(sessionId, engine);
  installWorldTick(sessionId, engine);
  await ensureSaveExists(playerDef.id);
  return { sessionId, state: engine.getState(), playerDef: engine.getPlayerDef() };
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
  const characterId = (req.params as { characterId: string }).characterId;
  try {
    await unlink(saveFilePath(characterId));
  } catch {
    /* gone */
  }
  // Also wipe every persistent NPC's memory tree scoped to this character so
  // a replay with the same character id starts each NPC from a clean slate.
  if (defs.activeSetting) {
    const settingDataDir = join(DATA_DIR, "settings", safeId(defs.activeSetting.id));
    await deleteAllNpcSavesForCharacter(settingDataDir, safeId(characterId));
  }
  return reply.code(200).send({ ok: true });
});

// ── World save (resume) ────────────────────────────────────────────────────────

server.get("/world", async (_req, reply) => {
  const loaded = await loadWorldState();
  if (!loaded) return reply.code(404).send({ error: "No world save" });

  const { state, aigmHistory } = loaded;
  // Restore the procedural-mission registry from the saved snapshot.
  // A player who quit mid-mission will find Vask's contract + the
  // generated map intact when they reload.
  const savedQuests = (state as unknown as WorldSave).inFlightMissions;
  restoreQuestsFromSave(savedQuests);
  // Re-derive per-NPC conversationId from the encounter def on load.
  // World saves written before `conversationOverrides` was wired (or
  // saved against an encounter whose overrides were later edited)
  // would otherwise carry stale `npc.conversationId` values — usually
  // undefined, which makes the TALK button silently fall through to
  // the AIGM free-text chat. Re-resolving here is idempotent: the
  // override always wins, the NPC def is the fallback.
  if (state.currentEncounterId) {
    const encDef = await loadEncounterDef(state.currentEncounterId);
    if (encDef) {
      for (const npc of state.npcs) {
        const cid = encDef.conversationOverrides?.[npc.defId]
          ?? defs.npcs.find((n) => n.id === npc.defId)?.conversationId;
        if (cid) npc.conversationId = cid;
      }
    }
  }
  // Re-use the existing engine if the session is still alive (e.g. hot-reload),
  // otherwise restore from the saved GameState.
  let engine = getEngine(state.sessionId);
  if (!engine) {
    engine = new GameEngine(state, defs);
    await attachPersistentNpcSaves(engine, state.player.defId);
    createSession(state.sessionId, engine);
    setAigmHistory(state.sessionId, aigmHistory);
  }
  return reply.send({
    sessionId: state.sessionId,
    state: engine.getState(),
    playerDef: engine.getPlayerDef(),
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
    placementMode: body.placementMode,
    placements: body.placements,
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
  const resumeCp              = charSaveForResume?.balanceCp       ?? body.resumeCp;
  const resumeInventoryIds    = charSaveForResume?.inventoryIds    ?? body.resumeInventoryIds;
  const resumeEquippedSlots   = charSaveForResume?.equippedSlots   ?? body.resumeEquippedSlots;

  const sessionId = randomUUID();
  const devFlags = await resolveDevFlags(body.devFlags);
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
      resumeCp,
      resumeInventoryIds,
      resumeEquippedSlots,
      devFlags,
    },
    defs,
    savedMap,
  );
  createSession(sessionId, engine);
  installWorldTick(sessionId, engine);
  await ensureSaveExists(playerDef.id);

  // Combat auto-start (when the encounter spawned with hostile NPCs) now
  // happens inside `GameEngine.createSession` so it runs under the
  // `isConstructing` flag and defers the first NPC turn until the cinematic
  // queue has played. Otherwise the bandits would take their turn here, on
  // the server, before the client even connects — and the initial state
  // would show every enemy already at its post-turn tile with no animation.

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
/**
 * Mission/hub transition — swap the current session for one running a
 * different encounter, **preserving** player state (HP, XP, inventory,
 * equipped slots, resources, level-ups) AND world-scope state (worldFlags,
 * factionRelations, factionStandings, discoveredFactions, rumors). The
 * old session is deleted; the new session's id replaces it on the client.
 *
 * Used by the BUREAU OFFICE → MISSION → BUREAU OFFICE cycle: the player
 * accepts a contract, the client POSTs here with the mission encounter id,
 * the server stands up a new session for the mission with all the player's
 * state carried over, and the client redirects to the new session id.
 *
 * Distinct from the adventure-chapter-advance path because:
 *   - it doesn't write or read an AdventureSave (the cycle is in-session,
 *     not adventure-scope);
 *   - it doesn't require an AdventureDef (the player can swap to any
 *     encounter, not just an authored chapter sequence);
 *   - it preserves the full world-flag map verbatim so the bureau-office
 *     conversation tree can read `mission_complete` and `mission_pending`
 *     to drive its branches.
 */
server.post<{
  Params: { id: string };
  Body: { encounterId?: string };
}>("/game/session/:id/transition", async (req, reply) => {
  const { id } = req.params;
  const { encounterId } = req.body ?? {};
  if (typeof encounterId !== 'string' || encounterId.length === 0) {
    return reply.code(400).send({ error: "transition requires { encounterId: string }" });
  }
  const oldEngine = getEngine(id);
  if (!oldEngine) return reply.code(404).send({ error: "Session not found" });

  // Procedural missions live in the in-memory registry, not on disk.
  // The mission id pattern (`mission_gen_<uuid>`) is the discriminator —
  // hand-authored encounters take the loadEncounterDef path; generated
  // ones short-circuit to the registry. Both return the same
  // EncounterDef shape so downstream code is unchanged.
  let encDef: EncounterDefJson;
  let savedMap: GameDefs['maps'][number] | undefined;
  if (isGeneratedEncounterId(encounterId)) {
    const resolved = getQuestEncounter(encounterId);
    if (!resolved) return reply.code(404).send({ error: `Generated quest encounter "${encounterId}" not in registry (expired or never rolled)` });
    encDef = resolved.encounter.encounterDef as unknown as EncounterDefJson;
    savedMap = resolved.encounter.savedMap;
  } else {
    const loaded = await loadEncounterDef(encounterId);
    if (!loaded) return reply.code(404).send({ error: `Unknown encounterId "${encounterId}"` });
    encDef = loaded;
    savedMap = encDef.mapId ? defs.maps.find((m) => m.id === encDef.mapId) : undefined;
  }

  const oldState = oldEngine.getState();
  const playerDef = oldEngine.getPlayerDef();

  // Companions travel with the player across the transition (onto a mission,
  // and back to the station when they leave). The companion mark lives only on
  // the live NpcState (`npc.companion`) — there's no world-level roster — so
  // read it from the OLD session. Inject any companion the target encounter
  // doesn't already author into its ally list (so it spawns near the player),
  // and re-promote them to companions after the new session is built. Their
  // memory (facts / journal / relationship) rides along via the persistent
  // NpcSave flush + attach below.
  const carriedCompanions = oldState.npcs
    .filter((n) => n.companion && n.hp > 0)
    .map((n) => ({ defId: n.defId, followMode: n.companion!.followMode }));
  const authoredDefIds = new Set<string>([
    ...(encDef.npcIds ?? []), ...(encDef.allyIds ?? []), ...(encDef.enemyIds ?? []),
  ]);
  const mergedAllyIds = [
    ...(encDef.allyIds ?? []),
    ...carriedCompanions.map((c) => c.defId).filter((id) => !authoredDefIds.has(id)),
  ];

  // The player's persisted save carries the `levelUps` history — without it the
  // rebuilt player reverts to base level after a transition (e.g. the player
  // levels up mid-mission, then leaves and is back at the old level). HP/XP/
  // inventory still come from the live `oldState` below; only the level-up
  // ladder needs the save.
  const charSave = await readSaveIfExists(playerDef.id);

  // Build the new encounter's context using the target encounter's
  // authored fields (npcs, enemies, allies, prose, placements).
  const encounterContext = buildEncounter({
    mapType: "saved",
    playerDefId: playerDef.id,
    playerName: playerDef.name,
    playerSpeciesName: playerDef.speciesName,
    playerClassName: playerDef.className,
    playerLevel: playerDef.level,
    playerMaxHp: oldState.player.hp,  // carry HP through
    playerAc: playerDef.ac,
    savedMapName: savedMap?.name,
    savedMapDescription: savedMap?.mapdescription,
    npcIds: encDef.npcIds,
    allyIds: mergedAllyIds,
    enemyIds: encDef.enemyIds,
    customIntroduction: encDef.customIntroduction,
    customContext: encDef.customContext,
    customObjective: encDef.objective,
    startingZones: encDef.startingZones,
    placementMode: encDef.placementMode,
    placements: encDef.placements,
    environment: encDef.environment,
    factionRelations: encDef.factionRelations,
    allowsLongRest: encDef.allowsLongRest,
  });

  // Seed world-scope state into the new session via the same
  // `adventureSeed.seedWorldFlags` path the chapter-advance flow uses.
  // The chapter id/title reflect the NEW encounter, but the chapter POSITION
  // (index / total) is carried from the old session so a transition (mission
  // cycle, or a dev encounter reload) doesn't collapse a multi-chapter
  // adventure to "1 of 1" — which the persisted context would otherwise feed
  // back into the wrap-up button as a premature "FINISH ADVENTURE".
  const seed: NonNullable<CreateSessionRequest['adventureSeed']> = {
    adventureId: oldState.adventureContext?.adventureId ?? '',
    adventureTitle: oldState.adventureContext?.adventureTitle ?? '',
    chapterId: encDef.id,
    chapterTitle: encDef.encounterTitle ?? encDef.id,
    chapterIndex: oldState.adventureContext?.chapterIndex ?? 0,
    totalChapters: oldState.adventureContext?.totalChapters ?? 1,
    priorChapterSummaries: oldState.adventureContext?.priorChapterSummaries ?? [],
    seedWorldFlags: { ...oldState.worldFlags },
    seedQuests: carryForwardQuests(oldState).quests,
    seedRuntimeQuestDefs: carryForwardQuests(oldState).runtimeQuestDefs,
    seedFactionStandings: { ...oldState.factionStandings },
    seedFactionRelations: { ...oldState.factionRelations },
    seedDiscoveredFactions: [...oldState.discoveredFactions],
    seedRumors: [...oldState.rumors],
  };

  const newSessionId = randomUUID();
  const req2: CreateSessionRequest = {
    mapType: "saved",
    playerDefId: playerDef.id,
    savedMapId: savedMap?.id,
    encounterId: encDef.id,
    encounterTitle: encDef.encounterTitle,
    savedMapName: savedMap?.name,
    savedMapDescription: savedMap?.mapdescription,
    npcIds: encDef.npcIds,
    allyIds: mergedAllyIds,
    enemyIds: encDef.enemyIds,
    customIntroduction: encDef.customIntroduction,
    customContext: encDef.customContext,
    customObjective: encDef.objective,
    completionFlag: encDef.completionFlag,
    tileProperties: encDef.tileProperties,
    startingZones: encDef.startingZones,
    placementMode: encDef.placementMode,
    placements: encDef.placements,
    triggers: encDef.triggers,
    // Per-NPC conversation overrides — without this the bureau's Vask spawns
    // with no `conversationId` on the return leg, so TALK falls back to free
    // text instead of opening the structured dialogue. Mirrors the other two
    // session-create paths.
    conversationOverrides: encDef.conversationOverrides,
    allowsLongRest: encDef.allowsLongRest,
    adventureSeed: seed,
    // Player state carry-over. Inventory + equipment + spell slots +
    // resources + level-up history all ride through.
    resumeHp: oldState.player.hp,
    resumeXp: oldState.player.xp,
    resumeCp: oldState.player.balanceCp,
    resumeInventoryIds: oldState.player.inventoryIds,
    resumeEquippedSlots: oldState.player.equippedSlots,
    resumeResources: oldState.player.resources,
    resumeSpellSlots: oldState.player.spellSlots,
    resumePreparedSpellIds: oldState.player.preparedSpellIds,
    resumeConcentratingOn: oldState.player.concentratingOn,
    resumeMageArmor: oldState.player.mageArmor,
    resumeLevelUps: charSave?.levelUps,
    devFlags: await resolveDevFlags(undefined),
  };

  // Flush any persistent NPC saves from the old session BEFORE we tear
  // it down — otherwise their stateOverrides (HP, conditions, etc.)
  // don't survive the swap.
  await flushSessionNpcSaves(id);
  deleteSession(id);

  const newEngine = GameEngine.createSession(
    newSessionId,
    { ...req2, encounterContext },
    defs,
    savedMap,
  );
  await attachPersistentNpcSaves(newEngine, playerDef.id);
  // Re-establish companion status on the spawned NPCs — whether injected into
  // the ally list above or already authored in the encounter — so they keep
  // following the player. Runs after `attachPersistentNpcSaves` (which may set
  // disposition from the NpcSave) and before the world tick starts.
  const newState = newEngine.getState();
  // Drop a companion onto the nearest free tile around the player. Used when a
  // companion is authored into the target encounter at a fixed spot (e.g. Edric
  // standing in the station office) — on a return trip he travels WITH the
  // player, so he should appear beside them, not back at his old post.
  const placeNearPlayer = (npc: import("../../shared/types.js").NpcState): void => {
    const px = newState.player.tileX, py = newState.player.tileY;
    const blocked = newState.map.blocksMovement;
    const occupied = new Set<string>([`${px},${py}`]);
    for (const n of newState.npcs) if (n !== npc && n.hp > 0) occupied.add(`${n.tileX},${n.tileY}`);
    for (let r = 1; r <= 4; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = px + dx, y = py + dy;
          if (y < 0 || x < 0 || y >= newState.map.rows || x >= newState.map.cols) continue;
          if (blocked[y]?.[x]) continue;
          if (occupied.has(`${x},${y}`)) continue;
          npc.tileX = x; npc.tileY = y;
          return;
        }
      }
    }
  };
  for (const c of carriedCompanions) {
    const npc = newState.npcs.find((n) => n.defId === c.defId && n.hp > 0);
    if (!npc) continue;
    npc.companion = { followMode: c.followMode, simState: { activeTaskId: null, lastTickId: 0 } };
    npc.disposition = 'ally';
    // If the spawned instance landed far from the player (authored at a fixed
    // placement rather than injected near them), bring it to their side.
    if (Math.max(Math.abs(npc.tileX - newState.player.tileX), Math.abs(npc.tileY - newState.player.tileY)) > 2) {
      placeNearPlayer(npc);
    }
  }
  createSession(newSessionId, newEngine);
  installWorldTick(newSessionId, newEngine);

  return reply.send({
    sessionId: newSessionId,
    state: newEngine.getState(),
    playerDef: newEngine.getPlayerDef(),
  });
});

server.post("/game/session/:id/world-paused", async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = req.body as { paused?: boolean };
  if (typeof body?.paused !== 'boolean') {
    return reply.code(400).send({ error: "world-paused requires { paused: boolean }" });
  }
  const engine = getEngine(id);
  if (!engine) return reply.code(404).send({ error: "Session not found" });
  const previouslyPaused = setWorldPaused(id, body.paused);
  // Paused → unpaused transition: the client has finished playing whatever
  // opening overlay was up. If `encounter_started` deferred the first
  // combat turn, flush it now and broadcast the resulting state so the
  // animation plays under the player's attention rather than behind a modal.
  if (previouslyPaused && !body.paused && engine.getState().pendingTurnAdvance) {
    const events = engine.runPendingTurnAdvance();
    pushStateUpdate(id, events, engine.getState());
  }
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
    balanceCp: state.player.balanceCp,
    inventoryIds: state.player.inventoryIds,
  } as CharSave;
  const updated: CharSave = {
    ...existing,
    hp: state.player.hp,
    xp: state.player.xp,
    balanceCp: state.player.balanceCp,
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
    balanceCp: engine.getState().player.balanceCp,
    inventoryIds: engine.getState().player.inventoryIds,
  } as CharSave;
  const history = (existing.levelUps ?? []).slice();
  history.push(choices);
  const updated: CharSave = {
    ...existing,
    hp: engine.getState().player.hp,
    xp: engine.getState().player.xp,
    balanceCp: engine.getState().player.balanceCp,
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
 *
 * The first tick is deferred so the supertitle, focused-announcement, and
 * fade-in cinematic have time to play before any auto-combat-start path
 * fires (the off-camera tick promotes hostile-NPC presence to combat via
 * `doStartCombat`, which used to run during the opening seconds and steal
 * the player's first combat round before they could see it).
 */
function installWorldTick(sessionId: string, engine: GameEngine): void {
  const tickMs = 6000;  // One SRD round per real-time tick.
  // Opening cinematic budget: supertitle (~2.5s) + focused announcement
  // (~4-5s) + fade-in (~0.8s) + comfort margin. The tick continues to
  // respect `isWorldTickEligible`, so any overlay holding the world pause
  // (intro, supertitle, focused announcement, character sheet, …) extends
  // the quiet window naturally.
  const startupDelayMs = 9000;
  const startInterval = (): void => {
    const handle = setInterval(() => {
      if (!isWorldTickEligible(sessionId)) return;
      const events = engine.runOffCameraTick();
      if (events.length > 0) {
        pushStateUpdate(sessionId, events, engine.getState());
      }
    }, tickMs);
    setWorldTickHandle(sessionId, handle);
  };
  setTimeout(startInterval, startupDelayMs);
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
    balanceCp: player.balanceCp,
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
  if (typeof body.playerMessage !== "string" || body.playerMessage.length === 0)
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
  // Leaving an authored adventure keeps the world save so the exact encounter
  // state can be restored on return (the LEAVE ADVENTURE path passes this).
  const keepWorldSave = (req.query as Record<string, string> | undefined)?.keepWorldSave === '1';
  const adventureData = getAdventureData(id);
  if (adventureData) {
    const { meta, lines, state } = adventureData;
    const record: EncounterRecord = {
      id,
      timestamp: meta.timestamp,
      description: meta.description,
      encounterTitle: meta.encounterTitle,
      xpGained: state.player.xp - meta.xpStart,
      cpGained: state.player.balanceCp - meta.balanceCpStart,
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
  await flushSessionNpcSaves(id);
  deleteSession(id);
  if (!keepWorldSave) await deleteWorldSave();
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
  const startupEvents = engine.consumeStartupEvents();
  socket.send(
    JSON.stringify({
      type: "state_update",
      // Flush any events queued during session construction — notably the
      // intro cinematic emitted by `encounter_started` triggers (supertitle,
      // fade-in, opening announcement). The buffer is consumed once, so a
      // mid-session WS reconnect doesn't re-replay the intro.
      events: startupEvents,
      state: engine.getState(),
    } satisfies ServerWSMessage),
  );
  // Fallback for the no-opening-overlay case. When the startup events
  // include no supertitle / announcement / introduction, the client never
  // acquires the world pause and so the paused→unpaused transition never
  // fires the deferred turn advance. Schedule it on a short timer; the
  // world-paused endpoint takes precedence (clears the flag earlier) if
  // an overlay does acquire the pause.
  const opensWithOverlay = startupEvents.some((e) => e.type === "supertitle" || e.type === "announcement")
    || !!engine.getState().introduction;
  if (engine.getState().pendingTurnAdvance && !opensWithOverlay) {
    setTimeout(() => {
      const eng = getEngine(id);
      if (!eng) return;
      if (!eng.getState().pendingTurnAdvance) return;
      const events = eng.runPendingTurnAdvance();
      pushStateUpdate(id, events, eng.getState());
    }, 1200);
  }
});

// ── Start ──────────────────────────────────────────────────────────────────────

await loadDefs();
const bootConfig = await loadServerConfig(DATA_DIR);
Logger.setLevel(bootConfig.devFlags?.logLevel ?? "regular");
await wipeAllSavesIfCleanMode();
await server.listen({ port: 3000, host: "0.0.0.0" });
const readyMs = Math.round(performance.now() - startupT0);
console.log(`Server listening on http://localhost:3000  ready in ${readyMs}ms`);
