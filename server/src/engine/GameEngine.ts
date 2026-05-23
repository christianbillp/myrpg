import {
  GameState, GameEvent, PlayerAction, CombatMode,
  PlayerDef, MonsterDef, NPCDef, ItemDef, ConsumableDef, WeaponDef,
  EquipmentSlots, NpcState, Disposition, MapItemState, SecretState, QuestState,
  QuestGoalType, SecretDef, NpcPersona, GameMap, LogEntry,
  CreateSessionRequest,
} from './types.js';
import type { EncounterContext } from '../encounterService.js';
import { generateMap } from './MapGenerator.js';
import { generateRoomsMap } from './RoomsMapGenerator.js';
import { shuffle } from './MapUtils.js';
import { d, d20, mod } from './Dice.js';
import {
  rollInitiative, playerMeleeAttack, enemyAttack, playerHide, playerSecondWind,
  drinkPotion, rollDeathSave, rollSkillCheck,
} from './CombatSystem.js';
import { applyEquipment } from './EquipmentSystem.js';
import { runEnemyTurn, runAllyTurn, chebyshev } from './EnemyAI.js';

const TURN_CONDITIONS = ['dodging', 'disengaged', 'dashing'];

export interface GameDefs {
  playerDefs: PlayerDef[];
  monsters: MonsterDef[];
  npcs: NPCDef[];
  items: ItemDef[];
  maps: { id: string; passable: boolean[][]; cols: number; rows: number; name: string; mapdescription: string }[];
}

export interface ActionResult {
  events: GameEvent[];
  state: GameState;
}

function crGoldReward(cr: string): number {
  if (cr.includes('/')) {
    const [num, den] = cr.split('/').map(Number);
    return Math.floor(10 * num / den);
  }
  return 10 * Number(cr);
}

let uidCounter = 0;
function uid(): string { return `e${++uidCounter}`; }

export class GameEngine {
  private state: GameState;
  private defs: GameDefs;
  private playerDef: PlayerDef;

  constructor(state: GameState, defs: GameDefs) {
    this.state = state;
    this.defs = defs;
    this.playerDef = defs.playerDefs.find((p) => p.id === state.player.defId)!;
    applyEquipment(this.playerDef, state.player.equippedSlots, defs.items);

    for (const id of [
      ...state.npcs.map((n) => n.id),
      ...state.mapItems.map((i) => i.id),
    ]) {
      const n = parseInt(id.replace(/\D/g, ''), 10);
      if (!isNaN(n) && n >= uidCounter) uidCounter = n + 1;
    }
  }

