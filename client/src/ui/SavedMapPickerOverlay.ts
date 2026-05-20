import Phaser from "phaser";
import { SavedMapDef } from "../data/maps";
import { BaseOverlay } from "./BaseOverlay";

const DPR = window.devicePixelRatio;
const CARD_ACCENT = 0x6ea8e2;

export class SavedMapPickerOverlay extends BaseOverlay {
  constructor(
    scene: Phaser.Scene,
    onConfirm: (map: SavedMapDef) => void,
    onCancel: () => void,
  ) {
    super(scene, 700, 500, 0x6ea8e2, onCancel);

    const panelW = this.panelW;
    const top = this.top;

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
    const col2X =   cardW / 2 + cardGapX / 2;
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

      bg.on("pointerover", () => bg.setStrokeStyle(2, CARD_ACCENT));
      bg.on("pointerout",  () => bg.setStrokeStyle(2, 0x334455));
      bg.on("pointerdown", () => {
        onConfirm(def);
        this.container.destroy();
      });

      const nameText = scene.add
        .text(cx, cardTop + 22, def.name, {
          fontSize: "13px", color: "#ffffff", fontFamily: "monospace", resolution: DPR,
        })
        .setOrigin(0.5, 0);

      const divider = scene.add.rectangle(cx, cardTop + 46, cardW - 24, 1, 0x334455);

      const desc = scene.add
        .text(cx, cardTop + 56, def.description, {
          fontSize: "11px", color: "#99aabb", fontFamily: "monospace", resolution: DPR,
          align: "center", lineSpacing: 6,
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

    this.container.add([title, sep, ...cardObjects]);
  }
}
