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

server.post('/save/:characterId', async (request, reply) => {
  const { characterId } = request.params as { characterId: string };
  await writeSave(characterId, request.body);
  return reply.code(200).send({ ok: true });
});

// --- Encounter types ---

type EncounterType = 'simple_combat' | 'social_interaction' | 'exploration';
type QuestGoalType = 'kill' | 'collect' | 'explore' | 'talk';

type SecretReward =
  | { type: 'gold'; amount: number }
  | { type: 'item'; itemId: string }
  | { type: 'lore'; text: string };
interface SecretDef { id: string; dc: number; reward: SecretReward; successText: string; failureText: string; }
interface Riddle { question: string; options: [string, string, string]; correctIndex: 0 | 1 | 2; }
interface QuestDef { id: string; title: string; goal: { type: QuestGoalType; target: number }; rewardXp: number; rewardGp: number; }

interface EncounterStartRequest {
  encounterTypes: EncounterType[];
  mapType: 'open' | 'rooms' | 'saved';
  playerDefId: string;
  playerName: string;
  playerSpeciesName: string;
  playerClassName: string;
  playerLevel: number;
  playerMaxHp: number;
  playerAc: number;
  savedMapName?: string;
  savedMapDescription?: string;
  npcId?: string;
}

// --- Data pools ---

const SECRET_POOL: SecretDef[] = [
  { id: 'loose_stone',    dc: 10, reward: { type: 'gold', amount: 12 }, successText: 'A loose stone conceals a small coin stash. (+12 GP)',              failureText: 'The stones look old and undisturbed.' },
  { id: 'hidden_vial',    dc: 12, reward: { type: 'item', itemId: 'health_potion' }, successText: 'Tucked in a crevice, you find a small healing vial.', failureText: 'The crevice holds only dust and cobwebs.' },
  { id: 'inscription',    dc: 15, reward: { type: 'lore', text: "An inscription reads: 'The strongest walls fall from within.'" }, successText: 'You make out a faint inscription on the surface.', failureText: 'The surface feels smooth and unremarkable.' },
  { id: 'coin_in_dust',   dc: 10, reward: { type: 'gold', amount: 5 },  successText: 'A single gold coin glints in the dust. (+5 GP)',                   failureText: 'The floor here is dusty and undisturbed.' },
  { id: 'worn_satchel',   dc: 12, reward: { type: 'gold', amount: 20 }, successText: 'Behind a fallen beam, a worn satchel holds coins. (+20 GP)',        failureText: 'Nothing catches your eye in this area.' },
  { id: 'scrap_parchment',dc: 12, reward: { type: 'lore', text: "A scrap of parchment reads: 'They came from the east and did not leave.'" }, successText: 'You find a scrap of parchment wedged in a crack.', failureText: 'A thorough search reveals only worn stone.' },
  { id: 'healing_cache',  dc: 15, reward: { type: 'item', itemId: 'health_potion' }, successText: 'A hidden niche in the wall holds a carefully wrapped vial.', failureText: 'The walls show signs of age but nothing stands out.' },
];

const RIDDLES: Riddle[] = [
  { question: "I speak without a mouth\nand hear without ears.\nWhat am I?",       options: ['A shadow', 'An echo', 'The wind'],     correctIndex: 1 },
  { question: "The more you take,\nthe more you leave behind.\nWhat am I?",        options: ['Time', 'Footsteps', 'Memories'],       correctIndex: 1 },
  { question: "I can fly without wings\nand cry without eyes.\nWhat am I?",        options: ['A cloud', 'A ghost', 'Smoke'],         correctIndex: 0 },
];

function pickRandom<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }
function shuffle<T>(arr: T[]): T[] { return [...arr].sort(() => Math.random() - 0.5); }

function pickSecrets(count: number): SecretDef[] { return shuffle(SECRET_POOL).slice(0, count); }

