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

const ENCOUNTER_DIVIDER_X = 280;
const MAP_DIVIDER_X = 560;
const CONTENT_CY = 390;

interface EncounterTypeDef {
  id: string;
  title: string;
  lines: string[];
}

interface MapTypeDef {
  id: "open" | "rooms";
  title: string;
  lines: string[];
  accent: number;
}

const SIMPLE_COMBAT: EncounterTypeDef = {
  id: "simple_combat",
  title: "Simple Combat",
  lines: [
    "Defeat all enemies in",
    "turn-based combat.",
    "",
    "Full SRD 5.2.1 rules.",
  ],
};

const OPEN_MAP: MapTypeDef = {
  id: "open",
  title: "Open Map",
  accent: 0x6ea8e2,
  lines: ["Randomly scattered walls", "on an open battlefield."],
};

const ROOMS_MAP: MapTypeDef = {
  id: "rooms",
  title: "Rooms",
  accent: 0x9e6ee2,
  lines: ["Connected rectangular", "rooms with corridors."],
};

export class EncounterSetupScene extends Phaser.Scene {
  private selectedEncounterType: EncounterTypeDef | null = null;
  private selectedMapType: MapTypeDef | null = null;
  private selectedPlayer: PlayerDef | null = null;

  private encounterCardBgs: Map<string, Phaser.GameObjects.Rectangle> = new Map();
  private mapTypeCardBgs: Map<string, Phaser.GameObjects.Rectangle> = new Map();
  private charCardBgs: Map<string, Phaser.GameObjects.Rectangle> = new Map();
  private beginBg!: Phaser.GameObjects.Rectangle;
  private beginLabel!: Phaser.GameObjects.Text;

  constructor() {
    super({ key: "EncounterSetupScene" });
  }

