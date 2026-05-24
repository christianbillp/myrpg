import {
  GameState, GameEvent, PlayerAction, PlayerAttack, CombatMode,
  PlayerDef, MonsterDef, NPCDef, ItemDef, ConsumableDef, WeaponDef,
  EquipmentSlots, NpcState, Disposition, MapItemState, SecretState, QuestState,
  QuestGoalType, NpcPersona, GameMap, LogEntry,
  CreateSessionRequest, FeatDef, BackgroundDef, SpeciesDef,
} from './types.js';
import type { EncounterContext } from '../encounterService.js';
import { generateMap } from './MapGenerator.js';
import { generateRoomsMap } from './RoomsMapGenerator.js';
import { d, d20, mod } from './Dice.js';
import {
  rollInitiative, playerMeleeAttack, playerThrowAttack, enemyAttack, playerHide, playerSecondWind,
  drinkPotion, rollDeathSave, rollSkillCheck, rollSavingThrow,
} from './CombatSystem.js';
import { applyEquipment, makePlayerAttack, computeEquippedSlotLabels } from './EquipmentSystem.js';
import { runEnemyTurn, runAllyTurn, chebyshev } from './EnemyAI.js';
import {
  isIncapacitated, grantsAdvantageAgainst, grantsDisadvantageAgainst,
  hasAttackDisadvantage, hasAttackAdvantage, hasSpeedZero, isAutoCrit, proneStandCost,
} from './ConditionSystem.js';
import {
  ZoneMap, parseStartingZones, findPlayerSpawn,
  spawnEnemies, spawnItems, spawnNpc, spawnSecrets,
} from './SpawnHelpers.js';

const TURN_CONDITIONS = ['dodging', 'disengaged', 'dashing', 'slowed'];

export interface GameDefs {
  playerDefs: PlayerDef[];
  monsters: MonsterDef[];
  npcs: NPCDef[];
  equipment: ItemDef[];
  maps: { id: string; passable: boolean[][]; cols: number; rows: number; name: string; mapdescription: string }[];
  feats: FeatDef[];
  backgrounds: BackgroundDef[];
  species: SpeciesDef[];
}

export interface ActionResult {
  events: GameEvent[];
  state: GameState;
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
    applyEquipment(this.playerDef, state.player.equippedSlots, defs.equipment);
    state.player.equippedSlotLabels = computeEquippedSlotLabels(this.playerDef, state.player.equippedSlots, defs.equipment);

