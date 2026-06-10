/**
 * Asset REST calls — tokens, token specs, tile legends, generated tiles.
 * Stateless; split out of GameClient.
 */
import type { GameState, PlayerDef, StorylogEntry, AdventureSave } from '../../../shared/types';
import type { TileLegendBlock, TilesetMeta } from './GameClient';
import { TokenExistsError } from './GameClient';
import { API_URL } from './apiBase';

/** Fetch the full Token Creator parts library in a single payload — every
 *  slot's full part fragments + a flat catalog of slot → ids. Cached by
 *  the Token Creator scene at boot; subsequent slot picks don't hit the
 *  server again. The fragments still carry `{{COLOR}}` placeholders. */
export async function listTokenParts(): Promise<{
  slots: Record<string, Record<string, string>>;
  catalog: Record<string, string[]>;
}> {
  const res = await fetch(`${API_URL}/tokens/parts`);
  if (!res.ok) throw new Error(`List token parts failed: ${res.status}`);
  return res.json() as Promise<{ slots: Record<string, Record<string, string>>; catalog: Record<string, string[]> }>;
}

/** List every token SVG filename in `data/tokens/`. Used by the Token
 *  Creator's LOAD overlay to build its card grid. */
export async function listTokens(): Promise<string[]> {
  const res = await fetch(`${API_URL}/tokens`);
  if (!res.ok) throw new Error(`List tokens failed: ${res.status}`);
  return res.json() as Promise<string[]>;
}

/** List every author-editable token spec id (filename stem). The LOAD
 *  overlay uses this to distinguish "editable via the Token Creator" from
 *  "legacy hand-authored" tokens. */
export async function listTokenSpecs(): Promise<string[]> {
  const res = await fetch(`${API_URL}/token-specs`);
  if (!res.ok) throw new Error(`List token specs failed: ${res.status}`);
  return res.json() as Promise<string[]>;
}

/** Fetch a saved spec by id for re-editing in the Token Creator. Returns
 *  null when no spec exists for that id (the SVG may still exist as a
 *  legacy hand-authored token). */
export async function loadTokenSpec(id: string): Promise<import("../../../shared/types").TokenSpec | null> {
  const res = await fetch(`${API_URL}/token-specs/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Load token spec failed: ${res.status}`);
  return res.json() as Promise<import("../../../shared/types").TokenSpec>;
}

/** Save a token. Server composes the SVG + writes both `data/tokens/<id>.svg`
 *  and the editable spec. Returns the asset path the NPC Creator should
 *  drop into `NPCDef.tokenAsset`. The server rejects with HTTP 409 when a
 *  token with the same id already exists; the caller catches `TokenExistsError`
 *  to prompt the user, then retries with `overwrite: true`. */
export async function saveToken(
  spec: import("../../../shared/types").TokenSpec,
  opts: { overwrite?: boolean } = {},
): Promise<{ id: string; tokenAsset: string }> {
  const query = opts.overwrite ? "?overwrite=true" : "";
  const res = await fetch(`${API_URL}/token${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(spec),
  });
  if (res.status === 409) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    throw new TokenExistsError(body.error ?? "Token already exists");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    throw new Error(body.error ?? `Token save failed: ${res.status}`);
  }
  return res.json() as Promise<{ id: string; tokenAsset: string }>;
}

/** Per-tileset tile legends (one block per tileset) used by the Tile
 *  Creator to render each tileset's frame grid + load existing attributes. */
export async function listTileLegends(): Promise<{ tilesets: TileLegendBlock[] }> {
  const res = await fetch(`${API_URL}/tilesets/legends`);
  if (!res.ok) throw new Error(`List tile legends failed: ${res.status}`);
  return res.json() as Promise<{ tilesets: TileLegendBlock[] }>;
}

/** Tileset image-slicing metadata (tilewidth/columns/etc.) so the Tile
 *  Creator can crop individual frames from each tileset PNG. */
export async function listTilesetMeta(): Promise<TilesetMeta[]> {
  const res = await fetch(`${API_URL}/tilesets`);
  if (!res.ok) throw new Error(`List tilesets failed: ${res.status}`);
  return res.json() as Promise<TilesetMeta[]>;
}

/** Create or update a single tile's legend entry. Server writes it into
 *  `<tileset>_legend.json` and reloads defs so the new semantics take
 *  effect on the next session. */
export async function saveTileEntry(
  tileset: string,
  gid: number,
  entry: import("../../../shared/types").TileLegendEntry,
): Promise<void> {
  const res = await fetch(`${API_URL}/tilesets/${encodeURIComponent(tileset)}/tiles/${gid}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    throw new Error(body.error ?? `Tile save failed: ${res.status}`);
  }
}

/** AIGM tile generation: a description → an SVG image + suggested legend
 *  attributes. The client rasterises the SVG and composites it into the
 *  shared `generated` tileset before calling `saveGeneratedTile`. */
export async function generateTile(description: string): Promise<{ svg: string; suggested: import("../../../shared/types").TileLegendEntry }> {
  const res = await fetch(`${API_URL}/tiles/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    throw new Error(body.error ?? `Tile generation failed: ${res.status}`);
  }
  return res.json() as Promise<{ svg: string; suggested: import("../../../shared/types").TileLegendEntry }>;
}

/** Existing generated tiles (gid order) + the sheet's grid metadata. The
 *  client re-rasterises every source SVG to rebuild the spritesheet. */
export async function listGeneratedTiles(): Promise<{ tiles: Array<{ gid: number; svg: string; entry: import("../../../shared/types").TileLegendEntry }>; tileSize: number; columns: number }> {
  const res = await fetch(`${API_URL}/tiles/generated`);
  if (!res.ok) throw new Error(`List generated tiles failed: ${res.status}`);
  return res.json() as Promise<{ tiles: Array<{ gid: number; svg: string; entry: import("../../../shared/types").TileLegendEntry }>; tileSize: number; columns: number }>;
}

/** Persist a generated tile: its source SVG, legend entry, and the full
 *  re-assembled spritesheet PNG (base64). Returns the assigned gid. */
export async function saveGeneratedTile(payload: { svg: string; entry: import("../../../shared/types").TileLegendEntry; pngBase64: string }): Promise<{ gid: number }> {
  const res = await fetch(`${API_URL}/tiles/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    throw new Error(body.error ?? `Tile save failed: ${res.status}`);
  }
  return res.json() as Promise<{ gid: number }>;
}
