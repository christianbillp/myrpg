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
import {
  NpcTickRunner, SimRng, FollowPlayerTask, WaitHereTask, IdleTask,
  InvestigateTask, AlertTask,
  tasksForRoutine,
} from './npcSim/index.js';
import { ALERT_DECAY_TICKS, DAY_PHASE_CYCLE, TICKS_PER_DAY_PHASE } from '../../../shared/types.js';

/**
 * Run one round of off-camera NPC-vs-NPC combat. Returns the events the
 * caller should broadcast (entity moves + a final state_update). Mutates the
 * session state in place.
 */
export function runOffCameraTick(ctx: GameContext): GameEvent[] {
  const s = ctx.state;
  const events: GameEvent[] = [];
  const tickStart = Date.now();

  // Bump the monotonic tick counter ONCE per off-camera tick. Every NPC
  // sim decision pulls a seeded RNG keyed off (worldTickCount, npc.id),
  // so the counter must increment exactly once per tick — not per NPC,
  // not per event. Survives save/load (it's on GameState).
  s.worldTickCount = (s.worldTickCount ?? 0) + 1;
  const tickId = s.worldTickCount;

  // Roll the day phase over every TICKS_PER_DAY_PHASE ticks. Routine-
  // bearing NPCs read `s.dayPhase` each tick to decide what they should
  // be doing. Per-encounter scope today — the cycle restarts at
  // `morning` on every session. Cross-encounter persistence is part of
  // step 7's WorldState refactor.
  const prevPhase = s.dayPhase ?? 'morning';
  const phaseIdx = Math.floor((s.worldTickCount - 1) / TICKS_PER_DAY_PHASE) % DAY_PHASE_CYCLE.length;
  s.dayPhase = DAY_PHASE_CYCLE[phaseIdx];
  if (s.dayPhase !== prevPhase) {
    Logger.log('world.day_phase_changed', { from: prevPhase, to: s.dayPhase, tickId });
  }

  // Age persistent AOE zones one round per real-time tick (6 s) — same cadence
  // as combat rounds. Fog Cloud cast 9 ticks ago in exploration phase fades
  // here exactly as it would after 9 player-turn-starts in combat.
  tickActiveZones(ctx);
  // Tick spell-imposed condition expiries too (Color Spray's blindness etc.).
  // Same cadence — one off-camera tick == one player turn end == 6 seconds.
  tickSpellConditionExpiries(ctx);

  // NPC sim pass — only during exploration. Ticks every NPC the sim
  // engine cares about: companions (player-driven via COMPANION chip)
  // AND routine-bearing NPCs (autonomous daily schedule). Combat skips
  // the sim entirely — combat companion routing goes through the existing
  // ally AI path, and routine NPCs freeze on their current tile.
  if (s.phase === 'exploring') {
    runSimNpcTicks(ctx, tickId, events);
  }

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

/**
 * Run one NPC-sim tick for every NPC the engine cares about. Two kinds
 * of NPC qualify:
 *
 *   • **Companions** (`npc.companion` set) — player-controllable. Task
 *     pool: Idle + FollowPlayer + WaitHere; player overrides via the
 *     COMPANION chip are consumed inline.
 *   • **Routine-bearing NPCs** (`npc.routine` set) — autonomous. Task
 *     pool comes from `tasksForRoutine(npc, dayPhase)` so the active
 *     row for the current day phase wins.
 *
 * Both paths run on the same `NpcTickRunner`, with the same seeded RNG
 * and the same decision-logging. The runner persists per-NPC sim state
 * (`activeTaskId`, `lastTickId`) across ticks so a task resumes mid-walk
 * after a save/load.
 *
 * An NPC could in principle hold BOTH `companion` and `routine` (e.g. a
 * routine-bearing tavern keeper the player has recruited). The companion
 * path takes priority because the player should always be able to
 * direct an NPC they've explicitly bound; the routine kicks in again
 * once `set_npc_companion isCompanion: false` strips the binding.
 */
function runSimNpcTicks(ctx: GameContext, tickId: number, events: GameEvent[]): void {
  const s = ctx.state;
  // Decay first so an NPC that JUST got pinged this tick keeps its
  // raised state — the pingFactionAlert/pingNoise calls have already
  // refreshed `lastAlertTick` to `tickId`, so the decay check below
  // (which compares against ALERT_DECAY_TICKS) won't demote them.
  decayAlertness(ctx, tickId);
  for (const npc of s.npcs) {
    if (npc.hp <= 0) continue;
    if (npc.companion) {
      runCompanionTick(ctx, npc, tickId, events);
    } else if (npc.routine && npc.routine.length > 0) {
      runRoutineTick(ctx, npc, tickId, events);
    } else if ((npc.alertness ?? 'calm') !== 'calm') {
      runAlertedAmbientTick(ctx, npc, tickId, events);
    }
  }
}

function runCompanionTick(ctx: GameContext, npc: import('./types.js').NpcState, tickId: number, events: GameEvent[]): void {
  if (!npc.companion) return;
  const tasks = [IdleTask, new FollowPlayerTask(npc.companion.followMode), WaitHereTask];
  const registry = { tasks, override: npc.companion.override };
  const sim = { ctx, npc, rng: SimRng.forNpcTick(tickId, npc.id), events, tickId };
  NpcTickRunner.run(sim, registry, npc.companion.simState);
  if (npc.companion.override && npc.companion.simState.activeTaskId === null) {
    npc.companion.override = undefined;
  }
}

function runRoutineTick(ctx: GameContext, npc: import('./types.js').NpcState, tickId: number, events: GameEvent[]): void {
  // Routine NPCs hold their own `simState` directly on `NpcState`
  // (companions hold it on `companion.simState`). Initialise lazily so
  // legacy save files that pre-date the field don't choke on a missing
  // pointer. No `override` — autonomy only.
  if (!npc.simState) npc.simState = { activeTaskId: null, lastTickId: 0 };
  const tasks = tasksForRoutine(npc, ctx.state.dayPhase);
  const registry = { tasks };
  const sim = { ctx, npc, rng: SimRng.forNpcTick(tickId, npc.id), events, tickId };
  NpcTickRunner.run(sim, registry, npc.simState);
}

/**
 * Tick path for an "ambient" NPC: no companion binding, no routine, but
 * something raised their alertness (a faction ping from combat start, a
 * noise event). Task pool is just Idle + Investigate + Alert — once the
 * alertness decays back to `calm`, the next tick will pick Idle and the
 * NPC will fall off the sim until something else wakes them.
 */
function runAlertedAmbientTick(ctx: GameContext, npc: import('./types.js').NpcState, tickId: number, events: GameEvent[]): void {
  if (!npc.simState) npc.simState = { activeTaskId: null, lastTickId: 0 };
  const tasks = [IdleTask, InvestigateTask, AlertTask];
  const registry = { tasks };
  const sim = { ctx, npc, rng: SimRng.forNpcTick(tickId, npc.id), events, tickId };
  NpcTickRunner.run(sim, registry, npc.simState);
}

/**
 * Step every NPC's alertness one rung down the ladder when their last
 * alert is older than the configured decay window. `alert` decays to
 * `suspicious` first, `suspicious` decays to `calm`. The memory pointer
 * (lastAlertTile etc.) is preserved as long as the NPC stays non-calm so
 * Investigate can still walk toward it; once an NPC returns to `calm`
 * the memory is cleared so the next ping starts fresh.
 *
 * Decay windows live in `ALERT_DECAY_TICKS` (shared with the client).
 */
function decayAlertness(ctx: GameContext, tickId: number): void {
  const s = ctx.state;
  for (const npc of s.npcs) {
    if (npc.hp <= 0) continue;
    const state = npc.alertness ?? 'calm';
    if (state === 'calm') continue;
    const last = npc.memory?.lastAlertTick ?? 0;
    const age = tickId - last;
    const window = ALERT_DECAY_TICKS[state];
    if (age < window) continue;
    if (state === 'alert') {
      npc.alertness = 'suspicious';
      Logger.log('ai.alertness_decayed', { npcId: npc.id, to: 'suspicious', tickId });
    } else {
      npc.alertness = 'calm';
      npc.memory = undefined;
      Logger.log('ai.alertness_decayed', { npcId: npc.id, to: 'calm', tickId });
    }
  }
}
