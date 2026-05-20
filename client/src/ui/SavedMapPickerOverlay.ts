import Phaser from "phaser";
import { SavedMapDef } from "../data/maps";
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
const H = GRID_ROWS * TILE_SIZE + HUD_HEIGHT;

const CARD_ACCENT = 0x6ea8e2;

export class SavedMapPickerOverlay {
  private container: Phaser.GameObjects.Container;
  private selectedMap: SavedMapDef | null = null;
  private cardBgs: Map<string, Phaser.GameObjects.Rectangle> = new Map();
  private confirmBg!: Phaser.GameObjects.Rectangle;
  private confirmLabel!: Phaser.GameObjects.Text;

  constructor(
    scene: Phaser.Scene,
    onConfirm: (map: SavedMapDef) => void,
    onCancel: () => void,
  ) {
    const panelW = 700;
    const panelH = 500;
    const top = -panelH / 2;

    const backdrop = scene.add
      .rectangle(W / 2, H / 2, W, H, 0x000000, 0.75)
      .setInteractive();

    const panel = scene.add
      .rectangle(0, 0, panelW, panelH, 0x0d0d1e)
      .setStrokeStyle(2, 0x6ea8e2);

    const title = scene.add
      .text(0, top + 24, "SELECT SAVED MAP", {
        fontSize: "16px",
        color: "#6ea8e2",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5, 0);

    const sep = scene.add.rectangle(0, top + 52, panelW - 40, 1, 0x334455);

    const cardW = 300;
    const cardH = 165;
    const cardGapX = 20;
    const cardGapY = 20;
    const col1X = -(cardW / 2 + cardGapX / 2);
    const col2X = cardW / 2 + cardGapX / 2;
    const row1Y = top + 68 + cardH / 2;
    const row2Y = row1Y + cardH + cardGapY;

    const positions: [number, number][] = [
      [col1X, row1Y],
      [col2X, row1Y],
      [col1X, row2Y],
      [col2X, row2Y],
    ];

    const cardObjects: Phaser.GameObjects.GameObject[] = [];
    const savedMaps = scene.registry.get("maps") as SavedMapDef[];

    savedMaps.forEach((def, i) => {
      const [cx, cy] = positions[i];
      const cardTop = cy - cardH / 2;

      const bg = scene.add
        .rectangle(cx, cy, cardW, cardH, 0x111122)
        .setStrokeStyle(2, 0x334455)
        .setInteractive({ useHandCursor: true });

      this.cardBgs.set(def.id, bg);

      bg.on("pointerover", () => {
        if (this.selectedMap?.id !== def.id)
          bg.setStrokeStyle(2, CARD_ACCENT & 0x7f7f7f);
      });
      bg.on("pointerout", () => {
        if (this.selectedMap?.id !== def.id) bg.setStrokeStyle(2, 0x334455);
      });
      bg.on("pointerdown", () => {
        for (const [id, b] of this.cardBgs)
          b.setStrokeStyle(2, id === def.id ? CARD_ACCENT : 0x334455);
        this.selectedMap = def;
        this.refreshConfirmButton();
      });

      const nameText = scene.add
        .text(cx, cardTop + 22, def.name, {
          fontSize: "13px",
          color: "#ffffff",
          fontFamily: "monospace",
          resolution: DPR,
        })
        .setOrigin(0.5, 0);

      const divider = scene.add.rectangle(
        cx,
        cardTop + 46,
        cardW - 24,
        1,
        0x334455,
      );

      const desc = scene.add
        .text(cx, cardTop + 56, def.description, {
          fontSize: "11px",
          color: "#99aabb",
          fontFamily: "monospace",
          resolution: DPR,
          align: "center",
          lineSpacing: 6,
        })
        .setOrigin(0.5, 0);

      const selectLabel = scene.add
        .text(cx, cardTop + cardH - 18, "SELECT", {
          fontSize: "11px",
          color: "#" + CARD_ACCENT.toString(16).padStart(6, "0"),
          fontFamily: "monospace",
          resolution: DPR,
        })
        .setOrigin(0.5, 0);

      cardObjects.push(bg, nameText, divider, desc, selectLabel);
    });

    const btnY = top + panelH - 36;

    this.confirmBg = scene.add
      .rectangle(80, btnY, 180, 32, 0x1a3a1a)
      .setStrokeStyle(1, 0x556677)
      .setAlpha(0.4);
    this.confirmLabel = scene.add
      .text(80, btnY, "CONFIRM", {
        fontSize: "13px",
        color: "#ffffff",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5)
      .setAlpha(0.4);

    this.confirmBg.setInteractive({ useHandCursor: true });
    this.confirmBg.on("pointerover", () => {
      if (this.selectedMap) this.confirmBg.setAlpha(0.75);
    });
    this.confirmBg.on("pointerout", () => {
      if (this.selectedMap) this.confirmBg.setAlpha(1);
    });
    this.confirmBg.on("pointerdown", () => {
      if (!this.selectedMap) return;
      onConfirm(this.selectedMap);
      this.container.destroy();
    });

    const cancelBg = scene.add
      .rectangle(-80, btnY, 180, 32, 0x2a1a1a)
      .setStrokeStyle(1, 0x556677)
      .setInteractive({ useHandCursor: true });
    const cancelLabel = scene.add
      .text(-80, btnY, "CANCEL", {
        fontSize: "13px",
        color: "#aaaaaa",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5);

    cancelBg.on("pointerover", () => cancelBg.setFillStyle(0x3a2a2a));
    cancelBg.on("pointerout", () => cancelBg.setFillStyle(0x2a1a1a));
    cancelBg.on("pointerdown", () => {
      onCancel();
      this.container.destroy();
    });

    this.container = scene.add
      .container(W / 2, H / 2, [
        backdrop,
        panel,
        title,
        sep,
        ...cardObjects,
        this.confirmBg,
        this.confirmLabel,
        cancelBg,
        cancelLabel,
      ])
      .setDepth(50);
  }

  private refreshConfirmButton(): void {
    const ready = this.selectedMap !== null;
    this.confirmBg.setAlpha(ready ? 1 : 0.4);
    this.confirmLabel.setAlpha(ready ? 1 : 0.4);
  }

  destroy(): void {
    this.container.destroy();
  }
}
