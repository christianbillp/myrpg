import { NpcState, MonsterDef, GameEvent, LogEntry, AttackOnHitEffect, ExtraAttack, MonsterSaveAction } from './types.js';
import { tryNimbleEscape, enemyAttack, npcBanePenalty, npcBlessBonus, npcReducedPenalty, type RolledBonusDamage } from './CombatSystem.js';
import { isIncapacitated, hasAttackDisadvantage, hasAttackAdvantage, hasSpeedZero, proneStandCost, grantsDisadvantageAgainst, grantsAdvantageAgainst } from './ConditionSystem.js';
import { rolePrefersRange } from './MonsterRoles.js';

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
  /** True when this target is currently grappled BY the attacking NPC — set
   *  by the caller from `grappledBy` tracking. Grants Advantage to attacks
   *  flagged `advantageVsGrappledTarget` (US-125, Bugbear Light Hammer). */
  grappledByAttacker?: boolean;
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
  /** Tactical role (#35) — `artillery` / range-preferring `skirmisher` hold their
   *  weapon's range and kite away from melee instead of marching in. Defaults to
   *  `soldier` when omitted (today's advance-to-melee behavior). */
  role?: import('../../../shared/types.js').MonsterRole;
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
  /** Cover AC bonus the target benefits from against a shot taken from
   *  (fromX, fromY) — the caller walks the Vision line (US-045). Consulted
   *  for ranged attacks only; ≥ 99 means Total Cover (no shot is taken). */
  coverFor?: (fromX: number, fromY: number) => number;
  /** SRD Unseen Attackers and Targets (US-127), evaluated from the attacker's
   *  post-movement tile: `seesTarget` false → Disadvantage (swinging at a
   *  location); `seenByTarget` false → Advantage (unseen attacker). The
   *  caller resolves both through the Vision walker (ambient light, fog,
   *  blindness, senses). */
  attackVision?: (fromX: number, fromY: number) => { seesTarget: boolean; seenByTarget: boolean };
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
  /** Whether the resolved attack was a melee swing or a ranged shot (US-124)
   *  — drives the caller's attack beat + sound. Undefined when no attack. */
  attackKind?: 'melee' | 'ranged';
  /** Attack-replacement save action used this turn (US-125, Enthralling
   *  Panache) — one Multiattack swing was traded for it. The caller resolves
   *  the target's save and applies the condition; it lasts until the start
   *  of this creature's next turn. */
  saveAction?: MonsterSaveAction;
}

export interface AllyTurnConfig {
  /** Pre-disambiguated display name; same convention as EnemyTurnConfig. */
  displayName: string;
  enemyTargets: Array<{ id: string; tileX: number; tileY: number; ac: number; conditions?: string[] }>;
  /** SRD Unseen Attackers and Targets (US-127) — same contract as
   *  `EnemyTurnConfig.attackVision`, with the chosen target's id since the
   *  ally picks its own target inside. */
  attackVision?: (fromX: number, fromY: number, targetId: string) => { seesTarget: boolean; seenByTarget: boolean };
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

  // SRD attack choice (US-124): a creature with a save-rider attack (Ghoul
  // Claw → Paralyzed) opens with it while the target lacks the condition —
  // the rider is its own single-attack action, not part of Multiattack. Once
  // the condition lands (or the attack has no rider) the creature uses its
  // first melee attack with full Multiattack (the Ghoul's two Bites, now with
  // Advantage and adjacent auto-crits against a paralyzed target). A ranged
  // option (Skeleton's Shortbow, Bandit Captain's Pistol) is used whenever
  // melee can't be reached this turn — charge when you can engage, shoot
  // when you can't.
  const meleeAttacks = def.attacks.filter((a) => a.attackType === 'melee' || a.attackType === 'both');
  const riderAttack = meleeAttacks.find((a) =>
    a.onHit?.some((e) => (e.kind === 'save' || e.kind === 'condition') && !target.conditions.includes(e.condition)),
  );
  const meleeAttack = riderAttack ?? meleeAttacks[0];
  const rangedAttack = def.attacks.find((a) => (a.attackType === 'ranged' || a.attackType === 'both') && (a.rangeNormal ?? 0) > 0);
  if (!meleeAttack && !rangedAttack) {
    logs.push({ left: `${config.displayName} has no attack`, style: 'normal' });
    return skip();
  }
  const rangeNormalTiles = rangedAttack ? Math.max(1, Math.floor((rangedAttack.rangeNormal ?? 5) / 5)) : 0;
  const rangeLongTiles = rangedAttack ? Math.max(rangeNormalTiles, Math.floor((rangedAttack.rangeLong ?? rangedAttack.rangeNormal ?? 5) / 5)) : 0;

