/**
 * Individual relationship layer — the per-creature scope that sits *in front of*
 * the faction matrix (`FactionRelations.ts`).
 *
 * A **relationship** is a directed scalar `rel(a → b) ∈ [−100, +100]`: "how does
 * individual `a` regard individual `b`." It resolves by layering, highest
 * precedence first:
 *
 *   1. **Individual override** — an explicit link `state.relationships[a][b]`.
 *   2. **Faction baseline** — the raw faction-matrix cell for the two
 *      individuals' factions (same faction ⇒ +100, mirroring `getRelation`).
 *   3. **Default** — 0 (indifferent).
 *
 * "Individual" includes the player (id `PLAYER_ID`, faction `PLAYER_FACTION_ID`).
 *
 * From the resolved scalar we derive combat stance (`viewStance` → fed to
 * `isHostileTo`/`isFriendlyTo`) for ALL pairs — player↔npc AND npc↔npc — and the
 * party-relative `NpcState.disposition` projection (`projectDisposition`). The
 * individual layer is what lets same-faction members be enemies, or
 * opposing-faction members be friends: the link overrides the faction default.
 */
import type { GameState, FactionStance, NpcState, Disposition } from '../../../shared/types.js';
import {
  PLAYER_ID,
  PLAYER_FACTION_ID,
  FACTION_HOSTILE_THRESHOLD,
  FACTION_FRIENDLY_THRESHOLD,
} from '../../../shared/types.js';

/** A creature reduced to what relationship resolution needs: its individual id
 *  and its faction. Cheap to build at every AI call site (no NPC lookup). */
export interface RelationView {
  id: string;
  factionId: string;
}

type RelState = Pick<GameState, 'factionRelations' | 'relationships'>;

function clamp(v: number): number {
  return Math.max(-100, Math.min(100, v));
}

function stanceOf(v: number): FactionStance {
  if (v <= FACTION_HOSTILE_THRESHOLD) return 'hostile';
  if (v >= FACTION_FRIENDLY_THRESHOLD) return 'friendly';
  return 'neutral';
}

/**
 * Directed effective relation `a → b` given both individuals' ids AND factions
 * up front — the hot-path form, no NPC lookups. Individual override wins; else
 * the faction baseline (same faction reads +100, matching `getRelation`); else 0.
 */
function directed(
  state: RelState,
  aId: string, aFactionId: string,
  bId: string, bFactionId: string,
): number {
  const ind = state.relationships?.[aId]?.[bId];
  if (ind !== undefined) return ind;
  if (aFactionId === bFactionId) return 100;
  return state.factionRelations[aFactionId]?.[bFactionId] ?? 0;
}

/**
 * Mutual combat stance between two creatures (worse of the two directions, so a
 * one-sided grudge still makes them fight). This is the single resolution point
 * behind `isHostileTo` / `isFriendlyTo`.
 */
export function viewStance(state: RelState, me: RelationView, other: RelationView): FactionStance {
  if (me.id === other.id) return 'friendly';
  const ab = directed(state, me.id, me.factionId, other.id, other.factionId);
  const ba = directed(state, other.id, other.factionId, me.id, me.factionId);
  return stanceOf(Math.min(ab, ba));
}

// ── Id-keyed forms (tools / guards — fine to do an NPC lookup) ────────────────

/** Resolve an individual id to its faction. `PLAYER_ID` → `PLAYER_FACTION_ID`;
 *  an NPC id → its `factionId`; anything else falls back to the id itself (a
 *  faction-of-one), matching `spawnNpc`'s raw-monster convention. */
export function factionOf(state: Pick<GameState, 'npcs'>, id: string): string {
  if (id === PLAYER_ID) return PLAYER_FACTION_ID;
  const npc = state.npcs?.find((n) => n.id === id);
  return npc?.factionId ?? id;
}

/** Directed numeric relation `a → b`, resolving factions via lookup. For
 *  display, guards, and `adjustIndividualRelation`. */
export function relation(state: RelState & Pick<GameState, 'npcs'>, aId: string, bId: string): number {
  return directed(state, aId, factionOf(state, aId), bId, factionOf(state, bId));
}

/** Mutual stance between two individual ids (faction lookup form). */
export function relationStance(
  state: RelState & Pick<GameState, 'npcs'>,
  aId: string, bId: string,
): FactionStance {
  return viewStance(state, { id: aId, factionId: factionOf(state, aId) }, { id: bId, factionId: factionOf(state, bId) });
}

