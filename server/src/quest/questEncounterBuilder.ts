/**
 * Shared encounter builder for generated quests. Composes a procedural outdoor
 * map and wraps it in a `GeneratedEncounterDef` with standard placements
 * (player west, enemies east, captives just inside the enemies, allies beside
 * the player). Each quest-type module supplies the creatures, prose, objective,
 * and the triggers that set the world flag its quest step watches.
 */
import { composeOutdoor } from '../engine/maps/outdoor.js';
import type { ComposedMap } from '../engine/mapTypes.js';
import type { SavedMapDef } from '../engine/types.js';
import type { MapTilesetInfo } from '../../../shared/types.js';
import type { GeneratedEncounterDef, GeneratedQuestEncounter } from './questGenTypes.js';

/** All generated quest maps are this size — wide enough for a west→east
 *  approach, small enough to read at a glance. */
export const MAP_W = 20;
export const MAP_H = 14;

export type Biome = 'grassland' | 'forest';

export interface BuildQuestEncounterArgs {
  ordinal: number;
  encounterId: string;
  title: string;
  biome: Biome;
  intro: string;
  context: string;
  objective: string;
  enemyIds: string[];
  /** Neutral NPC def ids (e.g. a rescue captive) — placed just inside the enemy line. */
  neutralIds?: string[];
  /** Ally def ids — placed beside the player. */
  allyIds?: string[];
  triggers: unknown[];
  tilesets: MapTilesetInfo[];
  rng: () => number;
}

function composedToSavedMap(composed: ComposedMap, id: string, tilesets: MapTilesetInfo[]): SavedMapDef {
  const { width, height, terrainData, objectData, name, description, zones } = composed;
  const toGrid = (flat: number[]): number[][] => {
    const grid: number[][] = [];
    for (let y = 0; y < height; y++) {
      const row: number[] = [];
      for (let x = 0; x < width; x++) row.push(flat[y * width + x]);
      grid.push(row);
    }
    return grid;
  };
  return {
    id,
    name,
    mapdescription: description,
    cols: width,
    rows: height,
    gidGrid: toGrid(terrainData),
    objectGidGrid: toGrid(objectData),
    tilesets,
    ...(zones && zones.length > 0 ? { zones: zones.map((z) => ({ id: z.id, name: z.name, color: z.color, cells: z.cells })) } : {}),
  };
}

export function buildQuestEncounter(args: BuildQuestEncounterArgs): GeneratedQuestEncounter {
  let zoneSeq = 0;
  const composed = composeOutdoor({
    width: MAP_W,
    height: MAP_H,
    terrain: args.biome,
    features: ['path'],
    rng: args.rng,
    allocZoneId: () => `z${++zoneSeq}`,
  });
  const savedMap = composedToSavedMap(composed, args.encounterId, args.tilesets);

  const midY = Math.floor(MAP_H / 2);
  const enemyX = MAP_W - 3;
  const placements: GeneratedEncounterDef['placements'] = [{ role: 'player', x: 2, y: midY }];
  // Enemies fan out vertically around the centreline at the east edge.
  args.enemyIds.forEach((_, i) => {
    const offset = i === 0 ? 0 : (i % 2 === 1 ? Math.ceil(i / 2) : -Math.ceil(i / 2));
    placements.push({ role: 'enemy', index: i, x: enemyX, y: Math.max(1, Math.min(MAP_H - 2, midY + offset)) });
  });
  (args.neutralIds ?? []).forEach((_, i) => {
    placements.push({ role: 'neutral', index: i, x: enemyX - 1, y: Math.max(1, Math.min(MAP_H - 2, midY + i + 1)) });
  });
  (args.allyIds ?? []).forEach((_, i) => {
    placements.push({ role: 'ally', index: i, x: 3, y: Math.max(1, Math.min(MAP_H - 2, midY + i + 1)) });
  });

  const encounterDef: GeneratedEncounterDef = {
    id: args.encounterId,
    encounterTitle: args.title,
    description: `Procedurally generated quest stage (${args.biome}).`,
    mapId: args.encounterId,
    npcIds: args.neutralIds ?? [],
    allyIds: args.allyIds ?? [],
    enemyIds: args.enemyIds,
    customIntroduction: args.intro,
    customContext: args.context,
    objective: args.objective,
    allowsLongRest: false,
    placementMode: 'exact',
    placements,
    triggers: args.triggers,
  };

  return { ordinal: args.ordinal, encounterDef, savedMap };
}

/** The east-edge "objective area" rectangle — where retrieve caches / investigate
 *  sites sit, and the `player_moved` guard that detects the player reaching it. */
export function eastObjectiveArea(): { x: number; y: number; w: number; h: number } {
  return { x: MAP_W - 5, y: 1, w: 5, h: MAP_H - 2 };
}
