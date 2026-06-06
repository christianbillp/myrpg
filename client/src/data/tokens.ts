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

/** Normalise a token path so it always starts with a leading slash. Callers
 *  build URLs as `${API_URL}${path}`, so a path missing the slash yields a
 *  malformed URL (`http://host:3000tokens/…`) that fails to load — which, for
 *  the in-game player sprite, surfaces as a broken/missing texture. Created
 *  characters (US-122) could carry a slash-less default, so guard here. */
function normalizeTokenPath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

/** Path to a player's token. */
export function tokenAssetForPlayer(def: PlayerDef): string {
  return normalizeTokenPath(def.tokenAsset);
}

/** Path to a monster's token. */
export function tokenAssetForMonster(def: MonsterDef): string {
  return normalizeTokenPath(def.tokenAsset);
}

/** Path to an NPC's own token, or `undefined` when none is declared — in that
 *  case the caller should resolve the monsterClass's token instead. */
export function tokenAssetForNpc(def: NPCDef): string | undefined {
  return def.tokenAsset ? normalizeTokenPath(def.tokenAsset) : undefined;
}
