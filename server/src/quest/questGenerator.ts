/**
 * Quest generator — picks a quest type (weighted, avoiding an immediate repeat)
 * and rolls a full `GeneratedQuest`. Replaces the single-type
 * `mission/missionGenerator.ts`.
 */
import type { GeneratedQuest, QuestGenContext } from './questGenTypes.js';
import { QUEST_TYPE_MODULES } from './questTypes.js';

export function generateQuest(ctx: QuestGenContext): GeneratedQuest {
  const enabled = QUEST_TYPE_MODULES.filter((m) => m.weight(ctx) > 0);
  // Prefer not to repeat the last type, but never starve.
  const candidates = enabled.filter((m) => m.id !== ctx.lastType);
  const pool = candidates.length > 0 ? candidates : enabled;

  const weights = pool.map((m) => m.weight(ctx));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = ctx.rng() * total;
  let chosen = pool[0];
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) { chosen = pool[i]; break; }
  }
  return chosen.generate(ctx);
}
