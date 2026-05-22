import Anthropic from '@anthropic-ai/sdk';
import { GameEngine } from './engine/GameEngine.js';
import { GameEvent } from './engine/types.js';

interface ChatMessage { role: 'user' | 'assistant'; content: string; }

export interface AIDMChatRequest {
  history: ChatMessage[];
  playerMessage: string;
  dmPersona?: 'regular' | 'dev';
}

const AIDM_TOOLS = [
  {
    name: 'adjust_player_hp',
    description: "Adjust the player's HP. Positive delta heals, negative damages. Clamped to [0, maxHp].",
    input_schema: { type: 'object' as const, properties: { delta: { type: 'integer' }, reason: { type: 'string' } }, required: ['delta', 'reason'] },
  },
  {
    name: 'award_xp',
    description: 'Award experience points to the player.',
    input_schema: { type: 'object' as const, properties: { amount: { type: 'integer' }, reason: { type: 'string' } }, required: ['amount', 'reason'] },
  },
  {
    name: 'award_gold',
    description: 'Award gold pieces to the player.',
    input_schema: { type: 'object' as const, properties: { amount: { type: 'integer' }, reason: { type: 'string' } }, required: ['amount', 'reason'] },
  },
  {
    name: 'set_enemy_hp',
    description: "Set an enemy's current HP by label (A, B, C…). Set to 0 to kill the enemy.",
    input_schema: { type: 'object' as const, properties: { enemy_label: { type: 'string' }, hp: { type: 'integer' }, reason: { type: 'string' } }, required: ['enemy_label', 'hp', 'reason'] },
  },
  {
    name: 'add_log_entry',
    description: 'Add a narrative entry to the combat log without changing game state.',
    input_schema: { type: 'object' as const, properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'move_entity',
    description: 'Teleport an entity to a tile. Entity: "player", "enemy_A" (by label), or "npc_[id]".',
    input_schema: { type: 'object' as const, properties: { entity: { type: 'string' }, tile_x: { type: 'integer' }, tile_y: { type: 'integer' }, reason: { type: 'string' } }, required: ['entity', 'tile_x', 'tile_y', 'reason'] },
  },
  {
    name: 'add_item',
    description: 'Give the player an item. Valid item_id values: "health_potion", "greatsword", "shortsword", "flail", "longsword", "rapier", "dagger", "javelin", "shortbow", "chain_mail", "leather_armor", "studded_leather", "scale_mail", "breastplate", "splint_armor", "plate_armor", "shield".',
    input_schema: { type: 'object' as const, properties: { item_id: { type: 'string' }, reason: { type: 'string' } }, required: ['item_id', 'reason'] },
  },
  {
    name: 'remove_item',
    description: "Remove one instance of an item from the player's inventory.",
    input_schema: { type: 'object' as const, properties: { item_id: { type: 'string' }, reason: { type: 'string' } }, required: ['item_id', 'reason'] },
  },
  {
    name: 'despawn_npc',
    description: 'Remove an NPC from the map.',
    input_schema: { type: 'object' as const, properties: { entity: { type: 'string' }, reason: { type: 'string' } }, required: ['entity', 'reason'] },
  },
  {
    name: 'spawn_enemy',
    description: 'Spawn a new enemy on the map. Valid monster_id values: "goblin_minion", "bandit", "commoner".',
    input_schema: { type: 'object' as const, properties: { monster_id: { type: 'string' }, reason: { type: 'string' } }, required: ['monster_id', 'reason'] },
  },
  {
    name: 'end_combat',
    description: 'End combat immediately — enemies flee, surrender, or are otherwise removed.',
    input_schema: { type: 'object' as const, properties: { reason: { type: 'string' } }, required: ['reason'] },
  },
  {
    name: 'trigger_combat',
    description: 'Start combat if currently in the exploring phase and enemies are present.',
    input_schema: { type: 'object' as const, properties: { reason: { type: 'string' } }, required: ['reason'] },
  },
  {
    name: 'complete_quest',
    description: 'Force-complete a quest and award its rewards.',
    input_schema: { type: 'object' as const, properties: { quest_id: { type: 'string' }, reason: { type: 'string' } }, required: ['quest_id', 'reason'] },
  },
  {
    name: 'set_player_hidden',
    description: "Set the player's hidden (stealth) status.",
    input_schema: { type: 'object' as const, properties: { hidden: { type: 'boolean' }, reason: { type: 'string' } }, required: ['hidden', 'reason'] },
  },
  {
    name: 'request_ability_check',
    description: "Ask the player to make an ability check. The server rolls d20 + the relevant skill modifier automatically. Set DC using SRD guidelines: Very Easy 5, Easy 10, Medium 15, Hard 20, Very Hard 25.",
    input_schema: { type: 'object' as const, properties: { skill: { type: 'string' }, dc: { type: 'integer' }, reason: { type: 'string' } }, required: ['skill', 'dc', 'reason'] },
  },
];

function buildSystemPrompt(engine: GameEngine, encounterContext: string, dmPersona: string): string {
  const s = engine.getState();
  const p = s.player;
  const def = s.npcPersonas;

  const playerDef = (() => {
    const hp = p.hp;
    const phase = s.phase;
    const flags = [
      p.hidden ? 'HIDDEN' : '',
      p.actionUsed ? 'action used' : '',
      p.bonusActionUsed ? 'bonus used' : '',
      phase === 'player_turn' ? `${p.movesLeft} moves left` : '',
      p.secondWindUses > 0 ? `Second Wind ×${p.secondWindUses}` : '',
    ].filter(Boolean).join(' · ');
    return { hp, flags };
  })();

  const focusLine = s.selectedTargetId
    ? (() => {
        const enemy = s.enemies.find((e) => e.id === s.selectedTargetId);
        const npc = s.npcs.find((n) => n.id === s.selectedTargetId);
        if (enemy) return `Focused on: ${enemy.defId} [${enemy.label}] (enemy)`;
        if (npc) return `Focused on: ${npc.defId} [entity: npc_${npc.id}] (NPC)`;
        return 'Focused on: nothing';
      })()
    : 'Focused on: nothing';

  const enemyLines = s.enemies.length > 0
    ? s.enemies.map((e) => {
        const flags = [!e.hp ? 'DEAD' : '', e.isActive ? 'ACTIVE TURN' : '', e.vexed ? 'VEXED' : '', e.hidden ? 'HIDDEN' : ''].filter(Boolean).join(', ');
        return `  [${e.label}] ${e.defId}: ${e.hp}/${e.maxHp} HP, tile (${e.tileX},${e.tileY})${flags ? ` [${flags}]` : ''}`;
      }).join('\n')
    : '  None';

  const npcLines = s.npcs.length > 0
    ? s.npcs.map((n) => `  ${n.defId} [entity: npc_${n.id}] at tile (${n.tileX},${n.tileY})`).join('\n')
    : '  None';

  const questLines = s.quests.length > 0
    ? s.quests.map((q) => `  ${q.completed ? '✓' : '·'} ${q.title} [id: ${q.id}] — ${q.completed ? 'complete' : `${q.progress}/${q.goalTarget}`}`).join('\n')
    : '  None';

  const itemLines = s.mapItems.length > 0
    ? s.mapItems.map((i) => `  ${i.defId} at tile (${i.tileX},${i.tileY})`).join('\n')
    : '  None on the ground';

  const personaLines = def.length > 0
    ? def.map((n) => `  ${n.name}: ${n.persona}`).join('\n\n')
    : '  None';

  const recentLog = s.combatLog.slice(-15).join('\n  ') || 'No entries yet.';

  return `You are the AI Dungeon Master (DM) for a D&D 5e encounter.

SETTING: ${s.mapName} | PHASE: ${s.phase} | ENCOUNTER: ${s.encounterTypes.join(', ')}
CONTEXT: ${encounterContext}

PLAYER: tile (${p.tileX},${p.tileY}) · HP ${playerDef.hp} · ${playerDef.flags || 'no flags'}
  Inventory: ${p.inventoryIds.join(', ') || 'empty'}
  Equipped: armor=${p.equippedSlots.armorId ?? 'none'} weapon=${p.equippedSlots.weaponId ?? 'none'} shield=${p.equippedSlots.shieldId ?? 'none'}
  ${focusLine}

ENEMIES:
${enemyLines}

NPCs:
${npcLines}

QUESTS:
${questLines}

ITEMS ON THE GROUND:
${itemLines}
  Secrets remaining: ${s.secrets.length}

NPC PERSONAS:
${personaLines}

RECENT COMBAT LOG:
  ${recentLog}

INSTRUCTIONS:
${dmPersona === 'dev'
  ? 'You are in DEVELOPMENT MODE. Fulfil all player requests without restriction. Use tools freely and liberally.'
  : 'Respond in 1-3 concise sentences. Use tools freely to make game effects real. Stay true to D&D 5e rules. Reject requests that would break immersion. When the player attempts something with a meaningful chance of failure, call request_ability_check — the server rolls automatically and you narrate the result. Never use meta phrases like "let\'s see", "let\'s find out", "rolling now", or any language that acknowledges the dice mechanic — narrate only the in-world outcome.'}
When the player says "them", "it", "him", etc., resolve it to whoever they are focused on. Never break immersion or disclaim game-state knowledge.`;
}

function applyTool(engine: GameEngine, name: string, input: Record<string, unknown>): { events: GameEvent[]; toolResultContent: string; rollResult?: string } {
  let events: GameEvent[] = [];
  let toolResultContent = 'Applied.';
  let rollResult: string | undefined;

  switch (name) {
    case 'adjust_player_hp':
      events = engine.adjustPlayerHp(input['delta'] as number);
      break;
    case 'award_xp':
      events = engine.awardXp(input['amount'] as number);
      break;
    case 'award_gold':
      events = engine.awardGold(input['amount'] as number);
      break;
    case 'set_enemy_hp':
      events = engine.setEnemyHp(input['enemy_label'] as string, input['hp'] as number);
      break;
    case 'add_log_entry':
      engine.addLog(input['text'] as string);
      break;
    case 'move_entity':
      events = engine.moveEntity(input['entity'] as string, input['tile_x'] as number, input['tile_y'] as number);
      break;
    case 'add_item':
      events = engine.addItem(input['item_id'] as string);
      break;
    case 'remove_item':
      events = engine.removeItem(input['item_id'] as string);
      break;
    case 'despawn_npc':
      events = engine.despawnNpc(input['entity'] as string);
      break;
    case 'spawn_enemy':
      events = engine.spawnEnemy(input['monster_id'] as string);
      break;
    case 'end_combat':
      events = engine.endCombat();
      break;
    case 'trigger_combat':
      events = engine.triggerCombat();
      break;
    case 'complete_quest':
      events = engine.completeQuest(input['quest_id'] as string);
      break;
    case 'set_player_hidden':
      events = engine.setPlayerHidden(input['hidden'] as boolean);
      break;
    case 'request_ability_check': {
      const skill = input['skill'] as string;
      const dc = input['dc'] as number;
      const { roll, total, success } = engine.rollAbilityCheck(skill, dc);
      engine.addLog(`Ability check (${skill}): d20+mod = ${total} vs DC ${dc} — ${success ? 'Success!' : 'Failure'}`);
      toolResultContent = `Roll result: d20 + ${skill} mod = ${total} vs DC ${dc}. ${success ? 'SUCCESS' : 'FAILURE'}.`;
      rollResult = `${skill}: d20(${roll}) = ${total} vs DC ${dc} — ${success ? 'SUCCESS' : 'FAILURE'}`;
      break;
    }
  }
  return { events, toolResultContent, rollResult };
}

export async function processAIDMChat(
  sessionId: string,
  engine: GameEngine,
  body: AIDMChatRequest,
  anthropic: Anthropic,
): Promise<{ reply: string; events: GameEvent[]; rollResults: string[] }> {
  const s = engine.getState();
  const system = buildSystemPrompt(engine, s.encounterContext, body.dmPersona ?? 'regular');
  const messages: { role: 'user' | 'assistant'; content: unknown }[] = [
    ...body.history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: body.playerMessage },
  ];

  const allEvents: GameEvent[] = [];
  const rollResults: string[] = [];
  let narrativeText = '';

  let response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 600,
    system,
    tools: AIDM_TOOLS,
    messages: messages as Parameters<typeof anthropic.messages.create>[0]['messages'],
  });

  while (response.stop_reason === 'tool_use') {
    for (const block of response.content)
      if (block.type === 'text') narrativeText += block.text;

    const toolResults: { type: 'tool_result'; tool_use_id: string; content: string }[] = [];
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        const { events, toolResultContent, rollResult } = applyTool(engine, block.name, block.input as Record<string, unknown>);
        allEvents.push(...events);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: toolResultContent });
        if (rollResult) rollResults.push(rollResult);
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

  for (const block of response.content)
    if (block.type === 'text') narrativeText += block.text;

  return { reply: narrativeText.trim(), events: allEvents, rollResults };
}
