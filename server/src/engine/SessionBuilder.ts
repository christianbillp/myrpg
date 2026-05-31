import {
  GameState, GameMap, GameDefs, EquipmentSlots, NpcState, MapItemState,
  SecretState, NpcPersona, CreateSessionRequest, EncounterTileProperty,
  MapTilesetInfo, LogEntry,
} from './types.js';
import { PLAYER_FACTION_ID } from '../../../shared/types.js';
import type { EncounterContext } from '../encounterService.js';
import { generateMap } from './MapGenerator.js';
import { generateRoomsMap } from './RoomsMapGenerator.js';
import {
  ZoneMap, parseStartingZones, findPlayerSpawn, populateNpcs,
} from './SpawnHelpers.js';
import { buildFactionRelations, projectFactionStandings } from './FactionRelations.js';
import { stripTileFlipBits } from '../../../shared/tileGid.js';

/** The shape stored in `defs.maps[i]` — pure geometry, no semantics.
 *  Identical to SavedMapDef (shared); aliased here for engine-side clarity. */
export type SavedMapRecord = import('./types.js').SavedMapDef;

/**
 * Resolve the passability of a single GID against (1) the encounter's explicit
 * tileProperties, (2) the source tileset's `tiles[].properties[].passable`
 * carried on `MapTilesetInfo.tilePassability`, (3) the global tile legend,
 * and (4) a default of `true` (Tiled's convention: unmarked tiles are
 * passable). Encounter overrides win, then tileset, then legend.
 */
function resolveGidPassable(
  rawGid: number,
  byGid: Map<number, EncounterTileProperty>,
  tilesets: MapTilesetInfo[],
  tileLegend: Record<string, { passable?: boolean }>,
): boolean {
  if (rawGid === 0) return true; // empty object-layer cell — no obstacle here.
  // Strip Tiled's flip/rotation bits before looking up — orientation never
  // affects passability, only rendering.
  const gid = stripTileFlipBits(rawGid);
  const explicit = byGid.get(gid);
  if (explicit?.passable !== undefined) return explicit.passable;
  // Find the tileset this GID belongs to — the one with the greatest
  // firstgid that is still ≤ gid. (Tilesets in a map have disjoint GID ranges.)
  let owner: MapTilesetInfo | undefined;
  for (const ts of tilesets) {
    if (ts.firstgid <= gid && (!owner || ts.firstgid > owner.firstgid)) owner = ts;
  }
  if (owner) {
    const local = gid - owner.firstgid;
    const declared = owner.tilePassability[local];
    if (declared !== undefined) return declared;
  }
  // Fall through to the legend — transparent-twin tiles and others added in
  // the legend JSON but missing from the source .tsj end up here.
  const legendPassable = tileLegend[String(gid)]?.passable;
  if (legendPassable !== undefined) return legendPassable;
  return true;
}

/**
 * Combine a saved map's GID grid(s) with the encounter's per-GID tile
 * properties to produce the engine's `GameMap` (with passability resolved).
 *
 * Object overrides terrain: when a cell carries a non-zero object GID, that
 * GID alone determines passability / cover / obscurance — a passable doorway
 * laid over an impassable wall opens the cell; a tree on grass blocks it.
 * The ground tile only matters when the object slot is empty.
 */
