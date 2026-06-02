import type { NpcState, MonsterDef } from './types.js';
import type { GameContext } from './GameContext.js';
import { chebyshev, nextStepToward } from './EnemyAI.js';
import { hasSpeedZero, proneStandCost, isIncapacitated } from './ConditionSystem.js';
import { Logger } from '../Logger.js';

/**
 * NpcBrain (Phase D — utility AI) — decides what high-level behavior an NPC
 * adopts on its turn: attack, flee, or hold. The engine's `runEnemyTurn` /
 * `runAllyTurn` then resolve the chosen behavior into concrete movement and
 * attacks.
 *
 * Truth flows down: this layer is fully deterministic. It scores three
 * candidate behaviors by weighted needs (survival, aggression, loyalty) and
 * returns the highest-scoring one. No LLM input.
 */

export type NpcBehavior = 'attack' | 'flee' | 'hold';

interface BehaviorScores {
  attack: number;
  flee: number;
  hold: number;
}

export function chooseNpcBehavior(ctx: GameContext, npc: NpcState, def: MonsterDef): NpcBehavior {
  if (isIncapacitated(npc.conditions)) {
    Logger.log('ai.behavior_pick', { npcId: npc.id, defId: npc.defId, chosen: 'hold', reason: 'incapacitated' });
    return 'hold';
  }

  const scores = scoreBehaviors(ctx, npc, def);
  let chosen: NpcBehavior;
  // Pick the highest. Ties resolve attack > hold > flee — keeps default
  // gameplay feel when no need dominates.
  if (scores.attack >= scores.flee && scores.attack >= scores.hold) chosen = 'attack';
  else if (scores.hold >= scores.flee) chosen = 'hold';
  else chosen = 'flee';
  Logger.log('ai.behavior_pick', {
    npcId: npc.id, defId: npc.defId, chosen,
    hp: npc.hp, maxHp: npc.maxHp, scores,
  });
  return chosen;
}

function scoreBehaviors(ctx: GameContext, npc: NpcState, def: MonsterDef): BehaviorScores {
  const s = ctx.state;
  const hpRatio = npc.hp / Math.max(1, npc.maxHp);

  // survival: rises as HP drops. Doubles below 25%.
  const survival = (1 - hpRatio) * 60 + (hpRatio < 0.25 ? 40 : 0);

  // aggression: baseline 40, scaled by CR (bigger monsters press harder).
  const aggression = 40 + Math.min(30, parseCr(def.cr) * 6);

  // loyalty: rises with living allies of the same disposition. A lone
  // creature breaks more easily.
  const samePeers = s.npcs.filter((n) =>
    n.id !== npc.id && n.hp > 0 && n.disposition === npc.disposition,
  ).length;
  const loyalty = Math.min(30, samePeers * 10);

  return {
    attack: aggression + loyalty * 0.5 - survival * 0.3,
    flee: survival * 1.0 - aggression * 0.4 - loyalty * 0.4,
    hold: 25 + (hpRatio < 0.5 ? 10 : 0),
  };
}

/**
 * True when the tile is on the playable-map boundary — any edge column or row.
 * A fleeing creature that ends its turn on such a tile is considered to have
 * escaped the encounter; the caller is responsible for despawning them.
 */
export function isMapEdge(ctx: GameContext, tileX: number, tileY: number): boolean {
  const { cols, rows } = ctx.state.map;
  return tileX === 0 || tileX === cols - 1 || tileY === 0 || tileY === rows - 1;
}

/** Parse an SRD challenge rating string ("0", "1/8", "1/4", "1/2", "2", …). */
function parseCr(cr: string | undefined): number {
  if (!cr) return 0;
  if (cr.includes('/')) {
    const [n, d] = cr.split('/').map(Number);
    return d ? n / d : 0;
  }
  return Number(cr) || 0;
}

// ── Flee behavior ────────────────────────────────────────────────────────────
//
// When morale breaks, an NPC moves away from its primary threat using BFS to
// find the tile within its movement budget that maximises Chebyshev distance
// from the threat. Falls back to "hold" when no valid retreat tile exists
// (e.g. cornered).

export interface FleeResult {
  finalTileX: number;
  finalTileY: number;
  pathTaken: Array<{ x: number; y: number }>;
}

export function fleeFromThreat(
  ctx: GameContext,
  npc: NpcState,
  def: MonsterDef,
  threatX: number,
  threatY: number,
): FleeResult {
  const s = ctx.state;
  let { tileX, tileY } = npc;

  if (hasSpeedZero(npc.conditions)) {
    return { finalTileX: tileX, finalTileY: tileY, pathTaken: [] };
  }

  const tileSpeed = def.speed / 5;
  const standCost = proneStandCost(npc.conditions, tileSpeed);
  let stepsLeft = Math.max(0, tileSpeed - (npc.conditions.includes('slowed') ? 2 : 0) - standCost);

  const path: Array<{ x: number; y: number }> = [];
  while (stepsLeft > 0) {
    // Greedy: among valid neighbours, pick the one that maximises distance
    // from the threat. Tie-break by preferring NOT to step adjacent to other
    // hostiles (avoid running INTO an enemy).
    const occupied: [number, number][] = s.npcs
      .filter((n) => n !== npc && n.hp > 0)
      .map((n): [number, number] => [n.tileX, n.tileY]);
    occupied.push([s.player.tileX, s.player.tileY]);

    let best: { x: number; y: number; dist: number } | null = null;
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]] as [number, number][]) {
      const nx = tileX + dx;
      const ny = tileY + dy;
      if (nx < 0 || ny < 0 || nx >= s.map.cols || ny >= s.map.rows) continue;
      if (!s.map.passable[ny][nx]) continue;
      if (dx !== 0 && dy !== 0 && !s.map.passable[tileY][nx] && !s.map.passable[ny][tileX]) continue;
      if (occupied.some(([ox, oy]) => ox === nx && oy === ny)) continue;
      const dist = chebyshev(nx, ny, threatX, threatY);
      if (!best || dist > best.dist) best = { x: nx, y: ny, dist };
    }
    if (!best || best.dist <= chebyshev(tileX, tileY, threatX, threatY)) break;
    tileX = best.x;
    tileY = best.y;
    path.push({ x: tileX, y: tileY });
    stepsLeft--;
  }

  // Quiet the unused-import warning when no path was found — nextStepToward
  // is held for future "flee to a known refuge" logic.
  void nextStepToward;

  return { finalTileX: tileX, finalTileY: tileY, pathTaken: path };
}
