import { PlayerDef, EquipmentSlots } from '../data/player';
import { Enemy } from '../entities/Enemy';
import { ItemDef, WeaponDef } from '../data/items';
import { applyEquipment } from './EquipmentSystem';

function crGoldReward(cr: string): number {
  if (cr.includes('/')) {
    const [num, den] = cr.split('/').map(Number);
    return Math.floor(10 * num / den);
  }
  return 10 * Number(cr);
}
import {
  rollInitiative,
  playerMeleeAttack,
  playerHide,
  playerSecondWind,
  drinkPotion,
  rollDeathSave,
} from './CombatSystem';

export type CombatMode = 'exploring' | 'player_turn' | 'enemy_turn' | 'death_saves' | 'defeat';

export interface ResumeState {
  hp: number;
  xp: number;
  gold: number;
  inventory: ItemDef[];
  secondWindUses: number;
  equippedSlots: EquipmentSlots;
}

export interface EnemyTurnResult {
  damage: number;
  isHit: boolean;
  isCrit: boolean;
  attacked: boolean;
  logs: string[];
}

const ENEMY_TURN_DELAY: Record<string, number> = {
  init: 800,
  attack: 900,
  hide: 600,
  endTurn: 600,
  deathSave: 900,
};

export class EncounterManager {
  mode: CombatMode = 'exploring';
  playerHp: number;
  playerXp: number;
  secondWindUses: number;
  inventory: ItemDef[] = [];
  equippedSlots: EquipmentSlots;
  playerGold = 0;
  playerHidden = false;
  enemyVexed = false;
  enemyHidden = false;
  deathSaveSuccesses = 0;
  deathSaveFailures = 0;
  activeEnemy: Enemy | null = null;
  combatEnemies: Enemy[] = [];
  combatLog: string[] = [];
  logScrollOffset = 0;
  movesLeft = 0;
  actionUsed = false;
  bonusActionUsed = false;

  readonly playerDef: PlayerDef;
  private readonly onChange: () => void;
  private readonly onEnemyTurn: (delay: number) => void;
  private readonly onEnemyKilled: (enemy: Enemy) => void;
  private activeEnemyIndex = 0;

  constructor(
    playerDef: PlayerDef,
    onChange: () => void,
    onEnemyTurn: (delay: number) => void,
    onEnemyKilled: (enemy: Enemy) => void,
    resume?: ResumeState,
  ) {
    this.playerDef = playerDef;
    this.playerHp = resume?.hp ?? playerDef.maxHp;
    this.playerXp = resume?.xp ?? playerDef.xp;
    this.playerGold = resume?.gold ?? 0;
    this.inventory = resume?.inventory ?? [];
    this.secondWindUses = resume?.secondWindUses ?? playerDef.secondWindMaxUses;
    this.equippedSlots = resume?.equippedSlots ?? { ...playerDef.defaultEquipment };
    this.onChange = onChange;
    this.onEnemyTurn = onEnemyTurn;
    this.onEnemyKilled = onEnemyKilled;
  }

  equip(slot: 'armor' | 'weapon' | 'shield', itemId: string, allItems: ItemDef[]): void {
    const item = this.inventory.find((i) => i.id === itemId);
    if (!item) return;

    const slotKey = `${slot}Id` as keyof EquipmentSlots;

    if (slot === 'shield') {
      const weapon = allItems.find((i) => i.id === this.equippedSlots.weaponId) as WeaponDef | undefined;
      if (weapon?.twoHanded) return;
    }
    if (slot === 'weapon') {
      const incoming = allItems.find((i) => i.id === itemId) as WeaponDef | undefined;
      if (incoming?.twoHanded && this.equippedSlots.shieldId) {
        this.inventory.push(allItems.find((i) => i.id === this.equippedSlots.shieldId)!);
        this.equippedSlots.shieldId = null;
      }
    }

    const currentId = this.equippedSlots[slotKey];
    if (currentId) {
      const currentItem = allItems.find((i) => i.id === currentId);
      if (currentItem) this.inventory.push(currentItem);
    }

    const removeIdx = this.inventory.findIndex((i) => i.id === itemId);
    if (removeIdx !== -1) this.inventory.splice(removeIdx, 1);
    this.equippedSlots[slotKey] = itemId;
    applyEquipment(this.playerDef, this.equippedSlots, allItems);
    this.onChange();
  }

