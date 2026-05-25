import {
  GameState, GameMap, GameDefs, EquipmentSlots, NpcState, MapItemState,
  SecretState, QuestState, NpcPersona, CreateSessionRequest, EncounterTileProperty,
  TileLegend,
} from './types.js';
import type { EncounterContext } from '../encounterService.js';
import { generateMap } from './MapGenerator.js';
import { generateRoomsMap } from './RoomsMapGenerator.js';
import {
  ZoneMap, parseStartingZones, findPlayerSpawn,
  spawnEnemies, spawnItems, spawnNpc, spawnSecrets,
} from './SpawnHelpers.js';

/** The shape stored in `defs.maps[i]` — pure geometry, no semantics.
 *  Identical to SavedMapDef (shared); aliased here for engine-side clarity. */
export type SavedMapRecord = import('./types.js').SavedMapDef;

/**
 * Resolve the passability of a single GID against (1) the encounter's explicit
 * tileProperties, (2) the tileset legend, and (3) a default of `false`
 * (impassable). Encounter overrides win over the legend.
 */
function resolveGidPassable(
  gid: number,
  byGid: Map<number, EncounterTileProperty>,
  legend: TileLegend,
): boolean {
  if (gid === 0) return true; // empty object-layer cell — no obstacle here.
  const explicit = byGid.get(gid);
  if (explicit?.passable !== undefined) return explicit.passable;
  const legendEntry = legend.tiles[String(gid)];
  if (legendEntry) return legendEntry.passable;
  return false;
}

/**
 * Combine a saved map's GID grid(s) with the encounter's per-GID tile
 * properties and the tileset legend to produce the engine's `GameMap` (with
 * passability resolved). A cell is passable iff the ground GID is passable
 * AND any object GID at that cell is also passable.
 */
function buildGameMapFromSaved(
  saved: SavedMapRecord,
  tileProperties: EncounterTileProperty[] | undefined,
  legend: TileLegend,
): GameMap {
  const byGid = new Map<number, EncounterTileProperty>();
  for (const tp of tileProperties ?? []) byGid.set(tp.gid, tp);
  const passable: boolean[][] = saved.gidGrid.map((row, y) =>
    row.map((groundGid, x) => {
      if (!resolveGidPassable(groundGid, byGid, legend)) return false;
      const objectGid = saved.objectGidGrid?.[y]?.[x] ?? 0;
      return resolveGidPassable(objectGid, byGid, legend);
    }),
  );
  return {
    cols: saved.cols,
    rows: saved.rows,
    passable,
    // Carry rendering info through to the client.
    gidGrid: saved.gidGrid,
    objectGidGrid: saved.objectGidGrid,
    tilesets: saved.tilesets,
  };
}

/**
 * Build a fresh GameState from an encounter request. Pure: does not mutate
 * any input. The returned state is ready to hand to a new GameEngine.
 */
export function buildSessionState(
  sessionId: string,
  req: CreateSessionRequest & { encounterContext: EncounterContext },
  defs: GameDefs,
  savedMap?: SavedMapRecord,
): GameState {
  const playerDef = defs.playerDefs.find((p) => p.id === req.playerDefId);
  if (!playerDef) throw new Error(`Unknown playerDefId: ${req.playerDefId}`);

  const map: GameMap = savedMap
    ? buildGameMapFromSaved(savedMap, req.tileProperties, defs.tileLegend)
    : (req.mapType === 'rooms' ? generateRoomsMap() : generateMap());

  const equippedSlots: EquipmentSlots = req.resumeEquippedSlots ?? { ...playerDef.defaultEquipment };
  const inventoryIds: string[] = req.resumeInventoryIds ?? [...(playerDef.defaultInventoryIds ?? [])];

  const rawZones = req.startingZones ?? req.encounterContext.startingZones;
  const zoneMap: ZoneMap = rawZones ? parseStartingZones(rawZones, map) : new Map();
  const playerZone = zoneMap.get('P');
  const allyZone   = zoneMap.get('A') ?? playerZone;
  const npcZone    = zoneMap.get('N');
  const enemyZone  = zoneMap.get('E');

  const [pX, pY] = findPlayerSpawn(map, playerZone);

  const player = {
    defId: playerDef.id,
    tileX: pX, tileY: pY,
    hp: req.resumeHp ?? playerDef.maxHp,
    xp: req.resumeXp ?? playerDef.xp,
    gold: req.resumeGold ?? 0,
    inventoryIds,
    equippedSlots,
    secondWindUses: req.resumeSecondWindUses ?? playerDef.secondWindMaxUses,
    actionUsed: false,
    bonusActionUsed: false,
    reactionUsed: false,
    freeObjectInteractionUsed: false,
    initiativeRoll: 0,
    movesLeft: 0,
    deathSaveSuccesses: 0,
    deathSaveFailures: 0,
    hitDiceUsed: 0,
    tempHp: 0,
    heroicInspiration: false,
    exhaustionLevel: 0,
    conditions: [] as string[],
    equippedSlotLabels: { armor: null, weapon: null, shield: null },
  };

  const isCombat = req.encounterTypes.includes('simple_combat');

  const npcs: NpcState[] = [];
  const mapItems: MapItemState[] = [];
  const secrets: SecretState[] = [];

  for (const defId of (req.allyIds ?? req.encounterContext.allyIds ?? [])) {
    spawnNpc(npcs, map, defs.npcs, defs.monsters, defId, player.tileX, player.tileY, 'ally', allyZone);
  }
  if (isCombat) {
    spawnEnemies(npcs, map, defs.monsters, player.tileX, player.tileY, req.encounterContext.enemyCount ?? 2, enemyZone);
    spawnItems(mapItems, map, defs.equipment, player.tileX, player.tileY, npcs);
  }
  if (req.encounterTypes.includes('social_interaction')) {
    for (const defId of (req.npcIds ?? req.encounterContext.npcIds ?? [])) {
      spawnNpc(npcs, map, defs.npcs, defs.monsters, defId, player.tileX, player.tileY, 'neutral', npcZone);
    }
  }
  if (req.encounterTypes.includes('exploration')) {
    spawnSecrets(secrets, map, req.encounterContext.secrets ?? [], player.tileX, player.tileY, npcs);
  }

  const npcPersonas: NpcPersona[] = npcs
    .filter((n) => n.disposition === 'neutral')
    .flatMap((ns) => {
      const def = defs.npcs.find((n) => n.id === ns.defId);
      return def?.persona ? [{ id: ns.id, name: def.name, persona: def.persona }] : [];
    });

  const quests: QuestState[] = (req.encounterContext.quests ?? []).map((q) => ({
    id: q.id,
    title: q.title,
    goalType: q.goal.type,
    goalTarget: q.goal.target,
    rewardXp: q.rewardXp,
    rewardGp: q.rewardGp,
    progress: 0,
    completed: false,
  }));

  const state: GameState = {
    sessionId,
    phase: 'exploring',
    map,
    player,
    npcs,
    mapItems,
    secrets,
    combatLog: [],
    logScrollOffset: 0,
    encounterTypes: req.encounterTypes,
    mapName: req.encounterContext.mapName ?? 'Unknown',
    encounterTitle: req.encounterTitle ?? '',
    quests,
    selectedTargetId: null,
    activeNpcIndex: 0,
    turnOrderIds: [],
    introduction: req.encounterContext.introduction,
    encounterContext: req.encounterContext.context,
    npcPersonas,
    availableActions: {
      canAttack: false, throwableItemIds: [],
      canHide: false, canSecondWind: false, canDash: false,
      canDodge: false, canDisengage: false, canShortRest: false,
    },
  };

  return state;
}