  getState(): GameState { return this.state; }

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
      case 'attack':       this.doAttack(action.targetId, events); break;
      case 'hide':         this.doHide(events); break;
      case 'secondWind':   this.doSecondWind(events); break;
      case 'dash':         this.doDash(events); break;
      case 'dodge':        this.doDodge(events); break;
      case 'disengage':    this.doDisengage(events); break;
      case 'endTurn':      this.doEndTurn(events); break;
      case 'rollDeathSave':this.doRollDeathSave(events); break;
      case 'shortRest':    this.doShortRest(events); break;
      case 'search':       this.doSearch(events); break;
      case 'usePotion':    this.doUsePotion(events); break;
      case 'equip':        this.doEquip(action.slot, action.itemId); break;
      case 'unequip':      this.doUnequip(action.slot); break;
      case 'selectTarget': s.selectedTargetId = action.entityId; break;
      case 'scrollLog': {
        const maxOffset = Math.max(0, s.combatLog.length - 6);
        s.logScrollOffset = Math.max(0, Math.min(maxOffset, s.logScrollOffset + (action.delta > 0 ? -1 : 1)));
        break;
      }
    }

    return { events, state: this.state };
  }

  // ── AIDM tool handlers ──────────────────────────────────────────────────────

  adjustPlayerHp(delta: number): GameEvent[] {
    const s = this.state;
    const before = s.player.hp;
    s.player.hp = Math.max(0, Math.min(this.playerDef.maxHp, s.player.hp + delta));
    this.addLog(`HP: ${before} → ${s.player.hp}/${this.playerDef.maxHp}`);
    if (s.player.hp <= 0 && s.phase === 'exploring') s.phase = 'defeat';
    return [];
  }

  awardXp(amount: number): GameEvent[] {
    this.state.player.xp += amount;
    return [];
  }

  awardGold(amount: number): GameEvent[] {
    this.state.player.gold += amount;
    return [];
  }

  setEnemyHp(label: string, hp: number): GameEvent[] {
    const s = this.state;
    const npc = s.npcs.find((n) => n.label === label && n.disposition === 'enemy');
    if (!npc) return [];
    npc.hp = Math.max(0, hp);
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
    } else if (entity.startsWith('enemy_')) {
      const label = entity.replace('enemy_', '');
      const npc = s.npcs.find((n) => n.label === label && n.disposition === 'enemy');
      if (npc) {
        npc.tileX = tileX;
        npc.tileY = tileY;
        events.push({ type: 'entity_move', entityId: npc.id, toX: tileX, toY: tileY });
      }
    } else if (entity.startsWith('npc_')) {
      const npcId = entity.replace('npc_', '');
      const npc = s.npcs.find((n) => n.id === npcId);
      if (npc) {
        npc.tileX = tileX;
        npc.tileY = tileY;
        events.push({ type: 'entity_move', entityId: npc.id, toX: tileX, toY: tileY });
      }
    }
    return events;
  }

  addItem(itemId: string): GameEvent[] {
    const item = this.defs.items.find((i) => i.id === itemId);
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
    const s = this.state;
    const npcId = entity.replace('npc_', '');
    s.npcs = s.npcs.filter((n) => n.id !== npcId);
    return [];
  }

  spawnEnemy(monsterId: string): GameEvent[] {
    const def = this.defs.monsters.find((m) => m.id === monsterId);
    if (!def) return [];
    const s = this.state;
    const [tx, ty] = this.findFreeTileNear(s.player.tileX, s.player.tileY, 3, 8);
    if (tx === -1) return [];
    const livingEnemies = s.npcs.filter((n) => n.disposition === 'enemy' && n.hp > 0);
    const label = String.fromCharCode(65 + livingEnemies.length);
    const npc: NpcState = {
      id: uid(), defId: def.id, label,
      tileX: tx, tileY: ty,
      disposition: 'enemy',
      hp: def.maxHp, maxHp: def.maxHp,
      isActive: false, vexed: false, hidden: false,
      reactionUsed: false, conditions: [],
    };
    s.npcs.push(npc);
    if (s.phase !== 'exploring') {
      s.turnOrderIds.push(npc.id);
    }
    return [];
  }

  endCombat(): GameEvent[] {
    const s = this.state;
    s.phase = 'exploring';
    s.npcs = s.npcs.filter((n) => n.disposition !== 'enemy');
    s.npcs.forEach((n) => { if (n.disposition === 'ally') n.disposition = 'neutral'; });
    s.activeNpcIndex = 0;
    s.turnOrderIds = [];
    s.player.hidden = false;
    return [];
  }

  triggerCombat(): GameEvent[] {
    const s = this.state;
    if (s.phase !== 'exploring' || !s.npcs.some((n) => n.disposition === 'enemy')) return [];
    const events: GameEvent[] = [];
    this.doStartCombat(events);
    return events;
  }

  completeQuest(questId: string): GameEvent[] {
    const q = this.state.quests.find((qs) => qs.id === questId && !qs.completed);
    if (!q) return [];
    q.progress = q.goalTarget;
    q.completed = true;
    this.state.player.xp += q.rewardXp;
    this.state.player.gold += q.rewardGp;
    this.addLog(`Quest complete: ${q.title}! +${q.rewardXp} XP  +${q.rewardGp} GP`);
    return [];
  }

  setPlayerHidden(hidden: boolean): GameEvent[] {
    this.state.player.hidden = hidden;
    return [];
  }

  setDisposition(entity: string, disposition: string): GameEvent[] {
    if (!['ally', 'neutral', 'enemy'].includes(disposition)) return [];
    const s = this.state;
    let npc: NpcState | undefined;
    if (entity.startsWith('enemy_')) {
      const label = entity.replace('enemy_', '');
      npc = s.npcs.find((n) => n.label === label);
    } else if (entity.startsWith('npc_')) {
      const npcId = entity.replace('npc_', '');
      npc = s.npcs.find((n) => n.id === npcId);
    }
    if (npc) npc.disposition = disposition as Disposition;
    return [];
  }

  applyCondition(entity: string, condition: string): GameEvent[] {
    const s = this.state;
    if (entity === 'player') {
      if (!s.player.conditions.includes(condition)) s.player.conditions.push(condition);
    } else if (entity.startsWith('enemy_')) {
      const label = entity.replace('enemy_', '');
      const npc = s.npcs.find((n) => n.label === label && n.disposition === 'enemy');
      if (npc && !npc.conditions.includes(condition)) npc.conditions.push(condition);
    } else if (entity.startsWith('npc_')) {
      const npcId = entity.replace('npc_', '');
      const npc = s.npcs.find((n) => n.id === npcId);
      if (npc && !npc.conditions.includes(condition)) npc.conditions.push(condition);
    }
    return [];
  }

  removeCondition(entity: string, condition: string): GameEvent[] {
    const s = this.state;
    if (entity === 'player') {
      s.player.conditions = s.player.conditions.filter((c) => c !== condition);
    } else if (entity.startsWith('enemy_')) {
      const label = entity.replace('enemy_', '');
      const npc = s.npcs.find((n) => n.label === label && n.disposition === 'enemy');
      if (npc) npc.conditions = npc.conditions.filter((c) => c !== condition);
    } else if (entity.startsWith('npc_')) {
      const npcId = entity.replace('npc_', '');
      const npc = s.npcs.find((n) => n.id === npcId);
      if (npc) npc.conditions = npc.conditions.filter((c) => c !== condition);
    }
    return [];
  }

  rollAbilityCheck(skill: string, dc: number): { roll: number; total: number; success: boolean } {
    const skillMod = this.playerDef.skills[skill] ?? 0;
    return rollSkillCheck(skillMod, dc);
  }

  // ── Private action implementations ─────────────────────────────────────────

  private doMove(dx: number, dy: number, events: GameEvent[]): void {
    const s = this.state;
    if (s.phase !== 'exploring' && s.phase !== 'player_turn') return;

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
            this.doEnemyOpportunityAttack(npc, events);
            if ((this.state.phase as string) === 'death_saves' || (this.state.phase as string) === 'defeat') return;
          }
        }
      }
    } else {
      this.checkItemPickup();
      this.checkCombatTrigger(events);
    }
  }

  private checkItemPickup(): void {
    const s = this.state;
    const idx = s.mapItems.findIndex(
      (i) => i.tileX === s.player.tileX && i.tileY === s.player.tileY,
    );
    if (idx === -1) return;
    const item = s.mapItems[idx];
    const def = this.defs.items.find((i) => i.id === item.defId);
    if (def) {
      s.player.inventoryIds.push(item.defId);
      this.addLog(`Picked up ${def.name}!`);
    }
    s.mapItems.splice(idx, 1);
    this.advanceQuest('collect');
  }

  private checkCombatTrigger(events: GameEvent[]): void {
    const s = this.state;
    const enemies = s.npcs.filter((n) => n.disposition === 'enemy');
    for (const enemy of enemies) {
      if (chebyshev(s.player.tileX, s.player.tileY, enemy.tileX, enemy.tileY) <= 2) {
        if (enemies.length > 1) enemies.forEach((e, i) => { e.label = String.fromCharCode(65 + i); });
        this.doStartCombat(events);
        s.selectedTargetId = enemy.id;
        return;
      }
    }
  }

  private doStartCombat(events: GameEvent[]): void {
    const s = this.state;
    const enemies = s.npcs.filter((n) => n.disposition === 'enemy');
    const firstEnemyDef = enemies[0] ? this.resolveMonsterDef(enemies[0].defId) : undefined;
    if (!firstEnemyDef) return;

    s.player.hidden = false;
    s.player.deathSaveSuccesses = 0;
    s.player.deathSaveFailures = 0;
    s.activeNpcIndex = 0;
    const combatNpcs = s.npcs.filter((n) => n.disposition !== 'neutral');
    s.turnOrderIds = ['player', ...combatNpcs.map((n) => n.id)];

    const { playerFirst, logs } = rollInitiative(this.playerDef, firstEnemyDef);
    this.addLogs(logs);

    if (playerFirst) {
      this.enterPlayerTurn();
    } else {
      this.enterEnemyPhase(events);
    }
  }

  private enterPlayerTurn(): void {
    const s = this.state;
    s.phase = 'player_turn';
    s.activeNpcIndex = 0;
    s.npcs.filter((n) => n.disposition !== 'neutral').forEach((n) => {
      n.isActive = false;
      n.reactionUsed = false;
      n.conditions = n.conditions.filter((c) => !TURN_CONDITIONS.includes(c));
    });
    s.player.movesLeft = this.playerDef.speed;
    s.player.actionUsed = false;
    s.player.bonusActionUsed = false;
    s.player.reactionUsed = false;
    s.player.conditions = s.player.conditions.filter((c) => !TURN_CONDITIONS.includes(c));
  }

  private doAttack(targetId: string | undefined, _events: GameEvent[]): void {
    const s = this.state;
    if (s.phase !== 'player_turn' || s.player.actionUsed) return;

    const isAdjacent = (n: NpcState) =>
      n.disposition === 'enemy' && n.hp > 0 && chebyshev(s.player.tileX, s.player.tileY, n.tileX, n.tileY) <= 1;

    let target = targetId
      ? (s.npcs.find((n) => n.id === targetId && isAdjacent(n)) ?? null)
      : null;
    if (!target) target = s.npcs.find(isAdjacent) ?? null;
    if (!target) return;

    const targetDef = this.resolveMonsterDef(target!.defId);
    if (!targetDef) return;

    const withAdvantage = s.player.hidden;
    const { damage, logs, vexApplied } = playerMeleeAttack(this.playerDef, targetDef, withAdvantage);
    s.player.hidden = false;
    this.addLogs(logs);

    const { finalDamage, log: resistLog } = this.resistMod(damage, this.playerDef.mainAttack.damageType, targetDef);
    if (resistLog) this.addLog(resistLog);
    target.hp = Math.max(0, target.hp - finalDamage);
    this.addLog({ left: `${targetDef.name} HP: ${target.hp}/${target.maxHp}`, style: 'status' });

    if (vexApplied) {
      target.vexed = true;
      this.addLog({ left: `Vex — ${targetDef.name} attacks with Disadvantage`, style: 'status' });
    }

    if (target.hp <= 0) {
      const gold = crGoldReward(targetDef.cr);
      s.player.xp += targetDef.xp;
      s.player.gold += gold;
      this.addLogs([
        { left: `☠ ${targetDef.name} is slain! +${targetDef.xp} XP  +${gold} GP`, style: 'kill' },
        { left: `Total XP: ${s.player.xp}  |  GP: ${s.player.gold}`, style: 'status' },
      ]);
      this.killNpc(target.id);
    }

    s.player.actionUsed = true;
    if (s.npcs.filter((n) => n.disposition === 'enemy' && n.hp > 0).length === 0) {
      s.phase = 'exploring';
    }
  }

  private resistMod(damage: number, damageType: string, def: MonsterDef): { finalDamage: number; log: LogEntry | null } {
    if (def.resistances?.includes(damageType)) {
      const fd = Math.floor(damage / 2);
      return { finalDamage: fd, log: { left: `${def.name} resists ${damageType} — ${damage}→${fd}`, right: '×½', style: 'status' } };
    }
    if (def.vulnerabilities?.includes(damageType)) {
      const fd = damage * 2;
      return { finalDamage: fd, log: { left: `${def.name} is vulnerable to ${damageType}! ${damage}→${fd}`, right: '×2', style: 'crit' } };
    }
    return { finalDamage: damage, log: null };
  }

  private applyDamageToPlayer(damage: number, _events: GameEvent[]): void {
    const s = this.state;
    const hpBefore = s.player.hp;
    s.player.hp = Math.max(0, hpBefore - damage);
    this.addLog({ left: `${this.playerDef.name} HP: ${s.player.hp}/${this.playerDef.maxHp}`, style: 'status' });
    if (s.player.hp > 0) return;
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
    s.npcs = s.npcs.filter((n) => n.id !== id);
    s.turnOrderIds = s.turnOrderIds.filter((tid) => tid !== id);
    if (s.selectedTargetId === id) s.selectedTargetId = null;
    this.advanceQuest('kill');
  }

  private doHide(_events: GameEvent[]): void {
    const s = this.state;
    if (s.phase !== 'player_turn' || s.player.bonusActionUsed) return;
    const living = s.npcs.filter((n) => n.disposition === 'enemy' && n.hp > 0);
    if (!living.length) return;
    const maxPP = Math.max(...living.map((n) => {
      const def = this.resolveMonsterDef(n.defId);
      return def?.passivePerception ?? 10;
    }));
    const { hidden, logs } = playerHide(this.playerDef, maxPP);
    s.player.hidden = hidden;
    this.addLogs(logs);
    s.player.bonusActionUsed = true;
  }

  private doDash(_events: GameEvent[]): void {
    const s = this.state;
    if (s.phase !== 'player_turn' || s.player.actionUsed) return;
    s.player.movesLeft += this.playerDef.speed;
    s.player.conditions.push('dashing');
    s.player.actionUsed = true;
    this.addLog({ left: `${this.playerDef.name} Dashes — +${this.playerDef.speed} tiles movement`, style: 'status' });
  }

  private doDodge(_events: GameEvent[]): void {
    const s = this.state;
    if (s.phase !== 'player_turn' || s.player.actionUsed) return;
    s.player.conditions.push('dodging');
    s.player.actionUsed = true;
    this.addLog({ left: `${this.playerDef.name} Dodges — enemies attack with Disadvantage`, style: 'status' });
  }

  private doDisengage(_events: GameEvent[]): void {
    const s = this.state;
    if (s.phase !== 'player_turn' || s.player.actionUsed) return;
    s.player.conditions.push('disengaged');
    s.player.actionUsed = true;
    this.addLog({ left: `${this.playerDef.name} Disengages — no Opportunity Attacks this turn`, style: 'status' });
  }

  private doSecondWind(_events: GameEvent[]): void {
    const s = this.state;
    if (s.phase !== 'player_turn' || s.player.bonusActionUsed || s.player.secondWindUses <= 0 || s.player.hp >= this.playerDef.maxHp) return;
    const { healed, logs } = playerSecondWind(this.playerDef.level);
    const before = s.player.hp;
    s.player.hp = Math.min(this.playerDef.maxHp, s.player.hp + healed);
    s.player.secondWindUses--;
    this.addLogs([...logs, { left: `HP: ${before} → ${s.player.hp}/${this.playerDef.maxHp} (${s.player.secondWindUses} uses left)`, style: 'status' }]);
    s.player.bonusActionUsed = true;
  }

  private doEndTurn(events: GameEvent[]): void {
    if (this.state.phase !== 'player_turn') return;
    this.enterEnemyPhase(events);
  }

  private enterEnemyPhase(events: GameEvent[]): void {
    const s = this.state;
    s.phase = 'enemy_turn';
    s.activeNpcIndex = 0;
    this.runAllNpcCombatTurns(events);
  }

  private runAllNpcCombatTurns(events: GameEvent[]): void {
    const s = this.state;

    // Enemy turns — each enemy attacks the player
    const livingEnemies = s.npcs.filter((n) => n.disposition === 'enemy' && n.hp > 0);
    for (const npc of livingEnemies) {
      if (s.phase === 'defeat') break;
      npc.isActive = true;

      const def = this.resolveMonsterDef(npc.defId);
      if (!def) { npc.isActive = false; continue; }

      const occupied: [number, number][] = s.npcs
        .filter((n) => n !== npc && n.hp > 0)
        .map((n): [number, number] => [n.tileX, n.tileY]);

      const startedAdjacentToPlayer = chebyshev(npc.tileX, npc.tileY, s.player.tileX, s.player.tileY) <= 1;

      const result = runEnemyTurn(npc, def, {
        playerTileX: s.player.tileX,
        playerTileY: s.player.tileY,
        playerAc: this.playerDef.ac,
        playerHp: s.player.hp,
        playerHidden: s.player.hidden,
        enemyVexed: npc.vexed,
        enemyCurrentlyHidden: npc.hidden,
        playerDodging: s.player.conditions.includes('dodging'),
        passivePerception: 10 + (this.playerDef.skills['perception'] ?? 0),
        passable: s.map.passable,
        mapCols: s.map.cols,
        mapRows: s.map.rows,
        occupiedTiles: occupied,
      });

      const endedAdjacentToPlayer = chebyshev(result.finalTileX, result.finalTileY, s.player.tileX, s.player.tileY) <= 1;

      npc.tileX = result.finalTileX;
      npc.tileY = result.finalTileY;
      npc.hidden = result.hidden;
      npc.vexed = false;
      events.push(...result.events);

      if (startedAdjacentToPlayer && !endedAdjacentToPlayer && !result.attacked) {
        this.doPlayerOpportunityAttack(npc, events);
      }

      this.addLogs(result.logs);

      if (result.attacked && result.isHit) {
        if (s.player.hp <= 0) {
          const failures = result.isCrit ? 2 : 1;
          s.player.deathSaveFailures = Math.min(3, s.player.deathSaveFailures + failures);
          this.addLogs([
            { left: `Strikes unconscious ${this.playerDef.name}!${result.isCrit ? ' CRITICAL — 2 failures!' : ' 1 failure.'}`, style: 'status' },
            { left: `Death saves: ${s.player.deathSaveSuccesses} ✓  ${s.player.deathSaveFailures} ✗`, style: 'status' },
          ]);
          if (s.player.deathSaveFailures >= 3) {
            this.addLog({ left: `${this.playerDef.name} has died.`, style: 'kill' });
            s.phase = 'defeat';
          } else {
            s.phase = 'death_saves';
          }
        } else {
          this.applyDamageToPlayer(result.damage, events);
        }
      }
      s.player.hidden = false;
      npc.isActive = false;
    }

    // Ally turns — each ally attacks the nearest living enemy
    if (s.phase !== 'defeat' && s.phase !== 'death_saves') {
      const livingAllies = s.npcs.filter((n) => n.disposition === 'ally' && n.hp > 0);
      for (const ally of livingAllies) {
        ally.isActive = true;

        const def = this.resolveMonsterDef(ally.defId);
        if (!def) { ally.isActive = false; continue; }

        const enemyTargets = s.npcs
          .filter((n) => n.disposition === 'enemy' && n.hp > 0)
          .map((n) => {
            const ndef = this.resolveMonsterDef(n.defId);
            return { id: n.id, tileX: n.tileX, tileY: n.tileY, ac: ndef?.ac ?? 10 };
          });

        const occupied: [number, number][] = [
          [s.player.tileX, s.player.tileY],
          ...s.npcs.filter((n) => n !== ally && n.hp > 0).map((n): [number, number] => [n.tileX, n.tileY]),
        ];

        const result = runAllyTurn(ally, def, {
          enemyTargets,
          passable: s.map.passable,
          mapCols: s.map.cols,
          mapRows: s.map.rows,
          occupiedTiles: occupied,
        });

        ally.tileX = result.finalTileX;
        ally.tileY = result.finalTileY;
        events.push(...result.events);
        this.addLogs(result.logs);

        if (result.attacked && result.isHit && result.attackedTargetId) {
          const target = s.npcs.find((n) => n.id === result.attackedTargetId);
          if (target) {
            const targetDef = this.resolveMonsterDef(target.defId);
            if (targetDef) {
              const meleeAttack = def.attacks.find((a) => a.attackType === 'melee' || a.attackType === 'both');
              const { finalDamage, log: resistLog } = this.resistMod(result.damage, meleeAttack?.damageType ?? '', targetDef);
              if (resistLog) this.addLog(resistLog);
              target.hp = Math.max(0, target.hp - finalDamage);
              this.addLog({ left: `${targetDef.name} HP: ${target.hp}/${target.maxHp}`, style: 'status' });
              if (target.hp <= 0) {
                const gold = crGoldReward(targetDef.cr);
                s.player.xp += targetDef.xp;
                s.player.gold += gold;
                this.addLogs([
                  { left: `☠ ${targetDef.name} is slain! +${targetDef.xp} XP  +${gold} GP`, style: 'kill' },
                  { left: `Total XP: ${s.player.xp}  |  GP: ${s.player.gold}`, style: 'status' },
                ]);
                this.killNpc(target.id);
              }
            }
          }
        }

        ally.isActive = false;
      }
    }

    if (s.phase !== 'defeat' && s.phase !== 'death_saves') {
      if (s.npcs.filter((n) => n.disposition === 'enemy' && n.hp > 0).length === 0) {
        s.phase = 'exploring';
      } else {
        this.enterPlayerTurn();
      }
    }
  }

  private doRollDeathSave(events: GameEvent[]): void {
    const s = this.state;
    if (s.phase !== 'death_saves') return;

    const { roll, outcome } = rollDeathSave();
    const logs: LogEntry[] = [{ left: `${this.playerDef.name} death save: d20 = ${roll}`, style: 'normal' }];
    let nextPhase: CombatMode = 'death_saves';

    switch (outcome) {
      case 'nat20':
        s.player.hp = 1;
        logs.push({ left: `Natural 20! ${this.playerDef.name} regains 1 HP!`, style: 'heal' });
        nextPhase = 'player_turn';
        break;
      case 'nat1':
        s.player.deathSaveFailures = Math.min(3, s.player.deathSaveFailures + 2);
        logs.push({ left: `Natural 1 — two failures (${s.player.deathSaveFailures}/3)`, style: 'miss' });
        nextPhase = s.player.deathSaveFailures >= 3 ? 'defeat' : 'enemy_turn';
        if (nextPhase === 'defeat') logs.push({ left: `${this.playerDef.name} has died.`, style: 'kill' });
        break;
      case 'success':
        s.player.deathSaveSuccesses++;
        logs.push({ left: `Success (${s.player.deathSaveSuccesses}/3)`, style: 'hit' });
        if (s.player.deathSaveSuccesses >= 3) { logs.push({ left: `${this.playerDef.name} stabilizes.`, style: 'heal' }); nextPhase = 'defeat'; }
        else nextPhase = 'enemy_turn';
        break;
      case 'failure':
        s.player.deathSaveFailures++;
        logs.push({ left: `Failure (${s.player.deathSaveFailures}/3)`, style: 'miss' });
        nextPhase = s.player.deathSaveFailures >= 3 ? 'defeat' : 'enemy_turn';
        if (nextPhase === 'defeat') logs.push({ left: `${this.playerDef.name} has died.`, style: 'kill' });
        break;
    }

    this.addLogs(logs);

    if (nextPhase === 'player_turn') {
      s.player.movesLeft = this.playerDef.speed;
      s.phase = 'player_turn';
    } else if (nextPhase === 'enemy_turn') {
      this.enterEnemyPhase(events);
    } else {
      s.phase = nextPhase;
    }
  }

  private doSearch(_events: GameEvent[]): void {
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
        const item = this.defs.items.find((i) => i.id === r.itemId);
        if (item) { s.player.inventoryIds.push(r.itemId); logs.push({ left: `Found: ${item.name}`, style: 'status' }); }
      } else {
        logs.push({ left: `Lore: "${r.text}"`, style: 'normal' });
      }
    } else {
      logs.push({ left: `Search (${roll} vs DC ${secret.def.dc}) — ${secret.def.failureText}`, style: 'miss' });
    }
    this.addLogs(logs);
  }

  private doUsePotion(_events: GameEvent[]): void {
    const s = this.state;
    if (s.phase === 'player_turn' && s.player.bonusActionUsed) return;
    if (s.phase !== 'player_turn' && s.phase !== 'exploring') return;

    const idx = s.player.inventoryIds.findIndex((id) => {
      const item = this.defs.items.find((i) => i.id === id);
      return item?.type === 'consumable';
    });
    if (idx === -1) return;

    const itemId = s.player.inventoryIds.splice(idx, 1)[0];
    const item = this.defs.items.find((i) => i.id === itemId) as ConsumableDef;
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
      const weapon = this.defs.items.find((i) => i.id === s.player.equippedSlots.weaponId) as WeaponDef | undefined;
      if (weapon?.twoHanded) return;
    }
    if (slot === 'weapon') {
      const incoming = this.defs.items.find((i) => i.id === itemId) as WeaponDef | undefined;
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
    applyEquipment(this.playerDef, s.player.equippedSlots, this.defs.items);
    s.player.equippedSlots = { ...s.player.equippedSlots };
  }

  private doUnequip(slot: 'armor' | 'weapon' | 'shield'): void {
    const s = this.state;
    const slotKey = `${slot}Id` as keyof EquipmentSlots;
    const currentId = s.player.equippedSlots[slotKey];
    if (!currentId) return;
    s.player.inventoryIds.push(currentId);
    s.player.equippedSlots[slotKey] = null;
    applyEquipment(this.playerDef, s.player.equippedSlots, this.defs.items);
    s.player.equippedSlots = { ...s.player.equippedSlots };
  }

  private doEnemyOpportunityAttack(npc: NpcState, events: GameEvent[]): void {
    const s = this.state;
    const def = this.resolveMonsterDef(npc.defId);
    if (!def) return;
    const meleeAttack = def.attacks.find((a) => a.attackType === 'melee' || a.attackType === 'both');
    if (!meleeAttack) return;
    npc.reactionUsed = true;
    const withDisadvantage = s.player.conditions.includes('dodging');
    const { damage, isHit, isCrit, logs } = enemyAttack(def, meleeAttack, this.playerDef.ac, false, withDisadvantage);
    this.addLogs([{ left: `⚡ ${def.name} makes an Opportunity Attack!`, style: 'header' }, ...logs]);
    if (isHit) {
      this.applyDamageToPlayer(damage, events);
    }
    void isCrit;
  }

  private doPlayerOpportunityAttack(npc: NpcState, _events: GameEvent[]): void {
    const s = this.state;
    if (s.player.reactionUsed || s.player.hp <= 0) return;
    const targetDef = this.resolveMonsterDef(npc.defId);
    if (!targetDef) return;
    s.player.reactionUsed = true;
    const { damage, logs, vexApplied } = playerMeleeAttack(this.playerDef, targetDef, false);
    this.addLogs([{ left: `⚡ ${this.playerDef.name} makes an Opportunity Attack!`, style: 'header' }, ...logs]);
    const { finalDamage: oaFinalDamage, log: oaResistLog } = this.resistMod(damage, this.playerDef.mainAttack.damageType, targetDef);
    if (oaResistLog) this.addLog(oaResistLog);
    npc.hp = Math.max(0, npc.hp - oaFinalDamage);
    this.addLog({ left: `${targetDef.name} HP: ${npc.hp}/${npc.maxHp}`, style: 'status' });
    if (vexApplied) npc.vexed = true;
    if (npc.hp <= 0) {
      const gold = crGoldReward(targetDef.cr);
      s.player.xp += targetDef.xp;
      s.player.gold += gold;
      this.addLog({ left: `☠ ${targetDef.name} slain by Opportunity Attack! +${targetDef.xp} XP  +${gold} GP`, style: 'kill' });
      this.killNpc(npc.id);
    }
  }

  private doShortRest(_events: GameEvent[]): void {
    const s = this.state;
    if (s.phase !== 'exploring') return;
    if (s.player.hp >= this.playerDef.maxHp) return;
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

  private advanceQuest(type: QuestGoalType): void {
    const s = this.state;
    for (const q of s.quests) {
      if (q.goalType !== type || q.completed) continue;
      q.progress = Math.min(q.progress + 1, q.goalTarget);
      if (q.progress >= q.goalTarget) {
        q.completed = true;
        s.player.xp += q.rewardXp;
        s.player.gold += q.rewardGp;
        this.addLog({ left: `Quest complete: ${q.title}! +${q.rewardXp} XP  +${q.rewardGp} GP`, style: 'status' });
      }
    }
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
    applyEquipment(ownedDef, equippedSlots, defs.items);

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
      hidden: false,
      actionUsed: false,
      bonusActionUsed: false,
      reactionUsed: false,
      movesLeft: 0,
      deathSaveSuccesses: 0,
      deathSaveFailures: 0,
      hitDiceUsed: 0,
      conditions: [] as string[],
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
      spawnItems(mapItems, map, defs.items, player.tileX, player.tileY, npcs);
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
      quests,
      selectedTargetId: null,
      activeNpcIndex: 0,
      turnOrderIds: [],
      introduction: req.encounterContext.introduction,
      encounterContext: req.encounterContext.context,
      npcPersonas,
    };

    const sessionDefs: GameDefs = {
      ...defs,
      playerDefs: defs.playerDefs.map((p) => p.id === ownedDef.id ? ownedDef : p),
    };

    return new GameEngine(state, sessionDefs);
  }
}

