import {
  NpcState, MonsterDef, NPCDef, ItemDef, MapItemState, SecretState, SecretDef, GameMap,
  StartingZonesLayer,
} from './types.js';
import { totalSpawnCount, spawnOrdinalForSlot } from '../../../shared/spawnInstanceIds.js';
import { shuffle } from './MapUtils.js';
import { chebyshev } from './EnemyAI.js';
import {
  STARTING_ZONE_PLAYER, STARTING_ZONE_ALLY, STARTING_ZONE_NEUTRAL, STARTING_ZONE_ENEMY,
  ZONE_LETTER,
} from '../../../shared/startingZones.js';

export type Zone = [number, number][]; // [tileX, tileY] pairs, already filtered to passable tiles
export type ZoneMap = Map<string, Zone>;

// Encounter JSONs encode the spawn layer as flat row-major GIDs from the
// `STARTING_ZONE_*` constants in `shared/startingZones.ts`. The legacy ASCII
// letters (P/A/N/E) are preserved as ZoneMap keys so SessionBuilder's
// `zoneMap.get('P')` lookups don't need to change.
const GID_TO_ZONE_KEY: Record<number, string> = {
  [STARTING_ZONE_PLAYER]:  ZONE_LETTER[STARTING_ZONE_PLAYER],
  [STARTING_ZONE_ALLY]:    ZONE_LETTER[STARTING_ZONE_ALLY],
  [STARTING_ZONE_NEUTRAL]: ZONE_LETTER[STARTING_ZONE_NEUTRAL],
  [STARTING_ZONE_ENEMY]:   ZONE_LETTER[STARTING_ZONE_ENEMY],
};

export function parseStartingZones(layer: StartingZonesLayer, map: GameMap): ZoneMap {
  const result: ZoneMap = new Map();
  for (let y = 0; y < layer.height; y++) {
    for (let x = 0; x < layer.width; x++) {
      const gid = layer.data[y * layer.width + x];
      if (!gid) continue;
      const key = GID_TO_ZONE_KEY[gid];
      if (!key) continue;
      if (!map.passable[y]?.[x]) continue;
      if (!result.has(key)) result.set(key, []);
      result.get(key)!.push([x, y]);
    }
  }
  return result;
}

export function pickFromZone(zone: Zone, occupied: Set<string>): [number, number] | null {
  const free = zone.filter(([c, r]) => !occupied.has(`${c},${r}`));
  if (!free.length) return null;
  return free[Math.floor(Math.random() * free.length)];
}

export function findPlayerSpawn(map: GameMap, zone?: Zone, exactTile?: [number, number]): [number, number] {
  // Exact placement wins when the bound tile is in bounds and passable.
  // Anything else falls through to the zone / left-third defaults so an
  // accidentally-wall-bound exact placement doesn't strand the player.
  if (exactTile) {
    const [ex, ey] = exactTile;
    const { cols, rows, passable } = map;
    if (ex >= 0 && ex < cols && ey >= 0 && ey < rows && passable[ey][ex]) return [ex, ey];
  }
  if (zone) {
    const pick = zone[Math.floor(Math.random() * zone.length)];
    if (pick) return pick;
  }
  const { cols, rows, passable } = map;
  const candidates: [number, number][] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < Math.floor(cols / 3); c++)
      if (passable[r][c]) candidates.push([c, r]);
  if (candidates.length > 0) return candidates[Math.floor(Math.random() * candidates.length)];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      if (passable[r][c]) return [c, r];
  return [0, 0];
}


export function spawnItems(
  out: MapItemState[], map: GameMap, items: ItemDef[],
  px: number, py: number, npcs: NpcState[],
): void {
  const potion = items.find((i) => i.id === 'health_potion');
  if (!potion) return;
  const { cols, rows, passable } = map;
  const candidates: [number, number][] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      if (passable[r][c] && chebyshev(c, r, px, py) >= 3 && !npcs.some((n) => n.tileX === c && n.tileY === r))
        candidates.push([r, c]);
  shuffle(candidates).slice(0, Math.min(3, candidates.length)).forEach(([r, c], i) => {
    out.push({ id: `item_${i}`, defId: potion.id, tileX: c, tileY: r });
  });
}

