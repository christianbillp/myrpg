/**
 * Token palette + slot z-order — shared between the server composer
 * (`server/src/tokenCompose.ts`) and the client preview composer
 * (`client/src/ui/tokenComposer.ts`).
 *
 * Both composers used to carry their own copies of `TOKEN_SLOTS`, the
 * `body|skin|hair → {{BODY_COLOR}}|{{SKIN_COLOR}}|{{HAIR_COLOR}}` mapping,
 * and the default palette. Drift between them meant the in-editor preview
 * could disagree with the saved SVG. Centralising here makes that
 * impossible — either composer pulls the same constants.
 */

import type { TokenSpec } from "./types.js";

/** Z-order — bottom (drawn first) to top. Fragments are stitched in this
 *  exact order, so face details land over the body coin, beard sits between
 *  the face and hair, and accessories stamp over everything. */
export const TOKEN_SLOTS = ["body", "ears", "face", "beard", "eyes", "mouth", "hair", "accessory"] as const;
export type TokenSlot = typeof TOKEN_SLOTS[number];

/** Maps the spec's palette keys to the placeholder names embedded in part
 *  fragments. A fragment uses `{{BODY_COLOR}}` etc.; the composer rewrites
 *  those with the matching `palette.body` hex string at compose time. */
export const PALETTE_PLACEHOLDERS: Record<"body" | "skin" | "hair", string> = {
  body: "BODY_COLOR",
  skin: "SKIN_COLOR",
  hair: "HAIR_COLOR",
};

/** Default palette colours used when the spec leaves an entry blank. Authors
 *  almost always set `body` from the NPC's color and `skin` to a real tone,
 *  but the editor lets you preview before any palette is picked. */
export const DEFAULT_PALETTE: Required<NonNullable<TokenSpec["palette"]>> = {
  body: "#d8c39a",
  skin: "#f1c9a5",
  hair: "#3a2a1a",
};

/** Resolve the spec's palette against the defaults and return the
 *  placeholder→hex map the composer needs to stamp into each fragment. */
export function resolvePaletteStamps(spec: TokenSpec): Record<string, string> {
  const stamps: Record<string, string> = {};
  for (const key of Object.keys(PALETTE_PLACEHOLDERS) as Array<keyof typeof PALETTE_PLACEHOLDERS>) {
    stamps[PALETTE_PLACEHOLDERS[key]] = spec.palette?.[key] ?? DEFAULT_PALETTE[key];
  }
  return stamps;
}
