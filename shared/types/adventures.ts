/**
 * AdventureDef + chapter list.
 *
 * Extracted from the original god-file `shared/types.ts` (now a barrel that
 * re-exports every domain module under `shared/types/`).
 */

// Cross-domain imports — keep these explicit so the dependency graph is visible.
import type { EncounterDef } from "./encounter.js";
import type { WorldFlagValue } from "./engineEvents.js";
import type { Rumor } from "./factions.js";
import type { GameState } from "./gameState.js";

//
// An adventure is a string of encounters with overarching narrative and
// cross-chapter state (world flags, faction standings, rumors, GM-summary
// memory). Each chapter references an existing `EncounterDef`; chapters are
// linear by default and an optional `unlockedBy` guard lets later chapters
// gate on world flags for soft branching. Authored in
// `server/data/adventures/*.json`; the live adventure save for a character
// lives in `server/data/saves/{characterId}_adventure.json`.

export interface AdventureChapter {
  /** Unique within the adventure. Used in save files and chapter-advance routes. */
  id: string;
  /** Title shown in HUD + setup-screen progress dots. */
  title: string;
  /** Encounter id from `server/data/encounters/`. */
  encounterId: string;
  /**
   * Optional guard: if present, the chapter only unlocks when the guard
   * holds. `flag_set: name` means worldFlags[name] is defined; `flag_equals`
   * checks value. Lets adventure authors gate chapters on choices in
   * earlier chapters.
   */
  unlockedBy?:
    | { flag_set: string }
    | { flag_equals: { name: string; value: WorldFlagValue } };
  /**
   * Optional named flag that, when set, marks this chapter complete (in
   * addition to the default combat-ended detection). Lets exploration /
   * dialogue chapters define their own completion condition.
   */
  completionFlag?: string;
}

export interface AdventureDef {
  id: string;
  title: string;
  description: string;
  /** Player-facing prose shown on the adventure card and in the intro overlay before chapter 1. */
  introduction: string;
  chapters: AdventureChapter[];
  /** Optional AI Game Master context — backstory, factions, themes, plot
   *  hooks. Surfaced into the AIGM prompt for every encounter played as part
   *  of this adventure so the GM keeps cross-chapter narrative coherence. */
  aiContext?: string;
  /** Optional rest encounter id — the inn / campsite the player can return
   *  to between chapters when they pick REST. Resolves against the same
   *  encounters/ pool as chapters. */
  restEncounterId?: string;
}

/** Persisted at `server/data/saves/{characterId}_adventure.json`. Holds the cross-chapter state that survives a chapter transition. */
export interface AdventureSave {
  characterId: string;
  adventureId: string;
  /** Index into `AdventureDef.chapters` for the chapter currently in progress (or just completed). */
  currentChapterIndex: number;
  /** Ids of chapters that have been completed. */
  completedChapterIds: string[];
  /** Cross-chapter world flags. Seeds `GameState.worldFlags` when each chapter session starts. */
  worldFlags: Record<string, WorldFlagValue>;
  /** Cross-chapter quests (adventure/world scope) carried between chapters, plus
   *  any runtime (AIGM-created) quest defs they reference. Encounter-scope quests
   *  are dropped at the chapter boundary. Seeds `GameState.quests` at chapter boot. */
  quests?: import('./quests.js').QuestState[];
  runtimeQuestDefs?: import('./quests.js').QuestDef[];
  /**
   * Cross-chapter faction standings. **Kept for backward compatibility** —
   * stores the player's standing with each faction (`factionRelations.party.*`).
   * On chapter boot the session seeds `factionRelations.party` from this map
   * and persists the updated `party` row back here on chapter advance.
   */
  factionStandings: Record<string, number>;
  /**
   * Full pair-wise faction-relation matrix carried between chapters. When
   * present at chapter boot, seeds `GameState.factionRelations` (after layering
   * the encounter override on top). When the chapter ends, persists the live
   * matrix back so faction politics survive across chapters.
   *
   * Older saves without this field fall back to deriving `party`'s row from
   * `factionStandings` plus the faction-def defaults.
   */
  factionRelations?: Record<string, Record<string, number>>;
  /**
   * Cross-chapter individual relationship overrides (`GameState.relationships`).
   * Seeds the individual layer on chapter boot; persisted back when the chapter
   * ends so personal grudges / loyalties survive. Absent on older saves.
   */
  relationships?: Record<string, Record<string, number>>;
  /**
   * Cross-chapter discovered factions. Seeds `GameState.discoveredFactions`
   * on chapter boot; persisted back when the chapter ends so identity
   * reveals survive.
   */
  discoveredFactions?: string[];
  /** Cross-chapter rumors. Seeds `GameState.rumors`. */
  rumors: Rumor[];
  /** Short GM-authored summaries of completed chapters, surfaced to the AIGM in later chapters under PRIOR CHAPTERS. */
  priorChapterSummaries: Array<{ chapterId: string; chapterTitle: string; summary: string }>;
  /** Rest-stop interlude state. When set, the player is mid-rest at the
   *  adventure's `restEncounterId`, sitting between `currentChapterIndex - 1`
   *  (just completed) and `currentChapterIndex` (queued). The next `/advance`
   *  call clears this and proceeds with the normal chapter-advance routing
   *  rather than offering rest again. Absent/null = not in rest. */
  inRest?: boolean;
}