  unequip(slot: 'armor' | 'weapon' | 'shield', allItems: ItemDef[]): void {
    const slotKey = `${slot}Id` as keyof EquipmentSlots;
    const currentId = this.equippedSlots[slotKey];
    if (!currentId) return;
    const item = allItems.find((i) => i.id === currentId);
    if (item) this.inventory.push(item);
    this.equippedSlots[slotKey] = null;
    applyEquipment(this.playerDef, this.equippedSlots, allItems);
    this.onChange();
  }

  addItem(item: ItemDef): void {
    this.inventory.push(item);
    this.addLogs([`Picked up ${item.name}!`]);
    this.onChange();
  }

  removeItem(itemId: string): boolean {
    const idx = this.inventory.findIndex((i) => i.id === itemId);
    if (idx === -1) return false;
    this.inventory.splice(idx, 1);
    this.onChange();
    return true;
  }

  usePotion(): void {
    const idx = this.inventory.findIndex(i => i.type === 'consumable');
    if (idx === -1) return;
    if (this.mode === 'player_turn' && this.bonusActionUsed) return;
    if (this.mode !== 'player_turn' && this.mode !== 'exploring') return;
    const item = this.inventory.splice(idx, 1)[0];
    const { healed, logs } = drinkPotion(item as import('../data/items').ConsumableDef);
    const before = this.playerHp;
    this.playerHp = Math.min(this.playerDef.maxHp, this.playerHp + healed);
    this.addLogs([...logs, `HP: ${before} → ${this.playerHp}/${this.playerDef.maxHp}`]);
    if (this.mode === 'player_turn') this.bonusActionUsed = true;
    this.onChange();
  }

  startCombat(enemies: Enemy[]): void {
    this.combatEnemies = [...enemies];
    this.activeEnemy = enemies[0] ?? null;
    this.enemyHidden = false;
    this.enemyVexed = false;
    this.playerHidden = false;
    this.deathSaveSuccesses = 0;
    this.deathSaveFailures = 0;

    const { playerFirst, logs } = rollInitiative(this.playerDef, enemies[0].def);
    this.addLogs(logs);

    if (playerFirst) {
      this.enterPlayerTurn();
    } else {
      this.enterEnemyPhase(ENEMY_TURN_DELAY.init);
    }
  }

  enterPlayerTurn(): void {
    this.mode = 'player_turn';
    this.activeEnemy = null;
    this.movesLeft = this.playerDef.speed;
    this.actionUsed = false;
    this.bonusActionUsed = false;
    this.onChange();
  }

  onAttack(): void {
    if (!this.activeEnemy || this.mode !== 'player_turn' || this.actionUsed) return;

    const { damage, logs, vexApplied } = playerMeleeAttack(
      this.playerDef,
      this.activeEnemy.def,
      this.playerHidden,
    );
    this.playerHidden = false;
    this.addLogs(logs);
    this.activeEnemy.takeDamage(damage);
    this.addLogs([`${this.activeEnemy.def.name} HP: ${this.activeEnemy.hp}/${this.activeEnemy.maxHp}`]);

    if (vexApplied) {
      this.enemyVexed = true;
      this.addLogs([`Vex! ${this.activeEnemy.def.name} has Disadvantage on its next attack.`]);
    }

    if (this.activeEnemy.isDead()) {
      const gold = crGoldReward(this.activeEnemy.def.cr);
      this.playerXp += this.activeEnemy.def.xp;
      this.playerGold += gold;
      this.addLogs([
        `☠ ${this.activeEnemy.def.name} is slain! +${this.activeEnemy.def.xp} XP  +${gold} GP`,
        `Total XP: ${this.playerXp}  |  GP: ${this.playerGold}`,
      ]);
      const killed = this.activeEnemy;
      this.combatEnemies = this.combatEnemies.filter(e => e !== killed);
      this.activeEnemy = null;
      this.enemyVexed = false;
      this.onEnemyKilled(killed);

      if (this.combatEnemies.every(e => e.isDead())) {
        this.mode = 'exploring';
        this.onChange();
        return;
      }
    }

    this.actionUsed = true;
    this.onChange();
  }

