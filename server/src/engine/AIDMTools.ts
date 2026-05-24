import { GameEngine } from './GameEngine.js';
import { GameEvent } from './types.js';

export interface AIDMToolResult {
  events: GameEvent[];
  toolResultContent: string;
  rollResult?: string;
}

export const AIDM_TOOLS = [
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
    description: 'Adjust any combatant\'s HP by a delta. Positive heals, negative damages. Entity: "player", "enemy_A" (enemy by label A–Z), "ally_a" (ally by label a–z), or "npc_[id]" (neutral NPC by id). To kill, use a large negative delta. Optionally supply damage_type (e.g. "fire", "poison", "piercing") so resistance and vulnerability are applied automatically.',
    input_schema: { type: 'object' as const, properties: { entity: { type: 'string' }, delta: { type: 'integer' }, damage_type: { type: 'string' }, reason: { type: 'string' } }, required: ['entity', 'delta', 'reason'] },
  },
  {
    name: 'add_log_entry',
    description: 'Add a narrative entry to the combat log without changing game state.',
    input_schema: { type: 'object' as const, properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'move_entity',
    description: 'Teleport an entity to a tile. Entity: "player", "enemy_A" (enemy by label), or "npc_[id]" (NPC or ally by id).',
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
    description: 'Remove an NPC from the map. Entity: "npc_[id]".',
    input_schema: { type: 'object' as const, properties: { entity: { type: 'string' }, reason: { type: 'string' } }, required: ['entity', 'reason'] },
  },
  {
    name: 'spawn_enemy',
    description: 'Spawn a new enemy on the map. Valid monster_id values: "goblin_minion", "bandit", "commoner", "skeleton", "guard".',
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
    description: 'Apply a condition to the player or an NPC. Entity: "player", "enemy_A" (by label), or "npc_[id]". Common conditions: blinded, charmed, frightened, grappled, incapacitated, paralyzed, poisoned, prone, restrained, stunned.',
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
    description: 'Change an NPC\'s disposition. Entity: "enemy_A" (by label) or "npc_[id]". Disposition: "ally" (fights alongside the player), "neutral" (does not participate in combat), "enemy" (fights the player).',
    input_schema: { type: 'object' as const, properties: { entity: { type: 'string' }, disposition: { type: 'string' }, reason: { type: 'string' } }, required: ['entity', 'disposition', 'reason'] },
  },
  {
    name: 'throw_item',
    description: 'Throw an item at a target. Proper thrown weapons (javelin, dagger) use their weapon stats and mastery with proficiency. All other items are improvised weapons (1d4 bludgeoning, no proficiency bonus). The item is removed from the player\'s inventory or the map. item_id can be an inventory item id or a map item defId. target uses the same entity ref format as move_entity: "enemy_A" for an enemy by label, "npc_[id]" for a neutral or ally NPC by id; omit to auto-target the nearest enemy in range. Attacking a neutral NPC turns them hostile.',
    input_schema: { type: 'object' as const, properties: { item_id: { type: 'string' }, target: { type: 'string' }, reason: { type: 'string' } }, required: ['item_id', 'reason'] },
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
    description: 'Roll an attack roll for the player or an NPC against a target AC (use this for attacking objects, doors, or off-turn attacks such as opportunity attacks). attacker: "player", "enemy_A" (enemy by label), or "npc_[id]". target_ac: the Armor Class to roll against. Returns hit/miss/critical and damage dealt.',
    input_schema: { type: 'object' as const, properties: { attacker: { type: 'string' }, target_ac: { type: 'integer' }, reason: { type: 'string' } }, required: ['attacker', 'target_ac', 'reason'] },
  },
  {
    name: 'set_exhaustion_level',
    description: 'Set the player\'s Exhaustion level (0–5). Each level imposes −2 to all D20 Tests (ability checks and saving throws). Level 5 is lethal. Per SRD: a Long Rest removes one Exhaustion level.',
    input_schema: { type: 'object' as const, properties: { level: { type: 'integer' }, reason: { type: 'string' } }, required: ['level', 'reason'] },
  },
];

export function applyAIDMTool(engine: GameEngine, name: string, input: Record<string, unknown>): AIDMToolResult {
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
    case 'award_gold': {
      const amount = input['amount'] as number;
      if (amount < 0 && engine.getState().player.gold + amount < 0) {
        toolResultContent = `Transaction rejected: player only has ${engine.getState().player.gold} GP and cannot pay ${Math.abs(amount)} GP. Do not narrate this payment as successful — inform the player they cannot afford it.`;
      } else {
        events = engine.awardGold(amount);
      }
      break;
    }
    case 'adjust_npc_hp': {
      const logBefore = engine.getState().combatLog.length;
      events = engine.adjustNpcHp(input['entity'] as string, input['delta'] as number, input['damage_type'] as string | undefined);
      const newEntries = engine.getState().combatLog.slice(logBefore);
      toolResultContent = newEntries.map((e) => e.right ? `${e.left} [${e.right}]` : e.left).join(' | ') || 'Applied.';
      break;
    }
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
    case 'apply_condition':
      events = engine.applyCondition(input['entity'] as string, input['condition'] as string);
      break;
    case 'remove_condition':
      events = engine.removeCondition(input['entity'] as string, input['condition'] as string);
      break;
    case 'set_disposition':
      events = engine.setDisposition(input['entity'] as string, input['disposition'] as string);
      break;
    case 'throw_item': {
      const stateBeforeThrow = engine.getState();
      if (stateBeforeThrow.phase === 'player_turn' && stateBeforeThrow.player.actionUsed) {
        toolResultContent = 'Action already spent this turn — throw not performed. Inform the player their action is used and they must end their turn or use a bonus action instead.';
        break;
      }
      const logBefore = stateBeforeThrow.combatLog.length;
      events = engine.throwItem(input['item_id'] as string, input['target'] as string | undefined);
      const newEntries = engine.getState().combatLog.slice(logBefore);
      toolResultContent = newEntries.map((e) => e.right ? `${e.left} [${e.right}]` : e.left).join(' | ') || 'Applied.';
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
    case 'award_temp_hp':
      events = engine.awardTempHp(input['amount'] as number);
      break;
    case 'grant_heroic_inspiration':
      events = engine.grantHeroicInspiration();
      break;
    case 'set_exhaustion_level':
      events = engine.setExhaustionLevel(input['level'] as number);
      toolResultContent = `Exhaustion level set to ${input['level'] as number}.`;
      break;
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
  }
  return { events, toolResultContent, rollResult };
}
