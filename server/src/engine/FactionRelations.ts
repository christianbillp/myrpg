/**
 * Faction-relation helpers — Pass 1 of the new faction system.
 *
 * The shipping engine (NPC AI, combat targeting, faction aggro) still reads
 * `NpcState.disposition` directly; these helpers exist so subsequent passes
 * can flip readers over to the matrix one at a time without churn. For now,
 * they're consulted by:
 *   • `SessionBuilder` — to seed `GameState.factionRelations` from
 *     `defs.factions[*].defaultRelations`, the optional encounter override,
 *     and any legacy `factionStandings` carried over from an adventure save.
 *   • Server / engine code that wants a "what does X feel about Y?"
 *     lookup without parsing the matrix layout itself.
 */
import type {
  FactionDef, GameState, FactionStance,
} from '../../../shared/types.js';
import {
  PLAYER_FACTION_ID,
  FACTION_HOSTILE_THRESHOLD,
  FACTION_FRIENDLY_THRESHOLD,
} from '../../../shared/types.js';
import { viewStance, type RelationView } from './Relationships.js';

/**
 * Seed the full pair-wise relation matrix from faction defs + optional
 * per-encounter override + optional adventure-save carry-over.
 *
 * Layering order (lowest → highest precedence):
 *   1. Each faction's `defaultRelations` (mirrored to both directions so the
 *      matrix is symmetric on cold-boot — runtime triggers / AIGM tools may
 *      break symmetry later).
 *   2. Adventure-save `seedFactionRelations` (carry from previous chapter).
 *   3. Adventure-save `seedFactionStandings` (legacy `party.X` row).
 *   4. Encounter-level `factionRelations` override.
 *
 * Returns a fresh matrix; callers assign onto `GameState.factionRelations`.
 */
export function buildFactionRelations(
  factions: FactionDef[],
  opts?: {
    seedFactionRelations?: Record<string, Record<string, number>>;
    seedFactionStandings?: Record<string, number>;
    encounterOverride?: Record<string, Record<string, number>>;
  },
): Record<string, Record<string, number>> {
  const matrix: Record<string, Record<string, number>> = {};

  // Every known faction has its own row, even if empty — keeps subsequent
  // lookups predictable.
  for (const f of factions) matrix[f.id] = {};

  // Layer 1 — symmetric defaults from each faction def.
  for (const f of factions) {
    for (const [other, value] of Object.entries(f.defaultRelations ?? {})) {
      setBoth(matrix, f.id, other, value, /* mirror */ true);
    }
  }

  // Layer 2 — adventure-save full matrix carry-over.
  if (opts?.seedFactionRelations) {
    for (const [a, row] of Object.entries(opts.seedFactionRelations)) {
      for (const [b, v] of Object.entries(row)) {
        setBoth(matrix, a, b, v, /* mirror */ false);
      }
    }
  }

  // Layer 3 — legacy `factionStandings` (party-only column).
  if (opts?.seedFactionStandings) {
    for (const [other, v] of Object.entries(opts.seedFactionStandings)) {
      setBoth(matrix, PLAYER_FACTION_ID, other, v, /* mirror */ true);
    }
  }

  // Layer 4 — encounter-level override (highest precedence; asymmetric allowed).
  if (opts?.encounterOverride) {
    for (const [a, row] of Object.entries(opts.encounterOverride)) {
      for (const [b, v] of Object.entries(row)) {
        setBoth(matrix, a, b, v, /* mirror */ false);
      }
    }
  }

  return matrix;
}

/**
 * Effective numeric standing of `a` toward `b`. Takes the worse (lower) of
 * the two directions in the matrix — so a one-sided grudge still bites.
 * Unknown factions / unknown pairs default to 0 (neutral).
 */
export function getRelation(
  state: Pick<GameState, 'factionRelations'>,
  a: string, b: string,
): number {
  if (a === b) return 100;  // Self-faction reads as fully friendly.
  const ab = state.factionRelations[a]?.[b];
  const ba = state.factionRelations[b]?.[a];
  if (ab === undefined && ba === undefined) return 0;
  if (ab === undefined) return ba!;
  if (ba === undefined) return ab;
  return Math.min(ab, ba);
}

/**
 * Discrete stance derived from the numeric relation. Thresholds live on the
 * `FACTION_*_THRESHOLD` constants so they can be tuned from one place.
 */
export function getStance(
  state: Pick<GameState, 'factionRelations'>,
  a: string, b: string,
): FactionStance {
  const v = getRelation(state, a, b);
  if (v <= FACTION_HOSTILE_THRESHOLD) return 'hostile';
  if (v >= FACTION_FRIENDLY_THRESHOLD) return 'friendly';
  return 'neutral';
}

/** Shortcut for `getStance(...) === 'hostile'`. */
export function isHostile(
  state: Pick<GameState, 'factionRelations'>,
  a: string, b: string,
): boolean {
  return getStance(state, a, b) === 'hostile';
}

