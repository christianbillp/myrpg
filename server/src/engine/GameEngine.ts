import {
  GameState, GameEvent, PlayerAction, CombatMode,
  PlayerDef, MonsterDef, NPCDef, ItemDef, ConsumableDef, WeaponDef,
  EquipmentSlots, EnemyState, NpcState, MapItemState, SecretState, QuestState,
  QuestGoalType, SecretDef, NpcPersona, GameMap,
  CreateSessionRequest,
} from './types.js';
import type { EncounterContext } from '../encounterService.js';
import { generateMap } from './MapGenerator.js';
import { generateRoomsMap } from './RoomsMapGenerator.js';
import { shuffle } from './MapUtils.js';
import { d20 } from './Dice.js';
import {
  rollInitiative, playerMeleeAttack, enemyAttack, playerHide, playerSecondWind,
  drinkPotion, rollDeathSave, rollSkillCheck,
} from './CombatSystem.js';
import { applyEquipment } from './EquipmentSystem.js';
import { runEnemyTurn, chebyshev } from './EnemyAI.js';

const TURN_CONDITIONS = ['dodging', 'disengaged', 'dashing'];

export interface GameDefs {
  playerDefs: PlayerDef[];
  monsters: MonsterDef[];
  npcs: NPCDef[];
  items: ItemDef[];
  maps: { id: string; passable: boolean[][]; cols: number; rows: number; name: string; description: string }[];
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