// ── Spawn helpers ──────────────────────────────────────────────────────────────

type Zone = [number, number][]; // [tileX, tileY] pairs, already filtered to passable tiles
type ZoneMap = Map<string, Zone>;

function parseStartingZones(rows: string[], map: GameMap): ZoneMap {
  const result: ZoneMap = new Map();
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      const ch = rows[r][c];
      if (ch === '.' || ch === '#' || ch === ' ') continue;
      if (!map.passable[r]?.[c]) continue;
      if (!result.has(ch)) result.set(ch, []);
      result.get(ch)!.push([c, r]);
    }
  }
  return result;
}

function pickFromZone(zone: Zone, occupied: Set<string>): [number, number] | null {
  const free = zone.filter(([c, r]) => !occupied.has(`${c},${r}`));
  if (!free.length) return null;
  return free[Math.floor(Math.random() * free.length)];
}

function findPlayerSpawn(map: GameMap, zone?: Zone): [number, number] {
  if (zone) {
    const pick = zone[Math.floor(Math.random() * zone.length)];
    if (pick) return pick;
  }
  const { cols, rows, passable } = map;
  const candidates: [number, number][] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < Math.floor(cols / 3); c++)
      if (passable[r][c]) candidates.push([c, r]);
  if (candidates.length > 0) return candidates[Math.floor(Math.random() * candidates.length)];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      if (passable[r][c]) return [c, r];
  return [0, 0];
}

