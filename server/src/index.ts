import { config as loadEnv } from 'dotenv';
import { resolve } from 'path';
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env') });
import Fastify from 'fastify';
import cors from '@fastify/cors';
import Anthropic from '@anthropic-ai/sdk';
import { readFile, readdir, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../data');
const SAVE_FILE = join(DATA_DIR, 'character.json');

async function readDir(dir: string): Promise<unknown[]> {
  const files = await readdir(dir);
  return Promise.all(
    files
      .filter((f) => f.endsWith('.json'))
      .map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf-8'))),
  );
}

async function defaultSave(): Promise<unknown> {
  const chars = await readDir(join(DATA_DIR, 'characters'));
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

server.get('/characters', async () => readDir(join(DATA_DIR, 'characters')));
server.get('/monsters',   async () => readDir(join(DATA_DIR, 'monsters')));
server.get('/npcs',       async () => readDir(join(DATA_DIR, 'npcs')));
server.get('/items',      async () => readDir(join(DATA_DIR, 'items')));
server.get('/maps',       async () => readDir(join(DATA_DIR, 'maps')));

server.get('/save', async () => readSave());

interface ChatMessage { role: 'user' | 'assistant'; content: string; }
interface PlayerState { name: string; className: string; level: number; hp: number; maxHp: number; xp: number; gold: number; }
interface ChatRequest { npcId: string; history: ChatMessage[]; playerMessage: string; playerState: PlayerState; }

server.post('/npc/chat', async (request, reply) => {
  const body = request.body as ChatRequest;
  const npcs = await readDir(join(DATA_DIR, 'npcs')) as Record<string, unknown>[];
  const npc = npcs.find((n) => n['id'] === body.npcId);
  if (!npc || !npc['persona']) return reply.code(404).send({ error: 'NPC not found or has no persona' });

  const { name, className, level, hp, maxHp, xp, gold } = body.playerState;
  const system = `${npc['persona']}

The adventurer you are speaking with is ${name}, a level ${level} ${className}. They have ${hp}/${maxHp} HP, ${xp} XP, and ${gold} GP.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      system,
      messages: [...body.history, { role: 'user', content: body.playerMessage }],
    });
    const reply_text = response.content[0].type === 'text' ? response.content[0].text : '';
    return { reply: reply_text };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Anthropic API error:', message);
    return reply.code(502).send({ error: message });
  }
});

server.post('/save', async (request, reply) => {
  await writeSave(request.body);
  return reply.code(200).send({ ok: true });
});

await server.listen({ port: 3000, host: '0.0.0.0' });
console.log('Server listening on http://localhost:3000');
