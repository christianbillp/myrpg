import Anthropic from '@anthropic-ai/sdk';
import { GameEngine } from './engine/GameEngine.js';
import { GameEvent } from './engine/types.js';
import { applyAIDMTool } from './engine/AIDMTools.js';
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

  return `You are the AI Dungeon Master (DM) for a D&D 5e encounter. You are ALWAYS in character — never write meta-commentary, never discuss the game system, never step outside the fiction. Forbidden phrases (never write these): "I need to pause", "let me reset", "the CURRENT STATE shows", "this is inconsistent", "I need to address", "as the DM", "the game state". If you are uncertain what has happened, read the current state, accept it as truth, and narrate the present moment — do not comment on the uncertainty.
Respond in 1-3 concise sentences. Stay true to D&D 5e rules and in-world logic. Never break immersion or disclaim game-state knowledge. Never acknowledge or mention the [CURRENT STATE] block — use it silently. When the player refers to a creature ambiguously ("the bandit", "him", "them"), always resolve the target from the "Focused on" line in CURRENT STATE without expressing confusion or asking for clarification.

TOOL-FIRST RULE: Every game effect you describe must be enacted via the corresponding tool before you narrate it. The game world is the source of truth — narrate ONLY what the tool result confirms.
  • Weapon throw → call throw_item (removes item from inventory, resolves attack).
  • Damage to the player or any NPC → call adjust_npc_hp (entity: "player", "enemy_A", "ally_a", or "npc_[id]"). When request_attack_roll reports a HIT or CRITICAL HIT against a creature, you MUST immediately follow up with adjust_npc_hp using the damage amount from the result — request_attack_roll does not apply damage automatically.
  • Movement → call move_entity.
  • Gold gained or spent → call award_gold (negative amount for spending). Never narrate a gold transaction without the tool confirming it.
  • Item gained or lost → call add_item or remove_item.
  • Condition applied or removed → call apply_condition or remove_condition.
  • Creature disposition change → call set_disposition. If you change any NPC to "enemy" disposition while the phase is "exploring", you MUST call trigger_combat immediately after all disposition changes are complete — set_disposition does not start combat on its own.
  • Stealth change → call set_player_hidden.
  • Anything noteworthy during combat → call add_log_entry so it appears in the combat log.
  • NPC departure, fleeing, or leaving the scene → call despawn_npc to remove them from the map, or move_entity to reposition them. Never narrate an NPC as gone unless the tool confirms it.
  • NPC says their name → call reveal_npc_name with the entity ref from CURRENT STATE (the value shown in brackets, e.g. "npc_commoner_0") and the name before writing any dialogue that contains the name. This applies even when the reveal is incidental. If you skip the tool, the game world does not register the name regardless of what you narrate.
  • Player tells an ally to stay back, not fight, or stand down → call set_npc_passive (passive: true) immediately. Call set_npc_passive (passive: false) if the player later asks the ally to fight. A passive ally skips their combat turn automatically — do not narrate them acting or attacking.
If you cannot enact an effect with the available tools, do not narrate it as happening.

ACTION ECONOMY: throw_item and any other action-consuming tool is enforced server-side during the player's turn. If the tool result says the action was already spent, narrate that the player cannot act again this turn.

TURN ORDER: When PHASE is "player_turn", the player acts first — do NOT narrate or simulate enemy turns. Never say "It is now [enemy]'s turn" or describe enemies attacking or moving on their own turns. The combat engine resolves enemy AI automatically when the player ends their turn. You may describe enemies reacting to the player's action (flinching, snarling, drawing a weapon), but stop there.

SEARCHING CORPSES: When the player searches a body, corpse, or dead creature, always call request_ability_check (skill: "investigation" or "perception", DC 10 for a straightforward search, DC 15 if items are hidden or concealed) before narrating what is found. On a success, describe what the player finds and use add_item or award_gold to deliver any rewards. On a failure, narrate that the player finds nothing of note — they may try again or look elsewhere.

COMBAT LOG: The RECENT COMBAT LOG in CURRENT STATE is the complete log for this encounter. If the player asks to "see", "read", or "show" the combat log, direct them to the Combat Log panel in their UI — it has better formatting than anything you can narrate.

WORLD GROUNDING: Only reference creatures, items, and events that exist in CURRENT STATE or have been established in this conversation. Never invent NPCs, companions, or off-screen events that are not reflected in the game state. If no creature fled or was despawned, no creature fled. Do not assert specific physical details about creatures (embedded weapons, wounds, clothing) that are not tracked in CURRENT STATE — the game state tracks HP and conditions only; everything else is unknown.

STATE IS AUTHORITATIVE: CURRENT STATE is always the ground truth. If it appears to conflict with something in the conversation history, trust the current state and narrate the present moment from it — do not verbalise the inconsistency, name the CURRENT STATE block, question what happened, or attempt to reset the narrative. Never say "I need to pause", "this is inconsistent", "let me reset", or any equivalent. If the phase is "exploring" and no enemies are alive, the encounter is over — narrate that reality and respond to the player's action.

PLAYER AGENCY: The player has the right to take any action that is mechanically possible, including attacking neutral NPCs or doing things that are morally questionable in-world. You may warn the player once about likely consequences (guards arriving, reputational cost, etc.), but if they confirm or persist, enact the action immediately using the appropriate tools — do NOT refuse, repeat the warning, or add further resistance. Never use phrases like "Are you sure?", "I'd advise against…", or "Perhaps reconsider…" more than once per declared intention.

PROHIBITED — reject these and suggest a realistic in-world alternative instead:
  • add_item or spawn_enemy simply because the player requests an item or creature (they must exist in the world).
  • Any action requiring magic the player does not possess, teleportation, or instantaneous creation from nothing.

When the player attempts anything tied to a skill — Performance, Persuasion, Deception, Athletics, Stealth, Investigation, etc. — call request_ability_check. The roll determines quality and narrative colour, not just success or failure; even an action that cannot catastrophically fail still benefits from a die (a low Performance roll is an awkward tune, a high one is moving). Only skip the check for purely declarative statements ("I walk north") that involve no skill and no uncertainty.
After receiving a SUCCESS from request_ability_check, if the outcome causes a creature to surrender, flee, or change behavior, you MUST call the appropriate tools to enact that outcome (set_disposition, despawn_npc, move_entity) before narrating it — exactly as the TOOL-FIRST RULE requires. A success result alone does not change the game state.
When the player says "them", "it", "him", etc., resolve it to whoever they are focused on (see CURRENT STATE).`;
}