    // Advance UID counter past any entity IDs already in state so spawned
    // entities never clash with restored ones after a server restart.
    for (const id of [
      ...state.enemies.map((e) => e.id),
      ...state.npcs.map((n) => n.id),
      ...state.mapItems.map((i) => i.id),
    ]) {
      const n = parseInt(id.replace(/\D/g, ''), 10);
      if (!isNaN(n) && n >= uidCounter) uidCounter = n + 1;
    }
  }

  getState(): GameState { return this.state; }

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
    const enemy = s.enemies.find((e) => e.label === label);
    if (!enemy) return [];
    enemy.hp = Math.max(0, hp);
    if (enemy.hp === 0) this.killEnemy(enemy.id);
    return [];
  }

  addLog(text: string): void {
    this.state.combatLog.push(text);
    this.state.logScrollOffset = 0;
  }

  addLogs(lines: string[]): void {
    lines.forEach((l) => this.addLog(l));
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
      const enemy = s.enemies.find((e) => e.label === label);
      if (enemy) {
        enemy.tileX = tileX;
        enemy.tileY = tileY;
        events.push({ type: 'entity_move', entityId: enemy.id, toX: tileX, toY: tileY });
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
    const label = String.fromCharCode(65 + s.enemies.filter((e) => e.hp > 0).length);
    const enemy: EnemyState = {
      id: uid(), defId: def.id, label,
      tileX: tx, tileY: ty,
      hp: def.maxHp, maxHp: def.maxHp,
      isActive: false, vexed: false, hidden: false,
      reactionUsed: false, conditions: [],
    };
    s.enemies.push(enemy);
    if (s.phase !== 'exploring') {
      s.turnOrderIds.push(enemy.id);
    }
    return [];
  }

  endCombat(): GameEvent[] {
    const s = this.state;
    s.phase = 'exploring';
    s.enemies = [];
    s.activeEnemyIndex = 0;
    s.turnOrderIds = [];
    s.player.hidden = false;
    return [];
  }

  triggerCombat(): GameEvent[] {
    const s = this.state;
    if (s.phase !== 'exploring' || s.enemies.length === 0) return [];
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

  applyCondition(entity: string, condition: string): GameEvent[] {
    const s = this.state;
    if (entity === 'player') {
      if (!s.player.conditions.includes(condition)) s.player.conditions.push(condition);
    } else if (entity.startsWith('enemy_')) {
      const label = entity.replace('enemy_', '');
      const enemy = s.enemies.find((e) => e.label === label);
      if (enemy && !enemy.conditions.includes(condition)) enemy.conditions.push(condition);
    }
    return [];
  }

  removeCondition(entity: string, condition: string): GameEvent[] {
    const s = this.state;
    if (entity === 'player') {
      s.player.conditions = s.player.conditions.filter((c) => c !== condition);
    } else if (entity.startsWith('enemy_')) {
      const label = entity.replace('enemy_', '');
      const enemy = s.enemies.find((e) => e.label === label);
      if (enemy) enemy.conditions = enemy.conditions.filter((c) => c !== condition);
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
    if (s.enemies.some((e) => e.hp > 0 && e.tileX === nx && e.tileY === ny)) return;
    if (s.npcs.some((n) => n.tileX === nx && n.tileY === ny)) return;
    if (s.phase === 'player_turn' && s.player.movesLeft <= 0) return;

    const oldX = s.player.tileX;
    const oldY = s.player.tileY;
    s.player.tileX = nx;
    s.player.tileY = ny;
    events.push({ type: 'entity_move', entityId: 'player', toX: nx, toY: ny });

    if (s.phase === 'player_turn') {
      s.player.movesLeft--;
      if (!s.player.conditions.includes('disengaged')) {
        for (const enemy of s.enemies.filter((e) => e.hp > 0 && !e.reactionUsed)) {
          if (chebyshev(oldX, oldY, enemy.tileX, enemy.tileY) <= 1 &&
              chebyshev(nx, ny, enemy.tileX, enemy.tileY) > 1) {
            this.doEnemyOpportunityAttack(enemy, events);
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
    for (const enemy of s.enemies) {
      if (chebyshev(s.player.tileX, s.player.tileY, enemy.tileX, enemy.tileY) <= 2) {
        if (s.enemies.length > 1) s.enemies.forEach((e, i) => { e.label = String.fromCharCode(65 + i); });
        this.doStartCombat(events);
        s.selectedTargetId = enemy.id;
        return;
      }
    }
  }

  private doStartCombat(events: GameEvent[]): void {
    const s = this.state;
    const firstEnemy = this.defs.monsters.find((m) => m.id === s.enemies[0]?.defId);
    if (!firstEnemy) return;

    s.player.hidden = false;
    s.player.deathSaveSuccesses = 0;
    s.player.deathSaveFailures = 0;
    s.activeEnemyIndex = 0;
    s.turnOrderIds = ['player', ...s.enemies.map((e) => e.id)];

    const { playerFirst, logs } = rollInitiative(this.playerDef, firstEnemy);
    this.addLogs(logs);
    events.push({ type: 'log', lines: logs });

    if (playerFirst) {
      this.enterPlayerTurn();
    } else {
      this.enterEnemyPhase(events);
    }
  }

  private enterPlayerTurn(): void {
    const s = this.state;
    s.phase = 'player_turn';
    s.activeEnemyIndex = 0;
    s.enemies.forEach((e) => {
      e.isActive = false;
      e.reactionUsed = false;
      e.conditions = e.conditions.filter((c) => !TURN_CONDITIONS.includes(c));
    });
    s.player.movesLeft = this.playerDef.speed;
    s.player.actionUsed = false;
    s.player.bonusActionUsed = false;
    s.player.reactionUsed = false;
    s.player.conditions = s.player.conditions.filter((c) => !TURN_CONDITIONS.includes(c));
  }

  private doAttack(targetId: string | undefined, events: GameEvent[]): void {
    const s = this.state;
    if (s.phase !== 'player_turn' || s.player.actionUsed) return;

    const isAdjacent = (e: EnemyState) =>
      e.hp > 0 && chebyshev(s.player.tileX, s.player.tileY, e.tileX, e.tileY) <= 1;

    let target = targetId
      ? (s.enemies.find((e) => e.id === targetId && isAdjacent(e)) ?? null)
      : null;
    if (!target) target = s.enemies.find(isAdjacent) ?? null;
    if (!target) return;

    const targetDef = this.defs.monsters.find((m) => m.id === target!.defId);
    if (!targetDef) return;

    const withAdvantage = s.player.hidden;
    const { damage, logs, vexApplied } = playerMeleeAttack(this.playerDef, targetDef, withAdvantage);
    s.player.hidden = false;
    this.addLogs(logs);
    events.push({ type: 'log', lines: logs });

    target.hp = Math.max(0, target.hp - damage);
    this.addLog(`${targetDef.name} HP: ${target.hp}/${target.maxHp}`);

    if (vexApplied) {
      target.vexed = true;
      this.addLog(`Vex! ${targetDef.name} has Disadvantage on its next attack.`);
    }

    if (target.hp <= 0) {
      const gold = crGoldReward(targetDef.cr);
      s.player.xp += targetDef.xp;
      s.player.gold += gold;
      this.addLogs([`☠ ${targetDef.name} is slain! +${targetDef.xp} XP  +${gold} GP`, `Total XP: ${s.player.xp}  |  GP: ${s.player.gold}`]);
      this.killEnemy(target.id);
    }

    s.player.actionUsed = true;
    if (s.enemies.filter((e) => e.hp > 0).length === 0) {
      s.phase = 'exploring';
    }
  }

  private killEnemy(id: string): void {
    const s = this.state;
    s.enemies = s.enemies.filter((e) => e.id !== id);
    s.turnOrderIds = s.turnOrderIds.filter((tid) => tid !== id);
    if (s.selectedTargetId === id) s.selectedTargetId = null;
    this.advanceQuest('kill');
  }

  private doHide(events: GameEvent[]): void {
    const s = this.state;
    if (s.phase !== 'player_turn' || s.player.bonusActionUsed) return;
    const target = s.enemies.find((e) => e.hp > 0);
    if (!target) return;
    const targetDef = this.defs.monsters.find((m) => m.id === target.defId);
    if (!targetDef) return;
    const { hidden, logs } = playerHide(this.playerDef, targetDef.passivePerception);
    s.player.hidden = hidden;
    this.addLogs(logs);
    events.push({ type: 'log', lines: logs });
    s.player.bonusActionUsed = true;
  }

  private doDash(events: GameEvent[]): void {
    const s = this.state;
    if (s.phase !== 'player_turn' || s.player.actionUsed) return;
    s.player.movesLeft += this.playerDef.speed;
    s.player.conditions.push('dashing');
    s.player.actionUsed = true;
    const log = `${this.playerDef.name} Dashes! +${this.playerDef.speed} movement.`;
    this.addLog(log);
    events.push({ type: 'log', lines: [log] });
  }

  private doDodge(events: GameEvent[]): void {
    const s = this.state;
    if (s.phase !== 'player_turn' || s.player.actionUsed) return;
    s.player.conditions.push('dodging');
    s.player.actionUsed = true;
    const log = `${this.playerDef.name} Dodges! Enemies attack with Disadvantage until next turn.`;
    this.addLog(log);
    events.push({ type: 'log', lines: [log] });
  }

  private doDisengage(events: GameEvent[]): void {
    const s = this.state;
    if (s.phase !== 'player_turn' || s.player.actionUsed) return;
    s.player.conditions.push('disengaged');
    s.player.actionUsed = true;
    const log = `${this.playerDef.name} Disengages! No Opportunity Attacks this turn.`;
    this.addLog(log);
    events.push({ type: 'log', lines: [log] });
  }

  private doSecondWind(events: GameEvent[]): void {
    const s = this.state;
    if (s.phase !== 'player_turn' || s.player.bonusActionUsed || s.player.secondWindUses <= 0 || s.player.hp >= this.playerDef.maxHp) return;
    const { healed, logs } = playerSecondWind(this.playerDef.level);
    const before = s.player.hp;
    s.player.hp = Math.min(this.playerDef.maxHp, s.player.hp + healed);
    s.player.secondWindUses--;
    const fullLogs = [...logs, `HP: ${before} → ${s.player.hp}/${this.playerDef.maxHp} (${s.player.secondWindUses} uses left)`];
    this.addLogs(fullLogs);
    events.push({ type: 'log', lines: fullLogs });
    s.player.bonusActionUsed = true;
  }

  private doEndTurn(events: GameEvent[]): void {
    if (this.state.phase !== 'player_turn') return;
    this.enterEnemyPhase(events);
  }

  private enterEnemyPhase(events: GameEvent[]): void {
    const s = this.state;
    s.phase = 'enemy_turn';
    s.activeEnemyIndex = 0;
    this.runAllEnemyTurns(events);
  }

  private runAllEnemyTurns(events: GameEvent[]): void {
    const s = this.state;
    const living = s.enemies.filter((e) => e.hp > 0);

    for (const enemy of living) {
      if (s.phase === 'defeat') break;
      enemy.isActive = true;

      const def = this.defs.monsters.find((m) => m.id === enemy.defId);
      if (!def) { enemy.isActive = false; continue; }

      const occupied: [number, number][] = [
        ...s.enemies.filter((e) => e !== enemy && e.hp > 0).map((e): [number, number] => [e.tileX, e.tileY]),
        ...s.npcs.map((n): [number, number] => [n.tileX, n.tileY]),
      ];

      const startedAdjacentToPlayer = chebyshev(enemy.tileX, enemy.tileY, s.player.tileX, s.player.tileY) <= 1;

      const result = runEnemyTurn(enemy, def, {
        playerTileX: s.player.tileX,
        playerTileY: s.player.tileY,
        playerAc: this.playerDef.ac,
        playerHp: s.player.hp,
        playerHidden: s.player.hidden,
        enemyVexed: enemy.vexed,
        enemyCurrentlyHidden: enemy.hidden,
        playerDodging: s.player.conditions.includes('dodging'),
        passivePerception: 10 + (this.playerDef.skills['perception'] ?? 0),
        passable: s.map.passable,
        mapCols: s.map.cols,
        mapRows: s.map.rows,
        occupiedTiles: occupied,
      });

      const endedAdjacentToPlayer = chebyshev(result.finalTileX, result.finalTileY, s.player.tileX, s.player.tileY) <= 1;

      // Apply move results
      enemy.tileX = result.finalTileX;
      enemy.tileY = result.finalTileY;
      enemy.hidden = result.hidden;
      enemy.vexed = false;
      events.push(...result.events);

      // Player Opportunity Attack if enemy moved out of player's reach
      if (startedAdjacentToPlayer && !endedAdjacentToPlayer && !result.attacked) {
        this.doPlayerOpportunityAttack(enemy, events);
      }

      this.addLogs(result.logs);
      events.push({ type: 'log', lines: result.logs });

      // Apply attack result
      if (result.attacked && result.isHit) {
        if (s.player.hp <= 0) {
          const failures = result.isCrit ? 2 : 1;
          s.player.deathSaveFailures = Math.min(3, s.player.deathSaveFailures + failures);
          const dsLogs = [
            `Strikes unconscious ${this.playerDef.name}!${result.isCrit ? ' CRITICAL — 2 failures!' : ' 1 failure.'}`,
            `Death saves: ${s.player.deathSaveSuccesses} ✓  ${s.player.deathSaveFailures} ✗`,
          ];
          this.addLogs(dsLogs);
          events.push({ type: 'log', lines: dsLogs });
          if (s.player.deathSaveFailures >= 3) {
            this.addLog(`${this.playerDef.name} has died.`);
            s.phase = 'defeat';
          } else {
            s.phase = 'death_saves';
          }
        } else {
          s.player.hp = Math.max(0, s.player.hp - result.damage);
          const dmgLog = `${this.playerDef.name} HP: ${s.player.hp}/${this.playerDef.maxHp}`;
          this.addLog(dmgLog);
          events.push({ type: 'log', lines: [dmgLog] });
          if (s.player.hp <= 0) {
            const fallLog = `${this.playerDef.name} falls unconscious!`;
            this.addLog(fallLog);
            events.push({ type: 'log', lines: [fallLog] });
            s.phase = 'death_saves';
          }
        }
      }
      s.player.hidden = false;
      enemy.isActive = false;
    }

    if (s.phase !== 'defeat' && s.phase !== 'death_saves') this.enterPlayerTurn();
  }

  private doRollDeathSave(events: GameEvent[]): void {
    const s = this.state;
    if (s.phase !== 'death_saves') return;

    const { roll, outcome } = rollDeathSave();
    const logs: string[] = [`${this.playerDef.name} death save: d20 = ${roll}`];
    let nextPhase: CombatMode = 'death_saves';

    switch (outcome) {
      case 'nat20':
        s.player.hp = 1;
        logs.push(`Natural 20! ${this.playerDef.name} regains 1 HP!`);
        nextPhase = 'player_turn';
        break;
      case 'nat1':
        s.player.deathSaveFailures = Math.min(3, s.player.deathSaveFailures + 2);
        logs.push(`Natural 1! Two failures. (${s.player.deathSaveFailures}/3)`);
        nextPhase = s.player.deathSaveFailures >= 3 ? 'defeat' : 'enemy_turn';
        if (nextPhase === 'defeat') logs.push(`${this.playerDef.name} has died.`);
        break;
      case 'success':
        s.player.deathSaveSuccesses++;
        logs.push(`Success! (${s.player.deathSaveSuccesses}/3)`);
        if (s.player.deathSaveSuccesses >= 3) { logs.push(`${this.playerDef.name} stabilizes.`); nextPhase = 'defeat'; }
        else nextPhase = 'enemy_turn';
        break;
      case 'failure':
        s.player.deathSaveFailures++;
        logs.push(`Failure! (${s.player.deathSaveFailures}/3)`);
        nextPhase = s.player.deathSaveFailures >= 3 ? 'defeat' : 'enemy_turn';
        if (nextPhase === 'defeat') logs.push(`${this.playerDef.name} has died.`);
        break;
    }

    this.addLogs(logs);
    events.push({ type: 'log', lines: logs });

    if (nextPhase === 'player_turn') {
      s.player.movesLeft = this.playerDef.speed;
      s.phase = 'player_turn';
    } else if (nextPhase === 'enemy_turn') {
      this.enterEnemyPhase(events);
    } else {
      s.phase = nextPhase;
    }
  }

  private doSearch(events: GameEvent[]): void {
    const s = this.state;
    if (s.phase !== 'exploring') return;

    const roll = d20() + (this.playerDef.skills['perception'] ?? 0);
    const adj = s.secrets.filter(
      (sec) => chebyshev(s.player.tileX, s.player.tileY, sec.tileX, sec.tileY) <= 1,
    );

    if (adj.length === 0) {
      const log = `Search (${roll}) — Nothing found.`;
      this.addLog(log);
      events.push({ type: 'log', lines: [log] });
      return;
    }

    const secret = adj[0];
    const success = roll >= secret.def.dc;
    s.secrets = s.secrets.filter((sec) => sec !== secret);

    const logs: string[] = [];
    if (success) {
      this.advanceQuest('explore');
      logs.push(`Search (${roll} vs DC ${secret.def.dc}) — ${secret.def.successText}`);
      const r = secret.def.reward;
      if (r.type === 'gold') {
        s.player.gold += r.amount;
        logs.push(`+${r.amount} GP`);
      } else if (r.type === 'item') {
        const item = this.defs.items.find((i) => i.id === r.itemId);
        if (item) { s.player.inventoryIds.push(r.itemId); logs.push(`Found: ${item.name}`); }
      } else {
        logs.push(`Lore: "${r.text}"`);
      }
    } else {
      logs.push(`Search (${roll} vs DC ${secret.def.dc}) — ${secret.def.failureText}`);
    }
    this.addLogs(logs);
    events.push({ type: 'log', lines: logs });
  }

  private doUsePotion(events: GameEvent[]): void {
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
    const fullLogs = [...logs, `HP: ${before} → ${s.player.hp}/${this.playerDef.maxHp}`];
    this.addLogs(fullLogs);
    events.push({ type: 'log', lines: fullLogs });
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

  private doEnemyOpportunityAttack(enemy: EnemyState, events: GameEvent[]): void {
    const s = this.state;
    const def = this.defs.monsters.find((m) => m.id === enemy.defId);
    if (!def) return;
    const meleeAttack = def.attacks.find((a) => a.attackType === 'melee' || a.attackType === 'both');
    if (!meleeAttack) return;
    enemy.reactionUsed = true;
    const withDisadvantage = s.player.conditions.includes('dodging');
    const { damage, isHit, isCrit, logs } = enemyAttack(def, meleeAttack, this.playerDef.ac, false, withDisadvantage);
    const oaLogs = [`⚡ ${def.name} makes an Opportunity Attack!`, ...logs];
    this.addLogs(oaLogs);
    events.push({ type: 'log', lines: oaLogs });
    if (isHit) {
      s.player.hp = Math.max(0, s.player.hp - damage);
      const dmgLog = `${this.playerDef.name} HP: ${s.player.hp}/${this.playerDef.maxHp}`;
      this.addLog(dmgLog);
      events.push({ type: 'log', lines: [dmgLog] });
      if (s.player.hp <= 0) {
        const fallLog = `${this.playerDef.name} falls unconscious!`;
        this.addLog(fallLog);
        events.push({ type: 'log', lines: [fallLog] });
        s.phase = 'death_saves';
      }
    }
    // Suppress unused variable warning for isCrit (consistent with future death-save extension)
    void isCrit;
  }

  private doPlayerOpportunityAttack(enemy: EnemyState, events: GameEvent[]): void {
    const s = this.state;
    if (s.player.reactionUsed || s.player.hp <= 0) return;
    const targetDef = this.defs.monsters.find((m) => m.id === enemy.defId);
    if (!targetDef) return;
    s.player.reactionUsed = true;
    const { damage, logs, vexApplied } = playerMeleeAttack(this.playerDef, targetDef, false);
    const oaLogs = [`⚡ ${this.playerDef.name} makes an Opportunity Attack!`, ...logs];
    this.addLogs(oaLogs);
    events.push({ type: 'log', lines: oaLogs });
    enemy.hp = Math.max(0, enemy.hp - damage);
    this.addLog(`${targetDef.name} HP: ${enemy.hp}/${enemy.maxHp}`);
    if (vexApplied) enemy.vexed = true;
    if (enemy.hp <= 0) {
      const gold = crGoldReward(targetDef.cr);
      s.player.xp += targetDef.xp;
      s.player.gold += gold;
      this.addLogs([`☠ ${targetDef.name} slain by Opportunity Attack! +${targetDef.xp} XP  +${gold} GP`]);
      this.killEnemy(enemy.id);
    }
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
        this.addLog(`Quest complete: ${q.title}! +${q.rewardXp} XP  +${q.rewardGp} GP`);
      }
    }
  }

  private findFreeTileNear(cx: number, cy: number, minDist: number, maxDist: number): [number, number] {
    const s = this.state;
    const { cols, rows, passable } = s.map;
    const occupied = new Set<string>([
      `${s.player.tileX},${s.player.tileY}`,
      ...s.enemies.filter((e) => e.hp > 0).map((e) => `${e.tileX},${e.tileY}`),
      ...s.npcs.map((n) => `${n.tileX},${n.tileY}`),
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
    // Deep-copy playerDef so we can mutate AC/mainAttack per session
    const ownedDef: PlayerDef = JSON.parse(JSON.stringify(playerDef));
    applyEquipment(ownedDef, equippedSlots, defs.items);

    const inventoryIds: string[] = req.resumeInventoryIds ?? [...(playerDef.defaultInventoryIds ?? [])];

    // Find player spawn
    const [pX, pY] = findPlayerSpawn(map);

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
      conditions: [] as string[],
    };

    const isCombat = req.encounterTypes.includes('simple_combat');

    const enemies: EnemyState[] = [];
    const npcs: NpcState[] = [];
    const mapItems: MapItemState[] = [];
    const secrets: SecretState[] = [];

    if (isCombat) {
      spawnEnemies(enemies, map, defs.monsters, player.tileX, player.tileY, req.encounterContext.enemyCount ?? 2);
      spawnItems(mapItems, map, defs.items, player.tileX, player.tileY, enemies);
    }
    if (req.encounterTypes.includes('social_interaction')) {
      for (const defId of (req.npcIds ?? [])) {
        spawnNpc(npcs, map, defs.npcs, defId, player.tileX, player.tileY, enemies);
      }
    }
    if (req.encounterTypes.includes('exploration')) {
      spawnSecrets(secrets, map, req.encounterContext.secrets ?? [], player.tileX, player.tileY, enemies);
    }

    const npcPersonas: NpcPersona[] = npcs.flatMap((ns) => {
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
      enemies,
      npcs,
      mapItems,
      secrets,
      combatLog: [],
      logScrollOffset: 0,
      encounterTypes: req.encounterTypes,
      mapName: req.encounterContext.mapName ?? 'Unknown',
      quests,
      selectedTargetId: null,
      activeEnemyIndex: 0,
      turnOrderIds: [],
      introduction: req.encounterContext.introduction,
      encounterContext: req.encounterContext.context,
      npcPersonas,
    };

    // Use a plain object as defs with the owned def substituted
    const sessionDefs: GameDefs = {
      ...defs,
      playerDefs: defs.playerDefs.map((p) => p.id === ownedDef.id ? ownedDef : p),
    };

    return new GameEngine(state, sessionDefs);
  }
}

// ── Spawn helpers ──────────────────────────────────────────────────────────────

function findPlayerSpawn(map: GameMap): [number, number] {
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
  out: EnemyState[], map: GameMap, monsters: MonsterDef[],
  px: number, py: number, count: number,
): void {
  const defs = monsters.filter((m) => m.cr !== '0');
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
      tileX: c, tileY: r, hp: def.maxHp, maxHp: def.maxHp,
      isActive: false, vexed: false, hidden: false,
      reactionUsed: false, conditions: [],
    });
  });
}

function spawnItems(
  out: MapItemState[], map: GameMap, items: import('./types.js').ItemDef[],
  px: number, py: number, enemies: EnemyState[],
): void {
  const potion = items.find((i) => i.id === 'health_potion');
  if (!potion) return;
  const { cols, rows, passable } = map;
  const candidates: [number, number][] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      if (passable[r][c] && chebyshev(c, r, px, py) >= 3 && !enemies.some((e) => e.tileX === c && e.tileY === r))
        candidates.push([r, c]);
  shuffle(candidates).slice(0, Math.min(3, candidates.length)).forEach(([r, c], i) => {
    out.push({ id: `item_${i}`, defId: potion.id, tileX: c, tileY: r });
  });
}

function spawnNpc(
  out: NpcState[], map: GameMap, npcDefs: NPCDef[],
  defId: string, px: number, py: number, enemies: EnemyState[],
): void {
  if (!npcDefs.find((n) => n.id === defId)) return;
  const { cols, rows, passable } = map;
  const occupied = new Set<string>([
    `${px},${py}`,
    ...enemies.map((e) => `${e.tileX},${e.tileY}`),
    ...out.map((n) => `${n.tileX},${n.tileY}`),
  ]);
  const candidates: [number, number][] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      if (passable[r][c] && chebyshev(c, r, px, py) >= 5 && !occupied.has(`${c},${r}`))
        candidates.push([c, r]);
  if (candidates.length === 0) return;
  const [nx, ny] = candidates[Math.floor(Math.random() * candidates.length)];
  out.push({ id: uid(), defId, tileX: nx, tileY: ny });
}

function spawnSecrets(
  out: SecretState[], map: GameMap, secretDefs: SecretDef[],
  px: number, py: number, enemies: EnemyState[],
): void {
  const { cols, rows, passable } = map;
  const candidates: [number, number][] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      if (passable[r][c] && chebyshev(c, r, px, py) >= 3 && !enemies.some((e) => e.tileX === c && e.tileY === r))
        candidates.push([r, c]);
  shuffle(candidates).slice(0, Math.min(secretDefs.length, candidates.length)).forEach(([r, c], i) => {
    out.push({ tileX: c, tileY: r, def: secretDefs[i] as SecretDef });
  });
}
