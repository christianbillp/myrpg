import { GameEngine } from './GameEngine.js';
import { GameEvent } from './types.js';

export interface AIGMToolResult {
  // GameEvent[] only carries client-facing animation signals (e.g. entity_move).
  // Most tools return [] because their state changes are picked up by the full
  // state snapshot pushed over WebSocket. Only move_entity meaningfully emits
  // events today; others may extend this if they need bespoke client animations.
  events: GameEvent[];
  toolResultContent: string;
  rollResult?: string;
}

/** Side-channel context that some tools need (e.g. recall_memory). */
export interface AIGMToolContext {
  archive?: { role: 'user' | 'assistant'; content: string }[];
}

// The tool list is fully static — content/IDs live in CURRENT STATE so the
// tools block stays cache-stable even when JSON definitions change.
export function buildAIGMTools() {
  return buildToolList();
}

// IMPORTANT: tool array order is part of the cacheable prompt prefix. Append new
// tools at the END only — reordering or inserting in the middle invalidates the
// Anthropic prompt cache and every following turn pays a cache miss until rewarm.
function buildToolList() { return [
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
    name: 'adjust_npc_hp',
    description: 'Adjust any combatant\'s HP by a delta. Positive heals, negative damages. Entity: "player", "enemy_A" (enemy by uppercase combat label A–Z), "ally_A" (ally by uppercase combat label — same A–Z pool), or "npc_[id]" (neutral NPC, or any NPC by id). To kill, use a large negative delta. Optionally supply damage_type (e.g. "fire", "poison", "piercing") so resistance, vulnerability, and immunity are applied automatically.',
    input_schema: { type: 'object' as const, properties: { entity: { type: 'string' }, delta: { type: 'integer' }, damage_type: { type: 'string' }, reason: { type: 'string' } }, required: ['entity', 'delta', 'reason'] },
  },
  {
    name: 'add_log_entry',
    description: 'Add a narrative entry to the event log without changing game state.',
    input_schema: { type: 'object' as const, properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'move_entity',
    description: 'Teleport an entity to a tile. Entity: "player", "enemy_A" (enemy by label), "ally_A" (ally by combat label), or "npc_[id]" (any NPC by id).',
    input_schema: { type: 'object' as const, properties: { entity: { type: 'string' }, tile_x: { type: 'integer' }, tile_y: { type: 'integer' }, reason: { type: 'string' } }, required: ['entity', 'tile_x', 'tile_y', 'reason'] },
  },
  {
    name: 'add_item',
    description: 'Give the player an item. Valid item_id values are listed in CURRENT STATE under REFERENCE DATA → ITEMS.',
    input_schema: { type: 'object' as const, properties: { item_id: { type: 'string' }, reason: { type: 'string' } }, required: ['item_id', 'reason'] },
  },
  {
    name: 'remove_item',
    description: "Remove one instance of an item from the player's inventory.",
    input_schema: { type: 'object' as const, properties: { item_id: { type: 'string' }, reason: { type: 'string' } }, required: ['item_id', 'reason'] },
  },
  {
    name: 'despawn_npc',
    description: 'Remove an NPC from the map. Entity: "npc_[id]".',
    input_schema: { type: 'object' as const, properties: { entity: { type: 'string' }, reason: { type: 'string' } }, required: ['entity', 'reason'] },
  },
  {
    name: 'spawn_enemy',
    description: 'Spawn a new enemy on the map. Valid monster_id values are listed in CURRENT STATE under REFERENCE DATA → MONSTERS.',
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
    name: 'apply_condition',
    description: 'Apply a condition to the player or an NPC. Entity: "player", "enemy_A" (by label), "ally_A" (by combat label), or "npc_[id]" (any NPC by id). Common conditions: blinded, charmed, frightened, grappled, incapacitated, paralyzed, poisoned, prone, restrained, stunned.',
    input_schema: { type: 'object' as const, properties: { entity: { type: 'string' }, condition: { type: 'string' }, reason: { type: 'string' } }, required: ['entity', 'condition', 'reason'] },
  },
  {
    name: 'remove_condition',
    description: 'Remove a condition from the player or an NPC.',
    input_schema: { type: 'object' as const, properties: { entity: { type: 'string' }, condition: { type: 'string' }, reason: { type: 'string' } }, required: ['entity', 'condition', 'reason'] },
  },
  {
    name: 'request_ability_check',
    description: "Ask the player to make an ability check. The server rolls d20 + the relevant skill modifier automatically. Set DC using SRD guidelines: Very Easy 5, Easy 10, Medium 15, Hard 20, Very Hard 25.",
    input_schema: { type: 'object' as const, properties: { skill: { type: 'string' }, dc: { type: 'integer' }, reason: { type: 'string' } }, required: ['skill', 'dc', 'reason'] },
  },
  {
    name: 'set_disposition',
    description: 'Change an NPC\'s disposition. Entity: "enemy_A" (by label), "ally_A" (by combat label), or "npc_[id]" (any NPC by id). Disposition: "ally" (fights alongside the player), "neutral" (does not participate in combat), "enemy" (fights the player).',
    input_schema: { type: 'object' as const, properties: { entity: { type: 'string' }, disposition: { type: 'string' }, reason: { type: 'string' } }, required: ['entity', 'disposition', 'reason'] },
  },
  {
    name: 'throw_item',
    description: 'Throw an item at a target. Proper thrown weapons (javelin, dagger) use their weapon stats and mastery with proficiency. All other items are improvised weapons (1d4 bludgeoning, no proficiency bonus). The item is removed from the player\'s inventory or the map. item_id can be an inventory item id or a map item defId. target uses the same entity ref format as move_entity: "enemy_A" / "ally_A" by combat label, or "npc_[id]" by id; omit to auto-target the nearest enemy in range. Attacking a neutral NPC turns them hostile.',
    input_schema: { type: 'object' as const, properties: { item_id: { type: 'string' }, target: { type: 'string' }, reason: { type: 'string' } }, required: ['item_id', 'reason'] },
  },
  {
    name: 'cast_spell',
    description: 'Cast a player spell from the player\'s known/prepared list. Drives the generic spell resolver: attack-roll spells (Fire Bolt, Ray of Frost, Magic Missile) consume the Action and an L1+ slot (if leveled), roll vs target AC, deal damage; save-based AOE spells (Burning Hands, Sleep) ask each creature in the area to save; utility spells (Mage Armor, Detect Magic) apply lasting effects. Cantrips spend no slot; levelled spells spend one slot of `spell.level`. Action economy is enforced — if the player\'s Action is already spent, action-cost spells are refused. target_id uses entity ref format ("enemy_A", "ally_A", "npc_[id]"); omit for self/AOE spells. slot_level defaults to spell.level; upcasting (slot_level > spell.level) is supported for levelled spells.',
    input_schema: { type: 'object' as const, properties: { spell_id: { type: 'string' }, target_id: { type: 'string' }, slot_level: { type: 'integer' }, reason: { type: 'string' } }, required: ['spell_id', 'reason'] },
  },
  {
    name: 'request_saving_throw',
    description: 'Ask the player to make a saving throw. The server rolls d20 + the relevant saving throw modifier automatically. Active conditions are applied: paralyzed/unconscious auto-fail Str/Dex saves; Dodge grants advantage on Dex saves; restrained imposes disadvantage on Dex saves. Use ability names: "str", "dex", "con", "int", "wis", "cha". Set DC using SRD guidelines: Very Easy 5, Easy 10, Medium 15, Hard 20, Very Hard 25.',
    input_schema: { type: 'object' as const, properties: { ability: { type: 'string' }, dc: { type: 'integer' }, reason: { type: 'string' } }, required: ['ability', 'dc', 'reason'] },
  },
  {
    name: 'award_temp_hp',
    description: 'Grant the player Temporary Hit Points. Temporary HP act as a buffer — damage depletes them before real HP. Per SRD, Temporary HP don\'t stack: the player keeps whichever value is higher (existing or new).',
    input_schema: { type: 'object' as const, properties: { amount: { type: 'integer' }, reason: { type: 'string' } }, required: ['amount', 'reason'] },
  },
  {
    name: 'grant_heroic_inspiration',
    description: 'Grant the player Heroic Inspiration. The player may expend it to re-roll any one die immediately after rolling. Per SRD, only one instance can be held at a time.',
    input_schema: { type: 'object' as const, properties: { reason: { type: 'string' } }, required: ['reason'] },
  },
  {
    name: 'request_attack_roll',
    description: 'Roll an attack roll for the player or an NPC against a target AC (use this for attacking objects, doors, or off-turn attacks such as opportunity attacks). attacker: "player", "enemy_A" (by label), "ally_A" (by combat label), or "npc_[id]" (any NPC by id). target_ac: the Armor Class to roll against. Returns hit/miss/critical and damage dealt.',
    input_schema: { type: 'object' as const, properties: { attacker: { type: 'string' }, target_ac: { type: 'integer' }, reason: { type: 'string' } }, required: ['attacker', 'target_ac', 'reason'] },
  },
  {
    name: 'set_exhaustion_level',
    description: 'Set the player\'s Exhaustion level (0–5). Each level imposes −2 to all D20 Tests (ability checks and saving throws). Level 5 is lethal. Per SRD: a Long Rest removes one Exhaustion level.',
    input_schema: { type: 'object' as const, properties: { level: { type: 'integer' }, reason: { type: 'string' } }, required: ['level', 'reason'] },
  },
  {
    name: 'reveal_npc_name',
    description: 'Call this when an NPC reveals their name to the player. Updates the NPC\'s map label to the revealed name and ensures continuity. entity: the full entity ref from CURRENT STATE, e.g. "npc_villager_0". revealed_name: the name the NPC gave.',
    input_schema: { type: 'object' as const, properties: { entity: { type: 'string' }, revealed_name: { type: 'string' } }, required: ['entity', 'revealed_name'] },
  },
  {
    name: 'npc_speaks',
    description: 'Show a brief speech bubble above an NPC (or the player) on the map for the line you pass. Call this **alongside** any in-fiction quote in your reply so the player can see at a glance who is speaking and where the sound is coming from — the bubble shows the same text you put between quotes in the narrative. Entity: the full ref from CURRENT STATE ("enemy_A", "ally_A", "npc_<id>", or "player"). Text: only the spoken line itself (no "she says" wrapping). Use a separate call per speaker if multiple characters speak in one reply.',
    input_schema: { type: 'object' as const, properties: { entity: { type: 'string' }, text: { type: 'string' } }, required: ['entity', 'text'] },
  },
  {
    name: 'set_npc_passive',
    description: 'Mark an ally NPC as combat-passive (passive: true) so they skip their combat turn, or remove that restriction (passive: false). Use this when the player tells an ally to stay back, not fight, or stand down. Entity: the full entity ref from CURRENT STATE, e.g. "ally_A" or "npc_commoner_0".',
    input_schema: { type: 'object' as const, properties: { entity: { type: 'string' }, passive: { type: 'boolean' }, reason: { type: 'string' } }, required: ['entity', 'passive', 'reason'] },
  },
  {
    name: 'recall_memory',
    description: 'Search the full, unsummarized conversation archive for past content matching a keyword or phrase. Use this when the sliding-window history doesn\'t contain enough detail — e.g. to look up an NPC\'s previous statements, a quest hook the player mentioned long ago, or any earlier exchange. Returns up to 8 matching message snippets (player and GM lines) with rough turn indices. The query is a case-insensitive substring match.',
    input_schema: { type: 'object' as const, properties: { query: { type: 'string' }, reason: { type: 'string' } }, required: ['query', 'reason'] },
  },
  {
    name: 'adjust_faction_standing',
    description: 'Adjust the player\'s standing with a faction by `delta` (positive = better, negative = worse). Standings are clamped to [-100, +100]. Use when an action durably shifts how a faction views the player — saving a faction member, betraying them, completing a faction quest, etc. The faction id is a free-form string; encounter authors and AIGM should use stable short ids ("bridge_bandits", "town_guard"). Surfaced to future turns in CURRENT STATE.',
    input_schema: { type: 'object' as const, properties: { faction_id: { type: 'string' }, delta: { type: 'integer' }, reason: { type: 'string' } }, required: ['faction_id', 'delta', 'reason'] },
  },
  {
    name: 'adjust_faction_relation',
    description: 'Shift the standing between any two factions by `delta` (positive = friendlier, negative = more hostile). Standings are clamped to [-100, +100]. Use when an event durably changes how two NPC groups feel about each other — e.g. the bandits and the guards reach an understanding, or the cultists declare war on the townsfolk. Mirrors to both directions by default; pass mirror=false for a one-sided shift (one faction\'s opinion moves without reciprocation). For player-faction shifts prefer adjust_faction_standing.',
    input_schema: { type: 'object' as const, properties: { faction_a: { type: 'string' }, faction_b: { type: 'string' }, delta: { type: 'integer' }, mirror: { type: 'boolean' }, reason: { type: 'string' } }, required: ['faction_a', 'faction_b', 'delta', 'reason'] },
  },
  {
    name: 'set_faction_relation',
    description: 'Set the standing between two factions to an absolute value (clamped to [-100, +100]). Use this for hard resets — e.g. forging an alliance (+80) or declaring blood feud (-100) — rather than incremental shifts (use adjust_faction_relation for those). Mirrors to both directions by default; pass mirror=false for asymmetric.',
    input_schema: { type: 'object' as const, properties: { faction_a: { type: 'string' }, faction_b: { type: 'string' }, value: { type: 'integer' }, mirror: { type: 'boolean' }, reason: { type: 'string' } }, required: ['faction_a', 'faction_b', 'value', 'reason'] },
  },
  {
    name: 'reveal_faction',
    description: 'Mark a faction as identified by the player — from now on the Target Panel will render its name instead of "???" for every member. Use when the player learns who a group really is through dialogue, finding a sigil, an obvious uniform, etc. Idempotent: a second call with the same factionId is a no-op.',
    input_schema: { type: 'object' as const, properties: { faction_id: { type: 'string' }, reason: { type: 'string' } }, required: ['faction_id', 'reason'] },
  },
  {
    name: 'create_rumor',
    description: 'Record a significant world event into long-term world memory. Use when something happens that NPCs in this world would plausibly hear about and reference later — a public defeat, a saved village, a treaty signed. The `id` is a stable short slug used by triggers; `text` is the human-readable summary the GM can reference; `salience` is 1–10 (default 5) where 10 = "everyone is talking about it." Idempotent: a second call with the same id is ignored.',
    input_schema: { type: 'object' as const, properties: { id: { type: 'string' }, text: { type: 'string' }, salience: { type: 'integer' }, reason: { type: 'string' } }, required: ['id', 'text', 'reason'] },
  },
  {
    name: 'set_world_flag',
    description: 'Write a value to `GameState.worldFlags[name]`. Use when a narrative resolution needs to influence encounter triggers — e.g. the player pays a toll and a "toll_paid" flag should prevent an ambush trigger from firing later. Values are booleans, numbers, or short strings. Triggers read these via `flag_set` / `flag_unset` / `flag_equals` guards. The flag is persisted with the world save.',
    input_schema: { type: 'object' as const, properties: { name: { type: 'string' }, value: { }, reason: { type: 'string' } }, required: ['name', 'value', 'reason'] },
  },
  {
    name: 'fade_screen',
    description: 'Fade the entire game screen (map + every UI panel) to or from black. Three modes — `"out"` fades to full black, `"in"` fades back to clear, `"dim"` fades to a 50% black overlay (atmospheric dim where the world is still visible underneath). Use for cinematic scene transitions — time-jumps, travel montages, dramatic reveals — and pair with show_supertitle / show_announcement between a fade-out and fade-in so the message lands against the black. The fade is sticky: a `mode: "out"` or `mode: "dim"` call leaves the overlay in place until a matching `mode: "in"` call (or the next chapter advance / long rest). `duration_ms` defaults to 1200 if omitted.',
    input_schema: { type: 'object' as const, properties: { mode: { type: 'string', enum: ['in', 'out', 'dim'] }, duration_ms: { type: 'integer' }, reason: { type: 'string' } }, required: ['mode', 'reason'] },
  },
  {
    name: 'show_supertitle',
    description: 'Display a movie-style location title — huge bold white text centred on screen for a few seconds. Use sparingly to mark significant location or time changes (entering a new region, "Three Days Later", chapter-style cards). Pair with fade_screen for dramatic reveals. `duration_ms` controls the hold time (the fade-in and fade-out are added on top); defaults to 3000 if omitted.',
    input_schema: { type: 'object' as const, properties: { text: { type: 'string' }, duration_ms: { type: 'integer' }, reason: { type: 'string' } }, required: ['text', 'reason'] },
  },
  {
    name: 'show_announcement',
    description: 'Display a large centred announcement card. The text is ALSO appended to the Event Log so the message persists after the visual fades. Use add_log_entry for routine log lines that do not need an attention-grabbing card.\n\n`mode` controls how the announcement integrates with play:\n  - `"focused"` (default) — orange-bordered card; the Player Panel, Target Panel, and HUD are hidden; player movement and actions are locked; world-tick is paused for the duration. Use for important beats the player MUST stop and read (quest reveal, major discovery).\n  - `"unfocused"` — borderless card with soft edge-fade; UI stays, world keeps ticking, player keeps playing. Use for atmospheric flavour (weather shift, distant thunder, time-of-day change).\n\n`duration_ms` defaults to 3500 if omitted.',
    input_schema: { type: 'object' as const, properties: { text: { type: 'string' }, duration_ms: { type: 'integer' }, mode: { type: 'string', enum: ['focused', 'unfocused'] }, reason: { type: 'string' } }, required: ['text', 'reason'] },
  },
]; }

