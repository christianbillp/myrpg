/**
 * Shared helper for writing a Tiled-shape map JSON to disk. Used by all three
 * map-write call sites (`/generate/map/composed`, `/generate/encounter/composed`,
 * and `encounterGenerator.generateMap`) so the file shape and tileset path are
 * declared in exactly one place.
 *
 * If we ever support a second tileset, this is the only place that changes.
 */
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";

export interface MapJsonPayload {
  id: string;
  name: string;
  description: string;
  width: number;
  height: number;
  terrainData: number[];
  /** Object layer GIDs. Omit or pass an all-zero array if the map has no objects. */
  objectData?: number[];
  /** Tileset references the data uses. Defaults to the scribble tileset at firstgid=1 when omitted. */
  tilesets?: Array<{ firstgid: number; source: string }>;
}

/** Filename invariant: every generated map and encounter id starts with `gen_`.
 *  Hand-authored maps MUST NOT use this prefix or they'd be wiped by the
 *  DELETE /generate/maps/all dev-mode cleanup. */
export const GEN_PREFIX = 'gen_';

export function isGeneratedId(id: string): boolean {
  return id.startsWith(GEN_PREFIX);
}

/** Build the Tiled-shape JSON for a composed/generated map. Pure — does not touch disk. */
export function buildMapJson(p: MapJsonPayload): Record<string, unknown> {
  const hasObjects = !!p.objectData && p.objectData.some((g) => g !== 0);
  const layers: unknown[] = [
    { type: 'tilelayer', name: 'terrain', width: p.width, height: p.height, data: p.terrainData },
  ];
  if (hasObjects && p.objectData) {
    layers.push({ type: 'tilelayer', name: 'objects', width: p.width, height: p.height, data: p.objectData });
  }
  return {
    id: p.id,
    name: p.name,
    mapdescription: p.description,
    width: p.width,
    height: p.height,
    tilesets: p.tilesets ?? [{ firstgid: 1, source: '../tilesets/scribble.tsj' }],
    layers,
  };
}

/** Persist a map JSON under `server/data/maps/<id>.json`. Creates the dir if needed. */
export async function writeMapJson(dataDir: string, p: MapJsonPayload): Promise<void> {
  const json = buildMapJson(p);
  await mkdir(join(dataDir, 'maps'), { recursive: true });
  await writeFile(join(dataDir, 'maps', `${p.id}.json`), JSON.stringify(json, null, 2));
}
