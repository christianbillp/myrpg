import { PlayerDef } from '../data/player';
import { Enemy } from '../entities/Enemy';
import {
  rollInitiative,
  playerMeleeAttack,
  playerHide,
  playerSecondWind,
  rollDeathSave,
} from './CombatSystem';

export type CombatMode = 'exploring' | 'player_turn' | 'enemy_turn' | 'death_saves' | 'defeat';

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

export class CombatManager {
  mode: CombatMode = 'exploring';
  playerHp: number;
  playerXp: number;
  secondWindUses: number;
  playerHidden = false;
  enemyVexed = false;
  enemyHidden = false;
  deathSaveSuccesses = 0;
  deathSaveFailures = 0;
  activeEnemy: Enemy | null = null;
  combatLog: string[] = [];
  logScrollOffset = 0;
  movesLeft = 0;

  readonly playerDef: PlayerDef;
  private readonly onChange: () => void;
  private readonly onEnemyTurn: (delay: number) => void;
  private readonly onEnemyKilled: (enemy: Enemy) => void;

  constructor(
    playerDef: PlayerDef,
    onChange: () => void,
    onEnemyTurn: (delay: number) => void,
    onEnemyKilled: (enemy: Enemy) => void,
  ) {
    this.playerDef = playerDef;
    this.playerHp = playerDef.maxHp;
    this.playerXp = playerDef.xp;
    this.secondWindUses = playerDef.secondWindMaxUses;
    this.onChange = onChange;
    this.onEnemyTurn = onEnemyTurn;
    this.onEnemyKilled = onEnemyKilled;
  }

  startCombat(enemy: Enemy): void {
    this.activeEnemy = enemy;
    this.enemyHidden = false;
    this.enemyVexed = false;
    this.playerHidden = false;
    this.deathSaveSuccesses = 0;
    this.deathSaveFailures = 0;

    const { playerFirst, logs } = rollInitiative(this.playerDef, enemy.def);
    this.addLogs(logs);

    if (playerFirst) {
      this.enterPlayerTurn();
    } else {
      this.mode = 'enemy_turn';
      this.onChange();
      this.onEnemyTurn(ENEMY_TURN_DELAY.init);
    }
  }

  enterPlayerTurn(): void {
    this.mode = 'player_turn';
    this.movesLeft = this.playerDef.speed;
    this.onChange();
  }

  onAttack(): void {
    if (!this.activeEnemy || this.mode !== 'player_turn') return;

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
      this.playerXp += this.activeEnemy.def.xp;
      this.addLogs([
        `☠ ${this.activeEnemy.def.name} is slain! +${this.activeEnemy.def.xp} XP`,
        `Total XP: ${this.playerXp}`,
      ]);
      const killed = this.activeEnemy;
      this.activeEnemy = null;
      this.enemyVexed = false;
      this.mode = 'exploring';
      this.onEnemyKilled(killed);
      this.onChange();
      return;
    }

    this.mode = 'enemy_turn';
    this.onChange();
    this.onEnemyTurn(ENEMY_TURN_DELAY.attack);
  }

  onHide(): void {
    if (this.mode !== 'player_turn' || !this.activeEnemy) return;

    const { hidden, logs } = playerHide(this.playerDef, this.activeEnemy.def.passivePerception);
    this.playerHidden = hidden;
    this.addLogs(logs);
    this.mode = 'enemy_turn';
    this.onChange();
    this.onEnemyTurn(ENEMY_TURN_DELAY.hide);
  }

  onSecondWind(): void {
    if (this.mode !== 'player_turn' || this.secondWindUses <= 0 || this.playerHp >= this.playerDef.maxHp) return;

    const { healed, logs } = playerSecondWind(this.playerDef.level);
    const before = this.playerHp;
    this.playerHp = Math.min(this.playerDef.maxHp, this.playerHp + healed);
    this.secondWindUses--;
    this.addLogs([...logs, `HP: ${before} → ${this.playerHp}/${this.playerDef.maxHp} (${this.secondWindUses} uses left)`]);
    this.onChange();
  }

  onEndTurn(): void {
    if (this.mode !== 'player_turn') return;
    this.mode = 'enemy_turn';
    this.onChange();
    this.onEnemyTurn(ENEMY_TURN_DELAY.endTurn);
  }

  onDeathSave(): void {
    if (this.mode !== 'death_saves') return;

    const { roll, outcome } = rollDeathSave();
    const logs: string[] = [`${this.playerDef.name} death save: d20 = ${roll}`];
    let nextMode: CombatMode = 'death_saves';

    switch (outcome) {
      case 'nat20':
        this.playerHp = 1;
        this.deathSaveSuccesses = 0;
        this.deathSaveFailures = 0;
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
    this.mode = nextMode;

    if (nextMode === 'player_turn') {
      this.movesLeft = this.playerDef.speed;
    }

    this.onChange();

    if (nextMode === 'enemy_turn') {
      this.onEnemyTurn(ENEMY_TURN_DELAY.deathSave);
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

  addLogs(lines: string[]): void {
    this.combatLog.push(...lines);
    this.logScrollOffset = 0;
  }

  scrollLog(delta: number): void {
    const maxOffset = Math.max(0, this.combatLog.length - 6);
    this.logScrollOffset = Math.max(0, Math.min(maxOffset, this.logScrollOffset + delta));
  }

  private endEnemyTurn(): void {
    if (this.mode === 'defeat') return;
    this.playerHidden = false;
    if (this.playerHp <= 0) {
      this.mode = 'death_saves';
      this.onChange();
    } else {
      this.enterPlayerTurn();
    }
  }
}