// Tracks quests force-completed within a single AIGM turn so that subsequent
// award_xp calls in the same turn can detect and reject double-credit attempts.
// Reset between turns by callers (see resetTurnGuards).
let questsCompletedThisTurn = new Set<string>();
let xpAwardedThisTurnFromQuests = 0;

export function resetTurnGuards(): void {
  questsCompletedThisTurn = new Set();
  xpAwardedThisTurnFromQuests = 0;
}

export function applyAIGMTool(
  engine: GameEngine,
  name: string,
  input: Record<string, unknown>,
  ctx: AIGMToolContext = {},
): AIGMToolResult {
  let events: GameEvent[] = [];
  let toolResultContent = 'Applied.';
  let rollResult: string | undefined;

  switch (name) {
    case 'adjust_player_hp': {
      const delta = input['delta'] as number;
      const before = engine.getState().player.hp;
      events = engine.adjustPlayerHp(delta);
      const s = engine.getState();
      toolResultContent = `Player HP ${before} → ${s.player.hp} (${delta >= 0 ? '+' : ''}${delta}).`;
      if (s.phase === 'death_saves') toolResultContent += ' Player is now Unconscious — death saves required.';
      if (s.phase === 'defeat') toolResultContent += ' Player has been defeated.';
      break;
    }
    case 'award_xp': {
      const amount = input['amount'] as number;
      // Guard: if the AIGM already collected XP this turn via complete_quest,
      // refuse direct award_xp calls — those would double-credit the player.
      if (questsCompletedThisTurn.size > 0 && amount > 0) {
        toolResultContent = `award_xp rejected — you already granted ${xpAwardedThisTurnFromQuests} XP this turn via complete_quest for: ${[...questsCompletedThisTurn].join(', ')}. Quest rewards are awarded automatically; do not also call award_xp for the same outcome.`;
        break;
      }
      events = engine.awardXp(amount);
      toolResultContent = `Awarded ${amount} XP. Total XP: ${engine.getState().player.xp}.`;
      break;
    }
    case 'award_gold': {
      const amount = input['amount'] as number;
      if (amount < 0 && engine.getState().player.gold + amount < 0) {
        toolResultContent = `Transaction rejected: player only has ${engine.getState().player.gold} GP and cannot pay ${Math.abs(amount)} GP. Do not narrate this payment as successful — inform the player they cannot afford it.`;
      } else {
        events = engine.awardGold(amount);
        const s = engine.getState();
        toolResultContent = `${amount >= 0 ? '+' : ''}${amount} GP. Player now has ${s.player.gold} GP.`;
      }
      break;
    }
    case 'adjust_npc_hp': {
      // Compute the result from before/after state directly — never slice the
      // event log, which may contain unrelated entries (quest fires, etc.).
      const entity = input['entity'] as string;
      const delta = input['delta'] as number;
      const damageType = input['damage_type'] as string | undefined;
      const stateBefore = engine.getState();

      if (entity === 'player') {
        const beforeHp = stateBefore.player.hp;
        events = engine.adjustPlayerHp(delta);
        const afterState = engine.getState();
        const afterHp = afterState.player.hp;
        toolResultContent = `Player HP ${beforeHp} → ${afterHp} (${delta >= 0 ? '+' : ''}${delta}).`;
        if (afterState.phase === 'death_saves') toolResultContent += ' Player is now Unconscious — death saves required.';
        if (afterState.phase === 'defeat') toolResultContent += ' Player has been defeated.';
        break;
      }

      const npcBefore = stateBefore.npcs.find((n) => {
        if (entity.startsWith('enemy_')) return n.combatLabel === entity.slice(6) && n.disposition === 'enemy';
        if (entity.startsWith('ally_')) return n.combatLabel === entity.slice(5) && n.disposition === 'ally';
        if (entity.startsWith('npc_')) return n.id === entity.slice(4);
        return false;
      });
      if (!npcBefore) { toolResultContent = `${entity} not found.`; break; }

      const beforeHp = npcBefore.hp;
      const monsterDef = engine.getMonsterDef(npcBefore.defId);
      events = engine.adjustNpcHp(entity, delta, damageType);
      const afterNpc = engine.getState().npcs.find((n) => n.id === npcBefore.id);
      const afterHp = afterNpc?.hp ?? 0;

      let typeNote = '';
      if (damageType && delta < 0 && monsterDef) {
        if (monsterDef.immunities?.includes(damageType)) typeNote = ` (immune to ${damageType})`;
        else if (monsterDef.resistances?.includes(damageType)) typeNote = ` (resists ${damageType}, ×½)`;
        else if (monsterDef.vulnerabilities?.includes(damageType)) typeNote = ` (vulnerable to ${damageType}, ×2)`;
      }
      const killNote = afterHp === 0 && beforeHp > 0 ? ' — killed.' : '.';
      toolResultContent = `${npcBefore.name} HP ${beforeHp} → ${afterHp}${typeNote}${killNote}`;
      break;
    }
    case 'add_log_entry':
      engine.addLog(input['text'] as string);
      toolResultContent = `Log entry added: "${input['text']}".`;
      break;
    case 'move_entity': {
      const entity = input['entity'] as string;
      const tx = input['tile_x'] as number;
      const ty = input['tile_y'] as number;
      events = engine.moveEntity(entity, tx, ty);
      toolResultContent = events.length > 0
        ? `${entity} moved to (${tx}, ${ty}).`
        : `${entity} not found — no move performed.`;
      break;
    }
    case 'add_item': {
      const itemId = input['item_id'] as string;
      events = engine.addItem(itemId);
      toolResultContent = events.length === 0
        ? `Unknown item_id "${itemId}" — nothing added.`
        : `${itemId} added to player inventory.`;
      break;
    }
    case 'remove_item': {
      const itemId = input['item_id'] as string;
      const had = engine.getState().player.inventoryIds.includes(itemId);
      events = engine.removeItem(itemId);
      toolResultContent = had
        ? `Removed one ${itemId} from player inventory.`
        : `Player does not carry "${itemId}" — nothing removed.`;
      break;
    }
    case 'despawn_npc': {
      const entity = input['entity'] as string;
      const npcBefore = engine.getState().npcs.length;
      events = engine.despawnNpc(entity);
      const npcAfter = engine.getState().npcs.length;
      toolResultContent = npcAfter < npcBefore
        ? `${entity} removed from the map.`
        : `${entity} not found — nothing removed.`;
      break;
    }
    case 'spawn_enemy': {
      const monsterId = input['monster_id'] as string;
      const npcBefore = engine.getState().npcs.length;
      events = engine.spawnEnemy(monsterId);
      const after = engine.getState().npcs;
      const newOne = after[after.length - 1];
      toolResultContent = after.length > npcBefore && newOne
        ? `Spawned ${monsterId} at tile (${newOne.tileX}, ${newOne.tileY}) as enemy_${newOne.combatLabel}.`
        : `Could not spawn ${monsterId} (unknown id or no free tile).`;
      break;
    }
    case 'end_combat':
      events = engine.endCombat();
      toolResultContent = 'Combat ended. Phase is now "exploring".';
      break;
    case 'trigger_combat': {
      const before = engine.getState().phase;
      events = engine.triggerCombat();
      const after = engine.getState().phase;
      toolResultContent = before !== after
        ? `Combat triggered. Phase: ${before} → ${after}.`
        : 'No combat triggered (no living enemies or already in combat).';
      break;
    }
    case 'complete_quest': {
      const questId = input['quest_id'] as string;
      const q = engine.getState().quests.find((q) => q.id === questId);
      events = engine.completeQuest(questId);
      if (q) {
        questsCompletedThisTurn.add(q.title);
        xpAwardedThisTurnFromQuests += q.rewardXp;
        toolResultContent = `Quest "${q.title}" force-completed — rewards (+${q.rewardXp} XP, +${q.rewardGp} GP) granted automatically. Do NOT also call award_xp for this outcome.`;
      } else {
        toolResultContent = `Unknown quest_id "${questId}".`;
      }
      break;
    }
    case 'set_player_hidden': {
      const hidden = input['hidden'] as boolean;
      events = engine.setPlayerHidden(hidden);
      toolResultContent = `Player is now ${hidden ? 'HIDDEN' : 'visible'}.`;
      break;
    }
    case 'apply_condition': {
      const entity = input['entity'] as string;
      const condition = input['condition'] as string;
      events = engine.applyCondition(entity, condition);
      toolResultContent = `Applied condition "${condition}" to ${entity}.`;
      break;
    }
    case 'remove_condition': {
      const entity = input['entity'] as string;
      const condition = input['condition'] as string;
      events = engine.removeCondition(entity, condition);
      toolResultContent = `Removed condition "${condition}" from ${entity}.`;
      break;
    }
    case 'set_disposition': {
      const entity = input['entity'] as string;
      const disposition = input['disposition'] as string;
      events = engine.setDisposition(entity, disposition);
      toolResultContent = `${entity} disposition set to "${disposition}".`;
      if (disposition === 'enemy' && engine.getState().phase === 'exploring') {
        toolResultContent += ' Phase is still "exploring" — call trigger_combat to start the fight.';
      }
      break;
    }
    case 'throw_item': {
      const stateBeforeThrow = engine.getState();
      if (stateBeforeThrow.phase === 'player_turn' && stateBeforeThrow.player.actionUsed) {
        toolResultContent = 'Action already spent this turn — throw not performed. Inform the player their action is used and they must end their turn or use a bonus action instead.';
        break;
      }
      const logBefore = stateBeforeThrow.eventLog.length;
      events = engine.throwItem(input['item_id'] as string, input['target'] as string | undefined);
      // Filter out lines that aren't part of the throw outcome — quest progress,
      // turn-boundary markers, and quest completion can fire as side effects of
      // a kill and shouldn't be conflated with the throw result.
      const SIDE_EFFECT_PREFIXES = ['Quest complete:', 'Total XP:', '──'];
      const newEntries = engine.getState().eventLog
        .slice(logBefore)
        .filter((e) => !SIDE_EFFECT_PREFIXES.some((p) => e.left.startsWith(p)));
      toolResultContent = newEntries.map((e) => e.right ? `${e.left} [${e.right}]` : e.left).join(' | ') || 'Throw resolved.';
      break;
    }
    case 'cast_spell': {
      const stateBeforeCast = engine.getState();
      const spellId = input['spell_id'] as string;
      const targetId = input['target_id'] as string | undefined;
      const slotLevelInput = input['slot_level'] as number | undefined;
      const spell = engine.getSpellDef(spellId);
      if (!spell) { toolResultContent = `Unknown spell id "${spellId}".`; break; }
      // Action-economy pre-check so the player isn't surprised by a refused cast.
      if (stateBeforeCast.phase === 'player_turn'
          && spell.castingTime === 'action'
          && stateBeforeCast.player.actionUsed) {
        toolResultContent = `Action already spent this turn — ${spell.name} not cast. Inform the player their action is used.`;
        break;
      }
      // Resolve target entity ref → npc id (matching throw_item conventions).
      let targetIds: string[] | undefined;
      if (targetId) {
        const npc = stateBeforeCast.npcs.find((n) => {
          if (targetId.startsWith('enemy_')) return n.combatLabel === targetId.slice(6) && n.disposition === 'enemy';
          if (targetId.startsWith('ally_'))  return n.combatLabel === targetId.slice(5) && n.disposition === 'ally';
          if (targetId.startsWith('npc_'))   return n.id === targetId.slice(4);
          return n.id === targetId;
        });
        if (!npc) { toolResultContent = `cast_spell: target "${targetId}" not found.`; break; }
        targetIds = [npc.id];
      }
      const slotLevel = slotLevelInput ?? spell.level;
      const logBefore = stateBeforeCast.eventLog.length;
      events = engine.castSpell(spellId, slotLevel, targetIds);
      const SIDE_EFFECT_PREFIXES = ['Quest complete:', 'Total XP:', '──'];
      const newEntries = engine.getState().eventLog
        .slice(logBefore)
        .filter((e) => !SIDE_EFFECT_PREFIXES.some((p) => e.left.startsWith(p)));
      toolResultContent = newEntries.map((e) => e.right ? `${e.left} [${e.right}]` : e.left).join(' | ') || `${spell.name} resolved.`;
      break;
    }
    case 'request_ability_check': {
      const skill = input['skill'] as string;
      const dc = input['dc'] as number;
      const { roll, total, success } = engine.rollAbilityCheck(skill, dc);
      engine.addLog(`Ability check (${skill}): d20+mod = ${total} vs DC ${dc} — ${success ? 'Success!' : 'Failure'}`);
      toolResultContent = `Roll result: d20 + ${skill} mod = ${total} vs DC ${dc}. ${success ? 'SUCCESS' : 'FAILURE'}.`;
      rollResult = `${skill}: d20(${roll}) = ${total} vs DC ${dc} — ${success ? 'SUCCESS' : 'FAILURE'}`;
      break;
    }
    case 'request_saving_throw': {
      const ability = input['ability'] as string;
      const dc = input['dc'] as number;
      const result = engine.rollPlayerSavingThrow(ability, dc);
      if (result.autoFail) {
        engine.addLog(`Saving throw (${ability}): auto-fail — condition prevents Str/Dex saves`);
        toolResultContent = `Auto-fail: condition (paralyzed/unconscious) causes automatic failure on ${ability} saves.`;
        rollResult = `${ability} save: AUTO-FAIL vs DC ${dc}`;
      } else {
        engine.addLog(`Saving throw (${ability}): d20+mod = ${result.total} vs DC ${dc} — ${result.success ? 'Success!' : 'Failure'}`);
        toolResultContent = `Roll result: d20 + ${ability} save mod = ${result.total} vs DC ${dc}. ${result.success ? 'SUCCESS' : 'FAILURE'}.`;
        rollResult = `${ability} save: d20(${result.roll}) = ${result.total} vs DC ${dc} — ${result.success ? 'SUCCESS' : 'FAILURE'}`;
      }
      break;
    }
    case 'award_temp_hp': {
      const amount = input['amount'] as number;
      const before = engine.getState().player.tempHp;
      events = engine.awardTempHp(amount);
      const after = engine.getState().player.tempHp;
      toolResultContent = after > before
        ? `Player gained ${amount} Temp HP — now has ${after} Temp HP (kept higher per SRD).`
        : `Awarded ${amount} Temp HP, but player already has ${before} — kept the higher value.`;
      break;
    }
    case 'grant_heroic_inspiration':
      events = engine.grantHeroicInspiration();
      toolResultContent = 'Heroic Inspiration granted. Player may expend it to re-roll any one die.';
      break;
    case 'set_exhaustion_level':
      events = engine.setExhaustionLevel(input['level'] as number);
      toolResultContent = `Exhaustion level set to ${input['level'] as number}.`;
      break;
    case 'reveal_npc_name': {
      const entity = input['entity'] as string;
      const revealedName = input['revealed_name'] as string;
      engine.revealNpcName(entity, revealedName);
      toolResultContent = `${entity} is now known as "${revealedName}". The player has NOT been told the name yet — they only see your narrative reply. You MUST speak the name in this reply, in-character (e.g. "'I'm ${revealedName},' she says."). Use this name for all future references to this NPC.`;
      break;
    }
    case 'npc_speaks': {
      const entity = String(input['entity'] ?? '').trim();
      const text = String(input['text'] ?? '').trim();
      if (!entity || !text) {
        toolResultContent = 'npc_speaks needs both entity and text.';
        break;
      }
      // Resolve "player" → "player"; otherwise look up the NPC. Unknown
      // entity refs are a no-op (with a hint so the model corrects itself).
      let entityId: string | null = null;
      if (entity === 'player') {
        entityId = 'player';
      } else {
        const npc = engine.resolveNpcEntity(entity);
        if (npc) entityId = npc.id;
      }
      if (!entityId) {
        toolResultContent = `npc_speaks: unknown entity ref "${entity}". Use one from CURRENT STATE.`;
        break;
      }
      events = [{ type: 'npc_speech', entityId, text }];
      toolResultContent = `Speech bubble queued above ${entity}: "${text}".`;
      break;
    }
    case 'set_npc_passive': {
      events = engine.setNpcPassive(input['entity'] as string, input['passive'] as boolean);
      toolResultContent = `${input['entity']} is now ${input['passive'] ? 'passive — will skip combat turns' : 'active — will act normally in combat'}.`;
      break;
    }
    case 'request_attack_roll': {
      const attacker = input['attacker'] as string;
      const targetAc = input['target_ac'] as number;
      const atk = engine.rollAttackRoll(attacker, targetAc);
      const outcome = atk.isCrit ? 'CRITICAL HIT' : atk.isHit ? 'HIT' : 'MISS';
      const dmgPart = atk.isHit ? ` — ${atk.damage} damage` : '';
      engine.addLog(`Attack roll (${attacker}): ${atk.rollStr} — ${outcome}`);
      toolResultContent = `${outcome}. ${atk.rollStr}${dmgPart}.`;
      rollResult = `Attack: ${atk.rollStr} — ${outcome}${dmgPart}`;
      break;
    }
    case 'recall_memory': {
      const query = String(input['query'] ?? '').trim();
      const archive = ctx.archive ?? [];
      if (!query) { toolResultContent = 'recall_memory needs a non-empty query.'; break; }
      const lower = query.toLowerCase();
      const MAX_HITS = 8;
      const MAX_SNIPPET = 240;
      const hits: string[] = [];
      // Iterate newest-first so most recent matches surface; cap output.
      for (let i = archive.length - 1; i >= 0 && hits.length < MAX_HITS; i--) {
        const msg = archive[i];
        // Skip the synthetic seed "Begin the encounter." and historic CURRENT STATE blocks.
        let text = msg.content;
        const m = /\[PLAYER\]\n([\s\S]+)$/.exec(text);
        if (m) text = m[1];
        if (!text.toLowerCase().includes(lower)) continue;
        const snippet = text.length > MAX_SNIPPET ? text.slice(0, MAX_SNIPPET) + '…' : text;
        const turn = Math.floor(i / 2) + 1;
        hits.push(`turn ${turn} [${msg.role}]: ${snippet}`);
      }
      toolResultContent = hits.length === 0
        ? `No archived messages match "${query}".`
        : `Found ${hits.length} match${hits.length === 1 ? '' : 'es'} for "${query}" (newest first):\n${hits.join('\n---\n')}`;
      break;
    }
    case 'adjust_faction_standing': {
      const factionId = String(input['faction_id'] ?? '').trim();
      const delta = Number(input['delta']) || 0;
      if (!factionId) { toolResultContent = 'adjust_faction_standing requires a non-empty faction_id.'; break; }
      const before = engine.getFactionStanding(factionId);
      engine.adjustFactionStanding(factionId, delta);
      const after = engine.getFactionStanding(factionId);
      toolResultContent = `Faction "${factionId}" standing: ${before} → ${after} (Δ ${delta >= 0 ? '+' : ''}${delta}).`;
      break;
    }
    case 'adjust_faction_relation': {
      const a = String(input['faction_a'] ?? '').trim();
      const b = String(input['faction_b'] ?? '').trim();
      const delta = Number(input['delta']) || 0;
      const mirror = input['mirror'] === undefined ? true : !!input['mirror'];
      if (!a || !b) { toolResultContent = 'adjust_faction_relation requires both faction_a and faction_b.'; break; }
      engine.fireTriggerAction({ type: 'adjust_faction_relation', a, b, delta, mirror });
      const after = engine.getFactionRelation(a, b);
      toolResultContent = `Faction relation "${a}" ↔ "${b}" set to ${after} (Δ ${delta >= 0 ? '+' : ''}${delta}${mirror ? '' : ', one-sided'}).`;
      break;
    }
    case 'set_faction_relation': {
      const a = String(input['faction_a'] ?? '').trim();
      const b = String(input['faction_b'] ?? '').trim();
      const value = Number(input['value']);
      const mirror = input['mirror'] === undefined ? true : !!input['mirror'];
      if (!a || !b) { toolResultContent = 'set_faction_relation requires both faction_a and faction_b.'; break; }
      if (Number.isNaN(value)) { toolResultContent = 'set_faction_relation value must be a number.'; break; }
      engine.fireTriggerAction({ type: 'set_faction_relation', a, b, value, mirror });
      const after = engine.getFactionRelation(a, b);
      toolResultContent = `Faction relation "${a}" ↔ "${b}" set to ${after}${mirror ? '' : ' (one-sided)'}.`;
      break;
    }
    case 'reveal_faction': {
      const factionId = String(input['faction_id'] ?? '').trim();
      if (!factionId) { toolResultContent = 'reveal_faction requires a non-empty faction_id.'; break; }
      const newly = engine.revealFaction(factionId);
      toolResultContent = newly
        ? `Faction "${factionId}" is now identified — the Target Panel will show its name.`
        : `Faction "${factionId}" was already identified.`;
      break;
    }
    case 'create_rumor': {
      const id = String(input['id'] ?? '').trim();
      const text = String(input['text'] ?? '').trim();
      const salience = Number(input['salience']) || 5;
      if (!id || !text) { toolResultContent = 'create_rumor requires both id and text.'; break; }
      const added = engine.recordRumor(id, text, salience);
      toolResultContent = added
        ? `Rumor "${id}" recorded (salience ${salience}). The world now remembers this.`
        : `Rumor "${id}" already exists — no change.`;
      break;
    }
    case 'set_world_flag': {
      const name = String(input['name'] ?? '').trim();
      const rawValue = input['value'];
      if (!name) { toolResultContent = 'set_world_flag requires a non-empty name.'; break; }
      // Only booleans, numbers, and strings are persistable as WorldFlagValue.
      if (typeof rawValue !== 'boolean' && typeof rawValue !== 'number' && typeof rawValue !== 'string') {
        toolResultContent = 'set_world_flag value must be a boolean, number, or string.';
        break;
      }
      engine.setWorldFlag(name, rawValue);
      toolResultContent = `World flag "${name}" set to ${JSON.stringify(rawValue)}.`;
      break;
    }
    case 'fade_screen': {
      const rawMode = input['mode'];
      const mode = rawMode === 'in' || rawMode === 'out' || rawMode === 'dim' ? rawMode : null;
      if (!mode) { toolResultContent = 'fade_screen requires mode: "in", "out", or "dim".'; break; }
      const rawDuration = input['duration_ms'];
      const durationMs = typeof rawDuration === 'number' && rawDuration >= 0
        ? Math.min(10000, Math.floor(rawDuration))
        : 1200;
      events = [{ type: 'screen_fade', mode, durationMs }];
      toolResultContent = `Screen fade ${mode} queued (${durationMs} ms).`;
      break;
    }
    case 'show_supertitle': {
      const text = String(input['text'] ?? '').trim();
      if (!text) { toolResultContent = 'show_supertitle requires non-empty text.'; break; }
      const rawDuration = input['duration_ms'];
      const durationMs = typeof rawDuration === 'number' && rawDuration > 0
        ? Math.min(15000, Math.floor(rawDuration))
        : undefined;
      events = durationMs !== undefined
        ? [{ type: 'supertitle', text, durationMs }]
        : [{ type: 'supertitle', text }];
      toolResultContent = `Supertitle queued: "${text}".`;
      break;
    }
    case 'show_announcement': {
      const text = String(input['text'] ?? '').trim();
      if (!text) { toolResultContent = 'show_announcement requires non-empty text.'; break; }
      const rawDuration = input['duration_ms'];
      const durationMs = typeof rawDuration === 'number' && rawDuration > 0
        ? Math.min(15000, Math.floor(rawDuration))
        : undefined;
      const rawMode = input['mode'];
      const mode: 'focused' | 'unfocused' = rawMode === 'unfocused' ? 'unfocused' : 'focused';
      // Mirror the announcement to the Event Log so it persists after the
      // visual fades. The Event Log is canonical; the announcement is just an
      // attention-grabbing visual on top.
      engine.addLog(text);
      const ev: import('../../../shared/types.js').GameEvent =
        durationMs !== undefined
          ? { type: 'announcement', text, durationMs, mode }
          : { type: 'announcement', text, mode };
      events = [ev];
      toolResultContent = `Announcement queued (${mode}): "${text}" (also written to Event Log).`;
      break;
    }
  }
  return { events, toolResultContent, rollResult };
}
