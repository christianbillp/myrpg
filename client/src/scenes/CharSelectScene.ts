import Phaser from "phaser";
import { ALDRIC, MIRIEL, PlayerDef } from "../data/player";
import {
  TILE_SIZE,
  GRID_COLS,
  GRID_ROWS,
  HUD_HEIGHT,
  PLAYER_PANEL_WIDTH,
  TARGET_PANEL_WIDTH,
} from "../constants";

const W = PLAYER_PANEL_WIDTH + GRID_COLS * TILE_SIZE + TARGET_PANEL_WIDTH;
const H = GRID_ROWS * TILE_SIZE + HUD_HEIGHT;
const DPR = window.devicePixelRatio;

export class CharSelectScene extends Phaser.Scene {
  constructor() {
    super({ key: "CharSelectScene" });
  }

  create(): void {
    this.add.rectangle(W / 2, H / 2, W, H, 0x0d0d1e);

    this.add
      .text(W / 2, 48, "CHOOSE YOUR CHARACTER", {
        fontSize: "22px",
        color: "#e2b96f",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5);

    this.add.rectangle(W / 2, 86, W - 64, 1, 0x334455);

    this.buildCard(ALDRIC, W / 2 - 178, 420, [
      "Greatsword  2d6+3 slashing",
      "Savage Attacker (roll dmg twice)",
      "Graze (STR mod on miss)",
      "Second Wind ×2",
    ]);

    this.buildCard(MIRIEL, W / 2 + 178, 420, [
      "Shortsword  1d6+3 piercing",
      "Sneak Attack +1d6 (from hide)",
      "Vex (Disadvantage on hit)",
      "Hide action (Stealth +7)",
    ]);
  }

  private buildCard(
    def: PlayerDef,
    cx: number,
    cy: number,
    features: string[],
  ): void {
    const cardW = 300;
    const cardH = 520;

    const bg = this.add
      .rectangle(cx, cy, cardW, cardH, 0x111122)
      .setStrokeStyle(2, 0x334455);

    bg.setInteractive({ useHandCursor: true });
    bg.on("pointerover", () => bg.setStrokeStyle(2, def.color));
    bg.on("pointerout", () => bg.setStrokeStyle(2, 0x334455));
    bg.on("pointerdown", () =>
      this.scene.start("GameScene", { playerDef: def }),
    );

    const top = cy - cardH / 2;

    // Colour swatch
    this.add.rectangle(cx, top + 56, 52, 52, def.color);

    // Name
    this.add
      .text(cx, top + 104, def.name, {
        fontSize: "16px",
        color: "#ffffff",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5, 0);

    // Class line
    const className = `${def.speciesName}  ${def.className} ${def.level}`;
    this.add
      .text(cx, top + 130, className, {
        fontSize: "12px",
        color: "#8899aa",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5, 0);

    this.add.rectangle(cx, top + 158, cardW - 32, 1, 0x334455);

    // Core stats
    const statMod =
      def.mainAttack.statKey === "str"
        ? Math.floor((def.str - 10) / 2)
        : Math.floor((def.dex - 10) / 2);
    const atkBonus = statMod + def.proficiencyBonus;
    const statsLines = [
      `HP ${def.maxHp}   AC ${def.ac}   Speed ${def.speedFt} ft`,
      `Attack +${atkBonus}   Initiative +${Math.floor((def.dex - 10) / 2)}`,
    ];
    statsLines.forEach((line, i) => {
      this.add
        .text(cx, top + 170 + i * 22, line, {
          fontSize: "12px",
          color: "#aabbcc",
          fontFamily: "monospace",
          resolution: DPR,
        })
        .setOrigin(0.5, 0);
    });

    this.add.rectangle(cx, top + 228, cardW - 32, 1, 0x334455);

    // Features
    features.forEach((line, i) => {
      this.add
        .text(cx, top + 244 + i * 26, line, {
          fontSize: "11px",
          color: "#99bbcc",
          fontFamily: "monospace",
          resolution: DPR,
        })
        .setOrigin(0.5, 0);
    });

    // Click prompt
    const colorHex = "#" + def.color.toString(16).padStart(6, "0");
    this.add
      .text(cx, top + cardH - 36, "CLICK TO PLAY", {
        fontSize: "13px",
        color: colorHex,
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5, 0);
  }
}
