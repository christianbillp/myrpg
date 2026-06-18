/**
 * Authoring/content REST calls — encounter, adventure, NPC, and map
 * generation/refinement/listing. Stateless; split out of GameClient.
 */
import type { GameState, PlayerDef, StorylogEntry, AdventureSave } from '../../../shared/types';
import type { AdventureRefineDraft, AdventureRefineResponse, ComposedMapAnchors, EncounterRefineDraft, EncounterRefineResponse, NpcRefineDraft, NpcRefineResponse, RefinerTrigger } from './GameClient';
import { API_URL } from './apiBase';

/**
 * Request an AI-generated one-off encounter. The server validates the
 * Claude output, writes both map + encounter JSON files, refreshes its
 * in-memory `defs`, and returns the new encounterId. The caller then
 * starts a session against that encounter via `startGeneratedEncounter`.
 */
export async function generateEncounter(req: {
  prompt: string;
  playerName?: string;
  playerClassName?: string;
}): Promise<{ encounterId: string; mapId: string }> {
  const res = await fetch(`${API_URL}/generate/encounter`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    throw new Error(body.error ?? `Generation failed: ${res.status}`);
  }
  return res.json() as Promise<{ encounterId: string; mapId: string }>;
}

/**
 * Ask the AI to refine an in-progress encounter draft. The server returns
 * a partial patch (only fields the model wants to change) plus a short
 * rationale. The caller computes the diff and shows Accept / Reject — the
 * server does NOT persist anything.
 */
export async function refineEncounter(
  draft: EncounterRefineDraft,
  prompt: string,
): Promise<EncounterRefineResponse> {
  const res = await fetch(`${API_URL}/generate/encounter/refine`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draft, prompt }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    throw new Error(body.error ?? `Refine failed: ${res.status}`);
  }
  return res.json() as Promise<EncounterRefineResponse>;
}

/** Adventure counterpart to `refineEncounter`. The server picks the
 *  encounter pool fresh from disk so newly authored encounters are
 *  immediately available as chapter / rest picks. */
export async function refineAdventure(
  draft: AdventureRefineDraft,
  prompt: string,
): Promise<AdventureRefineResponse> {
  const res = await fetch(`${API_URL}/generate/adventure/refine`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draft, prompt }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    throw new Error(body.error ?? `Refine failed: ${res.status}`);
  }
  return res.json() as Promise<AdventureRefineResponse>;
}

/** NPC counterpart to `refineEncounter` / `refineAdventure`. */
export async function refineNpc(
  draft: NpcRefineDraft,
  prompt: string,
): Promise<NpcRefineResponse> {
  const res = await fetch(`${API_URL}/generate/npc/refine`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draft, prompt }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    throw new Error(body.error ?? `Refine failed: ${res.status}`);
  }
  return res.json() as Promise<NpcRefineResponse>;
}

/**
 * Compose a map deterministically from terrain + features toggles. Used
 * when the player has set any of the map-style toggles on
 * `MapEditorScene` — bypasses Claude entirely and returns a map built
 * by the rule-based composer in `engine/MapComposer.ts`.
 */
