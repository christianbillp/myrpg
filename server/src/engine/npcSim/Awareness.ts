/**
 * Awareness — the propagation pass that promotes nearby NPCs from `calm`
 * to `suspicious` or `alert` based on what's happening in the world.
 *
 * Two surfaces:
 *
 *   • `pingFactionAlert(ctx, sourceTile, factionId, …)` — direct call
 *     used at combat start so every same-faction NPC within range wakes
 *     up to `alert` even if they aren't in line of sight yet. Direct
 *     because no other system needs to react to "combat started in
 *     faction F" — it's a one-shot call site.
 *
 *   • `registerAwarenessHooks(ctx)` — subscribes to the existing `noise`
 *     bus event from `Sound.ts`. Every audible noise (combat swing,
 *     spell verbal component, footstep) raises NPCs inside the noise's
 *     intensity radius to `suspicious`. This piggy-backs on the same
 *     `intensity`-as-tile-radius contract the Hide/perception code uses;
 *     a noise loud enough to break Hide is loud enough to alert a sentry.
 *
 * Both surfaces respect the alertness ladder — they only ever RAISE,
 * never lower. Decay is handled by `decayAlertness` in `WorldTick`.
 */
import type { GameContext } from '../GameContext.js';
import type { NpcAlertness, NpcMemory } from '../types.js';
import { Logger } from '../../Logger.js';

/** Default combat-start propagation radius — tile distance, Chebyshev. */
export const FACTION_ALERT_RADIUS = 30;

/**
 * Raise every living same-faction NPC inside `radius` to `alert` and
 * record the source tile in their memory. NPCs already in a higher
 * state stay there (no demotion).
 */
export function pingFactionAlert(
  ctx: GameContext,
  sourceTile: { x: number; y: number },
  factionId: string,
  options?: { tickId?: number; sourceId?: string; radius?: number },
): void {
  const radius = options?.radius ?? FACTION_ALERT_RADIUS;
  const tickId = options?.tickId ?? ctx.state.worldTickCount;
  const sourceId = options?.sourceId ?? 'unknown';
  let pinged = 0;
  for (const npc of ctx.state.npcs) {
    if (npc.hp <= 0) continue;
    if (npc.factionId !== factionId) continue;
    if (chebyshev(npc.tileX, npc.tileY, sourceTile.x, sourceTile.y) > radius) continue;
    raiseAlertness(npc, 'alert', {
      lastAlertTick: tickId,
      lastAlertTile: { ...sourceTile },
      lastAlertSource: sourceId,
      lastAlertKind: 'faction',
    });
    pinged++;
  }
  if (pinged > 0) {
    Logger.log('ai.faction_alert', { factionId, sourceId, tile: sourceTile, pinged, radius });
  }
}

/**
 * Wire awareness into the noise bus. Every `noise` event raises living
 * NPCs within Chebyshev distance `intensity` to `suspicious`. The
 * intensity comes straight from the source — `NOISE_COMBAT = 5` from a
 * swing, `NOISE_SPELL_VERBAL = 5` from a cast, `NOISE_FOOTSTEP = 2`,
 * etc. Faction-agnostic — anyone within earshot reacts. The hook also
 * skips the source NPC itself (an NPC shouldn't be spooked by their own
 * footstep) and dead NPCs.
 *
 * Registered alongside `registerSoundHooks` in `GameEngine.ctor`. Lower
 * priority than the Hide/perception subscriber so the Hide cleanup runs
 * first (the alertness raise is independent of whether the source got
 * de-hidden by the noise).
 */
export function registerAwarenessHooks(ctx: GameContext): void {
  ctx.bus.subscribe('noise', (e) => {
    if (e.intensity <= 0) return;
    const tickId = ctx.state.worldTickCount;
    const sourceId = e.sourceId ?? 'unknown';
    let pinged = 0;
    for (const npc of ctx.state.npcs) {
      if (npc.hp <= 0) continue;
      if (e.sourceId && npc.id === e.sourceId) continue;
      if (chebyshev(npc.tileX, npc.tileY, e.x, e.y) > e.intensity) continue;
      raiseAlertness(npc, 'suspicious', {
        lastAlertTick: tickId,
        lastAlertTile: { x: e.x, y: e.y },
        lastAlertSource: sourceId,
        lastAlertKind: 'noise',
      });
      pinged++;
    }
    if (pinged > 0) {
      Logger.log('ai.noise_alert', { sourceId, tile: { x: e.x, y: e.y }, intensity: e.intensity, pinged });
    }
  }, /*priority*/ 10);
}

/** Internal — raise an NPC's alertness only if the new state is higher
 *  in the ladder; always overwrite the memory pointer. */
function raiseAlertness(
  npc: import('../types.js').NpcState,
  target: NpcAlertness,
  memory: NpcMemory,
): void {
  const current = npc.alertness ?? 'calm';
  if (rank(target) > rank(current)) npc.alertness = target;
  npc.memory = { ...(npc.memory ?? {}), ...memory };
}

function rank(a: NpcAlertness): number {
  return a === 'alert' ? 2 : a === 'suspicious' ? 1 : 0;
}

function chebyshev(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}
