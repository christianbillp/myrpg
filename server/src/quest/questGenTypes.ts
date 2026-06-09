/**
 * Quest generator — shared types.
 *
 * A `GeneratedQuest` is a self-contained, procedurally-rolled quest: a real
 * `QuestDef` (so the structured `QuestSystem` drives its objective, steps, XP,
 * and persistence) plus the 1..N generated encounters needed to play it. Each
 * encounter sets the world flag its matching quest step watches; multi-stage
 * quests chain by having a step's `onComplete` point `mission_pending` at the
 * next stage's encounter id.
 *
 * This replaces the single-type `mission/missionGenerator.ts`: a "mission" is
 * now just the contract transport around a typed, generated quest.
 */
import type { QuestDef } from '../../../shared/types.js';
import type { MonsterDef, MapTilesetInfo } from '../../../shared/types.js';
import type { SavedMapDef } from '../engine/types.js';

/** The quest types the generator can roll. Extensible — adding a type is one
 *  module in `questTypes/` plus a registry entry in `questGenerator.ts`. */
export type QuestTypeId =
  | 'bounty'        // clear the enemies
  | 'hunt'          // kill a named elite among minions
  | 'rescue'        // free a captive, clear the captors
  | 'retrieve'      // fight to a cache and recover it
  | 'investigate'   // reach a site and study it
  | 'two_stage_strike'; // scout, then assault (2 encounters)

/** A trimmed EncounterDefJson — the fields the transition endpoint + session
 *  builder consume for a generated encounter. */
export interface GeneratedEncounterDef {
  id: string;
  encounterTitle: string;
  description?: string;
  mapId: string;
  npcIds?: string[];
  allyIds?: string[];
  enemyIds?: string[];
  customIntroduction?: string;
  customContext?: string;
  objective?: string;
  allowsLongRest?: boolean;
  completionFlag?: string;
  placementMode?: 'zones' | 'exact';
  placements?: Array<{ role: 'player' | 'enemy' | 'ally' | 'neutral'; index?: number; x: number; y: number }>;
  triggers?: unknown[];
  conversationOverrides?: Record<string, string>;
}

/** One stage of a generated quest: the encounter def + its materialised map. */
export interface GeneratedQuestEncounter {
  /** 0-based stage index. Stage 0's encounter id is the base id; stage k>0 is
   *  `<baseId>#<k>` (resolved by the registry). */
  ordinal: number;
  encounterDef: GeneratedEncounterDef;
  savedMap: SavedMapDef;
}

export interface QuestGenReward {
  cpDelta: number;
  xp: number;
}

export interface GeneratedQuest {
  /** Registry key / stage-0 encounter id, `mission_gen_<uuid>` (the
   *  `mission_gen_` transport prefix is kept so the existing contract loop +
   *  client TopBar work unchanged). */
  baseEncounterId: string;
  /** The QuestDef id, `quest_gen_<uuid>`. */
  questId: string;
  type: QuestTypeId;
  title: string;
  /** Theme tag for prose / pool selection (bandit / goblin / undead / …). */
  flavour: string;
  /** The real quest definition — registered as a trusted runtime def and
   *  started when the player enters stage 0. */
  questDef: QuestDef;
  /** Ordered stages (length 1 for single-encounter types). */
  encounters: GeneratedQuestEncounter[];
  reward: QuestGenReward;
  /** What the hub conversation surfaces in the offer. */
  offer: { objective: string; rewardLine: string; prose: string };
}

/** Inputs a quest-type module needs to roll a quest. */
export interface QuestGenContext {
  /** Player level — drives the difficulty budget. */
  playerLevel: number;
  /** Full monster roster (for CR/xp-weighted enemy selection). */
  monsters: MonsterDef[];
  /** Tileset metadata for the generated maps. */
  tilesets: MapTilesetInfo[];
  /** Deterministic RNG (Math.random in production; seeded in tests). */
  rng: () => number;
  /** Quest type rolled last, so the generator can avoid immediate repeats. */
  lastType?: QuestTypeId;
}

/** A quest-type recipe. */
export interface QuestTypeModule {
  id: QuestTypeId;
  /** Relative selection weight; 0 disables the type (e.g. a level gate). */
  weight(ctx: QuestGenContext): number;
  /** Roll a full quest of this type. */
  generate(ctx: QuestGenContext): GeneratedQuest;
}
