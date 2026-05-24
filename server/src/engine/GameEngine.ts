import {
  GameState, GameEvent, PlayerAction, CombatMode,
  PlayerDef, MonsterDef, ItemDef, ConsumableDef, WeaponDef,
  EquipmentSlots, NpcState, Disposition, MapItemState, SecretState, QuestState,
  QuestGoalType, NpcPersona, GameMap, LogEntry, GameDefs,
  CreateSessionRequest,
} from './types.js';
import { advanceQuest as questAdvance, completeQuest as questComplete } from './QuestSystem.js';
import type { EncounterContext } from '../encounterService.js';
import { generateMap } from './MapGenerator.js';
import { generateRoomsMap } from './RoomsMapGenerator.js';
import { d, d20, mod } from './Dice.js';
import {
  drinkPotion, rollSkillCheck, rollSavingThrow,
  rollPlayerAttackVsAc, rollNpcAttackVsAc,
} from './CombatSystem.js';
import { applyEquipment, computeEquippedSlotLabels } from './EquipmentSystem.js';
import { chebyshev } from './EnemyAI.js';
import { isIncapacitated } from './ConditionSystem.js';
import {
  ZoneMap, parseStartingZones, findPlayerSpawn,
  spawnEnemies, spawnItems, spawnNpc, spawnSecrets,
} from './SpawnHelpers.js';
import { buildAIDMTools } from './AIDMTools.js';
import type { GameContext } from './GameContext.js';
import {
  endCombat as cfEndCombat, autoEndCombatIfNoEnemies as cfAutoEndCombat,
  triggerCombat as cfTriggerCombat, doStartCombat as cfDoStartCombat,
  enterEnemyPhase as cfEnterEnemyPhase, doRollDeathSave as cfDoRollDeathSave,
} from './CombatFlow.js';
import {
  doAttack as caDoAttack, throwItem as caThrowItem,
  doHide as caDoHide, doDash as caDoDash, doDodge as caDoDodge,
  doDisengage as caDoDisengage, doSecondWind as caDoSecondWind,
  doEnemyOpportunityAttack as caDoEnemyOA,
  doPlayerOpportunityAttack as caDoPlayerOA,
} from './CombatActions.js';

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
    this.defs = defs;
    this.playerDef = defs.playerDefs.find((p) => p.id === state.player.defId)!;
    applyEquipment(this.playerDef, state.player.equippedSlots, defs.equipment);
    state.player.equippedSlotLabels = computeEquippedSlotLabels(this.playerDef, state.player.equippedSlots, defs.equipment);

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
      doPlayerOpportunityAttack: (npc, ev) => caDoPlayerOA(this.ctx, npc),
    };
  }

  getState(): GameState { this.computeAvailableActions(); return this.state; }
  getMonsterDef(defId: string): MonsterDef | undefined { return this.resolveMonsterDef(defId); }
  getAIDMTools() { return buildAIDMTools(this.defs); }

  private resolveMonsterDef(defId: string): MonsterDef | undefined {
    const direct = this.defs.monsters.find((m) => m.id === defId);
    if (direct) return direct;
    const npcDef = this.defs.npcs.find((n) => n.id === defId);
    return npcDef ? this.defs.monsters.find((m) => m.id === npcDef.monsterClass) : undefined;
  }

  processAction(action: PlayerAction): ActionResult {
    const events: GameEvent[] = [];
    const s = this.state;

    switch (action.type) {
      case 'move':         this.doMove(action.dx, action.dy, events); break;
      case 'moveTo':       this.doMoveTo(action.tileX, action.tileY, events); break;
      case 'attack':       caDoAttack(this.ctx, action.targetId, events); break;
      case 'throw':
        if (s.phase === 'exploring' || s.phase === 'player_turn')
          events.push(...caThrowItem(this.ctx, action.itemId, action.targetId));
        break;
      case 'hide':         caDoHide(this.ctx); break;
      case 'secondWind':   caDoSecondWind(this.ctx); break;
      case 'dash':         caDoDash(this.ctx); break;
      case 'dodge':        caDoDodge(this.ctx); break;
      case 'disengage':    caDoDisengage(this.ctx); break;
      case 'endTurn':
        if (s.phase === 'player_turn') cfEnterEnemyPhase(this.ctx, events);
        break;
      case 'rollDeathSave': cfDoRollDeathSave(this.ctx, events); break;
      case 'shortRest':    this.doShortRest(); break;
      case 'search':       this.doSearch(); break;
      case 'usePotion':    this.doUsePotion(); break;
      case 'equip':        this.doEquip(action.slot, action.itemId); break;
      case 'unequip':      this.doUnequip(action.slot); break;
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

  // ── Private helpers ─────────────────────────────────────────────────────────

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
    s.turnOrderIds = s.turnOrderIds.filter((tid) => tid !== id);
    this.advanceQuest('kill');
    this.autoEndCombatIfNoEnemies();
  }

  private killWithReward(npc: NpcState, def: MonsterDef, killMessage: string, includeTotal = true): void {
    const s = this.state;
    s.player.xp += def.xp;
    const logs: LogEntry[] = [{ left: `${killMessage} +${def.xp} XP`, style: 'kill' }];
    if (includeTotal) logs.push({ left: `Total XP: ${s.player.xp}`, style: 'status' });
    this.addLogs(logs);
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

  // ── Exploration actions ─────────────────────────────────────────────────────

  private doMove(dx: number, dy: number, events: GameEvent[]): void {
    const s = this.state;
    if (s.phase !== 'exploring' && s.phase !== 'player_turn') return;
    if (isIncapacitated(s.player.conditions)) return;

    const nx = s.player.tileX + dx;
    const ny = s.player.tileY + dy;
    if (nx < 0 || ny < 0 || nx >= s.map.cols || ny >= s.map.rows) return;
    if (!s.map.passable[ny][nx]) return;
    if (dx !== 0 && dy !== 0) {
      if (!s.map.passable[s.player.tileY][nx] && !s.map.passable[ny][s.player.tileX]) return;
    }
    if (s.npcs.some((n) => n.hp > 0 && n.tileX === nx && n.tileY === ny)) return;
    if (s.phase === 'player_turn' && s.player.movesLeft <= 0) return;

    const oldX = s.player.tileX;
    const oldY = s.player.tileY;
    s.player.tileX = nx;
    s.player.tileY = ny;
    events.push({ type: 'entity_move', entityId: 'player', toX: nx, toY: ny });

    if (s.phase === 'player_turn') {
      s.player.movesLeft--;
      if (!s.player.conditions.includes('disengaged')) {
        for (const npc of s.npcs.filter((n) => n.disposition === 'enemy' && n.hp > 0 && !n.reactionUsed)) {
          if (chebyshev(oldX, oldY, npc.tileX, npc.tileY) <= 1 &&
              chebyshev(nx, ny, npc.tileX, npc.tileY) > 1) {
            caDoEnemyOA(this.ctx, npc, events);
            if ((this.state.phase as string) === 'death_saves' || (this.state.phase as string) === 'defeat') return;
          }
        }
      }
    } else {
      this.checkItemPickup();
      this.checkCombatTrigger(events);
    }
  }

  private doMoveTo(targetX: number, targetY: number, events: GameEvent[]): void {
    const s = this.state;
    if (s.phase !== 'exploring' && s.phase !== 'player_turn') return;
    const { cols, rows, passable } = s.map;
    if (targetX < 0 || targetX >= cols || targetY < 0 || targetY >= rows) return;

    const dist: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(-1));
    const prev: Array<Array<[number, number] | null>> = Array.from({ length: rows }, () => new Array(cols).fill(null));
    const px = s.player.tileX, py = s.player.tileY;
    dist[py][px] = 0;
    const queue: [number, number][] = [[py, px]];
    while (queue.length > 0) {
      const [cy, cx] = queue.shift()!;
      for (const [dr, dc] of [[0,1],[0,-1],[1,0],[-1,0],[1,1],[1,-1],[-1,1],[-1,-1]] as [number,number][]) {
        const nr = cy + dr, nc = cx + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        if (!passable[nr][nc]) continue;
        if (dr !== 0 && dc !== 0 && !passable[cy][nc] && !passable[nr][cx]) continue;
        if (s.npcs.some((n) => n.hp > 0 && n.tileX === nc && n.tileY === nr)) continue;
        if (dist[nr][nc] !== -1) continue;
        dist[nr][nc] = dist[cy][cx] + 1;
        prev[nr][nc] = [cy, cx];
        queue.push([nr, nc]);
      }
    }
    if (dist[targetY][targetX] === -1) return;

    const path: [number, number][] = [];
    let cur: [number, number] = [targetY, targetX];
    while (cur[0] !== py || cur[1] !== px) {
      path.unshift(cur);
      cur = prev[cur[0]][cur[1]]!;
    }
    for (const [ny, nx] of path) {
      const phase = this.state.phase as string;
      if (phase === 'death_saves' || phase === 'defeat') break;
      this.doMove(nx - this.state.player.tileX, ny - this.state.player.tileY, events);
    }
  }

  private checkItemPickup(): void {
    const s = this.state;
    const idx = s.mapItems.findIndex((i) => i.tileX === s.player.tileX && i.tileY === s.player.tileY);
    if (idx === -1) return;
    const item = s.mapItems[idx];
    const def = this.defs.equipment.find((i) => i.id === item.defId);
    if (def) {
      s.player.inventoryIds.push(item.defId);
      this.addLog(`Picked up ${def.name}!`);
    }
    s.mapItems.splice(idx, 1);
    this.advanceQuest('collect');
  }

  private checkCombatTrigger(events: GameEvent[]): void {
    const s = this.state;
    const enemies = s.npcs.filter((n) => n.disposition === 'enemy' && n.hp > 0);
    for (const enemy of enemies) {
      if (chebyshev(s.player.tileX, s.player.tileY, enemy.tileX, enemy.tileY) <= 2) {
        cfDoStartCombat(this.ctx, events);
        s.selectedTargetId = enemy.id;
        return;
      }
    }
  }

  private doSearch(): void {
    const s = this.state;
    if (s.phase !== 'exploring') return;

    const roll = d20() + (this.playerDef.skills['perception'] ?? 0);
    const adj = s.secrets.filter(
      (sec) => chebyshev(s.player.tileX, s.player.tileY, sec.tileX, sec.tileY) <= 1,
    );

    if (adj.length === 0) {
      this.addLog({ left: `Search (${roll}) — nothing found`, style: 'miss' });
      return;
    }

    const secret = adj[0];
    const success = roll >= secret.def.dc;
    s.secrets = s.secrets.filter((sec) => sec !== secret);

    const logs: LogEntry[] = [];
    if (success) {
      this.advanceQuest('explore');
      logs.push({ left: `Search (${roll} vs DC ${secret.def.dc}) — ${secret.def.successText}`, style: 'hit' });
      const r = secret.def.reward;
      if (r.type === 'gold') {
        s.player.gold += r.amount;
        logs.push({ left: `+${r.amount} GP`, style: 'status' });
      } else if (r.type === 'item') {
        const item = this.defs.equipment.find((i) => i.id === r.itemId);
        if (item) { s.player.inventoryIds.push(r.itemId); logs.push({ left: `Found: ${item.name}`, style: 'status' }); }
      } else {
        logs.push({ left: `Lore: "${r.text}"`, style: 'normal' });
      }
    } else {
      logs.push({ left: `Search (${roll} vs DC ${secret.def.dc}) — ${secret.def.failureText}`, style: 'miss' });
    }
    this.addLogs(logs);
  }

  private doShortRest(): void {
    const s = this.state;
    if (s.phase !== 'exploring' || s.player.hp <= 0 || s.player.hp >= this.playerDef.maxHp) return;
    const hitDiceRemaining = this.playerDef.level - s.player.hitDiceUsed;
    if (hitDiceRemaining <= 0) return;
    const conMod = mod(this.playerDef.con);
    const roll = d(this.playerDef.hitDieType);
    const healed = Math.max(1, roll + conMod);
    const before = s.player.hp;
    s.player.hp = Math.min(this.playerDef.maxHp, s.player.hp + healed);
    s.player.hitDiceUsed++;
    const remaining = this.playerDef.level - s.player.hitDiceUsed;
    this.addLogs([
      { left: `Short Rest — +${healed} HP restored`, right: `1d${this.playerDef.hitDieType}+CON(${conMod >= 0 ? '+' : ''}${conMod})=[${roll}]+${conMod}=${healed}`, style: 'heal' },
      { left: `HP: ${before} → ${s.player.hp}/${this.playerDef.maxHp}  (${remaining} Hit ${remaining === 1 ? 'Die' : 'Dice'} left)`, style: 'status' },
    ]);
  }

  private doUsePotion(): void {
    const s = this.state;
    if (s.phase === 'player_turn' && s.player.bonusActionUsed) return;
    if (s.phase !== 'player_turn' && s.phase !== 'exploring') return;

    const idx = s.player.inventoryIds.findIndex((id) => {
      const item = this.defs.equipment.find((i) => i.id === id);
      return item?.type === 'consumable';
    });
    if (idx === -1) return;

    const itemId = s.player.inventoryIds.splice(idx, 1)[0];
    const item = this.defs.equipment.find((i) => i.id === itemId) as ConsumableDef;
    const { healed, logs } = drinkPotion(item);
    const before = s.player.hp;
    s.player.hp = Math.min(this.playerDef.maxHp, s.player.hp + healed);
    this.addLogs([...logs, { left: `HP: ${before} → ${s.player.hp}/${this.playerDef.maxHp}`, style: 'status' }]);
    if (s.phase === 'player_turn') s.player.bonusActionUsed = true;
  }

  private doEquip(slot: 'armor' | 'weapon' | 'shield', itemId: string): void {
    const s = this.state;
    const slotKey = `${slot}Id` as keyof EquipmentSlots;
    if (!s.player.inventoryIds.includes(itemId)) return;

    if (slot === 'shield') {
      const weapon = this.defs.equipment.find((i) => i.id === s.player.equippedSlots.weaponId) as WeaponDef | undefined;
      if (weapon?.twoHanded) return;
    }
    if (slot === 'weapon') {
      const incoming = this.defs.equipment.find((i) => i.id === itemId) as WeaponDef | undefined;
      if (incoming?.twoHanded && s.player.equippedSlots.shieldId) {
        s.player.inventoryIds.push(s.player.equippedSlots.shieldId);
        s.player.equippedSlots.shieldId = null;
      }
    }

    const currentId = s.player.equippedSlots[slotKey];
    if (currentId) s.player.inventoryIds.push(currentId);

    const removeIdx = s.player.inventoryIds.indexOf(itemId);
    if (removeIdx !== -1) s.player.inventoryIds.splice(removeIdx, 1);
    s.player.equippedSlots[slotKey] = itemId;
    applyEquipment(this.playerDef, s.player.equippedSlots, this.defs.equipment);
    s.player.equippedSlots = { ...s.player.equippedSlots };
    s.player.equippedSlotLabels = computeEquippedSlotLabels(this.playerDef, s.player.equippedSlots, this.defs.equipment);
  }

  private doUnequip(slot: 'armor' | 'weapon' | 'shield'): void {
    const s = this.state;
    const slotKey = `${slot}Id` as keyof EquipmentSlots;
    const currentId = s.player.equippedSlots[slotKey];
    if (!currentId) return;
    s.player.inventoryIds.push(currentId);
    s.player.equippedSlots[slotKey] = null;
    applyEquipment(this.playerDef, s.player.equippedSlots, this.defs.equipment);
    s.player.equippedSlots = { ...s.player.equippedSlots };
    s.player.equippedSlotLabels = computeEquippedSlotLabels(this.playerDef, s.player.equippedSlots, this.defs.equipment);
  }

  private computeAvailableActions(): void {
    const s = this.state;
    const p = s.player;
    const phase = s.phase;
    const playerHidden = p.conditions.includes('hidden');
    const livingEnemies = s.npcs.filter((n) => n.disposition === 'enemy' && n.hp > 0);
    const selectedTarget = s.selectedTargetId
      ? s.npcs.find((n) => n.id === s.selectedTargetId && n.hp > 0 && n.disposition !== 'ally')
      : null;
    const targetAdjacent = selectedTarget
      ? chebyshev(p.tileX, p.tileY, selectedTarget.tileX, selectedTarget.tileY) <= 1
      : false;
    const actionFree = !p.actionUsed;
    const bonusFree = !p.bonusActionUsed;
    const notIncapacitated = !isIncapacitated(p.conditions);
    const hitDiceRemaining = this.playerDef.level - p.hitDiceUsed;

    let throwableItemIds: string[] = [];
    if (selectedTarget && (phase === 'exploring' || (phase === 'player_turn' && actionFree))) {
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
      canAttack: (phase === 'exploring' || (phase === 'player_turn' && actionFree && notIncapacitated)) && targetAdjacent,
      throwableItemIds,
      canHide: phase === 'player_turn' && bonusFree && notIncapacitated && this.playerDef.sneakAttackDice > 0 && !playerHidden && livingEnemies.length > 0,
      canSecondWind: phase === 'player_turn' && bonusFree && notIncapacitated && this.playerDef.secondWindMaxUses > 0 && p.secondWindUses > 0 && p.hp < this.playerDef.maxHp,
      canDash: phase === 'player_turn' && actionFree && notIncapacitated,
      canDodge: phase === 'player_turn' && actionFree && notIncapacitated,
      canDisengage: phase === 'player_turn' && actionFree && notIncapacitated && livingEnemies.length > 0,
      canShortRest: phase === 'exploring' && p.hp > 0 && p.hp < this.playerDef.maxHp && hitDiceRemaining > 0,
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
    savedMap?: GameMap,
  ): GameEngine {
    const playerDef = defs.playerDefs.find((p) => p.id === req.playerDefId);
    if (!playerDef) throw new Error(`Unknown playerDefId: ${req.playerDefId}`);

    const map: GameMap = savedMap ?? (req.mapType === 'rooms' ? generateRoomsMap() : generateMap());

    const equippedSlots: EquipmentSlots = req.resumeEquippedSlots ?? { ...playerDef.defaultEquipment };
    const ownedDef: PlayerDef = JSON.parse(JSON.stringify(playerDef));
    applyEquipment(ownedDef, equippedSlots, defs.equipment);

    const inventoryIds: string[] = req.resumeInventoryIds ?? [...(playerDef.defaultInventoryIds ?? [])];

    const rawZones = req.startingZones ?? req.encounterContext.startingZones;
    const zoneMap: ZoneMap = rawZones ? parseStartingZones(rawZones, map) : new Map();
    const playerZone = zoneMap.get('P');
    const allyZone   = zoneMap.get('A') ?? playerZone;
    const npcZone    = zoneMap.get('N');
    const enemyZone  = zoneMap.get('E');

    const [pX, pY] = findPlayerSpawn(map, playerZone);

    const player = {
      defId: playerDef.id,
      tileX: pX, tileY: pY,
      hp: req.resumeHp ?? playerDef.maxHp,
      xp: req.resumeXp ?? playerDef.xp,
      gold: req.resumeGold ?? 0,
      inventoryIds,
      equippedSlots,
      secondWindUses: req.resumeSecondWindUses ?? playerDef.secondWindMaxUses,
      actionUsed: false,
      bonusActionUsed: false,
      reactionUsed: false,
      movesLeft: 0,
      deathSaveSuccesses: 0,
      deathSaveFailures: 0,
      hitDiceUsed: 0,
      tempHp: 0,
      heroicInspiration: false,
      exhaustionLevel: 0,
      conditions: [] as string[],
      equippedSlotLabels: { armor: null, weapon: null, shield: null },
    };

    const isCombat = req.encounterTypes.includes('simple_combat');

    const npcs: NpcState[] = [];
    const mapItems: MapItemState[] = [];
    const secrets: SecretState[] = [];

    for (const defId of (req.allyIds ?? req.encounterContext.allyIds ?? [])) {
      spawnNpc(npcs, map, defs.npcs, defs.monsters, defId, player.tileX, player.tileY, 'ally', allyZone);
    }
    if (isCombat) {
      spawnEnemies(npcs, map, defs.monsters, player.tileX, player.tileY, req.encounterContext.enemyCount ?? 2, enemyZone);
      spawnItems(mapItems, map, defs.equipment, player.tileX, player.tileY, npcs);
    }
    if (req.encounterTypes.includes('social_interaction')) {
      for (const defId of (req.npcIds ?? req.encounterContext.npcIds ?? [])) {
        spawnNpc(npcs, map, defs.npcs, defs.monsters, defId, player.tileX, player.tileY, 'neutral', npcZone);
      }
    }
    if (req.encounterTypes.includes('exploration')) {
      spawnSecrets(secrets, map, req.encounterContext.secrets ?? [], player.tileX, player.tileY, npcs);
    }

    const npcPersonas: NpcPersona[] = npcs
      .filter((n) => n.disposition === 'neutral')
      .flatMap((ns) => {
        const def = defs.npcs.find((n) => n.id === ns.defId);
        return def?.persona ? [{ id: ns.id, name: def.name, persona: def.persona }] : [];
      });

    const quests: QuestState[] = (req.encounterContext.quests ?? []).map((q) => ({
      id: q.id,
      title: q.title,
      goalType: q.goal.type,
      goalTarget: q.goal.target,
      rewardXp: q.rewardXp,
      rewardGp: q.rewardGp,
      progress: 0,
      completed: false,
    }));

    const state: GameState = {
      sessionId,
      phase: 'exploring',
      map,
      player,
      npcs,
      mapItems,
      secrets,
      combatLog: [],
      logScrollOffset: 0,
      encounterTypes: req.encounterTypes,
      mapName: req.encounterContext.mapName ?? 'Unknown',
      encounterTitle: req.encounterTitle ?? '',
      quests,
      selectedTargetId: null,
      activeNpcIndex: 0,
      turnOrderIds: [],
      introduction: req.encounterContext.introduction,
      encounterContext: req.encounterContext.context,
      npcPersonas,
      availableActions: {
        canAttack: false, throwableItemIds: [],
        canHide: false, canSecondWind: false, canDash: false,
        canDodge: false, canDisengage: false, canShortRest: false,
      },
    };

    const sessionDefs: GameDefs = {
      ...defs,
      playerDefs: defs.playerDefs.map((p) => p.id === ownedDef.id ? ownedDef : p),
    };

    return new GameEngine(state, sessionDefs);
  }
}
