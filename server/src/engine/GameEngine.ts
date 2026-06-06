import {
  GameState, GameEvent, PlayerAction,
  PlayerDef, MonsterDef,
  NpcState, Disposition,
  LogEntry, GameDefs,
  CreateSessionRequest,
} from './types.js';
import type { EncounterContext } from '../encounterService.js';
import {
  rollSkillCheck, rollSavingThrow,
  rollPlayerAttackVsAc, rollNpcAttackVsAc,
} from './CombatSystem.js';
import { applyEquipment, computeEquippedSlotLabels } from './EquipmentSystem.js';
import { chebyshev } from './EnemyAI.js';
import { buildAIGMTools } from './AIGMTools.js';
import { setRelation, getRelation, isHostileTo } from './FactionRelations.js';
import { runOffCameraTick as runOffCameraTickImpl } from './WorldTick.js';
import { PLAYER_FACTION_ID, INFLUENCE_SKILLS } from '../../../shared/types.js';
import { SKILL_ABILITY } from './Leveling.js';
import { Logger } from '../Logger.js';
import * as Guard from './ActionGuards.js';
import { clearHide, isDead } from './ConditionSystem.js';
import type { GameContext } from './GameContext.js';
import {
  endCombat as cfEndCombat, autoEndCombatIfNoEnemies as cfAutoEndCombat,
  triggerCombat as cfTriggerCombat, doStartCombat as cfDoStartCombat,
  enterEnemyPhase as cfEnterEnemyPhase, doRollDeathSave as cfDoRollDeathSave,
  endPlayerTurn as cfEndPlayerTurn,
  doResolveReaction as cfDoResolveReaction,
  advanceTurn as cfAdvanceTurn,
} from './CombatFlow.js';
import {
  doAttack as caDoAttack, throwItem as caThrowItem,
  doHide as caDoHide, doDash as caDoDash, doDodge as caDoDodge,
  doDisengage as caDoDisengage, doDetach as caDoDetach,
  doPlayerOpportunityAttack as caDoPlayerOA, withinShoveGrappleSize,
} from './CombatActions.js';
import {
  doMove as exDoMove, doMoveTo as exDoMoveTo,
  doSearch as exDoSearch, doShortRest as exDoShortRest, doUsePotion as exDoUsePotion,
} from './ExplorationActions.js';
import { doEquip as ivDoEquip, doUnequip as ivDoUnequip } from './InventoryActions.js';
import { doCastSpell as spDoCastSpell } from './SpellSystem.js';
import { isDeployableGear } from './TrapSystem.js';
import { doCommandSummon, checkSummonTether, registerSummonHooks } from './SummonSystem.js';
import { registerSoundHooks } from './Sound.js';
import { registerAwarenessHooks, registerCompanionFollowHooks } from './npcSim/index.js';
import { maybeBreakConcentration, endConcentration } from './ConcentrationSystem.js';
import { doUseFeature } from './FeatureRegistry.js';
import { buildSessionState, SavedMapRecord } from './SessionBuilder.js';
import { registerTriggers, adjustFactionStanding, recordRumor, fireAction as triggerFireAction } from './TriggerSystem.js';
import {
  startConversation as cnStartConversation,
  advanceConversation as cnAdvanceConversation,
  endConversation as cnEndConversation,
} from './ConversationSystem.js';
import { registerDirector } from './Director.js';
import { registerEncounterProgress } from './EncounterProgress.js';
import { registerEncounterLifecycle, publishEncounterStarted } from './EncounterLifecycle.js';
import { EventBus } from './EventBus.js';
import { publishHpThresholdCrossings } from './ThresholdPublisher.js';
import { WeaponDef } from './types.js';
import { buildLevelUpPreview, applyLevelUp, applyLevelUpHistory, syncCharacterTracks } from './Leveling.js';
import { canLevelUp } from '../../../shared/xpTable.js';
import type { LevelUpPreview, LevelUpChoices, LongRestPreview, LongRestChoices, ClassDef } from '../../../shared/types.js';
import { buildLongRestPreview, applyLongRest } from './Resting.js';
import { dispatchPlayerAction } from './playerActions/registry.js';

export interface ActionResult {
  events: GameEvent[];
  state: GameState;
}

/**
 * Engine-wide event subscribers, in registration order. Order matters
 * only when two systems subscribe to the same event with the same
 * priority — register-order wins. Otherwise priorities (set by each
 * subscriber inline) sort the dispatch.
 *
 * Adding a new engine system = drop one `register*Hooks(ctx)` line
 * here. The constructor wires the whole array in one loop.
 */
const ENGINE_HOOKS: Array<(ctx: GameContext) => void> = [
  registerDirector,
  registerEncounterProgress,
  registerEncounterLifecycle,
  registerTriggers,
  registerSummonHooks,
  registerSoundHooks,
  registerAwarenessHooks,
  registerCompanionFollowHooks,
];

let uidCounter = 0;

export class GameEngine {
  private state: GameState;
  private defs: GameDefs;
  private playerDef: PlayerDef;
  private ctx: GameContext;
  private bus: EventBus;
  /** GameEvents emitted during session construction (notably by triggers fired
   *  from `encounter_started`). The WS handler flushes these onto the first
   *  state_update so intro cinematics land the moment the client connects.
   *  See `consumeStartupEvents()`. */
  private startupEvents: GameEvent[] = [];

  constructor(state: GameState, defs: GameDefs, levelUpHistory: LevelUpChoices[] = []) {
    this.state = state;
    this.bus = new EventBus();
    // Clone the player def so per-session equipment mutations never leak into the
    // shared GameDefs (which is reused across every session in the process).
    const sharedDef = defs.playerDefs.find((p) => p.id === state.player.defId)!;
    this.playerDef = JSON.parse(JSON.stringify(sharedDef));
    // Replay recorded level-ups onto the clone BEFORE applyEquipment so AC /
    // proficiency-bonus-derived skills land at the character's current level.
    if (levelUpHistory.length > 0) {
      applyLevelUpHistory(this.playerDef, levelUpHistory, defs.features, defs.spells, defs.classes, defs.subclasses, defs.feats);
    }
    // Project the class's per-level scaling tracks onto the clone so engine
    // subsystems can read `playerDef.tracks[id]` regardless of how the
    // character got to this level (fresh build, level-up replay, AIGM
    // forced advancement). Idempotent — safe to run after the replay above.
    syncCharacterTracks(this.playerDef, defs.classes);
    // Dev mode `unlockAllSpells` — widen the cloned playerDef's spellbook
    // and cantrip list so `castableSpellIds` treats every spell of the
    // character's class as known. Cantrips need explicit treatment because
    // `canCastSpell` checks `defaultCantripIds` for level-0 spells (not
    // `defaultSpellbookIds`). Other classes that don't consult either
    // remain unaffected. The clone above guarantees this mutation stays
    // scoped to the current session.
    if (state.devFlags?.unlockAllSpells) {
      const className = this.playerDef.className?.toLowerCase();
      const allSpellsForClass = className
        ? defs.spells.filter((sp) => sp.classes.includes(className))
        : defs.spells;
      this.playerDef.defaultSpellbookIds = allSpellsForClass.filter((sp) => sp.level > 0).map((sp) => sp.id);
      this.playerDef.defaultCantripIds   = allSpellsForClass.filter((sp) => sp.level === 0).map((sp) => sp.id);
    }
    this.defs = {
      ...defs,
      playerDefs: defs.playerDefs.map((p) => p.id === this.playerDef.id ? this.playerDef : p),
    };
    applyEquipment(this.playerDef, state.player.equippedSlots, this.defs.equipment, state.player.mageArmor, state.player.shieldActive);
    state.player.ac = this.playerDef.ac;
    state.player.equippedSlotLabels = computeEquippedSlotLabels(this.playerDef, state.player.equippedSlots, this.defs.equipment);

    for (const npc of state.npcs) npc.inventoryIds ??= [];
    for (const id of [
      ...state.npcs.map((n) => n.id),
      ...state.mapItems.map((i) => i.id),
    ]) {
      const n = parseInt(id.replace(/\D/g, ''), 10);
      if (!isNaN(n) && n >= uidCounter) uidCounter = n + 1;
    }

    this.ctx = this.buildCtx();
    // Register engine-level subscribers AFTER ctx is built so they can
    // publish further events during their handlers. Director runs at higher
    // priority than triggers (50 vs -10) so directorial decisions arrive
    // before authored reactions to the same event.
    for (const register of ENGINE_HOOKS) register(this.ctx);

    // Fire encounter_started AFTER every subscriber is registered. Triggers
    // listening on this event push their GameEvents into the startup buffer
    // (point ctx.eventSink at it for the duration of the publish call), and
    // the WS handler flushes that buffer onto the first state_update so any
    // intro cinematic plays the moment the client connects.
    this.ctx.eventSink = this.startupEvents;
    this.ctx.isConstructing = true;
    try {
      publishEncounterStarted(this.ctx);
      // Auto-prepend the encounter title supertitle so every scene opens with
      // the same cinematic location card regardless of authored triggers.
      // The pre-blacked screen (see GameScene.create) sits behind it so the
      // title reads against full black. We also explicitly append a
      // fade_screen 'in' so the world reveals after the title — and so the
      // client's "no fade in startup events → unshift fade-in" guard sees a
      // fade event and doesn't add its own.
      //
      // Dev mode `disableSupertitle` skips the auto-prepend so the encounter
      // starts immediately. We also omit the paired fade-in — the client's
      // "no startup fade → add one" guard will supply a short fade-in on
      // its own, so the world still reveals cleanly.
      const title = this.state.encounterTitle?.trim();
      if (title && !this.state.devFlags?.disableSupertitle) {
        this.startupEvents.unshift({ type: 'supertitle', text: title, durationMs: 2500 });
        this.startupEvents.push({ type: 'screen_fade', mode: 'in', durationMs: 800 });
      }
      // Auto-start combat for encounters that spawned with hostile NPCs.
      // MUST happen inside the isConstructing window so `doStartCombat`
      // sets `pendingTurnAdvance` instead of running the first NPC turn
      // immediately — otherwise the bandits move on the server before the
      // client even connects, and the initial state_update arrives with
      // every enemy already at its post-turn position. The deferred turn
      // is flushed by `runPendingTurnAdvance` once the cinematic queue
      // releases the world pause.
      if (this.anyHostileToParty()) {
        cfTriggerCombat(this.ctx);
      }
    } finally {
      this.ctx.eventSink = null;
      this.ctx.isConstructing = false;
    }
  }

