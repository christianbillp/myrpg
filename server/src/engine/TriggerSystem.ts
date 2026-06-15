import type { GameContext } from './GameContext.js';
import type {
  EncounterTrigger, WhenClause, TriggerGuard, TriggerAction,
  EngineEvent, ComparisonOp, GameEvent,
} from './types.js';
import { pickNarrationVariant } from './NarrationSystem.js';
// Runtime-only use (inside the start_quest action handler) — the QuestSystem ↔
// TriggerSystem cycle is safe because neither calls the other at module eval.
import { startQuest } from './QuestSystem.js';
import { d20 as d20Local } from './Dice.js';
import { setRelation, adjustRelation } from './FactionRelations.js';
import { setIndividualRelation, adjustIndividualRelation, reprojectAllDispositions, relation } from './Relationships.js';
import { isDead } from './ConditionSystem.js';
import { registerHazardZone } from './HazardSystem.js';
import { PLAYER_FACTION_ID, PLAYER_ID } from '../../../shared/types.js';
import { formatCoins as formatCoinsTrigger } from '../../../shared/currency.js';
import { Logger } from '../Logger.js';
import { generateQuest } from '../quest/questGenerator.js';
import type { QuestTypeId } from '../quest/questGenTypes.js';
import {
  recordQuest,
  dropQuest,
  getQuest,
  isGeneratedEncounterId,
  getGeneratedMapTilesets,
} from '../quest/questRegistry.js';
import { parseStageEncounterId } from '../quest/questIds.js';
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
  const warn = (msg: string) => {
    console.warn(`[TriggerSystem] trigger '${trigger.id}': ${msg}`);
    Logger.warn('anomaly.trigger_validation', { triggerId: trigger.id, message: msg });
  };

  const validEvents: WhenClause['event'][] = [
    'player_moved', 'npc_killed', 'item_picked_up',
    'turn_started', 'turn_ended', 'combat_started', 'combat_ended', 'combat_round',
    'encounter_started', 'encounter_completed',
    'damage_dealt', 'hp_threshold_crossed', 'faction_changed', 'flag_set', 'custom',
    'spell_cast', 'help_used', 'study_feature', 'magic_feature',
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
  // Runtime instance ids assigned by `SpawnHelpers.populateNpcs` —
  // `${defId}` for singletons, `${defId}_${ordinal}` for duplicates. Used
  // by per-instance disposition flips (`set_disposition_by_def_id` accepts
  // either a bare def or an instance id), so the validation below treats
  // a hit on either set as "spawned".
  const spawnedInstanceIds = new Set(ctx.state.npcs.map((n) => n.id));

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
    if (a.type === 'set_npc_companion'
        && !spawnedDefIds.has(a.defId)
        && !spawnedInstanceIds.has(a.defId)) {
      warn(`set_npc_companion defId "${a.defId}" doesn't match any spawned NPC's defId or instance id — action will no-op`);
    }
    if (a.type === 'set_disposition_by_def_id'
        && !spawnedDefIds.has(a.defId)
        && !spawnedInstanceIds.has(a.defId)) {
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

  Logger.log('trigger.fired', {
    triggerId: trigger.id,
    eventType: event.type,
    actions: trigger.then.map((a) => a.type),
  });

  // Mark fired BEFORE running the actions: a once-trigger whose actions publish
  // an event that re-matches it (e.g. a `set_flag` re-entering on `flag_set`)
  // would otherwise re-fire within the same synchronous cascade.
  if (once) ctx.state.firedTriggerIds.push(trigger.id);

  for (const action of trigger.then) fireAction(ctx, action);
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
      if (when.in_zone && !when.in_zone.cells.includes(`${e.x},${e.y}`)) return false;
      return true;
    }
    case 'study_feature': {
      const e = event as Extract<EngineEvent, { type: 'study_feature' }>;
      return when.tile.x === e.x && when.tile.y === e.y;
    }
    case 'magic_feature': {
      const e = event as Extract<EngineEvent, { type: 'magic_feature' }>;
      return when.tile.x === e.x && when.tile.y === e.y;
    }
    case 'npc_killed': {
      const e = event as Extract<EngineEvent, { type: 'npc_killed' }>;
      return when.defId === undefined || when.defId === e.defId;
    }
    case 'spell_cast': {
      const e = event as Extract<EngineEvent, { type: 'spell_cast' }>;
      return (when.spellId === undefined || when.spellId === e.spellId)
        && (when.school === undefined || when.school === e.school);
    }
    case 'help_used': {
      const e = event as Extract<EngineEvent, { type: 'help_used' }>;
      return (when.targetId === undefined || when.targetId === e.targetId)
        && (when.targetDefId === undefined || when.targetDefId === e.targetDefId);
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
    case 'combat_round': {
      const e = event as Extract<EngineEvent, { type: 'combat_round' }>;
      if (when.round !== undefined) return e.round === when.round;
      if (when.atLeast !== undefined) return e.round >= when.atLeast;
      return true;
    }
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

export function guardHolds(ctx: GameContext, guard: TriggerGuard): boolean {
  const s = ctx.state;
  switch (guard.type) {
    // `set` / `unset` are truthiness, not mere presence: authors clear a flag
    // by writing `value: false` (or `0` / `""`), not by deleting it — e.g. the
    // bureau cycle does `set_flag mission_pending false` on turn-in. Treating a
    // cleared flag as still "set" would surface contradictory dialogue choices.
    case 'flag_set':
      return !!s.worldFlags[guard.name];
    case 'flag_unset':
      return !s.worldFlags[guard.name];
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
    case 'individual_relation':
      return compare(relation(s, guard.a, guard.b), guard.op, guard.value);
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
/**
 * Trigger-action handler registry. One entry per `TriggerAction.type`.
 *
 * Generic `Registry<TriggerAction>` enforces compile-time exhaustiveness:
 * adding a new `TriggerAction` variant without registering a handler is
 * a TS error. Handlers receive the narrowed `action` shape so e.g.
 * `a.monsterId` only exists for the spawn cases.
 *
 * Adding a new trigger action = add the variant to `TriggerAction` +
 * one entry here. No central switch to keep in sync.
 */
type TriggerHandler<K extends TriggerAction['type']> = (
  ctx: GameContext,
  action: Extract<TriggerAction, { type: K }>,
) => void;

type TriggerRegistry = { [K in TriggerAction['type']]: TriggerHandler<K> };

const TRIGGER_ACTIONS: TriggerRegistry = {
  spawn_enemy_near_player: (ctx, a) => {
    const spawned = ctx.spawnEnemyNearPlayer(a.monsterId, a.minDist, a.maxDist);
    if (spawned) ctx.addLog({ left: `⚔ ${spawned.name} appears!`, style: 'header' });
  },
  spawn_enemy_at: (ctx, a) => {
    const spawned = ctx.spawnEnemyAt(a.monsterId, a.x, a.y);
    if (spawned) ctx.addLog({ left: `⚔ ${spawned.name} appears!`, style: 'header' });
  },
  show_log: (ctx, a) => {
    ctx.addLog({ left: a.message, style: 'header' });
  },
  send_aigm_message: (ctx, a) => {
    ctx.state.pendingAigmEvents.push(a.message);
  },
  narrate: (ctx, a) => {
    const text = pickNarrationVariant(ctx, a.narrationId);
    if (text) ctx.addLog({ left: text, style: 'header' });
  },
  set_flag: (ctx, a) => {
    ctx.state.worldFlags[a.name] = a.value;
    // Publishing flag_set lets other triggers fan out off a flag change.
    ctx.publish({ type: 'flag_set', name: a.name, value: a.value });
  },
  set_objective: (ctx, a) => {
    const text = a.text.trim();
    if (!text || ctx.state.objective === text) return;
    ctx.state.objective = text;
    ctx.addLog({ left: `New objective: ${text}`, style: 'status' });
  },
  start_quest: (ctx, a) => {
    const def = ctx.defs.quests.find((q) => q.id === a.questId);
    if (def) startQuest(ctx, def);
  },
  pick_random_value: (ctx, a) => {
    if (!Array.isArray(a.values) || a.values.length === 0) return;
    const pick = a.values[Math.floor(Math.random() * a.values.length)];
    ctx.state.worldFlags[a.name] = pick;
    ctx.publish({ type: 'flag_set', name: a.name, value: pick });
  },
  award_mission_reward: (ctx) => {
    // Coin only. XP is granted by the generated quest's steps (the quest system
    // owns XP), so paying it here too would double-count — the offer's XP line
    // is the sum of those step rewards.
    const cp = ctx.state.worldFlags['mission_offer_reward_cp'];
    if (typeof cp === 'number' && cp > 0) {
      ctx.state.player.balanceCp += cp;
      ctx.addLog({
        left: `Received ${formatCoinsTrigger(cp)} (Bureau contract pay).`,
        style: 'heal',
      });
    }
    // Reward paid — the procedurally-generated mission has done its
    // job. Drop it from the registry so a long Bureau-office session
    // doesn't accumulate stale entries. `pending` is the LAST one
    // that was rolled (still set until the conversation's "Got
    // another?" branch generates the next).
    const pending = ctx.state.worldFlags['mission_pending'];
    if (typeof pending === 'string' && isGeneratedEncounterId(pending)) {
      dropQuest(pending);
    }
  },
  generate_mission_contract: (ctx) => {
    const last = ctx.state.worldFlags['mission_last_type'];
    const quest = generateQuest({
      playerLevel: ctx.playerDef.level ?? 1,
      monsters: ctx.defs.monsters,
      tilesets: getGeneratedMapTilesets(),
      rng: Math.random,
      lastType: typeof last === 'string' ? (last as QuestTypeId) : undefined,
    });
    recordQuest(quest);
    // Set the flags the conversation offer / TO MISSION button read.
    const setFlag = (name: string, value: number | string | boolean): void => {
      ctx.state.worldFlags[name] = value;
      ctx.publish({ type: 'flag_set', name, value });
    };
    setFlag('mission_pending', quest.baseEncounterId);
    if (ctx.state.currentEncounterId) setFlag('mission_hub_id', ctx.state.currentEncounterId);
    setFlag('mission_offer_type', quest.type);
    setFlag('mission_offer_objective', quest.offer.objective);
    setFlag('mission_offer_reward_cp', quest.reward.cpDelta);
    setFlag('mission_offer_reward_xp', quest.reward.xp);
    setFlag('mission_last_type', quest.type);
  },
  begin_generated_quest: (ctx) => {
    const here = ctx.state.currentEncounterId;
    if (!here) return;
    const quest = getQuest(parseStageEncounterId(here).baseId);
    if (!quest) return;
    // Already active (a later stage of a multi-encounter quest)? Don't restart.
    if (ctx.state.quests.some((q) => q.questId === quest.questId && q.status === 'active')) return;
    startQuest(ctx, quest.questDef);
  },
  apply_condition_to_player: (ctx, a) => {
    if (!ctx.state.player.conditions.includes(a.condition)) {
      ctx.state.player.conditions.push(a.condition);
      ctx.addLog({ left: `${ctx.playerDef.name} is now ${a.condition}`, style: 'status' });
    }
  },
  emit_event: (ctx, a) => {
    // Only `custom` events can be authored — engine-canonical events
    // (npc_killed, damage_dealt, …) must originate from the engine.
    ctx.publish({ type: 'custom', name: a.name, payload: a.payload });
  },
  adjust_faction_standing: (ctx, a) => {
    adjustFactionStanding(ctx, a.factionId, a.delta);
  },
  record_rumor: (ctx, a) => {
    recordRumor(ctx, a.id, a.text, a.salience ?? 5);
  },
  adjust_faction_relation: (ctx, a) => {
    const before = ctx.state.factionRelations[a.a]?.[a.b] ?? 0;
    adjustRelation(ctx.state, a.a, a.b, a.delta, { mirror: a.mirror ?? true });
    const after = ctx.state.factionRelations[a.a]?.[a.b] ?? 0;
    if (a.a === PLAYER_FACTION_ID) ctx.publish({ type: 'faction_changed', factionId: a.b, oldValue: before, newValue: after });
    else if (a.b === PLAYER_FACTION_ID) ctx.publish({ type: 'faction_changed', factionId: a.a, oldValue: before, newValue: after });
  },
  set_faction_relation: (ctx, a) => {
    const before = ctx.state.factionRelations[a.a]?.[a.b] ?? 0;
    setRelation(ctx.state, a.a, a.b, a.value, { mirror: a.mirror ?? true });
    const after = ctx.state.factionRelations[a.a]?.[a.b] ?? 0;
    if (a.a === PLAYER_FACTION_ID) ctx.publish({ type: 'faction_changed', factionId: a.b, oldValue: before, newValue: after });
    else if (a.b === PLAYER_FACTION_ID) ctx.publish({ type: 'faction_changed', factionId: a.a, oldValue: before, newValue: after });
  },
  set_individual_relation: (ctx, a) => {
    setIndividualRelation(ctx.state, a.a, a.b, a.value, { mirror: a.mirror ?? true });
    reprojectAllDispositions(ctx.state);
  },
  adjust_individual_relation: (ctx, a) => {
    adjustIndividualRelation(ctx.state, a.a, a.b, a.delta, { mirror: a.mirror ?? true });
    reprojectAllDispositions(ctx.state);
  },
  reveal_faction: (ctx, a) => {
    if (!ctx.state.discoveredFactions.includes(a.factionId)) {
      ctx.state.discoveredFactions.push(a.factionId);
    }
  },
  set_npc_dead: (ctx, a) => {
    // Mark every matching NPC as a corpse. Drops inventory unless opted out;
    // attaches optional one-shot search payload.
    const dropInventory = a.dropInventory !== false;
    for (const npc of ctx.state.npcs.filter((n) => n.defId === a.defId)) {
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
      if (a.corpseSearch) npc.corpseSearch = { ...a.corpseSearch };
      // Withhold the corpse from the client until the player has line of sight
      // to it (the `hidden` condition is living-only and stripped above, so
      // corpses need their own LOS gate). The passive sweep flips `seen`.
      if (a.hiddenUntilSeen) { npc.hiddenUntilSeen = true; npc.seen = false; }
    }
  },
  set_npc_hidden: (ctx, a) => {
    // Hide/reveal every living NPC matching `defId`. Default DC from
    // monster's stealthBonus + 10. On reveal, bumps off occupied tiles.
    for (const npc of ctx.state.npcs.filter((n) => n.defId === a.defId && n.hp > 0)) {
      if (a.hidden) {
        if (!npc.conditions.includes('hidden')) npc.conditions.push('hidden');
        if (typeof a.hideDC === 'number') {
          npc.hideDC = a.hideDC;
        } else if (typeof npc.hideDC !== 'number') {
          const def = ctx.resolveMonsterDef(npc.defId);
          npc.hideDC = 10 + (def?.stealthBonus ?? 0);
        }
        npc.revealedByTrigger = a.revealedBy === 'trigger';
      } else {
        npc.conditions = npc.conditions.filter((c) => c !== 'hidden' && c !== 'invisible');
        npc.hideDC = undefined;
        npc.revealedByTrigger = undefined;
        bumpOffOccupiedTile(ctx, npc);
      }
    }
  },
  npc_leaves: (ctx, a) => {
    // Flag matching NPCs to walk off the map. The exploration world-tick
    // (WorldTick.runOffCameraTick) steps them toward the nearest edge and
    // removes them on arrival. Idempotent; combat-flagged NPCs just freeze
    // until exploration resumes.
    for (const npc of ctx.state.npcs.filter((n) => n.defId === a.defId && n.hp > 0)) {
      npc.leaving = true;
    }
  },
  move_npc: (ctx, a) => {
    // Authored-content twin of the AIGM `move_entity` tool: relocate every
    // living NPC matching the def (or instance) id to the given tile.
    // `walk` (default) emits the BFS path as `entity_move` steps so the
    // client animates a visible approach; `teleport` snaps. A blocked or
    // occupied destination bumps to the nearest free passable tile; an
    // unreachable walk falls back to teleporting.
    const s = ctx.state;
    const { cols, rows, blocksMovement } = s.map;
    const matches = s.npcs.filter((n) => (n.defId === a.defId || n.id === a.defId) && n.hp > 0);
    for (const npc of matches) {
      let tx = Math.max(0, Math.min(cols - 1, Math.floor(a.x)));
      let ty = Math.max(0, Math.min(rows - 1, Math.floor(a.y)));
      const occupied = new Set<string>([
        `${s.player.tileX},${s.player.tileY}`,
        ...s.npcs.filter((n) => n !== npc && n.hp > 0).map((n) => `${n.tileX},${n.tileY}`),
      ]);
      if (blocksMovement[ty][tx] || occupied.has(`${tx},${ty}`)) {
        const free = nearestFreeTile(ctx, tx, ty, occupied);
        if (!free) continue; // pathological: nowhere to stand — leave in place
        [tx, ty] = free;
      }
      if ((a.mode ?? 'walk') === 'walk') {
        const path = bfsPath(ctx, npc.tileX, npc.tileY, tx, ty, occupied);
        if (path) {
          for (const [px, py] of path) {
            ctx.eventSink?.push({ type: 'entity_move', entityId: npc.id, toX: px, toY: py });
          }
        }
        // No path (sealed off) — snap; the position must still change.
      }
      npc.tileX = tx;
      npc.tileY = ty;
      if ((a.mode ?? 'walk') === 'teleport') {
        ctx.eventSink?.push({ type: 'entity_move', entityId: npc.id, toX: tx, toY: ty });
      }
    }
  },
  set_npc_companion: (ctx, a) => {
    // Promote / demote every matching NPC. `defId` accepts either a bare
    // def id (`"guard"` → every guard) or an instance id (`"guard_3"` →
    // just that one). Existing companion's simState survives re-fires.
    const followMode = a.followMode ?? 'loose';
    for (const npc of ctx.state.npcs.filter((n) =>
      (n.defId === a.defId || n.id === a.defId) && n.hp > 0,
    )) {
      if (a.isCompanion) {
        if (!npc.companion) {
          npc.companion = {
            followMode,
            simState: { activeTaskId: null, lastTickId: 0 },
          };
        } else {
          npc.companion.followMode = followMode;
        }
        npc.disposition = 'ally';
      } else {
        npc.companion = undefined;
        npc.disposition = a.returnDisposition ?? 'neutral';
      }
    }
  },
  set_disposition_by_def_id: (ctx, a) => {
    // Write the player↔NPC *individual* relationship for each matched NPC;
    // disposition is then a projection. A bare `defId` (not an instance id) is a
    // faction-wide flip, so it also moves the faction baseline so unaffected
    // members / future spawns inherit it; an instance id touches only that NPC.
    const standingByDisp = a.disposition === 'enemy' ? -100
                          : a.disposition === 'ally' ? 100
                          : 0;
    const isInstanceTargeted = ctx.state.npcs.some((n) => n.id === a.defId);
    const matches = ctx.state.npcs.filter((n) =>
      n.hp > 0 && (n.defId === a.defId || n.id === a.defId),
    );
    const touchedFactions = new Set<string>();
    for (const npc of matches) {
      if (a.disposition === 'ally') {
        setIndividualRelation(ctx.state, npc.id, PLAYER_ID, 100, { mirror: true });
        npc.disposition = 'ally';
      } else if (a.disposition === 'enemy') {
        setIndividualRelation(ctx.state, npc.id, PLAYER_ID, -100);
      } else {
        setIndividualRelation(ctx.state, npc.id, PLAYER_ID, 0, { mirror: true });
      }
      if ((a.disposition === 'ally' || a.disposition === 'enemy') && !npc.combatLabel) {
        ctx.assignCombatLabel(npc);
      }
      touchedFactions.add(npc.factionId);
    }
    if (!isInstanceTargeted) {
      for (const factionId of touchedFactions) {
        setRelation(ctx.state, factionId, PLAYER_FACTION_ID, standingByDisp);
      }
    }
    reprojectAllDispositions(ctx.state);
    // A flip during combat adds the NPC to the initiative order (at the end,
    // mirroring AIGM-spawned reinforcements) — initiative is rolled once at
    // combat start, so without this a mid-fight joiner never gets a turn.
    // Gate on the turn order EXISTING rather than on phase: a combat_started
    // trigger fires while session construction still reads phase 'exploring'
    // (the deferred-turn-advance window), and endCombat clears the array, so
    // a non-empty turnOrderIds is the reliable "combat is live" signal.
    if (ctx.state.turnOrderIds.length > 0) {
      for (const npc of matches) {
        if (npc.disposition !== 'neutral' && !ctx.state.turnOrderIds.includes(npc.id)) {
          ctx.state.turnOrderIds.push(npc.id);
        }
      }
    }
  },
  trigger_combat: (ctx) => {
    if (ctx.state.phase !== 'exploring') return;
    if (!ctx.state.npcs.some((n) => n.disposition === 'enemy' && n.hp > 0)) return;
    const sink = ctx.eventSink ?? [];
    ctx.doStartCombat(sink);
  },
  fail_encounter: (ctx, a) => {
    // Objective-driven defeat (US-131): the player failed (escort died, timer
    // ran out, hold lost). Idempotent — no-op if the encounter already resolved.
    const s = ctx.state;
    if (s.phase === 'defeat' || s.encounterComplete) return;
    s.phase = 'defeat';
    ctx.addLog({ left: a.reason?.trim() || 'You have failed.', style: 'kill' });
  },
  spawn_hazard: (ctx, a) => {
    registerHazardZone(ctx, {
      x: a.x, y: a.y, sizeFeet: a.sizeFeet, name: a.name, tintHex: a.tintHex,
      dice: a.dice, sides: a.sides, bonus: a.bonus, damageType: a.damageType,
      saveAbility: a.saveAbility, saveDC: a.saveDC, halfOnSave: a.halfOnSave,
      spreads: a.spreads, maxTiles: a.maxTiles, rounds: a.rounds,
    });
  },
  award_xp: (ctx, a) => {
    // Authored story XP — kill XP is awarded automatically by the kill resolver.
    const amount = Math.max(0, Math.floor(a.amount));
    if (amount <= 0) return;
    ctx.state.player.xp += amount;
    ctx.addLog({ left: `+${amount} XP`, style: 'status' });
  },
  player_ability_check: (ctx, a) => {
    // Roll intentionally NOT logged so a failed check leaks no info.
    const bonus = ctx.playerDef.skills[a.skill] ?? 0;
    const roll = d20Local();
    const total = roll + bonus;
    const branch = total >= a.dc ? a.onPass : a.onFail;
    for (const sub of branch) fireAction(ctx, sub);
  },
  random_action: (ctx, a) => {
    // Mid-fight complication / Director twist (#39): pick ONE of the `choices`
    // action-sets at random and run it, so the same encounter throws a
    // different wrench each playthrough. Each choice is itself a list of
    // actions, run in order via the canonical `fireAction` path.
    if (!Array.isArray(a.choices) || a.choices.length === 0) return;
    const idx = Math.floor(Math.random() * a.choices.length);
    for (const sub of a.choices[idx]) fireAction(ctx, sub);
  },
  show_announcement: (ctx, a) => {
    const text = a.text.trim();
    if (!text) return;
    ctx.addLog(text);
    const sink = ctx.eventSink;
    if (!sink) return;
    const mode: 'focused' | 'unfocused' = a.mode === 'unfocused' ? 'unfocused' : 'focused';
    const ev: GameEvent = a.durationMs !== undefined
      ? { type: 'announcement', text, durationMs: clampDuration(a.durationMs, 15000), mode }
      : { type: 'announcement', text, mode };
    sink.push(ev);
  },
  npc_speaks: (ctx, a) => {
    const text = a.text.trim();
    if (!text) return;
    let entityId: string | null = null;
    let speakerName: string | null = null;
    if (a.entity === 'player') {
      entityId = 'player';
      speakerName = ctx.playerDef.name;
    } else {
      const npc = ctx.resolveNpcByEntity(a.entity);
      // The dead don't deliver authored lines — a trigger written against a
      // specific instance (e.g. an elf who may have fallen earlier in the
      // fight) silently skips rather than speaking from a corpse.
      if (npc && !isDead(npc)) {
        entityId = npc.id;
        speakerName = npc.revealedName ?? npc.name;
      }
    }
    if (!entityId || !speakerName) return;
    ctx.addLog({ left: `💬 ${speakerName}: "${text}"`, style: 'status' });
    const sink = ctx.eventSink;
    if (!sink) return;
    sink.push({ type: 'npc_speech', entityId, text, speakerName });
  },
  fade_screen: (ctx, a) => {
    const sink = ctx.eventSink;
    if (!sink) return;
    const durationMs = clampDuration(a.durationMs ?? 1200, 10000);
    sink.push({ type: 'screen_fade', mode: a.mode, durationMs });
  },
  set_long_rest: (ctx, a) => {
    if (ctx.state.allowsLongRest === a.allowed) return;
    ctx.state.allowsLongRest = a.allowed;
    ctx.addLog({
      left: a.allowed ? "You can take a Long Rest here." : "Long Rest is no longer available.",
      style: 'status',
    });
  },
  adjust_player_balance_cp: (ctx, a) => {
    // Positive = award, negative = spend. A spend below zero is refused.
    const delta = Math.floor(a.deltaCp);
    if (!Number.isFinite(delta) || delta === 0) return;
    const before = ctx.state.player.balanceCp;
    if (delta < 0 && before + delta < 0) {
      ctx.addLog({
        left: a.reason
          ? `You can't afford ${a.reason} — you have ${formatCoinsTrigger(before)}.`
          : `You can't afford that — you have ${formatCoinsTrigger(before)}.`,
        style: 'status',
      });
      return;
    }
    ctx.state.player.balanceCp = before + delta;
    const verb = delta > 0 ? "Received" : "Paid";
    const amount = formatCoinsTrigger(Math.abs(delta));
    const tail = a.reason ? ` (${a.reason})` : "";
    ctx.addLog({
      left: `${verb} ${amount}${tail}. Purse: ${formatCoinsTrigger(ctx.state.player.balanceCp)}.`,
      style: delta > 0 ? 'heal' : 'status',
    });
  },
  start_conversation:   (ctx, a) => startConversation(ctx, a.npcRef, a.conversationId),
  end_conversation:     (ctx)    => endConversation(ctx),
  set_conversation_node:(ctx, a) => setConversationNode(ctx, a.nodeId),
  npc_remember:           (ctx, a) => applyNpcRemember(ctx, a.ref, a.fact, a.value, a.source ?? 'authored'),
  npc_forget:             (ctx, a) => applyNpcForget(ctx, a.ref, a.fact),
  npc_adjust_relationship:(ctx, a) => applyNpcAdjustRelationship(ctx, a.ref, a.target, a.delta),
  npc_record_journal:     (ctx, a) => applyNpcRecordJournal(ctx, a.ref, a.text, a.source ?? 'authored', a.salience),
  npc_set_arc_phase:      (ctx, a) => applyNpcSetArcPhase(ctx, a.ref, a.phase),
};

export function fireAction(ctx: GameContext, action: TriggerAction): void {
  const handler = TRIGGER_ACTIONS[action.type] as
    | ((ctx: GameContext, a: TriggerAction) => void)
    | undefined;
  if (handler) handler(ctx, action);
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
  const { cols, rows, blocksMovement } = s.map;
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
        if (blocksMovement[tr][tc]) continue;
        if (occupied.has(`${tc},${tr}`)) continue;
        npc.tileX = tc;
        npc.tileY = tr;
        return;
      }
    }
  }
}

/** Nearest free passable tile to (tx,ty) in expanding Chebyshev rings (≤8),
 *  or null. Shared shape with `bumpOffOccupiedTile`, but returns the tile
 *  instead of mutating — used by `move_npc` destination resolution. */
function nearestFreeTile(
  ctx: GameContext,
  tx: number,
  ty: number,
  occupied: Set<string>,
): [number, number] | null {
  const { cols, rows, blocksMovement } = ctx.state.map;
  for (let dist = 1; dist <= 8; dist++) {
    for (let dc = -dist; dc <= dist; dc++) {
      for (let dr = -dist; dr <= dist; dr++) {
        if (Math.abs(dc) !== dist && Math.abs(dr) !== dist) continue;
        const c = tx + dc, r = ty + dr;
        if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
        if (blocksMovement[r][c] || occupied.has(`${c},${r}`)) continue;
        return [c, r];
      }
    }
  }
  return null;
}

/** 8-way BFS path from (sx,sy) to (tx,ty) over passable, unoccupied tiles
 *  (the destination itself is pre-validated by the caller). Returns the step
 *  list EXCLUDING the start tile, or null when sealed off. Capped at 80
 *  steps — `move_npc` stage moves are short; anything longer snaps. */
function bfsPath(
  ctx: GameContext,
  sx: number, sy: number, tx: number, ty: number,
  occupied: Set<string>,
): Array<[number, number]> | null {
  const { cols, rows, blocksMovement } = ctx.state.map;
  const prev = new Map<string, string | null>([[`${sx},${sy}`, null]]);
  const queue: Array<[number, number]> = [[sx, sy]];
  while (queue.length > 0) {
    const [x, y] = queue.shift()!;
    if (x === tx && y === ty) break;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      const nx = x + dx, ny = y + dy, key = `${nx},${ny}`;
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows || prev.has(key)) continue;
      if (blocksMovement[ny][nx]) continue;
      if (occupied.has(key) && !(nx === tx && ny === ty)) continue;
      prev.set(key, `${x},${y}`);
      queue.push([nx, ny]);
    }
  }
  if (!prev.has(`${tx},${ty}`)) return null;
  const path: Array<[number, number]> = [];
  let cur: string | null = `${tx},${ty}`;
  while (cur && cur !== `${sx},${sy}`) {
    const [cx, cy] = cur.split(',').map(Number);
    path.unshift([cx, cy]);
    cur = prev.get(cur) ?? null;
  }
  return path.length <= 80 ? path : null;
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
