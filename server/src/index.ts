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

// --- AIDM ---

interface AIDMEntityState {
  label?: string; id: string; name: string;
  hp?: number; maxHp?: number; ac?: number;
  tileX: number; tileY: number; alive?: boolean;
}
interface AIDMPlayerState {
  name: string; className: string; level: number;
  hp: number; maxHp: number; xp: number; gold: number;
  ac: number; tileX: number; tileY: number; inventory: string[];
}
interface AIDMSelectedTarget {
  type: 'enemy' | 'npc'; name: string; id: string; label?: string;
}
interface AIDMQuestState {
  id: string; title: string; progress: number; target: number; completed: boolean;
}
interface AIDMMapItem {
  name: string; tileX: number; tileY: number;
}
interface AIDMNpcConversation {
  npcId: string; npcName: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
}
interface AIDMGameState {
  player: AIDMPlayerState & {
    hidden: boolean; actionUsed: boolean; bonusActionUsed: boolean;
    movesLeft: number; secondWindUses: number;
  };
  enemies: (AIDMEntityState & { alive: boolean; isActive: boolean; vexed: boolean; hidden: boolean })[];
  npcs: AIDMEntityState[];
  selectedTarget?: AIDMSelectedTarget;
  quests: AIDMQuestState[];
  mapItems: AIDMMapItem[];
  secretsRemaining: number;
  npcConversations: AIDMNpcConversation[];
  combatLog: string[];
  encounterTypes: string[];
  mapName: string;
  combatPhase: string;
}
interface AIDMNpcPersona { id: string; name: string; persona: string; }
interface AIDMChatRequest {
  history: ChatMessage[];
  playerMessage: string;
  gameState: AIDMGameState;
  encounterContext: string;
  npcPersonas: AIDMNpcPersona[];
}
interface AIDMAction { type: string; [key: string]: unknown; }