  /** Internal — true when any living NPC is currently hostile to the party.
   *  Mirrors the helper of the same name in `server/src/index.ts`; kept inline
   *  here so `createSession` can decide to auto-start combat while still
   *  holding the `isConstructing` flag. */
  private anyHostileToParty(): boolean {
    const partyView = { factionId: PLAYER_FACTION_ID } as const;
    return this.state.npcs.some((n) => n.hp > 0
      && isHostileTo(this.state, partyView, { factionId: n.factionId, disposition: n.disposition }));
  }

  /** Run the first-turn `advanceTurn` that `doStartCombat` deferred during
   *  session construction, if any. Idempotent — flips
   *  `state.pendingTurnAdvance` off and returns the events that the
   *  resulting NPC turn produced (entity_move, etc.). The WS layer
   *  broadcasts them in a fresh state_update so the client animates them
   *  AFTER the player has dismissed the opening overlay. */
  runPendingTurnAdvance(): GameEvent[] {
    if (!this.state.pendingTurnAdvance) return [];
    this.state.pendingTurnAdvance = false;
    const events: GameEvent[] = [];
    this.ctx.eventSink = events;
    try {
      cfAdvanceTurn(this.ctx, events);
    } finally {
      this.ctx.eventSink = null;
    }
    return events;
  }

  /** Drains and returns the buffer of GameEvents emitted during session
   *  construction (by `encounter_started` triggers). Called once by the WS
   *  handler on initial connection; subsequent calls return an empty array. */
  consumeStartupEvents(): GameEvent[] {
    const out = this.startupEvents;
    this.startupEvents = [];
    return out;
  }

  private buildCtx(): GameContext {
    return {
      state: this.state,
      playerDef: this.playerDef,
      defs: this.defs,
      addLog: (e) => this.addLog(e),
      addLogs: (es) => this.addLogs(es),
      uid: () => `e${++uidCounter}`,
      resolveMonsterDef: (id) => this.resolveMonsterDef(id),
      resolveNpcByEntity: (e) => this.resolveNpcByEntity(e),
      assignCombatLabel: (npc) => this.assignCombatLabel(npc),
      aggroFaction: (npc) => this.aggroFaction(npc),
      autoEndCombatIfNoEnemies: () => this.autoEndCombatIfNoEnemies(),
      resistMod: (d, t, def, n) => this.resistMod(d, t, def, n),
      applyDamageToPlayer: (d, ev, dt) => this.applyDamageToPlayer(d, ev, dt),
      killNpc: (id) => this.killNpc(id),
      killWithReward: (npc, def, msg, t) => this.killWithReward(npc, def, msg, t),
      applyMasteryConditions: (tgt, v, s) => this.applyMasteryConditions(tgt, v, s),
      doStartCombat: (ev) => cfDoStartCombat(this.ctx, ev),
      doPlayerOpportunityAttack: (npc) => caDoPlayerOA(this.ctx, npc),
      spawnEnemyNearPlayer: (id, mn, mx) => this.spawnEnemyNearPlayer(id, mn, mx),
      spawnEnemyAt: (id, tx, ty) => this.spawnEnemyAt(id, tx, ty),
      spawnSummon: (id, spellId, tx, ty) => this.spawnSummon(id, spellId, tx, ty),
      bus: this.bus,
      publish: (event) => this.bus.publish(event),
      removeNpc: (id) => this.removeNpcFromEncounter(id),
      eventSink: null,
      isConstructing: false,
      engineRef: {
        fireSingleAction: (action) => triggerFireAction(this.ctx, action),
        getNpcSaves: () => this.npcSaves,
      },
    };
  }

  /**
   * Removes an NPC from the encounter entirely (different from killNpc which
   * leaves them as a corpse). Used when a fleeing creature escapes off the
   * map edge. Combat auto-ends if no enemies remain.
   */
  private removeNpcFromEncounter(id: string): void {
    const s = this.state;
    s.npcs = s.npcs.filter((n) => n.id !== id);
    // turnOrderIds intentionally untouched — advanceTurn skips ids it can't find.
    this.autoEndCombatIfNoEnemies();
  }

  getState(): GameState {
    // Apply dev-mode resource topups BEFORE computing available actions so
    // the "refilled" state is what drives `availableActions` for the client.
    // This is the single chokepoint every server state push goes through, so
    // resetting here is enough — the player will see slots/actions as
    // available on every tick, regardless of how the underlying consumers
    // decremented them.
    this.applyDevFlagsTopup();
    this.computeAvailableActions();
    return this.state;
  }

  /** Dev-mode normalisation pass — called from `getState`. Idempotent. */
  private applyDevFlagsTopup(): void {
    const flags = this.state.devFlags;
    if (!flags) return;
    const p = this.state.player;
    if (flags.unlimitedActions) {
      p.actionUsed = false;
      p.bonusActionUsed = false;
    }
    if (flags.unlimitedSpellSlots) {
      // Restore each slot to the per-session playerDef's current max. The
      // clone holds any level-up changes, so post-L2 slot counts are
      // honoured. Spell levels with zero starting slots stay at zero — we
      // never invent slots a level wouldn't have.
      const max = this.playerDef.defaultSpellSlots ?? [];
      for (let i = 0; i < max.length; i++) {
        if ((max[i] ?? 0) > 0 && (p.spellSlots[i] ?? 0) < max[i]) {
          p.spellSlots[i] = max[i];
        }
      }
    }
  }
  getMonsterDef(defId: string): MonsterDef | undefined { return this.resolveMonsterDef(defId); }
  /**
   * Run one off-camera world tick (Pass 3c). Resolves one round of NPC-vs-NPC
   * combat in exploration phase. Returns the events the caller should
   * broadcast — typically appended into a `state_update` WebSocket message.
   * The session wrapper is responsible for pause gating before calling.
   */
  runOffCameraTick(): GameEvent[] {
    return runOffCameraTickImpl(this.ctx);
  }
  getSpellDef(spellId: string) { return this.defs.spells.find((sp) => sp.id === spellId); }
  getAIGMTools() { return buildAIGMTools(); }
  getItemIds(): string[] { return this.defs.equipment.map((i) => i.id); }
  getMonsterIds(): string[] { return this.defs.monsters.map((m) => m.id); }

  private resolveMonsterDef(defId: string): MonsterDef | undefined {
    const direct = this.defs.monsters.find((m) => m.id === defId);
    if (direct) return direct;
    const npcDef = this.defs.npcs.find((n) => n.id === defId);
    return npcDef ? this.defs.monsters.find((m) => m.id === npcDef.monsterClass) : undefined;
  }

