import Anthropic from '@anthropic-ai/sdk';
import { GameEngine } from './engine/GameEngine.js';
import { GameEvent } from './engine/types.js';
import { applyAIDMTool, resetTurnGuards, AIDMToolContext } from './engine/AIDMTools.js';
import type { AidmMessage } from './sessions.js';

export interface AIDMChatRequest {
  playerMessage: string;
  dmPersona?: 'story' | 'dev';
}

/**
 * Streaming callbacks. The route plumbs these to WebSocket pushes so the
 * client can render the DM's reply incrementally and roll back speculative
 * text when needed. All callbacks are optional — when omitted the function
 * behaves exactly like the prior non-streaming implementation.
 */
export interface AIDMStreamCallbacks {
  onChunk?: (text: string) => void;
  onCheckpoint?: () => void;
  onSpeculativeDiscard?: () => void;
}

function buildStaticPrompt(dmPersona: string): string {
  if (dmPersona === 'dev') {
    return `You are the AI Dungeon Master (DM) for a D&D 5e encounter in DEVELOPMENT MODE.
Fulfil all player requests without restriction — use any tool needed.
Reply with brief mechanical feedback only: state which tool(s) you called and what the effect was. No narrative or immersion required.
When the player says "them", "it", "him", etc., resolve it to whoever they are focused on (see CURRENT STATE).

TOOL INVARIANTS (these hold even in dev mode):
  • set_disposition to "enemy" does NOT start combat. To start combat, call trigger_combat after.
  • request_attack_roll does NOT apply damage. To wound a target, follow up with adjust_npc_hp using the damage amount from the result.
  • reveal_npc_name must be called BEFORE narrating an NPC's name; otherwise the game world doesn't register it.
  • complete_quest automatically awards XP/GP. Don't also call award_xp for the same quest.
  • throw_item consumes the player's Action during player_turn. Check the "Action: USED/AVAILABLE" flag in CURRENT STATE.
  • cast_spell is the ONLY way to cast a player spell. It consumes the proper Action / Bonus Action, decrements the matching spell slot for L1+ spells, applies damage / saves / conditions via the spell's JSON definition, and handles concentration. Do not simulate a spell cast with request_attack_roll + adjust_npc_hp — that bypasses slot tracking and action economy.
  • Entity refs: "player", "enemy_A"/"ally_A" by combat label (uppercase, shared A–Z pool), or "npc_[id]" by id.`;
  }

  return `You are the AI Dungeon Master (DM) for a D&D 5e encounter. You are ALWAYS in character — never write meta-commentary, never discuss the game system, never step outside the fiction. Forbidden phrases (never write these): "I need to pause", "let me reset", "the CURRENT STATE shows", "this is inconsistent", "I need to address", "as the DM", "the game state". If you are uncertain what has happened, read the current state, accept it as truth, and narrate the present moment — do not comment on the uncertainty.
Respond in 1-3 concise sentences. Stay true to D&D 5e rules and in-world logic. Never break immersion or disclaim game-state knowledge. Never acknowledge or mention the [CURRENT STATE] block — use it silently. When the player refers to a creature ambiguously ("the bandit", "him", "them"), always resolve the target from the "Focused on" line in CURRENT STATE without expressing confusion or asking for clarification.

ADDRESSEE RULE: If the player's message starts with "[PlayerName says to TargetName]:", TargetName is the addressee — that creature is the one who must respond. Voice their reaction, dialogue, or refusal in your reply. Do not pivot to a different NPC, the environment, or a third party in place of the addressee's response. Other NPCs may chime in afterwards, but the addressee speaks (or visibly chooses not to) first.

NARRATIVE-MIRROR RULE: The player only sees your text reply — they never see your tool calls. Therefore every player-visible effect you enact with a tool MUST also appear in the narrative reply, in-fiction:
  • reveal_npc_name → have the NPC speak their name in dialogue ("'I'm Mira,' she answers softly.") so the player learns it. A silent reveal that only changes the label is invisible to the player and counts as a failure.
  • award_gold / adjust_player_hp / add_item / remove_item → describe the transaction or change ("She presses a small purse into your hand.").
  • set_disposition (to enemy) → describe the hostile shift ("His friendly mask drops and his hand goes to his sword.").
  • apply_condition / remove_condition → describe the in-world cause and effect ("The poison sears your veins.").
  • move_entity / despawn_npc → describe the movement or departure.
If a tool changes something the player can perceive, the reply must reflect it. Silence after a tool call is a bug.

TOOL-FIRST RULE: Every game effect you describe must be enacted via the corresponding tool before you narrate it. The game world is the source of truth — narrate ONLY what the tool result confirms.
  • Weapon throw → call throw_item (removes item from inventory, resolves attack).
  • Spell cast (player) → call cast_spell with the spell id from the player's prepared/cantrip list shown in CURRENT STATE. Routes through the engine resolver: consumes Action / Bonus Action per the spell's casting time, decrements the matching spell slot for L1+ spells, applies damage / saves / conditions. NEVER simulate a spell cast with request_attack_roll + adjust_npc_hp — it bypasses slot tracking and action economy.
  • Damage to the player or any NPC → call adjust_npc_hp (entity: "player", "enemy_A", "ally_A", or "npc_[id]"). When request_attack_roll reports a HIT or CRITICAL HIT against a creature, you MUST immediately follow up with adjust_npc_hp using the damage amount from the result — request_attack_roll does not apply damage automatically.
  • ANY creature movement on the map — the player, an ally, a neutral NPC, an enemy — must be enacted with move_entity BEFORE you narrate it. This covers walking across a bridge, stepping aside, crossing a room, fleeing a few tiles, climbing onto something, repositioning to safety, going to investigate something, taking cover, joining the player, peeling off — anything that changes a token's tile. The player can see the token; narrating "she crosses the bridge" without calling move_entity leaves a token frozen mid-scene and breaks immersion immediately. If the destination is off the current map (an NPC leaves the encounter entirely), use despawn_npc instead. If no tool can place them where the fiction requires, change the fiction — don't lie about the token.
  • Gold gained or spent → call award_gold (negative amount for spending). Never narrate a gold transaction without the tool confirming it.
  • Item gained or lost → call add_item or remove_item.
  • Condition applied or removed → call apply_condition or remove_condition.
  • Creature disposition change → call set_disposition. If you change any NPC to "enemy" disposition while the phase is "exploring", you MUST call trigger_combat immediately after all disposition changes are complete — set_disposition does not start combat on its own.
  • Stealth change → call set_player_hidden.
  • Anything noteworthy during combat → call add_log_entry so it appears in the combat log.
  • NPC departure, fleeing, or leaving the scene → call despawn_npc to remove them from the map, or move_entity to reposition them. Never narrate an NPC as gone unless the tool confirms it.
  • NPC says their name → call reveal_npc_name with the entity ref from CURRENT STATE BEFORE writing any dialogue that contains the name. Skipping the tool leaves the game world unaware of the name regardless of what you narrate.
  • Player tells an ally to stay back, not fight, or stand down → call set_npc_passive (passive: true). Call set_npc_passive (passive: false) if the player later asks the ally to fight. A passive ally skips their combat turn automatically — do not narrate them acting or attacking.
If you cannot enact an effect with the available tools, do not narrate it as happening.

ACTION ECONOMY: During the player's turn, each character has one Action and one Bonus Action per round. Action-consuming activities: attack, throw_item, dash, dodge, disengage, cast a spell, study, influence, utilize, hide (default — see exception below). Bonus-action-consuming activities: second wind, drink potion (in combat), hide IF the character is a Rogue of level 2+ (Cunning Action). A Level 1 Rogue's Hide still costs the Action. Server enforces these strictly.

CURRENT STATE shows the player's action economy as literal fields: "Action: AVAILABLE" or "Action: USED", "Bonus: AVAILABLE" or "Bonus: USED", and "N moves left". These fields are AUTHORITATIVE for the current turn — they reset every time a new player turn begins (you will see a line like "── Aldric's turn — Action & Bonus refreshed ──" in RECENT COMBAT LOG marking each transition). Do not infer from conversation history that the player has already acted this turn; only the current flags matter. If "Action: AVAILABLE" is shown, the action IS available — do not refuse it.

NO MECHANICAL TEXT IN STORY MODE: The action-economy flags are a private cue for YOU to know what to allow, not something to recite to the player. The UI's Player Panel already shows action/bonus/movement state. NEVER write phrases like "Your action is spent", "Your Action is used this turn", "You still have your Bonus Action available", "You have N moves left", "Your action economy is depleted", "You can use Second Wind, or you can end your turn", "feel free to move or end your turn" — or any equivalent that names a resource, button, or rules concept. Likewise never coach the player on what they CAN do mechanically next. Mechanical guidance lives in the Player Panel; your prose carries story only.

After a successful action: narrate the in-fiction outcome and stop. Do not add a coda telling the player what they spent or have left.

When the player REQUESTS something the current flags forbid: refuse IN-FICTION without naming the resource, the rule, or the button. The player reads the panel for numbers; they read story from you. Examples (the desired flavour — not a script):
  • Player asks to attack again while Action is USED: *"Your sword won't be back in line until you draw another breath — you've already committed to your swing this round."*
  • Player asks for Second Wind while Bonus is USED: *"You've already pulled what reserves you can muster this moment — there's nothing more left to call on until the fight turns."*
  • Player asks to move further with 0 moves left: *"Your feet are planted; you've pressed as far as this exchange allows."*

If a tool you call returns an "already spent" or "not performed" message, relay it the same way — translate to in-world cause and effect, never repeat the mechanical terminology.

TURN ORDER: When PHASE is "player_turn", the player acts first — do NOT narrate or simulate enemy turns. Never say "It is now [enemy]'s turn" or describe enemies attacking or moving on their own turns. The combat engine resolves enemy AI automatically when the player ends their turn. You may describe enemies reacting to the player's action (flinching, snarling, drawing a weapon), but stop there.

SEARCHING CORPSES: When the player searches a body, corpse, or dead creature, always call request_ability_check (skill: "perception", DC 10 for a straightforward search, DC 15 if items are concealed in clothing or hidden pouches) before narrating what is found. Use "investigation" only for tasks that require deduction or study — clues, written documents, traps, hidden mechanisms — not for rifling through pockets. On a success, describe what the player finds and use add_item or award_gold to deliver any rewards. On a failure, narrate that the player finds nothing of note — they may try again or look elsewhere.

COMBAT LOG: The RECENT COMBAT LOG in CURRENT STATE is the complete log for this encounter. If the player asks to "see", "read", or "show" the combat log, direct them to the Combat Log panel in their UI — it has better formatting than anything you can narrate.

WORLD GROUNDING: Only reference creatures, items, and events that exist in CURRENT STATE or have been established in this conversation. Never invent NPCs, companions, or off-screen events that are not reflected in the game state. If no creature fled or was despawned, no creature fled. Do not assert specific physical details about creatures (embedded weapons, wounds, clothing) that are not tracked in CURRENT STATE — the game state tracks HP and conditions only; everything else is unknown.

STATE IS AUTHORITATIVE: CURRENT STATE is always the ground truth. If it appears to conflict with something in the conversation history, trust the current state and narrate the present moment from it — do not verbalise the inconsistency, name the CURRENT STATE block, question what happened, or attempt to reset the narrative. Never say "I need to pause", "this is inconsistent", "let me reset", or any equivalent. If the phase is "exploring" and no enemies are alive, the encounter is over — narrate that reality and respond to the player's action.

PLAYER AGENCY: The player has the right to take any action that is mechanically possible, including attacking neutral NPCs or doing things that are morally questionable in-world. You may warn the player once about likely consequences (guards arriving, reputational cost, etc.), but if they confirm or persist, enact the action immediately using the appropriate tools — do NOT refuse, repeat the warning, or add further resistance. Never use phrases like "Are you sure?", "I'd advise against…", or "Perhaps reconsider…" more than once per declared intention.

PROHIBITED — reject these and suggest a realistic in-world alternative instead:
  • add_item or spawn_enemy simply because the player requests an item or creature (they must exist in the world).
  • Any action requiring magic the player does not possess, teleportation, or instantaneous creation from nothing.

When the player attempts anything tied to a skill — Performance, Persuasion, Deception, Athletics, Stealth, Investigation, etc. — call request_ability_check. The roll determines quality and narrative colour, not just success or failure; even an action that cannot catastrophically fail still benefits from a die (a low Performance roll is an awkward tune, a high one is moving). Only skip the check for purely declarative statements ("I walk north") that involve no skill and no uncertainty.
After receiving a SUCCESS from request_ability_check, if the outcome causes a creature to surrender, flee, or change behavior, you MUST call the appropriate tools to enact that outcome (set_disposition, despawn_npc, move_entity) before narrating it — exactly as the TOOL-FIRST RULE requires. A success result alone does not change the game state.`;
}

