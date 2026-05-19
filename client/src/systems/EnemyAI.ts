import { GRID_COLS, GRID_ROWS } from '../constants';
import { Enemy } from '../entities/Enemy';
import { tryNimbleEscape, enemyAttack } from './CombatSystem';
import { EnemyTurnResult } from './CombatManager';
import { EnemyAttack } from '../data/enemies';

export interface EnemyTurnConfig {
  playerTileX: number;
  playerTileY: number;
  playerAc: number;
  playerHp: number;
  playerHidden: boolean;
  enemyVexed: boolean;
  enemyCurrentlyHidden: boolean;
  passivePerception: number;
}

export class EnemyAI {
  static runTurn(
    enemy: Enemy,
    config: EnemyTurnConfig,
    onDone: (result: EnemyTurnResult) => void,
  ): void {
    const logs: string[] = [`--- ${enemy.def.name}'s turn ---`];
    let enemyHidden = config.enemyCurrentlyHidden;

    const belowHalf = enemy.hp <= enemy.maxHp / 2;
    if (!enemyHidden && (belowHalf || Math.random() < 0.3)) {
      const { hidden, logs: hideLogs } = tryNimbleEscape(enemy.def, config.passivePerception);
      logs.push(...hideLogs);
      enemyHidden = hidden;
    }

    EnemyAI.moveStep(enemy, enemy.def.speed, config, () => {
      const dist = chebyshev(enemy.tileX, enemy.tileY, config.playerTileX, config.playerTileY);

      if (dist > 1) {
        logs.push(`${enemy.def.name} is too far to attack.`);
        onDone({ damage: 0, isHit: false, isCrit: false, attacked: false, logs });
        return;
      }

      const meleeAttack = EnemyAI.primaryMeleeAttack(enemy.def.attacks);
      if (!meleeAttack) {
        logs.push(`${enemy.def.name} has no melee attack.`);
        onDone({ damage: 0, isHit: false, isCrit: false, attacked: false, logs });
        return;
      }
      const withAdvantage = enemyHidden;
      const withDisadvantage = config.playerHidden || config.enemyVexed;
      const { damage, isHit, isCrit, logs: attackLogs } = enemyAttack(
        enemy.def,
        meleeAttack,
        config.playerAc,
        withAdvantage,
        withDisadvantage,
      );
      logs.push(...attackLogs);
      onDone({ damage, isHit, isCrit, attacked: true, logs });
    });
  }

  private static primaryMeleeAttack(attacks: EnemyAttack[]): EnemyAttack | undefined {
    return attacks.find(a => a.attackType === 'melee' || a.attackType === 'both');
  }

  private static moveStep(
    enemy: Enemy,
    stepsLeft: number,
    config: EnemyTurnConfig,
    onDone: () => void,
  ): void {
    if (stepsLeft <= 0 || chebyshev(enemy.tileX, enemy.tileY, config.playerTileX, config.playerTileY) <= 1) {
      onDone();
      return;
    }

    const absDx = Math.abs(config.playerTileX - enemy.tileX);
    const absDy = Math.abs(config.playerTileY - enemy.tileY);
    const stepX = absDx >= absDy ? Math.sign(config.playerTileX - enemy.tileX) : 0;
    const stepY = absDx < absDy ? Math.sign(config.playerTileY - enemy.tileY) : 0;
    const tx = enemy.tileX + stepX;
    const ty = enemy.tileY + stepY;

    if (tx < 0 || ty < 0 || tx >= GRID_COLS || ty >= GRID_ROWS) { onDone(); return; }
    if (tx === config.playerTileX && ty === config.playerTileY) { onDone(); return; }

    enemy.moveTo(tx, ty, () => {
      EnemyAI.moveStep(enemy, stepsLeft - 1, config, onDone);
    });
  }
}

export function chebyshev(x1: number, y1: number, x2: number, y2: number): number {
  return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2));
}