  processAction(action: PlayerAction): ActionResult {
    const events: GameEvent[] = [];
    this.computeAvailableActions();
    // Expose the events buffer to engine subsystems that don't receive it
    // explicitly (TriggerSystem actions, in particular). Cleared in finally
    // so AIGM-tool / direct-engine callers don't accidentally accumulate
    // entity_move events into the wrong outer call.
    this.ctx.eventSink = events;
    try {

    dispatchPlayerAction(this.ctx, action, events, this);

    // Route through getState() so dev-mode resource topups (unlimited
    // spell slots / unlimited actions) get applied to the state we hand
    // back to the action POST response AND to the broadcast pushStateUpdate
    // that follows. Without this, the action consumed the resource and the
    // top-up never ran for this turn's reply.
    const state = this.getState();
    return { events, state };
    } finally {
      this.ctx.eventSink = null;
    }
  }

  // ── AIGM tool handlers ──────────────────────────────────────────────────────

  adjustPlayerHp(delta: number): GameEvent[] {
    const s = this.state;
    let effective = delta;
    if (effective < 0 && s.player.tempHp > 0) {
      const absorbed = Math.min(s.player.tempHp, -effective);
      s.player.tempHp -= absorbed;
      effective += absorbed;
      this.addLog(`${absorbed} damage absorbed by Temporary HP (${s.player.tempHp} remaining)`);
      if (effective === 0) return [];
    }
    const before = s.player.hp;
    s.player.hp = Math.max(0, Math.min(this.playerDef.maxHp, s.player.hp + effective));
    this.addLog(`HP: ${before} → ${s.player.hp}/${this.playerDef.maxHp}`);
    if (s.player.hp <= 0 && s.phase === 'exploring') s.phase = 'defeat';
    return [];
  }

  awardTempHp(amount: number): GameEvent[] {
    const s = this.state;
    s.player.tempHp = Math.max(s.player.tempHp, amount);
    this.addLog(`Temporary HP: ${s.player.tempHp} (${amount} awarded — using higher value)`);
    return [];
  }

  grantHeroicInspiration(): GameEvent[] {
    this.state.player.heroicInspiration = true;
    this.addLog('Heroic Inspiration granted — you may re-roll any one die.');
    return [];
  }

  setExhaustionLevel(level: number): GameEvent[] {
    const before = this.state.player.exhaustionLevel;
    const clamped = Math.max(0, Math.min(6, level));
    this.state.player.exhaustionLevel = clamped;
    const speedDrop = clamped * 5;
    Logger.log('combat.exhaustion_changed', { entity: 'player', before, after: clamped, speedDropFt: speedDrop });
    this.addLog(`Exhaustion level: ${clamped} (−${clamped * 2} to all D20 Tests, −${speedDrop} ft Speed)`);
    if (clamped >= 6) {
      // SRD: Exhaustion level 6 is lethal.
      Logger.log('combat.player_died', { reason: 'exhaustion_level_6' });
      this.addLog({ left: `${this.playerDef.name} succumbs to exhaustion.`, style: 'kill' });
      this.state.player.hp = 0;
      this.state.phase = 'defeat';
    }
    return [];
  }

  awardXp(amount: number): GameEvent[] {
    this.state.player.xp += amount;
    return [];
  }

  /** Add a signed CP delta to the player's coin purse. Negative deltas spend
   *  coins; the call is a no-op when the spend would put the purse negative. */
  awardCoins(cpDelta: number): GameEvent[] {
    const next = this.state.player.balanceCp + cpDelta;
    if (next < 0) return [];
    this.state.player.balanceCp = next;
    return [];
  }

  adjustNpcHp(entity: string, delta: number, damageType?: string): GameEvent[] {
    if (entity === 'player') return this.adjustPlayerHp(delta);
    const npc = this.resolveNpcByEntity(entity);
    if (!npc) {
      Logger.warn('anomaly.unknown_entity', { tool: 'adjust_npc_hp', entity });
      return [];
    }
    let finalDelta = delta;
    if (damageType && delta < 0) {
      const monsterDef = this.resolveMonsterDef(npc.defId);
      if (monsterDef) {
        const { finalDamage, log: resistLog } = this.resistMod(-delta, damageType, monsterDef, npc.name);
        if (resistLog) this.addLog(resistLog);
        finalDelta = -finalDamage;
      }
    }
    const before = npc.hp;
    npc.hp = Math.max(0, Math.min(npc.maxHp, npc.hp + finalDelta));
    this.addLog(`${npc.name}: ${finalDelta >= 0 ? '+' : ''}${finalDelta} HP (${before} → ${npc.hp})`);
    if (npc.hp === 0) this.killNpc(npc.id);
    return [];
  }

  addLog(entry: LogEntry | string): void {
    this.state.eventLog.push(typeof entry === 'string' ? { left: entry } : entry);
    this.state.logScrollOffset = 0;
  }

  addLogs(entries: (LogEntry | string)[]): void {
    entries.forEach((e) => this.addLog(e));
  }

  /**
   * Teleport an entity to a tile. Returns events + an optional error string
   * the caller can surface back to the AIGM. Validation:
   *   1. Tile must be in-bounds.
   *   2. Tile must be passable per the map's passability layer.
   *   3. Tile must not be occupied by the player or any living NPC (other
   *      than the moving entity itself — a no-op move to the current tile
   *      is allowed and succeeds silently).
   *   4. Entity must resolve. Unknown entity refs return an error.
   * On any failure no state changes and `events` is empty — the AIGM sees
   * the `error` string in the tool result and adjusts its narration.
   */
  moveEntity(entity: string, tileX: number, tileY: number): { events: GameEvent[]; error: string | null } {
    const s = this.state;
    const { cols, rows, blocksMovement } = s.map;

    if (!(tileX >= 0 && tileX < cols && tileY >= 0 && tileY < rows)) {
      return { events: [], error: `tile (${tileX}, ${tileY}) is out of bounds — map is ${cols}×${rows}` };
    }
    if (blocksMovement[tileY]?.[tileX]) {
      return { events: [], error: `tile (${tileX}, ${tileY}) is impassable (wall, water, void, or a non-walkable object)` };
    }

    // Resolve the moving entity. A reference that doesn't match anything is
    // an authoring error worth surfacing — silently failing leaves the AIGM
    // narrating a move the engine never applied.
    let movingNpc: NpcState | null = null;
    let currentX: number, currentY: number;
    if (entity === 'player') {
      currentX = s.player.tileX;
      currentY = s.player.tileY;
    } else {
      const resolved = this.resolveNpcByEntity(entity);
      if (!resolved) {
        return { events: [], error: `entity "${entity}" not found — check CURRENT STATE for valid refs` };
      }
      movingNpc = resolved;
      currentX = movingNpc.tileX;
      currentY = movingNpc.tileY;
    }
    // No-op: moving to the current tile is fine; emit no event.
    if (currentX === tileX && currentY === tileY) {
      return { events: [], error: null };
    }
    // Occupancy check — every living entity OTHER than the mover.
    const playerThere = (entity !== 'player'
      && s.player.tileX === tileX && s.player.tileY === tileY);
    if (playerThere) {
      return { events: [], error: `tile (${tileX}, ${tileY}) is occupied by the player` };
    }
    const blockingNpc = s.npcs.find((n) =>
      n.hp > 0 && n !== movingNpc && n.tileX === tileX && n.tileY === tileY);
    if (blockingNpc) {
      return { events: [], error: `tile (${tileX}, ${tileY}) is occupied by ${blockingNpc.name} (${blockingNpc.id})` };
    }

    // All checks passed — apply.
    if (entity === 'player') {
      s.player.tileX = tileX;
      s.player.tileY = tileY;
      return { events: [{ type: 'entity_move', entityId: 'player', toX: tileX, toY: tileY }], error: null };
    }
    movingNpc!.tileX = tileX;
    movingNpc!.tileY = tileY;
    return { events: [{ type: 'entity_move', entityId: movingNpc!.id, toX: tileX, toY: tileY }], error: null };
  }

  addItem(itemId: string): GameEvent[] {
    const item = this.defs.equipment.find((i) => i.id === itemId);
    if (item) {
      this.state.player.inventoryIds.push(itemId);
      this.addLog(`Received: ${item.name}`);
    }
    return [];
  }

  removeItem(itemId: string): GameEvent[] {
    const idx = this.state.player.inventoryIds.indexOf(itemId);
    if (idx !== -1) this.state.player.inventoryIds.splice(idx, 1);
    return [];
  }

  despawnNpc(entity: string): GameEvent[] {
    const npc = this.resolveNpcByEntity(entity);
    if (!npc) return [];
    this.state.npcs = this.state.npcs.filter((n) => n !== npc);
    this.autoEndCombatIfNoEnemies();
    return [];
  }

  revealNpcName(entity: string, name: string): GameEvent[] {
    const npc = this.resolveNpcByEntity(entity);
    if (!npc) return [];
    npc.revealedName = name;
    return [];
  }

