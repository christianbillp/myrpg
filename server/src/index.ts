import { config as loadEnv } from 'dotenv';
import { resolve } from 'path';
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env') });
import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Anthropic from '@anthropic-ai/sdk';
import { readFile, readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { buildEncounter, EncounterStartRequest } from './encounterService.js';
import { processAIDMChat, AIDMChatRequest } from './aidm.js';
import { GameEngine, GameDefs } from './engine/GameEngine.js';
import { CreateSessionRequest } from './engine/types.js';
import { createSession, getEngine, registerWebSocket, pushStateUpdate, deleteSession } from './sessions.js';
import type { PlayerAction, ServerWSMessage, GameState, PlayerState, EquipmentSlots } from './engine/types.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../data');

async function readDir<T>(dir: string): Promise<T[]> {
  const files = await readdir(dir);
  return Promise.all(
    files.filter((f) => f.endsWith('.json')).map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf-8')) as T),
  );
}

// ── Load all data at startup ───────────────────────────────────────────────────

const defs: GameDefs = {
  playerDefs: [],
  monsters: [],
  npcs: [],
  items: [],
  maps: [],
};

async function loadDefs(): Promise<void> {
  const [playerDefs, monsters, npcs, items, rawMaps] = await Promise.all([
    readDir<GameDefs['playerDefs'][0]>(join(DATA_DIR, 'characters')),
    readDir<GameDefs['monsters'][0]>(join(DATA_DIR, 'monsters')),
    readDir<GameDefs['npcs'][0]>(join(DATA_DIR, 'npcs')),
    readDir<GameDefs['items'][0]>(join(DATA_DIR, 'items')),
    readDir<{ id: string; name: string; description: string; rows: string[] }>(join(DATA_DIR, 'maps')),
  ]);
  defs.playerDefs = playerDefs;
  defs.monsters = monsters;
  defs.npcs = npcs;
  defs.items = items;
  defs.maps = rawMaps.map(({ id, name, description, rows }) => ({
    id, name, description,
    cols: rows[0]?.length ?? 0,
    rows: rows.length,
    passable: rows.map((r) => [...r].map((c) => c === '.')),
  }));
}

// ── Server setup ───────────────────────────────────────────────────────────────

const server = Fastify({ logger: false });
await server.register(cors, { origin: 'http://localhost:5173' });
await server.register(websocket);

// ── Static data routes (unchanged) ────────────────────────────────────────────

server.get('/characters',         async () => defs.playerDefs);
server.get('/monsters',           async () => defs.monsters);
server.get('/npcs',               async () => defs.npcs);
server.get('/items',              async () => defs.items);
server.get('/premade-encounters', async () => readDir(join(DATA_DIR, 'premade-encounters')));
server.get('/maps',               async () => defs.maps);

// ── Save routes (unchanged) ────────────────────────────────────────────────────

const SAVES_DIR = join(DATA_DIR, 'saves');
const WORLD_SAVE_PATH = join(SAVES_DIR, 'world.json');
import { writeFile, mkdir, unlink } from 'fs/promises';

function saveFilePath(characterId: string): string { return join(SAVES_DIR, `${characterId}.json`); }

// Persistent player stats live in the character save; the world save only keeps
// session-specific player fields (position, turn flags, death saves).
type SessionPlayerState = Pick<PlayerState, 'defId' | 'tileX' | 'tileY' | 'hidden' | 'actionUsed' | 'bonusActionUsed' | 'movesLeft' | 'deathSaveSuccesses' | 'deathSaveFailures'>;
type WorldSave = Omit<GameState, 'player'> & { player: SessionPlayerState };

interface CharSave {
  playerDefId: string;
  hp: number; xp: number; gold: number;
  inventoryIds: string[];
  secondWindUses: number;
  equippedSlots?: EquipmentSlots;
}

async function saveWorldState(state: GameState): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { hp: _hp, xp: _xp, gold: _gold, inventoryIds: _inv, equippedSlots: _eq, secondWindUses: _sw, ...sessionPlayer } = state.player;
  const worldSave: WorldSave = { ...state, player: sessionPlayer };
  await mkdir(SAVES_DIR, { recursive: true });
  await writeFile(WORLD_SAVE_PATH, JSON.stringify(worldSave));
}

async function loadWorldState(): Promise<GameState | null> {
  let worldSave: WorldSave;
  try { worldSave = JSON.parse(await readFile(WORLD_SAVE_PATH, 'utf-8')) as WorldSave; } catch { return null; }

  const charSave = await readSave(worldSave.player.defId) as CharSave;
  const fullPlayer: PlayerState = {
    ...worldSave.player,
    hp: charSave.hp,
    xp: charSave.xp,
    gold: charSave.gold,
    inventoryIds: charSave.inventoryIds ?? [],
    equippedSlots: charSave.equippedSlots ?? { armorId: null, weaponId: null, shieldId: null },
    secondWindUses: charSave.secondWindUses,
  };
  return { ...worldSave, player: fullPlayer };
}