export async function composeMap(args: {
  terrain?: 'grassland' | 'forest' | 'dungeon' | 'cave' | 'urban';
  features?: Array<'campsites' | 'coastline' | 'path' | 'intersection' | '3-room' | '5-room' | 'stairs' | 'clearing' | 'river'>;
  seed?: number;
  /** Buildings / ruins (type + connected-room count 1..5, + optional target
   *  region index on a big map). Baked into a single grassland/forest terrain, or
   *  stamped consciously onto a BIG MAP. */
  structures?: Array<{ type: 'building' | 'ruin'; rooms: number; region?: number }>;
  /** BIG multi-region map mode (US-126): 2-5 biome bands in travel order. The
   *  base is the multi-region composer; `structures` and `feature` (if given) are
   *  stamped onto it, re-rolling until they fit cleanly. `terrain`/`features` are
   *  not used in this mode. */
  regions?: Array<{ terrain: 'grassland' | 'forest' | 'urban' | 'cave' | 'dungeon'; share?: number; name?: string; light?: 'bright' | 'dim' | 'dark' }>;
  /** Set-piece recipe (watchtower / cemetery / town_square). Stamped onto the
   *  chosen base — a big map, an open terrain, or (alone) a flat grass field —
   *  re-rolling until it fits cleanly. */
  feature?: string;
  /** The unified placeable catalog (structures + set-pieces): any registry id,
   *  with a room count for building/ruin and an optional target region. Stamped
   *  onto the terrain / big map. */
  placeables?: Array<{ id: string; rooms?: number; region?: number }>;
  /** Map size — used by the regions mode (24×16 up to 96×64). */
  width?: number;
  height?: number;
}): Promise<{
  /** Always null for /generate/map/composed — the preview is not persisted. Call `saveMap` to persist. */
  mapId: null;
  width: number;
  height: number;
  terrainData: number[];
  objectData: number[];
  name: string;
  description: string;
  tilesets: Array<{ firstgid: number; source: string }>;
  /** Story-suitable spawn anchors found / stamped by the composer (campfires, inlandBand, pathEndpoints, etc). */
  anchors: ComposedMapAnchors;
  /** Named tile regions emitted by feature placers (currently `path` and
   *  `intersection`). Empty array when the chosen features produced none. */
  zones: Array<{ id: string; name: string; color: string; cells: string[]; lightLevel?: 'bright' | 'dim' | 'dark' }>;
  /** Placed structures (Phase B), for in-place interior re-roll via `restampMap`. */
  placements: PlacementRecord[];
}> {
  const res = await fetch(`${API_URL}/generate/map/composed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    throw new Error(body.error ?? `Map compose failed: ${res.status}`);
  }
  return res.json() as Promise<ComposeMapResult>;
}

/** A structure placed onto a composed map — re-roll its interior with `restampMap`. */
export interface PlacementRecord { id: string; label: string; x: number; y: number; w: number; h: number; rooms?: number; interiorSeed: number; }

export interface ComposeMapResult {
  mapId: null; width: number; height: number;
  terrainData: number[]; objectData: number[];
  name: string; description: string;
  tilesets: Array<{ firstgid: number; source: string }>;
  anchors: ComposedMapAnchors;
  zones: Array<{ id: string; name: string; color: string; cells: string[]; lightLevel?: 'bright' | 'dim' | 'dark' }>;
  placements: PlacementRecord[];
}

/** Re-roll placed structures' interiors IN PLACE — `index` re-rolls one, omit for
 *  all — without recomposing the map. Returns the updated composed map. */
export async function restampMap(args: {
  width: number; height: number; terrainData: number[]; objectData: number[];
  name?: string; description?: string;
  zones?: Array<{ id: string; name: string; color: string; cells: string[]; lightLevel?: 'bright' | 'dim' | 'dark' }>;
  placements: PlacementRecord[];
  index?: number;
}): Promise<ComposeMapResult> {
  const res = await fetch(`${API_URL}/generate/map/restamp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    throw new Error(body.error ?? `Restamp failed: ${res.status}`);
  }
  return res.json() as Promise<ComposeMapResult>;
}

/**
 * Persist a map. Returns the mapId. When `existingMapId` is set the
 * server overwrites that map in place (used by the Map Editor's LOAD MAP
 * → edit → SAVE flow); otherwise a fresh `gen_<stamp>_<slug>` id is
 * allocated.
 */