export function spawnNpc(
  out: NpcState[], map: GameMap, npcDefs: NPCDef[], monsters: MonsterDef[],
  defId: string, px: number, py: number,
  disposition: 'neutral' | 'ally' | 'enemy' = 'neutral',
  zone?: Zone,
  /**
   * Exact tile bound to this slot via the encounter's `placements[]` array
   * (when `placementMode === 'exact'`). When set and passable + free, the
   * spawn lands there unconditionally; the zone-based search is skipped.
   * On a blocked / occupied / out-of-bounds tile we fall through to the
   * normal zone / distance-gated search so the encounter still produces a
   * working spawn instead of silently dropping the NPC.
   */
  exactTile?: [number, number],
  /**
   * Disambiguates duplicate spawns of the same defId. When > 1, the spawned
   * NPC's name gets a ` #N` suffix (1-based) so the player and the AIGM can
   * tell two bandits apart in the Event Log, Target Panel, and tool-result
   * narration. Caller (`populateNpcs`) computes `dupCount` and passes the
   * 1-based ordinal so the suffix is stable across spawns.
   */
  dupOrdinal?: number,
  dupCount?: number,
  /** Effective conversation graph id for this spawn — encounter override
   *  resolved by the caller against `EncounterDef.conversationOverrides`.
   *  Lands on `NpcState.conversationId` when present; the TALK button
   *  reads it directly from the state instead of from `NPCDef.conversationId`. */
  conversationOverride?: string,
): void {
  // Resolve the def: NPC roster first (named characters with personas),
  // then the monster roster (raw creature stats). This lets the
  // deterministic compose-encounter flow pass monster ids directly into
  // allyIds / enemyIds without authoring an NPC wrapper for each one.
  const npcDef = npcDefs.find((n) => n.id === defId);
  let name: string;
  let maxHp: number;
  // Faction resolution:
  //   • Named NPCs carry the worldbuilding — NPCDef.factionId is the source
  //     of truth (e.g. "bridge_bandit" → "bandits").
  //   • Raw monster spawns (no NPC wrapper, e.g. `enemyIds: ['bandit']`)
  //     fall back to using the def id itself as a faction-of-one. That
  //     preserves the existing implicit-faction aggro behaviour for the
  //     generator / random-encounter content path. Authors who want raw
  //     monster spawns to participate in the wider faction matrix should
  //     either author a thin NPC wrapper or use a future per-spawn
  //     faction override.
  let factionId: string;
  if (npcDef) {
    name = npcDef.name;
    const monsterDef = monsters.find((m) => m.id === npcDef.monsterClass);
    maxHp = monsterDef?.maxHp ?? 8;
    // NPC's factionId wins; if absent, fall back to the def id as a
    // faction-of-one. (MonsterDef no longer carries factionId — monsters
    // are pure stat blocks; faction membership lives on the NPC wrapper.)
    factionId = npcDef.factionId ?? defId;
  } else {
    const monsterDef = monsters.find((m) => m.id === defId);
    if (!monsterDef) return;
    name = monsterDef.name;
    maxHp = monsterDef.maxHp;
    factionId = defId;
  }

  // Per-def deterministic instance id + name suffix when the encounter
  // spawns more than one of the same defId. Singletons keep the bare
  // defId as id (preserves existing references like `npc_tavern_keeper`).
  const isDup = (dupCount ?? 1) > 1;
  const instanceId = isDup ? `${defId}_${dupOrdinal ?? 1}` : defId;
  if (isDup) name = `${name} #${dupOrdinal ?? 1}`;

  const occupied = new Set<string>([
    `${px},${py}`,
    ...out.map((n) => `${n.tileX},${n.tileY}`),
  ]);

  // Exact placement wins when the bound tile is in bounds, passable, and
  // not already claimed by the player or a previously-spawned NPC. Anything
  // else falls through to the zone path so authors can't accidentally erase
  // a spawn by binding it to a wall or another entity.
  if (exactTile) {
    const [ex, ey] = exactTile;
    const { cols, rows, passable } = map;
    if (ex >= 0 && ex < cols && ey >= 0 && ey < rows && passable[ey][ex] && !occupied.has(`${ex},${ey}`)) {
      let combatLabel = '';
      if (disposition === 'enemy') {
        const enemyCount = out.filter((n) => n.disposition === 'enemy').length;
        combatLabel = String.fromCharCode(65 + enemyCount);
      }
      out.push({
        id: instanceId,
        defId,
        name,
        tileX: ex, tileY: ey,
        disposition,
        attitude: npcDef?.attitude ?? 'indifferent',
        factionId,
        combatLabel,
        hp: maxHp, maxHp,
        isActive: false,
        reactionUsed: false, conditions: [], inventoryIds: [], ongoingEffects: [],
        ...(npcDef?.routine && npcDef.routine.length > 0 ? { routine: npcDef.routine } : {}),
        ...(() => {
          const cid = conversationOverride ?? npcDef?.conversationId;
          return cid ? { conversationId: cid } : {};
        })(),
      });
      return;
    }
  }

  let candidates: [number, number][];
  if (zone) {
    candidates = zone.filter(([c, r]) => !occupied.has(`${c},${r}`));
  } else {
    const { cols, rows, passable } = map;
    candidates = [];
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const dist = chebyshev(c, r, px, py);
        // Distance gate by disposition: allies hug close (1-3 tiles), enemies
        // start at sniping range (≥5), neutrals likewise stay back.
        const inRange = disposition === 'ally' ? dist >= 1 && dist <= 3 : dist >= 5;
        if (passable[r][c] && inRange && !occupied.has(`${c},${r}`))
          candidates.push([c, r]);
      }
  }

  if (candidates.length === 0) return;
  const [nx, ny] = candidates[Math.floor(Math.random() * candidates.length)];

  // Enemies need a unique combatLabel ("A", "B", …) for combat-log readability.
  let combatLabel = '';
  if (disposition === 'enemy') {
    const enemyCount = out.filter((n) => n.disposition === 'enemy').length;
    combatLabel = String.fromCharCode(65 + enemyCount);
  }

  out.push({
    id: instanceId,
    defId,
    name,
    tileX: nx, tileY: ny,
    disposition,
    attitude: npcDef?.attitude ?? 'indifferent',
    factionId,
    combatLabel,
    hp: maxHp, maxHp,
    isActive: false,
    reactionUsed: false, conditions: [], inventoryIds: [], ongoingEffects: [],
    ...(npcDef?.routine && npcDef.routine.length > 0 ? { routine: npcDef.routine } : {}),
    ...(() => {
      const cid = conversationOverride ?? npcDef?.conversationId;
      return cid ? { conversationId: cid } : {};
    })(),
  });
}

