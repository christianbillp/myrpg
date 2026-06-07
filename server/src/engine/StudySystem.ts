/**
 * StudySystem — the Study player-action against an authored feature tile.
 *
 * A `study_feature` trigger (authored on a tile, e.g. a cracked wardstone) holds
 * the deterministic examination: a `player_ability_check` whose onPass surfaces
 * the lore. Unlike a `player_moved` auto-trigger, it fires only when the player
 * deliberately Studies the tile from within reach (≤1 tile) — the engine gates
 * range here, the client prompts "move closer" when farther. Studying costs the
 * Action in combat (SRD Study action). The check resolves through the normal
 * trigger path once we publish the `study_feature` event.
 */
import type { GameContext } from './GameContext.js';
import type { GameEvent } from './types.js';
import { chebyshev } from './EnemyAI.js';

export function doStudy(ctx: GameContext, tileX: number, tileY: number, _events: GameEvent[]): void {
  const s = ctx.state;
  if (s.phase !== 'exploring' && s.phase !== 'player_turn') return;

  // There must be an un-fired study point on the tile, or there's nothing to do
  // (and we mustn't spend an Action for nothing).
  const hasPoint = s.triggers.some((t) =>
    t.when.event === 'study_feature'
    && t.when.tile.x === tileX && t.when.tile.y === tileY
    && (t.once === false || !s.firedTriggerIds.includes(t.id)));
  if (!hasPoint) return;

  // Range gate — authoritative. The client gates the same way and prompts the
  // player to move closer, so this only rejects out-of-range/stale clicks.
  if (chebyshev(s.player.tileX, s.player.tileY, tileX, tileY) > 1) return;

  // Study is an Action in combat.
  if (s.phase === 'player_turn') {
    if (s.player.actionUsed) return;
    s.player.actionUsed = true;
  }

  // Resolve through the trigger system: the tile's `study_feature` trigger runs
  // its `player_ability_check` (rolls + routes to onPass/onFail).
  ctx.publish({ type: 'study_feature', x: tileX, y: tileY });
}

/**
 * The SRD **Magic** action against an authored `magic_feature` tile — channelling
 * magic into it (e.g. performing the binding rite at the keystone). Same shape as
 * `doStudy`: range-gated to ≤1 tile, costs the Action in combat, resolves through
 * the tile's `magic_feature` trigger.
 */
export function doMagicRite(ctx: GameContext, tileX: number, tileY: number, _events: GameEvent[]): void {
  const s = ctx.state;
  if (s.phase !== 'exploring' && s.phase !== 'player_turn') return;

  const hasPoint = s.triggers.some((t) =>
    t.when.event === 'magic_feature'
    && t.when.tile.x === tileX && t.when.tile.y === tileY
    && (t.once === false || !s.firedTriggerIds.includes(t.id)));
  if (!hasPoint) return;

  if (chebyshev(s.player.tileX, s.player.tileY, tileX, tileY) > 1) return;

  if (s.phase === 'player_turn') {
    if (s.player.actionUsed) return;
    s.player.actionUsed = true;
  }

  ctx.publish({ type: 'magic_feature', x: tileX, y: tileY });
}