function buildStateMessage(engine: GameEngine): string {
  const s = engine.getState();
  const p = s.player;

  // Explicit AVAILABLE/USED rather than absence-implies-available — the model
  // hallucinates "you already acted" otherwise, pattern-matching on conversation
  // history. Showing the resource state as a literal field removes ambiguity.
  const slotsLine = p.spellSlots.length > 0
    ? p.spellSlots.map((n, i) => n > 0 ? `L${i + 1}:${n}` : '').filter(Boolean).join(',')
    : '';
  const flags = [
    p.conditions.includes('hidden') ? 'HIDDEN' : '',
    s.phase === 'player_turn' ? `Action: ${p.actionUsed ? 'USED' : 'AVAILABLE'}` : '',
    s.phase === 'player_turn' ? `Bonus: ${p.bonusActionUsed ? 'USED' : 'AVAILABLE'}` : '',
    s.phase === 'player_turn' ? `${p.movesLeft} moves left` : '',
    ...Object.entries(p.resources)
      .filter(([, n]) => n > 0)
      .map(([id, n]) => `${id} ×${n}`),
    slotsLine ? `Slots ${slotsLine}` : '',
    p.concentratingOn ? `Concentrating: ${p.concentratingOn}` : '',
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
          // Reactions refresh at the start of each creature's own turn. USED
          // means this creature has spent its Reaction (e.g. an Opportunity
          // Attack against the player or another NPC) and cannot take another
          // until its next turn comes around.
          s.phase !== 'exploring' ? `Reaction: ${n.reactionUsed ? 'USED' : 'AVAILABLE'}` : '',
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

  const itemIds = engine.getItemIds().join(', ');
  const monsterIds = engine.getMonsterIds().join(', ');

  // Scripted events authored on the encounter (via TriggerSystem's
  // `send_aidm_message` action). Surfaced here so Claude can weave them into
  // the next reply. The server clears `pendingAidmEvents` once the API call
  // returns successfully.
  const scriptedEvents = s.pendingAidmEvents.length > 0
    ? `\nSCRIPTED EVENTS (incorporate into your next reply, then they are cleared):\n${s.pendingAidmEvents.map((m) => `  • ${m}`).join('\n')}\n`
    : '';

  // Faction standings + rumors — long-term world memory. Helps the DM remember
  // who likes the player and what the world has heard about.
  const factionLines = Object.entries(s.factionStandings).filter(([, v]) => v !== 0);
  const factionsBlock = factionLines.length > 0
    ? `\nFACTION STANDINGS (player's reputation, −100..+100):\n${factionLines.map(([id, v]) => `  ${id}: ${v >= 0 ? '+' : ''}${v}`).join('\n')}\n`
    : '';
  const rumorsBlock = s.rumors.length > 0
    ? `\nRUMORS (world memory, newest first — reference when narratively apt):\n${[...s.rumors].sort((a, b) => b.recordedAt - a.recordedAt).slice(0, 8).map((r) => `  • [${r.id}] (sal ${r.salience}) ${r.text}`).join('\n')}\n`
    : '';

  return `SETTING: ${s.mapName} | PHASE: ${s.phase} | ENCOUNTER: ${s.encounterTypes.join(', ')}
CONTEXT: ${s.encounterContext}${scriptedEvents}${factionsBlock}${rumorsBlock}

PLAYER: tile (${p.tileX},${p.tileY}) · HP ${p.hp} · ${p.gold} GP · ${flags || 'no flags'}
  Inventory: ${p.inventoryIds.join(', ') || 'empty'}
  Equipped: armor=${p.equippedSlots.armorId ?? 'none'} weapon=${p.equippedSlots.weaponId ?? 'none'} shield=${p.equippedSlots.shieldId ?? 'none'}
  ${p.preparedSpellIds.length > 0 ? `Prepared spells: ${p.preparedSpellIds.join(', ')}` : ''}
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

REFERENCE DATA (valid IDs for add_item / spawn_enemy):
  ITEMS: ${itemIds}
  MONSTERS: ${monsterIds}

RECENT COMBAT LOG:
  ${recentLog}`;
}

export async function processAIDMChat(
  engine: GameEngine,
  body: AIDMChatRequest,
  anthropic: Anthropic,
  history: AidmMessage[],
  archive?: AidmMessage[],   // full unsummarized history; consumed by D (memory tool)
  streamCallbacks?: AIDMStreamCallbacks,
): Promise<{ reply: string; events: GameEvent[]; rollResults: string[] }> {
  const s = engine.getState();

  // Seed history with introduction on the first exchange so Claude has narrative context.
  // Anthropic requires conversations to start with a user message, so pair it with a prompt.
  if (history.length === 0 && s.introduction) {
    history.push({ role: 'user', content: 'Begin the encounter.' });
    history.push({ role: 'assistant', content: s.introduction });
  }

  // Reset per-turn guards (e.g. award_xp / complete_quest double-credit detection).
  resetTurnGuards();

  // D. Bound the working history. If it exceeds the threshold, summarize the
  // oldest pairs into a single [SUMMARY] assistant turn. The archive remains
  // intact for the recall_memory tool to search.
  await maybeSummarizeHistory(history, anthropic);

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

  // Send the system prompt as a content-block array with a cache_control marker
  // so Anthropic's prompt cache (5-minute TTL) covers the static instructions and
  // tool list across turns. The dynamic CURRENT STATE block lives in the user
  // message and is not cached.
  const system = [
    {
      type: 'text' as const,
      text: buildStaticPrompt(body.dmPersona ?? 'story'),
      cache_control: { type: 'ephemeral' as const },
    },
  ];
  const rawTools = engine.getAIDMTools();
  // Mark the last tool's input_schema with cache_control so the entire tools
  // block is treated as cacheable prefix material.
  const tools = rawTools.map((t, i) =>
    i === rawTools.length - 1
      ? { ...t, cache_control: { type: 'ephemeral' as const } }
      : t,
  );
  const allEvents: GameEvent[] = [];
  const rollResults: string[] = [];
  let narrativeText = '';

  const model = body.dmPersona === 'dev' ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-6';

  // Tools whose result is unknown until the server rolls — text written alongside
  // these is speculative and must not be shown to the player.
  const SPECULATIVE_TOOLS = new Set([
    'request_attack_roll', 'request_ability_check', 'request_saving_throw',
  ]);

  // A. Cap loop iterations so a degenerate tool chain can't run away.
  const MAX_TOOL_ITERATIONS = 8;

  // E. Streaming: track whether the currently-streaming response's chunks are
  // speculative (i.e. accompany a roll-tool). Chunks are forwarded eagerly to
  // the client; we only learn it was speculative when the response completes.
  // If so, we tell the client to discard them via onSpeculativeDiscard.
  let currentResponseEmittedChunks = false;
  const onChunkForward = streamCallbacks?.onChunk
    ? (text: string) => {
        currentResponseEmittedChunks = true;
        streamCallbacks.onChunk!(text);
      }
    : undefined;

  let response = await callClaudeWithRetry(anthropic, { model, max_tokens: 600, system, tools, messages }, onChunkForward);
  let iteration = 0;

  while (true) {
    // Capture any narrative text from this response. Skip the text only if this
    // response also calls a roll-requesting tool — in that case the text is a
    // guess written before the roll result is known.
    const hasSpeculativeTool = response.content.some(
      (b) => b.type === 'tool_use' && SPECULATIVE_TOOLS.has(b.name),
    );
    if (!hasSpeculativeTool) {
      for (const block of response.content) {
        if (block.type === 'text' && block.text) {
          if (narrativeText && !narrativeText.endsWith('\n')) narrativeText += '\n';
          narrativeText += block.text;
        }
      }
      // Tell the client: these chunks are canonical — advance the discard baseline.
      if (currentResponseEmittedChunks) streamCallbacks?.onCheckpoint?.();
    } else if (currentResponseEmittedChunks) {
      // Roll back the speculative chunks on the client.
      streamCallbacks?.onSpeculativeDiscard?.();
    }
    currentResponseEmittedChunks = false;

    if (response.stop_reason !== 'tool_use') break;

    iteration++;
    const overBudget = iteration >= MAX_TOOL_ITERATIONS;

    const toolResults: { type: 'tool_result'; tool_use_id: string; content: string; cache_control?: { type: 'ephemeral' } }[] = [];
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        let content: string;
        let rollResult: string | undefined;
        if (overBudget) {
          // A. On the last allowed iteration, override every tool with a budget-exhausted
          // signal. This forces the model to finalize its reply instead of looping further.
          content = 'TOOL BUDGET EXHAUSTED. Do not call any more tools this turn. Write the final narrative reply to the player now, summarising the actions you have already taken.';
        } else {
          const toolCtx: AIDMToolContext = { archive };
          const result = applyAIDMTool(engine, block.name, block.input as Record<string, unknown>, toolCtx);
          allEvents.push(...result.events);
          content = result.toolResultContent;
          rollResult = result.rollResult;
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content });
        if (rollResult) rollResults.push(rollResult);
      }
    }

    // N. Cache breakpoint on the most-recent tool_result block. The previous
    // assistant turn + this tool_result become the new cacheable prefix on the
    // next iteration, so a long tool chain doesn't re-pay all preceding tokens.
    if (toolResults.length > 0) {
      toolResults[toolResults.length - 1].cache_control = { type: 'ephemeral' };
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });

    // C. Rebuild CURRENT STATE on the most-recent user message (the original
    // turn user message) — the model should reason from fresh state each loop.
    refreshStateInMessages(messages, engine, body.playerMessage);

    if (overBudget) {
      // Force the model to stop calling tools by removing the tool definitions
      // for the final response. We still need to issue a request so the model
      // can produce its closing narrative.
      response = await callClaudeWithRetry(anthropic, { model, max_tokens: 600, system, tools: [], messages }, onChunkForward);
      // One more pass through the loop to capture text, then break.
      const finalText = response.content
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text).join('');
      if (finalText) {
        if (narrativeText && !narrativeText.endsWith('\n')) narrativeText += '\n';
        narrativeText += finalText;
      }
      if (!narrativeText.trim()) {
        narrativeText = '(The Dungeon Master pauses, gathering their thoughts.)';
      }
      break;
    }

    response = await callClaudeWithRetry(anthropic, { model, max_tokens: 600, system, tools, messages }, onChunkForward);
  }

  // Scripted events were folded into this reply — clear them so they aren't
  // re-injected on the next turn.
  engine.getState().pendingAidmEvents.length = 0;

  // Persist the exchange into server-side history (clean user/assistant pairs only).
  history.push({ role: 'user', content: currentUserContent });
  history.push({ role: 'assistant', content: narrativeText.trim() });

  // D. Append to the archive too — the archive is what recall_memory searches.
  if (archive) {
    archive.push({ role: 'user', content: currentUserContent });
    archive.push({ role: 'assistant', content: narrativeText.trim() });
  }

  return { reply: narrativeText.trim(), events: allEvents, rollResults };
}