  setNpcPassive(entity: string, passive: boolean): GameEvent[] {
    const npc = this.resolveNpcByEntity(entity);
    if (!npc) return [];
    npc.combatPassive = passive;
    return [];
  }

  spawnEnemy(monsterId: string): GameEvent[] {
    this.spawnEnemyNearPlayer(monsterId);
    return [];
  }

  spawnEnemyNearPlayer(monsterId: string, minDist = 3, maxDist = 8): NpcState | null {
    const s = this.state;
    const [tx, ty] = this.findFreeTileNear(s.player.tileX, s.player.tileY, minDist, maxDist);
    if (tx === -1) return null;
    return this.materializeEnemy(monsterId, tx, ty);
  }

  /**
   * Conjure a player-owned summon (Mage Hand, Unseen Servant) at the chosen
   * tile. Despawns any existing summon of the same `spellId` first — Mage
   * Hand's SRD "vanishes if you cast this spell again" rule.
   *
   * Summons spawn with `disposition: 'ally'`, no combat label, and skip the
   * combat turn loop — they only act when the caster commands them via
   * `commandSummon`. They live in their own faction (the spell id) so they
   * don't interact with the faction-relation matrix.
   */
  spawnSummon(monsterId: string, spellId: string, tx: number, ty: number): NpcState | null {
    const def = this.defs.monsters.find((m) => m.id === monsterId);
    if (!def) return null;
    const s = this.state;

    // Existing summon of this spell → vanish first.
    for (const existing of s.npcs.filter((n) => n.summonSpellId === spellId && n.summonOwnerId === 'player')) {
      this.removeNpcFromEncounter(existing.id);
      this.addLog({ left: `${existing.name} fades away.`, style: 'status' });
    }

    const { cols, rows, blocksMovement } = s.map;
    const occupied = (x: number, y: number): boolean =>
      (s.player.tileX === x && s.player.tileY === y)
      || s.npcs.some((n) => n.hp > 0 && n.tileX === x && n.tileY === y);
    let fx = tx, fy = ty;
    const inBounds = tx >= 0 && tx < cols && ty >= 0 && ty < rows;
    if (!inBounds || blocksMovement[ty][tx] || occupied(tx, ty)) {
      const [nfx, nfy] = this.findFreeTileNear(tx, ty, 0, 6);
      if (nfx === -1) return null;
      fx = nfx; fy = nfy;
    }

    const npc: NpcState = {
      id: `sm${++uidCounter}`,
      defId: def.id,
      name: def.name,
      combatLabel: '',  // summons don't carry a combat label
      tileX: fx, tileY: fy,
      disposition: 'ally',
      attitude: 'friendly',
      factionId: `summon:${spellId}`,
      summonSpellId: spellId,
      summonOwnerId: 'player',
      combatPassive: true,
      hp: def.maxHp, maxHp: def.maxHp,
      isActive: false,
      reactionUsed: false, conditions: [], inventoryIds: [], ongoingEffects: [],
    };
    s.npcs.push(npc);
    return npc;
  }

  spawnEnemyAt(monsterId: string, tx: number, ty: number): NpcState | null {
    const s = this.state;
    const { cols, rows, blocksMovement } = s.map;
    const inBounds = tx >= 0 && tx < cols && ty >= 0 && ty < rows;
    const occupied = (x: number, y: number) =>
      (s.player.tileX === x && s.player.tileY === y)
      || s.npcs.some((n) => n.hp > 0 && n.tileX === x && n.tileY === y);
    if (inBounds && !blocksMovement[ty][tx] && !occupied(tx, ty)) {
      return this.materializeEnemy(monsterId, tx, ty);
    }
    // Fall back to the nearest free tile around the requested anchor.
    const [fx, fy] = this.findFreeTileNear(tx, ty, 0, 6);
    if (fx === -1) return null;
    return this.materializeEnemy(monsterId, fx, fy);
  }

  private materializeEnemy(monsterId: string, tx: number, ty: number): NpcState | null {
    const def = this.defs.monsters.find((m) => m.id === monsterId);
    if (!def) return null;
    const s = this.state;
    const usedLabels = new Set(s.npcs.filter((n) => n.disposition === 'enemy').map((n) => n.combatLabel));
    let combatLabel = 'A';
    for (let i = 0; i < 26; i++) {
      const candidate = String.fromCharCode(65 + i);
      if (!usedLabels.has(candidate)) { combatLabel = candidate; break; }
    }
    const npc: NpcState = {
      id: `e${++uidCounter}`, defId: def.id, name: def.name, combatLabel,
      tileX: tx, tileY: ty,
      disposition: 'enemy', attitude: 'hostile', factionId: def.id,
      hp: def.maxHp, maxHp: def.maxHp,
      isActive: false,
      reactionUsed: false, conditions: [], inventoryIds: [], ongoingEffects: [],
    };
    s.npcs.push(npc);
    if (s.phase !== 'exploring') s.turnOrderIds.push(npc.id);
    return npc;
  }

  endCombat(): GameEvent[] { return cfEndCombat(this.ctx); }
  triggerCombat(): GameEvent[] { return cfTriggerCombat(this.ctx); }

  // ── Faction & rumor surfaces (AIGM-tool wiring) ────────────────────────────
  getFactionStanding(factionId: string): number {
    return this.state.factionStandings[factionId] ?? 0;
  }
  adjustFactionStanding(factionId: string, delta: number): void {
    adjustFactionStanding(this.ctx, factionId, delta);
  }
  recordRumor(id: string, text: string, salience: number): boolean {
    const had = this.state.rumors.some((r) => r.id === id);
    recordRumor(this.ctx, id, text, salience);
    return !had;
  }
  setWorldFlag(name: string, value: number | string | boolean): void {
    this.state.worldFlags[name] = value;
    this.bus.publish({ type: 'flag_set', name, value });
  }
  /** Lookup the effective relation between two factions (worse-direction). Surfaced for AIGM tool result strings. */
  getFactionRelation(a: string, b: string): number {
    return getRelation(this.state, a, b);
  }
  /** Add `factionId` to `discoveredFactions` if not already present. Returns true on first reveal, false if a no-op. */
  revealFaction(factionId: string): boolean {
    if (this.state.discoveredFactions.includes(factionId)) return false;
    this.state.discoveredFactions.push(factionId);
    return true;
  }
  /**
   * Fire a single `TriggerAction` through the engine's `fireAction` path —
   * lets AIGM tools share the new matrix-mutating action handlers
   * (`adjust_faction_relation`, `set_faction_relation`) without duplicating
   * the clamp + event-publishing logic.
   */
  fireTriggerAction(action: import('./types.js').TriggerAction): void {
    triggerFireAction(this.ctx, action);
  }

  throwItem(itemId: string, targetId?: string): GameEvent[] {
    return caThrowItem(this.ctx, itemId, targetId);
  }

  castSpell(spellId: string, slotLevel: number, targetIds?: string[], tile?: { x: number; y: number }, asRitual = false): GameEvent[] {
    const events: GameEvent[] = [];
    spDoCastSpell(this.ctx, spellId, slotLevel, targetIds, tile, asRitual, events);
    return events;
  }

  setPlayerHidden(hidden: boolean): GameEvent[] {
    const conditions = this.state.player.conditions;
    if (hidden) {
      if (!conditions.includes('hidden')) conditions.push('hidden');
    } else {
      this.state.player.conditions = conditions.filter((c) => c !== 'hidden');
    }
    return [];
  }

  setDisposition(entity: string, disposition: string): GameEvent[] {
    if (!['ally', 'neutral', 'enemy'].includes(disposition)) {
      Logger.warn('anomaly.invalid_disposition', { entity, disposition });
      return [];
    }
    const npc = this.resolveNpcByEntity(entity);
    if (!npc) {
      Logger.warn('anomaly.unknown_entity', { tool: 'set_disposition', entity });
    }
    if (npc) {
      const before = npc.disposition;
      npc.disposition = disposition as Disposition;
      Logger.log('combat.disposition_changed', { npcId: npc.id, defId: npc.defId, before, after: disposition });
      if ((disposition === 'ally' || disposition === 'enemy') && !npc.combatLabel) this.assignCombatLabel(npc);
      if (disposition === 'enemy') this.aggroFaction(npc);
      else this.autoEndCombatIfNoEnemies();
      // Mirror the player-relative disposition into the matrix: every NPC
      // sharing this faction inherits the same standing with party. (For an
      // enemy flip this is redundant with aggroFaction's matrix write — it
      // still serves as the only path for 'ally' / 'neutral' transitions.)
      if (disposition !== 'enemy') {
        const standing = disposition === 'ally' ? 100 : 0;
        setRelation(this.state, npc.factionId ?? npc.defId, PLAYER_FACTION_ID, standing);
      }
    }
    return [];
  }

