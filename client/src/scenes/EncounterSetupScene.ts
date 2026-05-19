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

const DIVIDER_X = 440;
const CONTENT_CY = 390;

interface EncounterTypeDef {
  id: string;
  title: string;
  lines: string[];
}

const SIMPLE_COMBAT: EncounterTypeDef = {
  id: "simple_combat",
  title: "Simple Combat",
  lines: [
    "A randomly generated map",
    "with impassable walls.",
    "",
    "Face a Goblin Minion and",
    "a Bandit in turn-based",
    "combat.",
    "",
    "Full SRD 5.2.1 rules.",
  ],
};

export class EncounterSetupScene extends Phaser.Scene {
  private selectedEncounterType: EncounterTypeDef | null = null;
  private selectedPlayer: PlayerDef | null = null;

  private encounterCardBg!: Phaser.GameObjects.Rectangle;
  private charCardBgs: Map<string, Phaser.GameObjects.Rectangle> = new Map();
  private beginBg!: Phaser.GameObjects.Rectangle;
  private beginLabel!: Phaser.GameObjects.Text;

  constructor() {
    super({ key: "EncounterSetupScene" });
  }

  create(): void {
    this.selectedEncounterType = null;
    this.selectedPlayer = null;
    this.charCardBgs.clear();

    this.add.rectangle(W / 2, H / 2, W, H, 0x0d0d1e);

    this.add
      .text(W / 2, 28, "ENCOUNTER SETUP", {
        fontSize: "22px",
        color: "#e2b96f",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5, 0);

    this.add.rectangle(W / 2, 66, W - 64, 1, 0x334455);

    this.add
      .rectangle(DIVIDER_X, H / 2, 1, H - 140, 0x334455)
      .setOrigin(0.5, 0.5);

    this.add
      .text(DIVIDER_X / 2, 78, "ENCOUNTER TYPE", {
        fontSize: "12px",
        color: "#667788",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5, 0);

    const rightCx = DIVIDER_X + (W - DIVIDER_X) / 2;
    this.add
      .text(rightCx, 78, "CHARACTER", {
        fontSize: "12px",
        color: "#667788",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5, 0);

    this.buildEncounterCard(SIMPLE_COMBAT, DIVIDER_X / 2, CONTENT_CY);

    const spread = 190;
    this.buildCharCard(ALDRIC, rightCx - spread, CONTENT_CY);
    this.buildCharCard(MIRIEL, rightCx + spread, CONTENT_CY);

    this.add.rectangle(W / 2, H - 58, W - 64, 1, 0x334455);
    this.buildBeginButton(W / 2, H - 36);
    this.refreshBeginButton();
  }

  private buildEncounterCard(def: EncounterTypeDef, cx: number, cy: number): void {
    const cardW = 340;
    const cardH = 480;

    this.encounterCardBg = this.add
      .rectangle(cx, cy, cardW, cardH, 0x111122)
      .setStrokeStyle(2, 0x334455)
      .setInteractive({ useHandCursor: true });

    this.encounterCardBg.on("pointerover", () => {
      if (this.selectedEncounterType?.id !== def.id)
        this.encounterCardBg.setStrokeStyle(2, 0x667788);
    });
    this.encounterCardBg.on("pointerout", () => {
      if (this.selectedEncounterType?.id !== def.id)
        this.encounterCardBg.setStrokeStyle(2, 0x334455);
    });
    this.encounterCardBg.on("pointerdown", () => {
      this.selectedEncounterType = def;
      this.encounterCardBg.setStrokeStyle(2, 0xe2b96f);
      this.refreshBeginButton();
    });

    const top = cy - cardH / 2;

    this.add
      .rectangle(cx, top + 56, 52, 52, 0xe2b96f)
      .setAlpha(0.15);
    this.add
      .text(cx, top + 56, "⚔", {
        fontSize: "28px",
        color: "#e2b96f",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5);

    this.add
      .text(cx, top + 102, def.title, {
        fontSize: "16px",
        color: "#ffffff",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5, 0);

    this.add.rectangle(cx, top + 130, cardW - 32, 1, 0x334455);

    this.add
      .text(cx, top + 144, def.lines.join("\n"), {
        fontSize: "12px",
        color: "#99aabb",
        fontFamily: "monospace",
        resolution: DPR,
        align: "center",
        lineSpacing: 6,
      })
      .setOrigin(0.5, 0);

    this.add
      .text(cx, top + cardH - 32, "SELECT", {
        fontSize: "13px",
        color: "#e2b96f",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5, 0);
  }

  private buildCharCard(def: PlayerDef, cx: number, cy: number): void {
    const cardW = 270;
    const cardH = 480;
    const colorHex = "#" + def.color.toString(16).padStart(6, "0");
    const statMod = (v: number) => Math.floor((v - 10) / 2);

    const bg = this.add
      .rectangle(cx, cy, cardW, cardH, 0x111122)
      .setStrokeStyle(2, 0x334455)
      .setInteractive({ useHandCursor: true });

    this.charCardBgs.set(def.name, bg);

    bg.on("pointerover", () => {
      if (this.selectedPlayer?.name !== def.name)
        bg.setStrokeStyle(2, def.color & 0x7f7f7f);
    });
    bg.on("pointerout", () => {
      if (this.selectedPlayer?.name !== def.name)
        bg.setStrokeStyle(2, 0x334455);
    });
    bg.on("pointerdown", () => {
      for (const [id, b] of this.charCardBgs)
        b.setStrokeStyle(2, id === def.name ? def.color : 0x334455);
      this.selectedPlayer = def;
      this.refreshBeginButton();
    });

    const top = cy - cardH / 2;

    this.add.rectangle(cx, top + 50, 48, 48, def.color);

    this.add
      .text(cx, top + 90, def.name, {
        fontSize: "15px",
        color: "#ffffff",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5, 0);

    this.add
      .text(cx, top + 114, `${def.speciesName}  ${def.className} ${def.level}`, {
        fontSize: "11px",
        color: "#8899aa",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5, 0);

    this.add.rectangle(cx, top + 140, cardW - 32, 1, 0x334455);

    const atkMod =
      def.mainAttack.statKey === "str"
        ? statMod(def.str)
        : statMod(def.dex);
    const atkBonus = atkMod + def.proficiencyBonus;
    this.add
      .text(
        cx,
        top + 152,
        [
          `HP ${def.maxHp}   AC ${def.ac}   Speed ${def.speedFt} ft`,
          `Attack +${atkBonus}   Initiative ${statMod(def.dex) >= 0 ? "+" : ""}${statMod(def.dex)}`,
        ].join("\n"),
        {
          fontSize: "11px",
          color: "#aabbcc",
          fontFamily: "monospace",
          resolution: DPR,
          align: "center",
          lineSpacing: 6,
        },
      )
      .setOrigin(0.5, 0);

    this.add.rectangle(cx, top + 202, cardW - 32, 1, 0x334455);

    const features = this.charFeatures(def);
    this.add
      .text(cx, top + 214, features.join("\n"), {
        fontSize: "11px",
        color: "#99bbcc",
        fontFamily: "monospace",
        resolution: DPR,
        align: "center",
        lineSpacing: 8,
      })
      .setOrigin(0.5, 0);

    this.add
      .text(cx, top + cardH - 32, "SELECT", {
        fontSize: "13px",
        color: colorHex,
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5, 0);
  }

  private charFeatures(def: PlayerDef): string[] {
    if (def.name === ALDRIC.name) {
      return [
        "Greatsword  2d6+3 slashing",
        "Savage Attacker (roll dmg twice)",
        "Graze (STR mod on miss)",
        "Second Wind ×2",
      ];
    }
    return [
      "Shortsword  1d6+3 piercing",
      "Sneak Attack +1d6 (from hide)",
      "Vex (Disadvantage on hit)",
      "Hide action (Stealth +7)",
    ];
  }

  private buildBeginButton(cx: number, cy: number): void {
    this.beginBg = this.add
      .rectangle(cx, cy, 260, 36, 0x1a3a20)
      .setStrokeStyle(1, 0x556677)
      .setAlpha(0.4);
    this.beginLabel = this.add
      .text(cx, cy, "BEGIN ENCOUNTER", {
        fontSize: "14px",
        color: "#ffffff",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5)
      .setAlpha(0.4);

    this.beginBg.setInteractive({ useHandCursor: true });
    this.beginBg.on("pointerover", () => {
      if (this.isReady()) this.beginBg.setAlpha(0.75);
    });
    this.beginBg.on("pointerout", () => {
      if (this.isReady()) this.beginBg.setAlpha(1);
    });
    this.beginBg.on("pointerdown", () => {
      if (!this.isReady()) return;
      this.scene.start("GameScene", { playerDef: this.selectedPlayer });
    });
  }

  private isReady(): boolean {
    return this.selectedEncounterType !== null && this.selectedPlayer !== null;
  }

  private refreshBeginButton(): void {
    const ready = this.isReady();
    this.beginBg.setAlpha(ready ? 1 : 0.4);
    this.beginLabel.setAlpha(ready ? 1 : 0.4);
  }
}
