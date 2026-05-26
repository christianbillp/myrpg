/**
 * Tiled GID flip-bit decoder.
 *
 * Tiled encodes tile orientation in the top three bits of each 32-bit GID:
 *   • 0x80000000 — horizontal flip
 *   • 0x40000000 — vertical flip
 *   • 0x20000000 — anti-diagonal flip (transpose)
 *
 * The remaining 29 bits are the actual tile id. Engine code that does a
 * passability lookup against `tileLegend.tiles[gid]` MUST mask off the flip
 * bits first; client renderers MUST also translate the flip bits into the
 * appropriate Phaser transform (rotation + flipX/flipY).
 *
 * Reference: https://doc.mapeditor.org/en/stable/reference/global-tile-ids/#tile-flipping
 */

export const TILE_FLIP_H = 0x80000000;
export const TILE_FLIP_V = 0x40000000;
export const TILE_FLIP_D = 0x20000000;
export const TILE_FLIP_MASK = 0xe0000000;
export const TILE_GID_MASK  = 0x1fffffff;

/**
 * Sentinel GID for a "pure void" tile. No spritesheet frame is drawn — the
 * renderer paints a solid black rectangle instead, letting the canvas's own
 * black backdrop show through cleanly. Always impassable. Used for chasms
 * and abysses on tilesets that lack a flat void / black tile of their own.
 *
 * 65534 (0xFFFE) is deliberately outside any real tileset's frame range so
 * it can never collide with an actual tile id, but still fits inside the
 * 29-bit GID space (so flip bits remain available if ever needed).
 */
export const TILE_VOID_GID = 0xfffe;

export interface DecodedGid {
  /** The bare tile id with flip bits stripped. Safe to use as a tileLegend / spritesheet frame key. */
  gid: number;
  /** Phaser `setFlipX` value derived from the flip bits. */
  flipX: boolean;
  /** Phaser `setFlipY` value. */
  flipY: boolean;
  /** Phaser `setAngle` value in degrees (0 / 90 / 180 / 270). */
  angle: number;
}

/**
 * Decode a Tiled GID into a base tile id plus a Phaser-friendly transform.
 * The 8 (H, V, D) bit combinations map to the 8 unique tile orientations.
 */
export function decodeTileGid(rawGid: number): DecodedGid {
  const h = (rawGid & TILE_FLIP_H) !== 0;
  const v = (rawGid & TILE_FLIP_V) !== 0;
  const d = (rawGid & TILE_FLIP_D) !== 0;
  const gid = rawGid & TILE_GID_MASK;

  // Worked out by tracing where the (TL, TR, BL, BR) corners end up after
  // applying Tiled's "D then H then V" transform order, then matching that
  // to a Phaser angle + simple flip pair.
  if (!d) {
    if (!h && !v) return { gid, flipX: false, flipY: false, angle: 0 };
    if ( h && !v) return { gid, flipX: true,  flipY: false, angle: 0 };
    if (!h &&  v) return { gid, flipX: false, flipY: true,  angle: 0 };
    return         { gid, flipX: false, flipY: false, angle: 180 };  // H + V
  }
  if (!h && !v) return { gid, flipX: true,  flipY: false, angle: 90  };  // D only (transpose)
  if ( h && !v) return { gid, flipX: false, flipY: false, angle: 90  };  // D + H (90° CW)
  if (!h &&  v) return { gid, flipX: false, flipY: false, angle: 270 };  // D + V (270° CW / 90° CCW)
  return         { gid, flipX: false, flipY: true,  angle: 90  };        // D + H + V (anti-transpose)
}

/** Strip the flip bits from a Tiled GID — convenient when you only need the base id. */
export function stripTileFlipBits(rawGid: number): number {
  return rawGid & TILE_GID_MASK;
}