  /**
   * US-092: set the social Attitude of an NPC toward the party. Returns the
   * pre-change attitude when the NPC was found (so the AIGM tool can log
   * `before → after`), or `null` when the entity ref is unknown. Does not
   * touch combat disposition — attitude and disposition are orthogonal.
   */
  setAttitude(entity: string, attitude: 'friendly' | 'indifferent' | 'hostile'): 'friendly' | 'indifferent' | 'hostile' | null {
    const npc = this.resolveNpcByEntity(entity);
    if (!npc) {
      Logger.warn('anomaly.unknown_entity', { tool: 'set_attitude', entity });
      return null;
    }
    const before = npc.attitude ?? 'indifferent';
    npc.attitude = attitude;
    Logger.log('social.attitude_changed', { npcId: npc.id, defId: npc.defId, before, after: attitude });
    this.addLog({ left: `${npc.revealedName ?? npc.name}: attitude ${before} → ${attitude}`, style: 'status' });
    return before;
  }

  applyCondition(entity: string, condition: string, reason = 'aigm.apply_condition'): GameEvent[] {
    const s = this.state;
    if (entity === 'player') {
      if (!s.player.conditions.includes(condition)) {
        s.player.conditions.push(condition);
        Logger.log('combat.condition_added', { entity: 'player', condition, reason });
      }
      if (condition === 'unconscious' && !s.player.conditions.includes('prone')) {
        s.player.conditions.push('prone');
        Logger.log('combat.condition_added', { entity: 'player', condition: 'prone', reason: 'unconscious_implies_prone' });
      }
    } else {
      const npc = this.resolveNpcByEntity(entity);
      if (!npc) {
        Logger.warn('anomaly.unknown_entity', { tool: 'apply_condition', entity });
      }
      if (npc && !npc.conditions.includes(condition)) {
        npc.conditions.push(condition);
        Logger.log('combat.condition_added', { entity: npc.id, defId: npc.defId, condition, reason });
      }
      if (condition === 'unconscious' && npc && !npc.conditions.includes('prone')) {
        npc.conditions.push('prone');
        Logger.log('combat.condition_added', { entity: npc.id, defId: npc.defId, condition: 'prone', reason: 'unconscious_implies_prone' });
      }
    }
    return [];
  }

  removeCondition(entity: string, condition: string, reason = 'aigm.remove_condition'): GameEvent[] {
    const s = this.state;
    if (entity === 'player') {
      if (s.player.conditions.includes(condition)) {
        s.player.conditions = s.player.conditions.filter((c) => c !== condition);
        Logger.log('combat.condition_removed', { entity: 'player', condition, reason });
      }
    } else {
      const npc = this.resolveNpcByEntity(entity);
      if (!npc) {
        Logger.warn('anomaly.unknown_entity', { tool: 'remove_condition', entity });
      }
      if (npc) {
        if (npc.conditions.includes(condition)) {
          npc.conditions = npc.conditions.filter((c) => c !== condition);
          Logger.log('combat.condition_removed', { entity: npc.id, defId: npc.defId, condition, reason });
        }
        // US-092: when Charm Person's `charmed` condition ends, restore the
        // pre-cast social attitude. The condition might also be removed by
        // an explicit AIGM remove_condition or by the spell's duration; the
        // restore branch fires the same way in every path.
        if (condition === 'charmed' && npc.attitudePreCharm !== undefined) {
          const before = npc.attitude;
          npc.attitude = npc.attitudePreCharm;
          npc.attitudePreCharm = undefined;
          Logger.log('social.attitude_changed', { npcId: npc.id, defId: npc.defId, before, after: npc.attitude, reason: 'charm_ended' });
        }
      }
    }
    return [];
  }

  /**
   * Roll a player ability check. When `targetNpcEntity` is supplied AND
   * the skill is an Influence check (Deception / Intimidation / Performance
   * / Persuasion / Animal Handling), the target NPC's social attitude
   * (US-092) modifies the roll: Friendly → Advantage, Hostile → Disadvantage,
   * Indifferent → normal. `attitudeNote` is a short human-readable string
   * (e.g. "[Friendly: Advantage]") the caller appends to log lines.
   */
  rollAbilityCheck(skill: string, dc: number, targetNpcEntity?: string): { roll: number; total: number; success: boolean; attitudeNote: string } {
    const { conditions, exhaustionLevel, enhancedAbility } = this.state.player;
    const skillMod = (this.playerDef.skills[skill] ?? 0) - exhaustionLevel * 2;
    let withAdvantage = false;
    let withDisadvantage = conditions.includes('poisoned') || conditions.includes('frightened');
    // SRD armor Stealth penalty (US-111): Disadvantage on Dex (Stealth) checks.
    if (skill === 'stealth' && Guard.playerHasStealthDisadvantage(this.ctx)) withDisadvantage = true;
    let attitudeNote = '';
    if (targetNpcEntity && INFLUENCE_SKILLS.includes(skill)) {
      const npc = this.resolveNpcByEntity(targetNpcEntity);
      if (npc) {
        const att = npc.attitude ?? 'indifferent';
        if (att === 'friendly') { withAdvantage = true; attitudeNote = '[Friendly: Adv]'; }
        else if (att === 'hostile') { withDisadvantage = true; attitudeNote = '[Hostile: Dis]'; }
        else attitudeNote = '[Indifferent]';
      }
    }
    // SRD Enhance Ability — Advantage on ability checks whose underlying
    // ability matches the chosen one. Stacks with the attitude-driven
    // Advantage above (both are sources of Adv, which collapses to a
    // single Adv per the SRD Advantage rules — see US-043).
    let enhanceNote = '';
    if (enhancedAbility && SKILL_ABILITY[skill] === enhancedAbility) {
      withAdvantage = true;
      enhanceNote = `[Enhance Ability ${enhancedAbility.toUpperCase()}: Adv]`;
    }
    const result = rollSkillCheck(skillMod, dc, withAdvantage, withDisadvantage);
    Logger.log('check.ability_check', {
      skill, dc, skillMod, exhaustionPenalty: exhaustionLevel * 2,
      adv: withAdvantage, dis: withDisadvantage,
      targetNpcEntity: targetNpcEntity ?? null,
      attitudeNote: attitudeNote || null,
      enhanceNote: enhanceNote || null,
      roll: result.roll, total: result.total, success: result.success,
    });
    return { ...result, attitudeNote: [attitudeNote, enhanceNote].filter(Boolean).join(' ') };
  }

  rollPlayerSavingThrow(ability: string, dc: number): { roll: number; total: number; success: boolean; autoFail: boolean } {
    const { conditions, exhaustionLevel } = this.state.player;
    if ((ability === 'str' || ability === 'dex') && (conditions.includes('paralyzed') || conditions.includes('unconscious') || conditions.includes('stunned'))) {
      return { roll: 0, total: 0, success: false, autoFail: true };
    }
    const saveMod = (this.playerDef.savingThrows[ability] ?? 0) - exhaustionLevel * 2;
    const withAdvantage = ability === 'dex' && conditions.includes('dodging');
    const withDisadvantage = ability === 'dex' && conditions.includes('restrained');
    return { ...rollSavingThrow(saveMod, dc, withAdvantage, withDisadvantage), autoFail: false };
  }

  rollAttackRoll(attacker: string, targetAc: number): { roll: number; total: number; isHit: boolean; isCrit: boolean; damage: number; rollStr: string } {
    if (attacker === 'player') return rollPlayerAttackVsAc(this.playerDef, targetAc);
    const npc = this.resolveNpcByEntity(attacker);
    if (!npc) return { roll: 0, total: 0, isHit: false, isCrit: false, damage: 0, rollStr: 'Unknown attacker.' };
    const monsterDef = this.resolveMonsterDef(npc.defId);
    if (!monsterDef || !monsterDef.attacks.length) return { roll: 0, total: 0, isHit: false, isCrit: false, damage: 0, rollStr: 'No attack available.' };
    return rollNpcAttackVsAc(monsterDef, targetAc);
  }

  /**
   * Public lookup for AIGM tools: resolve an entity ref (`enemy_A`,
   * `ally_A`, `npc_<id>`) to the matching NpcState, or undefined when the
   * ref doesn't resolve. Wraps the existing private resolver.
   */
  resolveNpcEntity(entity: string): NpcState | undefined {
    return this.resolveNpcByEntity(entity);
  }

  // ── Private helpers shared with the GameContext ─────────────────────────────