/** Shortcut for `getStance(...) === 'friendly'`. */
export function isFriendly(
  state: Pick<GameState, 'factionRelations'>,
  a: string, b: string,
): boolean {
  return getStance(state, a, b) === 'friendly';
}

/**
 * Returns true when `me` considers `other` hostile. Resolves through the
 * **individual relationship layer** (`Relationships.viewStance`): an explicit
 * `relationships[a][b]` link wins, else the faction baseline, else neutral. This
 * is what lets same-faction members be enemies (an individual −link overriding a
 * friendly faction default) and opposing-faction members be friends.
 *
 * Both views carry an individual `id` and a `factionId`. Pass the player as
 * `{ id: PLAYER_ID, factionId: PLAYER_FACTION_ID }`.
 */
export function isHostileTo(
  state: Pick<GameState, 'factionRelations' | 'relationships'>,
  me: RelationView,
  other: RelationView,
): boolean {
  return viewStance(state, me, other) === 'hostile';
}

/**
 * Returns true when `me` and `other` are allied. Mirror of `isHostileTo` on the
 * friendly side. Used by ally-OA detection, pack tactics, and ally turn target
 * filtering.
 */
export function isFriendlyTo(
  state: Pick<GameState, 'factionRelations' | 'relationships'>,
  me: RelationView,
  other: RelationView,
): boolean {
  return viewStance(state, me, other) === 'friendly';
}

/**
 * Mutate the matrix and (when the change touches the `party` row) keep the
 * legacy `factionStandings` projection in sync so existing readers stay
 * correct without modification. Clamps to ±100. Mirrors to both directions
 * unless `mirror: false` is requested (e.g. one-sided AIGM-authored shifts).
 */
export function setRelation(
  state: { factionRelations: Record<string, Record<string, number>>; factionStandings?: Record<string, number> },
  a: string, b: string, value: number,
  opts?: { mirror?: boolean },
): void {
  const v = Math.max(-100, Math.min(100, value));
  const mirror = opts?.mirror ?? true;
  (state.factionRelations[a] ??= {})[b] = v;
  if (mirror) (state.factionRelations[b] ??= {})[a] = v;
  if (state.factionStandings) {
    if (a === PLAYER_FACTION_ID) state.factionStandings[b] = v;
    if (mirror && b === PLAYER_FACTION_ID) state.factionStandings[a] = v;
  }
}

/** Convenience: shift a relation by a delta and clamp. Wraps `setRelation`. */
export function adjustRelation(
  state: { factionRelations: Record<string, Record<string, number>>; factionStandings?: Record<string, number> },
  a: string, b: string, delta: number,
  opts?: { mirror?: boolean },
): void {
  const current = getRelation(state as Pick<GameState, 'factionRelations'>, a, b);
  setRelation(state, a, b, current + delta, opts);
}

/**
 * Back-fill the faction matrix from spawned NPCs' authored `disposition`: an
 * `enemy` makes its faction hostile to the party, an `ally` friendly — but only
 * when the faction↔party cell isn't already set (faction defaults / encounter
 * overrides win). This keeps `disposition` a **faction-level** default so an
 * enemy fights the player AND the player's allies; per-individual exceptions
 * live in the relationship layer (`GameState.relationships`) on top.
 */
export function seedFactionRelationsFromDispositions(
  matrix: Record<string, Record<string, number>>,
  npcs: Array<{ factionId: string; disposition: FactionStance | 'ally' | 'neutral' | 'enemy' }>,
): void {
  for (const n of npcs) {
    if (matrix[n.factionId]?.[PLAYER_FACTION_ID] !== undefined) continue;
    if (n.disposition === 'enemy') setBoth(matrix, n.factionId, PLAYER_FACTION_ID, -100, true);
    else if (n.disposition === 'ally') setBoth(matrix, n.factionId, PLAYER_FACTION_ID, 100, true);
  }
}

/**
 * Project the player faction's row into the legacy `factionStandings` shape.
 * Used at session-build time and after any mutation that touches the `party`
 * row so existing `faction_standing` guards + `adjust_faction_standing` tool
 * calls keep working without modification.
 */
export function projectFactionStandings(
  factionRelations: Record<string, Record<string, number>>,
): Record<string, number> {
  return { ...(factionRelations[PLAYER_FACTION_ID] ?? {}) };
}

// ── Internal ────────────────────────────────────────────────────────────────

/**
 * Write `matrix[a][b] = v` and optionally mirror to `matrix[b][a] = v`. Auto-
 * creates the inner records on demand. Mirroring is the right default for
 * faction-def declarations + party standings (symmetric); we skip it for
 * encounter overrides and adventure-save carry-overs so one-sided shifts
 * stay one-sided.
 */
function setBoth(
  matrix: Record<string, Record<string, number>>,
  a: string, b: string, v: number, mirror: boolean,
): void {
  (matrix[a] ??= {})[b] = v;
  if (mirror) (matrix[b] ??= {})[a] = v;
}
