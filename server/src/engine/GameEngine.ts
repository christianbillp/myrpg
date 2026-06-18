import {
  GameState, GameEvent, PlayerAction,
  PlayerDef, PlayerState, MonsterDef, GmpcActor,
  NpcState, Disposition,
  LogEntry, GameDefs,
  CreateSessionRequest,
} from './types.js';
import type { EncounterContext } from '../encounterService.js';
import {
  rollSkillCheck, rollSavingThrow,
  rollPlayerAttackVsAc, rollNpcAttackVsAc, npcSaveMod,
} from './CombatSystem.js';
import { rollDiceBonus, d20 } from './Dice.js';
import { applyEquipment, computeEquippedSlotLabels } from './EquipmentSystem.js';
import {
  gmpcIdForDef, buildGmpcPlayerState, buildGmpcShellDef, buildGmpcShell,
  pullShellIntoActor, pushActorIntoShell, retagPlayerEventsToActor, resetActorTurnEconomy,
} from './Gmpc.js';
import { gmpcTakeCombatTurn } from './GmpcCombatAI.js';
import { hasRelentlessEndurance, RELENTLESS_ENDURANCE_ID } from './SpeciesAbilities.js';
import { applyStoneEndurance } from './GiantGifts.js';
import { chebyshev } from './EnemyAI.js';
import { buildAIGMTools } from './AIGMTools.js';
import { setRelation, getRelation, isHostileTo } from './FactionRelations.js';
import { setIndividualRelation, reprojectDisposition, relation, aggroOnAttack as aggroOnAttackImpl } from './Relationships.js';
import { runOffCameraTick as runOffCameraTickImpl } from './WorldTick.js';
import { PLAYER_FACTION_ID, PLAYER_ID, INFLUENCE_SKILLS } from '../../../shared/types.js';
import { SKILL_ABILITY } from './Leveling.js';
import { Logger } from '../Logger.js';
import * as Guard from './ActionGuards.js';
import { clearHide, isDead, autoFailsStrDexSave, resistsAllDamage, npcConditionImmune } from './ConditionSystem.js';
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
  releaseGrappleFrom,
} from './CombatActions.js';
import { dropNpcConcentration } from './NpcConcentration.js';
import {
  doMove as exDoMove, doMoveTo as exDoMoveTo,
  doSearch as exDoSearch, doShortRest as exDoShortRest, doUsePotion as exDoUsePotion,
} from './ExplorationActions.js';
import { doEquip as ivDoEquip, doUnequip as ivDoUnequip } from './InventoryActions.js';
import { doCastSpell as spDoCastSpell } from './SpellSystem.js';
import { resolveImprovisedAction as iaResolveImprovisedAction } from './ImprovisedActionSystem.js';
import type { ImprovisedActionInput, ImprovisedActionResult } from './ImprovisedActionSystem.js';
import { isDeployableGear } from './TrapSystem.js';
import { doCommandSummon, checkSummonTether, registerSummonHooks } from './SummonSystem.js';
import { registerSoundHooks } from './Sound.js';
import { registerAwarenessHooks, registerCompanionFollowHooks } from './npcSim/index.js';
import { registerPresentationHooks } from './PresentationHooks.js';
import { registerWarlockHooks } from './WarlockFeatures.js';
import { maybeBreakConcentration, endConcentration } from './ConcentrationSystem.js';
import { doUseFeature } from './FeatureRegistry.js';
import { buildSessionState, SavedMapRecord } from './SessionBuilder.js';
import { scaledIncomingDamage } from './RunMutators.js';
import { registerTriggers, adjustFactionStanding, recordRumor, fireAction as triggerFireAction } from './TriggerSystem.js';
import {
  startConversation as cnStartConversation,
  advanceConversation as cnAdvanceConversation,
  endConversation as cnEndConversation,
} from './ConversationSystem.js';
import { registerDirector } from './Director.js';
import { registerEncounterProgress } from './EncounterProgress.js';
import { registerEncounterLifecycle, publishEncounterStarted } from './EncounterLifecycle.js';
import { registerQuestSystem, startQuest as qStartQuest, advanceQuest as qAdvanceQuest, completeQuest as qCompleteQuest, failQuest as qFailQuest } from './QuestSystem.js';
import { EventBus } from './EventBus.js';
import { publishHpThresholdCrossings } from './ThresholdPublisher.js';
import { WeaponDef } from './types.js';
import { buildLevelUpPreview, applyLevelUp, applyLevelUpHistory, syncCharacterTracks } from './Leveling.js';
import { canLevelUp } from '../../../shared/xpTable.js';
import type { LevelUpPreview, LevelUpChoices, LongRestPreview, LongRestChoices, ClassDef } from '../../../shared/types.js';
import { buildLongRestPreview, applyLongRest } from './Resting.js';
import { monsterLimitedUses } from './SpawnHelpers.js';
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
  registerQuestSystem,
  registerTriggers,
  registerSummonHooks,
  registerSoundHooks,
  registerAwarenessHooks,
  registerCompanionFollowHooks,
  registerPresentationHooks,
  registerWarlockHooks,
];

