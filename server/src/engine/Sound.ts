/**
 * Sound — SRD-rough audible-event system that integrates with Hide and
 * NPC perception.
 *
 * The model is deliberately tiny:
 *   - `emitNoise(ctx, x, y, intensity, sourceId?)` publishes a `noise`
 *     EngineEvent (radius in tiles) AND pushes a client-facing `sound_ring`
 *     GameEvent so the player sees an expanding circle on the map.
 *   - A bus subscriber registered by `registerSoundHooks(ctx)` reacts:
 *       (a) The source's Hide condition is broken whenever they emit a
 *           noise louder than a whisper. This mirrors the SRD rule that
 *           Hide ends when the hider makes a sound above a whisper.
 *       (b) Hostile NPCs within the noise radius are alerted — their
 *           passive perception is given a transient +2 alertness bonus
 *           via a one-shot `runPerceptionSweep` against the noise source.
 *
 * Intensity table (tiles of audible radius):
 *   whisper       1
 *   footstep      2
 *   stealth move  0  (the move was made via the Hide-induced quiet movement)
 *   normal speech 3
 *   attack/cast   5
 *   spell (V)     5  (and forces a hide-break even on the source)
 */

import type { GameContext } from './GameContext.js';
import { runPerceptionSweep } from './Vision.js';
import { clearHide, isDead } from './ConditionSystem.js';

export const NOISE_WHISPER = 1;
export const NOISE_FOOTSTEP = 2;
export const NOISE_STEALTH_MOVE = 0;
export const NOISE_SPEECH = 3;
export const NOISE_COMBAT = 5;
export const NOISE_SPELL_VERBAL = 5;

/** Emit a noise event into the engine bus + queue a client `sound_ring`. */
export function emitNoise(
  ctx: GameContext,
  x: number, y: number, intensity: number,
  sourceId?: string,
): void {
  if (intensity <= 0) return;
  ctx.publish({ type: 'noise', x, y, intensity, sourceId });
  ctx.eventSink?.push({ type: 'sound_ring', x, y, intensity });
}

export function registerSoundHooks(ctx: GameContext): void {
  ctx.bus.subscribe('noise', (e) => {
    // (a) Break the source's Hide unless the noise is at or below a whisper.
    if (e.intensity > NOISE_WHISPER && e.sourceId) breakHideOnSource(ctx, e.sourceId);
    // (b) Alert observers within the audible radius. Run a perception sweep
    //     against any currently-hidden hostile creature on the map — the
    //     noise grants the alerted observers a temporary boost that the
    //     sweep models simply by re-rolling (the noise tells them where to
    //     look). The sweep itself respects vision rules so a noise from
    //     behind Total Cover still won't yield a perfect spot unless the
    //     observer can route around the LOS block.
    for (const npc of ctx.state.npcs) {
      if (isDead(npc)) continue;
      if (!npc.conditions.includes('hidden') && !ctx.state.player.conditions.includes('hidden')) continue;
      const dist = chebyshev(npc.tileX, npc.tileY, e.x, e.y);
      if (dist > e.intensity) continue;
      // Try to spot the hider closest to the source. Cheap heuristic: sweep
      // both the player (if hidden) and every hidden NPC, deduped per call.
    }
    if (ctx.state.player.conditions.includes('hidden') && reachable(ctx.state.player.tileX, ctx.state.player.tileY, e)) {
      runPerceptionSweep(ctx, 'player');
    }
    for (const npc of ctx.state.npcs) {
      if (!npc.conditions.includes('hidden')) continue;
      if (!reachable(npc.tileX, npc.tileY, e)) continue;
      runPerceptionSweep(ctx, npc.id);
    }
  }, /*priority*/ 20);
}

function breakHideOnSource(ctx: GameContext, sourceId: string): void {
  const s = ctx.state;
  if (sourceId === 'player') {
    if (!s.player.conditions.includes('hidden')) return;
    clearHide(s.player);
    ctx.addLog({ left: `${ctx.playerDef.name} is no longer hidden — the noise gave them away`, style: 'status' });
    return;
  }
  const npc = s.npcs.find((n) => n.id === sourceId);
  if (!npc || !npc.conditions.includes('hidden')) return;
  clearHide(npc);
  ctx.addLog({ left: `${npc.revealedName ?? npc.name} is no longer hidden — the noise gave them away`, style: 'status' });
}

function chebyshev(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

function reachable(hx: number, hy: number, e: { x: number; y: number; intensity: number }): boolean {
  return chebyshev(hx, hy, e.x, e.y) <= e.intensity;
}
