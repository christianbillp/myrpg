/**
 * Session creation request shape.
 *
 * Extracted from the original god-file `shared/types.ts` (now a barrel that
 * re-exports every domain module under `shared/types/`).
 */

// Cross-domain imports — keep these explicit so the dependency graph is visible.
import type { EncounterDef, EncounterPlacement, EncounterTileProperty, StartingZonesLayer } from "./encounter.js";
import type { WorldFlagValue } from "./engineEvents.js";
import type { EquipmentSlots } from "./entities.js";
import type { Rumor } from "./factions.js";
import type { LevelUpChoices } from "./levelUp.js";
import type { AdventureSessionContext, DevFlags, GameState } from "./longRest.js";
import type { EncounterTrigger } from "./triggers.js";

export interface CreateSessionRequest {
  mapType: 'open' | 'rooms' | 'saved';
  playerDefId: string;
  savedMapId?: string;
  encounterTitle?: string;
  savedMapName?: string;
  savedMapDescription?: string;
  npcIds?: string[];
  allyIds?: string[];
  /** Hand-picked hostile creature ids — see EncounterDef.enemyIds. */
  enemyIds?: string[];
  customIntroduction?: string;
  customContext?: string;
  customObjective?: string;
  /** Mirror of `EncounterDef.allowsLongRest`. Carried through to `GameState.allowsLongRest`. */
  allowsLongRest?: boolean;
  /** Mirror of `EncounterDef.completionFlag`. Seeded onto `GameState.encounterCompletionFlag` for the `encounter_completed` lifecycle event. */
  completionFlag?: string;
  tileProperties?: EncounterTileProperty[];
  startingZones?: StartingZonesLayer;
  /** Mirrors `EncounterDef.placementMode` — see that field for the rules. */
  placementMode?: 'zones' | 'exact';
  /** Mirrors `EncounterDef.placements`. */
  placements?: EncounterPlacement[];
  triggers?: EncounterTrigger[];
  /** Seed adventure-scope state on session creation. Set when the new session is a chapter of an in-progress adventure. */
  adventureSeed?: AdventureSessionContext & {
    seedWorldFlags?: Record<string, WorldFlagValue>;
    seedFactionStandings?: Record<string, number>;
    /** Cross-chapter full faction-relation matrix (Pass 1+). When absent we fall back to seeding from `seedFactionStandings` (`party` row only). */
    seedFactionRelations?: Record<string, Record<string, number>>;
    /** Cross-chapter discovered factions (Pass 1+). Empty when absent. */
    seedDiscoveredFactions?: string[];
    seedRumors?: Rumor[];
  };
  resumeHp?: number;
  resumeXp?: number;
  resumeCp?: number;
  resumeInventoryIds?: string[];
  resumeEquippedSlots?: EquipmentSlots;
  resumeResources?: Record<string, number>;
  resumeSpellSlots?: number[];
  resumePreparedSpellIds?: string[];
  resumeConcentratingOn?: string | null;
  resumeMageArmor?: boolean;
  /** Level-up history — one `LevelUpChoices` per level above 1. Replayed at
   *  session start so the per-session `playerDef` clone reaches its current
   *  level with the player's recorded feature / spell / Expertise picks. */
  resumeLevelUps?: LevelUpChoices[];
  /** Dev-mode session overrides — see `DevFlags`. Copied straight onto
   *  `GameState.devFlags` at session boot; `unlockAllSpells` is consumed
   *  at boot to seed `preparedSpellIds`/`defaultSpellbookIds`. */
  devFlags?: DevFlags;
}

export interface CreateSessionResponse {
  sessionId: string;
  state: GameState;
}
