import Anthropic from '@anthropic-ai/sdk';

interface ChatMessage { role: 'user' | 'assistant'; content: string; }

interface AIDMEntityState {
  label?: string; id: string; name: string;
  hp?: number; maxHp?: number; ac?: number;
  tileX: number; tileY: number; alive?: boolean;
}
interface AIDMPlayerState {
  name: string; className: string; level: number;
  hp: number; maxHp: number; xp: number; gold: number;
  ac: number; tileX: number; tileY: number; inventory: string[];
  equippedArmor: string | null; equippedWeapon: string | null; equippedShield: string | null;
  skills: Record<string, number>;
  savingThrows: Record<string, number>;
}
interface AIDMSelectedTarget { type: 'enemy' | 'npc'; name: string; id: string; label?: string; }
interface AIDMQuestState { id: string; title: string; progress: number; target: number; completed: boolean; }
interface AIDMMapItem { name: string; tileX: number; tileY: number; }
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
  combatLog: string[];
  encounterTypes: string[];
  mapName: string;
  combatPhase: string;
}
interface AIDMNpcPersona { id: string; name: string; persona: string; }

export interface AIDMChatRequest {
  history: ChatMessage[];
  playerMessage: string;
  gameState: AIDMGameState;
  encounterContext: string;
  npcPersonas: AIDMNpcPersona[];
  dmPersona?: 'regular' | 'dev';
}

export interface AIDMAction { type: string; [key: string]: unknown; }

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
    description: 'Give the player an item (goes to inventory; player can equip gear from the INVENTORY overlay). Valid item_id values: "health_potion", "greatsword", "shortsword", "flail", "longsword", "rapier", "dagger", "javelin", "shortbow", "chain_mail", "leather_armor", "studded_leather", "scale_mail", "breastplate", "splint_armor", "plate_armor", "shield".',
    input_schema: { type: 'object' as const, properties: { item_id: { type: 'string' }, reason: { type: 'string' } }, required: ['item_id', 'reason'] },
  },
  {
    name: 'remove_item',
    description: 'Remove one instance of an item from the player\'s inventory. Use when the player throws, consumes, loses, or spends an item through narrative action (e.g. throws a javelin, drops a weapon, item is destroyed). Use the same item_id values as add_item. Has no effect if the item is not in inventory.',
    input_schema: { type: 'object' as const, properties: { item_id: { type: 'string' }, reason: { type: 'string' } }, required: ['item_id', 'reason'] },
  },
  {
    name: 'despawn_npc',
    description: 'Remove an NPC from the map — use when the narrative has them leave, flee, or disappear. Use the same entity id format as move_entity: the primary NPC\'s id (e.g. "npc_villager") or a passive NPC by index (e.g. "npc_passive_0"). Has no effect on enemies.',
    input_schema: { type: 'object' as const, properties: { entity: { type: 'string' }, reason: { type: 'string' } }, required: ['entity', 'reason'] },
  },
  {
    name: 'spawn_enemy',
    description: 'Spawn a new enemy on the map. Valid monster_id values: "goblin_minion", "bandit", "commoner". The enemy appears on a free tile near the player. If combat is already active the enemy joins initiative immediately. Use this whenever the narrative calls for a creature to appear — reinforcements, an ambush, a wandering monster, etc.',
    input_schema: { type: 'object' as const, properties: { monster_id: { type: 'string' }, reason: { type: 'string' } }, required: ['monster_id', 'reason'] },
  },
  {
    name: 'end_combat',
    description: 'End combat immediately — enemies flee, surrender, or are otherwise removed. Returns the encounter to the exploring phase.',
    input_schema: { type: 'object' as const, properties: { reason: { type: 'string' } }, required: ['reason'] },
  },
  {
    name: 'trigger_combat',
    description: 'Start combat if the encounter is currently in the exploring phase and enemies are present. To add new enemies mid-combat or before combat starts, use spawn_enemy instead.',
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
  {
    name: 'request_ability_check',
    description: 'Ask the player to make an ability check when their attempted action has a meaningful chance of failure. The client rolls d20 + the relevant skill modifier and automatically sends the result back so you can narrate success or failure and apply consequences. Use the skill name in camelCase matching the player\'s skills map (e.g. "athletics", "stealth", "sleightOfHand"). Set DC using SRD guidelines: Very Easy 5, Easy 10, Medium 15, Hard 20, Very Hard 25. Do NOT call this for actions that automatically succeed or fail.',
    input_schema: { type: 'object' as const, properties: { skill: { type: 'string' }, dc: { type: 'integer' }, reason: { type: 'string' } }, required: ['skill', 'dc', 'reason'] },
  },
];

