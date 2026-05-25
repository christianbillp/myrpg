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
import { processAIDMChat, AIDMChatRequest } from "./aidm.js";
import {
  generateStorylog,
  type EncounterRecord,
  type StorylogEntry,
} from "./storylog.js";
import { GameEngine } from "./engine/GameEngine.js";
import { GameDefs } from "./engine/types.js";
import {
  applyEquipment,
  applyFeats,
  applySpecies,
} from "./engine/EquipmentSystem.js";
import { CreateSessionRequest } from "./engine/types.js";
import {
  createSession,
  getEngine,
  getAidmHistory,
  setAidmHistory,
  registerWebSocket,
  pushStateUpdate,
  push,
  deleteSession,
  pushAdventureLines,
  getAdventureData,
  tryAcquireAidmLock,
  releaseAidmLock,
  getAidmArchive,
} from "./sessions.js";
import type { AidmMessage } from "./sessions.js";
import type {
  PlayerAction,
  ServerWSMessage,
  GameState,
  PlayerState,
  EquipmentSlots,
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
  ] = await Promise.all([
    readDir<GameDefs["playerDefs"][0]>(join(DATA_DIR, "characters")),
    readDir<GameDefs["monsters"][0]>(join(DATA_DIR, "monsters")),
    readDir<GameDefs["npcs"][0]>(join(DATA_DIR, "npcs")),
    readDir<GameDefs["equipment"][0]>(join(DATA_DIR, "equipment")),
    readDir<{
      id: string;
      name: string;
      mapdescription: string;
      rows: string[];
    }>(join(DATA_DIR, "maps")),
    readDir<GameDefs["feats"][0]>(join(DATA_DIR, "feats")),
    readDir<GameDefs["backgrounds"][0]>(join(DATA_DIR, "backgrounds")),
    readDir<GameDefs["species"][0]>(join(DATA_DIR, "species")),
  ]);
  defs.playerDefs = playerDefs;
  defs.monsters = monsters;
  defs.npcs = npcs;
  defs.equipment = equipment;
  defs.feats = feats;
  defs.backgrounds = backgrounds;
  defs.species = species;
  for (const p of defs.playerDefs) {
    applySpecies(p, defs.species);
    applyFeats(p, defs.feats);
    applyEquipment(p, p.defaultEquipment, defs.equipment);
  }
  defs.maps = rawMaps.map(({ id, name, mapdescription, rows }) => ({
    id,
    name,
    mapdescription,
    cols: rows[0]?.length ?? 0,
    rows: rows.length,
    passable: rows.map((r) => [...r].map((c) => c === ".")),
  }));
}

// ── Server setup ───────────────────────────────────────────────────────────────

const server = Fastify({ logger: false });
await server.register(cors, { origin: "http://localhost:5173" });
await server.register(websocket);

// ── Static data routes (unchanged) ────────────────────────────────────────────

server.get("/characters", async () => defs.playerDefs);
server.get("/monsters", async () => defs.monsters);
server.get("/npcs", async () => defs.npcs);
server.get("/equipment", async () => defs.equipment);
server.get("/feats", async () => defs.feats);
server.get("/backgrounds", async () => defs.backgrounds);
server.get("/species", async () => defs.species);
server.get("/encounters", async () => readDir(join(DATA_DIR, "encounters")));
server.get("/maps", async () => defs.maps);
server.get("/health", async () => ({ ok: true }));

// ── Save routes (unchanged) ────────────────────────────────────────────────────

const SAVES_DIR = join(DATA_DIR, "saves");
const WORLD_SAVE_PATH = join(SAVES_DIR, "world.json");
import { writeFile, mkdir, unlink, access } from "fs/promises";

function saveFilePath(characterId: string): string {
  return join(SAVES_DIR, `${characterId}.json`);
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
  aidmHistory?: AidmMessage[];
};

interface CharSave {
  playerDefId: string;
  hp: number;
  xp: number;
  gold: number;
  inventoryIds: string[];
  secondWindUses: number;
  equippedSlots?: EquipmentSlots;
  encounterLog?: EncounterRecord[];
  storylog?: StorylogEntry[];
}

async function saveWorldState(
  state: GameState,
  aidmHistory: AidmMessage[] = [],
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const {
    hp: _hp,
    xp: _xp,
    gold: _gold,
    inventoryIds: _inv,
    equippedSlots: _eq,
    secondWindUses: _sw,
    ...sessionPlayer
  } = state.player;
  const worldSave: WorldSave = { ...state, player: sessionPlayer, aidmHistory };
  await mkdir(SAVES_DIR, { recursive: true });
  await writeFile(WORLD_SAVE_PATH, JSON.stringify(worldSave));
}

