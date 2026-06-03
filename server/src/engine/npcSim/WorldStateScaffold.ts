/**
 * WorldStateScaffold — types + migration plan for Step 7 of the NPC
 * simulation rollout. NOT WIRED YET. Read by future contributors before
 * lifting world-persistent NPC state out of per-encounter GameState.
 *
 * ── Why this scaffold exists ──────────────────────────────────────────
 *
 * Today every NPC lives on `GameState.npcs`, and `GameState` is scoped
 * to one encounter. That means:
 *
 *   • A routine-bearing tavern keeper resets to phase = morning the
 *     instant the player enters the encounter again.
 *   • An NPC alerted by faction ping in encounter A forgets they were
 *     alerted when the player crosses into encounter B.
 *   • Off-camera ticks can't run for NPCs in encounters the player
 *     isn't currently in.
 *
 * Step 7 splits the world model into THREE distinct registries with a
 * sharp boundary between them:
 *
 *   ┌──────────────────────┐    ┌──────────────────────┐    ┌──────────────────────┐
 *   │   WorldRegistry      │    │   EncounterState     │    │   PartyState         │
 *   │   (persistent)       │ ←→ │   (per-encounter)    │ ←→ │   (player-following) │
 *   └──────────────────────┘    └──────────────────────┘    └──────────────────────┘
 *
 * NPCs migrate ACROSS the boundary at scene entry/exit:
 *
 *   • Player enters encounter X:
 *       WorldRegistry.npcsForRegion(X) → spawn into EncounterState.npcs.
 *       Snapshot their last-known world state (tile, alertness, memory).
 *   • Player leaves encounter X:
 *       EncounterState.npcs → write back into WorldRegistry, preserving
 *       alertness, memory, simState. World-tick continues to advance
 *       these NPCs at a coarser LOD (see below).
 *
 * ── Level Of Detail (LOD) ─────────────────────────────────────────────
 *
 * Three LOD tiers govern how an NPC is simulated based on the player's
 * proximity / focus. The same NPC can transition between tiers without
 * being respawned — the simState is preserved across tiers.
 */

import type { NpcAlertness, NpcMemory, RoutineEntry } from '../types.js';

/** Local mirror of the inline `simState` shape on `NpcState`. Step 7
 *  should promote this to a named export from `shared/types/longRest`. */
export interface NpcSimState {
  activeTaskId: string | null;
  lastTickId: number;
}

/**
 * LOD tiers, from most-detailed to least:
 *
 *   • `near`    — full sim. NPC is in the player's active encounter.
 *                 Every off-camera tick (real-time, 6s) runs their task,
 *                 movement is tile-accurate, alerts are propagated.
 *
 *   • `region`  — coarse sim. NPC is in a region the player isn't
 *                 currently in, but it's "warm" (recently visited, or
 *                 adjacent). Tasks tick once every N world-ticks (default
 *                 6 → 36s game time per coarse tick), movement is
 *                 region-relative not tile-accurate, alerts decay
 *                 normally.
 *
 *   • `dormant` — no sim. NPC is in a "cold" region the player has never
 *                 visited or hasn't visited in a long time. State frozen
 *                 to whatever it was at last snapshot. Promoted to
 *                 `region` when the player approaches.
 *
 * Promotion is governed by `worldRegion.lodPolicy` (see below) — typically
 * "near = active encounter, region = encounter map graph within K hops,
 * dormant = everything else".
 */
export type NpcLod = 'near' | 'region' | 'dormant';

/**
 * A region is a named slice of the world map (one encounter, one town,
 * one wilderness tile). Persistent NPCs are stored grouped by region so
 * the per-region LOD policy can be evaluated cheaply.
 */
export interface WorldRegionId { readonly value: string; }

/**
 * A persistent NPC record stored in `WorldRegistry`. Differs from
 * `NpcState` in three ways:
 *   1. No HP/conditions/initiative — those belong to combat, which is
 *      always `near` LOD.
 *   2. No combatLabel — assigned per-encounter on spawn.
 *   3. `regionId` is required — tells the WorldRegistry which bucket
 *      this NPC lives in for proximity / LOD calculations.
 *
 * Open question for Step 7 implementation: do we hold a SINGLE union of
 * persistent + transient fields and clear the transient ones on encounter
 * exit, or do we maintain two separate types (`PersistentNpc` vs.
 * `EncounterNpc`) and translate between them? Leaning toward the union
 * type for simplicity — `applyEquipment` and friends already tolerate
 * undefined transient fields.
 */
