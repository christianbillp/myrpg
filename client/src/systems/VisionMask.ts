/**
 * VisionMask — client-side fog-of-war overlay. Mirrors the server's
 * `Vision.canSee` walker so the player only fully sees what their character
 * can see. Tiles outside the player's line of sight are darkened; tiles in
 * Lightly Obscured space are tinted softer; tiles in Heavily Obscured /
 * Dark (without Darkvision) are nearly opaque.
 *
 * The mask mirrors the server's `Vision.effectiveLightAt` + obscurance so what
 * the player sees matches what the engine lets them target. It reads:
 *   - `map.cover` / `map.obscurance` — baked per-tile properties.
 *   - `map.light` — per-tile ambient light grid (US-126 multi-region maps);
 *     a dark cave zone stays dark even when the encounter baseline is bright.
 *   - `environment.lightLevel` — encounter ambient baseline (fallback).
 *   - `player.lightSource` — the radius of a lit torch / lantern / Light
 *     cantrip, which pushes the darkness back to bright/dim around the player.
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
const TILE_FT = 5;

type LightLevel = "bright" | "dim" | "dark";
const LIGHT_ORDER: Record<LightLevel, number> = { dark: 0, dim: 1, bright: 2 };

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
    if (!state.map.cover && !state.map.obscurance && !state.map.light
        && (state.environment?.lightLevel ?? "bright") === "bright") {
      // Nothing to fog — fully lit, no per-tile light grid, no obscurance, no cover.
      return;
    }
    const ambient = (state.environment?.lightLevel ?? "bright") as LightLevel;
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

  /**
   * Effective light at a tile — mirrors `Vision.effectiveLightAt`: the baked
   * per-tile `map.light` value wins over the encounter baseline, and the
   * player's carried light source (torch / lantern / Light cantrip) raises the
   * level to bright/dim within its radius. Keeps the fog in lockstep with what
   * the engine considers visible/targetable.
   */
  private effectiveLight(state: GameState, x: number, y: number, px: number, py: number, ambient: LightLevel): LightLevel {
    const baked = (state.map.light?.[y]?.[x] ?? null) as LightLevel | null;
    let light: LightLevel = baked ?? ambient;
    const src = state.player.lightSource;
    if (src && state.player.hp > 0) {
      const distFt = Math.max(Math.abs(px - x), Math.abs(py - y)) * TILE_FT;
      const fromSource: LightLevel | null =
        distFt <= src.brightFt ? "bright"
        : distFt <= src.brightFt + src.dimFt ? "dim"
        : null;
      if (fromSource && LIGHT_ORDER[fromSource] > LIGHT_ORDER[light]) light = fromSource;
    }
    return light;
  }

  /** Compute the alpha (0–1) to paint over tile (x,y). 0 = clear. */
  private tileVeil(state: GameState, x: number, y: number, px: number, py: number, ambient: LightLevel, dvTiles: number): number {
    if (x === px && y === py) return 0;
    // LOS via Bresenham — mirrors Vision.ts (including diagonal corner-cutting).
    // A blocked line means tiles beyond a sight-blocker are fully fogged.
    const losBlocked = this.bresenhamLosBlocked(state, px, py, x, y);
    if (losBlocked) return VEIL_DARK_ALPHA;

    // Tile-level obscurance (forest underbrush, smoke).
    const tileObs = state.map.obscurance?.[y]?.[x];
    // Ambient obscurance from the EFFECTIVE light at this tile (per-tile grid +
    // carried light source), darkvision-stepped — mirrors `ambientObscurance`.
    const dist = Math.max(Math.abs(x - px), Math.abs(y - py));
    const baseline = this.effectiveLight(state, x, y, px, py, ambient);
    let ambientLevel: "none" | "lightly" | "heavily" = "none";
    if (baseline === "dim") ambientLevel = dist <= dvTiles ? "none" : "lightly";
    else if (baseline === "dark") ambientLevel = dist <= dvTiles ? "lightly" : "heavily";

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
    const blocks = (x: number, y: number) =>
      !!state.map.blocksSight?.[y]?.[x] || state.map.cover?.[y]?.[x] === "total";
    while (true) {
      const ox = cx, oy = cy;
      const e2 = 2 * err;
      let movedX = false, movedY = false;
      if (e2 > -dy) { err -= dy; cx += sx; movedX = true; }
      if (e2 < dx) { err += dx; cy += sy; movedY = true; }
      // Diagonal corner-cutting: a step on both axes that squeezes between two
      // sight-blockers meeting at a corner is blocked — mirrors `Vision.walkLOS`.
      if (movedX && movedY && blocks(cx, oy) && blocks(ox, cy)) return true;
      if (cx === x1 && cy === y1) break;
      if (blocks(cx, cy)) return true;
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
