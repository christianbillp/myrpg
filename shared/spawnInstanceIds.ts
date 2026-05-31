/**
 * Spawn-time naming for NPC slots.
 *
 * One canonical source of truth for the per-defId dedup that turns
 * `npcIds: ["bandit", "bandit"]` into runtime instance ids `bandit_1` and
 * `bandit_2`. The same algorithm runs at spawn time (`SpawnHelpers.populateNpcs`)
 * and at refine time (`encounterRefiner.ts` rewriting `npc_speaks.entity`
 * slot refs into instance ids); keeping them in one module guarantees the
 * two stay in lockstep when the rules evolve.
 *
 * The walk order is **ally → enemy → neutral**, with a global per-defId
 * counter. A defId that appears only once across the three arrays gets the
 * bare defId as its instance id; multiple instances get
 * `${defId}_${ordinal}` where the ordinal is the 1-based spawn count of
 * that defId.
 */

export interface SpawnIdLists {
  /** Allies (NPCs that spawn friendly to the player). */
  allyIds: string[];
  /** Enemies (NPCs that spawn hostile to the player). */
  enemyIds: string[];
  /** Neutrals — written `npcIds` in `EncounterDef`. Kept as `npcIds` here
   *  to match the field that already exists in the encounter JSON. */
  npcIds: string[];
}

export type SpawnRole = 'ally' | 'enemy' | 'neutral';

/**
 * Total number of times `defId` appears across all three spawn arrays.
 * Used by callers that need to know whether the bare defId or the
 * suffixed form is appropriate.
 */
export function totalSpawnCount(defId: string, lists: SpawnIdLists): number {
  return lists.allyIds.filter((id) => id === defId).length
    + lists.enemyIds.filter((id) => id === defId).length
    + lists.npcIds.filter((id) => id === defId).length;
}

/**
 * The 1-based global ordinal of the slot at `(role, index)` for its defId.
 * Walks ally → enemy → neutral up to and including the target slot. Throws
 * when the slot index is out of range for its role list — callers
 * validating an authored slot ref should check the index first.
 */
export function spawnOrdinalForSlot(role: SpawnRole, index: number, lists: SpawnIdLists): number {
  const list = role === 'ally' ? lists.allyIds
             : role === 'enemy' ? lists.enemyIds
             : lists.npcIds;
  if (index < 0 || index >= list.length) {
    throw new Error(`spawnOrdinalForSlot: index ${index} is out of range for role "${role}" (size ${list.length})`);
  }
  const defId = list[index];
  let ordinal = 0;
  const order: Array<{ arr: string[]; r: SpawnRole }> = [
    { arr: lists.allyIds, r: 'ally' },
    { arr: lists.enemyIds, r: 'enemy' },
    { arr: lists.npcIds, r: 'neutral' },
  ];
  for (const { arr, r } of order) {
    const end = r === role ? index + 1 : arr.length;
    for (let i = 0; i < end; i++) {
      if (arr[i] === defId) ordinal++;
    }
    if (r === role) break;
  }
  return ordinal;
}

/**
 * The instance id assigned to the NPC at `(role, index)`. Singletons get
 * the bare defId; duplicates get `${defId}_${ordinal}` (1-based).
 *
 * Returns `null` when the slot index is out of range — callers can use
 * that to detect authoring mistakes.
 */
export function instanceIdForSlot(role: SpawnRole, index: number, lists: SpawnIdLists): string | null {
  const list = role === 'ally' ? lists.allyIds
             : role === 'enemy' ? lists.enemyIds
             : lists.npcIds;
  if (index < 0 || index >= list.length) return null;
  const defId = list[index];
  const total = totalSpawnCount(defId, lists);
  if (total <= 1) return defId;
  const ordinal = spawnOrdinalForSlot(role, index, lists);
  return `${defId}_${ordinal}`;
}