  onHide(): void {
    if (this.mode !== 'player_turn' || this.bonusActionUsed) return;
    const target = this.combatEnemies.find(e => !e.isDead()) ?? null;
    if (!target) return;
    const { hidden, logs } = playerHide(this.playerDef, target.def.passivePerception);
    this.playerHidden = hidden;
    this.addLogs(logs);
    this.bonusActionUsed = true;
    this.onChange();
  }

  onSecondWind(): void {
    if (this.mode !== 'player_turn' || this.bonusActionUsed || this.secondWindUses <= 0 || this.playerHp >= this.playerDef.maxHp) return;

    const { healed, logs } = playerSecondWind(this.playerDef.level);
    const before = this.playerHp;
    this.playerHp = Math.min(this.playerDef.maxHp, this.playerHp + healed);
    this.secondWindUses--;
    this.addLogs([...logs, `HP: ${before} → ${this.playerHp}/${this.playerDef.maxHp} (${this.secondWindUses} uses left)`]);
    this.bonusActionUsed = true;
    this.onChange();
  }

  onEndTurn(): void {
    if (this.mode !== 'player_turn') return;
    this.enterEnemyPhase(ENEMY_TURN_DELAY.endTurn);
  }

  onDeathSave(): void {
    if (this.mode !== 'death_saves') return;

    const { roll, outcome } = rollDeathSave();
    const logs: string[] = [`${this.playerDef.name} death save: d20 = ${roll}`];
    let nextMode: CombatMode = 'death_saves';

    switch (outcome) {
      case 'nat20':
        this.playerHp = 1;
        logs.push(`Natural 20! ${this.playerDef.name} regains 1 HP!`);
        nextMode = 'player_turn';
        break;

      case 'nat1':
        this.deathSaveFailures = Math.min(3, this.deathSaveFailures + 2);
        logs.push(`Natural 1! Two failures. (${this.deathSaveFailures}/3)`);
        nextMode = this.deathSaveFailures >= 3 ? 'defeat' : 'enemy_turn';
        if (nextMode === 'defeat') logs.push(`${this.playerDef.name} has died.`);
        break;

      case 'success':
        this.deathSaveSuccesses++;
        logs.push(`Success! (${this.deathSaveSuccesses}/3)`);
        if (this.deathSaveSuccesses >= 3) {
          logs.push(`${this.playerDef.name} stabilizes.`);
          nextMode = 'defeat';
        } else {
          nextMode = 'enemy_turn';
        }
        break;

      case 'failure':
        this.deathSaveFailures++;
        logs.push(`Failure! (${this.deathSaveFailures}/3)`);
        nextMode = this.deathSaveFailures >= 3 ? 'defeat' : 'enemy_turn';
        if (nextMode === 'defeat') logs.push(`${this.playerDef.name} has died.`);
        break;
    }

    this.addLogs(logs);

    if (nextMode === 'player_turn') {
      this.movesLeft = this.playerDef.speed;
      this.mode = 'player_turn';
      this.onChange();
    } else if (nextMode === 'enemy_turn') {
      this.enterEnemyPhase(ENEMY_TURN_DELAY.deathSave);
    } else {
      this.mode = nextMode;
      this.onChange();
    }
  }