  create(): void {
    this.selectedEncounterType = null;
    this.selectedMapType = null;
    this.selectedPlayer = null;
    this.encounterCardBgs.clear();
    this.mapTypeCardBgs.clear();
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

    this.add.rectangle(ENCOUNTER_DIVIDER_X, H / 2, 1, H - 140, 0x334455).setOrigin(0.5, 0.5);
    this.add.rectangle(MAP_DIVIDER_X, H / 2, 1, H - 140, 0x334455).setOrigin(0.5, 0.5);

    const encounterCx = ENCOUNTER_DIVIDER_X / 2;
    const mapCx = ENCOUNTER_DIVIDER_X + (MAP_DIVIDER_X - ENCOUNTER_DIVIDER_X) / 2;
    const charCx = MAP_DIVIDER_X + (W - MAP_DIVIDER_X) / 2;

    this.add
      .text(encounterCx, 78, "ENCOUNTER TYPE", {
        fontSize: "12px",
        color: "#667788",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5, 0);

    this.add
      .text(mapCx, 78, "MAP TYPE", {
        fontSize: "12px",
        color: "#667788",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5, 0);

    this.add
      .text(charCx, 78, "CHARACTER", {
        fontSize: "12px",
        color: "#667788",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5, 0);

    this.buildEncounterCard(SIMPLE_COMBAT, encounterCx, CONTENT_CY);

    const mapCardH = 200;
    const mapCardGap = 20;
    const mapTopCY = CONTENT_CY - (mapCardH + mapCardGap) / 2;
    const mapBotCY = CONTENT_CY + (mapCardH + mapCardGap) / 2;
    this.buildMapTypeCard(OPEN_MAP, mapCx, mapTopCY, mapCardH);
    this.buildMapTypeCard(ROOMS_MAP, mapCx, mapBotCY, mapCardH);

    const spread = 170;
    this.buildCharCard(ALDRIC, charCx - spread, CONTENT_CY);
    this.buildCharCard(MIRIEL, charCx + spread, CONTENT_CY);

    this.add.rectangle(W / 2, H - 58, W - 64, 1, 0x334455);
    this.buildBeginButton(W / 2, H - 36);
    this.refreshBeginButton();
  }

  private buildEncounterCard(def: EncounterTypeDef, cx: number, cy: number): void {
    const cardW = 240;
    const cardH = 380;

    const bg = this.add
      .rectangle(cx, cy, cardW, cardH, 0x111122)
      .setStrokeStyle(2, 0x334455)
      .setInteractive({ useHandCursor: true });

    this.encounterCardBgs.set(def.id, bg);

    bg.on("pointerover", () => {
      if (this.selectedEncounterType?.id !== def.id)
        bg.setStrokeStyle(2, 0x667788);
    });
    bg.on("pointerout", () => {
      if (this.selectedEncounterType?.id !== def.id)
        bg.setStrokeStyle(2, 0x334455);
    });
    bg.on("pointerdown", () => {
      for (const [id, b] of this.encounterCardBgs)
        b.setStrokeStyle(2, id === def.id ? 0xe2b96f : 0x334455);
      this.selectedEncounterType = def;
      this.refreshBeginButton();
    });

    const top = cy - cardH / 2;

    this.add.rectangle(cx, top + 48, 44, 44, 0xe2b96f).setAlpha(0.15);
    this.add
      .text(cx, top + 48, "⚔", {
        fontSize: "22px",
        color: "#e2b96f",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5);

    this.add
      .text(cx, top + 86, def.title, {
        fontSize: "14px",
        color: "#ffffff",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5, 0);

    this.add.rectangle(cx, top + 108, cardW - 24, 1, 0x334455);

    this.add
      .text(cx, top + 120, def.lines.join("\n"), {
        fontSize: "12px",
        color: "#99aabb",
        fontFamily: "monospace",
        resolution: DPR,
        align: "center",
        lineSpacing: 6,
      })
      .setOrigin(0.5, 0);

    this.add
      .text(cx, top + cardH - 20, "SELECT", {
        fontSize: "12px",
        color: "#e2b96f",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5, 0);
  }

  private buildMapTypeCard(def: MapTypeDef, cx: number, cy: number, cardH: number): void {
    const cardW = 240;
    const accentHex = "#" + def.accent.toString(16).padStart(6, "0");

    const bg = this.add
      .rectangle(cx, cy, cardW, cardH, 0x111122)
      .setStrokeStyle(2, 0x334455)
      .setInteractive({ useHandCursor: true });

    this.mapTypeCardBgs.set(def.id, bg);

    bg.on("pointerover", () => {
      if (this.selectedMapType?.id !== def.id)
        bg.setStrokeStyle(2, def.accent & 0x7f7f7f);
    });
    bg.on("pointerout", () => {
      if (this.selectedMapType?.id !== def.id)
        bg.setStrokeStyle(2, 0x334455);
    });
    bg.on("pointerdown", () => {
      for (const [id, b] of this.mapTypeCardBgs)
        b.setStrokeStyle(2, id === def.id ? def.accent : 0x334455);
      this.selectedMapType = def;
      this.refreshBeginButton();
    });

    const top = cy - cardH / 2;

    this.add.rectangle(cx, top + 30, 36, 36, def.accent).setAlpha(0.15);

    this.add
      .text(cx, top + 54, def.title, {
        fontSize: "13px",
        color: "#ffffff",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5, 0);

    this.add.rectangle(cx, top + 74, cardW - 24, 1, 0x334455);

    this.add
      .text(cx, top + 86, def.lines.join("\n"), {
        fontSize: "11px",
        color: "#99aabb",
        fontFamily: "monospace",
        resolution: DPR,
        align: "center",
        lineSpacing: 6,
      })
      .setOrigin(0.5, 0);

    this.add
      .text(cx, top + cardH - 18, "SELECT", {
        fontSize: "11px",
        color: accentHex,
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
      def.mainAttack.statKey === "str" ? statMod(def.str) : statMod(def.dex);
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
      this.scene.start("GameScene", {
        playerDef: this.selectedPlayer,
        mapType: this.selectedMapType!.id,
      });
    });
  }

  private isReady(): boolean {
    return (
      this.selectedEncounterType !== null &&
      this.selectedMapType !== null &&
      this.selectedPlayer !== null
    );
  }

  private refreshBeginButton(): void {
    const ready = this.isReady();
    this.beginBg.setAlpha(ready ? 1 : 0.4);
    this.beginLabel.setAlpha(ready ? 1 : 0.4);
  }
}