export interface PersistentNpc {
  id: string;
  defId: string;
  regionId: WorldRegionId;
  tileX: number;
  tileY: number;
  factionId: string;
  routine?: RoutineEntry[];
  simState?: NpcSimState;
  alertness?: NpcAlertness;
  memory?: NpcMemory;
  /** Last world tick this NPC was simulated at any LOD. Used to detect
   *  when an NPC has been dormant long enough to qualify for cold
   *  cleanup (e.g. routine cleared, alert decayed manually). */
  lastSimTickId?: number;
}

/**
 * The world-persistent NPC registry. Sits on `WorldState` (NEW — Step 7
 * adds this top-level state container; today `GameState` is the only
 * top-level state).
 *
 * Open question: where do dispositions live? Today disposition is per-
 * encounter (combat-resolved). For world NPCs we want a "world
 * disposition" that survives encounter cycling. Likely answer: keep
 * the per-encounter disposition for combat resolution, AND mirror an
 * authored `factionId` + `worldDisposition` on `PersistentNpc` so the
 * spawn pass at encounter entry can re-derive the combat disposition.
 */
export interface WorldRegistry {
  npcs: Map<string, PersistentNpc>;
  byRegion: Map<string, Set<string>>;
  /** Policy callback the world tick uses to compute every NPC's LOD
   *  for the current frame. Default impl: any NPC in the player's
   *  active encounter is `near`; anything in a region within K
   *  encounter-graph hops is `region`; everything else is `dormant`. */
  lodFor: (npc: PersistentNpc, currentEncounterRegion: WorldRegionId | null) => NpcLod;
}

/**
 * Read-only view passed to LOD-aware tick code so it can't mutate the
 * registry while iterating. Step 7 should enforce this with a frozen
 * interface, not a runtime `Object.freeze` (cheaper).
 */
export type ReadonlyWorldRegistry = Readonly<Pick<WorldRegistry, 'npcs' | 'byRegion' | 'lodFor'>>;

/**
 * ── Migration plan (high-level, for the engineer who picks this up) ───
 *
 * Phase A — Plumbing.
 *   1. Introduce `WorldState` as the new top-level container.
 *      `WorldState = { regions: Map<regionId, EncounterState>, registry: WorldRegistry, party: PartyState, worldTickCount, dayPhase }`
 *      For now, `regions` holds exactly ONE encounter (the active one)
 *      and `registry` is empty — feature-parity with today.
 *   2. Move `worldTickCount` + `dayPhase` from `GameState` to
 *      `WorldState`. `EncounterState` becomes "GameState minus the
 *      world fields" — the existing `state.npcs` continues to live on
 *      `EncounterState`.
 *
 * Phase B — Registry population.
 *   3. Add a one-shot "publish to world" pass at encounter exit that
 *      copies routine-bearing + alerted NPCs from `EncounterState.npcs`
 *      into `WorldRegistry`. Cull pure combatants (enemy NPCs that
 *      survived but have no routine) — they don't persist across
 *      encounters today and we don't want to change that.
 *   4. Add the inverse pass at encounter entry: pull every NPC whose
 *      `regionId` matches the encounter from `WorldRegistry` into a
 *      transient `EncounterState.npcs` slot. SpawnHelpers becomes the
 *      bridge.
 *
 * Phase C — LOD.
 *   5. Extend WorldTick to iterate the FULL `WorldRegistry`, computing
 *      LOD per-NPC each tick. `near` NPCs hit the existing tick path
 *      verbatim. `region` NPCs get a stripped-down tick that only
 *      advances the active task by N tiles at a time and decays
 *      alertness. `dormant` NPCs skip the tick entirely.
 *   6. Add a `LOD_TICK_BATCHING` constant — `region` NPCs only tick
 *      once every K real-time ticks to amortise CPU.
 *
 * Phase D — Determinism + tests.
 *   7. Verify `SimRng.forNpcTick(tickId, npcId)` continues to give
 *      reproducible results when the same NPC alternates between
 *      `near` and `region` LOD. The tickId stream is shared, so the
 *      reproducibility contract holds — but verify with a fixture.
 *   8. Add a snapshot test: pin a WorldRegistry of ~20 NPCs across
 *      3 regions, advance 200 ticks, snapshot the final state.
 *      Replays should match byte-for-byte.
 *
 * ── Out of scope for Step 7 ───────────────────────────────────────────
 *
 *   • Cross-region pathfinding (e.g. "tavern keeper walks from town to
 *     dungeon"). That's Step 8 — requires the encounter graph to be
 *     materialised first.
 *   • Player-controlled time-of-day scrubbing. The world tick cadence
 *     is real-time only.
 *   • Save/load atomicity across regions. Today save/load is GameState-
 *     only; Step 7 must wrap WorldState too, but the binary format
 *     decision is deferred until we have a real save path.
 */
export const WORLD_STATE_SCAFFOLD_VERSION = 1 as const;