  // Simplified SRD Fly (US-117): +30 ft of speed while the self-cast Fly
  // concentration holds — the engine has no elevation model.
  const tileSpeed = (def.speed + (enemy.flying ? 30 : 0)) / 5;
  const standCost = proneStandCost(enemy.conditions, tileSpeed);
  let stepsLeft = hasSpeedZero(enemy.conditions)
    ? 0
    : Math.max(0, tileSpeed - (enemy.conditions.includes('slowed') ? 2 : 0) - standCost);

  // Movement intent: close to melee when this turn's budget can plausibly
  // reach adjacency; otherwise a shooter advances only to normal range (or
  // holds position if already inside it) instead of marching into reach.
  // Role #35: artillery (and a skirmisher with a ranged option) HOLD their
  // weapon's range — they advance only to that range and kite back out of melee.
  const startDist = chebyshev(tileX, tileY, target.tileX, target.tileY);
  const prefersRange = rolePrefersRange(config.role ?? 'soldier', !!rangedAttack) && rangeNormalTiles > 0;
  let desiredDist: number;
  if (prefersRange) {
    desiredDist = rangeNormalTiles;
  } else {
    const canReachMelee = !!meleeAttack && startDist - stepsLeft <= 1;
    desiredDist = rangedAttack && !canReachMelee ? Math.min(rangeNormalTiles, Math.max(1, startDist)) : 1;
  }