    for (const npc of state.npcs) {
      npc.inventoryIds ??= [];
    }
    for (const id of [
      ...state.npcs.map((n) => n.id),
      ...state.mapItems.map((i) => i.id),
    ]) {
      const n = parseInt(id.replace(/\D/g, ''), 10);
      if (!isNaN(n) && n >= uidCounter) uidCounter = n + 1;
    }
  }

  getState(): GameState { return this.state; }
  getMonsterDef(defId: string): MonsterDef | undefined { return this.resolveMonsterDef(defId); }

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
      case 'throw':       this.doThrow(action.itemId, action.targetId, events); break;
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
    const s = this.state;
    const npcId = entity.replace('npc_', '');
    s.npcs = s.npcs.filter((n) => n.id !== npcId);
    this.autoEndCombatIfNoEnemies();
    return [];
  }

  spawnEnemy(monsterId: string): GameEvent[] {
    const def = this.defs.monsters.find((m) => m.id === monsterId);
    if (!def) return [];
    const s = this.state;
    const [tx, ty] = this.findFreeTileNear(s.player.tileX, s.player.tileY, 3, 8);
    if (tx === -1) return [];
    const usedLabels = new Set(s.npcs.filter((n) => n.disposition === 'enemy').map((n) => n.label));
    let label = 'A';
    for (let i = 0; i < 26; i++) {
      const candidate = String.fromCharCode(65 + i);
      if (!usedLabels.has(candidate)) { label = candidate; break; }
    }
    const npc: NpcState = {
      id: uid(), defId: def.id, name: def.name, label,
      tileX: tx, tileY: ty,
      disposition: 'enemy', factionId: def.id,
      hp: def.maxHp, maxHp: def.maxHp,
      isActive: false,
      reactionUsed: false, conditions: [], inventoryIds: [],
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

  private autoEndCombatIfNoEnemies(): void {
    const s = this.state;
    if (s.phase === 'exploring' || s.phase === 'defeat') return;
    if (s.npcs.some(n => n.disposition === 'enemy' && n.hp > 0)) return;
    this.endCombat();
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
    const npc = this.resolveNpcByEntity(entity);
    if (npc) {
      npc.disposition = disposition as Disposition;
      if ((disposition === 'ally' || disposition === 'enemy') && !npc.label) this.assignCombatLabel(npc);
      if (disposition === 'enemy') this.aggroFaction(npc);
      else this.autoEndCombatIfNoEnemies();
    }
    return [];
  }

  applyCondition(entity: string, condition: string): GameEvent[] {
    const s = this.state;
    if (entity === 'player') {
      if (!s.player.conditions.includes(condition)) s.player.conditions.push(condition);
      if (condition === 'unconscious' && !s.player.conditions.includes('prone')) {
        s.player.conditions.push('prone');
      }
    } else {
      const npc = this.resolveNpcByEntity(entity);
      if (npc && !npc.conditions.includes(condition)) npc.conditions.push(condition);
      if (condition === 'unconscious' && npc && !npc.conditions.includes('prone')) {
        npc.conditions.push('prone');
      }
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
    // Per SRD: poisoned and frightened impose Disadvantage on ability checks.
    const withDisadvantage = conditions.includes('poisoned') || conditions.includes('frightened');
    return rollSkillCheck(skillMod, dc, false, withDisadvantage);
  }

  rollPlayerSavingThrow(ability: string, dc: number): { roll: number; total: number; success: boolean; autoFail: boolean } {
    const { conditions, exhaustionLevel } = this.state.player;
    // Per SRD: paralyzed, unconscious, and stunned cause automatic failure on Str/Dex saves.
    if ((ability === 'str' || ability === 'dex') && (conditions.includes('paralyzed') || conditions.includes('unconscious') || conditions.includes('stunned'))) {
      return { roll: 0, total: 0, success: false, autoFail: true };
    }
    const saveMod = (this.playerDef.savingThrows[ability] ?? 0) - exhaustionLevel * 2;
    // Dodge grants advantage on Dex saves; restrained imposes disadvantage on Dex saves.
    const withAdvantage = ability === 'dex' && conditions.includes('dodging');
    const withDisadvantage = ability === 'dex' && conditions.includes('restrained');
    return { ...rollSavingThrow(saveMod, dc, withAdvantage, withDisadvantage), autoFail: false };
  }

  rollAttackRoll(attacker: string, targetAc: number): { roll: number; total: number; isHit: boolean; isCrit: boolean; damage: number; rollStr: string } {
    if (attacker === 'player') {
      const attack = this.playerDef.mainAttack;
      const statMod = attack.statKey === 'str' ? mod(this.playerDef.str) : mod(this.playerDef.dex);
      const bonus = statMod + this.playerDef.proficiencyBonus;
      const roll = d20();
      const isCrit = roll === 20;
      const isHit = (isCrit || roll + bonus >= targetAc) && roll !== 1;
      let damage = 0;
      let rollStr = `d20(${roll})+${bonus}=${roll + bonus} vs AC ${targetAc}`;
      if (isHit) {
        const diceCount = isCrit ? attack.damageDice * 2 : attack.damageDice;
        const rolls: number[] = [];
        let dmg = 0;
        for (let i = 0; i < diceCount; i++) { const r = d(attack.damageSides); rolls.push(r); dmg += r; }
        damage = Math.max(0, dmg + statMod);
        rollStr += ` · ${diceCount}d${attack.damageSides}[${rolls.join(',')}]+${statMod}=${damage} ${attack.damageType}`;
      }
      return { roll, total: roll + bonus, isHit, isCrit, damage, rollStr };
    }
    const npc = this.resolveNpcByEntity(attacker);
    if (!npc) return { roll: 0, total: 0, isHit: false, isCrit: false, damage: 0, rollStr: 'Unknown attacker.' };
    const monsterDef = this.resolveMonsterDef(npc.defId);
    if (!monsterDef || !monsterDef.attacks.length) return { roll: 0, total: 0, isHit: false, isCrit: false, damage: 0, rollStr: 'No attack available.' };
    const atk = monsterDef.attacks[0];
    const roll = d20();
    const total = roll + atk.bonus;
    const isCrit = roll === 20;
    const isHit = (isCrit || total >= targetAc) && roll !== 1;
    let damage = 0;
    let rollStr = `d20(${roll})+${atk.bonus}=${total} vs AC ${targetAc}`;
    if (isHit) {
      const diceCount = isCrit ? atk.damageDice * 2 : atk.damageDice;
      const rolls: number[] = [];
      let dmg = 0;
      for (let i = 0; i < diceCount; i++) { const r = d(atk.damageSides); rolls.push(r); dmg += r; }
      damage = Math.max(0, dmg + atk.damageBonus);
      rollStr += ` · ${diceCount}d${atk.damageSides}[${rolls.join(',')}]+${atk.damageBonus}=${damage} ${atk.damageType}`;
    }
    return { roll, total, isHit, isCrit, damage, rollStr };
  }

  // ── Private action implementations ─────────────────────────────────────────

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
    const enemies = s.npcs.filter((n) => n.disposition === 'enemy');
    for (const enemy of enemies) {
      if (chebyshev(s.player.tileX, s.player.tileY, enemy.tileX, enemy.tileY) <= 2) {
        this.doStartCombat(events);
        s.selectedTargetId = enemy.id;
        return;
      }
    }
  }

  private resolveNpcByEntity(entity: string): NpcState | undefined {
    const s = this.state;
    if (entity.startsWith('enemy_')) {
      const label = entity.slice(6);
      return s.npcs.find((n) => n.label === label && n.disposition === 'enemy');
    }
    if (entity.startsWith('ally_')) {
      const label = entity.slice(5);
      return s.npcs.find((n) => n.label === label && n.disposition === 'ally');
    }
    if (entity.startsWith('npc_')) {
      const id = entity.slice(4);
      return s.npcs.find((n) => n.id === id);
    }
    return undefined;
  }

  private assignCombatLabel(npc: NpcState): void {
    const usedLabels = new Set(this.state.npcs.filter((n) => n.disposition !== 'neutral').map((n) => n.label));
    for (let i = 0; i < 26; i++) {
      const candidate = String.fromCharCode(65 + i);
      if (!usedLabels.has(candidate)) { npc.label = candidate; return; }
    }
  }

  // Flip all neutral faction-mates of the given NPC to enemy. Uses factionId (falls back to
  // defId for NPCs created before this field existed, e.g. from old saves).
  private aggroFaction(instigator: NpcState): void {
    const factionId = instigator.factionId ?? instigator.defId;
    for (const npc of this.state.npcs) {
      if (npc === instigator) continue;
      if (npc.disposition !== 'neutral') continue;
      if ((npc.factionId ?? npc.defId) !== factionId) continue;
      npc.disposition = 'enemy';
      if (!npc.label) this.assignCombatLabel(npc);
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
    for (const npc of combatNpcs.filter((n) => !n.label)) {
      this.assignCombatLabel(npc);
    }
    s.turnOrderIds = ['player', ...combatNpcs.map((n) => n.id)];

    const { playerFirst, logs } = rollInitiative(this.playerDef, firstEnemyDef, enemies[0].name);
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
    s.player.actionUsed = false;
    s.player.bonusActionUsed = false;
    s.player.reactionUsed = false;
    s.player.conditions = s.player.conditions.filter((c) => !TURN_CONDITIONS.includes(c));
    if (hasSpeedZero(s.player.conditions)) {
      s.player.movesLeft = 0;
    } else {
      const tileSpeed = this.playerDef.speed / 5;
      const standCost = proneStandCost(s.player.conditions, tileSpeed);
      s.player.movesLeft = Math.max(0, tileSpeed - standCost);
      if (standCost > 0) s.player.conditions = s.player.conditions.filter((c) => c !== 'prone');
    }
  }

  private doAttack(targetId: string | undefined, events: GameEvent[]): void {
    const s = this.state;

    if (s.phase === 'exploring') {
      if (!targetId) return;
      const target = s.npcs.find(n => n.id === targetId && n.hp > 0 && n.disposition !== 'ally');
      if (!target) return;
      if (chebyshev(s.player.tileX, s.player.tileY, target.tileX, target.tileY) > 1) return;
      if (target.disposition === 'neutral') {
        target.disposition = 'enemy';
        if (!target.label) this.assignCombatLabel(target);
      }
      this.aggroFaction(target);
      this.doStartCombat(events);
      // Fall through: if player won initiative, phase is now player_turn with actionUsed=false
    }

    if (s.phase !== 'player_turn' || s.player.actionUsed) return;
    if (isIncapacitated(s.player.conditions)) return;

    const isAdjacent = (n: NpcState) =>
      n.disposition === 'enemy' && n.hp > 0 && chebyshev(s.player.tileX, s.player.tileY, n.tileX, n.tileY) <= 1;

    let target = targetId
      ? (s.npcs.find((n) => n.id === targetId && isAdjacent(n)) ?? null)
      : null;
    if (!target) target = s.npcs.find(isAdjacent) ?? null;
    if (!target) return;

    const targetDef = this.resolveMonsterDef(target!.defId);
    if (!targetDef) return;

    const dist = chebyshev(s.player.tileX, s.player.tileY, target.tileX, target.tileY);
    const withAdvantage = s.player.hidden || hasAttackAdvantage(s.player.conditions) || grantsAdvantageAgainst(target.conditions, dist);
    const withDisadvantage = hasAttackDisadvantage(s.player.conditions) || grantsDisadvantageAgainst(target.conditions, dist);
    const autoCrit = isAutoCrit(target.conditions, dist);
    const { damage, logs, vexApplied, slowApplied } = playerMeleeAttack(this.playerDef, targetDef, withAdvantage, withDisadvantage, autoCrit);
    s.player.hidden = false;
    this.addLogs(logs);

    const { finalDamage, log: resistLog } = this.resistMod(damage, this.playerDef.mainAttack.damageType, targetDef, target.name);
    if (resistLog) this.addLog(resistLog);
    target.hp = Math.max(0, target.hp - finalDamage);
    this.addLog({ left: `${target.name} HP: ${target.hp}/${target.maxHp}`, style: 'status' });

    if (vexApplied) {
      if (!target.conditions.includes('vexed')) target.conditions.push('vexed');
      this.addLog({ left: `Vex/Sap — ${target.name} attacks with Disadvantage`, style: 'status' });
    }
    if (slowApplied && !target.conditions.includes('slowed')) {
      target.conditions.push('slowed');
      this.addLog({ left: `Slow — ${target.name} speed reduced by 10 ft`, style: 'status' });
    }

    if (target.hp <= 0) {
      this.killWithReward(target, targetDef, `☠ ${target.name} is slain!`);
    }

    s.player.actionUsed = true;
  }

  private doThrow(itemId: string, targetId: string | undefined, events: GameEvent[]): void {
    const s = this.state;
    if (s.phase !== 'exploring' && s.phase !== 'player_turn') return;
    if (s.phase === 'player_turn' && (s.player.actionUsed || isIncapacitated(s.player.conditions))) return;

    const itemIdx = s.player.inventoryIds.indexOf(itemId);
    if (itemIdx === -1) return;

    const itemDef = this.defs.equipment.find((i) => i.id === itemId);
    if (!itemDef) return;

    const isProperThrown = itemDef.type === 'weapon' && (itemDef as WeaponDef).thrown;
    const normalRange = isProperThrown ? Math.floor((itemDef as WeaponDef).throwNormal / 5) : 4;
    const longRange = isProperThrown ? Math.floor((itemDef as WeaponDef).throwLong / 5) : 12;

    const inRange = (n: NpcState) =>
      n.hp > 0 &&
      chebyshev(s.player.tileX, s.player.tileY, n.tileX, n.tileY) <= longRange;

    if (!targetId) return;
    const target = s.npcs.find((n) => n.id === targetId && inRange(n)) ?? null;
    if (!target) return;

    // Throwing at a neutral NPC turns them and their faction hostile.
    if (target.disposition === 'neutral') {
      target.disposition = 'enemy';
      if (!target.label) this.assignCombatLabel(target);
      this.aggroFaction(target);
    }

    const targetDef = this.resolveMonsterDef(target.defId);
    if (!targetDef) return;

    const attack: PlayerAttack = isProperThrown
      ? makePlayerAttack(this.playerDef, itemDef as WeaponDef)
      : { name: itemDef.name, statKey: 'str', damageDice: 1, damageSides: 4, damageType: 'bludgeoning', savageAttacker: false, graze: false, vex: false, sap: false, slow: false };
    const profBonus = isProperThrown ? this.playerDef.proficiencyBonus : 0;

    s.player.inventoryIds.splice(itemIdx, 1);
    this.executeThrowOnTarget(attack, profBonus, normalRange, itemDef, target, targetDef);

    if (s.phase === 'exploring') this.doStartCombat(events);
    if (s.phase === 'player_turn') s.player.actionUsed = true;
  }

  throwItem(itemId: string, targetId?: string): GameEvent[] {
    const s = this.state;
    const events: GameEvent[] = [];

    if (s.phase === 'player_turn' && (s.player.actionUsed || isIncapacitated(s.player.conditions))) return events;

    const inventoryIdx = s.player.inventoryIds.indexOf(itemId);
    const mapItemIdx = inventoryIdx === -1
      ? s.mapItems.findIndex((mi) => mi.id === itemId || mi.defId === itemId)
      : -1;
    if (inventoryIdx === -1 && mapItemIdx === -1) return events;

    const defId = inventoryIdx !== -1 ? itemId : s.mapItems[mapItemIdx].defId;
    const itemDef = this.defs.equipment.find((i) => i.id === defId);
    if (!itemDef) return events;

    const fromMap = mapItemIdx !== -1;
    const isProperThrown = !fromMap && itemDef.type === 'weapon' && (itemDef as WeaponDef).thrown;
    const normalRange = isProperThrown ? Math.floor((itemDef as WeaponDef).throwNormal / 5) : 4;
    const longRange = isProperThrown ? Math.floor((itemDef as WeaponDef).throwLong / 5) : 12;

    const inRange = (n: NpcState) =>
      n.hp > 0 &&
      chebyshev(s.player.tileX, s.player.tileY, n.tileX, n.tileY) <= longRange;

    // Resolve target. Explicit targetId accepts any living NPC; fallback picks nearest in range.
    let target: NpcState | null = null;
    if (targetId) {
      if (targetId.startsWith('enemy_')) {
        const label = targetId.replace('enemy_', '');
        target = s.npcs.find((n) => n.label === label && n.hp > 0) ?? null;
      } else if (targetId.startsWith('npc_')) {
        const npcId = targetId.replace('npc_', '');
        target = s.npcs.find((n) => n.id === npcId && n.hp > 0) ?? null;
      } else {
        target = s.npcs.find((n) => (n.id === targetId || n.label === targetId) && n.hp > 0) ?? null;
      }
      // Reject if out of range.
      if (target && !inRange(target)) return events;
    }
    if (!target) target = s.npcs.filter(n => n.disposition === 'enemy').find(inRange) ?? null;
    if (!target) return events;

    // Attacking a neutral NPC turns them and their faction hostile.
    if (target.disposition === 'neutral') {
      target.disposition = 'enemy';
      if (!target.label) this.assignCombatLabel(target);
      this.aggroFaction(target);
    }

    const targetDef = this.resolveMonsterDef(target.defId);
    if (!targetDef) return events;

    const attack: PlayerAttack = isProperThrown
      ? makePlayerAttack(this.playerDef, itemDef as WeaponDef)
      : { name: itemDef.name, statKey: 'str', damageDice: 1, damageSides: 4, damageType: 'bludgeoning', savageAttacker: false, graze: false, vex: false, sap: false, slow: false };
    const profBonus = isProperThrown ? this.playerDef.proficiencyBonus : 0;

    if (fromMap) s.mapItems.splice(mapItemIdx, 1);
    else s.player.inventoryIds.splice(inventoryIdx, 1);
    this.executeThrowOnTarget(attack, profBonus, normalRange, itemDef, target, targetDef);

    if (s.phase === 'exploring') this.doStartCombat(events);
    if (s.phase === 'player_turn') s.player.actionUsed = true;

    return events;
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
    if (dying) {
      for (const defId of dying.inventoryIds) {
        s.mapItems.push({ id: uid(), defId, tileX: dying.tileX, tileY: dying.tileY });
      }
    }
    s.npcs = s.npcs.filter((n) => n.id !== id);
    s.turnOrderIds = s.turnOrderIds.filter((tid) => tid !== id);
    if (s.selectedTargetId === id) s.selectedTargetId = null;
    this.advanceQuest('kill');
    if (s.phase === 'player_turn' || s.phase === 'enemy_turn') {
      if (s.npcs.filter((n) => n.disposition === 'enemy' && n.hp > 0).length === 0) {
        s.phase = 'exploring';
      }
    }
  }

  private killWithReward(npc: NpcState, def: MonsterDef, killMessage: string, includeTotal = true): void {
    const s = this.state;
    s.player.xp += def.xp;
    const logs: LogEntry[] = [{ left: `${killMessage} +${def.xp} XP`, style: 'kill' }];
    if (includeTotal) logs.push({ left: `Total XP: ${s.player.xp}`, style: 'status' });
    this.addLogs(logs);
    this.killNpc(npc.id);
  }

  private executeThrowOnTarget(
    attack: PlayerAttack,
    profBonus: number,
    normalRange: number,
    itemDef: ItemDef,
    target: NpcState,
    targetDef: MonsterDef,
  ): void {
    const s = this.state;
    const dist = chebyshev(s.player.tileX, s.player.tileY, target.tileX, target.tileY);
    const adjacentEnemy = s.npcs.some((n) =>
      n.disposition === 'enemy' && n.hp > 0 &&
      chebyshev(s.player.tileX, s.player.tileY, n.tileX, n.tileY) <= 1);
    const withAdvantage = s.player.hidden || grantsAdvantageAgainst(target.conditions, dist);
    const withDisadvantage = dist > normalRange || grantsDisadvantageAgainst(target.conditions, dist)
      || hasAttackDisadvantage(s.player.conditions) || adjacentEnemy;
    const autoCrit = isAutoCrit(target.conditions, dist);
    this.addLog({ left: `${this.playerDef.name} throws ${itemDef.name}`, style: 'normal' });
    const { damage, isHit, logs, vexApplied, slowApplied } = playerThrowAttack(
      this.playerDef, attack, targetDef, withAdvantage, withDisadvantage, profBonus, autoCrit,
    );
    s.player.hidden = false;
    this.addLogs(logs);

    if (isHit) {
      target.inventoryIds.push(itemDef.id);
    } else {
      s.mapItems.push({ id: uid(), defId: itemDef.id, tileX: target.tileX, tileY: target.tileY });
    }

    const { finalDamage, log: resistLog } = this.resistMod(damage, attack.damageType, targetDef, target.name);
    if (resistLog) this.addLog(resistLog);
    target.hp = Math.max(0, target.hp - finalDamage);
    this.addLog({ left: `${target.name} HP: ${target.hp}/${target.maxHp}`, style: 'status' });
    if (vexApplied) {
      if (!target.conditions.includes('vexed')) target.conditions.push('vexed');
      this.addLog({ left: `Vex/Sap — ${target.name} attacks with Disadvantage`, style: 'status' });
    }
    if (slowApplied && !target.conditions.includes('slowed')) {
      target.conditions.push('slowed');
      this.addLog({ left: `Slow — ${target.name} speed reduced by 10 ft`, style: 'status' });
    }
    if (target.hp <= 0) {
      this.killWithReward(target, targetDef, `☠ ${target.name} is slain!`);
    }
  }

  private doHide(_events: GameEvent[]): void {
    const s = this.state;
    if (s.phase !== 'player_turn' || s.player.bonusActionUsed) return;
    if (isIncapacitated(s.player.conditions)) return;
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
    if (isIncapacitated(s.player.conditions)) return;
    s.player.movesLeft += this.playerDef.speed / 5;
    s.player.conditions.push('dashing');
    s.player.actionUsed = true;
    this.addLog({ left: `${this.playerDef.name} Dashes — +${this.playerDef.speed / 5} tiles movement`, style: 'status' });
  }

  private doDodge(_events: GameEvent[]): void {
    const s = this.state;
    if (s.phase !== 'player_turn' || s.player.actionUsed) return;
    if (isIncapacitated(s.player.conditions)) return;
    s.player.conditions.push('dodging');
    s.player.actionUsed = true;
    this.addLog({ left: `${this.playerDef.name} Dodges — enemies attack with Disadvantage`, style: 'status' });
  }

  private doDisengage(_events: GameEvent[]): void {
    const s = this.state;
    if (s.phase !== 'player_turn' || s.player.actionUsed) return;
    if (isIncapacitated(s.player.conditions)) return;
    s.player.conditions.push('disengaged');
    s.player.actionUsed = true;
    this.addLog({ left: `${this.playerDef.name} Disengages — no Opportunity Attacks this turn`, style: 'status' });
  }

  private doSecondWind(_events: GameEvent[]): void {
    const s = this.state;
    if (s.phase !== 'player_turn' || s.player.bonusActionUsed || s.player.secondWindUses <= 0 || s.player.hp >= this.playerDef.maxHp) return;
    if (isIncapacitated(s.player.conditions)) return;
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
        playerDodging: s.player.conditions.includes('dodging'),
        playerInvisible: s.player.conditions.includes('invisible'),
        passivePerception: 10 + (this.playerDef.skills['perception'] ?? 0),
        passable: s.map.passable,
        mapCols: s.map.cols,
        mapRows: s.map.rows,
        occupiedTiles: occupied,
      });

      const endedAdjacentToPlayer = chebyshev(result.finalTileX, result.finalTileY, s.player.tileX, s.player.tileY) <= 1;

      npc.tileX = result.finalTileX;
      npc.tileY = result.finalTileY;
      if (result.hidden) {
        if (!npc.conditions.includes('hidden')) npc.conditions.push('hidden');
      } else {
        npc.conditions = npc.conditions.filter(c => c !== 'hidden');
      }
      npc.conditions = npc.conditions.filter((c) => c !== 'vexed');
      if (!isIncapacitated(npc.conditions)) {
        npc.conditions = npc.conditions.filter((c) => c !== 'prone');
      }
      events.push(...result.events);

      if (startedAdjacentToPlayer && !endedAdjacentToPlayer && !result.attacked) {
        this.doPlayerOpportunityAttack(npc, events);
      }

      this.addLogs(result.logs);

      if (result.attacked && result.isHit) {
        if (s.player.hp <= 0) {
          const adjacentToPlayer = chebyshev(result.finalTileX, result.finalTileY, s.player.tileX, s.player.tileY) <= 1;
          const effectivelyCrit = result.isCrit || adjacentToPlayer;
          const failures = effectivelyCrit ? 2 : 1;
          s.player.deathSaveFailures = Math.min(3, s.player.deathSaveFailures + failures);
          this.addLogs([
            { left: `Strikes unconscious ${this.playerDef.name}!${effectivelyCrit ? ' CRITICAL — 2 failures!' : ' 1 failure.'}`, style: 'status' },
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
              const { finalDamage, log: resistLog } = this.resistMod(result.damage, meleeAttack?.damageType ?? '', targetDef, target.name);
              if (resistLog) this.addLog(resistLog);
              target.hp = Math.max(0, target.hp - finalDamage);
              this.addLog({ left: `${target.name} HP: ${target.hp}/${target.maxHp}`, style: 'status' });
              if (target.hp <= 0) {
                this.killWithReward(target, targetDef, `☠ ${target.name} is slain!`);
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
        if (s.player.deathSaveSuccesses >= 3) {
          s.player.hp = 1;
          s.player.deathSaveSuccesses = 0;
          s.player.deathSaveFailures = 0;
          logs.push({ left: `${this.playerDef.name} stabilizes and regains consciousness with 1 HP!`, style: 'heal' });
          nextPhase = 'player_turn';
        } else {
          nextPhase = 'enemy_turn';
        }
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
      s.player.movesLeft = this.playerDef.speed / 5;
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

  private doUsePotion(_events: GameEvent[]): void {
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

  private doEnemyOpportunityAttack(npc: NpcState, events: GameEvent[]): void {
    const s = this.state;
    const def = this.resolveMonsterDef(npc.defId);
    if (!def) return;
    const meleeAttack = def.attacks.find((a) => a.attackType === 'melee' || a.attackType === 'both');
    if (!meleeAttack) return;
    npc.reactionUsed = true;
    const withDisadvantage = s.player.conditions.includes('dodging');
    const { damage, isHit, isCrit, logs } = enemyAttack(def, meleeAttack, this.playerDef.ac, false, withDisadvantage);
    this.addLogs([{ left: `⚡ ${npc.name} makes an Opportunity Attack!`, style: 'header' }, ...logs]);
    if (isHit) {
      this.applyDamageToPlayer(damage, events);
    }
    void isCrit;
  }

  private doPlayerOpportunityAttack(npc: NpcState, _events: GameEvent[]): void {
    const s = this.state;
    if (s.player.reactionUsed || s.player.hp <= 0) return;
    if (isIncapacitated(s.player.conditions)) return;
    const targetDef = this.resolveMonsterDef(npc.defId);
    if (!targetDef) return;
    s.player.reactionUsed = true;
    const dist = chebyshev(s.player.tileX, s.player.tileY, npc.tileX, npc.tileY);
    const oaAutoCrit = isAutoCrit(npc.conditions, dist);
    const { damage, logs, vexApplied, slowApplied } = playerMeleeAttack(this.playerDef, targetDef, false, false, oaAutoCrit);
    this.addLogs([{ left: `⚡ ${this.playerDef.name} makes an Opportunity Attack!`, style: 'header' }, ...logs]);
    const { finalDamage: oaFinalDamage, log: oaResistLog } = this.resistMod(damage, this.playerDef.mainAttack.damageType, targetDef, npc.name);
    if (oaResistLog) this.addLog(oaResistLog);
    npc.hp = Math.max(0, npc.hp - oaFinalDamage);
    this.addLog({ left: `${npc.name} HP: ${npc.hp}/${npc.maxHp}`, style: 'status' });
    if (vexApplied && !npc.conditions.includes('vexed')) npc.conditions.push('vexed');
    if (slowApplied && !npc.conditions.includes('slowed')) npc.conditions.push('slowed');
    if (npc.hp <= 0) {
      this.killWithReward(npc, targetDef, `☠ ${npc.name} slain by Opportunity Attack!`, false);
    }
  }

  private doShortRest(_events: GameEvent[]): void {
    const s = this.state;
    if (s.phase !== 'exploring') return;
    if (s.player.hp <= 0) return;
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
      hidden: false,
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
    };

    const sessionDefs: GameDefs = {
      ...defs,
      playerDefs: defs.playerDefs.map((p) => p.id === ownedDef.id ? ownedDef : p),
    };

    return new GameEngine(state, sessionDefs);
  }
}

