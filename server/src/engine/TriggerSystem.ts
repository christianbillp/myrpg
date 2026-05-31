import type { GameContext } from './GameContext.js';
import type {
  EncounterTrigger, WhenClause, TriggerGuard, TriggerAction,
  EngineEvent, ComparisonOp, GameEvent,
} from './types.js';
import { pickNarrationVariant } from './NarrationSystem.js';
import { d20 as d20Local } from './Dice.js';
import { setRelation, adjustRelation } from './FactionRelations.js';
import { PLAYER_FACTION_ID } from '../../../shared/types.js';
import { formatCoins as formatCoinsTrigger } from '../../../shared/currency.js';
import {
  startConversation, endConversation, setConversationNode,
  applyNpcRemember, applyNpcForget, applyNpcAdjustRelationship,
  applyNpcRecordJournal, applyNpcSetArcPhase,
} from './ConversationSystem.js';

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
    'encounter_started', 'encounter_completed',
    'damage_dealt', 'hp_threshold_crossed', 'faction_changed', 'flag_set', 'custom',
  ];
  if (!validEvents.includes(trigger.when.event)) {
    warn(`unknown WHEN event "${trigger.when.event}"`);
  }

  const monsterIds = new Set(ctx.defs.monsters.map((m) => m.id));
  const narrationIds = new Set(ctx.defs.narration.map((n) => n.id));
  const itemIds = new Set(ctx.defs.equipment.map((i) => i.id));
  // Set of defIds actually spawned in the encounter — used to detect typos
  // in disposition / hide / dead actions that target a defId nothing in the
  // encounter shares. The runtime list captures both `npcIds` and the
  // ally/enemy slots after SpawnHelpers.populateNpcs runs, so authors don't
  // have to maintain a separate manifest.
  const spawnedDefIds = new Set(ctx.state.npcs.map((n) => n.defId));

  // SRD-style "any flag" wildcard listeners are almost always authoring slips —
  // every other flag write in the same encounter pings them. The wildcard
  // pattern is rare enough that emitting it intentionally should require an
  // explicit `flag_set` when with `name: ""` (empty string), which we treat
  // as opt-in. Anything else (no `name` field at all) gets a warning.
  if (trigger.when.event === 'flag_set' && trigger.when.name === undefined) {
    warn(`flag_set trigger has no \`name\` filter — it will fire on EVERY flag write. Add \`when.name\` to scope it.`);
  }

  for (const a of trigger.then) {
    if ((a.type === 'spawn_enemy_near_player' || a.type === 'spawn_enemy_at') && !monsterIds.has(a.monsterId)) {
      warn(`spawn references unknown monsterId "${a.monsterId}"`);
    }
    if (a.type === 'narrate' && !narrationIds.has(a.narrationId)) {
      warn(`narrate references unknown narrationId "${a.narrationId}"`);
    }
    if (a.type === 'set_npc_hidden') {
      if (!monsterIds.has(a.defId) && !ctx.defs.npcs.some((n) => n.id === a.defId)) {
        warn(`set_npc_hidden references unknown defId "${a.defId}" (not in monster or NPC roster)`);
      } else if (!spawnedDefIds.has(a.defId)) {
        warn(`set_npc_hidden defId "${a.defId}" is not spawned in this encounter — action will no-op`);
      }
    }
    if (a.type === 'set_npc_dead') {
      if (!monsterIds.has(a.defId) && !ctx.defs.npcs.some((n) => n.id === a.defId)) {
        warn(`set_npc_dead references unknown defId "${a.defId}" (not in monster or NPC roster)`);
      } else if (!spawnedDefIds.has(a.defId)) {
        warn(`set_npc_dead defId "${a.defId}" is not spawned in this encounter — action will no-op`);
      }
    }
    if (a.type === 'set_disposition_by_def_id' && !spawnedDefIds.has(a.defId)) {
      warn(`set_disposition_by_def_id defId "${a.defId}" is not spawned in this encounter — action will no-op`);
    }
    if (a.type === 'npc_speaks' && /^(enemy|neutral|ally)_(\d+)$/.test(a.entity)) {
      warn(`npc_speaks entity "${a.entity}" is a slot ref, not an entity ref — use the NPC instance id (e.g. "npc_bandit_1") instead`);
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
    case 'encounter_started':
    case 'encounter_completed':
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
    case 'flag_set': {
      const e = event as Extract<EngineEvent, { type: 'flag_set' }>;
      if (when.name !== undefined && when.name !== e.name) return false;
      if (when.value !== undefined && when.value !== e.value) return false;
      return true;
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
    case 'balance_cp':
      return compare(s.player.balanceCp, guard.op, guard.value);
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

/**
 * Apply a single `TriggerAction`. Exported so AIGM tools that share the same
 * mutation semantics (the new faction-relation tools, etc.) can route through
 * the canonical handler instead of re-implementing it.
 */
export function fireAction(ctx: GameContext, action: TriggerAction): void {
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
    case 'adjust_faction_relation': {
      const before = ctx.state.factionRelations[action.a]?.[action.b] ?? 0;
      adjustRelation(ctx.state, action.a, action.b, action.delta, { mirror: action.mirror ?? true });
      const after = ctx.state.factionRelations[action.a]?.[action.b] ?? 0;
      // Surface a `faction_changed` event for any pair touching the player
      // so existing `faction_changed` listeners stay correct without extra
      // wiring. NPC-vs-NPC shifts don't publish (no existing listeners).
      if (action.a === PLAYER_FACTION_ID) ctx.publish({ type: 'faction_changed', factionId: action.b, oldValue: before, newValue: after });
      else if (action.b === PLAYER_FACTION_ID) ctx.publish({ type: 'faction_changed', factionId: action.a, oldValue: before, newValue: after });
      return;
    }
    case 'set_faction_relation': {
      const before = ctx.state.factionRelations[action.a]?.[action.b] ?? 0;
      setRelation(ctx.state, action.a, action.b, action.value, { mirror: action.mirror ?? true });
      const after = ctx.state.factionRelations[action.a]?.[action.b] ?? 0;
      if (action.a === PLAYER_FACTION_ID) ctx.publish({ type: 'faction_changed', factionId: action.b, oldValue: before, newValue: after });
      else if (action.b === PLAYER_FACTION_ID) ctx.publish({ type: 'faction_changed', factionId: action.a, oldValue: before, newValue: after });
      return;
    }
    case 'reveal_faction': {
      if (!ctx.state.discoveredFactions.includes(action.factionId)) {
        ctx.state.discoveredFactions.push(action.factionId);
      }
      return;
    }
    case 'set_npc_dead': {
      // Mark every matching NPC as a corpse. Sets hp to 0, tags the `dead`
      // condition (so condition-aware code paths — incapacitation gates,
      // perception sweeps, AIGM combatant listings — treat them uniformly),
      // forces disposition to neutral (a corpse can't be hostile), drops
      // their `inventoryIds` to the map (mirrors `killNpc`) unless the
      // author opts out via `dropInventory: false`, and attaches the
      // optional one-shot search payload. Idempotent on the hp/condition
      // fields; the corpseSearch payload overwrites any prior.
      const dropInventory = action.dropInventory !== false;
      for (const npc of ctx.state.npcs.filter((n) => n.defId === action.defId)) {
        npc.hp = 0;
        if (!npc.conditions.includes('dead')) npc.conditions.push('dead');
        npc.conditions = npc.conditions.filter((c) => c !== 'hidden' && c !== 'invisible');
        npc.hideDC = undefined;
        npc.revealedByTrigger = undefined;
        npc.disposition = 'neutral';
        if (dropInventory && npc.inventoryIds.length > 0) {
          for (const defId of npc.inventoryIds) {
            ctx.state.mapItems.push({ id: ctx.uid(), defId, tileX: npc.tileX, tileY: npc.tileY });
          }
          npc.inventoryIds = [];
        }
        if (action.corpseSearch) npc.corpseSearch = { ...action.corpseSearch };
      }
      return;
    }
    case 'set_npc_hidden': {
      // Hide/reveal every living NPC matching `defId`. Stored as the standard
      // `hidden` condition + `hideDC` so the existing perception machinery
      // (Vision.canSee, runPerceptionSweep, runPassivePerceptionSweep) finds
      // and resolves them with no special-casing. Default DC is derived from
      // the monster's `stealthBonus` (10 + bonus) so authors don't have to
      // hand-pick one for routine scrub/ambush starts. When
      // `revealedBy: 'trigger'` is set, the npc also gets the
      // `revealedByTrigger` flag so the passive Perception sweep skips it —
      // only an explicit `hidden: false` reveal will surface it.
      //
      // On reveal (`hidden: false`), if the NPC's tile is occupied by the
      // player or another living NPC (possible when the player walked
      // through a trigger-locked tile), the NPC is bumped to the nearest
      // free passable tile so the two creatures don't share a cell.
      for (const npc of ctx.state.npcs.filter((n) => n.defId === action.defId && n.hp > 0)) {
        if (action.hidden) {
          if (!npc.conditions.includes('hidden')) npc.conditions.push('hidden');
          if (typeof action.hideDC === 'number') {
            npc.hideDC = action.hideDC;
          } else if (typeof npc.hideDC !== 'number') {
            const def = ctx.resolveMonsterDef(npc.defId);
            npc.hideDC = 10 + (def?.stealthBonus ?? 0);
          }
          npc.revealedByTrigger = action.revealedBy === 'trigger';
        } else {
          npc.conditions = npc.conditions.filter((c) => c !== 'hidden' && c !== 'invisible');
          npc.hideDC = undefined;
          npc.revealedByTrigger = undefined;
          bumpOffOccupiedTile(ctx, npc);
        }
      }
      return;
    }
    case 'set_disposition_by_def_id': {
      // Disposition flips are sugar for setting the affected NPC's faction
      // standing with `party` to the corresponding pole. Mirror to the matrix
      // so Pass 3 readers (off-camera tick, NPC-vs-NPC AI) see the same view
      // as the existing combat-start condition that still reads disposition.
      const standingByDisp = action.disposition === 'enemy' ? -100
                            : action.disposition === 'ally' ? 100
                            : 0;
      const touchedFactions = new Set<string>();
      for (const npc of ctx.state.npcs.filter((n) => n.defId === action.defId && n.hp > 0)) {
        npc.disposition = action.disposition;
        if ((action.disposition === 'ally' || action.disposition === 'enemy') && !npc.combatLabel) {
          ctx.assignCombatLabel(npc);
        }
        if (action.disposition === 'enemy') ctx.aggroFaction(npc);
        touchedFactions.add(npc.factionId);
      }
      for (const factionId of touchedFactions) {
        setRelation(ctx.state, factionId, PLAYER_FACTION_ID, standingByDisp);
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
    case 'award_xp': {
      // Authored story XP — perception finds, riddles solved, parley
      // resolved, etc. Kill XP is awarded automatically by the kill resolver;
      // this is the "no kill happened" path. No-op when the amount is non-
      // positive so authoring "+0" doesn't add spurious log entries.
      const amount = Math.max(0, Math.floor(action.amount));
      if (amount <= 0) return;
      ctx.state.player.xp += amount;
      ctx.addLog({ left: `+${amount} XP`, style: 'status' });
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
    case 'show_announcement': {
      const text = action.text.trim();
      if (!text) return;
      // Mirror the announcement to the Event Log so it persists after the
      // visual fades — same behaviour as the AIGM tool.
      ctx.addLog(text);
      const sink = ctx.eventSink;
      if (!sink) return;
      const mode: 'focused' | 'unfocused' = action.mode === 'unfocused' ? 'unfocused' : 'focused';
      const ev: GameEvent = action.durationMs !== undefined
        ? { type: 'announcement', text, durationMs: clampDuration(action.durationMs, 15000), mode }
        : { type: 'announcement', text, mode };
      sink.push(ev);
      return;
    }
    case 'npc_speaks': {
      const text = action.text.trim();
      if (!text) return;
      let entityId: string | null = null;
      let speakerName: string | null = null;
      if (action.entity === 'player') {
        entityId = 'player';
        speakerName = ctx.playerDef.name;
      } else {
        const npc = ctx.resolveNpcByEntity(action.entity);
        if (npc) {
          entityId = npc.id;
          speakerName = npc.revealedName ?? npc.name;
        }
      }
      if (!entityId || !speakerName) return;
      // Mirror the spoken line into the Event Log — same surfacing as the
      // AIGM `npc_speaks` tool. Logged even when there's no eventSink so
      // a startup-event trigger (encounter_started) still leaves a record.
      // 💬 prefix matches the AIGM-tool path so dialogue lines line up
      // visually in the log.
      ctx.addLog({ left: `💬 ${speakerName}: "${text}"`, style: 'status' });
      const sink = ctx.eventSink;
      if (!sink) return;
      sink.push({ type: 'npc_speech', entityId, text, speakerName });
      return;
    }
    case 'fade_screen': {
      const sink = ctx.eventSink;
      if (!sink) return;
      const durationMs = clampDuration(action.durationMs ?? 1200, 10000);
      sink.push({ type: 'screen_fade', mode: action.mode, durationMs });
      return;
    }
    case 'set_long_rest': {
      // No-op if the flag is already in the requested state — avoids spurious
      // log entries on idempotent re-fires.
      if (ctx.state.allowsLongRest === action.allowed) return;
      ctx.state.allowsLongRest = action.allowed;
      ctx.addLog({
        left: action.allowed
          ? "You can take a Long Rest here."
          : "Long Rest is no longer available.",
        style: 'status',
      });
      return;
    }
    case 'adjust_player_balance_cp': {
      // Same semantics as the AIGM `award_coins` tool: positive = award,
      // negative = spend. A spend that would leave the player below zero is
      // refused (no mutation, a refusal log) so a conversation choice can't
      // accidentally bankrupt the player past zero. Authors who want a
      // visible "can you afford this?" branch should gate the choice with
      // `balance_cp` upstream.
      const delta = Math.floor(action.deltaCp);
      if (!Number.isFinite(delta) || delta === 0) return;
      const before = ctx.state.player.balanceCp;
      if (delta < 0 && before + delta < 0) {
        ctx.addLog({
          left: action.reason
            ? `You can't afford ${action.reason} — you have ${formatCoinsTrigger(before)}.`
            : `You can't afford that — you have ${formatCoinsTrigger(before)}.`,
          style: 'status',
        });
        return;
      }
      ctx.state.player.balanceCp = before + delta;
      const verb = delta > 0 ? "Received" : "Paid";
      const amount = formatCoinsTrigger(Math.abs(delta));
      const tail = action.reason ? ` (${action.reason})` : "";
      ctx.addLog({
        left: `${verb} ${amount}${tail}. Purse: ${formatCoinsTrigger(ctx.state.player.balanceCp)}.`,
        style: delta > 0 ? 'heal' : 'status',
      });
      return;
    }
    // ── Conversation system ────────────────────────────────────────────
    case 'start_conversation':
      startConversation(ctx, action.npcRef, action.conversationId);
      return;
    case 'end_conversation':
      endConversation(ctx);
      return;
    case 'set_conversation_node':
      setConversationNode(ctx, action.nodeId);
      return;
    // ── NPC persistence ────────────────────────────────────────────────
    case 'npc_remember':
      applyNpcRemember(ctx, action.ref, action.fact, action.value, action.source ?? 'authored');
      return;
    case 'npc_forget':
      applyNpcForget(ctx, action.ref, action.fact);
      return;
    case 'npc_adjust_relationship':
      applyNpcAdjustRelationship(ctx, action.ref, action.target, action.delta);
      return;
    case 'npc_record_journal':
      applyNpcRecordJournal(ctx, action.ref, action.text, action.source ?? 'authored', action.salience);
      return;
    case 'npc_set_arc_phase':
      applyNpcSetArcPhase(ctx, action.ref, action.phase);
      return;
  }
}

function clampDuration(raw: number, max: number): number {
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return Math.min(max, Math.floor(raw));
}

/**
 * If the NPC's current tile is also occupied by the player or another
 * living NPC, move them to the nearest free passable tile in expanding
 * rings (Chebyshev). Called from the `set_npc_hidden { hidden: false }`
 * reveal path so a trigger-locked NPC that was sitting under the player's
 * feet (player walked through their incorporeal tile) doesn't end up
 * sharing the cell once they materialise. No-op when the tile is already
 * free or when no free tile is reachable within 8 rings (silently leaves
 * the NPC on their tile in the pathological case).
 */
function bumpOffOccupiedTile(ctx: GameContext, npc: import('./types.js').NpcState): void {
  const s = ctx.state;
  const overlapsPlayer = s.player.tileX === npc.tileX && s.player.tileY === npc.tileY;
  const overlapsOther = s.npcs.some((n) => n !== npc && n.hp > 0 && n.tileX === npc.tileX && n.tileY === npc.tileY);
  if (!overlapsPlayer && !overlapsOther) return;
  const { cols, rows, passable } = s.map;
  const occupied = new Set<string>([
    `${s.player.tileX},${s.player.tileY}`,
    ...s.npcs.filter((n) => n.hp > 0 && n !== npc).map((n) => `${n.tileX},${n.tileY}`),
  ]);
  for (let dist = 1; dist <= 8; dist++) {
    for (let dc = -dist; dc <= dist; dc++) {
      for (let dr = -dist; dr <= dist; dr++) {
        if (Math.abs(dc) !== dist && Math.abs(dr) !== dist) continue;
        const tc = npc.tileX + dc, tr = npc.tileY + dr;
        if (tc < 0 || tc >= cols || tr < 0 || tr >= rows) continue;
        if (!passable[tr][tc]) continue;
        if (occupied.has(`${tc},${tr}`)) continue;
        npc.tileX = tc;
        npc.tileY = tr;
        return;
      }
    }
  }
}

// ── Faction & rumor helpers (also called from AIGMTools) ─────────────────────

/**
 * Adjust the player's standing with a faction. Writes go to both the legacy
 * `factionStandings` projection AND the full `factionRelations` matrix (party
 * row, mirrored — `setRelation` handles both) so the new matrix-driven
 * readers see the same view as the existing `faction_standing` guards.
 */
export function adjustFactionStanding(ctx: GameContext, factionId: string, delta: number): void {
  const s = ctx.state;
  const oldValue = s.factionStandings[factionId] ?? 0;
  const newValue = Math.max(-100, Math.min(100, oldValue + delta));
  s.factionStandings[factionId] = newValue;
  // Mirror into the full matrix (party row both ways). `setRelation` clamps
  // again on the matrix side, but we've already clamped above.
  setRelation(s, PLAYER_FACTION_ID, factionId, newValue);
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