// ── Mutation ──────────────────────────────────────────────────────────────────

/** Set an explicit individual override `a → b` (clamped). Mirrors to `b → a`
 *  unless `mirror: false`. Sparse — creates rows on demand. */
export function setIndividualRelation(
  state: Pick<GameState, 'relationships'>,
  aId: string, bId: string, value: number,
  opts?: { mirror?: boolean },
): void {
  const v = clamp(value);
  (state.relationships[aId] ??= {})[bId] = v;
  if (opts?.mirror) (state.relationships[bId] ??= {})[aId] = v;
}

/** Shift an individual relation by a delta (resolves the current effective value
 *  first, so adjusting an unset pair starts from the faction baseline). */
export function adjustIndividualRelation(
  state: RelState & Pick<GameState, 'npcs'>,
  aId: string, bId: string, delta: number,
  opts?: { mirror?: boolean },
): void {
  setIndividualRelation(state, aId, bId, relation(state, aId, bId) + delta, opts);
}

// ── Projection: disposition ───────────────────────────────────────────────────

/**
 * Party-relative combat label derived from the relationship layer. `ally` stays
 * an **explicit** state (set by spawn / companion / trigger / AIGM, cleared by
 * combat-end) so a merely-friendly bystander never auto-joins initiative; the
 * `enemy` / `neutral` split is driven by the player↔NPC relationship. Summons
 * keep their authored disposition.
 */
export function projectDisposition(state: RelState, npc: NpcState): Disposition {
  if (npc.summonSpellId) return npc.disposition;
  if (npc.disposition === 'ally') return 'ally';
  const stance = viewStance(
    state,
    { id: npc.id, factionId: npc.factionId },
    { id: PLAYER_ID, factionId: PLAYER_FACTION_ID },
  );
  return stance === 'hostile' ? 'enemy' : 'neutral';
}

/** Recompute and store one NPC's disposition projection. */
export function reprojectDisposition(state: RelState, npc: NpcState): void {
  npc.disposition = projectDisposition(state, npc);
}

/** Recompute every living NPC's disposition projection. Call after a
 *  relationship / faction mutation that can change who is hostile to the party. */
export function reprojectAllDispositions(state: RelState & Pick<GameState, 'npcs'>): void {
  for (const npc of state.npcs) reprojectDisposition(state, npc);
}

/**
 * Migration helper: derive individual `npc → player` links from stored
 * `disposition` for save files written before the relationship layer existed
 * (`enemy → −100`, `ally → +100`, mirrored). Produces the same hostility
 * outcomes on resume.
 */
export function deriveRelationshipsFromDispositions(
  npcs: Array<Pick<NpcState, 'id' | 'disposition'>>,
): Record<string, Record<string, number>> {
  const rel: Record<string, Record<string, number>> = {};
  for (const n of npcs) {
    if (n.disposition === 'enemy') (rel[n.id] ??= {})[PLAYER_ID] = -100;
    else if (n.disposition === 'ally') {
      (rel[n.id] ??= {})[PLAYER_ID] = 100;
      (rel[PLAYER_ID] ??= {})[n.id] = 100;
    }
  }
  return rel;
}

/**
 * Relationship-aware aggro. When the player attacks `victim`, the victim turns
 * hostile to the player, and so does every individual that is *friendly to the
 * victim* (friends defend) — regardless of faction. Individuals who dislike the
 * victim do NOT rally, even same-faction. Replaces the old same-faction
 * `aggroFaction` cascade. Sets individual links and reprojects disposition.
 */
export function aggroOnAttack(state: RelState & Pick<GameState, 'npcs'>, victim: NpcState): void {
  setIndividualRelation(state, victim.id, PLAYER_ID, -100);
  const victimView: RelationView = { id: victim.id, factionId: victim.factionId };
  for (const npc of state.npcs) {
    if (npc.id === victim.id || npc.hp <= 0 || npc.disposition === 'ally' || npc.summonSpellId) continue;
    const friendlyToVictim = viewStance(state, { id: npc.id, factionId: npc.factionId }, victimView) === 'friendly';
    if (friendlyToVictim) setIndividualRelation(state, npc.id, PLAYER_ID, -100);
  }
  reprojectAllDispositions(state);
}