function spawnEnemies(
  out: NpcState[], map: GameMap, monsters: MonsterDef[],
  px: number, py: number, count: number,
  zone?: Zone,
): void {
  const defs = monsters.filter((m) => m.cr !== '0');
  const occupied = new Set<string>([`${px},${py}`, ...out.map((n) => `${n.tileX},${n.tileY}`)]);

  if (zone) {
    const free = shuffle(zone.filter(([c, r]) => !occupied.has(`${c},${r}`))).slice(0, Math.min(count, zone.length));
    free.forEach(([c, r], i) => {
      const def = defs[Math.floor(Math.random() * defs.length)];
      out.push({
        id: `enemy_${i}`, defId: def.id, label: String.fromCharCode(65 + i),
        tileX: c, tileY: r,
        disposition: 'enemy',
        hp: def.maxHp, maxHp: def.maxHp,
        isActive: false, vexed: false, hidden: false,
        reactionUsed: false, conditions: [],
      });
    });
    return;
  }

  const { cols, rows, passable } = map;
  const candidates: [number, number][] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      if (passable[r][c] && chebyshev(c, r, px, py) >= 5) candidates.push([r, c]);
  const picked = shuffle(candidates).slice(0, Math.min(count, candidates.length));
  picked.forEach(([r, c], i) => {
    const def = defs[Math.floor(Math.random() * defs.length)];
    out.push({
      id: `enemy_${i}`, defId: def.id, label: String.fromCharCode(65 + i),
      tileX: c, tileY: r,
      disposition: 'enemy',
      hp: def.maxHp, maxHp: def.maxHp,
      isActive: false, vexed: false, hidden: false,
      reactionUsed: false, conditions: [],
    });
  });
}

