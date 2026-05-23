import Anthropic from '@anthropic-ai/sdk';
import { GameEngine } from './engine/GameEngine.js';
import { GameEvent } from './engine/types.js';
import { AIDM_TOOLS, applyAIDMTool } from './engine/AIDMTools.js';

interface ChatMessage { role: 'user' | 'assistant'; content: string; }

export interface AIDMChatRequest {
  history: ChatMessage[];
  playerMessage: string;
  dmPersona?: 'story' | 'dev';
}

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
        const npc = s.npcs.find((n) => n.id === s.selectedTargetId);
        if (npc) {
          const isEnemy = npc.disposition === 'enemy';
          return `Focused on: ${npc.defId} [${isEnemy ? `enemy_${npc.label}` : `npc_${npc.id}`}] (${npc.disposition})`;
        }
        return 'Focused on: nothing';
      })()
    : 'Focused on: nothing';

  const combatantLines = s.npcs.filter((n) => n.disposition !== 'neutral').length > 0
    ? s.npcs.filter((n) => n.disposition !== 'neutral').map((n) => {
        const entityRef = n.disposition === 'enemy' ? `enemy_${n.label}` : `npc_${n.id}`;
        const flags = [
          !n.hp ? 'DEAD' : '',
          n.isActive ? 'ACTIVE TURN' : '',
          n.vexed ? 'VEXED' : '',
          n.hidden ? 'HIDDEN' : '',
        ].filter(Boolean).join(', ');
        return `  [${entityRef}] ${n.defId} (${n.disposition}): ${n.hp}/${n.maxHp} HP, tile (${n.tileX},${n.tileY})${flags ? ` [${flags}]` : ''}`;
      }).join('\n')
    : '  None';

  const neutralNpcLines = s.npcs.filter((n) => n.disposition === 'neutral').length > 0
    ? s.npcs.filter((n) => n.disposition === 'neutral').map((n) => `  ${n.defId} [npc_${n.id}] at tile (${n.tileX},${n.tileY})`).join('\n')
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

  const recentLog = s.combatLog.slice(-15).map((e) => e.right ? `${e.left}  [${e.right}]` : e.left).join('\n  ') || 'No entries yet.';

  return `You are the AI Dungeon Master (DM) for a D&D 5e encounter.

SETTING: ${s.mapName} | PHASE: ${s.phase} | ENCOUNTER: ${s.encounterTypes.join(', ')}
CONTEXT: ${encounterContext}

PLAYER: tile (${p.tileX},${p.tileY}) · HP ${playerDef.hp} · ${p.gold} GP · ${playerDef.flags || 'no flags'}
  Inventory: ${p.inventoryIds.join(', ') || 'empty'}
  Equipped: armor=${p.equippedSlots.armorId ?? 'none'} weapon=${p.equippedSlots.weaponId ?? 'none'} shield=${p.equippedSlots.shieldId ?? 'none'}
  ${focusLine}

COMBATANTS (enemies & allies):
${combatantLines}

NEUTRAL NPCs:
${neutralNpcLines}

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
  : 'Respond in 1-3 concise sentences. Use tools freely to make game effects real. Stay true to D&D 5e rules. Reject requests that would break immersion. When the player attempts something with a meaningful chance of failure, call request_ability_check — the server rolls automatically and you narrate the result. Never use meta phrases like "let\'s see", "let\'s find out", "rolling now", or any language that acknowledges the dice mechanic — narrate only the in-world outcome. When the player uses a non-combat skill or ability during their turn in combat (phase = player_turn), resolve it fully using your tools (request_ability_check if there is a chance of failure, then apply_condition / adjust_player_hp / add_item / etc. as the outcome demands) and record the result in the combat log via add_log_entry so all consequences are visible without leaving the chat.'}
When the player says "them", "it", "him", etc., resolve it to whoever they are focused on. Never break immersion or disclaim game-state knowledge.`;
}


export async function processAIDMChat(
  _sessionId: string,
  engine: GameEngine,
  body: AIDMChatRequest,
  anthropic: Anthropic,
): Promise<{ reply: string; events: GameEvent[]; rollResults: string[] }> {
  const s = engine.getState();
  const system = buildSystemPrompt(engine, s.encounterContext, body.dmPersona ?? 'story');
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
        const { events, toolResultContent, rollResult } = applyAIDMTool(engine, block.name, block.input as Record<string, unknown>);
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