export function spawnSecrets(
  out: SecretState[], map: GameMap, secretDefs: SecretDef[],
  px: number, py: number, npcs: NpcState[],
): void {
  const { cols, rows, passable } = map;
  const candidates: [number, number][] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      if (passable[r][c] && chebyshev(c, r, px, py) >= 3 && !npcs.some((n) => n.tileX === c && n.tileY === r))
        candidates.push([r, c]);
  shuffle(candidates).slice(0, Math.min(secretDefs.length, candidates.length)).forEach(([r, c], i) => {
    out.push({ tileX: c, tileY: r, def: secretDefs[i] as SecretDef });
  });
}

/**
 * Single entry point for populating a freshly-built encounter map with NPCs,
 * items and secrets — collapses the four separate spawn calls that used to
 * live inline in `SessionBuilder` into one declarative pass keyed off the
 * encounter's id lists + types.
 *
 * Spawn rules (data-driven; the legacy `encounterTypes` gating is gone):
 *  • Allies (`allyIds`) — spawned near the player at the ally zone.
 *  • Hand-picked enemies (`enemyIds`) — spawned at the enemy zone.
 *  • Neutral NPCs (`npcIds`) — spawned at the npc zone.
 *  • Ground items (healing potions etc.) — spawned when the encounter
 *    contains at least one hand-picked enemy.
 *  • Secrets — spawned when the encounter author seeded any `secretDefs`.
 *    The default 4-pick pool means most encounters get them automatically.
 */
