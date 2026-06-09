/**
 * Difficulty scaling for generated quests. The single-type mission generator
 * had no scaling (fixed 1-2 enemies); this turns player level into an XP budget
 * and draws enemies from a pool until the budget is spent. Monster `xp` is the
 * CR proxy — it's already on every MonsterDef and rises with CR.
 */
import type { MonsterDef } from '../../../shared/types.js';

/** Target encounter XP budget for a given player level. Tuned so a level-1
 *  player faces roughly one CR-1/8 (25 xp) creature and the budget climbs
 *  steadily with level. */
export function questBudgetXp(level: number): number {
  return 25 + Math.max(0, level - 1) * 40;
}

export function monsterXp(monsters: MonsterDef[], defId: string): number {
  return monsters.find((m) => m.id === defId)?.xp ?? 25;
}

/**
 * Draw enemy def ids from `pool` (with replacement) until the XP budget is met,
 * clamped to `[min, max]` count. Returns at least `min` even on a tiny budget,
 * and never exceeds `max` (so a level-20 budget can't spawn a swarm that won't
 * fit the map).
 */
export function pickEnemies(
  monsters: MonsterDef[],
  pool: string[],
  budgetXp: number,
  rng: () => number,
  opts?: { min?: number; max?: number },
): string[] {
  const min = opts?.min ?? 1;
  const max = opts?.max ?? 5;
  const out: string[] = [];
  let spent = 0;
  while (out.length < max) {
    const def = pool[Math.floor(rng() * pool.length)];
    out.push(def);
    spent += monsterXp(monsters, def);
    if (out.length >= min && spent >= budgetXp) break;
  }
  return out;
}

/** Reward for clearing a set of enemies — XP equals their summed value; coin is
 *  a flat per-XP rate plus a completion bonus, so a harder contract pays more. */
export function rewardForEnemies(monsters: MonsterDef[], enemyIds: string[]): { cpDelta: number; xp: number } {
  const xp = enemyIds.reduce((n, id) => n + monsterXp(monsters, id), 0);
  return { cpDelta: xp * 20 + 500, xp };
}
