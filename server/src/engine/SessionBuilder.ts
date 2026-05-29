import {
  GameState, GameMap, GameDefs, EquipmentSlots, NpcState, MapItemState,
  SecretState, QuestState, NpcPersona, CreateSessionRequest, EncounterTileProperty,
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
 * carried on `MapTilesetInfo.tilePassability`, and (3) a default of `true`
 * (Tiled's convention: unmarked tiles are passable). Encounter overrides win.
 */
function resolveGidPassable(
  rawGid: number,
  byGid: Map<number, EncounterTileProperty>,
  tilesets: MapTilesetInfo[],
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
  if (!owner) return true;
  const local = gid - owner.firstgid;
  const declared = owner.tilePassability[local];
  return declared ?? true;
}

/**
 * Combine a saved map's GID grid(s) with the encounter's per-GID tile
 * properties to produce the engine's `GameMap` (with passability resolved).
 * A cell is passable iff the ground GID is passable AND any object GID at
 * that cell is also passable.
 */
function buildGameMapFromSaved(
  saved: SavedMapRecord,
  tileProperties: EncounterTileProperty[] | undefined,
  tileLegend: Record<string, { cover?: 'half' | 'three-quarters' | 'total'; obscurance?: 'lightly' | 'heavily'; transparent?: boolean }>,
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
  const passable: boolean[][] = saved.gidGrid.map((row, y) =>
    row.map((groundGid, x) => {
      if (!resolveGidPassable(groundGid, byGid, saved.tilesets)) return false;
      const objectGid = saved.objectGidGrid?.[y]?.[x] ?? 0;
      return resolveGidPassable(objectGid, byGid, saved.tilesets);
    }),
  );
  // Bake per-tile cover and obscurance from the encounter's tileProperties.
  // The walker takes the worst of the ground + object GID for each cell so a
  // patch of underbrush sitting on grass becomes "lightly obscured", and a
  // dense tree on dirt becomes "three-quarters cover". Tileset-level
  // defaults are not (yet) consulted — authors mark these explicitly via
  // `EncounterTileProperty`.
  //
  // Impassable tiles without an explicit cover declaration are auto-promoted
  // to Total Cover so walls block vision out of the box. Authors opt out of
  // this by setting `transparent: true` on the tile property (chasms, deep
  // water, low walls — terrain you can see across but cannot enter).
  const coverGrid: (null | 'half' | 'three-quarters' | 'total')[][] = saved.gidGrid.map((row, y) =>
    row.map((groundGid, x) => {
      const objectGid = saved.objectGidGrid?.[y]?.[x] ?? 0;
      let cover = worstCover(tileCoverFor(groundGid), tileCoverFor(objectGid));
      // Auto-promote: if this cell is impassable AND neither layer declared
      // `transparent: true` (legend or encounter override), treat as Total
      // Cover. Authors mark chasms / water / windows transparent to opt out.
      if (!passable[y][x] && !tileTransparent(groundGid) && !tileTransparent(objectGid) && cover === null) {
        cover = 'total';
      }
      return cover;
    }),
  );
  const obscuranceGrid: (null | 'lightly' | 'heavily')[][] = saved.gidGrid.map((row, y) =>
    row.map((groundGid, x) => {
      const objectGid = saved.objectGidGrid?.[y]?.[x] ?? 0;
      return worstObscurance(tileObsFor(groundGid), tileObsFor(objectGid));
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

type CoverCell = null | 'half' | 'three-quarters' | 'total';
const COVER_RANK: Record<Exclude<CoverCell, null>, number> = { 'half': 1, 'three-quarters': 2, 'total': 3 };
function worstCover(a: CoverCell, b: CoverCell): CoverCell {
  if (!a) return b;
  if (!b) return a;
  return COVER_RANK[a] >= COVER_RANK[b] ? a : b;
}

type ObsCell = null | 'lightly' | 'heavily';
const OBS_RANK: Record<Exclude<ObsCell, null>, number> = { 'lightly': 1, 'heavily': 2 };
function worstObscurance(a: ObsCell, b: ObsCell): ObsCell {
  if (!a) return b;
  if (!b) return a;
  return OBS_RANK[a] >= OBS_RANK[b] ? a : b;
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

  const [pX, pY] = findPlayerSpawn(map, playerZone);

  const player = {
    defId: playerDef.id,
    tileX: pX, tileY: pY,
    hp: req.resumeHp ?? playerDef.maxHp,
    xp: req.resumeXp ?? playerDef.xp,
    gold: req.resumeGold ?? playerDef.defaultGold ?? 0,
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
    preparedSpellIds: req.resumePreparedSpellIds ?? [...(playerDef.defaultPreparedSpellIds ?? [])],
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
    },
  );

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
    quests,
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
    } : null,
    chapterComplete: false,
    encounterCompletionFlag: req.completionFlag ?? req.adventureSeed?.completionFlag,
    environment: req.encounterContext.environment ?? {},
  };

  return state;
}
