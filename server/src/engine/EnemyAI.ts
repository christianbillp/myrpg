import { NpcState, MonsterDef, GameEvent, LogEntry, AttackOnHitEffect, ExtraAttack } from './types.js';
import { tryNimbleEscape, enemyAttack, npcBanePenalty, npcReducedPenalty, type RolledBonusDamage } from './CombatSystem.js';
import { isIncapacitated, hasAttackDisadvantage, hasAttackAdvantage, hasSpeedZero, proneStandCost, grantsDisadvantageAgainst, grantsAdvantageAgainst } from './ConditionSystem.js';

/**
 * Snapshot of the creature an enemy NPC is about to engage. Generic over
 * `player | npc` — the caller (`runSingleEnemyTurn`) projects the player or
 * a target NPC into this shape so `runEnemyTurn` doesn't have to know which.
 * The resulting `EnemyTurnResult.attackedTargetId` echoes the `id` field so
 * the caller can route damage to the right entity.
 */
export interface EnemyAttackTarget {
  /** `'player'` for the player, NPC id otherwise. */
  id: string;
  /** Pre-disambiguated label rendered in attack logs. */
  displayName: string;
  tileX: number;
  tileY: number;
  ac: number;
  hp: number;
  hidden: boolean;
  dodging: boolean;
  invisible: boolean;
  /** Full condition list — consulted by `grantsDisadvantageAgainst` so any
   *  Disadv-imposing condition (blurred, heavily-obscured, …) lands on the
   *  attacker without each one needing its own discrete flag here. */
  conditions: string[];
  passivePerception: number;
  /** Set on the synthesised "no reachable/locatable target" snapshot — the
   *  attacker has no one it can attack (e.g. its only foe is an Invisible
   *  creature it failed to find, or the Charmer it can't strike). `runEnemyTurn`
   *  holds position and makes no attack roll. */
  noAttack?: boolean;
}

export interface EnemyTurnConfig {
  /** Pre-disambiguated display name (e.g. "Bridge Bandit (A)" when there are
   *  multiple Bridge Bandits in the encounter). Caller's responsibility. */
  displayName: string;
  /** The creature this enemy is engaging this turn — caller picks via
   *  faction hostility + range; if absent the enemy will Hold / skip. */
  target: EnemyAttackTarget;
  blocksMovement: boolean[][];
  mapCols: number;
  mapRows: number;
  occupiedTiles: [number, number][];
  /** Trait-derived attack-roll modifier (set by the caller — see CombatFlow.collectTraitModifiers). */
  traitAdvantage?: boolean;
  /** Trait-derived attack-roll modifier (set by the caller — see CombatFlow.collectTraitModifiers). */
  traitDisadvantage?: boolean;
  /** Called after the NPC commits to a movement step. Returns the step's
   *  effective cost (1 for ordinary terrain, 2 for Difficult Terrain) and
   *  may apply zone-entry side effects (Web save + Restrained). When the
   *  side effect zeroes the NPC's speed, the movement loop breaks on the
   *  next iteration via `hasSpeedZero`. */
  onStep?: (tx: number, ty: number) => number;
}

export interface EnemyTurnResult {
  damage: number;
  isHit: boolean;
  isCrit: boolean;
  attacked: boolean;
  /** `'player'` or the NPC id this enemy attacked. `null` when no attack was made. */
  attackedTargetId: string | null;
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
  /** Damage type of the primary attack (US-108) — threaded to the player damage
   *  path so species resistances apply. Undefined when no attack was made. */
  damageType?: string;
  /** SRD Multiattack (US-112): additional attacks beyond the primary, each a
   *  separate roll against the same target with the same Advantage state.
   *  Applied by the caller after the primary (and after any Shield reaction).
   *  Absent / empty for single-attack creatures. */
  extraAttacks?: ExtraAttack[];
  /** On-hit effects authored on the attack (attach, etc.). The caller applies
   *  these only when the attack actually lands. */
  attackOnHit?: AttackOnHitEffect[];
}

