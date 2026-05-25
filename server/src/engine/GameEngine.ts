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
import { buildAIDMTools } from './AIDMTools.js';
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
  doDisengage as caDoDisengage,
  doPlayerOpportunityAttack as caDoPlayerOA,
} from './CombatActions.js';
import {
  doMove as exDoMove, doMoveTo as exDoMoveTo,
  doSearch as exDoSearch, doShortRest as exDoShortRest, doUsePotion as exDoUsePotion,
} from './ExplorationActions.js';
import { doEquip as ivDoEquip, doUnequip as ivDoUnequip } from './InventoryActions.js';
import { doCastSpell as spDoCastSpell } from './SpellSystem.js';
import { maybeBreakConcentration } from './ConcentrationSystem.js';
import { doUseFeature } from './FeatureRegistry.js';
import { buildSessionState, SavedMapRecord } from './SessionBuilder.js';
import { WeaponDef } from './types.js';

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

  constructor(state: GameState, defs: GameDefs) {
    this.state = state;
    // Clone the player def so per-session equipment mutations never leak into the
    // shared GameDefs (which is reused across every session in the process).
    const sharedDef = defs.playerDefs.find((p) => p.id === state.player.defId)!;
    this.playerDef = JSON.parse(JSON.stringify(sharedDef));
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
    };
  }

  getState(): GameState { this.computeAvailableActions(); return this.state; }
  getMonsterDef(defId: string): MonsterDef | undefined { return this.resolveMonsterDef(defId); }
  getSpellDef(spellId: string) { return this.defs.spells.find((sp) => sp.id === spellId); }
  getAIDMTools() { return buildAIDMTools(); }
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

    switch (action.type) {
      case 'move':         exDoMove(this.ctx, action.dx, action.dy, events); break;
      case 'moveTo':       exDoMoveTo(this.ctx, action.tileX, action.tileY, events); break;
      case 'attack':       caDoAttack(this.ctx, action.targetId, events); break;
      case 'throw':
        if (s.phase === 'exploring' || s.phase === 'player_turn')
          events.push(...caThrowItem(this.ctx, action.itemId, action.targetId));
        break;
      case 'castSpell':
        spDoCastSpell(this.ctx, action.spellId, action.slotLevel, action.targetIds, action.tile, !!action.asRitual, events);
        break;
      case 'hide':         caDoHide(this.ctx); break;
      case 'useFeature':   doUseFeature(this.ctx, action.featureId, { targetId: action.targetId, tile: action.tile }, events); break;
      case 'resolveReaction': cfDoResolveReaction(this.ctx, action.accept, events); break;
      case 'dash':         caDoDash(this.ctx); break;
      case 'dodge':        caDoDodge(this.ctx); break;
      case 'disengage':    caDoDisengage(this.ctx); break;
      case 'endTurn':
        if (s.phase === 'player_turn') cfEnterEnemyPhase(this.ctx, events);
        break;
      case 'rollDeathSave': cfDoRollDeathSave(this.ctx, events); break;
      case 'shortRest':    exDoShortRest(this.ctx); break;
      case 'search':       exDoSearch(this.ctx); break;
      case 'usePotion':    exDoUsePotion(this.ctx); break;
      case 'equip':        ivDoEquip(this.ctx, action.slot, action.itemId); break;
      case 'unequip':      ivDoUnequip(this.ctx, action.slot); break;
      case 'selectTarget': s.selectedTargetId = action.entityId; break;
      case 'scrollLog': {
        const maxOffset = Math.max(0, s.combatLog.length - 6);
        s.logScrollOffset = Math.max(0, Math.min(maxOffset, s.logScrollOffset + (action.delta > 0 ? -1 : 1)));
        break;
      }
    }

    this.computeAvailableActions();
    return { events, state: this.state };
  }

  // ── AIDM tool handlers ──────────────────────────────────────────────────────

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
    this.state.combatLog.push(typeof entry === 'string' ? { left: entry } : entry);
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
    const def = this.defs.monsters.find((m) => m.id === monsterId);
    if (!def) return [];
    const s = this.state;
    const [tx, ty] = this.findFreeTileNear(s.player.tileX, s.player.tileY, 3, 8);
    if (tx === -1) return [];
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
      reactionUsed: false, conditions: [], inventoryIds: [],
    };
    s.npcs.push(npc);
    if (s.phase !== 'exploring') s.turnOrderIds.push(npc.id);
    return [];
  }

  endCombat(): GameEvent[] { return cfEndCombat(this.ctx); }
  triggerCombat(): GameEvent[] { return cfTriggerCombat(this.ctx); }

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
    // NOTE: do NOT remove from turnOrderIds. The advance loop in CombatFlow
    // skips any combatant whose hp <= 0; mutating the array mid-iteration
    // would shift indices and could cause a still-alive combatant to skip
    // their turn.
    this.advanceQuest('kill');
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
    };
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
    const state = buildSessionState(sessionId, req, defs, savedMap);
    // The constructor clones playerDef internally to avoid mutating shared defs.
    return new GameEngine(state, defs);
  }
}