export interface PopulateNpcsInput {
  allyIds?: string[];
  enemyIds?: string[];
  npcIds?: string[];
  secretDefs?: SecretDef[];
  playerX: number;
  playerY: number;
  allyZone?: Zone;
  enemyZone?: Zone;
  npcZone?: Zone;
  /**
   * Per-entity exact tile overrides — only the entries whose `role` matches
   * `ally` / `enemy` / `neutral` are consumed here (the `player` role is
   * applied earlier, in `findPlayerSpawn`). For each spawn iteration we look
   * up `(role, index)` and pass the bound tile to `spawnNpc`, which falls
   * back to the zone path if the tile is blocked/occupied.
   */
  placements?: import('../../../shared/types.js').EncounterPlacement[];
  /** Per-defId conversation override map — see `EncounterDef.conversationOverrides`.
   *  Threaded through to `spawnNpc` so the resolved `conversationId` lands
   *  on each spawned `NpcState`. */
  conversationOverrides?: Record<string, string>;
}

export function populateNpcs(
  out: { npcs: NpcState[]; mapItems: MapItemState[]; secrets: SecretState[] },
  map: GameMap,
  defs: { npcs: NPCDef[]; monsters: MonsterDef[]; equipment: ItemDef[] },
  input: PopulateNpcsInput,
): void {
  const { allyIds, enemyIds, npcIds, secretDefs,
          playerX, playerY, allyZone, enemyZone, npcZone, placements, conversationOverrides } = input;

  // Build a per-role lookup: index → [x, y]. Faster than scanning the array
  // for every spawn (encounters with many NPCs would otherwise be O(n²)).
  const placementByRoleIndex: Record<string, [number, number]> = {};
  for (const p of placements ?? []) {
    if (p.role === 'player') continue;
    placementByRoleIndex[`${p.role}:${p.index}`] = [p.x, p.y];
  }
  const exactFor = (role: 'ally' | 'enemy' | 'neutral', index: number): [number, number] | undefined =>
    placementByRoleIndex[`${role}:${index}`];

  // Per-defId dedup naming. The shared `spawnInstanceIds` module is the
  // single source of truth for the (role, index) → ordinal/count mapping;
  // `encounterRefiner` also consumes it when rewriting slot refs in
  // `npc_speaks.entity`. Centralising the algorithm keeps both call sites
  // in lockstep when the rules evolve.
  const lists = { allyIds: allyIds ?? [], enemyIds: enemyIds ?? [], npcIds: npcIds ?? [] };
  const dupCount = (defId: string): number => totalSpawnCount(defId, lists);

  const overrideFor = (defId: string): string | undefined => conversationOverrides?.[defId];
  (allyIds ?? []).forEach((defId, i) => {
    spawnNpc(out.npcs, map, defs.npcs, defs.monsters, defId, playerX, playerY, 'ally', allyZone,
      exactFor('ally', i), spawnOrdinalForSlot('ally', i, lists), dupCount(defId), overrideFor(defId));
  });
  (enemyIds ?? []).forEach((defId, i) => {
    spawnNpc(out.npcs, map, defs.npcs, defs.monsters, defId, playerX, playerY, 'enemy', enemyZone,
      exactFor('enemy', i), spawnOrdinalForSlot('enemy', i, lists), dupCount(defId), overrideFor(defId));
  });
  (npcIds ?? []).forEach((defId, i) => {
    spawnNpc(out.npcs, map, defs.npcs, defs.monsters, defId, playerX, playerY, 'neutral', npcZone,
      exactFor('neutral', i), spawnOrdinalForSlot('neutral', i, lists), dupCount(defId), overrideFor(defId));
  });
  if ((enemyIds ?? []).length > 0) {
    spawnItems(out.mapItems, map, defs.equipment, playerX, playerY, out.npcs);
  }
  if ((secretDefs ?? []).length > 0) {
    spawnSecrets(out.secrets, map, secretDefs ?? [], playerX, playerY, out.npcs);
  }
}