/**
 * Rebuilds the [CURRENT STATE] block on the last user message that contains
 * a fresh CURRENT STATE marker (the original turn message — tool_result
 * messages are arrays and skipped). Called between tool-loop iterations.
 */
function refreshStateInMessages(
  messages: { role: 'user' | 'assistant'; content: unknown }[],
  engine: GameEngine,
  playerMessage: string,
): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user' || typeof m.content !== 'string') continue;
    if (!m.content.startsWith('[CURRENT STATE]')) continue;
    m.content = `[CURRENT STATE]\n${buildStateMessage(engine)}\n\n[PLAYER]\n${playerMessage}`;
    return;
  }
}

/**
 * I. Retry transient Anthropic errors (network failures, 429, 5xx) once with
 * a short backoff. Non-transient errors (400 schema mismatches, auth) are
 * re-thrown immediately.
 */
/**
 * D. Sliding-window history summarization.
 *
 * Keeps the working `history` array bounded. When it grows past
 * HISTORY_WINDOW_THRESHOLD messages, summarizes the oldest SUMMARIZE_BATCH
 * messages into a single [SUMMARY] assistant turn via Haiku and replaces
 * them in place. The first entry is preserved if it's the seeded
 * "Begin the encounter." / introduction pair so opening context is kept.
 *
 * The full archive (`aidmArchive` in sessions.ts) is untouched and remains
 * searchable via the recall_memory tool.
 */
