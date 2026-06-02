import type { TokenSpec } from "../../../shared/types";
import { TOKEN_SLOTS, type TokenSlot, resolvePaletteStamps } from "../../../shared/tokenPalette";

/**
 * Client-side token composer — uses the shared slot order + palette mapping
 * from `shared/tokenPalette.ts` so the Token Creator's live preview can never
 * drift from the server's compose-on-save output.
 */

export { TOKEN_SLOTS, type TokenSlot };

/** Stitch the fragments for the given spec into a full SVG string. The
 *  `parts` argument is the `slots` field of the `/tokens/parts` payload —
 *  per-slot map of `partId → raw fragment with {{COLOR}} placeholders`. */
export function composeTokenSvg(
  spec: TokenSpec,
  parts: Record<string, Record<string, string>>,
): string {
  const stamps = resolvePaletteStamps(spec);
  const fragments: string[] = [];
  for (const slot of TOKEN_SLOTS) {
    const id = spec.slots?.[slot];
    if (!id) continue;
    const raw = parts[slot]?.[id];
    if (!raw) continue;
    let stamped = raw;
    for (const [k, v] of Object.entries(stamps)) {
      stamped = stamped.split(`{{${k}}}`).join(v);
    }
    if (stamped) fragments.push("    " + stamped);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <g stroke="#222222" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round">
${fragments.join("\n")}
  </g>
</svg>`;
}

/** Render a single slot's part as a standalone preview SVG — used for the
 *  slot-picker thumbnails so the author can see each option's silhouette
 *  before clicking. Renders against a neutral grey coin when the slot isn't
 *  `body`. */
export function composePartThumbnail(
  slot: TokenSlot,
  partId: string,
  parts: Record<string, Record<string, string>>,
  palette: { body?: string; skin?: string; hair?: string } = {},
): string {
  const tempSpec: TokenSpec = {
    id: '_thumb',
    slots: { body: slot === 'body' ? partId : 'plain' } as TokenSpec['slots'],
    palette: {
      body: palette.body ?? '#555566',
      skin: palette.skin ?? '#f1c9a5',
      hair: palette.hair ?? '#3a2a1a',
    },
  };
  if (slot !== 'body') {
    // For non-body slots, draw the coin plus the part on top of a neutral
    // face oval so the thumb has visible context (you'd never recognise an
    // "ears" pick rendered alone).
    if (slot === 'ears') {
      tempSpec.slots.ears = partId;
      tempSpec.slots.face = 'oval';
    } else if (slot === 'face') {
      tempSpec.slots.face = partId;
    } else if (slot === 'beard') {
      tempSpec.slots.face = 'oval';
      tempSpec.slots.beard = partId;
    } else if (slot === 'eyes') {
      tempSpec.slots.face = 'oval';
      tempSpec.slots.eyes = partId;
    } else if (slot === 'mouth') {
      tempSpec.slots.face = 'oval';
      tempSpec.slots.mouth = partId;
    } else if (slot === 'hair') {
      tempSpec.slots.face = 'oval';
      tempSpec.slots.hair = partId;
    } else if (slot === 'accessory') {
      tempSpec.slots.face = 'oval';
      tempSpec.slots.eyes = 'normal';
      tempSpec.slots.accessory = partId;
    }
  }
  return composeTokenSvg(tempSpec, parts);
}