export interface AllyTurnConfig {
  /** Pre-disambiguated display name; same convention as EnemyTurnConfig. */
  displayName: string;
  enemyTargets: Array<{ id: string; tileX: number; tileY: number; ac: number; conditions?: string[] }>;
  blocksMovement: boolean[][];
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
  const target = config.target;
  const logs: LogEntry[] = [{ left: `${config.displayName}'s turn`, style: 'header' }];
  const events: GameEvent[] = [];
  let { tileX, tileY } = enemy;
  let enemyHidden = enemy.conditions.includes('hidden');

  const skip = (): EnemyTurnResult => ({
    damage: 0, isHit: false, isCrit: false, attackTotal: 0, attacked: false,
    attackedTargetId: null,
    logs, events, finalTileX: tileX, finalTileY: tileY, hidden: enemyHidden, bonusComponents: [],
  });

  if (isIncapacitated(enemy.conditions)) {
    logs.push({ left: `${config.displayName} is incapacitated`, style: 'status' });
    return skip();
  }

  // No creature this enemy can attack — its only foe is unreachable, or an
  // Invisible creature it failed to locate. It holds position and makes no
  // attack roll (it can't see where to swing).
  if (target.noAttack) {
    logs.push({ left: `${config.displayName} can't find a target`, style: 'normal' });
    return skip();
  }

  const belowHalf = enemy.hp <= enemy.maxHp / 2;

  const tileSpeed = def.speed / 5;
  const standCost = proneStandCost(enemy.conditions, tileSpeed);
  let stepsLeft = hasSpeedZero(enemy.conditions)
    ? 0
    : Math.max(0, tileSpeed - (enemy.conditions.includes('slowed') ? 2 : 0) - standCost);

  while (stepsLeft > 0 && chebyshev(tileX, tileY, target.tileX, target.tileY) > 1) {
    const next = nextStepToward(
      tileX, tileY,
      target.tileX, target.tileY,
      config.blocksMovement, config.mapRows, config.mapCols,
      config.occupiedTiles,
    );
    if (!next || (next[0] === target.tileX && next[1] === target.tileY)) break;
    tileX = next[0];
    tileY = next[1];
    events.push({ type: 'entity_move', entityId: enemy.id, toX: tileX, toY: tileY });
    // SRD zone interactions: stepping into a Web / Grease tile triggers the
    // enter-save (Web) and the Difficult Terrain cost (Web / Grease). The
    // hook runs after the tile commit so a failed Web save with
    // `condition: 'restrained'` will be observed by the next iteration's
    // `hasSpeedZero` check and break the loop.
    const cost = config.onStep?.(tileX, tileY) ?? 1;
    stepsLeft -= cost;
    if (hasSpeedZero(enemy.conditions)) break;
  }

  const dist = chebyshev(tileX, tileY, target.tileX, target.tileY);
  if (dist > 1) {
    logs.push({ left: `${config.displayName} is out of reach`, style: 'normal' });
    return skip();
  }

  const meleeAttack = def.attacks.find((a) => a.attackType === 'melee' || a.attackType === 'both');
  if (!meleeAttack) {
    logs.push({ left: `${config.displayName} has no attack`, style: 'normal' });
    return skip();
  }

  const targetUnconscious = target.hp <= 0;
  const withAdvantage = enemyHidden || targetUnconscious || hasAttackAdvantage(enemy.conditions) || !!config.traitAdvantage;
  // `grantsDisadvantageAgainst` consolidates the per-condition Disadv sources
  // (blurred, heavily-obscured, invisible, prone-at-distance) so adding a new
  // one is a single edit in ConditionSystem, not every attack resolver.
  const targetGrantsDisadv = grantsDisadvantageAgainst(target.conditions, dist);
  const withDisadvantage = target.hidden || targetGrantsDisadv || hasAttackDisadvantage(enemy.conditions) || target.dodging || !!config.traitDisadvantage;
  const { damage, isHit, isCrit, attackTotal, logs: attackLogs, bonusComponents } = enemyAttack(meleeAttack, target.ac, withAdvantage, withDisadvantage, 0, -npcBanePenalty(enemy), npcReducedPenalty(enemy));
  logs.push(...attackLogs);