function buildQuests(types: EncounterType[], enemyCount: number): QuestDef[] {
  const quests: QuestDef[] = [];
  if (types.includes('simple_combat')) {
    quests.push({ id: 'first_blood',  title: 'First Blood',   goal: { type: 'kill',    target: 1 },          rewardXp: 10, rewardGp: 5  });
    quests.push({ id: 'treasure_hunt',title: 'Treasure Hunt', goal: { type: 'collect', target: 2 },          rewardXp: 10, rewardGp: 5  });
    if (enemyCount > 1)
      quests.push({ id: 'slay_all',   title: 'Slay All',      goal: { type: 'kill',    target: enemyCount }, rewardXp: 25, rewardGp: 15 });
  }
  if (types.includes('exploration'))
    quests.push({ id: 'keen_eye',   title: 'Keen Eye',    goal: { type: 'explore', target: 2 }, rewardXp: 15, rewardGp: 10 });
  if (types.includes('social_interaction'))
    quests.push({ id: 'make_contact', title: 'Make Contact', goal: { type: 'talk', target: 1 }, rewardXp: 10, rewardGp: 5 });
  return quests;
}

// --- Narrative templates ---

const TYPE_NARRATIVE: Record<EncounterType, string> = {
  simple_combat:      'Hostile figures have been spotted — combat is unavoidable.',
  social_interaction: 'A local NPC is nearby, cautious but willing to speak.',
  exploration:        'Something feels hidden here — secrets reward the observant.',
};
const TYPE_CONTEXT: Record<EncounterType, string> = {
  simple_combat:      'Combat against hostile creatures; the player must defeat all enemies.',
  social_interaction: 'An NPC available for conversation; AI dialogue with riddle fallback.',
  exploration:        'Four hidden secrets on the map, found via Wisdom (Perception) checks.',
};

function buildEncounter(req: EncounterStartRequest) {
  const mapDescription =
    req.mapType === 'saved' && req.savedMapDescription ? req.savedMapDescription
    : req.mapType === 'rooms' ? 'a labyrinth of stone corridors and shadowed chambers'
    : 'an open expanse of field and scrubland';
  const mapLabel =
    req.mapType === 'saved' && req.savedMapName ? req.savedMapName
    : req.mapType === 'rooms' ? 'dungeon' : 'open terrain';

  const isCombat = req.encounterTypes.includes('simple_combat');
  const charOpener = isCombat
    ? `${req.playerName} the ${req.playerClassName} enters ${mapDescription}, senses sharp and weapon ready.`
    : `${req.playerName} the ${req.playerClassName} steps into ${mapDescription}.`;

  const introduction = [charOpener, ...req.encounterTypes.map((t) => TYPE_NARRATIVE[t])].join(' ');
  const context = [
    `Player: ${req.playerName}, ${req.playerSpeciesName} ${req.playerClassName} (Level ${req.playerLevel}, ${req.playerMaxHp} HP, AC ${req.playerAc}).`,
    `Setting: ${mapLabel} — ${mapDescription}.`,
    `Active encounter objectives: ${req.encounterTypes.map((t) => TYPE_CONTEXT[t]).join(' ')}.`,
  ].join(' ');

  const enemyCount = req.encounterTypes.includes('simple_combat')
    ? 2 + Math.floor(Math.random() * 3)
    : 0;

  return {
    introduction,
    context,
    enemyCount,
    secrets:  req.encounterTypes.includes('exploration')                                                          ? pickSecrets(4)      : [],
    riddle:   req.encounterTypes.includes('social_interaction') ? pickRandom(RIDDLES) : null,
    quests:   buildQuests(req.encounterTypes, enemyCount),
    npcId:    req.npcId,
  };
}

server.post('/encounter/start', async (request, reply) => {
  const body = request.body as EncounterStartRequest;
  const encounterContext = buildEncounter(body);
  const existing = await readSave(body.playerDefId) as Record<string, unknown>;
  await writeSave(body.playerDefId, { ...existing, encounterContext });
  return reply.send(encounterContext);
});

await server.listen({ port: 3000, host: '0.0.0.0' });
console.log('Server listening on http://localhost:3000');
