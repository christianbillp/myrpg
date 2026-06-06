import {
  GameState, GameMap, GameDefs, EquipmentSlots, NpcState, MapItemState,
  SecretState, NpcPersona, CreateSessionRequest, EncounterTileProperty,
  MapTilesetInfo, LogEntry, TrapState,
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

/** A tileset legend's GID→entry map (the value side of
 *  `defs.tileLegendsByTileset`), narrowed to the fields gameplay reads. */
type LegendTiles = Record<string, {
  blocksMovement?: boolean;
  blocksSight?: boolean;
  cover?: 'half' | 'three-quarters' | 'total';
  obscurance?: 'lightly' | 'heavily';
}>;

/** Base tileset key from an image URL: `/tilesets/scribble.png` → `scribble`.
 *  Matches the key `loadTileLegends` files each tileset's legend under. */
function tilesetKeyFromUrl(imageUrl: string): string {
  const base = imageUrl.split('/').pop() ?? imageUrl;
  return base.replace(/\.[^.]+$/, '').toLowerCase();
}

/** The tileset that owns a GID — the one with the greatest firstgid still ≤
 *  gid (tilesets in a map have disjoint, ascending GID ranges). */
function ownerTileset(gid: number, tilesets: MapTilesetInfo[]): MapTilesetInfo | undefined {
  let owner: MapTilesetInfo | undefined;
  for (const ts of tilesets) {
    if (ts.firstgid <= gid && (!owner || ts.firstgid > owner.firstgid)) owner = ts;
  }
  return owner;
}

/** Look up a GID's legend entry in its OWNING tileset's legend, keyed by the
 *  tile's standalone id (local frame + 1). Routing through the owner tileset
 *  is essential: legends from different tilesets share local GID keys
 *  (scribble's 8 = grass, water's 8 = water_edge_w), so a flat cross-tileset
 *  merge silently overwrites one with the other. */
function legendEntryForGid(
  rawGid: number,
  tilesets: MapTilesetInfo[],
  legendsByTileset: Record<string, LegendTiles>,
): LegendTiles[string] | undefined {
  const gid = stripTileFlipBits(rawGid);
  const owner = ownerTileset(gid, tilesets);
  if (!owner) return undefined;
  return legendsByTileset[tilesetKeyFromUrl(owner.imageUrl)]?.[String(gid - owner.firstgid + 1)];
}

/**
 * Resolve whether a single GID blocks movement against (1) the encounter's
 * explicit tileProperties, (2) the source tileset's per-tile data carried on
 * `MapTilesetInfo.tileBlocksMovement`, (3) the owning tileset's legend, and (4)
 * a default of `false` (unmarked tiles do not block). Encounter overrides win,
 * then tileset, then legend.
 */
function resolveGidBlocksMovement(
  rawGid: number,
  byGid: Map<number, EncounterTileProperty>,
  tilesets: MapTilesetInfo[],
  legendsByTileset: Record<string, LegendTiles>,
): boolean {
  if (rawGid === 0) return false; // empty object-layer cell — no obstacle here.
  // Strip Tiled's flip/rotation bits before looking up — orientation never
  // affects passability, only rendering.
  const gid = stripTileFlipBits(rawGid);
  const explicit = byGid.get(gid);
  if (explicit?.blocksMovement !== undefined) return explicit.blocksMovement;
  const owner = ownerTileset(gid, tilesets);
  if (owner) {
    const declared = owner.tileBlocksMovement[gid - owner.firstgid];
    if (declared !== undefined) return declared;
  }
  // Fall through to the owning tileset's legend — transparent-twin tiles and
  // others added in the legend JSON but missing from the source .tsj end here.
  const legend = legendEntryForGid(gid, tilesets, legendsByTileset);
  if (legend?.blocksMovement !== undefined) return legend.blocksMovement;
  return false;
}

/**
 * Resolve whether a single GID blocks line-of-sight. Encounter override wins,
 * then the owning tileset's legend; defaults to `false`. Tilesets carry no
 * sight data in their `.tsj` (only passability), so sight is authored in the
 * legend / per-encounter.
 */
function resolveGidBlocksSight(
  rawGid: number,
  byGid: Map<number, EncounterTileProperty>,
  tilesets: MapTilesetInfo[],
  legendsByTileset: Record<string, LegendTiles>,
): boolean {
  if (rawGid === 0) return false; // empty object-layer cell — see straight through.
  const gid = stripTileFlipBits(rawGid);
  const explicit = byGid.get(gid);
  if (explicit?.blocksSight !== undefined) return explicit.blocksSight;
  return legendEntryForGid(gid, tilesets, legendsByTileset)?.blocksSight ?? false;
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
  legendsByTileset: Record<string, LegendTiles>,
): GameMap {
  const byGid = new Map<number, EncounterTileProperty>();
  for (const tp of tileProperties ?? []) byGid.set(tp.gid, tp);
  /** Read cover/obscurance for a GID. Encounter override wins; otherwise fall
   *  through to the owning tileset's legend defaults. */
  const tileCoverFor = (gid: number): 'half' | 'three-quarters' | 'total' | null =>
    byGid.get(gid)?.cover ?? legendEntryForGid(gid, saved.tilesets, legendsByTileset)?.cover ?? null;
  const tileObsFor = (gid: number): 'lightly' | 'heavily' | null =>
    byGid.get(gid)?.obscurance ?? legendEntryForGid(gid, saved.tilesets, legendsByTileset)?.obscurance ?? null;
  /** GID whose tile properties win for this cell — the object when present,
   *  otherwise the ground GID. Implements the object-overrides-terrain rule. */
  const effectiveGid = (groundGid: number, objectGid: number): number =>
    objectGid !== 0 ? objectGid : groundGid;
  const blocksMovement: boolean[][] = saved.gidGrid.map((row, y) =>
    row.map((groundGid, x) => {
      const objectGid = saved.objectGidGrid?.[y]?.[x] ?? 0;
      return resolveGidBlocksMovement(effectiveGid(groundGid, objectGid), byGid, saved.tilesets, legendsByTileset);
    }),
  );
  // Sight blocking ORs the ground and object features: vision is stopped if
  // EITHER the terrain or whatever sits on top of it blocks sight (a tree
  // over grass blocks; a clear path over a wall opening does not). This
  // differs from movement, which uses object-overrides-terrain.
  const blocksSight: boolean[][] = saved.gidGrid.map((row, y) =>
    row.map((groundGid, x) => {
      const objectGid = saved.objectGidGrid?.[y]?.[x] ?? 0;
      return resolveGidBlocksSight(groundGid, byGid, saved.tilesets, legendsByTileset)
        || resolveGidBlocksSight(objectGid, byGid, saved.tilesets, legendsByTileset);
    }),
  );
  // Bake per-tile cover and obscurance from the effective tile (object
  // overrides ground per the rule above) plus any encounter override. Cover
  // is a combat concern (AC bonus); sight blocking is handled separately by
  // the `blocksSight` grid above.
  const coverGrid: (null | 'half' | 'three-quarters' | 'total')[][] = saved.gidGrid.map((row, y) =>
    row.map((groundGid, x) => {
      const objectGid = saved.objectGidGrid?.[y]?.[x] ?? 0;
      return tileCoverFor(effectiveGid(groundGid, objectGid));
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
    blocksMovement,
    blocksSight,
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
    ? buildGameMapFromSaved(savedMap, req.tileProperties, defs.tileLegendsByTileset)
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
    // Dev mode `unlockAllSpells` also widens the slot pool — without slots
    // of the right level the L2 (and higher) prepared spells below would
    // appear in the spellbook but stay uncastable. Pool size: 4 slots per
    // level for every level represented in the shipped roster, capped at
    // L9. Combine with `unlimitedSpellSlots` to keep the pool topped off
    // between casts; the two flags are independent and stack cleanly.
    spellSlots: req.devFlags?.unlockAllSpells
      ? (() => {
          const maxLevel = Math.min(9, Math.max(0, ...defs.spells.map((sp) => sp.level)));
          return Array.from({ length: maxLevel }, () => 4);
        })()
      : (req.resumeSpellSlots ?? [...(playerDef.defaultSpellSlots ?? [])]),
    // Dev mode `unlockAllSpells`: seed every L1+ spell from the caster's
    // class as prepared so the tester can invoke any spell without a
    // level-up rebuild. Cantrips are intentionally excluded — they are
    // surfaced via `defaultCantripIds` (also widened by dev mode in
    // GameEngine) and don't belong in the prepared list per SRD. Filtering
    // by class keeps the picker from drowning in cleric/druid spells the
    // wizard can't actually use.
    preparedSpellIds: req.devFlags?.unlockAllSpells
      ? defs.spells.filter((sp) => sp.level > 0 && (
          !playerDef.className || sp.classes.includes(playerDef.className.toLowerCase())
        )).map((sp) => sp.id)
      : (req.resumePreparedSpellIds ?? [...(playerDef.defaultPreparedSpellIds ?? [])]),
    concentratingOn: req.resumeConcentratingOn ?? null,
    // Mage Armor persists across resume — re-seed its buff so `recomputeBuffs`
    // keeps deriving `mageArmor` (the boolean below is the immediate AC seed the
    // GameEngine ctor's `applyEquipment` reads before any recompute runs).
    activeBuffs: req.resumeMageArmor ? [{ spellId: 'mage-armor', modifiers: [{ type: 'flag' as const, name: 'mage-armor' }] }] : [],
    mageArmor: req.resumeMageArmor ?? false,
    shieldActive: false,
    speedBonus: 0,
    expeditiousRetreat: false,
    jumpMultiplier: 1,
    magicWeaponBonus: 0,
    seeInvisible: false,
    ongoingEffects: [],
  };

  const npcs: NpcState[] = [];
  const mapItems: MapItemState[] = [];
  const secrets: SecretState[] = [];

  // Concealed tile traps authored on the encounter (EncounterDef.traps).
  const traps: TrapState[] = (req.traps ?? []).map((t, i) => ({
    id: `trap_${t.id || i}`,
    name: t.name,
    tileX: t.x,
    tileY: t.y,
    armed: true,
    discovered: t.hidden === false,
    detectDC: t.detectDC,
    disarmDC: t.disarmDC ?? 15,
    trigger: {
      saveAbility: t.trigger.saveAbility ?? 'dex',
      saveDC: t.trigger.saveDC,
      damageDice: t.trigger.damageDice,
      damageSides: t.trigger.damageSides,
      damageBonus: t.trigger.damageBonus ?? 0,
      damageType: t.trigger.damageType,
      halfOnSave: t.trigger.halfOnSave ?? true,
      condition: t.trigger.condition,
    },
    triggeredMessage: t.triggeredMessage,
    tintHex: t.tintHex,
  }));

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
      conversationOverrides: req.conversationOverrides,
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
    currentEncounterId: req.encounterId,
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
      canHide: false, canSearch: false,
      usableFeatureIds: [], canDash: false,
      canDodge: false, canDisengage: false, canShortRest: false,
      castableSpellIds: [],
      canDetach: false,
      canLevelUp: false,
      canLongRest: false,
      disarmableTrapTiles: [],
      deployableGearIds: [],
      grappleableTargetIds: [],
      shoveableTargetIds: [],
      attunableItemIds: [],
      unidentifiedItemIds: [],
    },
    pendingReaction: null,
    pendingReroll: null,
    activeConversation: null,
    triggers: req.triggers ?? [],
    firedTriggerIds: [],
    pendingAigmEvents: [],
    worldFlags: req.adventureSeed?.seedWorldFlags ?? {},
    narrationLastUsed: {},
    worldTickCount: 0,
    dayPhase: 'morning',
    activeZones: [],
    traps,
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
    encounterComplete: false,
    encounterCompletionFlag: req.completionFlag ?? req.adventureSeed?.completionFlag,
    environment: req.encounterContext.environment ?? {},
    devFlags: req.devFlags,
  };

  return state;
}