function buildGameMapFromSaved(
  saved: SavedMapRecord,
  tileProperties: EncounterTileProperty[] | undefined,
  tileLegend: Record<string, { passable?: boolean; cover?: 'half' | 'three-quarters' | 'total'; obscurance?: 'lightly' | 'heavily'; transparent?: boolean }>,
): GameMap {
  const byGid = new Map<number, EncounterTileProperty>();
  for (const tp of tileProperties ?? []) byGid.set(tp.gid, tp);
  /** Read cover/obscurance/transparent for a GID. Encounter override wins;
   *  otherwise fall through to the tileset legend defaults. */
  const tileCoverFor = (gid: number): 'half' | 'three-quarters' | 'total' | null =>
    byGid.get(gid)?.cover ?? tileLegend[String(gid)]?.cover ?? null;
  const tileObsFor = (gid: number): 'lightly' | 'heavily' | null =>
    byGid.get(gid)?.obscurance ?? tileLegend[String(gid)]?.obscurance ?? null;
  const tileTransparent = (gid: number): boolean =>
    byGid.get(gid)?.transparent ?? tileLegend[String(gid)]?.transparent ?? false;
  /** GID whose tile properties win for this cell — the object when present,
   *  otherwise the ground GID. Implements the object-overrides-terrain rule. */
  const effectiveGid = (groundGid: number, objectGid: number): number =>
    objectGid !== 0 ? objectGid : groundGid;
  const passable: boolean[][] = saved.gidGrid.map((row, y) =>
    row.map((groundGid, x) => {
      const objectGid = saved.objectGidGrid?.[y]?.[x] ?? 0;
      return resolveGidPassable(effectiveGid(groundGid, objectGid), byGid, saved.tilesets, tileLegend);
    }),
  );
  // Bake per-tile cover and obscurance from the effective tile (object
  // overrides ground per the rule above) plus any encounter override. A
  // tree-on-grass cell reads as "tree" (impassable, total cover); an empty
  // patch of underbrush stays at ground-tile defaults.
  //
  // Impassable tiles without an explicit cover declaration are auto-promoted
  // to Total Cover so walls block vision out of the box. Authors opt out of
  // this by setting `transparent: true` on the tile (chasms, water, windows).
  const coverGrid: (null | 'half' | 'three-quarters' | 'total')[][] = saved.gidGrid.map((row, y) =>
    row.map((groundGid, x) => {
      const objectGid = saved.objectGidGrid?.[y]?.[x] ?? 0;
      const gid = effectiveGid(groundGid, objectGid);
      let cover = tileCoverFor(gid);
      if (!passable[y][x] && !tileTransparent(gid) && cover === null) {
        cover = 'total';
      }
      return cover;
    }),
  );
  const obscuranceGrid: (null | 'lightly' | 'heavily')[][] = saved.gidGrid.map((row, y) =>
    row.map((groundGid, x) => {
      const objectGid = saved.objectGidGrid?.[y]?.[x] ?? 0;
      return tileObsFor(effectiveGid(groundGid, objectGid));
    }),
  );
  return {
    cols: saved.cols,
    rows: saved.rows,
    passable,
    cover: coverGrid,
    obscurance: obscuranceGrid,
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
    ? buildGameMapFromSaved(savedMap, req.tileProperties, defs.tileLegend.tiles)
    : (req.mapType === 'rooms' ? generateRoomsMap() : generateMap());

  const equippedSlots: EquipmentSlots = req.resumeEquippedSlots ?? { ...playerDef.defaultEquipment };
  const inventoryIds: string[] = req.resumeInventoryIds ?? [...(playerDef.defaultInventoryIds ?? [])];

  const rawZones = req.startingZones ?? req.encounterContext.startingZones;
  const zoneMap: ZoneMap = rawZones ? parseStartingZones(rawZones, map) : new Map();
  const playerZone = zoneMap.get('P');
  const allyZone   = zoneMap.get('A') ?? playerZone;
  const npcZone    = zoneMap.get('N');
  const enemyZone  = zoneMap.get('E');

  // Exact-mode placements: read only when the encounter opted in. In zones
  // mode (default) we pass `undefined` so `findPlayerSpawn` / `populateNpcs`
  // take their existing random-in-zone paths unchanged.
  const placementMode = req.placementMode ?? req.encounterContext.placementMode ?? 'zones';
  const placements = placementMode === 'exact'
    ? (req.placements ?? req.encounterContext.placements)
    : undefined;
  const playerPlacement = placements?.find((p) => p.role === 'player');
  const playerExactTile: [number, number] | undefined = playerPlacement
    ? [playerPlacement.x, playerPlacement.y]
    : undefined;

  const [pX, pY] = findPlayerSpawn(map, playerZone, playerExactTile);

  const player = {
    defId: playerDef.id,
    tileX: pX, tileY: pY,
    hp: req.resumeHp ?? playerDef.maxHp,
    xp: req.resumeXp ?? playerDef.xp,
    balanceCp: req.resumeCp ?? playerDef.defaultCp ?? 0,
    inventoryIds,
    equippedSlots,
    // Initialise per-feature resource pools: resume value wins; otherwise
    // each known feature with a non-unlimited resource starts at `max` (Long
    // Rest equivalent, since a new encounter == new day in our model).
    resources: req.resumeResources ?? Object.fromEntries(
      (playerDef.defaultFeatureIds ?? [])
        .map((fid) => defs.features.find((f) => f.id === fid))
        .filter((f): f is NonNullable<typeof f> => !!f && !!f.resource && f.resource.kind !== 'unlimited')
        .map((f) => [f.id, f.resource!.max] as const),
    ),
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
    ac: playerDef.ac,
    spellSlots: req.resumeSpellSlots ?? [...(playerDef.defaultSpellSlots ?? [])],
    // Dev mode `unlockAllSpells`: seed every spell in the game as known +
    // prepared so the tester can invoke any spell without a level-up
    // rebuild. Wizards also get every spell pushed into their spellbook
    // (mutating the per-session playerDef clone) so `castableSpellIds`
    // includes the lot.
    preparedSpellIds: req.devFlags?.unlockAllSpells
      ? defs.spells.map((s) => s.id)
      : (req.resumePreparedSpellIds ?? [...(playerDef.defaultPreparedSpellIds ?? [])]),
    concentratingOn: req.resumeConcentratingOn ?? null,
    mageArmor: req.resumeMageArmor ?? false,
    ongoingEffects: [],
  };

  const npcs: NpcState[] = [];
  const mapItems: MapItemState[] = [];
  const secrets: SecretState[] = [];

  populateNpcs(
    { npcs, mapItems, secrets },
    map,
    { npcs: defs.npcs, monsters: defs.monsters, equipment: defs.equipment },
    {
      allyIds: req.allyIds ?? req.encounterContext.allyIds,
      enemyIds: req.enemyIds ?? req.encounterContext.enemyIds,
      npcIds:   req.npcIds  ?? req.encounterContext.npcIds,
      secretDefs: req.encounterContext.secrets,
      playerX: player.tileX,
      playerY: player.tileY,
      allyZone,
      enemyZone,
      npcZone,
      placements,
    },
  );

  const npcPersonas: NpcPersona[] = npcs
    .filter((n) => n.disposition === 'neutral')
    .flatMap((ns) => {
      const def = defs.npcs.find((n) => n.id === ns.defId);
      return def?.persona ? [{ id: ns.id, name: def.name, persona: def.persona }] : [];
    });

  // Seed the event log with the encounter header + introduction prose so a
  // player who runs the encounter without the GM tab has a scrollable record
  // of what the scene is. Authored intro prose is split into lines so wider
  // paragraphs render as multiple log entries rather than a single long row.
  const seedLog: LogEntry[] = [];
  if (req.encounterTitle) {
    seedLog.push({ left: `── ${req.encounterTitle} ──`, style: 'header' });
  }
  const introText = req.encounterContext.introduction?.trim();
  if (introText) {
    for (const line of introText.split(/\n+/).map((s) => s.trim()).filter(Boolean)) {
      seedLog.push({ left: line, style: 'status' });
    }
  }
  if (req.encounterContext.objective) {
    seedLog.push({ left: `Objective: ${req.encounterContext.objective}`, style: 'status' });
  }

  // Faction relations matrix — built once from def defaults, then layered
  // with adventure-save carry-overs (full matrix preferred, falling back to
  // the legacy party-row), then the encounter's optional override block.
  // After the spawn pass the matrix is also back-filled with each spawned
  // NPC's disposition-implied standing with the party (only when the
  // override didn't already set one), so unannotated content still produces
  // matrix entries the new helpers can read.
  const factionRelations = buildFactionRelations(defs.factions, {
    seedFactionRelations: req.adventureSeed?.seedFactionRelations,
    seedFactionStandings: req.adventureSeed?.seedFactionStandings,
    encounterOverride: req.encounterContext.factionRelations,
  });
  for (const n of npcs) {
    const cur = factionRelations[n.factionId]?.[PLAYER_FACTION_ID];
    if (cur !== undefined) continue;
    if (n.disposition === 'enemy') {
      factionRelations[n.factionId] = { ...(factionRelations[n.factionId] ?? {}), [PLAYER_FACTION_ID]: -100 };
      factionRelations[PLAYER_FACTION_ID] = { ...(factionRelations[PLAYER_FACTION_ID] ?? {}), [n.factionId]: -100 };
    } else if (n.disposition === 'ally') {
      factionRelations[n.factionId] = { ...(factionRelations[n.factionId] ?? {}), [PLAYER_FACTION_ID]: 100 };
      factionRelations[PLAYER_FACTION_ID] = { ...(factionRelations[PLAYER_FACTION_ID] ?? {}), [n.factionId]: 100 };
    }
  }

  const state: GameState = {
    sessionId,
    phase: 'exploring',
    map,
    player,
    npcs,
    mapItems,
    secrets,
    eventLog: seedLog,
    logScrollOffset: 0,
    mapName: req.encounterContext.mapName ?? 'Unknown',
    encounterTitle: req.encounterTitle ?? '',
    objective: req.encounterContext.objective ?? '',
    selectedTargetId: null,
    activeNpcIndex: 0,
    turnOrderIds: [],
    introduction: req.encounterContext.introduction,
    encounterContext: req.encounterContext.context,
    allowsLongRest: req.encounterContext.allowsLongRest === true,
    npcPersonas,
    availableActions: {
      canAttack: false, throwableItemIds: [],
      canHide: false, usableFeatureIds: [], canDash: false,
      canDodge: false, canDisengage: false, canShortRest: false,
      castableSpellIds: [],
      canDetach: false,
      canLevelUp: false,
      canLongRest: false,
    },
    pendingReaction: null,
    triggers: req.triggers ?? [],
    firedTriggerIds: [],
    pendingAigmEvents: [],
    worldFlags: req.adventureSeed?.seedWorldFlags ?? {},
    narrationLastUsed: {},
    factionRelations,
    // Legacy projection kept in sync with the matrix at boot. Pass 2 will
    // re-project after every mutation so existing readers stay correct.
    factionStandings: projectFactionStandings(factionRelations),
    discoveredFactions: req.adventureSeed?.seedDiscoveredFactions ?? [],
    rumors: req.adventureSeed?.seedRumors ?? [],
    adventureContext: req.adventureSeed ? {
      adventureId: req.adventureSeed.adventureId,
      adventureTitle: req.adventureSeed.adventureTitle,
      chapterId: req.adventureSeed.chapterId,
      chapterTitle: req.adventureSeed.chapterTitle,
      chapterIndex: req.adventureSeed.chapterIndex,
      totalChapters: req.adventureSeed.totalChapters,
      priorChapterSummaries: req.adventureSeed.priorChapterSummaries,
      isRestSession: req.adventureSeed.isRestSession,
      restEncounterId: req.adventureSeed.restEncounterId,
    } : null,
    chapterComplete: false,
    encounterCompletionFlag: req.completionFlag ?? req.adventureSeed?.completionFlag,
    environment: req.encounterContext.environment ?? {},
    devFlags: req.devFlags,
  };

  return state;
}
