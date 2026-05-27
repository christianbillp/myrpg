import { NpcState, MonsterDef, GameEvent, LogEntry, AttackOnHitEffect } from './types.js';
import { tryNimbleEscape, enemyAttack, type RolledBonusDamage } from './CombatSystem.js';
import { isIncapacitated, hasAttackDisadvantage, hasAttackAdvantage, hasSpeedZero, proneStandCost } from './ConditionSystem.js';

export interface EnemyTurnConfig {
  /** Pre-disambiguated display name (e.g. "Bridge Bandit (A)" when there are
   *  multiple Bridge Bandits in the encounter). Caller's responsibility. */
  displayName: string;
  playerTileX: number;
  playerTileY: number;
  playerAc: number;
  playerHp: number;
  playerHidden: boolean;
  playerDodging: boolean;
  playerInvisible: boolean;
  passivePerception: number;
  passable: boolean[][];
  mapCols: number;
  mapRows: number;
  occupiedTiles: [number, number][];
  /** Trait-derived attack-roll modifier (set by the caller — see CombatFlow.collectTraitModifiers). */
  traitAdvantage?: boolean;
  /** Trait-derived attack-roll modifier (set by the caller — see CombatFlow.collectTraitModifiers). */
  traitDisadvantage?: boolean;
}

export interface EnemyTurnResult {
  damage: number;
  isHit: boolean;
  isCrit: boolean;
  attacked: boolean;
  /** The attacker's d20 + bonus total — exposed so callers can decide whether a Shield reaction would convert this hit to a miss. */
  attackTotal: number;
  logs: LogEntry[];
  events: GameEvent[];
  finalTileX: number;
  finalTileY: number;
  hidden: boolean;
  /** Secondary damage riders rolled from `MonsterAttack.bonusDamage`. The
   *  caller is responsible for applying each (along with per-type
   *  resistance) AFTER the primary damage lands. */
  bonusComponents: RolledBonusDamage[];
  /** On-hit effects authored on the attack (attach, etc.). The caller applies
   *  these only when the attack actually lands. */
  attackOnHit?: AttackOnHitEffect[];
}

export interface AllyTurnConfig {
  /** Pre-disambiguated display name; same convention as EnemyTurnConfig. */
  displayName: string;
  enemyTargets: Array<{ id: string; tileX: number; tileY: number; ac: number }>;
  passable: boolean[][];
  mapCols: number;
  mapRows: number;
  occupiedTiles: [number, number][];
}

export interface AllyTurnResult {
  attackedTargetId: string | null;
  damage: number;
  isHit: boolean;
  isCrit: boolean;
  attacked: boolean;
  logs: LogEntry[];
  events: GameEvent[];
  finalTileX: number;
  finalTileY: number;
  bonusComponents: RolledBonusDamage[];
}

export function chebyshev(x1: number, y1: number, x2: number, y2: number): number {
  return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2));
}

export function runEnemyTurn(
  enemy: NpcState,
  def: MonsterDef,
  config: EnemyTurnConfig,
): EnemyTurnResult {
  const logs: LogEntry[] = [{ left: `${config.displayName}'s turn`, style: 'header' }];
  const events: GameEvent[] = [];
  let { tileX, tileY } = enemy;
  let enemyHidden = enemy.conditions.includes('hidden');

  if (isIncapacitated(enemy.conditions)) {
    logs.push({ left: `${config.displayName} is incapacitated`, style: 'status' });
    return { damage: 0, isHit: false, isCrit: false, attackTotal: 0, attacked: false, logs, events, finalTileX: tileX, finalTileY: tileY, hidden: enemyHidden, bonusComponents: [] };
  }

  const belowHalf = enemy.hp <= enemy.maxHp / 2;
  if (!enemyHidden && def.nimbleEscape && (belowHalf || Math.random() < 0.3)) {
    const { hidden, logs: hideLogs } = tryNimbleEscape(def, config.passivePerception);
    logs.push(...hideLogs);
    enemyHidden = hidden;
  }

  const tileSpeed = def.speed / 5;
  const standCost = proneStandCost(enemy.conditions, tileSpeed);
  let stepsLeft = hasSpeedZero(enemy.conditions)
    ? 0
    : Math.max(0, tileSpeed - (enemy.conditions.includes('slowed') ? 2 : 0) - standCost);

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
    logs.push({ left: `${config.displayName} is out of reach`, style: 'normal' });
    return { damage: 0, isHit: false, isCrit: false, attackTotal: 0, attacked: false, logs, events, finalTileX: tileX, finalTileY: tileY, hidden: enemyHidden, bonusComponents: [] };
  }

  const meleeAttack = def.attacks.find((a) => a.attackType === 'melee' || a.attackType === 'both');
  if (!meleeAttack) {
    logs.push({ left: `${config.displayName} has no attack`, style: 'normal' });
    return { damage: 0, isHit: false, isCrit: false, attackTotal: 0, attacked: false, logs, events, finalTileX: tileX, finalTileY: tileY, hidden: enemyHidden, bonusComponents: [] };
  }

  const playerUnconscious = config.playerHp <= 0;
  const withAdvantage = enemyHidden || playerUnconscious || hasAttackAdvantage(enemy.conditions) || !!config.traitAdvantage;
  const withDisadvantage = config.playerHidden || config.playerInvisible || hasAttackDisadvantage(enemy.conditions) || config.playerDodging || !!config.traitDisadvantage;
  const { damage, isHit, isCrit, attackTotal, logs: attackLogs, bonusComponents } = enemyAttack(meleeAttack, config.playerAc, withAdvantage, withDisadvantage);
  logs.push(...attackLogs);

  return { damage, isHit, isCrit, attackTotal, attacked: true, logs, events, finalTileX: tileX, finalTileY: tileY, hidden: enemyHidden, bonusComponents, attackOnHit: meleeAttack.onHit };
}

