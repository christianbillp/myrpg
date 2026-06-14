/**
 * Ambient NPC-to-NPC banter (US-129).
 *
 * A *banter pack* is a data file of short scripted *exchanges* (2-4 lines)
 * between two nearby idle NPCs — gossip, small talk, bickering — that the
 * world-tick simulation plays out line by line to make a populated scene feel
 * alive. Distinct from the player-facing `ConversationDef` graph: banter has
 * no choices, no checks, no mechanical effects. It is pure flavour surfaced
 * through the same `npc_speech` bubble + Event Log channel directed speech uses.
 *
 * Selection is deterministic: the world tick's seeded `SimRng` picks the pack
 * and exchange, so the same world state + tick id always yields the same line.
 */

/** Social relation between the two speakers, resolved via `viewStance`. A pack
 *  is eligible only when the pair's relation matches. */
export type BanterRelation = 'friendly' | 'neutral' | 'hostile';

/** One line of an exchange. `speaker` selects which of the paired NPCs delivers
 *  it: `a` is the initiator, `b` the partner. */
export interface BanterLine {
  speaker: 'a' | 'b';
  /** Line text. `{a}` / `{b}` are replaced with the speakers' display names. */
  text: string;
}

/** An ordered back-and-forth, played one line per world tick. */
export interface BanterExchange {
  lines: BanterLine[];
}

/**
 * Selection filters for a pack. All present fields must match for the pack to
 * be eligible for a given pair; absent fields don't constrain.
 */
export interface BanterPack {
  id: string;
  /** Required relation between the two speakers. */
  relation: BanterRelation;
  /** When true, both NPCs must share a faction (war-band grumbling, etc.). */
  sameFaction?: boolean;
  /** When set, at least one speaker must belong to this faction id. */
  faction?: string;
  /** Restrict to these day phases (e.g. `["evening","night"]`). */
  dayPhases?: string[];
  exchanges: BanterExchange[];
}

/**
 * An in-flight ambient conversation tracked on `GameState`. Transient — it
 * exists only while two NPCs are mid-exchange; cleared when the exchange ends
 * or is interrupted (combat, alertness, separation).
 */
export interface ActiveBanter {
  /** Initiator NPC id (`a`). */
  speakerA: string;
  /** Partner NPC id (`b`). */
  speakerB: string;
  packId: string;
  exchangeIndex: number;
  /** Index of the NEXT line to deliver. */
  lineCursor: number;
}