export async function saveMap(args: {
  name: string;
  description: string;
  width: number;
  height: number;
  terrainData: number[];
  objectData: number[];
  tilesets?: Array<{ firstgid: number; source: string }>;
  /** Author-time named tile regions. Persists alongside the map; optional
   *  — omit if the map has none. */
  zones?: Array<{ id: string; name: string; color: string; cells: string[]; lightLevel?: 'bright' | 'dim' | 'dark' }>;
  existingMapId?: string;
}): Promise<{ mapId: string }> {
  const res = await fetch(`${API_URL}/generate/map/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    throw new Error(body.error ?? `Map save failed: ${res.status}`);
  }
  return res.json() as Promise<{ mapId: string }>;
}

/**
 * Compose a full encounter (map + encounter shell) deterministically. No
 * Claude call — the server writes both files directly from the toggles
 * and the optional player description. Returns the new encounterId so
 * the caller can hand the player off to the character-select screen with
 * the new encounter pre-selected.
 *
 * `existingMapId` reuses an already-saved map (e.g. one the user has
 * already accepted via the COMPOSE MAP preview) instead of composing a
 * new one. In that mode the `terrain` / `features` fields are ignored.
 * `startingZonesData` is a flat row-major zone array (1 = player, 2 =
 * ally, 4 = enemy); when omitted the server picks the first passable
 * cell as the lone player zone.
 */
export async function composeEncounter(args: {
  existingMapId?: string;
  terrain?: 'grassland' | 'forest' | 'dungeon' | 'cave' | 'urban';
  features?: Array<'campsites' | 'coastline' | 'path' | 'intersection' | '3-room' | '5-room' | 'stairs' | 'clearing' | 'river'>;
  structures?: Array<{ type: 'building' | 'ruin'; rooms: number; region?: number }>;
  /** Multi-region big-map bands (composed with placeable/road extras). */
  regions?: Array<{ terrain: 'grassland' | 'forest' | 'urban' | 'cave' | 'dungeon'; share?: number; name?: string; light?: 'bright' | 'dim' | 'dark' }>;
  /** A single set-piece stamped onto the base. */
  feature?: string;
  /** Unified placeable catalog (structures + set-pieces) stamped onto the map. */
  placeables?: Array<{ id: string; rooms?: number; region?: number }>;
  /** Long-form AIGM scene context (writes to the encounter's `customContext`). */
  aigmContext?: string;
  /** Player-facing card summary (writes to the encounter's `description`). */
  description?: string;
  seed?: number;
  startingZonesData?: number[];
  allyIds?: string[];
  enemyIds?: string[];
  neutralIds?: string[];
  customTitle?: string;
  customIntroduction?: string;
  customObjective?: string;
  completionFlag?: string;
  /** Author-painted triggers: rectangular region + one of the action
   *  templates. Each entry may also carry `extraActions[]` so the
   *  server emits a single EncounterTrigger with multiple consequences. */
  triggers?: RefinerTrigger[];
}): Promise<{
  mapId: string;
  encounterId: string;
  width: number;
  height: number;
  terrainData: number[];
  objectData: number[];
  name: string;
  description: string;
}> {
  const res = await fetch(`${API_URL}/generate/encounter/composed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    throw new Error(body.error ?? `Compose encounter failed: ${res.status}`);
  }
  return res.json() as Promise<{
    mapId: string; encounterId: string;
    width: number; height: number;
    terrainData: number[]; objectData: number[];
    name: string; description: string;
  }>;
}

/**
 * Fetch the live encounters list from the server. Used by EncounterSetupScene
 * to refresh the cached registry after a new encounter has been generated.
 */
export async function listEncounters(): Promise<unknown[]> {
  const res = await fetch(`${API_URL}/encounters`);
  if (!res.ok) throw new Error(`List encounters failed: ${res.status}`);
  return res.json() as Promise<unknown[]>;
}

/** Fetch all authored adventures from the active setting. Used by the
 *  Adventure Creator's LOAD button + by the player-side AdventureSetupScene
 *  refresh path. */
export async function listAdventures(): Promise<unknown[]> {
  const res = await fetch(`${API_URL}/adventures`);
  if (!res.ok) throw new Error(`List adventures failed: ${res.status}`);
  return res.json() as Promise<unknown[]>;
}

/** Upsert an authored adventure. Body is an `AdventureDef`; the server
 *  writes `<active-setting>/adventures/<id>.json` and reloads defs.
 *  Returns the persisted id. */
export async function saveAdventure(adventure: import("../../../shared/types").AdventureDef): Promise<{ adventureId: string }> {
  const res = await fetch(`${API_URL}/adventure`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(adventure),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    throw new Error(body.error ?? `Adventure save failed: ${res.status}`);
  }
  return res.json() as Promise<{ adventureId: string }>;
}

/** Fetch every NPC the active setting carries. Refresh path for the NPC
 *  Creator's LOAD overlay and for clients that want a fresh registry
 *  without a page reload after a SAVE. */
export async function listNpcs(): Promise<unknown[]> {
  const res = await fetch(`${API_URL}/npcs`);
  if (!res.ok) throw new Error(`List NPCs failed: ${res.status}`);
  return res.json() as Promise<unknown[]>;
}

/** Upsert an authored NPC. Server validates the `monsterClass` against the
 *  monster roster (the engine resolves an NPC's stats by looking up its
 *  monsterClass) and writes `<active-setting>/npcs/<id>.json`. */