let uidCounter = 0;

export class GameEngine {
  private state: GameState;
  private defs: GameDefs;
  private playerDef: PlayerDef;
  /** GMPC character defs (US-130), cloned + level-up-replayed like the human's,
   *  keyed by GMPC actor id. */
  private gmpcDefs = new Map<string, PlayerDef>();
  /** Synthetic `MonsterDef` shell stat blocks for GMPCs (US-130), keyed by the
   *  shell's `defId` (a `PlayerDef` id), so enemy targeting / initiative read
   *  the GMPC's real AC and abilities. */
  private gmpcShellDefs = new Map<string, MonsterDef>();
  /** The PlayerDef of whoever's turn it is for player-mechanics resolution —
   *  the human's def by default, a GMPC's while `withActor` is bound. Exposed
   *  through `ctx.playerDef` (a getter) so every existing handler resolves the
   *  active actor with no edits. */
  private activeDef: PlayerDef;
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
    // Re-apply persisted Strength drain (SRD Shadow Draining Swipe) — the
    // drain mutates only the per-session clone, so it's recorded as a delta
    // on the player state and replayed here, same pattern as the level-up
    // history above.
    if (state.player.strengthDrained) {
      this.playerDef.str = Math.max(0, this.playerDef.str - state.player.strengthDrained);
    }
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
    applyEquipment(this.playerDef, state.player.equippedSlots, this.defs.equipment, state.player.mageArmor, state.player.shieldActive, 0, state.player.attunedItemIds ?? []);
    state.player.ac = this.playerDef.ac;
    state.player.equippedSlotLabels = computeEquippedSlotLabels(this.playerDef, state.player.equippedSlots, this.defs.equipment);
    this.activeDef = this.playerDef;

    // US-130: register each GMPC — build its full PC def, synthetic shell stat
    // block, and ensure its on-map ally shell exists.
    for (const gmpc of state.gmpcs ?? []) this.registerGmpc(gmpc);

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
    const partyView = { id: PLAYER_ID, factionId: PLAYER_FACTION_ID } as const;
    return this.state.npcs.some((n) => n.hp > 0
      && isHostileTo(this.state, partyView, { id: n.id, factionId: n.factionId }));
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

  /**
   * Clone a character def and run it through the same level-up-replay + track
   * sync + Strength-drain reapplication the human's def gets, so a GMPC fields
   * its full PC kit. Returns null when the def id isn't in the roster.
   * (Level-up history for GMPCs isn't persisted yet — they boot at their
   * authored level; cross-session GMPC advancement is a later slice.)
   */
  private buildActorDef(defId: string, st: PlayerState): PlayerDef | undefined {
    const shared = this.defs.playerDefs.find((p) => p.id === defId);
    if (!shared) return undefined;
    const def: PlayerDef = JSON.parse(JSON.stringify(shared));
    syncCharacterTracks(def, this.defs.classes);
    if (st.strengthDrained) def.str = Math.max(0, def.str - st.strengthDrained);
    return def;
  }

  /**
   * Register a GMPC (US-130): build its full level-up-replayed, equipped def;
   * synthesise the shell stat block enemies target against; and ensure its ally
   * `NpcState` shell exists on the map. Idempotent — safe to call at boot and
   * when a GMPC is added mid-session.
   */
  private registerGmpc(gmpc: GmpcActor): void {
    const def = this.buildActorDef(gmpc.defId, gmpc.state);
    if (!def) return;
    this.gmpcDefs.set(gmpc.id, def);
    applyEquipment(def, gmpc.state.equippedSlots, this.defs.equipment, gmpc.state.mageArmor, gmpc.state.shieldActive, 0, gmpc.state.attunedItemIds ?? []);
    gmpc.state.ac = def.ac;
    gmpc.state.equippedSlotLabels = computeEquippedSlotLabels(def, gmpc.state.equippedSlots, this.defs.equipment);
    this.gmpcShellDefs.set(def.id, buildGmpcShellDef(def));
    if (!this.state.npcs.some((n) => n.gmpcId === gmpc.id)) {
      this.state.npcs.push(buildGmpcShell(gmpc.id, def, gmpc.state));
    }
  }

  /** The on-map shell for a GMPC, or undefined if it has none yet. */
  private gmpcShell(gmpcId: string): NpcState | undefined {
    return this.state.npcs.find((n) => n.gmpcId === gmpcId);
  }