async function loadWorldState(): Promise<{
  state: GameState;
  aidmHistory: AidmMessage[];
} | null> {
  let worldSave: WorldSave;
  try {
    worldSave = JSON.parse(
      await readFile(WORLD_SAVE_PATH, "utf-8"),
    ) as WorldSave;
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
    secondWindUses: charSave.secondWindUses,
    reactionUsed: false,
    hitDiceUsed: 0,
    tempHp: 0,
    heroicInspiration: false,
    exhaustionLevel: 0,
    conditions: [],
    equippedSlotLabels: { armor: null, weapon: null, shield: null },
  };
  const aidmHistory = worldSave.aidmHistory ?? [];
  return { state: { ...worldSave, player: fullPlayer }, aidmHistory };
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
    xp: 0,
    gold: 0,
    inventoryIds: [],
    secondWindUses: char?.secondWindMaxUses ?? 0,
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

server.get("/save/:characterId", async (req) =>
  readSave((req.params as { characterId: string }).characterId),
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

  const { state, aidmHistory } = loaded;
  // Re-use the existing engine if the session is still alive (e.g. hot-reload),
  // otherwise restore from the saved GameState.
  let engine = getEngine(state.sessionId);
  if (!engine) {
    engine = new GameEngine(state, defs);
    createSession(state.sessionId, engine);
    setAidmHistory(state.sessionId, aidmHistory);
  }
  return reply.send({
    sessionId: state.sessionId,
    state: engine.getState(),
    dmHistory: buildDmDisplayHistory(aidmHistory),
  });
});

function buildDmDisplayHistory(
  history: AidmMessage[],
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
    encounterTypes: body.encounterTypes,
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
    customIntroduction: body.customIntroduction,
    customContext: body.customContext,
    startingZones: body.startingZones,
  });

  const savedMap = body.savedMapId
    ? (defs.maps.find((m) => m.id === body.savedMapId) ?? undefined)
    : undefined;

  const sessionId = randomUUID();
  const engine = GameEngine.createSession(
    sessionId,
    { ...body, encounterContext },
    defs,
    savedMap,
  );
  createSession(sessionId, engine);
  await ensureSaveExists(playerDef.id);

  return reply.send({ sessionId, state: engine.getState() });
});

server.post("/game/session/:id/action", async (req, reply) => {
  const { id } = req.params as { id: string };
  const engine = getEngine(id);
  if (!engine) return reply.code(404).send({ error: "Session not found" });

  const logLengthBefore = engine.getState().combatLog.length;
  const action = req.body as PlayerAction;
  const { events, state } = engine.processAction(action);

  const newCombatEntries = state.combatLog.slice(logLengthBefore);
  pushAdventureLines(
    id,
    newCombatEntries.map((e) => ({
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
    secondWindUses: player.secondWindUses,
    equippedSlots: player.equippedSlots,
  });

  pushStateUpdate(id, events, state);
  await saveWorldState(state, getAidmHistory(id) ?? []);
  return reply.send({ events, state });
});

server.post("/game/session/:id/aidm", async (req, reply) => {
  const { id } = req.params as { id: string };
  const engine = getEngine(id);
  if (!engine) return reply.code(404).send({ error: "Session not found" });

  const body = req.body as AIDMChatRequest;
  if (!body.playerMessage)
    return reply.code(400).send({ error: "Missing playerMessage" });

  const history = getAidmHistory(id);
  if (!history) return reply.code(404).send({ error: "Session not found" });

  // Per-session mutex — defends against concurrent AIDM requests on the same
  // session (double-clicks, dueling tabs) which would otherwise interleave
  // engine mutations and history writes.
  if (!tryAcquireAidmLock(id)) {
    return reply.code(429).send({ error: "An AIDM request is already in progress for this session." });
  }

  try {
    pushAdventureLines(id, [{ type: "dm_player", text: body.playerMessage }]);
    const logLengthBefore = engine.getState().combatLog.length;
    const archive = getAidmArchive(id);

    // E. Open the streaming AIDM channel on the WebSocket.
    push(id, { type: "aidm_start" });

    const {
      reply: aidmReply,
      events,
      rollResults,
    } = await processAIDMChat(engine, body, anthropic, history, archive, {
      onChunk: (text) => push(id, { type: "aidm_chunk", text }),
      onCheckpoint: () => push(id, { type: "aidm_checkpoint" }),
      onSpeculativeDiscard: () => push(id, { type: "aidm_speculative_discard" }),
    });
    const state = engine.getState();
    const newCombatEntries = state.combatLog.slice(logLengthBefore);
    pushAdventureLines(id, [
      ...newCombatEntries.map((e) => ({
        type: "combat" as const,
        text: e.right ? `${e.left}  [${e.right}]` : e.left,
      })),
      { type: "dm_reply" as const, text: aidmReply },
    ]);
    pushStateUpdate(id, events, state);
    push(id, { type: "aidm_done", reply: aidmReply, rollResults });
    await saveWorldState(state, history);
    return reply.send({ reply: aidmReply, rollResults });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("AIDM API error:", message);
    return reply.code(502).send({ error: message });
  } finally {
    releaseAidmLock(id);
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
      events: [],
      state: engine.getState(),
    } satisfies ServerWSMessage),
  );
});

// ── Start ──────────────────────────────────────────────────────────────────────

await loadDefs();
await server.listen({ port: 3000, host: "0.0.0.0" });
console.log("Server listening on http://localhost:3000");
