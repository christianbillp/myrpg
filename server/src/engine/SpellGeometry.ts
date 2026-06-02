/**
 * Spell area-of-effect geometry — the per-shape tile-set builders that drive
 * "which cells does this spell cover" for every AOE shape in the SRD vocabulary
 * the engine handles (cone / cube / sphere / line, in both self-origin and
 * placed variants), plus the proximity disc used for "within X ft of target"
 * style riders.
 *
 * Extracted from `SpellSystem.ts` so the geometry math sits in its own,
 * navigable module. Every shape builder is pure (no engine state writes —
 * just returns a `Set<"x,y">`); only the top-level `tilesInArea` and its two
 * thin wrappers touch the live `GameContext` to resolve the caster's tile
 * and click anchor.
 */
import type { GameContext } from './GameContext.js';
import type { NpcState, SpellDef } from './types.js';

/**
 * SRD 5.2.1 cone (length = base diameter, ~53° total angle): at distance d along
 * the cone's axis, tiles within perpendicular distance ≤ d/2 + 0.5 are in.
 * Returns "x,y" strings for O(1) membership lookup.
 */
export function coneTileSet(
  ox: number, oy: number,
  targetX: number, targetY: number,
  lengthTiles: number,
): Set<string> {
  let dx = targetX - ox;
  let dy = targetY - oy;
  const len = Math.hypot(dx, dy);
  if (len === 0) { dx = 1; dy = 0; } else { dx /= len; dy /= len; }
  const out = new Set<string>();
  for (let ry = -lengthTiles; ry <= lengthTiles; ry++) {
    for (let rx = -lengthTiles; rx <= lengthTiles; rx++) {
      if (rx === 0 && ry === 0) continue;
      const along = rx * dx + ry * dy;
      if (along <= 0 || along > lengthTiles + 0.5) continue;
      const perp = Math.abs(-rx * dy + ry * dx);
      if (perp > along * 0.5 + 0.5) continue;
      out.add(`${ox + rx},${oy + ry}`);
    }
  }
  return out;
}

/** Tile-side count for an anchored cube (Grease-style). */
export function cubeSideTiles(spell: SpellDef): number {
  const sizeFeet = spell.area?.sizeFeet ?? 5;
  return Math.max(1, Math.ceil(sizeFeet / 5));
}

/** Tile-radius for a sphere area. */
export function sphereRadiusTiles(spell: SpellDef): number {
  const sizeFeet = spell.area?.sizeFeet ?? 5;
  return Math.max(1, Math.ceil(sizeFeet / 5));
}

/**
 * 3×3-style cube originating from the caster, extending in the cursor
 * direction (Thunderwave). Caster's tile is not in the cube.
 */
export function cubeFromCasterTiles(
  casterX: number, casterY: number,
  cursorX: number, cursorY: number,
  sideTiles: number,
): Set<string> {
  let dx = Math.sign(cursorX - casterX);
  let dy = Math.sign(cursorY - casterY);
  if (dx === 0 && dy === 0) dx = 1;
  const halfLow  = Math.floor((sideTiles - 1) / 2);
  const halfHigh = Math.ceil((sideTiles - 1) / 2);
  let xMin: number, xMax: number;
  if (dx === 0)      { xMin = casterX - halfLow; xMax = casterX + halfHigh; }
  else if (dx > 0)   { xMin = casterX + 1;       xMax = casterX + sideTiles; }
  else               { xMin = casterX - sideTiles; xMax = casterX - 1; }
  let yMin: number, yMax: number;
  if (dy === 0)      { yMin = casterY - halfLow; yMax = casterY + halfHigh; }
  else if (dy > 0)   { yMin = casterY + 1;       yMax = casterY + sideTiles; }
  else               { yMin = casterY - sideTiles; yMax = casterY - 1; }
  const out = new Set<string>();
  for (let y = yMin; y <= yMax; y++) {
    for (let x = xMin; x <= xMax; x++) out.add(`${x},${y}`);
  }
  return out;
}

/**
 * SRD `line` AOE — rectangular strip from caster toward cursor. Continuous
 * direction (any angle around the caster), `widthTiles` perpendicular width.
 * Caster's tile is NOT included.
 */
export function lineFromCasterTiles(
  casterX: number, casterY: number,
  cursorX: number, cursorY: number,
  lengthTiles: number,
  widthTiles: number,
): Set<string> {
  const dirX = cursorX - casterX;
  const dirY = cursorY - casterY;
  const len = Math.hypot(dirX, dirY);
  const out = new Set<string>();
  if (len === 0) return out;
  const ux = dirX / len;
  const uy = dirY / len;
  const perpX = -uy;
  const perpY = ux;
  const halfLow  = Math.floor((widthTiles - 1) / 2);
  const halfHigh = Math.ceil((widthTiles - 1) / 2);
  for (let step = 1; step <= lengthTiles; step++) {
    for (let off = -halfLow; off <= halfHigh; off++) {
      const fx = casterX + ux * step + perpX * off;
      const fy = casterY + uy * step + perpY * off;
      out.add(`${Math.round(fx)},${Math.round(fy)}`);
    }
  }
  return out;
}

