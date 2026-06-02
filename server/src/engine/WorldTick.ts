/**
 * WorldTick — Pass 3c real-time off-camera resolve loop.
 *
 * Runs one SRD round (6 seconds of game-world time per real-time tick) of
 * NPC-vs-NPC combat during exploration phase. NPC-vs-player hostility is
 * detected before the NPC-vs-NPC pass runs — if any living NPC considers the
 * party hostile, the tick escalates straight to turn-based combat via
 * `doStartCombat` instead of resolving NPC-vs-NPC. This keeps a single
 * authoritative path for player combat (the initiative-tracked one) and
 * means a faction shift performed by the AIGM mid-exploration auto-engages
 * on the next tick without the caller needing to also call `trigger_combat`.
 *
 * Each tick, when no party-hostile NPC exists, for every living NPC in
 * random order:
 *   • Pick the nearest hostile NON-PLAYER target via `isHostileTo`.
 *   • Run one full turn through `runEnemyTurn` (move up to speed + one attack).
 *   • Apply damage via `applyEnemyHitToNpc`-equivalent inline logic.
 *
 * Logs are written to the encounter event log; map deltas (movement, kills)
 * surface in the events array the caller broadcasts via `state_update`. The
 * caller is responsible for pause gating (`isWorldTickEligible`) and for
 * pushing the resulting events to the connected client.
 */
import type { GameContext } from './GameContext.js';
import type { GameEvent, NpcState } from './types.js';
import { runEnemyTurn, chebyshev, type EnemyAttackTarget } from './EnemyAI.js';
import { isHostileTo } from './FactionRelations.js';
import { PLAYER_FACTION_ID } from '../../../shared/types.js';
import { applyNpcAttackHit } from './NpcDamage.js';
import { tickActiveZones } from './SpellSystem.js';
import { tickSpellConditionExpiries } from './CombatFlow.js';
import { Logger } from '../Logger.js';

/**
 * Run one round of off-camera NPC-vs-NPC combat. Returns the events the
 * caller should broadcast (entity moves + a final state_update). Mutates the
 * session state in place.
 */
export function runOffCameraTick(ctx: GameContext): GameEvent[] {
  const s = ctx.state;
  const events: GameEvent[] = [];
  const tickStart = Date.now();

  // Age persistent AOE zones one round per real-time tick (6 s) — same cadence
  // as combat rounds. Fog Cloud cast 9 ticks ago in exploration phase fades
  // here exactly as it would after 9 player-turn-starts in combat.
  tickActiveZones(ctx);
  // Tick spell-imposed condition expiries too (Color Spray's blindness etc.).
  // Same cadence — one off-camera tick == one player turn end == 6 seconds.
  tickSpellConditionExpiries(ctx);

  // Escalate to combat if any living NPC turns hostile to the party while
  // the world was running off-camera (most likely an AIGM faction shift or a
  // trigger that flipped relations). The initiative-tracked combat path is
  // the single source of truth for player-engaged fights — the NPC-vs-NPC
  // pass below only runs while the party has no enemies on the map.
  if (s.phase === 'exploring' && anyHostileToParty(ctx)) {
    ctx.doStartCombat(events);
    return events;
  }

  // Sort by initiative-equivalent deterministic key so the same NPC doesn't
  // always get the first swing each tick (would feel rigged). Shuffle by a
  // simple per-id hash + tick counter — tick counter is just Date.now().
  const tickSalt = Date.now();
  const order = [...s.npcs]
    .filter((n) => n.hp > 0)
    .sort((a, b) => hash(a.id, tickSalt) - hash(b.id, tickSalt));

  for (const npc of order) {
    // The npc may have been killed earlier in this tick — re-check.
    if (npc.hp <= 0) continue;

    const target = pickHostileNpcTarget(ctx, npc);
    if (!target) continue;

    const def = ctx.resolveMonsterDef(npc.defId);
    if (!def) continue;

    const targetDef = ctx.resolveMonsterDef(target.defId);
    if (!targetDef) continue;

    const occupied: [number, number][] = s.npcs
      .filter((n) => n !== npc && n.hp > 0)
      .map((n): [number, number] => [n.tileX, n.tileY]);

    const snapshot: EnemyAttackTarget = {
      id: target.id,
      displayName: target.name,
      tileX: target.tileX,
      tileY: target.tileY,
      ac: targetDef.ac,
      hp: target.hp,
      hidden: target.conditions.includes('hidden'),
      dodging: target.conditions.includes('dodging'),
      invisible: target.conditions.includes('invisible'),
      conditions: target.conditions,
      passivePerception: 10,
    };

    const result = runEnemyTurn(npc, def, {
      displayName: npc.name,
      target: snapshot,
      passable: s.map.passable,
      mapCols: s.map.cols,
      mapRows: s.map.rows,
      occupiedTiles: occupied,
    });

    // Commit movement + flush the attacker's log.
    npc.tileX = result.finalTileX;
    npc.tileY = result.finalTileY;
    events.push(...result.events);
    ctx.addLogs(result.logs);

    // Apply damage if the attack landed.
    if (result.attacked && result.isHit && result.attackedTargetId && result.attackedTargetId !== 'player') {
      const live = s.npcs.find((n) => n.id === result.attackedTargetId);
      if (live && live.hp > 0) {
        applyNpcAttackHit({
          ctx, attacker: npc, target: live, attackerDef: def, targetDef, result,
          awardXp: false,
        });
      }
    }
  }

  if (events.length > 0) {
    Logger.log('world.tick_fired', { durationMs: Date.now() - tickStart, eventCount: events.length });
  }
  return events;
}

/**
 * True when any living NPC considers the party hostile. Used to detect the
 * "an off-camera faction shift turned an NPC against the player" case and
 * escalate to turn-based combat instead of running the NPC-vs-NPC pass.
 */
function anyHostileToParty(ctx: GameContext): boolean {
  const s = ctx.state;
  const partyView = { factionId: PLAYER_FACTION_ID } as const;
  return s.npcs.some((n) => n.hp > 0
    && isHostileTo(s, partyView, { factionId: n.factionId, disposition: n.disposition }));
}

/**
 * Find the nearest non-player creature this NPC considers hostile. Returns
 * undefined when there are no hostile NPC targets — typical of a peaceful
 * scene where the only enmity is toward the player (which combat phase
 * handles, not this loop).
 */
function pickHostileNpcTarget(ctx: GameContext, attacker: NpcState): NpcState | undefined {
  const s = ctx.state;
  const attackerView = { factionId: attacker.factionId, disposition: attacker.disposition };
  let best: NpcState | undefined;
  let bestDist = Infinity;
  for (const other of s.npcs) {
    if (other === attacker || other.hp <= 0) continue;
    const otherView = { factionId: other.factionId, disposition: other.disposition };
    if (!isHostileTo(s, attackerView, otherView)) continue;
    const d = chebyshev(attacker.tileX, attacker.tileY, other.tileX, other.tileY);
    if (d < bestDist) { best = other; bestDist = d; }
  }
  return best;
}

/**
 * Fast deterministic id-string hash used to shuffle the turn order each
 * tick. Mixing in `tickSalt` (the wall clock) means consecutive ticks
 * shuffle differently without us threading a counter through state.
 */
function hash(id: string, salt: number): number {
  let h = salt >>> 0;
  for (let i = 0; i < id.length; i++) {
    h = ((h << 5) - h + id.charCodeAt(i)) >>> 0;
  }
  return h;
}
