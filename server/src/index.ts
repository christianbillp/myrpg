import Fastify from 'fastify';
import cors from '@fastify/cors';
import { readFile, readdir, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../data');
const CHARACTERS_DIR = join(DATA_DIR, 'characters');
const SAVE_FILE = join(DATA_DIR, 'character.json');

async function readCharacters(): Promise<unknown[]> {
  const files = await readdir(CHARACTERS_DIR);
  return Promise.all(
    files
      .filter((f) => f.endsWith('.json'))
      .map(async (f) => JSON.parse(await readFile(join(CHARACTERS_DIR, f), 'utf-8'))),
  );
}

async function defaultSave(): Promise<unknown> {
  const chars = await readCharacters();
  const first = chars[0] as Record<string, unknown>;
  return {
    playerDefId: first['id'],
    hp: first['maxHp'],
    xp: 0,
    gold: 0,
    inventoryIds: [],
    secondWindUses: first['secondWindMaxUses'],
  };
}

async function readSave(): Promise<unknown> {
  try {
    return JSON.parse(await readFile(SAVE_FILE, 'utf-8'));
  } catch {
    return defaultSave();
  }
}

async function writeSave(data: unknown): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(SAVE_FILE, JSON.stringify(data, null, 2));
}

const server = Fastify({ logger: false });

await server.register(cors, { origin: 'http://localhost:5173' });

server.get('/characters', async () => readCharacters());

server.get('/save', async () => readSave());

server.post('/save', async (request, reply) => {
  await writeSave(request.body);
  return reply.code(200).send({ ok: true });
});

await server.listen({ port: 3000, host: '0.0.0.0' });
console.log('Server listening on http://localhost:3000');
