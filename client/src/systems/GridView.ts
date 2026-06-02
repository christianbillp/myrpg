import Phaser from "phaser";
import { TILE_SIZE, GRID_COLS, GRID_ROWS, PLAYER_PANEL_WIDTH } from "../constants";
import { GameMap } from "../../../shared/types";

const GRID_W = GRID_COLS * TILE_SIZE;
const GRID_H = GRID_ROWS * TILE_SIZE;

export class GridView {
  readonly container: Phaser.GameObjects.Container;
  private zoom = 1;
  private isPanning = false;
  private panStartedInMap = false;
  private panLastX = 0;
  private panLastY = 0;
  private mapCols = 0;
  private mapRows = 0;

  constructor(scene: Phaser.Scene) {
    this.container = scene.add.container(PLAYER_PANEL_WIDTH, 0);
  }

  get gridZoom(): number { return this.zoom; }

  initView(map: GameMap, playerTileX: number, playerTileY: number): void {
    this.mapCols = map.cols;
    this.mapRows = map.rows;
    const mapW = map.cols * TILE_SIZE;
    const mapH = map.rows * TILE_SIZE;
    const fitZoom = Math.min(GRID_W / mapW, GRID_H / mapH);
    this.zoom = Phaser.Math.Clamp(fitZoom, 0.5, 3);
    this.container.setScale(this.zoom);
    if (fitZoom >= 0.5) {
      this.container.x = PLAYER_PANEL_WIDTH;
      this.container.y = GRID_H - mapH * this.zoom;
      this.clamp();
    } else {
      this.centerOn(playerTileX, playerTileY);
    }
  }

  centerOn(tileX: number, tileY: number): void {
    const px = tileX * TILE_SIZE + TILE_SIZE / 2;
    const py = tileY * TILE_SIZE + TILE_SIZE / 2;
    this.container.x = PLAYER_PANEL_WIDTH + GRID_W / 2 - px * this.zoom;
    this.container.y = GRID_H / 2 - py * this.zoom;
    this.clamp();
  }

  isPointerInBounds(pointer: Phaser.Input.Pointer): boolean {
    return pointer.x >= PLAYER_PANEL_WIDTH && pointer.x < PLAYER_PANEL_WIDTH + GRID_W
      && pointer.y >= 0 && pointer.y < GRID_H;
  }

  toTile(pointer: Phaser.Input.Pointer): { tileX: number; tileY: number } {
    const localX = (pointer.x - this.container.x) / this.zoom;
    const localY = (pointer.y - this.container.y) / this.zoom;
    return {
      tileX: Math.floor(localX / TILE_SIZE),
      tileY: Math.floor(localY / TILE_SIZE),
    };
  }

  handleWheel(pointer: Phaser.Input.Pointer, dy: number): void {
    const newZoom = Phaser.Math.Clamp(this.zoom * (dy < 0 ? 1.15 : 1 / 1.15), 0.5, 3);
    const pivotX = pointer.x - this.container.x;
    const pivotY = pointer.y - this.container.y;
    this.container.x = pointer.x - pivotX * (newZoom / this.zoom);
    this.container.y = pointer.y - pivotY * (newZoom / this.zoom);
    this.zoom = newZoom;
    this.container.setScale(newZoom);
    this.clamp();
  }

  pointerDown(pointer: Phaser.Input.Pointer): void {
    this.panStartedInMap = false;
    if (!pointer.leftButtonDown() || !this.isPointerInBounds(pointer)) return;
    this.panStartedInMap = true;
    this.isPanning = false;
    this.panLastX = pointer.x;
    this.panLastY = pointer.y;
  }

  pointerMove(pointer: Phaser.Input.Pointer): void {
    if (!this.panStartedInMap || !pointer.leftButtonDown()) return;
    const dx = pointer.x - this.panLastX;
    const dy = pointer.y - this.panLastY;
    if (!this.isPanning && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) this.isPanning = true;
    if (this.isPanning) {
      this.container.x += dx;
      this.container.y += dy;
      this.clamp();
    }
    this.panLastX = pointer.x;
    this.panLastY = pointer.y;
  }

  // Returns true if this was a tap (not a pan) within map bounds.
  pointerUp(pointer: Phaser.Input.Pointer): boolean {
    const wasTap = this.panStartedInMap && !this.isPanning && this.isPointerInBounds(pointer);
    this.isPanning = false;
    this.panStartedInMap = false;
    return wasTap;
  }

  private clamp(): void {
    if (!this.mapCols || !this.mapRows) return;
    const margin = TILE_SIZE;
    const contentW = this.mapCols * TILE_SIZE;
    const contentH = this.mapRows * TILE_SIZE;
    this.container.x = Phaser.Math.Clamp(
      this.container.x,
      PLAYER_PANEL_WIDTH + margin - contentW * this.zoom,
      PLAYER_PANEL_WIDTH + contentW - margin,
    );
    this.container.y = Phaser.Math.Clamp(
      this.container.y,
      margin - contentH * this.zoom,
      contentH - margin,
    );
  }
}
