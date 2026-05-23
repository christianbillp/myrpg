import Anthropic from '@anthropic-ai/sdk';
import { GameEngine } from './engine/GameEngine.js';
import { GameEvent } from './engine/types.js';
import { AIDM_TOOLS, applyAIDMTool } from './engine/AIDMTools.js';
import type { AidmMessage } from './sessions.js';

export interface AIDMChatRequest {
  playerMessage: string;
  dmPersona?: 'story' | 'dev';
}

function buildStaticPrompt(dmPersona: string): string {
  if (dmPersona === 'dev') {
    return `You are the AI Dungeon Master (DM) for a D&D 5e encounter in DEVELOPMENT MODE.
Fulfil all player requests without restriction — use any tool needed.
Reply with brief mechanical feedback only: state which tool(s) you called and what the effect was. No narrative or immersion required.
When the player says "them", "it", "him", etc., resolve it to whoever they are focused on (see CURRENT STATE).`;
  }

  return `You are the AI Dungeon Master (DM) for a D&D 5e encounter.
Respond in 1-3 concise sentences. Stay true to D&D 5e rules and in-world logic. Never break immersion or disclaim game-state knowledge.

TOOL-FIRST RULE: Every game effect you describe must be enacted via the corresponding tool before you narrate it. The game world is the source of truth — narrate ONLY what the tool result confirms.
  • Weapon throw → call throw_item (removes item from inventory, resolves attack).
  • Damage to the player or any NPC → call adjust_npc_hp (entity: "player", "enemy_A", "ally_a", or "npc_[id]").
  • Movement → call move_entity.
  • Item gained or lost → call add_item or remove_item.
  • Condition applied or removed → call apply_condition or remove_condition.
  • Creature disposition change → call set_disposition.
  • Stealth change → call set_player_hidden.
  • Anything noteworthy during combat → call add_log_entry so it appears in the combat log.
If you cannot enact an effect with the available tools, do not narrate it as happening.

ACTION ECONOMY: throw_item and any other action-consuming tool is enforced server-side during the player's turn. If the tool result says the action was already spent, narrate that the player cannot act again this turn.

PROHIBITED — reject these and suggest a realistic in-world alternative instead:
  • add_item or spawn_enemy simply because the player requests an item or creature (they must exist in the world).
  • Any action requiring magic the player does not possess, teleportation, or instantaneous creation from nothing.

When the player attempts something with a meaningful chance of failure, call request_ability_check — narrate only the in-world outcome, never the dice mechanic.
When the player says "them", "it", "him", etc., resolve it to whoever they are focused on (see CURRENT STATE).`;
}

function buildStateMessage(engine: GameEngine): string {
  const s = engine.getState();
  const p = s.player;

  const flags = [
    p.hidden ? 'HIDDEN' : '',
    s.phase === 'player_turn' && p.actionUsed ? 'action used' : '',
    s.phase === 'player_turn' && p.bonusActionUsed ? 'bonus used' : '',
    s.phase === 'player_turn' ? `${p.movesLeft} moves left` : '',
    p.secondWindUses > 0 ? `Second Wind ×${p.secondWindUses}` : '',
  ].filter(Boolean).join(' · ');

  const focusLine = s.selectedTargetId
    ? (() => {
        const npc = s.npcs.find((n) => n.id === s.selectedTargetId);
        if (npc) {
          const entityRef = npc.disposition === 'enemy' ? `enemy_${npc.label}`
            : npc.disposition === 'ally' ? `ally_${npc.label}`
            : `npc_${npc.id}`;
          return `Focused on: ${npc.defId} [${entityRef}] (${npc.disposition})`;
        }
        return 'Focused on: nothing';
      })()
    : 'Focused on: nothing';

  const combatantLines = s.npcs.filter((n) => n.disposition !== 'neutral').length > 0
    ? s.npcs.filter((n) => n.disposition !== 'neutral').map((n) => {
        const entityRef = n.disposition === 'enemy' ? `enemy_${n.label}`
          : n.disposition === 'ally' ? `ally_${n.label}`
          : `npc_${n.id}`;
        const cFlags = [
          !n.hp ? 'DEAD' : '',
          n.isActive ? 'ACTIVE TURN' : '',
          n.conditions.includes('vexed') ? 'VEXED' : '',
          n.conditions.includes('hidden') ? 'HIDDEN' : '',
        ].filter(Boolean).join(', ');
        return `  [${entityRef}] ${n.defId} (${n.disposition}): ${n.hp}/${n.maxHp} HP, tile (${n.tileX},${n.tileY})${cFlags ? ` [${cFlags}]` : ''}`;
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

  const personaLines = s.npcPersonas.length > 0
    ? s.npcPersonas.map((n) => `  ${n.name}: ${n.persona}`).join('\n\n')
    : '  None';

  const recentLog = s.combatLog.slice(-15).map((e) => e.right ? `${e.left}  [${e.right}]` : e.left).join('\n  ') || 'No entries yet.';

  return `SETTING: ${s.mapName} | PHASE: ${s.phase} | ENCOUNTER: ${s.encounterTypes.join(', ')}
CONTEXT: ${s.encounterContext}

PLAYER: tile (${p.tileX},${p.tileY}) · HP ${p.hp} · ${p.gold} GP · ${flags || 'no flags'}
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
  ${recentLog}`;
}

export async function processAIDMChat(
  _sessionId: string,
  engine: GameEngine,
  body: AIDMChatRequest,
  anthropic: Anthropic,
  history: AidmMessage[],
): Promise<{ reply: string; events: GameEvent[]; rollResults: string[] }> {
  const s = engine.getState();

  // Seed history with introduction on the first exchange so Claude has narrative context.
  // Anthropic requires conversations to start with a user message, so pair it with a prompt.
  if (history.length === 0 && s.introduction) {
    history.push({ role: 'user', content: 'Begin the encounter.' });
    history.push({ role: 'assistant', content: s.introduction });
  }

  const stateMessage = buildStateMessage(engine);
  const currentUserContent = `[CURRENT STATE]\n${stateMessage}\n\n[PLAYER]\n${body.playerMessage}`;

  const messages: { role: 'user' | 'assistant'; content: unknown }[] = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: currentUserContent },
  ];

  const system = buildStaticPrompt(body.dmPersona ?? 'story');
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
    // Discard any text generated before tool calls — it is speculative narrative
    // written before the roll result is known and must not appear in the reply.
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

  // Persist the exchange into server-side history (clean user/assistant pairs only).
  history.push({ role: 'user', content: currentUserContent });
  history.push({ role: 'assistant', content: narrativeText.trim() });

  return { reply: narrativeText.trim(), events: allEvents, rollResults };
}