  while (stepsLeft > 0 && chebyshev(tileX, tileY, target.tileX, target.tileY) > desiredDist) {
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

  // Kite (#35): a range-preferring shooter that's inside its range (a melee foe
  // closed on it) backs away to regain distance, spending its remaining movement.
  while (prefersRange && stepsLeft > 0 && chebyshev(tileX, tileY, target.tileX, target.tileY) < desiredDist) {
    const away = stepAwayFrom(tileX, tileY, target.tileX, target.tileY, config.blocksMovement, config.mapRows, config.mapCols, config.occupiedTiles);
    if (!away) break;
    tileX = away[0];
    tileY = away[1];
    events.push({ type: 'entity_move', entityId: enemy.id, toX: tileX, toY: tileY });
    const cost = config.onStep?.(tileX, tileY) ?? 1;
    stepsLeft -= cost;
    if (hasSpeedZero(enemy.conditions)) break;
  }

  // Resolve which attack actually fires from the final position: melee when
  // adjacent (avoiding the SRD point-blank Disadvantage), the ranged option
  // for anything farther that is still within long range.
  const dist = chebyshev(tileX, tileY, target.tileX, target.tileY);
  let chosenAttack = meleeAttack;
  let attackKind: 'melee' | 'ranged' = 'melee';
  if (dist > 1) {
    if (rangedAttack && dist <= rangeLongTiles) {
      chosenAttack = rangedAttack;
      attackKind = 'ranged';
    } else {
      logs.push({ left: `${config.displayName} is out of reach`, style: 'normal' });
      return skip();
    }
  } else if (!meleeAttack && rangedAttack) {
    chosenAttack = rangedAttack;
    attackKind = 'ranged';
  }
  if (!chosenAttack) {
    logs.push({ left: `${config.displayName} has no attack`, style: 'normal' });
    return skip();
  }

  // SRD ranged-attack modifiers: Disadvantage beyond normal range (long
  // shot) and within 5 ft of the target (point-blank); the target's Cover
  // bonus applies (US-045) — Total Cover means no shot at all.
  const longShot = attackKind === 'ranged' && dist > rangeNormalTiles;
  const pointBlank = attackKind === 'ranged' && dist <= 1;
  const coverAc = attackKind === 'ranged' ? (config.coverFor?.(tileX, tileY) ?? 0) : 0;
  if (attackKind === 'ranged' && coverAc >= 99) {
    logs.push({ left: `${config.displayName} has no clear shot — ${target.displayName} is behind Total Cover`, style: 'normal' });
    return skip();
  }

  const targetUnconscious = target.hp <= 0;
  const grappleAdvantage = !!chosenAttack.advantageVsGrappledTarget && !!target.grappledByAttacker;
  // SRD Unseen Attackers and Targets (US-127) from the post-movement tile —
  // ambient darkness / fog / blindness via the caller's Vision walk.
  const vision = config.attackVision?.(tileX, tileY);
  const withAdvantage = enemyHidden || targetUnconscious || hasAttackAdvantage(enemy.conditions) || !!config.traitAdvantage || grappleAdvantage || (vision ? !vision.seenByTarget : false);
  // `grantsDisadvantageAgainst` consolidates the per-condition Disadv sources
  // (blurred, heavily-obscured, invisible, prone-at-distance) so adding a new
  // one is a single edit in ConditionSystem, not every attack resolver.
  const targetGrantsDisadv = grantsDisadvantageAgainst(target.conditions, dist);
  const withDisadvantage = target.hidden || targetGrantsDisadv || hasAttackDisadvantage(enemy.conditions) || target.dodging || !!config.traitDisadvantage || longShot || pointBlank || (vision ? !vision.seesTarget : false);
  const attackRollMod = npcBlessBonus(enemy) - npcBanePenalty(enemy);
  const { damage, isHit, isCrit, attackTotal, logs: attackLogs, bonusComponents } = enemyAttack(chosenAttack, target.ac, withAdvantage, withDisadvantage, coverAc, attackRollMod, npcReducedPenalty(enemy));
  logs.push(...attackLogs);

  // SRD Multiattack (US-112): roll the remaining attacks now, with the same
  // weapon and Advantage state. Each is a separate roll; the caller applies
  // them after the primary (and after any Shield reaction the primary triggers).
  // A save action (US-125, Enthralling Panache) replaces ONE of the attacks
  // when the target doesn't already carry its condition and is in range.
  const extraAttacks: ExtraAttack[] = [];
  let totalAttacks = chosenAttack === riderAttack ? 1 : Math.max(1, def.multiattack ?? 1);
  let saveAction: MonsterSaveAction | undefined;
  if (totalAttacks > 1) {
    saveAction = (def.saveActions ?? []).find((sa) =>
      !target.conditions.includes(sa.condition) && dist * 5 <= sa.rangeFeet,
    );
    if (saveAction) totalAttacks -= 1;
  }
  for (let i = 1; i < totalAttacks; i++) {
    const ea = enemyAttack(chosenAttack, target.ac, withAdvantage, withDisadvantage, coverAc, npcBlessBonus(enemy) - npcBanePenalty(enemy), npcReducedPenalty(enemy));
    logs.push(...ea.logs);
    extraAttacks.push({ damage: ea.damage, isHit: ea.isHit, isCrit: ea.isCrit, damageType: chosenAttack.damageType, bonusComponents: ea.bonusComponents });
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
    attackedTargetId: target.id, damageType: chosenAttack.damageType,
    logs, events, finalTileX: tileX, finalTileY: tileY, hidden: enemyHidden, bonusComponents,
    extraAttacks,
    attackOnHit: chosenAttack.onHit,
    attackKind,
    saveAction,
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

  // Melee when adjacent; otherwise fall back to a ranged option within long
  // range (US-124) — with the SRD long-shot Disadvantage beyond normal range.
  const dist = chebyshev(tileX, tileY, nearest.tileX, nearest.tileY);
  const meleeAttack = def.attacks.find((a) => a.attackType === 'melee' || a.attackType === 'both');
  const rangedAttack = def.attacks.find((a) => (a.attackType === 'ranged' || a.attackType === 'both') && (a.rangeNormal ?? 0) > 0);
  let chosenAttack = meleeAttack;
  let longShot = false;
  if (dist > 1) {
    const rangeNormalTiles = rangedAttack ? Math.max(1, Math.floor((rangedAttack.rangeNormal ?? 5) / 5)) : 0;
    const rangeLongTiles = rangedAttack ? Math.max(rangeNormalTiles, Math.floor((rangedAttack.rangeLong ?? rangedAttack.rangeNormal ?? 5) / 5)) : 0;
    if (rangedAttack && dist <= rangeLongTiles) {
      chosenAttack = rangedAttack;
      longShot = dist > rangeNormalTiles;
    } else {
      logs.push({ left: `${config.displayName} moves but cannot reach the enemy`, style: 'normal' });
      return { attackedTargetId: null, damage: 0, isHit: false, isCrit: false, attacked: false, logs, events, finalTileX: tileX, finalTileY: tileY, bonusComponents: [] };
    }
  }
  if (!chosenAttack) {
    logs.push({ left: `${config.displayName} has no attack`, style: 'normal' });
    return { attackedTargetId: null, damage: 0, isHit: false, isCrit: false, attacked: false, logs, events, finalTileX: tileX, finalTileY: tileY, bonusComponents: [] };
  }

  // Advantage from the target's condition (prone within reach, Blinded, and the
  // SRD Help `helped` marker — US-057). Previously allies never benefited from
  // target conditions; this also fixes the prone/blinded gap. (The `helped`
  // single-use marker is consumed by the caller after the attack.)
  const nearestConditions = nearest.conditions ?? [];
  const allyVision = config.attackVision?.(tileX, tileY, nearest.id);
  const allyAdvantage = grantsAdvantageAgainst(nearestConditions, dist) || (allyVision ? !allyVision.seenByTarget : false);
  const allyDisadvantage = grantsDisadvantageAgainst(nearestConditions, dist) || longShot || (allyVision ? !allyVision.seesTarget : false);
  const { damage, isHit, isCrit, logs: attackLogs, bonusComponents } = enemyAttack(chosenAttack, nearest.ac, allyAdvantage, allyDisadvantage);
  logs.push(...attackLogs);

  return { attackedTargetId: nearest.id, damage, isHit, isCrit, attacked: true, logs, events, finalTileX: tileX, finalTileY: tileY, bonusComponents };
}

/**
 * One step that increases distance from the target (kiting, #35). Picks the
 * passable, unoccupied, in-bounds neighbor with the greatest Chebyshev distance
 * from the target; returns null when no neighbor improves (cornered).
 */
export function stepAwayFrom(
  fromX: number, fromY: number,
  targetX: number, targetY: number,
  blocksMovement: boolean[][], rows: number, cols: number,
  occupiedTiles: [number, number][],
): [number, number] | null {
  const here = chebyshev(fromX, fromY, targetX, targetY);
  let best: [number, number] | null = null;
  let bestDist = here;
  for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]] as [number, number][]) {
    const nx = fromX + dc, ny = fromY + dr;
    if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
    if (blocksMovement[ny][nx]) continue;
    if (dr !== 0 && dc !== 0 && blocksMovement[fromY][nx] && blocksMovement[ny][fromX]) continue;
    if (occupiedTiles.some(([ox, oy]) => ox === nx && oy === ny)) continue;
    const d = chebyshev(nx, ny, targetX, targetY);
    if (d > bestDist) { bestDist = d; best = [nx, ny]; }
  }
  return best;
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