const HISTORY_WINDOW_THRESHOLD = 40;   // total messages (user + assistant)
const HISTORY_TRIM_TARGET      = 20;   // keep this many recent messages after summarizing
const SUMMARY_PREFIX           = '[SUMMARY OF EARLIER TURNS]';

async function maybeSummarizeHistory(history: AidmMessage[], anthropic: Anthropic): Promise<void> {
  if (history.length <= HISTORY_WINDOW_THRESHOLD) return;

  // Determine the slice to summarize. Always keep the last HISTORY_TRIM_TARGET messages
  // verbatim; collapse everything before into a single summary.
  const tailStart = history.length - HISTORY_TRIM_TARGET;
  const toSummarize = history.slice(0, tailStart);
  if (toSummarize.length === 0) return;

  // If the head is already a summary, fold it in; otherwise summarize from scratch.
  const transcript = toSummarize.map((m) => {
    let content = m.content;
    // Strip CURRENT STATE blocks from prior user messages — they are stale snapshots.
    const stripped = /\[PLAYER\]\n([\s\S]+)$/.exec(content);
    if (stripped) content = stripped[1].trim();
    return `${m.role === 'user' ? 'PLAYER' : 'DM'}: ${content}`;
  }).join('\n\n');

  let summaryText: string;
  try {
    const res = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: `You summarize a section of a D&D encounter transcript into a compact recap. Preserve: NPC names revealed, quest hooks, promises made or broken, items gained or lost, important player choices, current relationships and dispositions, and any unresolved threads. Drop: tactical combat detail (specific HP numbers, individual dice rolls, mechanical minutiae). Write 4-8 dense bullet points in past tense. No preamble — output bullets only.`,
      messages: [{ role: 'user', content: `Summarize the following encounter transcript:\n\n${transcript}` }],
    });
    const block = res.content.find((b) => b.type === 'text');
    summaryText = block && block.type === 'text' ? block.text.trim() : '';
  } catch {
    // If summarization fails, fall back to a trivial heuristic so the loop still bounds.
    summaryText = `Encounter so far covered ${Math.floor(toSummarize.length / 2)} earlier exchanges. Detail is preserved in the recall_memory archive.`;
  }
  if (!summaryText) {
    summaryText = `Earlier exchanges (${Math.floor(toSummarize.length / 2)}) are preserved in the recall_memory archive.`;
  }

  // Anthropic API requires conversation to start with a user message. The summary
  // is delivered as an assistant message preceded by a synthetic user prompt.
  const newHead: AidmMessage[] = [
    { role: 'user', content: 'Continue the encounter — what has happened so far is summarised below.' },
    { role: 'assistant', content: `${SUMMARY_PREFIX}\n${summaryText}` },
  ];

  history.splice(0, tailStart, ...newHead);
}