  // SRD Multiattack (US-112): roll the remaining attacks now, with the same
  // weapon and Advantage state. Each is a separate roll; the caller applies
  // them after the primary (and after any Shield reaction the primary triggers).
  const extraAttacks: ExtraAttack[] = [];
  const totalAttacks = Math.max(1, def.multiattack ?? 1);
  for (let i = 1; i < totalAttacks; i++) {
    const ea = enemyAttack(meleeAttack, target.ac, withAdvantage, withDisadvantage, 0, -npcBanePenalty(enemy), npcReducedPenalty(enemy));
    logs.push(...ea.logs);
    extraAttacks.push({ damage: ea.damage, isHit: ea.isHit, isCrit: ea.isCrit, damageType: meleeAttack.damageType, bonusComponents: ea.bonusComponents });
  }

  // Making an attack gives away an unseen attacker's position — a hidden enemy
  // is revealed by its own strike, hit or miss (SRD 5.2.1: a hidden attacker
  // reveals its location when it attacks). The unseen-attacker advantage was
  // already applied above; the reveal lands afterwards so the player sees who
  // just hit them.
  if (enemyHidden) {
    enemyHidden = false;
    logs.push({ left: `${config.displayName} breaks from cover as it strikes`, style: 'status' });
  }

  // Nimble Escape (goblins): Hide again as a bonus action after attacking —
  // the signature strike-and-vanish. Rolls Stealth vs the target's passive
  // Perception, so a watchful target keeps eyes on it. More likely when hurt.
  if (def.nimbleEscape && (belowHalf || Math.random() < 0.3)) {
    const { hidden, logs: hideLogs } = tryNimbleEscape(def, target.passivePerception);
    logs.push(...hideLogs);
    enemyHidden = hidden;
  }

  return {
    damage, isHit, isCrit, attackTotal, attacked: true,
    attackedTargetId: target.id, damageType: meleeAttack.damageType,
    logs, events, finalTileX: tileX, finalTileY: tileY, hidden: enemyHidden, bonusComponents,
    extraAttacks,
    attackOnHit: meleeAttack.onHit,
  };
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
      config.blocksMovement, config.mapRows, config.mapCols,
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

  // Advantage from the target's condition (prone within reach, Blinded, and the
  // SRD Help `helped` marker — US-057). Previously allies never benefited from
  // target conditions; this also fixes the prone/blinded gap. (The `helped`
  // single-use marker is consumed by the caller after the attack.)
  const nearestConditions = nearest.conditions ?? [];
  const allyAdvantage = grantsAdvantageAgainst(nearestConditions, dist);
  const allyDisadvantage = grantsDisadvantageAgainst(nearestConditions, dist);
  const { damage, isHit, isCrit, logs: attackLogs, bonusComponents } = enemyAttack(meleeAttack, nearest.ac, allyAdvantage, allyDisadvantage);
  logs.push(...attackLogs);

  return { attackedTargetId: nearest.id, damage, isHit, isCrit, attacked: true, logs, events, finalTileX: tileX, finalTileY: tileY, bonusComponents };
}

export function nextStepToward(
  fromX: number, fromY: number,
  targetX: number, targetY: number,
  blocksMovement: boolean[][], rows: number, cols: number,
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
      if (blocksMovement[ny][nx]) continue;
      if (dr !== 0 && dc !== 0 && blocksMovement[cy][cx + dc] && blocksMovement[cy + dr][cx]) continue;
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
