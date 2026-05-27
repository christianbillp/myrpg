/**
 * Token-asset path resolution.
 *
 * Every PlayerDef and MonsterDef must declare its `tokenAsset` explicitly
 * (the path is part of the data, not derived from naming convention). NPCs
 * may omit the field — when absent, callers should fall back to the
 * monsterClass's token, which `GameScene.resolveMonsterDef` does when it
 * synthesises a MonsterDef view of an NPC.
 *
 * Tokens live at `server/data/tokens/*.svg` and are served at `/tokens/<file>`.
 */
import type { PlayerDef, MonsterDef, NPCDef } from "../../../shared/types";

/** Path to a player's token. */
export function tokenAssetForPlayer(def: PlayerDef): string {
  return def.tokenAsset;
}

/** Path to a monster's token. */
export function tokenAssetForMonster(def: MonsterDef): string {
  return def.tokenAsset;
}

/** Path to an NPC's own token, or `undefined` when none is declared — in that
 *  case the caller should resolve the monsterClass's token instead. */
export function tokenAssetForNpc(def: NPCDef): string | undefined {
  return def.tokenAsset;
}