async function deleteWorldSave(): Promise<void> {
  try { await unlink(WORLD_SAVE_PATH); } catch { /* already gone */ }
}

async function readSave(characterId: string): Promise<unknown> {
  try { return JSON.parse(await readFile(saveFilePath(characterId), 'utf-8')); } catch { return defaultSave(characterId); }
}

async function defaultSave(characterId: string): Promise<unknown> {
  const char = defs.playerDefs.find((c) => c.id === characterId) ?? defs.playerDefs[0];
  return { playerDefId: char?.id ?? characterId, hp: char?.maxHp ?? 1, xp: 0, gold: 0, inventoryIds: [], secondWindUses: char?.secondWindMaxUses ?? 0 };
}

async function writeSave(characterId: string, data: unknown): Promise<void> {
  await mkdir(SAVES_DIR, { recursive: true });
  await writeFile(saveFilePath(characterId), JSON.stringify(data, null, 2));
}

server.get('/save/:characterId',    async (req) => readSave((req.params as { characterId: string }).characterId));
server.post('/save/:characterId',   async (req, reply) => { await writeSave((req.params as { characterId: string }).characterId, req.body); return reply.code(200).send({ ok: true }); });
server.delete('/save/:characterId', async (req, reply) => { try { await unlink(saveFilePath((req.params as { characterId: string }).characterId)); } catch { /* gone */ } return reply.code(200).send({ ok: true }); });

// ── World save (resume) ────────────────────────────────────────────────────────

server.get('/world', async (_req, reply) => {
  const state = await loadWorldState();
  if (!state) return reply.code(404).send({ error: 'No world save' });

  // Re-use the existing engine if the session is still alive (e.g. hot-reload),
  // otherwise restore from the saved GameState.
  let engine = getEngine(state.sessionId);
  if (!engine) {
    engine = new GameEngine(state, defs);
    createSession(state.sessionId, engine);
  }
  return reply.send({ sessionId: state.sessionId, state: engine.getState() });
});

// ── Legacy encounter start (kept for backwards compat) ─────────────────────────

server.post('/encounter/start', async (req, reply) => {
  const body = req.body as EncounterStartRequest;
  return reply.send(buildEncounter(body));
});

// ── Game session routes ────────────────────────────────────────────────────────

server.post('/game/session', async (req, reply) => {
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
  if (!playerDef) return reply.code(400).send({ error: 'Unknown playerDefId' });

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
  });

  const savedMap = body.savedMapId
    ? defs.maps.find((m) => m.id === body.savedMapId) ?? undefined
    : undefined;

  const sessionId = randomUUID();
  const engine = GameEngine.createSession(sessionId, { ...body, encounterContext }, defs, savedMap);
  createSession(sessionId, engine);

  return reply.send({ sessionId, state: engine.getState() });
});

server.post('/game/session/:id/action', async (req, reply) => {
  const { id } = req.params as { id: string };
  const engine = getEngine(id);
  if (!engine) return reply.code(404).send({ error: 'Session not found' });

  const action = req.body as PlayerAction;
  const { events, state } = engine.processAction(action);

  // Auto-save after each action so state is never lost
  const player = state.player;
  await writeSave(player.defId, {
    playerDefId: player.defId,
    hp: player.hp,
    xp: player.xp,
    gold: player.gold,
    inventoryIds: player.inventoryIds,
    secondWindUses: player.secondWindUses,
    equippedSlots: player.equippedSlots,
  });

  pushStateUpdate(id, events, state);
  await saveWorldState(state);
  return reply.send({ events, state });
});

server.post('/game/session/:id/aidm', async (req, reply) => {
  const { id } = req.params as { id: string };
  const engine = getEngine(id);
  if (!engine) return reply.code(404).send({ error: 'Session not found' });

  const body = req.body as AIDMChatRequest;
  if (!body.playerMessage) return reply.code(400).send({ error: 'Missing playerMessage' });

  try {
    const { reply: aidmReply, events } = await processAIDMChat(id, engine, body, anthropic);
    const state = engine.getState();
    pushStateUpdate(id, events, state);
    await saveWorldState(state);
    return reply.send({ reply: aidmReply });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('AIDM API error:', message);
    return reply.code(502).send({ error: message });
  }
});

server.delete('/game/session/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  deleteSession(id);
  await deleteWorldSave();
  return reply.code(200).send({ ok: true });
});

// ── WebSocket endpoint ─────────────────────────────────────────────────────────

server.get('/game/session/:id/ws', { websocket: true }, (socket, req) => {
  const { id } = req.params as { id: string };
  const engine = getEngine(id);
  if (!engine) {
    socket.send(JSON.stringify({ type: 'error', message: 'Session not found' } satisfies ServerWSMessage));
    socket.close();
    return;
  }
  registerWebSocket(id, socket);
  socket.send(JSON.stringify({ type: 'state_update', events: [], state: engine.getState() } satisfies ServerWSMessage));
});

// ── Start ──────────────────────────────────────────────────────────────────────

await loadDefs();
await server.listen({ port: 3000, host: '0.0.0.0' });
console.log('Server listening on http://localhost:3000');