const AIDM_TOOLS = [
  {
    name: 'adjust_player_hp',
    description: 'Adjust the player\'s HP. Positive delta heals, negative damages. Clamped to [0, maxHp].',
    input_schema: { type: 'object' as const, properties: { delta: { type: 'integer' }, reason: { type: 'string' } }, required: ['delta', 'reason'] },
  },
  {
    name: 'award_xp',
    description: 'Award experience points to the player for clever roleplay, exploration, or creative solutions.',
    input_schema: { type: 'object' as const, properties: { amount: { type: 'integer' }, reason: { type: 'string' } }, required: ['amount', 'reason'] },
  },
  {
    name: 'award_gold',
    description: 'Award gold pieces to the player.',
    input_schema: { type: 'object' as const, properties: { amount: { type: 'integer' }, reason: { type: 'string' } }, required: ['amount', 'reason'] },
  },
  {
    name: 'set_enemy_hp',
    description: 'Set an enemy\'s current HP by label (A, B, C…). Set to 0 to kill the enemy.',
    input_schema: { type: 'object' as const, properties: { enemy_label: { type: 'string' }, hp: { type: 'integer' }, reason: { type: 'string' } }, required: ['enemy_label', 'hp', 'reason'] },
  },
  {
    name: 'add_log_entry',
    description: 'Add a narrative entry to the combat log without changing game state.',
    input_schema: { type: 'object' as const, properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'move_entity',
    description: 'Teleport an entity to a tile. Entity: "player", "enemy_A" (by label), or "npc_[id]" (e.g. "npc_tavern_keeper").',
    input_schema: { type: 'object' as const, properties: { entity: { type: 'string' }, tile_x: { type: 'integer' }, tile_y: { type: 'integer' }, reason: { type: 'string' } }, required: ['entity', 'tile_x', 'tile_y', 'reason'] },
  },
  {
    name: 'add_item',
    description: 'Give the player an item. Valid item_id values: "health_potion".',
    input_schema: { type: 'object' as const, properties: { item_id: { type: 'string' }, reason: { type: 'string' } }, required: ['item_id', 'reason'] },
  },
  {
    name: 'end_combat',
    description: 'End combat immediately — enemies flee, surrender, or are otherwise removed. Returns the encounter to the exploring phase.',
    input_schema: { type: 'object' as const, properties: { reason: { type: 'string' } }, required: ['reason'] },
  },
  {
    name: 'trigger_combat',
    description: 'Start combat if the encounter is currently in the exploring phase and enemies are present.',
    input_schema: { type: 'object' as const, properties: { reason: { type: 'string' } }, required: ['reason'] },
  },
  {
    name: 'complete_quest',
    description: 'Force-complete a quest and award its rewards. Use quest id from the quest list.',
    input_schema: { type: 'object' as const, properties: { quest_id: { type: 'string' }, reason: { type: 'string' } }, required: ['quest_id', 'reason'] },
  },
  {
    name: 'set_player_hidden',
    description: 'Set the player\'s hidden (stealth) status.',
    input_schema: { type: 'object' as const, properties: { hidden: { type: 'boolean' }, reason: { type: 'string' } }, required: ['hidden', 'reason'] },
  },
];

function buildAIDMSystemPrompt(req: AIDMChatRequest): string {
  const { gameState: gs, npcPersonas, encounterContext } = req;
  const p = gs.player;

  // Player block
  const combatStateFlags = [
    p.hidden ? 'HIDDEN' : '',
    p.actionUsed ? 'action used' : '',
    p.bonusActionUsed ? 'bonus used' : '',
    gs.combatPhase === 'player_turn' ? `${p.movesLeft} moves left` : '',
    p.secondWindUses > 0 ? `Second Wind ×${p.secondWindUses}` : '',
  ].filter(Boolean).join(' · ');

  const focusLine = gs.selectedTarget
    ? gs.selectedTarget.type === 'enemy'
      ? `Focused on: ${gs.selectedTarget.name}${gs.selectedTarget.label ? ` [${gs.selectedTarget.label}]` : ''} (enemy)`
      : `Focused on: ${gs.selectedTarget.name} (NPC)`
    : 'Focused on: nothing';

  // Enemies block
  const enemyLines = gs.enemies.length > 0
    ? gs.enemies.map((e) => {
        const flags = [
          !e.alive ? 'DEAD' : '',
          e.isActive ? 'ACTIVE TURN' : '',
          e.vexed ? 'VEXED' : '',
          e.hidden ? 'HIDDEN' : '',
        ].filter(Boolean).join(', ');
        return `  ${e.label ? `[${e.label}] ` : ''}${e.name}: ${e.hp}/${e.maxHp} HP, AC ${e.ac}, tile (${e.tileX},${e.tileY})${flags ? ` [${flags}]` : ''}`;
      }).join('\n')
    : '  None';

  // NPCs block
  const npcLines = gs.npcs.length > 0
    ? gs.npcs.map((n) => `  ${n.name} [id: ${n.id}] at tile (${n.tileX},${n.tileY})`).join('\n')
    : '  None';

  // Quests block
  const questLines = gs.quests.length > 0
    ? gs.quests.map((q) =>
        `  ${q.completed ? '✓' : '·'} ${q.title} [id: ${q.id}] — ${q.completed ? 'complete' : `${q.progress}/${q.target}`}`
      ).join('\n')
    : '  None';

  // Map items block
  const itemLines = gs.mapItems.length > 0
    ? gs.mapItems.map((i) => `  ${i.name} at tile (${i.tileX},${i.tileY})`).join('\n')
    : '  None on the ground';

  // NPC conversations
  const conversationLines = gs.npcConversations.length > 0
    ? gs.npcConversations.map((c) => {
        const lines = c.messages.map((m) =>
          m.role === 'user' ? `  Player: ${m.content}` : `  ${c.npcName}: ${m.content}`
        ).join('\n');
        return `  [${c.npcName}]\n${lines}`;
      }).join('\n\n')
    : '  None yet.';

  // NPC personas
  const personaLines = npcPersonas.length > 0
    ? npcPersonas.map((n) => `  ${n.name}: ${n.persona}`).join('\n\n')
    : '  None';

  const recentLog = gs.combatLog.slice(-15).join('\n  ') || 'No entries yet.';

  return `You are the AI Dungeon Master (DM) for a D&D 5e encounter. The game engine feeds you complete, real-time state — positions, HP, inventory, quests, items, who the player is focused on. Never claim ignorance of any of this data.

SETTING: ${gs.mapName} | PHASE: ${gs.combatPhase} | ENCOUNTER: ${gs.encounterTypes.join(', ')}
CONTEXT: ${encounterContext}

PLAYER: ${p.name}, Level ${p.level} ${p.className}
  HP ${p.hp}/${p.maxHp} · AC ${p.ac} · XP ${p.xp} · ${p.gold} GP · tile (${p.tileX},${p.tileY})
  Inventory: ${p.inventory.join(', ') || 'empty'}
  ${combatStateFlags ? combatStateFlags + '\n  ' : ''}${focusLine}

ENEMIES:
${enemyLines}

NPCs:
${npcLines}

NPC CONVERSATIONS SO FAR:
${conversationLines}

QUESTS:
${questLines}

ITEMS ON THE GROUND:
${itemLines}
  Secrets remaining: ${gs.secretsRemaining}

NPC PERSONAS:
${personaLines}

RECENT COMBAT LOG:
  ${recentLog}

INSTRUCTIONS:
Respond in 1-3 concise sentences. Use tools freely to make game effects real — adjust HP for traps or environmental effects, award XP/GP for clever solutions, set enemy HP to reflect narrative wounds, move entities to create drama, give items as rewards, start or end combat as the story demands, complete quests when the player earns it, toggle stealth. When the player says "them", "it", "him", "her", or "that one", resolve it to whoever they are currently focused on. When addressing an NPC, speak in that NPC's voice, limited to what they would plausibly know. Never break immersion or disclaim game-state knowledge.`;
}

server.post('/aidm/chat', async (request, reply) => {
  const body = request.body as AIDMChatRequest;
  if (!body.playerMessage || !body.gameState) return reply.code(400).send({ error: 'Invalid request' });

  const system = buildAIDMSystemPrompt(body);
  const messages: { role: 'user' | 'assistant'; content: unknown }[] = [
    ...body.history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: body.playerMessage },
  ];

  const actions: AIDMAction[] = [];
  let narrativeText = '';

  try {
    let response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      system,
      tools: AIDM_TOOLS,
      messages: messages as Parameters<typeof anthropic.messages.create>[0]['messages'],
    });

    while (response.stop_reason === 'tool_use') {
      for (const block of response.content) {
        if (block.type === 'text') narrativeText += block.text;
      }
      const toolResults: { type: 'tool_result'; tool_use_id: string; content: string }[] = [];
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          actions.push({ type: block.name, ...(block.input as Record<string, unknown>) });
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Applied.' });
        }
      }
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
      response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        system,
        tools: AIDM_TOOLS,
        messages: messages as Parameters<typeof anthropic.messages.create>[0]['messages'],
      });
    }

    for (const block of response.content) {
      if (block.type === 'text') narrativeText += block.text;
    }

    return { reply: narrativeText.trim(), actions };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('AIDM API error:', message);
    return reply.code(502).send({ error: message });
  }
});

await server.listen({ port: 3000, host: '0.0.0.0' });
console.log('Server listening on http://localhost:3000');
