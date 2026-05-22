import { config as loadEnv } from 'dotenv';
import { resolve } from 'path';
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env') });
import Fastify from 'fastify';
import cors from '@fastify/cors';
import Anthropic from '@anthropic-ai/sdk';
import { readFile, readdir, writeFile, mkdir, unlink } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { buildEncounter } from './encounterService.js';
import type { EncounterStartRequest } from './encounterService.js';
import { processAIDMChat } from './aidm.js';
import type { AIDMChatRequest } from './aidm.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../data');
const SAVES_DIR = join(DATA_DIR, 'saves');

function saveFilePath(characterId: string): string {
  return join(SAVES_DIR, `${characterId}.json`);
}

async function readDir(dir: string): Promise<unknown[]> {
  const files = await readdir(dir);
  return Promise.all(
    files
      .filter((f) => f.endsWith('.json'))
      .map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf-8'))),
  );
}

async function defaultSave(characterId: string): Promise<unknown> {
  const chars = await readDir(join(DATA_DIR, 'characters')) as Record<string, unknown>[];
  const char = chars.find((c) => c['id'] === characterId) ?? chars[0];
  return {
    playerDefId: char?.['id'] ?? characterId,
    hp: char?.['maxHp'] ?? 1,
    xp: 0,
    gold: 0,
    inventoryIds: [],
    secondWindUses: char?.['secondWindMaxUses'] ?? 0,
  };
}

async function readSave(characterId: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(saveFilePath(characterId), 'utf-8'));
  } catch {
    return defaultSave(characterId);
  }
}

async function writeSave(characterId: string, data: unknown): Promise<void> {
  await mkdir(SAVES_DIR, { recursive: true });
  await writeFile(saveFilePath(characterId), JSON.stringify(data, null, 2));
}

const server = Fastify({ logger: false });

await server.register(cors, { origin: 'http://localhost:5173' });

server.get('/characters',         async () => readDir(join(DATA_DIR, 'characters')));
server.get('/monsters',           async () => readDir(join(DATA_DIR, 'monsters')));
server.get('/npcs',               async () => readDir(join(DATA_DIR, 'npcs')));
server.get('/items',              async () => readDir(join(DATA_DIR, 'items')));
server.get('/premade-encounters', async () => readDir(join(DATA_DIR, 'premade-encounters')));
server.get('/maps', async () => {
  interface RawMap { id: string; name: string; description: string; rows: string[]; }
  const raw = await readDir(join(DATA_DIR, 'maps')) as RawMap[];
  return raw.map(({ id, name, description, rows }) => ({
    id, name, description,
    cols: rows[0]?.length ?? 0,
    rows: rows.length,
    passable: rows.map((r) => [...r].map((c) => c === '.')),
  }));
});

server.get('/save/:characterId', async (request) => {
  const { characterId } = request.params as { characterId: string };
  return readSave(characterId);
});

server.post('/save/:characterId', async (request, reply) => {
  const { characterId } = request.params as { characterId: string };
  await writeSave(characterId, request.body);
  return reply.code(200).send({ ok: true });
});

server.delete('/save/:characterId', async (request, reply) => {
  const { characterId } = request.params as { characterId: string };
  try { await unlink(saveFilePath(characterId)); } catch { /* already gone */ }
  return reply.code(200).send({ ok: true });
});

server.post('/encounter/start', async (request, reply) => {
  const body = request.body as EncounterStartRequest;
  const encounterContext = buildEncounter(body);
  const existing = await readSave(body.playerDefId) as Record<string, unknown>;
  await writeSave(body.playerDefId, { ...existing, encounterContext });
  return reply.send(encounterContext);
});

server.post('/aidm/chat', async (request, reply) => {
  const body = request.body as AIDMChatRequest;
  if (!body.playerMessage || !body.gameState) return reply.code(400).send({ error: 'Invalid request' });
  try {
    return await processAIDMChat(body, anthropic);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('AIDM API error:', message);
    return reply.code(502).send({ error: message });
  }
});

await server.listen({ port: 3000, host: '0.0.0.0' });
console.log('Server listening on http://localhost:3000');
