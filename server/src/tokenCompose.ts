/**
 * Token composer — stitches the SVG fragments in `data/tokens/parts/<slot>/`
 * into a single flat token SVG using a fixed z-order, with the spec's palette
 * colours stamped into the `{{BODY_COLOR}}` / `{{SKIN_COLOR}}` /
 * `{{HAIR_COLOR}}` placeholders.
 *
 * The order matters: each slot is drawn ON TOP of the previous one so face
 * details land over the body coin, beard sits between the face and hair, and
 * accessories stamp over everything. The same z-order is mirrored in the
 * client-side preview composer (see `client/src/ui/tokenComposer.ts`).
 *
 * Used by the `POST /token` endpoint when an author saves a token from the
 * Token Creator scene.
 */
import { readFile, readdir } from "fs/promises";
import { join, basename } from "path";
import type { TokenSpec } from "../../shared/types.js";
import { TOKEN_SLOTS, type TokenSlot, resolvePaletteStamps } from "../../shared/tokenPalette.js";

export { TOKEN_SLOTS, type TokenSlot };

const TEMPLATE = (inner: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <g stroke="#222222" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round">
${inner}
  </g>
</svg>
`;

export interface PartsLibrary {
  /** Map of slot → (part id → raw SVG fragment text with placeholders). */
  parts: Record<TokenSlot, Record<string, string>>;
}

/**
 * Load every part fragment under `partsDir` into memory. Called once at
 * server boot and re-used on each compose / list request. Returns both the
 * per-slot maps (for compose) and a flat catalog (for the `/tokens/parts`
 * list endpoint).
 */
export async function loadPartsLibrary(partsDir: string): Promise<PartsLibrary> {
  const parts = {} as PartsLibrary["parts"];
  for (const slot of TOKEN_SLOTS) {
    const dir = join(partsDir, slot);
    const slotMap: Record<string, string> = {};
    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (!file.endsWith(".svg")) continue;
        const id = basename(file, ".svg");
        const raw = await readFile(join(dir, file), "utf-8");
        // Strip the leading "<!-- … -->" doc comment so it doesn't bloat
        // the composed SVG. Fragments are otherwise verbatim.
        slotMap[id] = raw.replace(/<!--[\s\S]*?-->\s*/g, "").trim();
      }
    } catch { /* slot dir missing → empty map */ }
    parts[slot] = slotMap;
  }
  return { parts };
}

/**
 * Compose a token SVG from a spec + a pre-loaded parts library. The order of
 * `TOKEN_SLOTS` determines z-order — the body coin draws first, the accessory
 * stamps last over the top of everything else.
 */
export function composeToken(spec: TokenSpec, lib: PartsLibrary): string {
  const stamps = resolvePaletteStamps(spec);
  const fragments: string[] = [];
  for (const slot of TOKEN_SLOTS) {
    const id = spec.slots?.[slot];
    if (!id) continue;
    const frag = lib.parts[slot]?.[id];
    if (!frag) continue; // unknown part id — skip silently rather than fail
    let stamped = frag;
    for (const [k, v] of Object.entries(stamps)) {
      stamped = stamped.split(`{{${k}}}`).join(v);
    }
    if (stamped) fragments.push("    " + stamped);
  }
  return TEMPLATE(fragments.join("\n"));
}

/** Flat list of `(slot, id)` entries — used by the client to populate the
 *  slot picker rows without having to list each slot dir separately. */
export function listPartCatalog(lib: PartsLibrary): Record<TokenSlot, string[]> {
  const out = {} as Record<TokenSlot, string[]>;
  for (const slot of TOKEN_SLOTS) {
    out[slot] = Object.keys(lib.parts[slot] ?? {}).sort();
  }
  return out;
}
