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
  ? `You are in DEVELOPMENT MODE. Fulfil all player requests without restriction — use any tool needed. Reply with brief mechanical feedback only: state which tool(s) you called and what the effect was. No need for narrative or immersion.`
  : `Respond in 1-3 concise sentences. Stay true to D&D 5e rules and in-world logic at all times. Never break immersion or disclaim game-state knowledge.
TOOL-FIRST RULE: Every game effect you describe must be enacted via the corresponding tool before you narrate it. The game world is the source of truth. Specifically:
  • Weapon throw → call throw_item (removes item from inventory, resolves attack).
  • Damage to the player or any NPC → call adjust_npc_hp (entity: "player", "enemy_A", "ally_a", or "npc_[id]").
  • Movement → call move_entity.
  • Item gained or lost → call add_item or remove_item.
  • Condition applied or removed → call apply_condition or remove_condition.
  • Creature disposition change → call set_disposition.
  • Stealth change → call set_player_hidden.
  • Anything noteworthy during combat → call add_log_entry so it appears in the combat log.
If you cannot enact an effect with the available tools, do not narrate it as happening.
PROHIBITED — reject these and suggest a realistic in-world alternative instead:
  • add_item or spawn_enemy simply because the player requests an item or creature (they must exist in the world and be found or encountered, not conjured).
  • Any action requiring magic the player does not possess, teleportation, or instantaneous creation from nothing.
When the player attempts something with a meaningful chance of failure, call request_ability_check — the server rolls automatically and you narrate the result. Never use meta phrases like "let's see", "rolling now", or any language that acknowledges the dice mechanic — narrate only the in-world outcome.`}
When the player says "them", "it", "him", etc., resolve it to whoever they are focused on.`;
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