  /**
   * Run `fn` with the named actor bound as "the active player" (US-130). For a
   * GMPC this physically binds its `PlayerState` into `state.player` and points
   * `activeDef` at its def for the call's duration, then restores the human —
   * so every player-mechanics path (attacks, leveled spellcasting, features,
   * resting) operates on the GMPC unchanged. A no-op for `'player'`.
   */
  withActor<T>(actorId: string, fn: () => T): T {
    if (actorId === 'player' || actorId === PLAYER_ID) return fn();
    const gmpc = (this.state.gmpcs ?? []).find((g) => g.id === actorId);
    const def = this.gmpcDefs.get(actorId);
    if (!gmpc || !def) return fn();
    const savedPlayer = this.state.player;
    const savedDef = this.activeDef;
    const savedActiveId = this.state.activeActorId;
    const savedParked = this.state.parkedActorTile;
    // Pull the shell's map-canonical fields (HP/pos/conditions enemies imposed)
    // into the GMPC's full state before it acts; write them back after.
    const shell = this.gmpcShell(actorId);
    if (shell) pullShellIntoActor(shell, gmpc.state);
    this.state.player = gmpc.state;
    this.activeDef = def;
    this.state.activeActorId = actorId;
    // Keep the swapped-out human as a movement obstacle for the bound GMPC.
    this.state.parkedActorTile = { x: savedPlayer.tileX, y: savedPlayer.tileY };
    try {
      return fn();
    } finally {
      this.state.player = savedPlayer;
      this.activeDef = savedDef;
      this.state.activeActorId = savedActiveId;
      this.state.parkedActorTile = savedParked;
      if (shell) pushActorIntoShell(gmpc.state, shell);
    }
  }

