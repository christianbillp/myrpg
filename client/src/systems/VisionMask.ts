/**
 * VisionMask — client-side fog-of-war overlay. Mirrors the server's
 * `Vision.canSee` walker so the player only fully sees what their character
 * can see. Tiles outside the player's line of sight are darkened; tiles in
 * Lightly Obscured space are tinted softer; tiles in Heavily Obscured /
 * Dark (without Darkvision) are nearly opaque.
 *
 * The mask reads three GameState fields:
 *   - `map.cover` / `map.obscurance` — baked per-tile properties.
 *   - `environment.lightLevel` — encounter ambient baseline.
 *   - `playerDef.senses` — Darkvision range for ambient stepping.
 *
 * Sound rings are also drawn here (separate graphics layer) so audible
 * events outside the visible area still register to the player.
 */
import Phaser from "phaser";
import { TILE_SIZE } from "../constants";
import type { GameState } from "../../../shared/types";
import type { PlayerDef } from "../../../shared/types";

const VEIL_DARK_ALPHA = 0.78;
const VEIL_HEAVY_ALPHA = 0.55;
const VEIL_LIGHT_ALPHA = 0.18;
const SOUND_RING_DURATION_MS = 700;

export class VisionMask {
  readonly fogLayer: Phaser.GameObjects.Graphics;
  readonly soundLayer: Phaser.GameObjects.Graphics;
  private soundRings: { x: number; y: number; intensity: number; bornAt: number }[] = [];

  constructor(scene: Phaser.Scene) {
    this.fogLayer = scene.add.graphics();
    this.soundLayer = scene.add.graphics();
  }

  /** Repaint the fog-of-war overlay for the current state. Run every frame. */
  refresh(state: GameState, playerDef: PlayerDef): void {
    this.fogLayer.clear();
    if (!state.map.cover && !state.map.obscurance && (state.environment?.lightLevel ?? "bright") === "bright") {
      // Nothing to fog — fully lit, no obscurance, no cover.
      return;
    }
    const ambient = state.environment?.lightLevel ?? "bright";
    const dvFeet = playerDef.senses?.darkvision ?? 0;
    const dvTiles = Math.floor(dvFeet / 5);
    const px = state.player.tileX;
    const py = state.player.tileY;

    for (let y = 0; y < state.map.rows; y++) {
      for (let x = 0; x < state.map.cols; x++) {
        const veil = this.tileVeil(state, x, y, px, py, ambient, dvTiles);
        if (veil <= 0) continue;
        this.fogLayer.fillStyle(0x000010, veil);
        this.fogLayer.fillRect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
      }
    }
  }

  /** Compute the alpha (0–1) to paint over tile (x,y). 0 = clear. */
  private tileVeil(state: GameState, x: number, y: number, px: number, py: number, ambient: string, dvTiles: number): number {
    if (x === px && y === py) return 0;
    // LOS via Bresenham — mirrors Vision.ts. If a tile along the way has
    // total cover (cover === 'total'), tiles beyond it are fully fogged.
    const losBlocked = this.bresenhamLosBlocked(state, px, py, x, y);
    if (losBlocked) return VEIL_DARK_ALPHA;

    // Tile-level obscurance (forest underbrush, smoke).
    const tileObs = state.map.obscurance?.[y]?.[x];
    // Ambient obscurance — darkvision steps `dark`→`dim` within range.
    const dist = Math.max(Math.abs(x - px), Math.abs(y - py));
    let ambientLevel: "none" | "lightly" | "heavily" = "none";
    if (ambient === "dim") ambientLevel = "lightly";
    else if (ambient === "dark") ambientLevel = dist <= dvTiles ? "lightly" : "heavily";

    const effective = worseObs(tileObs ?? "none", ambientLevel);
    if (effective === "heavily") return VEIL_HEAVY_ALPHA;
    if (effective === "lightly") return VEIL_LIGHT_ALPHA;
    return 0;
  }

  private bresenhamLosBlocked(state: GameState, x0: number, y0: number, x1: number, y1: number): boolean {
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let cx = x0, cy = y0;
    while (true) {
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; cx += sx; }
      if (e2 < dx) { err += dx; cy += sy; }
      if (cx === x1 && cy === y1) break;
      if (state.map.blocksSight?.[cy]?.[cx]) return true;
      if (state.map.cover?.[cy]?.[cx] === "total") return true;
    }
    return false;
  }

  /** Spawn a sound ring at a tile centre — fades over `SOUND_RING_DURATION_MS`. */
  pushSoundRing(x: number, y: number, intensity: number): void {
    this.soundRings.push({ x, y, intensity, bornAt: performance.now() });
  }

  /** Run every frame from GameScene update so sound rings animate. */
  refreshSoundRings(): void {
    this.soundLayer.clear();
    if (this.soundRings.length === 0) return;
    const now = performance.now();
    for (const r of this.soundRings) {
      const age = now - r.bornAt;
      if (age >= SOUND_RING_DURATION_MS) continue;
      const t = age / SOUND_RING_DURATION_MS;          // 0 → 1
      const radius = r.intensity * TILE_SIZE * (0.3 + t * 0.9);
      const alpha = (1 - t) * 0.7;
      const cx = r.x * TILE_SIZE + TILE_SIZE / 2;
      const cy = r.y * TILE_SIZE + TILE_SIZE / 2;
      this.soundLayer.lineStyle(2, 0xffe6a8, alpha);
      this.soundLayer.strokeCircle(cx, cy, radius);
    }
    // Drop expired entries so the array doesn't grow without bound.
    this.soundRings = this.soundRings.filter((r) => now - r.bornAt < SOUND_RING_DURATION_MS);
  }

  destroy(): void {
    this.fogLayer.destroy();
    this.soundLayer.destroy();
  }
}

const OBS_RANK: Record<"none" | "lightly" | "heavily", number> = { none: 0, lightly: 1, heavily: 2 };
function worseObs(a: "none" | "lightly" | "heavily", b: "none" | "lightly" | "heavily"): "none" | "lightly" | "heavily" {
  return OBS_RANK[a] >= OBS_RANK[b] ? a : b;
}