export function runAllyTurn(
  ally: NpcState,
  def: MonsterDef,
  config: AllyTurnConfig,
): AllyTurnResult {
  const logs: LogEntry[] = [{ left: `${config.displayName}'s turn (ally)`, style: 'header' }];
  const events: GameEvent[] = [];
  let { tileX, tileY } = ally;

  if (config.enemyTargets.length === 0) {
    logs.push({ left: `${config.displayName} stands ready`, style: 'normal' });
    return { attackedTargetId: null, damage: 0, isHit: false, isCrit: false, attacked: false, logs, events, finalTileX: tileX, finalTileY: tileY, bonusComponents: [] };
  }

  // Find nearest enemy target by Chebyshev distance
  let nearest = config.enemyTargets[0];
  let nearestDist = chebyshev(tileX, tileY, nearest.tileX, nearest.tileY);
  for (const target of config.enemyTargets.slice(1)) {
    const d = chebyshev(tileX, tileY, target.tileX, target.tileY);
    if (d < nearestDist) { nearest = target; nearestDist = d; }
  }

  // Move toward nearest target
  let stepsLeft = def.speed / 5;
  while (stepsLeft > 0 && chebyshev(tileX, tileY, nearest.tileX, nearest.tileY) > 1) {
    const next = nextStepToward(
      tileX, tileY,
      nearest.tileX, nearest.tileY,
      config.passable, config.mapRows, config.mapCols,
      config.occupiedTiles,
    );
    if (!next || (next[0] === nearest.tileX && next[1] === nearest.tileY)) break;
    tileX = next[0];
    tileY = next[1];
    events.push({ type: 'entity_move', entityId: ally.id, toX: tileX, toY: tileY });
    stepsLeft--;
  }

  const dist = chebyshev(tileX, tileY, nearest.tileX, nearest.tileY);
  if (dist > 1) {
    logs.push({ left: `${config.displayName} moves but cannot reach the enemy`, style: 'normal' });
    return { attackedTargetId: null, damage: 0, isHit: false, isCrit: false, attacked: false, logs, events, finalTileX: tileX, finalTileY: tileY, bonusComponents: [] };
  }

  const meleeAttack = def.attacks.find((a) => a.attackType === 'melee' || a.attackType === 'both');
  if (!meleeAttack) {
    logs.push({ left: `${config.displayName} has no melee attack`, style: 'normal' });
    return { attackedTargetId: null, damage: 0, isHit: false, isCrit: false, attacked: false, logs, events, finalTileX: tileX, finalTileY: tileY, bonusComponents: [] };
  }

  const { damage, isHit, isCrit, logs: attackLogs, bonusComponents } = enemyAttack(meleeAttack, nearest.ac, false, false);
  logs.push(...attackLogs);

  return { attackedTargetId: nearest.id, damage, isHit, isCrit, attacked: true, logs, events, finalTileX: tileX, finalTileY: tileY, bonusComponents };
}

export function nextStepToward(
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
  const dirs: [number, number][] = [
    [0, 1], [0, -1], [1, 0], [-1, 0],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
  ];

  while (queue.length > 0) {
    const [cy, cx] = queue.shift()!;
    for (const [dr, dc] of dirs) {
      const ny = cy + dr, nx = cx + dc;
      if (ny < 0 || ny >= rows || nx < 0 || nx >= cols) continue;
      if (!passable[ny][nx]) continue;
      if (dr !== 0 && dc !== 0 && !passable[cy][cx + dc] && !passable[cy + dr][cx]) continue;
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
