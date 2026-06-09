/**
 * FactionDef + rumour shapes.
 *
 * Extracted from the original god-file `shared/types.ts` (now a barrel that
 * re-exports every domain module under `shared/types/`).
 */

// Cross-domain imports — keep these explicit so the dependency graph is visible.
import type { EncounterDef } from "./encounter.js";
import type { GameState, NpcState } from "./longRest.js";

//
// Factions are referenced by string id on `NpcState.factionId` and held as a
// numeric **pair-wise relation matrix** on `GameState.factionRelations`. Each
// relation is a standing in the range −100..+100; the engine derives discrete
// states (`hostile`/`neutral`/`friendly`) via fixed thresholds (≤ −30, ≥ +30,
// else neutral). The player is a first-class faction (`PLAYER_FACTION_ID`
// `'party'`) — what used to be "the player's standing with faction X" is now
// `factionRelations.party.X`. Triggers/guards still read this view via the
// existing `adjust_faction_standing` / `faction_standing` plumbing.
//
// Defaults come from per-faction JSON files in `server/data/factions/`;
// individual encounters may override specific pairs via the optional
// `EncounterDef.factionRelations` block.
//
// **Discovery.** The player's identification of each faction is gated:
// `GameState.discoveredFactions` lists faction ids the player has identified
// (via an Insight check on combat-start, or an explicit AIGM
// `reveal_faction` tool). The Target Panel renders `Faction: ???` until the
// id appears in this set.
//
// Rumors are timestamped world events recorded into a global memory log so
// the GM and triggers can reference them later ("the bandit captain heard
// what you did to her brothers").

/** The reserved faction id every player party is a member of. */
export const PLAYER_FACTION_ID = 'party';
/** The reserved individual id of the player character in the relationship layer
 *  (`GameState.relationships`). Distinct from `PLAYER_FACTION_ID`: the player is
 *  an individual (`'player'`) who belongs to the `'party'` faction. */
export const PLAYER_ID = 'player';
/** Standing threshold at or below which a relation reads as `hostile`. */
export const FACTION_HOSTILE_THRESHOLD = -30;
/** Standing threshold at or above which a relation reads as `friendly`. */
export const FACTION_FRIENDLY_THRESHOLD = 30;

/** Discrete view of a faction-pair relation, derived from the numeric standing. */
export type FactionStance = 'hostile' | 'neutral' | 'friendly';

/**
 * A faction the world knows about. One JSON file per faction in
 * `server/data/factions/`. The shipped roster covers the encounter content
 * (party, town_guard, bandits, cultists, undead, monsters, wildlife,
 * townsfolk); adding a new faction is a JSON drop with no code change.
 */
export interface FactionDef {
  /** Stable kebab/snake-case id referenced from `NpcState.factionId`. */
  id: string;
  /** Player-facing display name once discovered ("Town Guard", "Skein Cultists"). */
  name: string;
  /**
   * One-line description shown alongside the name in the Target Panel after
   * discovery. Helps an author keep faction identities distinct.
   */
  description?: string;
  /** Hex display colour used by the UI to tint the faction tag. */
  displayColor: string;
  /**
   * 1..30 renown rating. The Insight DC to identify a member of this faction
   * is `max(1, renown)` — well-known factions are trivially identified,
   * obscure ones require a high check. Ships at 1 across the board so the
   * mechanic is in place but always passes.
   */
  renown: number;
  /**
   * Default standings with other factions, keyed by other-faction id. Values
   * are the `−100..+100` matrix entries. Omitted ids default to 0.
   *
   * Asymmetric — a faction can dislike another without that other faction
   * disliking them back. The engine merges both directions when computing
   * effective relation (`getRelation(a, b)` takes the *minimum* of a→b and
   * b→a so a one-sided hostility still bites).
   */
  defaultRelations?: Record<string, number>;
}

export interface Rumor {
  /** Stable id — used as the dedupe key when authoring triggers off `rumor_propagated`. */
  id: string;
  /** Short human-readable text shown to the GM in CURRENT STATE. */
  text: string;
  /** 1–10 importance score. Determines whether the GM should reference it in narration. */
  salience: number;
  /** Server-relative timestamp (Date.now() at creation). Lets the GM order references chronologically. */
  recordedAt: number;
}
