import type { GameContext } from './GameContext.js';
import type {
  EncounterTrigger, WhenClause, TriggerGuard, TriggerAction,
  EngineEvent, ComparisonOp, GameEvent,
} from './types.js';
import { pickNarrationVariant } from './NarrationSystem.js';
import { d20 as d20Local } from './Dice.js';

/**
 * TriggerSystem (v2) — subscribes encounter triggers to the engine event bus.
 *
 * Lifecycle:
 *  1. `registerTriggers(ctx)` is called once at session start by GameEngine.
 *     Each trigger registers a single subscribeAll handler at low priority
 *     (engine-internal subscribers run first).
 *  2. When an event is published, the handler runs WHEN-matching → IF guards
 *     → THEN effects, in that order. ALL guards must hold (logical AND).
 *  3. Once-only triggers (the default) append their id to `firedTriggerIds`
 *     after firing; subsequent events are ignored. `firedTriggerIds` is
 *     persisted on the world save, so once-ness survives save/load.
 */
export function registerTriggers(ctx: GameContext): void {
  for (const trigger of ctx.state.triggers) {
    validateTrigger(trigger, ctx);
    ctx.bus.subscribeAll((event) => evaluateOne(ctx, trigger, event), -10);
  }
}

/**
 * Load-time sanity check. Logs (does not throw) when a trigger references
 * a known-bad event/guard/action shape — e.g. a misspelled `event` key, a
 * `narrate` action whose `narrationId` doesn't exist in `defs.narration`,
 * or a `spawn_enemy_*` whose `monsterId` isn't a known monster. Trigger
 * authors get a console warning at session start instead of silent no-ops.
 */
function validateTrigger(trigger: EncounterTrigger, ctx: GameContext): void {
  const warn = (msg: string) => console.warn(`[TriggerSystem] trigger '${trigger.id}': ${msg}`);

  const validEvents: WhenClause['event'][] = [
    'player_moved', 'npc_killed', 'item_picked_up',
    'turn_started', 'turn_ended', 'combat_started', 'combat_ended',
    'damage_dealt', 'hp_threshold_crossed', 'faction_changed', 'custom',
  ];
  if (!validEvents.includes(trigger.when.event)) {
    warn(`unknown WHEN event "${trigger.when.event}"`);
  }

  const monsterIds = new Set(ctx.defs.monsters.map((m) => m.id));
  const narrationIds = new Set(ctx.defs.narration.map((n) => n.id));
  const itemIds = new Set(ctx.defs.equipment.map((i) => i.id));

  for (const a of trigger.then) {
    if ((a.type === 'spawn_enemy_near_player' || a.type === 'spawn_enemy_at') && !monsterIds.has(a.monsterId)) {
      warn(`spawn references unknown monsterId "${a.monsterId}"`);
    }
    if (a.type === 'narrate' && !narrationIds.has(a.narrationId)) {
      warn(`narrate references unknown narrationId "${a.narrationId}"`);
    }
  }
  if (trigger.when.event === 'item_picked_up' && trigger.when.defId && !itemIds.has(trigger.when.defId)) {
    warn(`item_picked_up references unknown defId "${trigger.when.defId}"`);
  }
}

function evaluateOne(ctx: GameContext, trigger: EncounterTrigger, event: EngineEvent): void {
  const once = trigger.once !== false;
  if (once && ctx.state.firedTriggerIds.includes(trigger.id)) return;
  if (!whenMatches(trigger.when, event)) return;
  if (trigger.if && !trigger.if.every((g) => guardHolds(ctx, g))) return;

  for (const action of trigger.then) fireAction(ctx, action);

  if (once && !ctx.state.firedTriggerIds.includes(trigger.id)) {
    ctx.state.firedTriggerIds.push(trigger.id);
  }
}

// ── WHEN ─────────────────────────────────────────────────────────────────────

function whenMatches(when: WhenClause, event: EngineEvent): boolean {
  if (when.event !== event.type) return false;
  switch (when.event) {
    case 'player_moved': {
      const e = event as Extract<EngineEvent, { type: 'player_moved' }>;
      if (when.in_area) {
        const a = when.in_area;
        if (e.x < a.x || e.x >= a.x + a.w || e.y < a.y || e.y >= a.y + a.h) return false;
      }
      if (when.tile && (when.tile.x !== e.x || when.tile.y !== e.y)) return false;
      return true;
    }
    case 'npc_killed': {
      const e = event as Extract<EngineEvent, { type: 'npc_killed' }>;
      return when.defId === undefined || when.defId === e.defId;
    }
    case 'item_picked_up': {
      const e = event as Extract<EngineEvent, { type: 'item_picked_up' }>;
      return when.defId === undefined || when.defId === e.defId;
    }
    case 'turn_started':
    case 'turn_ended': {
      const e = event as Extract<EngineEvent, { type: 'turn_started' | 'turn_ended' }>;
      return when.combatantId === undefined || when.combatantId === e.combatantId;
    }
    case 'combat_started':
    case 'combat_ended':
      return true;
    case 'damage_dealt': {
      const e = event as Extract<EngineEvent, { type: 'damage_dealt' }>;
      return when.target === undefined || when.target === e.target;
    }
    case 'hp_threshold_crossed': {
      const e = event as Extract<EngineEvent, { type: 'hp_threshold_crossed' }>;
      if (when.target !== undefined && when.target !== e.target) return false;
      if (when.ratio !== undefined && when.ratio !== e.ratio) return false;
      if (when.direction !== undefined && when.direction !== e.direction) return false;
      return true;
    }
    case 'faction_changed': {
      const e = event as Extract<EngineEvent, { type: 'faction_changed' }>;
      return when.factionId === undefined || when.factionId === e.factionId;
    }
    case 'custom': {
      const e = event as Extract<EngineEvent, { type: 'custom' }>;
      return when.name === e.name;
    }
  }
}

