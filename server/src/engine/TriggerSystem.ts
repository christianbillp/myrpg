import type { GameContext } from './GameContext.js';
import type {
  EncounterTrigger, TriggerCondition, TriggerAction, NpcState,
} from './types.js';

/**
 * Discriminated union of in-engine events that can match a trigger condition.
 * Hook points in the engine call `evaluateTriggers(ctx, event)` after the
 * underlying state change has been applied — so condition checks see the
 * already-updated GameState (player on new tile, NPC at hp 0, etc.).
 */
export type TriggerEvent =
  | { kind: 'player_moved'; x: number; y: number }
  | { kind: 'npc_killed'; npc: NpcState }
  | { kind: 'item_picked_up'; defId: string };

/**
 * Evaluate all unfired triggers against `event` and fire the actions of every
 * matching trigger. Triggers marked `once: false` re-fire on every match;
 * the default (`once` omitted or true) records the trigger id in
 * `GameState.firedTriggerIds` so it won't fire again — including across
 * save/load, since that field is persisted on the world save.
 */
export function evaluateTriggers(ctx: GameContext, event: TriggerEvent): void {
  const s = ctx.state;
  if (s.triggers.length === 0) return;

  for (const trigger of s.triggers) {
    const once = trigger.once !== false;
    if (once && s.firedTriggerIds.includes(trigger.id)) continue;
    if (!conditionMatches(trigger.condition, event)) continue;

    for (const action of trigger.actions) fireAction(ctx, action);

    if (once && !s.firedTriggerIds.includes(trigger.id)) {
      s.firedTriggerIds.push(trigger.id);
    }
  }
}

function conditionMatches(cond: TriggerCondition, event: TriggerEvent): boolean {
  switch (cond.type) {
    case 'enter_area':
      return event.kind === 'player_moved'
        && event.x >= cond.x && event.x < cond.x + cond.w
        && event.y >= cond.y && event.y < cond.y + cond.h;
    case 'enter_tile':
      return event.kind === 'player_moved' && event.x === cond.x && event.y === cond.y;
    case 'npc_killed':
      return event.kind === 'npc_killed' && event.npc.defId === cond.defId;
    case 'item_picked_up':
      return event.kind === 'item_picked_up' && event.defId === cond.defId;
  }
}

function fireAction(ctx: GameContext, action: TriggerAction): void {
  switch (action.type) {
    case 'spawn_enemy_near_player': {
      const spawned = ctx.spawnEnemyNearPlayer(action.monsterId, action.minDist, action.maxDist);
      if (spawned) ctx.addLog({ left: `⚔ ${spawned.name} appears!`, style: 'header' });
      return;
    }
    case 'spawn_enemy_at': {
      const spawned = ctx.spawnEnemyAt(action.monsterId, action.x, action.y);
      if (spawned) ctx.addLog({ left: `⚔ ${spawned.name} appears!`, style: 'header' });
      return;
    }
    case 'show_log':
      ctx.addLog({ left: action.message, style: 'header' });
      return;
    case 'send_aidm_message':
      ctx.state.pendingAidmEvents.push(action.message);
      return;
  }
}
