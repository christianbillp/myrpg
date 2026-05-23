import { EnemyState, MonsterDef, GameEvent, LogEntry } from './types.js';
import { tryNimbleEscape, enemyAttack } from './CombatSystem.js';

export interface EnemyTurnConfig {
  playerTileX: number;
  playerTileY: number;
  playerAc: number;
  playerHp: number;
  playerHidden: boolean;
  playerDodging: boolean;
  enemyVexed: boolean;
  enemyCurrentlyHidden: boolean;
  passivePerception: number;
  passable: boolean[][];
  mapCols: number;
  mapRows: number;
  occupiedTiles: [number, number][];
}

export interface EnemyTurnResult {
  damage: number;
  isHit: boolean;
  isCrit: boolean;
  attacked: boolean;
  logs: LogEntry[];
  events: GameEvent[];
  finalTileX: number;
  finalTileY: number;
  hidden: boolean;
}

export function chebyshev(x1: number, y1: number, x2: number, y2: number): number {
  return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2));
}

export function runEnemyTurn(
  enemy: EnemyState,
  def: MonsterDef,
  config: EnemyTurnConfig,
): EnemyTurnResult {
  const logs: LogEntry[] = [{ left: `${def.name}'s turn`, style: 'header' }];
  const events: GameEvent[] = [];
  let { tileX, tileY } = enemy;
  let enemyHidden = config.enemyCurrentlyHidden;

  const belowHalf = enemy.hp <= enemy.maxHp / 2;
  if (!enemyHidden && (belowHalf || Math.random() < 0.3)) {
    const { hidden, logs: hideLogs } = tryNimbleEscape(def, config.passivePerception);
    logs.push(...hideLogs);
    enemyHidden = hidden;
  }

  // Move step by step, recording each step as an event
  let stepsLeft = def.speed;
  while (stepsLeft > 0 && chebyshev(tileX, tileY, config.playerTileX, config.playerTileY) > 1) {
    const next = nextStepToward(
      tileX, tileY,
      config.playerTileX, config.playerTileY,
      config.passable, config.mapRows, config.mapCols,
      config.occupiedTiles,
    );
    if (!next || (next[0] === config.playerTileX && next[1] === config.playerTileY)) break;
    tileX = next[0];
    tileY = next[1];
    events.push({ type: 'entity_move', entityId: enemy.id, toX: tileX, toY: tileY });
    stepsLeft--;
  }

  const dist = chebyshev(tileX, tileY, config.playerTileX, config.playerTileY);
  if (dist > 1) {
    logs.push({ left: `${def.name} is out of reach`, style: 'normal' });
    return { damage: 0, isHit: false, isCrit: false, attacked: false, logs, events, finalTileX: tileX, finalTileY: tileY, hidden: enemyHidden };
  }

  const meleeAttack = def.attacks.find((a) => a.attackType === 'melee' || a.attackType === 'both');
  if (!meleeAttack) {
    logs.push({ left: `${def.name} has no attack`, style: 'normal' });
    return { damage: 0, isHit: false, isCrit: false, attacked: false, logs, events, finalTileX: tileX, finalTileY: tileY, hidden: enemyHidden };
  }

  const withAdvantage = enemyHidden;
  const withDisadvantage = config.playerHidden || config.enemyVexed || config.playerDodging;
  const { damage, isHit, isCrit, logs: attackLogs } = enemyAttack(def, meleeAttack, config.playerAc, withAdvantage, withDisadvantage);
  logs.push(...attackLogs);

  return { damage, isHit, isCrit, attacked: true, logs, events, finalTileX: tileX, finalTileY: tileY, hidden: enemyHidden };
}

function nextStepToward(
  fromX: number, fromY: number,
  targetX: number, targetY: number,
  passable: boolean[][], rows: number, cols: number,
  occupiedTiles: [number, number][],
): [number, number] | null {
  if (chebyshev(fromX, fromY, targetX, targetY) <= 1) return null;

  const visited: boolean[][] = Array.from({ length: rows }, () => new Array<boolean>(cols).fill(false));
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
