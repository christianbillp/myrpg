import Phaser from "phaser";
import { PLAYER_PANEL_WIDTH, GRID_COLS, TILE_SIZE } from "../constants";

const DPR = window.devicePixelRatio;
const GRID_W = GRID_COLS * TILE_SIZE;

const CHIP_W = 140;
const CHIP_H = 22;
const CHIP_GAP = 8;
const BAR_H = 30;

export interface TurnChip {
  label: string;
  name: string;
  color: number;
  isActive: boolean;
  isDead: boolean;
}

export class TurnOrderBar {
  private scene: Phaser.Scene;
  private bgRect: Phaser.GameObjects.Rectangle;
  private sepLine: Phaser.GameObjects.Rectangle;
  private chipsContainer: Phaser.GameObjects.Container;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    const cx = PLAYER_PANEL_WIDTH + GRID_W / 2;

    this.bgRect = scene.add
      .rectangle(cx, BAR_H / 2, GRID_W, BAR_H, 0x07070f)
      .setAlpha(0.92)
      .setDepth(15);
    this.sepLine = scene.add
      .rectangle(cx, BAR_H, GRID_W, 1, 0x334455)
      .setDepth(15);
    this.chipsContainer = scene.add
      .container(PLAYER_PANEL_WIDTH, 0)
      .setDepth(16);

    this.setVisible(false);
  }

  refresh(chips: TurnChip[]): void {
    this.chipsContainer.removeAll(true);

    const totalW = chips.length * CHIP_W + (chips.length - 1) * CHIP_GAP;
    let x = (GRID_W - totalW) / 2 + CHIP_W / 2;
    const y = BAR_H / 2;

    for (const chip of chips) {
      const fillColor = chip.isActive ? 0x1a3a20 : 0x0f0f1e;
      const strokeColor = chip.isActive ? 0x55aa66 : 0x334455;

      const bg = this.scene.add
        .rectangle(x, y, CHIP_W, CHIP_H, fillColor)
        .setStrokeStyle(1, strokeColor)
        .setAlpha(chip.isDead ? 0.3 : 1);

      const dot = this.scene.add
        .rectangle(x - CHIP_W / 2 + 10, y, 8, 8, chip.color)
        .setAlpha(chip.isDead ? 0.3 : 1);

      const displayName = chip.label ? `${chip.label} · ${chip.name}` : chip.name;
      const text = this.scene.add
        .text(x - CHIP_W / 2 + 18, y, displayName, {
          fontSize: "10px",
          color: chip.isActive ? "#ffffff" : "#778899",
          fontFamily: "monospace",
          resolution: DPR,
        })
        .setOrigin(0, 0.5)
        .setAlpha(chip.isDead ? 0.4 : 1);

      this.chipsContainer.add([bg, dot, text]);
      x += CHIP_W + CHIP_GAP;
    }
  }

  setVisible(visible: boolean): void {
    this.bgRect.setVisible(visible);
    this.sepLine.setVisible(visible);
    this.chipsContainer.setVisible(visible);
  }
}