// ── IF (guards) ──────────────────────────────────────────────────────────────

function guardHolds(ctx: GameContext, guard: TriggerGuard): boolean {
  const s = ctx.state;
  switch (guard.type) {
    case 'flag_set':
      return s.worldFlags[guard.name] !== undefined;
    case 'flag_unset':
      return s.worldFlags[guard.name] === undefined;
    case 'flag_equals':
      return s.worldFlags[guard.name] === guard.value;
    case 'hp_below':
      return s.player.hp / Math.max(1, ctx.playerDef.maxHp) < guard.ratio;
    case 'enemies_alive': {
      const count = s.npcs.filter((n) => n.disposition === 'enemy' && n.hp > 0).length;
      return compare(count, guard.op, guard.count);
    }
    case 'allies_alive': {
      const count = s.npcs.filter((n) => n.disposition === 'ally' && n.hp > 0).length;
      return compare(count, guard.op, guard.count);
    }
    case 'npcs_alive': {
      const count = s.npcs.filter((n) => n.defId === guard.defId && n.hp > 0).length;
      return compare(count, guard.op, guard.count);
    }
    case 'phase':
      return guard.in.includes(s.phase);
    case 'faction_standing': {
      const value = s.factionStandings[guard.factionId] ?? 0;
      return compare(value, guard.op, guard.value);
    }
  }
}

function compare(a: number, op: ComparisonOp, b: number): boolean {
  switch (op) {
    case 'lt': return a < b;
    case 'le': return a <= b;
    case 'eq': return a === b;
    case 'ge': return a >= b;
    case 'gt': return a > b;
  }
}

// ── THEN (effects) ───────────────────────────────────────────────────────────

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
    case 'send_aigm_message':
      ctx.state.pendingAigmEvents.push(action.message);
      return;
    case 'narrate': {
      const text = pickNarrationVariant(ctx, action.narrationId);
      if (text) ctx.addLog({ left: text, style: 'header' });
      return;
    }
    case 'set_flag': {
      ctx.state.worldFlags[action.name] = action.value;
      // Publishing flag_set lets other triggers fan out off a flag change.
      ctx.publish({ type: 'flag_set', name: action.name, value: action.value });
      return;
    }
    case 'apply_condition_to_player': {
      if (!ctx.state.player.conditions.includes(action.condition)) {
        ctx.state.player.conditions.push(action.condition);
        ctx.addLog({ left: `${ctx.playerDef.name} is now ${action.condition}`, style: 'status' });
      }
      return;
    }
    case 'emit_event':
      // Only `custom` events can be authored — engine-canonical events
      // (npc_killed, damage_dealt, …) must originate from the engine.
      ctx.publish({ type: 'custom', name: action.name, payload: action.payload });
      return;
    case 'adjust_faction_standing': {
      adjustFactionStanding(ctx, action.factionId, action.delta);
      return;
    }
    case 'record_rumor': {
      recordRumor(ctx, action.id, action.text, action.salience ?? 5);
      return;
    }
    case 'set_disposition_by_def_id': {
      for (const npc of ctx.state.npcs.filter((n) => n.defId === action.defId && n.hp > 0)) {
        npc.disposition = action.disposition;
        if ((action.disposition === 'ally' || action.disposition === 'enemy') && !npc.combatLabel) {
          ctx.assignCombatLabel(npc);
        }
        if (action.disposition === 'enemy') ctx.aggroFaction(npc);
      }
      return;
    }
    case 'trigger_combat': {
      // Precondition mirrors `CombatFlow.triggerCombat`: must be exploring and
      // have at least one living enemy.
      if (ctx.state.phase !== 'exploring') return;
      if (!ctx.state.npcs.some((n) => n.disposition === 'enemy' && n.hp > 0)) return;
      // Append to the outer call's event sink so any entity_move events
      // generated by an NPC's first turn (if they outroll the player on
      // Initiative) make it back to the client.
      const sink = ctx.eventSink ?? [];
      ctx.doStartCombat(sink);
      return;
    }
    case 'player_ability_check': {
      // d20 + player's skill bonus (defaults to 0 for unknown skills). The
      // roll itself is intentionally NOT logged so a failed check leaks no
      // information about hidden content — write any visible feedback inside
      // the onPass / onFail action lists instead.
      const bonus = ctx.playerDef.skills[action.skill] ?? 0;
      const roll = d20Local();
      const total = roll + bonus;
      const branch = total >= action.dc ? action.onPass : action.onFail;
      for (const a of branch) fireAction(ctx, a);
      return;
    }
  }
}

// ── Faction & rumor helpers (also called from AIGMTools) ─────────────────────

export function adjustFactionStanding(ctx: GameContext, factionId: string, delta: number): void {
  const s = ctx.state;
  const oldValue = s.factionStandings[factionId] ?? 0;
  const newValue = Math.max(-100, Math.min(100, oldValue + delta));
  s.factionStandings[factionId] = newValue;
  if (oldValue !== newValue) {
    ctx.publish({ type: 'faction_changed', factionId, oldValue, newValue });
  }
}

export function recordRumor(ctx: GameContext, id: string, text: string, salience: number): void {
  const s = ctx.state;
  if (s.rumors.some((r) => r.id === id)) return;
  s.rumors.push({ id, text, salience, recordedAt: Date.now() });
  ctx.publish({ type: 'rumor_propagated', rumorId: id });
}
