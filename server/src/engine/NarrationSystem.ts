import type { GameContext } from './GameContext.js';
import type { NarrationDef } from './types.js';

/**
 * NarrationSystem — picks a canned text variant for a `narrationId`, avoiding
 * the variant used last time (when more than one exists). Lets deterministic
 * triggers feel different across plays without invoking the generative GM.
 *
 * State: `GameState.narrationLastUsed[narrationId]` stores the last picked
 * index. Persisted in the world save so a save/load doesn't reset the
 * anti-repeat memory mid-encounter.
 */
export function pickNarrationVariant(ctx: GameContext, narrationId: string): string | null {
  const def = findNarrationDef(ctx, narrationId);
  if (!def || def.variants.length === 0) return null;

  const lastUsed = ctx.state.narrationLastUsed[narrationId];
  const eligible = def.variants.length === 1
    ? [0]
    : def.variants.map((_, i) => i).filter((i) => i !== lastUsed);

  const choice = pickWeighted(eligible, def.weights);
  ctx.state.narrationLastUsed[narrationId] = choice;
  return def.variants[choice];
}

/**
 * Pick an index from `eligible` either uniformly (no weights) or by the
 * supplied per-variant weights. `weights` is parallel to the underlying
 * variants array, so we index INTO it with the eligible indices.
 */
function pickWeighted(eligible: number[], weights: number[] | undefined): number {
  if (!weights || weights.length === 0) {
    return eligible[Math.floor(Math.random() * eligible.length)];
  }
  const total = eligible.reduce((sum, i) => sum + Math.max(0, weights[i] ?? 1), 0);
  if (total <= 0) return eligible[Math.floor(Math.random() * eligible.length)];
  let roll = Math.random() * total;
  for (const i of eligible) {
    const w = Math.max(0, weights[i] ?? 1);
    roll -= w;
    if (roll <= 0) return i;
  }
  return eligible[eligible.length - 1];
}

function findNarrationDef(ctx: GameContext, narrationId: string): NarrationDef | undefined {
  return ctx.defs.narration.find((n) => n.id === narrationId);
}
