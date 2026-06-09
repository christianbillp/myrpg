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
import { PLAYER_FACTION_ID, PLAYER_ID } from '../../../shared/types.js';
import { applyNpcAttackHit } from './NpcDamage.js';
import { tickActiveZones } from './SpellSystem.js';
import { tickSpellConditionExpiries } from './CombatFlow.js';
import { Logger } from '../Logger.js';
import {
  NpcTickRunner, SimRng, FollowPlayerTask, WaitHereTask, IdleTask,
  InvestigateTask, AlertTask, WalkToTask,
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
      blocksMovement: s.map.blocksMovement,
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
  const partyView = { id: PLAYER_ID, factionId: PLAYER_FACTION_ID } as const;
  return s.npcs.some((n) => n.hp > 0
    && isHostileTo(s, partyView, { id: n.id, factionId: n.factionId }));
}

/**
 * Find the nearest non-player creature this NPC considers hostile. Returns
 * undefined when there are no hostile NPC targets — typical of a peaceful
 * scene where the only enmity is toward the player (which combat phase
 * handles, not this loop).
 */
function pickHostileNpcTarget(ctx: GameContext, attacker: NpcState): NpcState | undefined {
  const s = ctx.state;
  const attackerView = { id: attacker.id, factionId: attacker.factionId };
  let best: NpcState | undefined;
  let bestDist = Infinity;
  for (const other of s.npcs) {
    if (other === attacker || other.hp <= 0) continue;
    const otherView = { id: other.id, factionId: other.factionId };
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

/**
 * Tile-movement budget per world tick = floor(speed_ft / 5). Mirrors
 * the SRD round-based movement budget (one world tick = one SRD round =
 * 6 seconds = full speed allowance). A speed-30 creature gets 6 tiles
 * per tick; speed-25 gets 5; speed-40 gets 8. Minimum 1 so an exhausted
 * speed-0 NPC still gets one attempted action per tick.
 */
function tilesPerTick(ctx: GameContext, npc: import('./types.js').NpcState): number {
  const def = ctx.resolveMonsterDef(npc.defId);
  return Math.max(1, Math.floor((def?.speed ?? 30) / 5));
}

/**
 * Pump the runner up to `tilesPerTick(npc)` times per world tick, so
 * sim NPCs cover their full SRD speed (30 ft = 6 tiles for a typical
 * creature). Breaks early when:
 *   • the active task signals 'done' (activeTaskId cleared), or
 *   • the NPC didn't actually move in the iteration — a stationary
 *     task (Idle, WaitHere) won the scorer, or the next step was
 *     blocked. Either way there's no point burning more budget.
 *
 * The runner's RNG is keyed by (tickId, npcId), so all iterations
 * within a tick share the same seed. Tasks today don't consume RNG
 * during nextAction, so this is deterministic and stable.
 */
function pumpSpeedBudget(
  ctx: GameContext,
  npc: import('./types.js').NpcState,
  tickId: number,
  events: GameEvent[],
  registry: import('./npcSim/index.js').NpcTaskRegistry,
  simState: { activeTaskId: string | null; lastTickId: number },
): void {
  const budget = tilesPerTick(ctx, npc);
  for (let i = 0; i < budget; i++) {
    const beforeX = npc.tileX;
    const beforeY = npc.tileY;
    const sim = { ctx, npc, rng: SimRng.forNpcTick(tickId, npc.id), events, tickId };
    NpcTickRunner.run(sim, registry, simState);
    if (simState.activeTaskId === null) break;
    if (npc.tileX === beforeX && npc.tileY === beforeY) break;
  }
}

/**
 * Run one sim tick for a single companion NPC. Exported so the
 * `companionCommand` player action can fire it synchronously after
 * setting the override — without this, the player waits up to 6 s
 * (one world-tick interval) before the companion starts moving. Pumps
 * the runner against the NPC's full speed budget so the first move
 * burst covers a full SRD round of distance.
 */
export function runCompanionTick(ctx: GameContext, npc: import('./types.js').NpcState, tickId: number, events: GameEvent[]): void {
  if (!npc.companion) return;
  const tasks: import('./npcSim/index.js').NpcTask[] = [
    IdleTask,
    new FollowPlayerTask(npc.companion.followMode),
    WaitHereTask,
  ];
  // MOVE TO override carries the destination on the override itself —
  // build the matching WalkToTask on the fly so the runner can find it
  // by id (`companion_move_to`) without us having to store another
  // task instance on the companion state.
  const override = npc.companion.override;
  if (override?.kind === 'move_to') {
    tasks.push(new WalkToTask(override.tileX, override.tileY, 'companion_move_to'));
  }
  const registry = { tasks, override };
  pumpSpeedBudget(ctx, npc, tickId, events, registry, npc.companion.simState);
  // Override-end handling. The runner clears `activeTaskId` when the
  // active task returns 'done'. What happens next depends on which
  // override was running:
  //   • move_to → convert to WAIT so the companion stays positioned
  //               where the player put them. This is what makes
  //               "set up positions" actually feel like positioning
  //               (otherwise FollowPlayerTask immediately drags them
  //               back to the player on the very next tick).
  //   • wait    → KEEP the override. WaitHereTask returns 'done' every
  //               tick by design (it has nothing to do), but the
  //               player's command to wait persists until they cancel
  //               it with another command. Without this branch the
  //               companion would bolt after the player on the very
  //               next tick.
  //   • everything else → clear the override so the next tick
  //               re-enters the autonomous scorer.
  if (override && npc.companion.simState.activeTaskId === null) {
    if (override.kind === 'move_to') {
      npc.companion.override = { kind: 'wait' };
    } else if (override.kind === 'wait' || override.kind === 'attack' || override.kind === 'cast') {
      // Persist:
      //   • wait — the player's hold command lasts until they cancel it.
      //   • attack / cast — combat-only overrides; not actionable in
      //     exploration (no matching task in the registry), so the
      //     exploration tick must leave them alone for the combat path
      //     in NpcTurnRunners to consume on the companion's next turn.
    } else {
      // follow — companion has caught up; autonomous scorer takes over.
      npc.companion.override = undefined;
    }
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
  pumpSpeedBudget(ctx, npc, tickId, events, registry, npc.simState);
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
  pumpSpeedBudget(ctx, npc, tickId, events, registry, npc.simState);
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
