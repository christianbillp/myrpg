import {
  GameState, GameEvent, PlayerAction,
  PlayerDef, MonsterDef,
  NpcState, Disposition,
  QuestGoalType, LogEntry, GameDefs,
  CreateSessionRequest,
} from './types.js';
import { advanceQuest as questAdvance, completeQuest as questComplete } from './QuestSystem.js';
import type { EncounterContext } from '../encounterService.js';
import {
  rollSkillCheck, rollSavingThrow,
  rollPlayerAttackVsAc, rollNpcAttackVsAc,
} from './CombatSystem.js';
import { applyEquipment, computeEquippedSlotLabels } from './EquipmentSystem.js';
import { chebyshev } from './EnemyAI.js';
import { buildAIGMTools } from './AIGMTools.js';
import { setRelation, getRelation } from './FactionRelations.js';
import { runOffCameraTick as runOffCameraTickImpl } from './WorldTick.js';
import { PLAYER_FACTION_ID } from '../../../shared/types.js';
import * as Guard from './ActionGuards.js';
import type { GameContext } from './GameContext.js';
import {
  endCombat as cfEndCombat, autoEndCombatIfNoEnemies as cfAutoEndCombat,
  triggerCombat as cfTriggerCombat, doStartCombat as cfDoStartCombat,
  enterEnemyPhase as cfEnterEnemyPhase, doRollDeathSave as cfDoRollDeathSave,
  doResolveReaction as cfDoResolveReaction,
} from './CombatFlow.js';
import {
  doAttack as caDoAttack, throwItem as caThrowItem,
  doHide as caDoHide, doDash as caDoDash, doDodge as caDoDodge,
  doDisengage as caDoDisengage, doDetach as caDoDetach,
  doPlayerOpportunityAttack as caDoPlayerOA,
} from './CombatActions.js';
import {
  doMove as exDoMove, doMoveTo as exDoMoveTo,
  doSearch as exDoSearch, doShortRest as exDoShortRest, doUsePotion as exDoUsePotion,
} from './ExplorationActions.js';
import { doEquip as ivDoEquip, doUnequip as ivDoUnequip } from './InventoryActions.js';
import { doCastSpell as spDoCastSpell } from './SpellSystem.js';
import { doCommandSummon, checkSummonTether, registerSummonHooks } from './SummonSystem.js';
import { maybeBreakConcentration } from './ConcentrationSystem.js';
import { doUseFeature } from './FeatureRegistry.js';
import { buildSessionState, SavedMapRecord } from './SessionBuilder.js';
import { registerTriggers, adjustFactionStanding, recordRumor, fireAction as triggerFireAction } from './TriggerSystem.js';
import { registerDirector } from './Director.js';
import { registerAdventureProgress } from './AdventureProgress.js';
import { registerEncounterLifecycle, publishEncounterStarted } from './EncounterLifecycle.js';
import { EventBus } from './EventBus.js';
import { publishHpThresholdCrossings } from './ThresholdPublisher.js';
import { WeaponDef } from './types.js';
import { buildLevelUpPreview, applyLevelUp, applyLevelUpHistory } from './Leveling.js';
import { canLevelUp } from '../../../shared/xpTable.js';
import type { LevelUpPreview, LevelUpChoices, LongRestPreview, LongRestChoices } from '../../../shared/types.js';
import { buildLongRestPreview, applyLongRest } from './Resting.js';