/**
 * E + I. Stream a Claude response, forwarding text deltas to onChunk as they
 * arrive. Returns the assembled final Message — same shape the non-streaming
 * create() would produce. Retries once on transient errors (429/5xx).
 *
 * The caller is responsible for issuing a speculative-discard signal if the
 * completed response turns out to contain a roll-requesting tool (the streamed
 * text was speculative).
 */
async function callClaudeWithRetry(
  anthropic: Anthropic,
  params: {
    model: string;
    max_tokens: number;
    system: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
    tools: unknown[];
    messages: unknown[];
  },
  onChunk?: (text: string) => void,
): Promise<Anthropic.Messages.Message> {
  const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 529]);
  const RETRY_DELAY_MS = 600;

  const runOnce = async (): Promise<Anthropic.Messages.Message> => {
    const stream = anthropic.messages.stream(params as Parameters<typeof anthropic.messages.stream>[0]);
    if (onChunk) stream.on('text', (delta) => { if (delta) onChunk(delta); });
    return await stream.finalMessage();
  };

  try {
    return await runOnce();
  } catch (err) {
    const status = (err as { status?: number }).status;
    const isTransient = status !== undefined && TRANSIENT_STATUSES.has(status);
    if (!isTransient) throw err;
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    return await runOnce();
  }
}
