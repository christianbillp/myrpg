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
    description: 'Spawn a new enemy on the map. Valid monster_id values: "goblin_minion", "bandit", "commoner", "skeleton".',
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
    description: 'Throw an item at a target enemy. Proper thrown weapons (javelin, dagger) use their weapon stats and mastery with proficiency. All other items are improvised weapons (1d4 bludgeoning, no proficiency bonus). The item is removed from the player\'s inventory or the map. item_id can be an inventory item or a map item defId. target is the enemy label (A, B, …); omit for nearest enemy in range.',
    input_schema: { type: 'object' as const, properties: { item_id: { type: 'string' }, target: { type: 'string' }, reason: { type: 'string' } }, required: ['item_id', 'reason'] },
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
    case 'apply_condition':
      events = engine.applyCondition(input['entity'] as string, input['condition'] as string);
      break;
    case 'remove_condition':
      events = engine.removeCondition(input['entity'] as string, input['condition'] as string);
      break;
    case 'set_disposition':
      events = engine.setDisposition(input['entity'] as string, input['disposition'] as string);
      break;
    case 'throw_item':
      events = engine.throwItem(input['item_id'] as string, input['target'] as string | undefined);
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