  private buildCtx(): GameContext {
    // `playerDef` is a getter so it tracks the active actor (the human, or a
    // GMPC while `withActor` is bound) without touching the ~800 read sites.
    const self = this;
    return {
      get state() { return self.state; },
      get playerDef() { return self.activeDef; },
      defs: this.defs,
      addLog: (e) => this.addLog(e),
      addLogs: (es) => this.addLogs(es),
      uid: () => `e${++uidCounter}`,
      resolveMonsterDef: (id) => this.resolveMonsterDef(id),
      resolveNpcByEntity: (e) => this.resolveNpcByEntity(e),
      assignCombatLabel: (npc) => this.assignCombatLabel(npc),
      aggroOnAttack: (npc) => this.aggroOnAttack(npc),
      autoEndCombatIfNoEnemies: () => this.autoEndCombatIfNoEnemies(),
      resistMod: (d, t, def, n) => this.resistMod(d, t, def, n),
      applyDamageToPlayer: (d, ev, dt) => this.applyDamageToPlayer(d, ev, dt),
      killNpc: (id) => this.killNpc(id),
      killWithReward: (npc, def, msg, t) => this.killWithReward(npc, def, msg, t),
      knockOutNpc: (npc, def) => this.knockOutNpc(npc, def),
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
        runGmpcTurn: (gmpcId, events) => this.runGmpcCombatTurn(gmpcId, events),
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
    this.syncGmpcShells();
    this.computeAvailableActions();
    return this.state;
  }

  /**
   * US-130 — reflect each GMPC shell's map-canonical HP/position/conditions back
   * onto its full `PlayerState` so the serialised `state.gmpcs` (read by the
   * client party UI and the AIGM party section) is consistent between turns,
   * when enemies have damaged or moved the shell.
   */
  private syncGmpcShells(): void {
    for (const gmpc of this.state.gmpcs ?? []) {
      // Skip the GMPC currently bound and acting — its actor state is canonical
      // mid-turn (and `withActor` writes back to the shell on exit).
      if (this.state.activeActorId === gmpc.id) continue;
      const shell = this.gmpcShell(gmpc.id);
      if (shell) pullShellIntoActor(shell, gmpc.state);
    }
  }

  /** Dev-mode normalisation pass — called from `getState`. Idempotent. */
  private applyDevFlagsTopup(): void {
    const flags = this.state.devFlags;
    if (!flags) return;
    const p = this.state.player;
    if (flags.unlimitedActions) {
      p.actionUsed = false;
      p.bonusActionUsed = false;
      p.attacksRemaining = 0;
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
  /** Look up an authored quest definition by id (for the AIGM `start_quest` tool). */
  getQuestDef(questId: string) { return this.defs.quests.find((q) => q.id === questId); }
  getAIGMTools() { return buildAIGMTools(); }
  getItemIds(): string[] { return this.defs.equipment.map((i) => i.id); }
  getMonsterIds(): string[] { return this.defs.monsters.map((m) => m.id); }

  private resolveMonsterDef(defId: string): MonsterDef | undefined {
    const direct = this.defs.monsters.find((m) => m.id === defId);
    if (direct) return direct;
    const npcDef = this.defs.npcs.find((n) => n.id === defId);
    if (npcDef) return this.defs.monsters.find((m) => m.id === npcDef.monsterClass);
    // US-130 — a GMPC shell's defId is a PlayerDef id; resolve its synthetic
    // stat block so enemy targeting / initiative read the GMPC's real AC.
    return this.gmpcShellDefs.get(defId);
  }

  /** Flavour description for a spawned creature — the NPC wrapper's own when
   *  authored, the monster class's as a fallback. Shown on the Target Panel
   *  (client-side resolution) and surfaced to the AIGM as appearance context. */
  getCreatureDescription(defId: string): string | undefined {
    const npcDef = this.defs.npcs.find((n) => n.id === defId);
    return npcDef?.description ?? this.resolveMonsterDef(defId)?.description;
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

  /**
   * US-130 — run a single `PlayerAction` as a GMPC. The named GMPC is bound as
   * the active actor for the call (`withActor`), so the action flows through the
   * exact same handler registry the human player uses — its attacks, leveled
   * spellcasting, class features, and resting all resolve against the GMPC's own
   * `PlayerState` (HP, spell slots, resource pools) with zero handler edits.
   *
   * Returns the same `{ events, state }` shape as `processAction`. The serialized
   * `state.player` is always the human (the swap is restored in `withActor`'s
   * finally), so the wire model is unchanged — the GMPC's mutated state lives in
   * `state.gmpcs`.
   */
  gmpcAct(gmpcId: string, action: PlayerAction): ActionResult {
    const events: GameEvent[] = [];
    this.ctx.eventSink = events;
    try {
      if (action.type === 'endTurn') {
        // End the GMPC's turn: drop its active highlight, clear the actor
        // binding, and hand off to the next combatant in initiative order.
        if (this.state.phase === 'gmpc_turn' && this.state.activeActorId === gmpcId) {
          const shell = this.gmpcShell(gmpcId);
          if (shell) shell.isActive = false;
          this.state.activeActorId = PLAYER_ID;
          cfAdvanceTurn(this.ctx, events);
        }
      } else {
        // Present the GMPC's turn to the action handlers as a normal
        // `player_turn`: the vast majority of move / attack / cast / feature
        // paths gate on `phase === 'player_turn'`, and the bound actor IS the
        // active turn-taker. Restored to `gmpc_turn` after — unless the action
        // itself legitimately transitioned the phase (e.g. killing the last
        // enemy ends combat → `exploring`), in which case the new phase wins.
        const savedPhase = this.state.phase;
        if (savedPhase === 'gmpc_turn') this.state.phase = 'player_turn';
        try {
          this.withActor(gmpcId, () => {
            dispatchPlayerAction(this.ctx, action, events, this);
          });
        } finally {
          if (savedPhase === 'gmpc_turn' && this.state.phase === 'player_turn') {
            this.state.phase = 'gmpc_turn';
          }
        }
        // The handlers ran on the swapped `state.player`, so they tagged their
        // animation events as `'player'`. Throughout a GMPC action window the
        // GMPC *is* `state.player` (the human isn't), so retag those events to
        // the GMPC's shell id — otherwise the client animates the human's token
        // (movement, attack swings, cast VFX, even an enemy OA against it).
        retagPlayerEventsToActor(events, gmpcId);
      }
      const state = this.getState();
      return { events, state };
    } finally {
      this.ctx.eventSink = null;
    }
  }

  /**
   * US-130 — resolve a GMPC's combat turn deterministically (no LLM). Binds the
   * actor, presents the phase as `player_turn` so the standard handlers run, and
   * drives the combat AI, which dispatches the GMPC's move + attack/cast through
   * the same registry the human uses. Events are retagged to the shell so the
   * client animates the GMPC. Turn completion (advancing initiative) is the
   * caller's (`advanceTurn`'s) job.
   */
  runGmpcCombatTurn(gmpcId: string, events: GameEvent[]): void {
    const savedPhase = this.state.phase;
    if (savedPhase !== 'enemy_turn' && savedPhase !== 'gmpc_turn' && savedPhase !== 'player_turn') return;
    this.state.phase = 'player_turn';
    try {
      this.withActor(gmpcId, () => {
        resetActorTurnEconomy(this.state.player, this.activeDef);
        gmpcTakeCombatTurn(this.ctx, (action) => dispatchPlayerAction(this.ctx, action, events, this));
      });
    } finally {
      // Restore the loop's phase unless the turn itself ended combat / downed
      // someone (those transitions win).
      if (this.state.phase === 'player_turn') this.state.phase = savedPhase;
      retagPlayerEventsToActor(events, gmpcId);
    }
  }

  /** True when the given id names a registered GMPC. */
  isGmpc(id: string): boolean {
    return this.gmpcDefs.has(id);
  }

  /**
   * US-130 — add a GMPC to the party mid-session from a `PlayerDef` id (the
   * `add_gmpc` AIGM tool). Builds a fresh full-kit `PlayerState`, registers the
   * actor + shell, and — if a fight is underway — rolls it into initiative.
   * Returns the new GMPC's id, or null when the def id is unknown.
   */
  addGmpc(defId: string, persona?: string, tile?: { x: number; y: number }): { id: string } | null {
    const shared = this.defs.playerDefs.find((p) => p.id === defId);
    if (!shared) return null;
    const id = gmpcIdForDef(defId);
    if (this.gmpcDefs.has(id)) return { id };  // already present — idempotent
    const anchor = tile ?? this.findFreeTileNear(this.state.player.tileX, this.state.player.tileY, 1, 4);
    const [tx, ty] = Array.isArray(anchor) ? anchor : [anchor.x, anchor.y];
    const placed = tx === -1
      ? { x: this.state.player.tileX, y: this.state.player.tileY }
      : { x: tx, y: ty };
    const st = buildGmpcPlayerState(shared, this.defs, placed);
    const gmpc: GmpcActor = { id, defId, state: st, persona };
    (this.state.gmpcs ??= []).push(gmpc);
    this.registerGmpc(gmpc);
    // Join an in-progress fight: roll initiative and slot into the order.
    if (this.state.phase !== 'exploring' && !this.state.turnOrderIds.includes(id)) {
      const shellDef = this.gmpcShellDefs.get(defId);
      st.initiativeRoll = (shellDef ? d20() + shellDef.initiativeBonus : d20());
      const shell = this.gmpcShell(id);
      if (shell) shell.initiativeRoll = st.initiativeRoll;
      this.state.turnOrderIds.push(id);
    }
    return { id };
  }

  /** Look up a GMPC's built (level-up-replayed, equipped) PlayerDef — for the
   *  AIGM party section + any UI that needs the GMPC's class kit. */
  getGmpcDef(gmpcId: string): PlayerDef | undefined {
    return this.gmpcDefs.get(gmpcId);
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
      ...monsterLimitedUses(def),
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
  /** Replace the player-facing OBJECTIVE line. Surfaced for the AIGM
   *  `set_objective` tool so the GM can advance the goal as the story moves. */
  setObjective(text: string): void {
    this.state.objective = text;
  }

  // ── Quests (structured quest system) — surfaced for the AIGM quest tools ──────
  startQuest(def: import('../../../shared/types.js').QuestDef): boolean {
    return qStartQuest(this.ctx, def) !== null;
  }
  advanceQuest(questId: string, toStepId?: string): boolean {
    return qAdvanceQuest(this.ctx, questId, toStepId);
  }
  completeQuest(questId: string): boolean {
    return qCompleteQuest(this.ctx, questId);
  }
  failQuest(questId: string): boolean {
    return qFailQuest(this.ctx, questId);
  }
  /** Lookup the effective relation between two factions (worse-direction). Surfaced for AIGM tool result strings. */
  getFactionRelation(a: string, b: string): number {
    return getRelation(this.state, a, b);
  }
  /** Directed individual relation `a → b` (individual override → faction baseline → 0). Surfaced for AIGM tool result strings. */
  getIndividualRelation(a: string, b: string): number {
    return relation(this.state, a, b);
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
      // Write the player↔NPC *individual* relationship; disposition is then a
      // projection of it. 'enemy' rallies the NPC's friends (aggroOnAttack);
      // 'ally' is an explicit friendly-combatant flag; 'neutral' pins the link
      // to 0 in both directions so it overrides any hostile faction baseline.
      if ((disposition === 'ally' || disposition === 'enemy') && !npc.combatLabel) this.assignCombatLabel(npc);
      if (disposition === 'enemy') {
        setIndividualRelation(this.state, npc.id, PLAYER_ID, -100);
        this.aggroOnAttack(npc);
      } else if (disposition === 'ally') {
        setIndividualRelation(this.state, npc.id, PLAYER_ID, 100, { mirror: true });
        npc.disposition = 'ally';
      } else {
        setIndividualRelation(this.state, npc.id, PLAYER_ID, 0, { mirror: true });
        reprojectDisposition(this.state, npc);
        this.autoEndCombatIfNoEnemies();
      }
      Logger.log('combat.disposition_changed', { npcId: npc.id, defId: npc.defId, before, after: npc.disposition });
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
    const beats: GameEvent[] = [];
    if (entity === 'player') {
      if (!s.player.conditions.includes(condition)) {
        s.player.conditions.push(condition);
        Logger.log('combat.condition_added', { entity: 'player', condition, reason });
        beats.push({ type: 'condition_changed', entityId: 'player', condition, change: 'applied' });
      }
      if (condition === 'unconscious' && !s.player.conditions.includes('prone')) {
        s.player.conditions.push('prone');
        Logger.log('combat.condition_added', { entity: 'player', condition: 'prone', reason: 'unconscious_implies_prone' });
        beats.push({ type: 'condition_changed', entityId: 'player', condition: 'prone', change: 'applied' });
      }
    } else {
      const npc = this.resolveNpcByEntity(entity);
      if (!npc) {
        Logger.warn('anomaly.unknown_entity', { tool: 'apply_condition', entity });
      }
      const def = npc ? this.resolveMonsterDef(npc.defId) : undefined;
      if (npc && def && npcConditionImmune(def, condition)) {
        this.addLog({ left: `${npc.name} is immune to ${condition}`, style: 'normal' });
        Logger.log('combat.condition_immune', { entity: npc.id, defId: npc.defId, condition, reason });
        return [];
      }
      if (npc && !npc.conditions.includes(condition)) {
        npc.conditions.push(condition);
        Logger.log('combat.condition_added', { entity: npc.id, defId: npc.defId, condition, reason });
        beats.push({ type: 'condition_changed', entityId: npc.id, condition, change: 'applied' });
      }
      if (condition === 'unconscious' && npc && !npc.conditions.includes('prone')) {
        npc.conditions.push('prone');
        Logger.log('combat.condition_added', { entity: npc.id, defId: npc.defId, condition: 'prone', reason: 'unconscious_implies_prone' });
        beats.push({ type: 'condition_changed', entityId: npc.id, condition: 'prone', change: 'applied' });
      }
    }
    return beats;
  }

  removeCondition(entity: string, condition: string, reason = 'aigm.remove_condition'): GameEvent[] {
    const s = this.state;
    const beats: GameEvent[] = [];
    if (entity === 'player') {
      if (s.player.conditions.includes(condition)) {
        s.player.conditions = s.player.conditions.filter((c) => c !== condition);
        Logger.log('combat.condition_removed', { entity: 'player', condition, reason });
        beats.push({ type: 'condition_changed', entityId: 'player', condition, change: 'removed' });
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
          beats.push({ type: 'condition_changed', entityId: npc.id, condition, change: 'removed' });
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
    return beats;
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
    const base = rollSkillCheck(skillMod, dc, withAdvantage, withDisadvantage, this.playerDef.halflingLuck);
    // Guidance and kin add a die to ability checks.
    const checkBonus = rollDiceBonus(this.state.player.checkDiceBonus);
    const result = checkBonus > 0
      ? { roll: base.roll, total: base.total + checkBonus, success: base.total + checkBonus >= dc }
      : base;
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

  /** First-class improvised-action resolution (resolve_improvised_action tool)
   *  — band → DC, Action spend in combat, and the roll all live in
   *  ImprovisedActionSystem; the roll routes back through `rollAbilityCheck`
   *  so every active check modifier applies. */
  resolveImprovisedAction(input: ImprovisedActionInput): ImprovisedActionResult {
    return iaResolveImprovisedAction(this.ctx, input, (skill, dc, target) => this.rollAbilityCheck(skill, dc, target));
  }

  rollPlayerSavingThrow(ability: string, dc: number): { roll: number; total: number; success: boolean; autoFail: boolean } {
    const { conditions, exhaustionLevel } = this.state.player;
    if ((ability === 'str' || ability === 'dex') && autoFailsStrDexSave(conditions)) {
      return { roll: 0, total: 0, success: false, autoFail: true };
    }
    const saveMod = (this.playerDef.savingThrows[ability] ?? 0) + (this.playerDef.saveBonus ?? 0) - exhaustionLevel * 2;
    // Bless adds a die to saves; Haste / Beacon of Hope grant save Advantage.
    const withAdvantage = (ability === 'dex' && conditions.includes('dodging')) || !!this.state.player.buffSaveAdvantage?.includes(ability);
    const withDisadvantage = ability === 'dex' && conditions.includes('restrained');
    const base = rollSavingThrow(saveMod, dc, withAdvantage, withDisadvantage, this.playerDef.halflingLuck);
    const saveBonus = rollDiceBonus(this.state.player.saveDiceBonus);
    const total = base.total + saveBonus;
    return { roll: base.roll, total, success: total >= dc, autoFail: false };
  }

  /** Roll a saving throw for an NPC against a DC (request_npc_saving_throw
   *  tool) — the stat block's save modifier via `npcSaveMod` (Bane applies),
   *  with the same Str/Dex auto-fail conditions as the player path. */
  rollNpcSavingThrow(entity: string, ability: string, dc: number):
    | { found: false }
    | { found: true; name: string; roll: number; total: number; success: boolean; autoFail: boolean } {
    const npc = this.resolveNpcByEntity(entity);
    const def = npc ? this.resolveMonsterDef(npc.defId) : undefined;
    if (!npc || !def) return { found: false };
    const name = npc.revealedName ?? npc.name;
    if ((ability === 'str' || ability === 'dex') && autoFailsStrDexSave(npc.conditions)) {
      return { found: true, name, roll: 0, total: 0, success: false, autoFail: true };
    }
    const saveBonus = npcSaveMod(npc, def, ability);
    const roll = d20();
    const total = roll + saveBonus;
    Logger.log('check.npc_saving_throw', { entity, defId: npc.defId, ability, dc, saveBonus, roll, total, success: total >= dc });
    return { found: true, name, roll, total, success: total >= dc, autoFail: false };
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

  /**
   * Relationship-aware aggro: the attacked NPC turns hostile to the player and
   * so does everyone who is *friendly to it* (friends defend), regardless of
   * faction — while intra-faction enemies of the victim do NOT rally. Replaces
   * the old same-faction cascade. Reprojects every NPC's disposition and assigns
   * combat labels to the newly-hostile.
   */
  private aggroOnAttack(victim: NpcState): void {
    aggroOnAttackImpl(this.state, victim);
    for (const npc of this.state.npcs) {
      if (npc.disposition === 'enemy' && !npc.combatLabel) this.assignCombatLabel(npc);
    }
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
    // SRD Petrified (US-058): Resistance to ALL damage + immunity to poison.
    if (resistsAllDamage(this.state.player.conditions) && !def.immunities?.includes(damageType)) {
      if (damageType === 'poison') {
        this.addLog({ left: `${name} is Petrified — immune to ${damageType} — ${damage}→0`, right: '×0', style: 'status' });
        return 0;
      }
      const fd = Math.floor(damage / 2);
      this.addLog({ left: `${name} is Petrified — resists all damage — ${damage}→${fd}`, right: '×½', style: 'status' });
      return fd;
    }
    if (def.immunities?.includes(damageType)) {
      this.addLog({ left: `${name} is immune to ${damageType} — ${damage}→0`, right: '×0', style: 'status' });
      return 0;
    }
    if (def.resistances?.includes(damageType) || this.state.player.buffResistances?.includes(damageType)) {
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
    // Run mutator (#29) — "Deadly": scale ALL incoming player damage before any
    // resistance / temp-HP math, so the harsher numbers flow through the normal
    // pipeline (logs, concentration save, thresholds).
    damage = scaledIncomingDamage(damage, s.mutators);
    // SRD: resistance/vulnerability/immunity adjusts the typed damage first,
    // before Temporary HP absorbs and before the CON save sees it.
    let effective = damageType ? this.playerResistMod(damage, damageType) : damage;
    // SRD Resistance cantrip: reduce damage of the warded type by 1d4. (The
    // SRD "only once per turn" limit is not modelled — every matching instance
    // is reduced.)
    const dr = s.player.buffDamageReduction;
    if (dr && effective > 0 && damageType === dr.damageType) {
      const reduced = rollDiceBonus({ count: dr.count, sides: dr.sides });
      const after = Math.max(0, effective - reduced);
      this.addLog({ left: `Resistance wards ${dr.damageType} — ${effective}→${after} (−${reduced})`, style: 'status' });
      effective = after;
    }
    // SRD Goliath Stone's Endurance: a Reaction that reduces the damage taken
    // by 1d12 + CON before Temporary HP / real HP see it.
    effective = applyStoneEndurance(this.ctx, effective);
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
    const leftover = effective - hpBefore;
    const killedOutright = leftover >= this.playerDef.maxHp;
    // SRD Orc Relentless Endurance: when reduced to 0 HP but not killed
    // outright, drop to 1 HP instead. Once per Long Rest. The character stays
    // conscious, so concentration (already CON-saved above) is not dropped.
    if (!killedOutright && this.tryRelentlessEndurance()) {
      s.player.hp = 1;
      this.addLog({ left: `${this.playerDef.name} refuses to fall — Relentless Endurance holds them at 1 HP!`, style: 'status' });
      return;
    }
    clearHide(s.player);
    // SRD: Concentration ends if you have the Incapacitated condition or
    // you die. Falling to 0 HP triggers Unconscious (which is Incapacitated),
    // so drop any concentration the player was holding before the phase flip.
    if (s.player.concentratingOn) endConcentration(this.ctx, 'caster fell unconscious');
    if (killedOutright) {
      this.addLog({ left: `Massive damage — ${this.playerDef.name} dies instantly`, style: 'kill' });
      s.phase = 'defeat';
    } else {
      this.addLog({ left: `${this.playerDef.name} falls unconscious!`, style: 'status' });
      s.phase = 'death_saves';
    }
  }

  /** SRD Orc Relentless Endurance: consume one use (1/Long Rest) if the species
   *  grants it and a use remains. Returns whether the drop-to-1 rescue fires. */
  private tryRelentlessEndurance(): boolean {
    if (!hasRelentlessEndurance(this.playerDef, this.defs.species)) return false;
    const remaining = this.state.player.resources[RELENTLESS_ENDURANCE_ID] ?? 0;
    if (remaining <= 0) return false;
    this.state.player.resources[RELENTLESS_ENDURANCE_ID] = remaining - 1;
    return true;
  }

  private killNpc(id: string): void {
    const s = this.state;
    const dying = s.npcs.find((n) => n.id === id);
    if (!dying) return;
    // Most callers reach here with hp already at 0 (the damage paths clamp
    // first), but direct kills (devCompleteEncounter, NPC-cast AoE) must not
    // leave a "dead" NPC standing at full hp — isDead() and enemies_alive
    // both read hp.
    dying.hp = 0;
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
    // SRD: a grapple ends when the grappler dies (US-125, Bugbear Grab).
    releaseGrappleFrom(this.ctx, id, `${dying.name} is down`);
    // An NPC caster's concentration (and the buffs it sustains — the Priest
    // Acolyte's Bless) ends with it.
    if (dying.concentratingOn) dropNpcConcentration(this.ctx, dying);
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

  /** SRD Knocking Out a Creature (US-052): the melee blow that would kill
   *  instead leaves the target Unconscious + Stable — defeated for XP and
   *  combat purposes, but alive (no loot drop, no `npc_killed`). Reviving it
   *  (regaining any HP) clears the Unconscious condition. */
  private knockOutNpc(npc: NpcState, def: MonsterDef): void {
    const s = this.state;
    s.player.xp += def.xp;
    this.addLog({ left: `☄ ${npc.name} is knocked out — +${def.xp} XP`, style: 'kill' });
    if (!npc.conditions.includes('unconscious')) npc.conditions.push('unconscious');
    if (!npc.conditions.includes('stable')) npc.conditions.push('stable');
    npc.isActive = false;
    clearHide(npc);
    // A downed creature can't sustain its attach DoTs — drop them, as killNpc does.
    s.player.ongoingEffects = s.player.ongoingEffects.filter((oe) => oe.kind !== 'attach' || oe.sourceNpcId !== npc.id);
    for (const n of s.npcs) n.ongoingEffects = n.ongoingEffects.filter((oe) => oe.kind !== 'attach' || oe.sourceNpcId !== npc.id);
    this.autoEndCombatIfNoEnemies();
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
    // Study points: un-fired `study_feature` triggers, surfaced regardless of
    // distance (the client gates to ≤1 tile and prompts "move closer"). Empty
    // when an Action isn't available, so STUDY falls back to the GM-chat prompt.
    const studyPointTiles = canActNow
      ? s.triggers
          .filter((t) => t.when.event === 'study_feature'
            && (t.once === false || !s.firedTriggerIds.includes(t.id)))
          .map((t) => (t.when as Extract<typeof t.when, { event: 'study_feature' }>).tile)
      : [];
    // Rite points: un-fired `magic_feature` triggers, surfaced for the MAGIC action.
    const magicPointTiles = canActNow
      ? s.triggers
          .filter((t) => t.when.event === 'magic_feature'
            && (t.once === false || !s.firedTriggerIds.includes(t.id)))
          .map((t) => (t.when as Extract<typeof t.when, { event: 'magic_feature' }>).tile)
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

    // Help (US-057): distract an adjacent enemy so a living ally gets Advantage,
    // OR aid an adjacent neutral creature (e.g. free a captive — free out of
    // combat). Ready: Action + Reaction free, not already readied, a living enemy.
    let canHelp = false;
    let canReady = false;
    const adjNeutral = s.npcs.some((n) => n.disposition === 'neutral' && n.hp > 0 && chebyshev(p.tileX, p.tileY, n.tileX, n.tileY) <= 1);
    if (Guard.canSpendAction(this.ctx)) {
      const adjEnemy = s.npcs.some((n) => n.disposition === 'enemy' && n.hp > 0 && chebyshev(p.tileX, p.tileY, n.tileX, n.tileY) <= 1);
      const livingAlly = s.npcs.some((n) => n.disposition === 'ally' && n.hp > 0);
      canHelp = (adjEnemy && livingAlly) || adjNeutral;
      canReady = phase === 'player_turn' && !p.reactionUsed && !p.readiedAttack
        && s.npcs.some((n) => n.disposition === 'enemy' && n.hp > 0);
    } else if (phase === 'exploring' && adjNeutral) {
      canHelp = true;
    }

    // Attunement (US-124): magic + requiresAttunement items the player holds,
    // not yet attuned, while exploring with fewer than 3 attuned.
    let attunableItemIds: string[] = [];
    const attuned = p.attunedItemIds ?? [];
    if (phase === 'exploring' && attuned.length < 3) {
      const held = new Set<string>([...p.inventoryIds, ...Object.values(p.equippedSlots).filter((x): x is string => !!x)]);
      attunableItemIds = [...held].filter((id) => {
        if (attuned.includes(id)) return false;
        const it = this.defs.equipment.find((e) => e.id === id) as { magic?: boolean; requiresAttunement?: boolean } | undefined;
        return !!it?.magic && !!it?.requiresAttunement;
      });
    }

    // Identify (US-124): held items flagged startsUnidentified, not yet
    // identified, while exploring.
    let unidentifiedItemIds: string[] = [];
    if (phase === 'exploring') {
      const identified = p.identifiedItemIds ?? [];
      const held = new Set<string>([...p.inventoryIds, ...Object.values(p.equippedSlots).filter((x): x is string => !!x)]);
      unidentifiedItemIds = [...held].filter((id) => {
        if (identified.includes(id)) return false;
        const it = this.defs.equipment.find((e) => e.id === id) as { startsUnidentified?: boolean } | undefined;
        return !!it?.startsUnidentified;
      });
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
      canEscapeGrapple: Guard.canEscapeGrapple(this.ctx),
      canToggleLight: Guard.canToggleLight(this.ctx),
      canOffhandAttack: Guard.canOffhandAttack(this.ctx),
      // LEVEL UP is offered in exploration only — the overlay opens a modal
      // dialogue and applies HP / feature changes that shouldn't land mid-turn.
      canLevelUp: phase === 'exploring' && canLevelUp(this.playerDef.level, p.xp),
      // LONG REST is gated by the encounter — only safehouses / taverns set
      // `allowsLongRest`. Combat phases block it outright.
      canLongRest: phase === 'exploring' && s.allowsLongRest === true,
      disarmableTrapTiles,
      studyPointTiles,
      magicPointTiles,
      deployableGearIds,
      grappleableTargetIds,
      shoveableTargetIds,
      attunableItemIds,
      unidentifiedItemIds,
      canHelp,
      canReady,
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
      { playerDef: this.playerDef, player: this.state.player, features: this.defs.features, spells: this.defs.spells, classDef: this.resolvePlayerClassDef(), species: this.defs.species, npcs: this.state.npcs },
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