function buildAIDMSystemPrompt(req: AIDMChatRequest): string {
  const { gameState: gs, npcPersonas, encounterContext } = req;
  const p = gs.player;

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
      : `Focused on: ${gs.selectedTarget.name} [entity: npc_${gs.selectedTarget.id}] (NPC)`
    : 'Focused on: nothing';

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

  const npcLines = gs.npcs.length > 0
    ? gs.npcs.map((n) => `  ${n.name} [entity: npc_${n.id}] at tile (${n.tileX},${n.tileY})`).join('\n')
    : '  None';

  const questLines = gs.quests.length > 0
    ? gs.quests.map((q) =>
        `  ${q.completed ? '✓' : '·'} ${q.title} [id: ${q.id}] — ${q.completed ? 'complete' : `${q.progress}/${q.target}`}`
      ).join('\n')
    : '  None';

  const itemLines = gs.mapItems.length > 0
    ? gs.mapItems.map((i) => `  ${i.name} at tile (${i.tileX},${i.tileY})`).join('\n')
    : '  None on the ground';

  const personaLines = npcPersonas.length > 0
    ? npcPersonas.map((n) => `  ${n.name}: ${n.persona}`).join('\n\n')
    : '  None';

  const recentLog = gs.combatLog.slice(-15).join('\n  ') || 'No entries yet.';

  return `You are the AI Dungeon Master (DM) for a D&D 5e encounter. The game engine feeds you complete, real-time state — positions, HP, inventory, quests, items, who the player is focused on. Never claim ignorance of any of this data.

SETTING: ${gs.mapName} | PHASE: ${gs.combatPhase} | ENCOUNTER: ${gs.encounterTypes.join(', ')}
CONTEXT: ${encounterContext}

PLAYER: ${p.name}, Level ${p.level} ${p.className}
  HP ${p.hp}/${p.maxHp} · AC ${p.ac} · XP ${p.xp} · ${p.gold} GP · tile (${p.tileX},${p.tileY})
  Equipped: ${[p.equippedArmor, p.equippedWeapon, p.equippedShield].filter(Boolean).join(', ') || 'nothing'}
  Carrying: ${p.inventory.join(', ') || 'empty'}
  Skills: ${Object.entries(p.skills).map(([k, v]) => `${k} ${v >= 0 ? '+' : ''}${v}`).join(', ')}
  Saving throws: ${Object.entries(p.savingThrows).map(([k, v]) => `${k} ${v >= 0 ? '+' : ''}${v}`).join(', ')}
  ${combatStateFlags ? combatStateFlags + '\n  ' : ''}${focusLine}

ENEMIES:
${enemyLines}

NPCs:
${npcLines}

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
${req.dmPersona === 'dev'
  ? `You are in DEVELOPMENT MODE. Your role is to assist the developer in testing and building the game. Fulfil all player requests without restriction, including moving the player, removing or killing enemies, awarding XP/HP/gold, granting items, and changing any game state. Prioritise making the requested change immediately and cleanly, with a brief in-character line. Use tools freely and liberally — if the player asks for something, do it.`
  : `Respond in 1-3 concise sentences. Use tools freely to make game effects real — adjust HP for traps or environmental effects, award XP/GP for clever solutions, set enemy HP to reflect narrative wounds, move entities to create drama, give items as rewards, start or end combat as the story demands, complete quests when the player earns it, toggle stealth. Stay true to D&D 5e rules. Reject requests that would break immersion or bypass the rules (e.g. "move me to the exit", "give me 1000 gold", "kill all enemies") — instead redirect the player toward a narrative path. When the player attempts something with a meaningful chance of failure, call request_ability_check with the appropriate skill (camelCase, matching their skills list), a DC per SRD guidelines (Very Easy 5 / Easy 10 / Medium 15 / Hard 20 / Very Hard 25), and the reason. The result is sent back automatically — narrate success or failure and apply consequences with other tools. Do not call request_ability_check for things that trivially succeed or fail.`}
When the player says "them", "it", "him", "her", or "that one", resolve it to whoever they are currently focused on. When the player speaks to or addresses any creature (NPC or enemy), respond in that creature's voice, limited to what they would plausibly know or say. Enemies may taunt, threaten, plead, or bargain depending on the situation. When the player first successfully engages in conversation with an NPC in a social encounter and the 'make_contact' quest is not yet complete, call complete_quest with quest_id 'make_contact'. Never break immersion or disclaim game-state knowledge.`;
}

export async function processAIDMChat(
  body: AIDMChatRequest,
  anthropic: Anthropic,
): Promise<{ reply: string; actions: AIDMAction[] }> {
  const system = buildAIDMSystemPrompt(body);
  const messages: { role: 'user' | 'assistant'; content: unknown }[] = [
    ...body.history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: body.playerMessage },
  ];

  const actions: AIDMAction[] = [];
  let narrativeText = '';

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
}