function spawnItems(
  out: MapItemState[], map: GameMap, items: import('./types.js').ItemDef[],
  px: number, py: number, npcs: NpcState[],
): void {
  const potion = items.find((i) => i.id === 'health_potion');
  if (!potion) return;
  const { cols, rows, passable } = map;
  const candidates: [number, number][] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      if (passable[r][c] && chebyshev(c, r, px, py) >= 3 && !npcs.some((n) => n.tileX === c && n.tileY === r))
        candidates.push([r, c]);
  shuffle(candidates).slice(0, Math.min(3, candidates.length)).forEach(([r, c], i) => {
    out.push({ id: `item_${i}`, defId: potion.id, tileX: c, tileY: r });
  });
}

function spawnNpc(
  out: NpcState[], map: GameMap, npcDefs: NPCDef[], monsters: MonsterDef[],
  defId: string, px: number, py: number,
  disposition: 'neutral' | 'ally' = 'neutral',
  zone?: Zone,
): void {
  const npcDef = npcDefs.find((n) => n.id === defId);
  if (!npcDef) return;
  const monsterDef = monsters.find((m) => m.id === npcDef.monsterClass);
  const maxHp = monsterDef?.maxHp ?? 8;
  const occupied = new Set<string>([
    `${px},${py}`,
    ...out.map((n) => `${n.tileX},${n.tileY}`),
  ]);

  let candidates: [number, number][];
  if (zone) {
    candidates = zone.filter(([c, r]) => !occupied.has(`${c},${r}`));
  } else {
    const { cols, rows, passable } = map;
    candidates = [];
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const dist = chebyshev(c, r, px, py);
        const inRange = disposition === 'ally' ? dist >= 1 && dist <= 3 : dist >= 5;
        if (passable[r][c] && inRange && !occupied.has(`${c},${r}`))
          candidates.push([c, r]);
      }
  }

  if (candidates.length === 0) return;
  const [nx, ny] = candidates[Math.floor(Math.random() * candidates.length)];
  out.push({
    id: `npc_${defId}_${out.length}`,
    defId,
    tileX: nx, tileY: ny,
    disposition,
    label: '',
    hp: maxHp, maxHp,
    isActive: false, vexed: false, hidden: false,
    reactionUsed: false, conditions: [],
  });
}

function spawnSecrets(
  out: SecretState[], map: GameMap, secretDefs: SecretDef[],
  px: number, py: number, npcs: NpcState[],
): void {
  const { cols, rows, passable } = map;
  const candidates: [number, number][] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      if (passable[r][c] && chebyshev(c, r, px, py) >= 3 && !npcs.some((n) => n.tileX === c && n.tileY === r))
        candidates.push([r, c]);
  shuffle(candidates).slice(0, Math.min(secretDefs.length, candidates.length)).forEach(([r, c], i) => {
    out.push({ tileX: c, tileY: r, def: secretDefs[i] as SecretDef });
  });
}