export async function saveNpc(npc: import("../../../shared/types").NPCDef): Promise<{ npcId: string }> {
  const res = await fetch(`${API_URL}/npc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(npc),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    throw new Error(body.error ?? `NPC save failed: ${res.status}`);
  }
  return res.json() as Promise<{ npcId: string }>;
}

/** Author-side preview chat for an NPC draft. No session required. */
export async function testNpcChat(
  draft: { name: string; monsterClass?: string; factionId?: string; persona: string },
  history: Array<{ role: "user" | "assistant"; content: string }>,
  prompt: string,
): Promise<{ reply: string }> {
  const res = await fetch(`${API_URL}/npc/test-chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draft, history, prompt }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    throw new Error(body.error ?? `Test chat failed: ${res.status}`);
  }
  return res.json() as Promise<{ reply: string }>;
}

/**
 * Update an existing encounter in place — used by `EncounterCreatorScene`.
 * Mirrors `composeEncounter`'s body shape but requires an `encounterId`
 * and skips map composition (the encounter's existing `mapId` is reused
 * unless the caller supplies a new one).
 */
export async function updateEncounter(args: {
  encounterId: string;
  mapId?: string;
  /** Long-form AIGM scene context (writes to the encounter's `customContext`). */
  aigmContext?: string;
  /** Player-facing card summary (writes to the encounter's `description`). */
  description?: string;
  startingZonesData?: number[];
  /** Starting-location mode (`'zones'` = random in zones, `'exact'` = per-entity tiles). */
  placementMode?: 'zones' | 'exact';
  /** Per-entity exact-tile bindings (consumed only when `placementMode === 'exact'`). */
  placements?: import("../../../shared/types").EncounterPlacement[];
  allyIds?: string[];
  enemyIds?: string[];
  neutralIds?: string[];
  customTitle?: string;
  customIntroduction?: string;
  customObjective?: string;
  completionFlag?: string;
  triggers?: RefinerTrigger[];
}): Promise<{ encounterId: string; mapId: string }> {
  const res = await fetch(`${API_URL}/generate/encounter/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    throw new Error(body.error ?? `Update encounter failed: ${res.status}`);
  }
  return res.json() as Promise<{ encounterId: string; mapId: string }>;
}

/**
 * Fetch the live maps list from the server. Used after a fresh map has been
 * generated so the client's registry can pick it up without restarting.
 */
export async function listMaps(): Promise<unknown[]> {
  const res = await fetch(`${API_URL}/maps`);
  if (!res.ok) throw new Error(`List maps failed: ${res.status}`);
  return res.json() as Promise<unknown[]>;
}

/** Fetch the live factions list from the server. Used by BootScene to seed the registry. */
export async function listFactions(): Promise<unknown[]> {
  const res = await fetch(`${API_URL}/factions`);
  if (!res.ok) throw new Error(`List factions failed: ${res.status}`);
  return res.json() as Promise<unknown[]>;
}

/**
 * Delete every map and encounter in the `gen_*` namespace. Used by the
 * dev-mode button on MapEditorScene so iterating on prompts doesn't
 * accumulate clutter in the maps list.
 */
export async function deleteAllGeneratedMaps(): Promise<{ mapsDeleted: number; encountersDeleted: number }> {
  const res = await fetch(`${API_URL}/generate/maps/all`, { method: 'DELETE' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    throw new Error(body.error ?? `Delete failed: ${res.status}`);
  }
  return res.json() as Promise<{ mapsDeleted: number; encountersDeleted: number }>;
}

/**
 * Promote a generated (`gen_*`) encounter to a stable premade id. The slug
 * defaults to a sanitised version of the encounter title; if omitted the
 * server derives it. Renames the encounter JSON, removes its `generated`
 * flag, and (if it references a `gen_*` map) renames that too.
 */
export async function promoteEncounter(encounterId: string, slug?: string): Promise<{ encounterId: string; mapId?: string }> {
  const res = await fetch(`${API_URL}/generate/encounter/promote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ encounterId, slug }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    throw new Error(body.error ?? `Promote failed: ${res.status}`);
  }
  return res.json() as Promise<{ encounterId: string; mapId?: string }>;
}

/**
 * Generate just a map (no encounter wrapper). Returns the map's id and
 * the raw GID arrays so the client can render a preview without an
 * additional round-trip. The map is persisted on disk for future use.
 */
export async function generateMap(prompt: string): Promise<{
  mapId: string;
  width: number;
  height: number;
  terrainData: number[];
  objectData: number[];
  name: string;
  description: string;
}> {
  const res = await fetch(`${API_URL}/generate/map`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    throw new Error(body.error ?? `Map generation failed: ${res.status}`);
  }
  return res.json() as Promise<{
    mapId: string; width: number; height: number;
    terrainData: number[]; objectData: number[];
    name: string; description: string;
  }>;
}
