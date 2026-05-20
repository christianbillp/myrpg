import { Enemy } from '../entities/Enemy';
import { tryNimbleEscape, enemyAttack } from './CombatSystem';
import { EnemyTurnResult } from './EncounterManager';
import { MonsterAttack } from '../data/monsters';

export interface EnemyTurnConfig {
  playerTileX: number;
  playerTileY: number;
  playerAc: number;
  playerHp: number;
  playerHidden: boolean;
  enemyVexed: boolean;
  enemyCurrentlyHidden: boolean;
  passivePerception: number;
  passable: boolean[][];
  mapCols: number;
  mapRows: number;
  occupiedTiles: [number, number][];
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

    EnemyAI.moveSteps(enemy, enemy.def.speed, config, () => {
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

  private static primaryMeleeAttack(attacks: MonsterAttack[]): MonsterAttack | undefined {
    return attacks.find(a => a.attackType === 'melee' || a.attackType === 'both');
  }

  private static moveSteps(
    enemy: Enemy,
    stepsLeft: number,
    config: EnemyTurnConfig,
    onDone: () => void,
  ): void {
    if (stepsLeft <= 0 || chebyshev(enemy.tileX, enemy.tileY, config.playerTileX, config.playerTileY) <= 1) {
      onDone();
      return;
    }

    const next = EnemyAI.nextStepToward(
      enemy.tileX, enemy.tileY,
      config.playerTileX, config.playerTileY,
      config.passable, config.mapRows, config.mapCols,
      config.occupiedTiles,
    );

    if (!next || (next[0] === config.playerTileX && next[1] === config.playerTileY)) {
      onDone();
      return;
    }

    enemy.moveTo(next[0], next[1], () => {
      EnemyAI.moveSteps(enemy, stepsLeft - 1, config, onDone);
    });
  }

  private static nextStepToward(
    fromX: number,
    fromY: number,
    targetX: number,
    targetY: number,
    passable: boolean[][],
    rows: number,
    cols: number,
    occupiedTiles: [number, number][],
  ): [number, number] | null {
    if (chebyshev(fromX, fromY, targetX, targetY) <= 1) return null;

    const visited: boolean[][] = Array.from({ length: rows }, () =>
      new Array<boolean>(cols).fill(false),
    );
    const firstStep: ([number, number] | null)[][] = Array.from({ length: rows }, () =>
      new Array<[number, number] | null>(cols).fill(null),
    );

    visited[fromY][fromX] = true;
    const queue: [number, number][] = [[fromY, fromX]];
    const dirs: [number, number][] = [[0, 1], [0, -1], [1, 0], [-1, 0]];

    while (queue.length > 0) {
      const [cy, cx] = queue.shift()!;
      for (const [dr, dc] of dirs) {
        const ny = cy + dr, nx = cx + dc;
        if (ny < 0 || ny >= rows || nx < 0 || nx >= cols) continue;
        if (!passable[ny][nx]) continue;
        if (visited[ny][nx]) continue;
        if (occupiedTiles.some(([ox, oy]) => ox === nx && oy === ny)) continue;
        visited[ny][nx] = true;
        firstStep[ny][nx] = firstStep[cy][cx] !== null ? firstStep[cy][cx] : [nx, ny];
        if (chebyshev(nx, ny, targetX, targetY) <= 1) return firstStep[ny][nx]!;
        queue.push([ny, nx]);
      }
    }
    return null;
  }
}

export function chebyshev(x1: number, y1: number, x2: number, y2: number): number {
  return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2));
}