  private resolveNpcByEntity(entity: string): NpcState | undefined {
    const s = this.state;
    if (entity.startsWith('enemy_')) return s.npcs.find((n) => n.combatLabel === entity.slice(6) && n.disposition === 'enemy');
    if (entity.startsWith('ally_'))  return s.npcs.find((n) => n.combatLabel === entity.slice(5) && n.disposition === 'ally');
    if (entity.startsWith('npc_'))   return s.npcs.find((n) => n.id === entity.slice(4));
    return undefined;
  }

  private assignCombatLabel(npc: NpcState): void {
    const usedLabels = new Set(this.state.npcs.filter((n) => n.disposition !== 'neutral').map((n) => n.combatLabel));
    for (let i = 0; i < 26; i++) {
      const candidate = String.fromCharCode(65 + i);
      if (!usedLabels.has(candidate)) { npc.combatLabel = candidate; return; }
    }
  }

  private aggroFaction(instigator: NpcState): void {
    const factionId = instigator.factionId ?? instigator.defId;
    for (const npc of this.state.npcs) {
      if (npc === instigator || npc.disposition !== 'neutral') continue;
      if ((npc.factionId ?? npc.defId) !== factionId) continue;
      npc.disposition = 'enemy';
      if (!npc.combatLabel) this.assignCombatLabel(npc);
    }
    // Mirror the aggro into the matrix: the instigator's faction is now
    // hostile to the party. Pass 3's matrix-driven readers will see this
    // alongside the legacy disposition flip.
    setRelation(this.state, factionId, PLAYER_FACTION_ID, -100);
  }

  private autoEndCombatIfNoEnemies(): void {
    cfAutoEndCombat(this.ctx);
  }

  /**
   * Dev-only fast-forward to encounter end. Mirrors both legitimate
   * completion paths so adventures, chapter wraps, and single encounters
   * all settle correctly:
   *   • If the encounter declares a `completionFlag`, set it. Publishes
   *     `flag_set` → `EncounterProgress` maps it to `encounterComplete`.
   *   • If there are living enemies, kill each one — the engine's normal
   *     `killNpc` path publishes `npc_killed` and `autoEndCombatIfNoEnemies`
   *     fires `combat_ended` after the last drop.
   * The result is the same `state.encounterComplete` flip the player would
   * reach normally — wrap-up overlay, next-chapter button, the rest of the
   * adventure machinery all keep working.
   */
  devCompleteEncounter(_events: GameEvent[]): void {
    if (!this.state.devFlags?.completePrimaryObjective) return; // server-side gate
    this.addLog({ left: "[DEV] Completing primary objective…", style: 'header' });
    const flag = this.state.encounterCompletionFlag;
    if (flag) {
      this.state.worldFlags[flag] = true;
      this.bus.publish({ type: 'flag_set', name: flag, value: true });
    }
    const livingEnemies = this.state.npcs.filter((n) => n.hp > 0 && n.disposition === 'enemy');
    for (const npc of livingEnemies) {
      this.killNpc(npc.id);
    }
    // Defensive backstops — content has many ways to leave `encounterComplete`
    // unset (chapter without a completionFlag, encounter flag that doesn't
    // match the chapter's flag, social scene with neither). The dev button
    // is supposed to be bulletproof regardless of authoring, so:
    //   • Publish `encounter_completed` if no flag was set and no kills
    //     happened (already-empty exploration room).
    //   • If we're in an adventure and `encounterComplete` is still false
    //     after all of the above, force it to true so the wrap-up overlay
    //     opens and the Next Chapter button surfaces.
    if (!flag && livingEnemies.length === 0) {
      this.bus.publish({ type: 'encounter_completed' });
    }
    if (this.state.adventureContext && !this.state.encounterComplete) {
      this.state.encounterComplete = true;
      this.addLog({ left: "[DEV] Chapter wrapped — proceed to the next chapter.", style: 'header' });
    }
  }

  private resistMod(damage: number, damageType: string, def: MonsterDef, displayName: string): { finalDamage: number; log: LogEntry | null } {
    if (def.immunities?.includes(damageType)) {
      return { finalDamage: 0, log: { left: `${displayName} is immune to ${damageType} — ${damage}→0`, right: '×0', style: 'status' } };
    }
    if (def.resistances?.includes(damageType)) {
      const fd = Math.floor(damage / 2);
      return { finalDamage: fd, log: { left: `${displayName} resists ${damageType} — ${damage}→${fd}`, right: '×½', style: 'status' } };
    }
    if (def.vulnerabilities?.includes(damageType)) {
      const fd = damage * 2;
      return { finalDamage: fd, log: { left: `${displayName} is vulnerable to ${damageType}! ${damage}→${fd}`, right: '×2', style: 'crit' } };
    }
    return { finalDamage: damage, log: null };
  }

  /** Player-side resistance/vulnerability/immunity (US-108), mirroring the
   *  monster `resistMod`. Immunity > vulnerability > resistance. Returns the
   *  damage unchanged when the player has no entry for `damageType`. */
  private playerResistMod(damage: number, damageType: string): number {
    const def = this.playerDef;
    const name = def.name;
    if (def.immunities?.includes(damageType)) {
      this.addLog({ left: `${name} is immune to ${damageType} — ${damage}→0`, right: '×0', style: 'status' });
      return 0;
    }
    if (def.resistances?.includes(damageType)) {
      const fd = Math.floor(damage / 2);
      this.addLog({ left: `${name} resists ${damageType} — ${damage}→${fd}`, right: '×½', style: 'status' });
      return fd;
    }
    if (def.vulnerabilities?.includes(damageType)) {
      const fd = damage * 2;
      this.addLog({ left: `${name} is vulnerable to ${damageType}! ${damage}→${fd}`, right: '×2', style: 'crit' });
      return fd;
    }
    return damage;
  }

  private applyDamageToPlayer(damage: number, _events: GameEvent[], damageType?: string): void {
    const s = this.state;
    // SRD: resistance/vulnerability/immunity adjusts the typed damage first,
    // before Temporary HP absorbs and before the CON save sees it.
    let effective = damageType ? this.playerResistMod(damage, damageType) : damage;
    // SRD: Temporary HP absorbs damage next; the pool drains before the
    // real HP takes any hit. The CON save (and the unconscious check) only
    // see the *leftover* damage that actually reached real HP.
    const tempHpBefore = s.player.tempHp;
    if (effective > 0 && s.player.tempHp > 0) {
      const absorbed = Math.min(s.player.tempHp, effective);
      s.player.tempHp -= absorbed;
      effective -= absorbed;
      this.addLog({ left: `${absorbed} damage absorbed by Temporary HP (${s.player.tempHp} remaining)`, style: 'status' });
    }
    const hpBefore = s.player.hp;
    s.player.hp = Math.max(0, hpBefore - effective);
    Logger.log('combat.damage_dealt', {
      target: 'player',
      raw: damage,
      tempAbsorbed: tempHpBefore - s.player.tempHp,
      effective,
      hpBefore,
      hpAfter: s.player.hp,
      maxHp: this.playerDef.maxHp,
    });
    this.addLog({ left: `${this.playerDef.name} HP: ${s.player.hp}/${this.playerDef.maxHp}`, style: 'status' });
    this.bus.publish({ type: 'damage_dealt', target: 'player', amount: effective });
    publishHpThresholdCrossings(this.ctx, 'player', hpBefore, s.player.hp, this.playerDef.maxHp);
    // Concentration save: damage that actually reached real HP triggers a
    // CON save. Pure temp-HP absorption does not break concentration —
    // SRD: the save is based on damage *taken*, not damage *dealt*.
    if (s.player.concentratingOn && effective > 0) maybeBreakConcentration(this.ctx, effective);
    if (s.player.hp > 0) return;
    clearHide(s.player);
    // SRD: Concentration ends if you have the Incapacitated condition or
    // you die. Falling to 0 HP triggers Unconscious (which is Incapacitated),
    // so drop any concentration the player was holding before the phase flip.
    if (s.player.concentratingOn) endConcentration(this.ctx, 'caster fell unconscious');
    const leftover = effective - hpBefore;
    if (leftover >= this.playerDef.maxHp) {
      this.addLog({ left: `Massive damage — ${this.playerDef.name} dies instantly`, style: 'kill' });
      s.phase = 'defeat';
    } else {
      this.addLog({ left: `${this.playerDef.name} falls unconscious!`, style: 'status' });
      s.phase = 'death_saves';
    }
  }

