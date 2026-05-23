import {
  NpcState, MonsterDef, NPCDef, ItemDef, MapItemState, SecretState, SecretDef, GameMap,
} from './types.js';
import { shuffle } from './MapUtils.js';
import { chebyshev } from './EnemyAI.js';

export type Zone = [number, number][]; // [tileX, tileY] pairs, already filtered to passable tiles
export type ZoneMap = Map<string, Zone>;

export function parseStartingZones(rows: string[], map: GameMap): ZoneMap {
  const result: ZoneMap = new Map();
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      const ch = rows[r][c];
      if (ch === '.' || ch === '#' || ch === ' ') continue;
      if (!map.passable[r]?.[c]) continue;
      if (!result.has(ch)) result.set(ch, []);
      result.get(ch)!.push([c, r]);
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

export function spawnEnemies(
  out: NpcState[], map: GameMap, monsters: MonsterDef[],
  px: number, py: number, count: number,
  zone?: Zone,
): void {
  const defs = monsters.filter((m) => m.cr !== '0');
  const occupied = new Set<string>([`${px},${py}`, ...out.map((n) => `${n.tileX},${n.tileY}`)]);

  if (zone) {
    const free = shuffle(zone.filter(([c, r]) => !occupied.has(`${c},${r}`))).slice(0, Math.min(count, zone.length));
    free.forEach(([c, r], i) => {
      const def = defs[Math.floor(Math.random() * defs.length)];
      out.push({
        id: `enemy_${i}`, defId: def.id, name: def.name, label: String.fromCharCode(65 + i),
        tileX: c, tileY: r,
        disposition: 'enemy', factionId: def.id,
        hp: def.maxHp, maxHp: def.maxHp,
        isActive: false,
        reactionUsed: false, conditions: [],
      });
    });
    return;
  }

  const { cols, rows, passable } = map;
  const candidates: [number, number][] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      if (passable[r][c] && chebyshev(c, r, px, py) >= 5) candidates.push([r, c]);
  const picked = shuffle(candidates).slice(0, Math.min(count, candidates.length));
  picked.forEach(([r, c], i) => {
    const def = defs[Math.floor(Math.random() * defs.length)];
    out.push({
      id: `enemy_${i}`, defId: def.id, name: def.name, label: String.fromCharCode(65 + i),
      tileX: c, tileY: r,
      disposition: 'enemy', factionId: def.id,
      hp: def.maxHp, maxHp: def.maxHp,
      isActive: false,
      reactionUsed: false, conditions: [],
    });
  });
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
  disposition: 'neutral' | 'ally' = 'neutral',
  zone?: Zone,
): void {
  const npcDef = npcDefs.find((n) => n.id === defId);
  if (!npcDef) return;
  const monsterDef = monsters.find((m) => m.id === npcDef.monsterClass);
  const maxHp = monsterDef?.maxHp ?? 8;
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
        const inRange = disposition === 'ally' ? dist >= 1 && dist <= 3 : dist >= 5;
        if (passable[r][c] && inRange && !occupied.has(`${c},${r}`))
          candidates.push([c, r]);
      }
  }

  if (candidates.length === 0) return;
  const [nx, ny] = candidates[Math.floor(Math.random() * candidates.length)];
  out.push({
    id: `npc_${defId}_${out.length}`,
    defId,
    name: npcDef.name,
    tileX: nx, tileY: ny,
    disposition, factionId: defId,
    label: '',
    hp: maxHp, maxHp,
    isActive: false,
    reactionUsed: false, conditions: [],
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