export interface ActionResult {
  events: GameEvent[];
  state: GameState;
}

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
      applyLevelUpHistory(this.playerDef, levelUpHistory, defs.features, defs.spells);
    }
    this.defs = {
      ...defs,
      playerDefs: defs.playerDefs.map((p) => p.id === this.playerDef.id ? this.playerDef : p),
    };
    applyEquipment(this.playerDef, state.player.equippedSlots, this.defs.equipment, state.player.mageArmor);
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
    registerDirector(this.ctx);
    registerAdventureProgress(this.ctx);
    registerEncounterLifecycle(this.ctx);
    registerTriggers(this.ctx);
    registerSummonHooks(this.ctx);

    // Fire encounter_started AFTER every subscriber is registered. Triggers
    // listening on this event push their GameEvents into the startup buffer
    // (point ctx.eventSink at it for the duration of the publish call), and
    // the WS handler flushes that buffer onto the first state_update so any
    // intro cinematic plays the moment the client connects.
    this.ctx.eventSink = this.startupEvents;
    try {
      publishEncounterStarted(this.ctx);
    } finally {
      this.ctx.eventSink = null;
    }
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
      advanceQuest: (t) => this.advanceQuest(t),
      autoEndCombatIfNoEnemies: () => this.autoEndCombatIfNoEnemies(),
      resistMod: (d, t, def, n) => this.resistMod(d, t, def, n),
      applyDamageToPlayer: (d, ev) => this.applyDamageToPlayer(d, ev),
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

  getState(): GameState { this.computeAvailableActions(); return this.state; }
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
    const s = this.state;
    this.computeAvailableActions();
    // Expose the events buffer to engine subsystems that don't receive it
    // explicitly (TriggerSystem actions, in particular). Cleared in finally
    // so AIGM-tool / direct-engine callers don't accidentally accumulate
    // entity_move events into the wrong outer call.
    this.ctx.eventSink = events;
    try {

    switch (action.type) {
      case 'move':         exDoMove(this.ctx, action.dx, action.dy, events); break;
      case 'moveTo':       exDoMoveTo(this.ctx, action.tileX, action.tileY, events); break;
      case 'attack':       caDoAttack(this.ctx, action.targetId, events); break;
      case 'throw':
        if (s.phase === 'exploring' || s.phase === 'player_turn')
          events.push(...caThrowItem(this.ctx, action.itemId, action.targetId));
        break;
      case 'castSpell':
        spDoCastSpell(this.ctx, action.spellId, action.slotLevel, action.targetIds, action.tile, !!action.asRitual, events, action.damageTypeChoice);
        break;
      case 'hide':         caDoHide(this.ctx); break;
      case 'useFeature':   doUseFeature(this.ctx, action.featureId, { targetId: action.targetId, tile: action.tile }, events); break;
      case 'resolveReaction': cfDoResolveReaction(this.ctx, action.accept, events); break;
      case 'dash':         caDoDash(this.ctx); break;
      case 'dodge':        caDoDodge(this.ctx); break;
      case 'disengage':    caDoDisengage(this.ctx); break;
      case 'detach':       caDoDetach(this.ctx); break;
      case 'commandSummon': doCommandSummon(this.ctx, action.summonNpcId, action.tile, events); break;
      case 'endTurn':
        if (s.phase === 'player_turn') {
          // SRD Mage Hand: vanishes if the caster ends a turn > 30 ft away.
          checkSummonTether(this.ctx);
          cfEnterEnemyPhase(this.ctx, events);
        }
        break;
      case 'rollDeathSave': cfDoRollDeathSave(this.ctx, events); break;
      case 'shortRest':    exDoShortRest(this.ctx); break;
      case 'search':       exDoSearch(this.ctx); break;
      case 'usePotion':    exDoUsePotion(this.ctx); break;
      case 'equip':        ivDoEquip(this.ctx, action.slot, action.itemId); break;
      case 'unequip':      ivDoUnequip(this.ctx, action.slot); break;
      case 'selectTarget': s.selectedTargetId = action.entityId; break;
      case 'scrollLog': {
        const maxOffset = Math.max(0, s.eventLog.length - 6);
        s.logScrollOffset = Math.max(0, Math.min(maxOffset, s.logScrollOffset + (action.delta > 0 ? -1 : 1)));
        break;
      }
    }

    this.computeAvailableActions();
    return { events, state: this.state };
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
    this.state.player.exhaustionLevel = Math.max(0, Math.min(5, level));
    this.addLog(`Exhaustion level: ${this.state.player.exhaustionLevel} (−${this.state.player.exhaustionLevel * 2} to all D20 Tests)`);
    return [];
  }

  awardXp(amount: number): GameEvent[] {
    this.state.player.xp += amount;
    return [];
  }

  awardGold(amount: number): GameEvent[] {
    const newGold = this.state.player.gold + amount;
    if (newGold < 0) return [];
    this.state.player.gold = newGold;
    return [];
  }

  adjustNpcHp(entity: string, delta: number, damageType?: string): GameEvent[] {
    if (entity === 'player') return this.adjustPlayerHp(delta);
    const npc = this.resolveNpcByEntity(entity);
    if (!npc) return [];
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

  moveEntity(entity: string, tileX: number, tileY: number): GameEvent[] {
    const s = this.state;
    const events: GameEvent[] = [];
    if (entity === 'player') {
      s.player.tileX = tileX;
      s.player.tileY = tileY;
      events.push({ type: 'entity_move', entityId: 'player', toX: tileX, toY: tileY });
    } else {
      const npc = this.resolveNpcByEntity(entity);
      if (npc) {
        npc.tileX = tileX;
        npc.tileY = tileY;
        events.push({ type: 'entity_move', entityId: npc.id, toX: tileX, toY: tileY });
      }
    }
    return events;
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

    const { cols, rows, passable } = s.map;
    const occupied = (x: number, y: number): boolean =>
      (s.player.tileX === x && s.player.tileY === y)
      || s.npcs.some((n) => n.hp > 0 && n.tileX === x && n.tileY === y);
    let fx = tx, fy = ty;
    const inBounds = tx >= 0 && tx < cols && ty >= 0 && ty < rows;
    if (!inBounds || !passable[ty][tx] || occupied(tx, ty)) {
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
    const { cols, rows, passable } = s.map;
    const inBounds = tx >= 0 && tx < cols && ty >= 0 && ty < rows;
    const occupied = (x: number, y: number) =>
      (s.player.tileX === x && s.player.tileY === y)
      || s.npcs.some((n) => n.hp > 0 && n.tileX === x && n.tileY === y);
    if (inBounds && passable[ty][tx] && !occupied(tx, ty)) {
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
      disposition: 'enemy', factionId: def.id,
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

  completeQuest(questId: string): GameEvent[] {
    this.addLogs(questComplete(this.state, questId));
    return [];
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
    if (!['ally', 'neutral', 'enemy'].includes(disposition)) return [];
    const npc = this.resolveNpcByEntity(entity);
    if (npc) {
      npc.disposition = disposition as Disposition;
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

  applyCondition(entity: string, condition: string): GameEvent[] {
    const s = this.state;
    if (entity === 'player') {
      if (!s.player.conditions.includes(condition)) s.player.conditions.push(condition);
      if (condition === 'unconscious' && !s.player.conditions.includes('prone')) s.player.conditions.push('prone');
    } else {
      const npc = this.resolveNpcByEntity(entity);
      if (npc && !npc.conditions.includes(condition)) npc.conditions.push(condition);
      if (condition === 'unconscious' && npc && !npc.conditions.includes('prone')) npc.conditions.push('prone');
    }
    return [];
  }

  removeCondition(entity: string, condition: string): GameEvent[] {
    const s = this.state;
    if (entity === 'player') {
      s.player.conditions = s.player.conditions.filter((c) => c !== condition);
    } else {
      const npc = this.resolveNpcByEntity(entity);
      if (npc) npc.conditions = npc.conditions.filter((c) => c !== condition);
    }
    return [];
  }

  rollAbilityCheck(skill: string, dc: number): { roll: number; total: number; success: boolean } {
    const { conditions, exhaustionLevel } = this.state.player;
    const skillMod = (this.playerDef.skills[skill] ?? 0) - exhaustionLevel * 2;
    const withDisadvantage = conditions.includes('poisoned') || conditions.includes('frightened');
    return rollSkillCheck(skillMod, dc, false, withDisadvantage);
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

  private advanceQuest(type: QuestGoalType): void {
    this.addLogs(questAdvance(this.state, type));
  }

  private autoEndCombatIfNoEnemies(): void {
    cfAutoEndCombat(this.ctx);
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

  private applyDamageToPlayer(damage: number, _events: GameEvent[]): void {
    const s = this.state;
    const hpBefore = s.player.hp;
    s.player.hp = Math.max(0, hpBefore - damage);
    this.addLog({ left: `${this.playerDef.name} HP: ${s.player.hp}/${this.playerDef.maxHp}`, style: 'status' });
    this.bus.publish({ type: 'damage_dealt', target: 'player', amount: damage });
    publishHpThresholdCrossings(this.ctx, 'player', hpBefore, s.player.hp, this.playerDef.maxHp);
    // Concentration save: any damage while concentrating triggers a CON save.
    if (s.player.concentratingOn) maybeBreakConcentration(this.ctx, damage);
    if (s.player.hp > 0) return;
    s.player.conditions = s.player.conditions.filter((c) => c !== 'hidden');
    const leftover = damage - hpBefore;
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
    dying.conditions = dying.conditions.filter((c) => c !== 'hidden');
    // A dead source can't sustain its periodic effects — drop any attach
    // effects it had on the player or other NPCs.
    s.player.ongoingEffects = s.player.ongoingEffects.filter((oe) => oe.sourceNpcId !== id);
    for (const n of s.npcs) {
      n.ongoingEffects = n.ongoingEffects.filter((oe) => oe.sourceNpcId !== id);
    }
    // NOTE: do NOT remove from turnOrderIds. The advance loop in CombatFlow
    // skips any combatant whose hp <= 0; mutating the array mid-iteration
    // would shift indices and could cause a still-alive combatant to skip
    // their turn.
    this.advanceQuest('kill');
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

    s.availableActions = {
      canAttack: Guard.canAttackTarget(this.ctx),
      throwableItemIds,
      canHide: Guard.canHide(this.ctx),
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

  // ── Long Rest ──────────────────────────────────────────────────────────────

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
      { playerDef: this.playerDef, player: this.state.player, features: this.defs.features, spells: this.defs.spells },
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

    this.computeAvailableActions();
    return preview;
  }

  private findFreeTileNear(cx: number, cy: number, minDist: number, maxDist: number): [number, number] {
    const s = this.state;
    const { cols, rows, passable } = s.map;
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
          if (!passable[tr][tc]) continue;
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
    if (history.length > 0) {
      const base = defs.playerDefs.find((p) => p.id === req.playerDefId);
      if (base) {
        const leveled = JSON.parse(JSON.stringify(base)) as PlayerDef;
        applyLevelUpHistory(leveled, history, defs.features, defs.spells);
        defsForBuild = {
          ...defs,
          playerDefs: defs.playerDefs.map((p) => p.id === base.id ? leveled : p),
        };
      }
    }
    const state = buildSessionState(sessionId, req, defsForBuild, savedMap);
    // Replay again inside the constructor so the engine's own clone is also
    // updated (defsForBuild is local to this method).
    return new GameEngine(state, defs, history);
  }
}
