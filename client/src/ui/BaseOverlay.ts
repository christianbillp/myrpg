import Phaser from "phaser";
import {
  GRID_ROWS,
  TILE_SIZE,
  HUD_HEIGHT,
  PLAYER_PANEL_WIDTH,
  GRID_COLS,
  TARGET_PANEL_WIDTH,
} from "../constants";

const DPR = window.devicePixelRatio;
const W = PLAYER_PANEL_WIDTH + GRID_COLS * TILE_SIZE + TARGET_PANEL_WIDTH;
const GRID_H = GRID_ROWS * TILE_SIZE;
const H = GRID_H + HUD_HEIGHT;

export abstract class BaseOverlay {
  protected readonly container: Phaser.GameObjects.Container;
  protected readonly panelW: number;
  protected readonly panelH: number;
  protected readonly top: number;

  private readonly _onClose: () => void;

  constructor(
    scene: Phaser.Scene,
    panelW: number,
    panelH: number,
    accentColor: number,
    onClose: () => void,
  ) {
    this.panelW = panelW;
    this.panelH = panelH;
    this.top = -panelH / 2;
    this._onClose = onClose;

    // Full-screen dim — click outside panel to close.
    const backdrop = scene.add
      .rectangle(0, 0, W, H, 0x000000, 0.75)
      .setInteractive();
    backdrop.on("pointerdown", () => this.close());

    // Panel — absorbs pointer events so backdrop doesn't fire inside it.
    const panel = scene.add
      .rectangle(0, 0, panelW, panelH, 0x0d0d1e)
      .setStrokeStyle(2, accentColor)
      .setInteractive();

    // Close icon — transparent hit-area rectangle + visible ✕ text.
    const iconX = panelW / 2 - 18;
    const iconY = this.top + 16;
    const iconBg = scene.add
      .rectangle(iconX, iconY, 26, 26, 0x000000, 0)
      .setInteractive({ useHandCursor: true });
    const iconText = scene.add
      .text(iconX, iconY, "✕", {
        fontSize: "14px",
        color: "#556677",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5);
    iconBg.on("pointerover", () => iconText.setColor("#aabbcc"));
    iconBg.on("pointerout",  () => iconText.setColor("#556677"));
    iconBg.on("pointerdown", () => this.close());

    this.container = scene.add
      .container(W / 2, GRID_H / 2, [backdrop, panel, iconBg, iconText])
      .setDepth(100);
  }

  protected close(): void {
    this._onClose();
    this.container.destroy();
  }

  destroy(): void {
    this.container.destroy();
  }
}