  private killNpc(id: string): void {
    const s = this.state;
    const dying = s.npcs.find((n) => n.id === id);
    if (!dying) return;
    for (const defId of dying.inventoryIds) {
      s.mapItems.push({ id: `e${++uidCounter}`, defId, tileX: dying.tileX, tileY: dying.tileY });
    }
    dying.inventoryIds = [];
    dying.isActive = false;
    clearHide(dying);
    // A dead source can't sustain its periodic effects — drop any attach
    // effects it had on the player or other NPCs. Delayed-self-damage
    // ongoing effects are spell-authored and don't reference an NPC source,
    // so they survive the source's death.
    s.player.ongoingEffects = s.player.ongoingEffects.filter((oe) => oe.kind !== 'attach' || oe.sourceNpcId !== id);
    for (const n of s.npcs) {
      n.ongoingEffects = n.ongoingEffects.filter((oe) => oe.kind !== 'attach' || oe.sourceNpcId !== id);
    }
    // NOTE: do NOT remove from turnOrderIds. The advance loop in CombatFlow
    // skips any combatant whose hp <= 0; mutating the array mid-iteration
    // would shift indices and could cause a still-alive combatant to skip
    // their turn.
    // Fire npc_killed triggers BEFORE autoEndCombatIfNoEnemies so a trigger
    // can spawn reinforcements that prevent combat from auto-ending.
    this.bus.publish({ type: 'npc_killed', npcId: dying.id, defId: dying.defId });
    this.autoEndCombatIfNoEnemies();
  }

  private killWithReward(npc: NpcState, def: MonsterDef, killMessage: string, _includeTotal = true): void {
    const s = this.state;
    s.player.xp += def.xp;
    this.addLog({ left: `${killMessage} +${def.xp} XP`, style: 'kill' });
    this.killNpc(npc.id);
  }

  private applyMasteryConditions(target: NpcState, vexApplied: boolean, slowApplied: boolean): void {
    if (vexApplied) {
      if (!target.conditions.includes('vexed')) target.conditions.push('vexed');
      this.addLog({ left: `Vex/Sap — ${target.name} attacks with Disadvantage`, style: 'status' });
    }
    if (slowApplied && !target.conditions.includes('slowed')) {
      target.conditions.push('slowed');
      this.addLog({ left: `Slow — ${target.name} speed reduced by 10 ft`, style: 'status' });
    }
  }

  private computeAvailableActions(): void {
    const s = this.state;
    const p = s.player;
    const phase = s.phase;
    const selectedTarget = s.selectedTargetId
      ? s.npcs.find((n) => n.id === s.selectedTargetId && n.hp > 0 && n.disposition !== 'ally')
      : null;

    let throwableItemIds: string[] = [];
    if (selectedTarget && (phase === 'exploring' || (phase === 'player_turn' && !p.actionUsed))) {
      const dist = chebyshev(p.tileX, p.tileY, selectedTarget.tileX, selectedTarget.tileY);
      const seen = new Set<string>();
      throwableItemIds = p.inventoryIds.filter((id) => {
        if (seen.has(id)) return false;
        seen.add(id);
        const itemDef = this.defs.equipment.find((i) => i.id === id);
        if (!itemDef) return false;
        const longRange = itemDef.type === 'weapon' && (itemDef as WeaponDef).thrown
          ? Math.floor((itemDef as WeaponDef).throwLong / 5) : 12;
        return dist <= longRange;
      });
    }

    // Trap actions are usable during exploration, or on the player's turn while
    // an Action remains (both Disarm and Deploy cost the full Action in combat).
    const canActNow = phase === 'exploring' || (phase === 'player_turn' && !p.actionUsed);
    const disarmableTrapTiles = canActNow
      ? s.traps
          .filter((t) => t.armed && t.discovered && chebyshev(p.tileX, p.tileY, t.tileX, t.tileY) <= 1)
          .map((t) => ({ x: t.tileX, y: t.tileY }))
      : [];
    let deployableGearIds: string[] = [];
    if (canActNow) {
      const seen = new Set<string>();
      deployableGearIds = p.inventoryIds.filter((id) => {
        if (seen.has(id)) return false;
        seen.add(id);
        return isDeployableGear(this.defs.equipment.find((i) => i.id === id));
      });
    }

    // Shove (US-050) / Grapple (US-110): adjacent, living, size-eligible enemies
    // while the player has an Action. Grapple additionally excludes the already-
    // grappled.
    let grappleableTargetIds: string[] = [];
    let shoveableTargetIds: string[] = [];
    if (Guard.canSpendAction(this.ctx)) {
      const adj = s.npcs.filter((n) => n.disposition === 'enemy' && n.hp > 0
        && chebyshev(p.tileX, p.tileY, n.tileX, n.tileY) <= 1
        && withinShoveGrappleSize(this.playerDef.size, n.size));
      shoveableTargetIds = adj.map((n) => n.id);
      grappleableTargetIds = adj.filter((n) => !n.conditions.includes('grappled')).map((n) => n.id);
    }

    s.availableActions = {
      canAttack: Guard.canAttackTarget(this.ctx),
      throwableItemIds,
      canHide: Guard.canHide(this.ctx),
      canSearch: Guard.canSearch(this.ctx),
      usableFeatureIds: Guard.usableFeatureIds(this.ctx),
      canDash: Guard.canDash(this.ctx),
      canDodge: Guard.canDodge(this.ctx),
      canDisengage: Guard.canDisengage(this.ctx),
      canShortRest: Guard.canShortRest(this.ctx),
      castableSpellIds: Guard.castableSpellIds(this.ctx),
      canDetach: Guard.canDetach(this.ctx),
      // LEVEL UP is offered in exploration only — the overlay opens a modal
      // dialogue and applies HP / feature changes that shouldn't land mid-turn.
      canLevelUp: phase === 'exploring' && canLevelUp(this.playerDef.level, p.xp),
      // LONG REST is gated by the encounter — only safehouses / taverns set
      // `allowsLongRest`. Combat phases block it outright.
      canLongRest: phase === 'exploring' && s.allowsLongRest === true,
      disarmableTrapTiles,
      deployableGearIds,
      grappleableTargetIds,
      shoveableTargetIds,
    };
  }

  // ── Level-up ───────────────────────────────────────────────────────────────

  /**
   * Build the SRD preview the LevelUpOverlay renders. Returns `null` when the
   * character isn't eligible right now (insufficient XP, already at L20, or
   * outside the exploration phase). The preview is recomputed by
   * `commitLevelUp` so the client can't smuggle stale values back.
   */
  buildLevelUpPreview(): LevelUpPreview | null {
    return buildLevelUpPreview({
      playerDef: this.playerDef,
      xp: this.state.player.xp,
      features: this.defs.features,
      spells: this.defs.spells,
      classes: this.defs.classes,
      subclasses: this.defs.subclasses,
      feats: this.defs.feats,
    });
  }

  /**
   * Apply a player-confirmed level-up. Mutates `playerDef` + projects the new
   * `maxHp` / spell-slot caps onto `state.player`. The caller is responsible
   * for persisting the updated character save to disk and broadcasting a
   * `state_update`.
   */
  commitLevelUp(choices: LevelUpChoices): LevelUpPreview {
    if (this.state.phase !== 'exploring') {
      throw new Error('Level up is only available in the exploration phase.');
    }
    const preview = this.buildLevelUpPreview();
    if (!preview) throw new Error('Not enough XP to level up.');

    const slotsBefore = (this.playerDef.defaultSpellSlots ?? []).slice();
    applyLevelUp({
      playerDef: this.playerDef,
      choices,
      features: this.defs.features,
      spells: this.defs.spells,
      classes: this.defs.classes,
      subclasses: this.defs.subclasses,
      feats: this.defs.feats,
      preview,
    });

    // Heal the newly-gained HP so the player sees their fresh max HP
    // immediately. `maxHp` itself lives on `playerDef` (no separate runtime
    // copy in PlayerState); the response carries the updated playerDef so the
    // client refreshes its cached copy.
    this.state.player.hp = Math.min(this.playerDef.maxHp, this.state.player.hp + preview.hpGain);

    // For each slot level that gained a slot, also refill the current pool by
    // the same delta so the player can immediately cast at the new ceiling.
    const slotsAfter = this.playerDef.defaultSpellSlots ?? [];
    for (let i = 0; i < slotsAfter.length; i++) {
      const before = slotsBefore[i] ?? 0;
      const after = slotsAfter[i] ?? 0;
      const delta = after - before;
      if (delta <= 0) continue;
      this.state.player.spellSlots[i] = (this.state.player.spellSlots[i] ?? 0) + delta;
    }

    // Initialise feature resource pools for newly-granted features with a
    // resource (e.g. Action Surge gets 1 use per short rest).
    for (const f of preview.newFeatures) {
      const def = this.defs.features.find((d) => d.id === f.id);
      if (def?.resource?.kind && def.resource.kind !== 'unlimited') {
        this.state.player.resources[def.id] = def.resource.max;
      }
    }

    this.addLog({ left: `── Level up: ${this.playerDef.name} reaches level ${preview.toLevel} ──`, style: 'header' });
    this.addLog({ left: `+${preview.hpGain} HP (${preview.toLevel === 2 ? 'fixed value + Con' : 'class roll'})`, style: 'heal' });
    for (const f of preview.newFeatures) {
      this.addLog({ left: `New feature: ${f.name}`, style: 'status' });
    }

    this.computeAvailableActions();
    return preview;
  }