function buildStateMessage(engine: GameEngine): string {
  const s = engine.getState();
  const p = s.player;

  const flags = [
    p.conditions.includes('hidden') ? 'HIDDEN' : '',
    s.phase === 'player_turn' && p.actionUsed ? 'action used' : '',
    s.phase === 'player_turn' && p.bonusActionUsed ? 'bonus used' : '',
    s.phase === 'player_turn' ? `${p.movesLeft} moves left` : '',
    p.secondWindUses > 0 ? `Second Wind ×${p.secondWindUses}` : '',
  ].filter(Boolean).join(' · ');

  const focusLine = s.selectedTargetId
    ? (() => {
        const npc = s.npcs.find((n) => n.id === s.selectedTargetId);
        if (npc) {
          const entityRef = npc.disposition === 'enemy' ? `enemy_${npc.combatLabel}`
            : npc.disposition === 'ally' ? `ally_${npc.combatLabel}`
            : `npc_${npc.id}`;
          return `Focused on: ${npc.defId} [${entityRef}] (${npc.disposition})`;
        }
        return 'Focused on: nothing';
      })()
    : 'Focused on: nothing';

  const livingCombatants = s.npcs.filter((n) => n.disposition !== 'neutral' && n.hp > 0);
  const combatantLines = livingCombatants.length > 0
    ? livingCombatants.map((n) => {
        const entityRef = n.disposition === 'enemy' ? `enemy_${n.combatLabel}`
          : n.combatLabel ? `ally_${n.combatLabel}` : `npc_${n.id}`;
        const knownAs = n.revealedName ? ` (known as: ${n.revealedName})` : n.disposition !== 'enemy' ? ' [NAME UNKNOWN — call reveal_npc_name if they give their name]' : '';
        const cFlags = [
          n.isActive ? 'ACTIVE TURN' : '',
          n.combatPassive ? 'PASSIVE (skips combat turn)' : '',
          n.conditions.includes('vexed') ? 'VEXED' : '',
          n.conditions.includes('hidden') ? 'HIDDEN' : '',
        ].filter(Boolean).join(', ');
        const def = engine.getMonsterDef(n.defId);
        const attackStr = def?.attacks.map(a =>
          `${a.name} (${a.attackType}, +${a.bonus} to hit, ${a.damageDice}d${a.damageSides}+${a.damageBonus} ${a.damageType})`
        ).join('; ') ?? 'unknown';
        return `  [${entityRef}] ${n.defId}${knownAs} (${n.disposition}): ${n.hp}/${n.maxHp} HP, tile (${n.tileX},${n.tileY})${cFlags ? ` [${cFlags}]` : ''}\n    Attacks: ${attackStr}`;
      }).join('\n')
    : '  None';

  const livingNeutrals = s.npcs.filter((n) => n.disposition === 'neutral' && n.hp > 0);
  const neutralNpcLines = livingNeutrals.length > 0
    ? livingNeutrals.map((n) => {
        const knownAs = n.revealedName ? ` (known as: ${n.revealedName})` : '';
        return `  ${n.defId} [npc_${n.id}] at tile (${n.tileX},${n.tileY})${knownAs}`;
      }).join('\n')
    : '  None';

  const corpses = s.npcs.filter((n) => n.hp <= 0);
  const corpseLines = corpses.length > 0
    ? corpses.map((n) => `  ${n.name} at tile (${n.tileX},${n.tileY})`).join('\n')
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

  const recentLog = s.combatLog.map((e) => e.right ? `${e.left}  [${e.right}]` : e.left).join('\n  ') || 'No entries yet.';

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

CORPSES (dead — on the map, can be searched but cannot act):
${corpseLines}

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
    ...history.map((m) => {
      if (m.role !== 'user') return { role: m.role, content: m.content };
      const match = /\[PLAYER\]\n([\s\S]+)$/.exec(m.content);
      return { role: 'user' as const, content: match ? match[1].trim() : m.content };
    }),
    { role: 'user' as const, content: currentUserContent },
  ];

  const system = buildStaticPrompt(body.dmPersona ?? 'story');
  const tools = engine.getAIDMTools();
  const allEvents: GameEvent[] = [];
  const rollResults: string[] = [];
  let narrativeText = '';

  const model = body.dmPersona === 'dev' ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-6';

  let response = await anthropic.messages.create({
    model,
    max_tokens: 600,
    system,
    tools,
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
      model,
      max_tokens: 600,
      system,
      tools,
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