  applyEnemyTurnResult(result: EnemyTurnResult): void {
    this.addLogs(result.logs);
    this.enemyVexed = false;
    this.enemyHidden = false;

    if (!result.attacked) {
      this.endEnemyTurn();
      return;
    }

    if (result.isHit) {
      if (this.playerHp <= 0) {
        const failures = result.isCrit ? 2 : 1;
        this.deathSaveFailures = Math.min(3, this.deathSaveFailures + failures);
        this.addLogs([
          `Strikes unconscious ${this.playerDef.name}!${result.isCrit ? ' CRITICAL — 2 failures!' : ' 1 failure.'}`,
          `Death saves: ${this.deathSaveSuccesses} ✓  ${this.deathSaveFailures} ✗`,
        ]);
        if (this.deathSaveFailures >= 3) {
          this.addLogs([`${this.playerDef.name} has died.`]);
          this.mode = 'defeat';
          this.onChange();
          return;
        }
        this.mode = 'death_saves';
        this.onChange();
        return;
      }

      this.playerHp = Math.max(0, this.playerHp - result.damage);
      this.addLogs([`${this.playerDef.name} HP: ${this.playerHp}/${this.playerDef.maxHp}`]);

      if (this.playerHp <= 0) {
        this.addLogs([`${this.playerDef.name} falls unconscious!`]);
        this.mode = 'death_saves';
        this.onChange();
        return;
      }
    }

    this.endEnemyTurn();
  }

  awardXP(amount: number): void {
    this.playerXp += amount;
    this.onChange();
  }

  awardGold(amount: number): void {
    this.playerGold += amount;
    this.onChange();
  }

  adjustPlayerHp(delta: number): void {
    const before = this.playerHp;
    this.playerHp = Math.max(0, Math.min(this.playerDef.maxHp, this.playerHp + delta));
    this.addLogs([`HP: ${before} → ${this.playerHp}/${this.playerDef.maxHp}`]);
    if (this.playerHp <= 0 && this.mode === 'exploring') this.mode = 'defeat';
    this.onChange();
  }

  setPlayerHidden(hidden: boolean): void {
    this.playerHidden = hidden;
    this.onChange();
  }

  addCombatant(enemy: Enemy): void {
    if (this.mode !== 'exploring') {
      this.combatEnemies.push(enemy);
    }
    this.onChange();
  }

  endCombat(): void {
    this.mode = 'exploring';
    this.activeEnemy = null;
    this.combatEnemies = [];
    this.enemyVexed = false;
    this.enemyHidden = false;
    this.playerHidden = false;
    this.onChange();
  }

  addLogs(lines: string[]): void {
    this.combatLog.push(...lines);
    this.logScrollOffset = 0;
  }

  scrollLog(delta: number): void {
    const maxOffset = Math.max(0, this.combatLog.length - 6);
    this.logScrollOffset = Math.max(0, Math.min(maxOffset, this.logScrollOffset + delta));
  }

  private enterEnemyPhase(delay: number): void {
    this.mode = 'enemy_turn';
    this.activeEnemyIndex = 0;
    this.onChange();
    this.scheduleNextEnemy(delay);
  }

  private scheduleNextEnemy(delay: number): void {
    while (this.activeEnemyIndex < this.combatEnemies.length) {
      const enemy = this.combatEnemies[this.activeEnemyIndex];
      if (!enemy.isDead()) {
        this.activeEnemy = enemy;
        this.onChange();
        this.onEnemyTurn(delay);
        return;
      }
      this.activeEnemyIndex++;
    }
    this.activeEnemy = null;
    this.activeEnemyIndex = 0;
    this.enterPlayerTurn();
  }

  private endEnemyTurn(): void {
    if (this.mode === 'defeat') return;
    this.playerHidden = false;
    if (this.playerHp <= 0) {
      this.mode = 'death_saves';
      this.onChange();
      return;
    }
    this.activeEnemyIndex++;
    this.scheduleNextEnemy(ENEMY_TURN_DELAY.attack);
  }
}
