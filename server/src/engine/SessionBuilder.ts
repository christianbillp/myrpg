import {
  GameState, GameMap, GameDefs, EquipmentSlots, NpcState, MapItemState,
  SecretState, QuestState, NpcPersona, CreateSessionRequest,
} from './types.js';
import type { EncounterContext } from '../encounterService.js';
import { generateMap } from './MapGenerator.js';
import { generateRoomsMap } from './RoomsMapGenerator.js';
import {
  ZoneMap, parseStartingZones, findPlayerSpawn,
  spawnEnemies, spawnItems, spawnNpc, spawnSecrets,
} from './SpawnHelpers.js';

/**
 * Build a fresh GameState from an encounter request. Pure: does not mutate
 * any input. The returned state is ready to hand to a new GameEngine.
 */
export function buildSessionState(
  sessionId: string,
  req: CreateSessionRequest & { encounterContext: EncounterContext },
  defs: GameDefs,
  savedMap?: GameMap,
): GameState {
  const playerDef = defs.playerDefs.find((p) => p.id === req.playerDefId);
  if (!playerDef) throw new Error(`Unknown playerDefId: ${req.playerDefId}`);

  const map: GameMap = savedMap ?? (req.mapType === 'rooms' ? generateRoomsMap() : generateMap());

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
