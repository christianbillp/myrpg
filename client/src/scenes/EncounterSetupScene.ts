import Phaser from "phaser";
import { PlayerDef } from "../data/player";
import { ItemDef } from "../data/items";
import { EncounterType } from "../data/encounterTypes";
import { SavedMapDef, toGameMap } from "../data/maps";
import { SavedMapPickerOverlay } from "../ui/SavedMapPickerOverlay";
import { SaveSystem, SaveData, resumeFromSave } from "../systems/SaveSystem";
import { ResumeState } from "../systems/EncounterManager";
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
  id: "open" | "rooms" | "saved";
  title: string;
  lines: string[];
  accent: number;
}

const SIMPLE_COMBAT: EncounterTypeDef = {
  id: "simple_combat",
  title: "Simple Combat",
  lines: ["Defeat all enemies in", "turn-based combat."],
};

const SOCIAL_INTERACTION: EncounterTypeDef = {
  id: "social_interaction",
  title: "Social Interaction",
  lines: ["Speak with a villager,", "solve their riddle."],
};

const EXPLORATION: EncounterTypeDef = {
  id: "exploration",
  title: "Exploration",
  lines: ["Find hidden secrets", "using the Search action."],
};

const AI_DIALOGUE: EncounterTypeDef = {
  id: "ai_dialogue",
  title: "AI Dialogue",
  lines: ["Converse with a sage", "powered by Claude AI."],
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

const SAVED_MAP: MapTypeDef = {
  id: "saved",
  title: "Saved Map",
  accent: 0xe28f6e,
  lines: ["Choose from a collection", "of hand-crafted maps."],
};

export class EncounterSetupScene extends Phaser.Scene {
  private selectedEncounterTypeIds: Set<string> = new Set();
  private selectedMapType: MapTypeDef | null = null;
  private selectedSavedMap: SavedMapDef | null = null;
  private selectedPlayer: PlayerDef | null = null;

  private encounterCardBgs: Map<string, Phaser.GameObjects.Rectangle> =
    new Map();
  private mapTypeCardBgs: Map<string, Phaser.GameObjects.Rectangle> = new Map();
  private charCardBgs: Map<string, Phaser.GameObjects.Rectangle> = new Map();
  private savedMapNameLabel!: Phaser.GameObjects.Text;
  private beginBg!: Phaser.GameObjects.Rectangle;
  private beginLabel!: Phaser.GameObjects.Text;
  private characters: PlayerDef[] = [];
  private resumeState: ResumeState | null = null;
  private savedCharDefId: string | null = null;
  private incomingSaveData: SaveData | null = null;
  private saveBannerText!: Phaser.GameObjects.Text;

  constructor() {
    super({ key: "EncounterSetupScene" });
  }

  init(data: { saveData?: SaveData }): void {
    this.incomingSaveData = data?.saveData ?? null;
  }

  create(): void {
    this.characters = this.registry.get("characters") as PlayerDef[];
    this.selectedEncounterTypeIds.clear();
    this.selectedMapType = null;
    this.selectedSavedMap = null;
    this.selectedPlayer = null;
    this.resumeState = null;
    this.savedCharDefId = null;
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

    this.add
      .rectangle(ENCOUNTER_DIVIDER_X, H / 2, 1, H - 140, 0x334455)
      .setOrigin(0.5, 0.5);
    this.add
      .rectangle(MAP_DIVIDER_X, H / 2, 1, H - 140, 0x334455)
      .setOrigin(0.5, 0.5);

    const encounterCx = ENCOUNTER_DIVIDER_X / 2;
    const mapCx =
      ENCOUNTER_DIVIDER_X + (MAP_DIVIDER_X - ENCOUNTER_DIVIDER_X) / 2;
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

    const encounterCardH = 130;
    const encounterCardGap = 10;
    const encStep = encounterCardH + encounterCardGap;
    const encContentCY = CONTENT_CY + 10;
    this.buildEncounterCard(SIMPLE_COMBAT,      encounterCx, encContentCY - 1.5 * encStep, encounterCardH);
    this.buildEncounterCard(SOCIAL_INTERACTION, encounterCx, encContentCY - 0.5 * encStep, encounterCardH);
    this.buildEncounterCard(EXPLORATION,        encounterCx, encContentCY + 0.5 * encStep, encounterCardH);
    this.buildEncounterCard(AI_DIALOGUE,        encounterCx, encContentCY + 1.5 * encStep, encounterCardH);

    const mapCardH = 155;
    const mapCardGap = 18;
    const mapStep = mapCardH + mapCardGap;
    this.buildMapTypeCard(OPEN_MAP, mapCx, CONTENT_CY - mapStep, mapCardH);
    this.buildMapTypeCard(ROOMS_MAP, mapCx, CONTENT_CY, mapCardH);
    this.buildSavedMapCard(mapCx, CONTENT_CY + mapStep, mapCardH);

    const spread = 170;
    const offsets = [-spread, spread];
    this.characters.forEach((char, i) => this.buildCharCard(char, charCx + (offsets[i] ?? i * 2 * spread), CONTENT_CY));

    this.saveBannerText = this.add
      .text(W / 2, H - 76, "", { fontSize: "11px", color: "#667788", fontFamily: "monospace", resolution: DPR })
      .setOrigin(0.5, 0)
      .setDepth(1);

    this.add.rectangle(W / 2, H - 58, W - 64, 1, 0x334455);
    this.buildBeginButton(W / 2, H - 36);
    this.refreshBeginButton();

    if (this.incomingSaveData) {
      this.applySave(this.incomingSaveData);
    } else if (SaveSystem.hasExistingSave()) {
      this.applySave(SaveSystem.load()!);
    } else {
      SaveSystem.loadFromServer().then((save) => {
        if (save) this.applySave(save);
      });
    }
  }

  private applySave(save: SaveData): void {
    const savedDef = this.characters.find((c) => c.id === save.playerDefId) ?? this.characters[0];
    if (!savedDef) return;
    const items = this.registry.get("items") as ItemDef[];
    this.resumeState = resumeFromSave(save, items);
    this.savedCharDefId = savedDef.id;
    this.selectChar(savedDef);
    this.saveBannerText.setText(
      `Saved: ${savedDef.name}  ·  HP ${save.hp}/${savedDef.maxHp}  ·  ${save.xp} XP  ·  ${save.gold} GP`,
    );
  }

  private buildEncounterCard(
    def: EncounterTypeDef,
    cx: number,
    cy: number,
    cardH: number,
  ): void {
    const cardW = 240;

    const bg = this.add
      .rectangle(cx, cy, cardW, cardH, 0x111122)
      .setStrokeStyle(2, 0x334455)
      .setInteractive({ useHandCursor: true });

    this.encounterCardBgs.set(def.id, bg);

    bg.on("pointerover", () => {
      if (!this.selectedEncounterTypeIds.has(def.id))
        bg.setStrokeStyle(2, 0x667788);
    });
    bg.on("pointerout", () => {
      if (!this.selectedEncounterTypeIds.has(def.id))
        bg.setStrokeStyle(2, 0x334455);
    });
    bg.on("pointerdown", () => {
      if (this.selectedEncounterTypeIds.has(def.id)) {
        this.selectedEncounterTypeIds.delete(def.id);
        bg.setStrokeStyle(2, 0x334455);
      } else {
        this.selectedEncounterTypeIds.add(def.id);
        bg.setStrokeStyle(2, 0xe2b96f);
      }
      this.refreshBeginButton();
    });

    const top = cy - cardH / 2;

    this.add.rectangle(cx, top + 22, 28, 28, 0xe2b96f).setAlpha(0.15);
    this.add
      .text(cx, top + 42, def.title, {
        fontSize: "13px",
        color: "#ffffff",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5, 0);

    this.add.rectangle(cx, top + 60, cardW - 24, 1, 0x334455);

    this.add
      .text(cx, top + 70, def.lines.join("\n"), {
        fontSize: "11px",
        color: "#99aabb",
        fontFamily: "monospace",
        resolution: DPR,
        align: "center",
        lineSpacing: 4,
      })
      .setOrigin(0.5, 0);

    this.add
      .text(cx, top + cardH - 14, "SELECT", {
        fontSize: "11px",
        color: "#e2b96f",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5, 0);
  }

  private buildMapCardBase(
    def: MapTypeDef,
    cx: number,
    cy: number,
    cardH: number,
    actionLabel: string,
  ): { bg: Phaser.GameObjects.Rectangle; descText: Phaser.GameObjects.Text } {
    const cardW = 240;
    const accentHex = "#" + def.accent.toString(16).padStart(6, "0");
    const top = cy - cardH / 2;

    const bg = this.add
      .rectangle(cx, cy, cardW, cardH, 0x111122)
      .setStrokeStyle(2, 0x334455)
      .setInteractive({ useHandCursor: true });
    this.mapTypeCardBgs.set(def.id, bg);

    this.add.rectangle(cx, top + 30, 36, 36, def.accent).setAlpha(0.15);
    this.add
      .text(cx, top + 54, def.title, { fontSize: "13px", color: "#ffffff", fontFamily: "monospace", resolution: DPR })
      .setOrigin(0.5, 0);
    this.add.rectangle(cx, top + 74, cardW - 24, 1, 0x334455);
    const descText = this.add
      .text(cx, top + 86, def.lines.join("\n"), { fontSize: "11px", color: "#99aabb", fontFamily: "monospace", resolution: DPR, align: "center", lineSpacing: 6 })
      .setOrigin(0.5, 0);
    this.add
      .text(cx, top + cardH - 18, actionLabel, { fontSize: "11px", color: accentHex, fontFamily: "monospace", resolution: DPR })
      .setOrigin(0.5, 0);

    return { bg, descText };
  }

  private buildMapTypeCard(def: MapTypeDef, cx: number, cy: number, cardH: number): void {
    const { bg } = this.buildMapCardBase(def, cx, cy, cardH, "SELECT");
    bg.on("pointerover", () => {
      if (this.selectedMapType?.id !== def.id) bg.setStrokeStyle(2, def.accent & 0x7f7f7f);
    });
    bg.on("pointerout", () => {
      if (this.selectedMapType?.id !== def.id) bg.setStrokeStyle(2, 0x334455);
    });
    bg.on("pointerdown", () => {
      for (const [id, b] of this.mapTypeCardBgs)
        b.setStrokeStyle(2, id === def.id ? def.accent : 0x334455);
      this.selectedMapType = def;
      this.refreshBeginButton();
    });
  }

  private buildSavedMapCard(cx: number, cy: number, cardH: number): void {
    const def = SAVED_MAP;
    const { bg, descText } = this.buildMapCardBase(def, cx, cy, cardH, "PICK MAP");
    this.savedMapNameLabel = descText;
    bg.on("pointerover", () => {
      if (this.selectedMapType?.id !== def.id) bg.setStrokeStyle(2, def.accent & 0x7f7f7f);
    });
    bg.on("pointerout", () => {
      if (this.selectedMapType?.id !== def.id) bg.setStrokeStyle(2, 0x334455);
    });
    bg.on("pointerdown", () => {
      new SavedMapPickerOverlay(
        this,
        (chosenMap) => {
          this.selectedSavedMap = chosenMap;
          this.selectedMapType = def;
          for (const [id, b] of this.mapTypeCardBgs)
            b.setStrokeStyle(2, id === def.id ? def.accent : 0x334455);
          this.savedMapNameLabel.setText(chosenMap.name).setColor("#e2b96f");
          this.refreshBeginButton();
        },
        () => {
          if (this.selectedMapType?.id !== def.id) bg.setStrokeStyle(2, 0x334455);
        },
      );
    });
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
    bg.on("pointerdown", () => this.selectChar(def));

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
      .text(
        cx,
        top + 114,
        `${def.speciesName}  ${def.className} ${def.level}`,
        {
          fontSize: "11px",
          color: "#8899aa",
          fontFamily: "monospace",
          resolution: DPR,
        },
      )
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

  private selectChar(def: PlayerDef): void {
    for (const [id, b] of this.charCardBgs)
      b.setStrokeStyle(2, id === def.name ? def.color : 0x334455);
    this.selectedPlayer = def;
    this.refreshBeginButton();
  }

  private charFeatures(def: PlayerDef): string[] {
    if (def.id === "aldric") {
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
      const selectedId = this.selectedPlayer?.id ?? 'aldric';
      const resume = this.resumeState && this.savedCharDefId === selectedId
        ? this.resumeState
        : undefined;
      this.scene.start("GameScene", {
        playerDef: this.selectedPlayer,
        mapType: this.selectedMapType!.id,
        encounterTypes: Array.from(this.selectedEncounterTypeIds) as EncounterType[],
        savedMap:
          this.selectedMapType!.id === "saved" && this.selectedSavedMap
            ? toGameMap(this.selectedSavedMap)
            : undefined,
        resumeState: resume,
      });
    });
  }

  private isReady(): boolean {
    if (this.selectedEncounterTypeIds.size === 0) return false;
    if (this.selectedMapType === null) return false;
    if (this.selectedMapType.id === "saved" && this.selectedSavedMap === null)
      return false;
    return this.selectedPlayer !== null;
  }

  private refreshBeginButton(): void {
    const ready = this.isReady();
    this.beginBg.setAlpha(ready ? 1 : 0.4);
    this.beginLabel.setAlpha(ready ? 1 : 0.4);
  }
}