/** Chebyshev disc of `radiusTiles` around a tile centre — proximity riders. */
export function chebyshevDiscTiles(centerX: number, centerY: number, radiusTiles: number): Set<string> {
  const out = new Set<string>();
  for (let dy = -radiusTiles; dy <= radiusTiles; dy++) {
    for (let dx = -radiusTiles; dx <= radiusTiles; dx++) {
      out.add(`${centerX + dx},${centerY + dy}`);
    }
  }
  return out;
}

/**
 * SRD 5.2.1 placed-sphere rule: origin is a grid-line intersection, radius
 * extends from there. On a tile grid the area is a `2 * radius` tile square
 * with the cursor at the upper-left of the four central tiles.
 */
export function placedSphereTiles(cursorX: number, cursorY: number, radiusTiles: number): Set<string> {
  const out = new Set<string>();
  const side = 2 * radiusTiles;
  const halfLow = radiusTiles;
  for (let dy = -halfLow; dy < side - halfLow; dy++) {
    for (let dx = -halfLow; dx < side - halfLow; dx++) {
      out.add(`${cursorX + dx},${cursorY + dy}`);
    }
  }
  return out;
}

/**
 * Full tile set a spell's area covers, dispatched by `spell.area.shape`.
 * Single source of truth for "what's in the AOE" — used by the saved-creature
 * sweep and the player-in-area check.
 *
 *   • cone:   53° expanding triangle from caster toward `click`
 *   • sphere + self-range: chebyshev disc centred on caster's tile
 *   • sphere + placed:     SRD grid-intersection rule, anchored at click
 *   • cube   + self-range: `cubeFromCasterTiles` (Thunderwave)
 *   • cube   + placed:     anchored cube — Grease-style
 *   • line:                rectangular strip toward cursor
 */
export function tilesInArea(
  ctx: GameContext,
  spell: SpellDef,
  click: { x: number; y: number } | undefined,
): Set<string> {
  const s = ctx.state;
  const out = new Set<string>();
  if (!spell.area) return out;

  if (spell.area.shape === 'cone') {
    const radiusTiles = Math.max(1, Math.ceil(spell.area.sizeFeet / 5));
    const tx = click?.x ?? s.player.tileX + 1;
    const ty = click?.y ?? s.player.tileY;
    return coneTileSet(s.player.tileX, s.player.tileY, tx, ty, radiusTiles);
  }

  if (spell.area.shape === 'line') {
    const lengthTiles = Math.max(1, Math.ceil(spell.area.sizeFeet / 5));
    const widthTiles  = Math.max(1, Math.ceil((spell.area.widthFeet ?? 5) / 5));
    const tx = click?.x ?? s.player.tileX + 1;
    const ty = click?.y ?? s.player.tileY;
    return lineFromCasterTiles(s.player.tileX, s.player.tileY, tx, ty, lengthTiles, widthTiles);
  }

  if (spell.area.shape === 'sphere') {
    if ((spell.area.sizeFeet ?? 0) === 0) {
      const x = click?.x ?? s.player.tileX;
      const y = click?.y ?? s.player.tileY;
      return new Set([`${x},${y}`]);
    }
    const r = sphereRadiusTiles(spell);
    if (spell.range === 'self') {
      return chebyshevDiscTiles(s.player.tileX, s.player.tileY, r);
    }
    return placedSphereTiles(click?.x ?? s.player.tileX, click?.y ?? s.player.tileY, r);
  }

  // Cube.
  const side = cubeSideTiles(spell);
  if (spell.range === 'self') {
    const tx = click?.x ?? s.player.tileX + 1;
    const ty = click?.y ?? s.player.tileY;
    return cubeFromCasterTiles(s.player.tileX, s.player.tileY, tx, ty, side);
  }
  const cx = click?.x ?? s.player.tileX;
  const cy = click?.y ?? s.player.tileY;
  let xMin: number, xMax: number, yMin: number, yMax: number;
  if (side % 2 === 1) {
    const r = (side - 1) / 2;
    xMin = cx - r; xMax = cx + r; yMin = cy - r; yMax = cy + r;
  } else {
    const offset = side - 1;
    xMin = cx; xMax = cx + offset; yMin = cy; yMax = cy + offset;
  }
  for (let y = yMin; y <= yMax; y++) {
    for (let x = xMin; x <= xMax; x++) out.add(`${x},${y}`);
  }
  return out;
}

/** True when the player's tile sits inside the spell's AOE. */
export function playerInArea(
  ctx: GameContext,
  spell: SpellDef,
  click: { x: number; y: number } | undefined,
): boolean {
  const s = ctx.state;
  const tiles = tilesInArea(ctx, spell, click);
  return tiles.has(`${s.player.tileX},${s.player.tileY}`);
}

/**
 * Living NPCs in a spell's area. Routes through `tilesInArea` so every
 * AOE-shape rule lives in one place. Includes allies — AOE spells like
 * Burning Hands are indiscriminate per SRD.
 */
export function creaturesInArea(
  ctx: GameContext,
  spell: SpellDef,
  tile: { x: number; y: number } | undefined,
): NpcState[] {
  const tiles = tilesInArea(ctx, spell, tile);
  return ctx.state.npcs.filter((n) => n.hp > 0 && tiles.has(`${n.tileX},${n.tileY}`));
}