  /** Read-only access to the per-session mutable PlayerDef. The session
   *  manager uses this to write the updated character back to disk after a
   *  level-up. */
  getPlayerDef(): PlayerDef { return this.playerDef; }

  // ── NPC save layer (per-session in-memory copies) ──────────────────────
  //
  // Loaded asynchronously by the WS layer after session creation (so the
  // engine constructor stays sync) and attached here. Mutations during the
  // session land in these objects directly; the WS layer flushes them back
  // to disk on session destruction / chapter advance via `getNpcSaves()`.

  /** Keyed by NPC def id. Only persistent NPCs land here. */
  private npcSaves: Map<string, import("../../../shared/types.js").NpcSave> = new Map();

  attachNpcSaves(saves: import("../../../shared/types.js").NpcSave[]): void {
    for (const s of saves) this.npcSaves.set(s.npcId, s);
  }

  /** Live in-memory NPC saves — used by the conversation system + trigger
   *  actions for read/write. Caller MUST NOT replace entries; mutate them
   *  in place. */
  getNpcSaves(): Map<string, import("../../../shared/types.js").NpcSave> { return this.npcSaves; }

  /** Snapshot for end-of-session flushing. Stamps `lastSeen` on every save
   *  with the current encounter context before returning. */
  collectNpcSavesForFlush(): import("../../../shared/types.js").NpcSave[] {
    const adventureCtx = this.state.adventureContext;
    for (const save of this.npcSaves.values()) {
      const npc = this.state.npcs.find((n) => n.defId === save.npcId);
      if (npc) {
        save.stateOverrides.currentHp = npc.hp;
        save.stateOverrides.conditions = [...npc.conditions];
        save.stateOverrides.disposition = npc.disposition;
        save.stateOverrides.factionId = npc.factionId;
        save.status = isDead(npc) ? "dead" : "alive";
        save.nameKnownToPlayer = !!npc.revealedName;
      }
      save.lastSeen = {
        at: new Date().toISOString(),
        ...(adventureCtx?.adventureId ? { adventureId: adventureCtx.adventureId } : {}),
        ...(adventureCtx?.chapterId   ? { chapterId:   adventureCtx.chapterId   } : {}),
        ...(this.state.encounterTitle ? { encounterId: this.state.encounterTitle } : {}),
      };
    }
    return Array.from(this.npcSaves.values());
  }

  // ── Long Rest ──────────────────────────────────────────────────────────────

  /** Resolve the player's `ClassDef` from the loaded class data, or null for
   *  an unrecognised class. Used wherever rest / prep logic needs the class's
   *  spellcasting metadata instead of branching on the class name. */
  private resolvePlayerClassDef(): ClassDef | null {
    const key = (this.playerDef.className ?? '').toLowerCase();
    return this.defs.classes.find((c) => c.id.toLowerCase() === key) ?? null;
  }

  /**
   * Build the SRD Long Rest preview the LongRestOverlay renders. Returns
   * `null` when the current encounter doesn't permit Long Rest or the
   * player is mid-combat. The preview is recomputed inside `commitLongRest`
   * so the client can't smuggle stale values.
   */
  buildLongRestPreview(): LongRestPreview | null {
    if (this.state.phase !== 'exploring' || this.state.allowsLongRest !== true) return null;
    return buildLongRestPreview({
      playerDef: this.playerDef,
      player: this.state.player,
      features: this.defs.features,
      spells: this.defs.spells,
      classDef: this.resolvePlayerClassDef(),
      npcs: this.state.npcs,
    });
  }

  /**
   * Apply a confirmed Long Rest. Restores HP, hit dice, spell slots, feature
   * pools, exhaustion, and (for Wizards) rebuilds prepared spells. Returns
   * the preview that was applied so the caller can persist it.
   */
  commitLongRest(choices: LongRestChoices): LongRestPreview {
    const preview = this.buildLongRestPreview();
    if (!preview) throw new Error('Long Rest is not available here.');

    applyLongRest(
      { playerDef: this.playerDef, player: this.state.player, features: this.defs.features, spells: this.defs.spells, classDef: this.resolvePlayerClassDef(), npcs: this.state.npcs },
      choices,
      preview,
    );

    this.addLog({ left: `── Long Rest — ${this.playerDef.name} is fully rested ──`, style: 'header' });
    if (preview.hpRestored > 0) {
      this.addLog({ left: `HP restored: ${this.state.player.hp}/${this.playerDef.maxHp}`, style: 'heal' });
    }
    if (preview.hitDiceRestored > 0) {
      this.addLog({ left: `Hit Dice restored: ${preview.hitDiceRestored}`, style: 'status' });
    }
    if (preview.spellSlotsRestored.some((d) => d > 0)) {
      const parts = preview.spellSlotsRestored
        .map((d, i) => d > 0 ? `L${i + 1}+${d}` : null)
        .filter((s): s is string => !!s);
      this.addLog({ left: `Spell slots restored: ${parts.join(', ')}`, style: 'status' });
    }
    if (preview.exhaustionReduced) {
      this.addLog({ left: `Exhaustion level: ${this.state.player.exhaustionLevel}`, style: 'status' });
    }
    for (const c of preview.companionsRestored ?? []) {
      const bits = [
        c.hpRestored > 0 ? `+${c.hpRestored} HP` : null,
        c.conditionsCleared.length > 0 ? `cleared ${c.conditionsCleared.join(', ')}` : null,
      ].filter((s): s is string => !!s);
      this.addLog({ left: `${c.name} rests — ${bits.join(', ') || 'ready'}`, style: 'heal' });
    }

    this.computeAvailableActions();
    return preview;
  }

  private findFreeTileNear(cx: number, cy: number, minDist: number, maxDist: number): [number, number] {
    const s = this.state;
    const { cols, rows, blocksMovement } = s.map;
    const occupied = new Set<string>([
      `${s.player.tileX},${s.player.tileY}`,
      ...s.npcs.filter((n) => n.hp > 0).map((n) => `${n.tileX},${n.tileY}`),
    ]);
    for (let dist = minDist; dist <= maxDist; dist++) {
      for (let dc = -dist; dc <= dist; dc++) {
        for (let dr = -dist; dr <= dist; dr++) {
          if (Math.abs(dc) !== dist && Math.abs(dr) !== dist) continue;
          const tc = cx + dc, tr = cy + dr;
          if (tc < 0 || tc >= cols || tr < 0 || tr >= rows) continue;
          if (blocksMovement[tr][tc]) continue;
          if (!occupied.has(`${tc},${tr}`)) return [tc, tr];
        }
      }
    }
    return [-1, -1];
  }

  // ── Static session builder ─────────────────────────────────────────────────

  static createSession(
    sessionId: string,
    req: CreateSessionRequest & { encounterContext: EncounterContext },
    defs: GameDefs,
    savedMap?: SavedMapRecord,
  ): GameEngine {
    // Build a leveled clone of the playerDef BEFORE buildSessionState so the
    // initial state (maxHp, spell slots, features) reflects the character's
    // current level rather than the L1 starting state.
    const history = req.resumeLevelUps ?? [];
    let defsForBuild = defs;
    const base = defs.playerDefs.find((p) => p.id === req.playerDefId);
    if (base) {
      // We always clone — even with no level-up history we need
      // `syncCharacterTracks` to backfill the character's L1 class features
      // (Wizard's Spellcasting / Ritual Adept / Arcane Recovery, Fighter's
      // Fighting Style / Second Wind, …) which the source character JSON
      // omits. Without this, the SessionBuilder resource-pool seeder and the
      // Short Rest's "do I have Arcane Recovery?" check both miss those
      // features entirely.
      const leveled = JSON.parse(JSON.stringify(base)) as PlayerDef;
      if (history.length > 0) {
        applyLevelUpHistory(leveled, history, defs.features, defs.spells, defs.classes, defs.subclasses, defs.feats);
      }
      syncCharacterTracks(leveled, defs.classes);
      defsForBuild = {
        ...defs,
        playerDefs: defs.playerDefs.map((p) => p.id === base.id ? leveled : p),
      };
    }
    const state = buildSessionState(sessionId, req, defsForBuild, savedMap);
    // Replay again inside the constructor so the engine's own clone is also
    // updated (defsForBuild is local to this method).
    return new GameEngine(state, defs, history);
  }
}
