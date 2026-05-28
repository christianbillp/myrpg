import {
  NpcState, MonsterDef, NPCDef, ItemDef, MapItemState, SecretState, SecretDef, GameMap,
  StartingZonesLayer,
} from './types.js';
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

export function findPlayerSpawn(map: GameMap, zone?: Zone): [number, number] {
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
    factionId = npcDef.factionId ?? defId;
  } else {
    const monsterDef = monsters.find((m) => m.id === defId);
    if (!monsterDef) return;
    name = monsterDef.name;
    maxHp = monsterDef.maxHp;
    factionId = defId;
  }

  const occupied = new Set<string>([
    `${px},${py}`,
    ...out.map((n) => `${n.tileX},${n.tileY}`),
  ]);

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
    id: disposition === 'enemy' ? `enemy_${out.filter((n) => n.disposition === 'enemy').length}` : `${defId}_${out.length}`,
    defId,
    name,
    tileX: nx, tileY: ny,
    disposition, factionId,
    combatLabel,
    hp: maxHp, maxHp,
    isActive: false,
    reactionUsed: false, conditions: [], inventoryIds: [], ongoingEffects: [],
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
}

export function populateNpcs(
  out: { npcs: NpcState[]; mapItems: MapItemState[]; secrets: SecretState[] },
  map: GameMap,
  defs: { npcs: NPCDef[]; monsters: MonsterDef[]; equipment: ItemDef[] },
  input: PopulateNpcsInput,
): void {
  const { allyIds, enemyIds, npcIds, secretDefs,
          playerX, playerY, allyZone, enemyZone, npcZone } = input;

  for (const defId of allyIds ?? []) {
    spawnNpc(out.npcs, map, defs.npcs, defs.monsters, defId, playerX, playerY, 'ally', allyZone);
  }
  for (const defId of enemyIds ?? []) {
    spawnNpc(out.npcs, map, defs.npcs, defs.monsters, defId, playerX, playerY, 'enemy', enemyZone);
  }
  for (const defId of npcIds ?? []) {
    spawnNpc(out.npcs, map, defs.npcs, defs.monsters, defId, playerX, playerY, 'neutral', npcZone);
  }
  if ((enemyIds ?? []).length > 0) {
    spawnItems(out.mapItems, map, defs.equipment, playerX, playerY, out.npcs);
  }
  if ((secretDefs ?? []).length > 0) {
    spawnSecrets(out.secrets, map, secretDefs ?? [], playerX, playerY, out.npcs);
  }
}
