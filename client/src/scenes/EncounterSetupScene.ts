import Phaser from "phaser";
import { PlayerDef } from "../data/player";
import { ItemDef } from "../data/items";
import { EncounterType, PremadeEncounterDef } from "../data/encounterContext";
import { SavedMapDef } from "../data/maps";
import { SaveSystem, SaveData, resumeFromSave, EncounterStartConfig } from "../systems/SaveSystem";
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

const CHAR_DIVIDER_X = 640;
const CHAR1_CX = 155;
const CHAR2_CX = 460;
const CONTENT_CY = Math.round(80 + (H - 80 - 100) / 2);

const ENC_CARD_W = 480;
const ENC_CARD_H = 180;
const ENC_COL1_CX = 920;
const ENC_COL2_CX = 1420;

const TYPE_COLOR: Record<EncounterType, number> = {
  simple_combat:      0xcc4444,
  exploration:        0x44aa66,
  social_interaction: 0x4488cc,
  ai_dialogue:        0x7755cc,
};
const TYPE_LABEL: Record<EncounterType, string> = {
  simple_combat:      "Combat",
  exploration:        "Exploration",
  social_interaction: "Social",
  ai_dialogue:        "AI Dialogue",
};

export class EncounterSetupScene extends Phaser.Scene {
  private selectedPlayer: PlayerDef | null = null;
  private selectedEncounter: PremadeEncounterDef | null = null;

  private charCardBgs: Map<string, Phaser.GameObjects.Rectangle> = new Map();
  private encounterCardBgs: Map<string, Phaser.GameObjects.Rectangle> = new Map();
  private beginBg!: Phaser.GameObjects.Rectangle;
  private beginLabel!: Phaser.GameObjects.Text;
  private saveBannerText!: Phaser.GameObjects.Text;

  private characters: PlayerDef[] = [];
  private premadeEncounters: PremadeEncounterDef[] = [];
  private resumeState: ResumeState | null = null;
  private savedCharDefId: string | null = null;
  private incomingSaveData: SaveData | null = null;

  constructor() {
    super({ key: "EncounterSetupScene" });
  }

  init(data: { saveData?: SaveData }): void {
    this.incomingSaveData = data?.saveData ?? null;
  }

  create(): void {
    this.characters = this.registry.get("characters") as PlayerDef[];
    this.premadeEncounters = this.registry.get("premade-encounters") as PremadeEncounterDef[];
    this.selectedPlayer = null;
    this.selectedEncounter = null;
    this.resumeState = null;
    this.savedCharDefId = null;
    this.charCardBgs.clear();
    this.encounterCardBgs.clear();

    this.add.rectangle(W / 2, H / 2, W, H, 0x0d0d1e);

    this.add
      .text(W / 2, 28, "ENCOUNTER SETUP", {
        fontSize: "22px", color: "#e2b96f", fontFamily: "monospace", resolution: DPR,
      })
      .setOrigin(0.5, 0);

    this.add.rectangle(W / 2, 66, W - 64, 1, 0x334455);
    this.add.rectangle(CHAR_DIVIDER_X, H / 2, 1, H - 140, 0x334455).setOrigin(0.5, 0.5);

    this.add
      .text(CHAR_DIVIDER_X / 2, 78, "CHARACTER", {
        fontSize: "11px", color: "#556677", fontFamily: "monospace", resolution: DPR, letterSpacing: 2,
      })
      .setOrigin(0.5, 0);

    this.add
      .text(CHAR_DIVIDER_X + (W - CHAR_DIVIDER_X) / 2, 78, "PREMADE ENCOUNTER", {
        fontSize: "11px", color: "#556677", fontFamily: "monospace", resolution: DPR, letterSpacing: 2,
      })
      .setOrigin(0.5, 0);

    this.characters.forEach((char, i) => {
      const cx = i === 0 ? CHAR1_CX : CHAR2_CX;
      this.buildCharCard(char, cx, CONTENT_CY);
    });

    const encPositions: [number, number][] = [
      [ENC_COL1_CX, 261], [ENC_COL2_CX, 261],
      [ENC_COL1_CX, 465], [ENC_COL2_CX, 465],
      [ENC_COL1_CX, 669], [ENC_COL2_CX, 669],
    ];
    this.premadeEncounters.forEach((enc, i) => {
      const [cx, cy] = encPositions[i] ?? [ENC_COL1_CX, 216 + i * 161];
      this.buildPremadeCard(enc, cx, cy);
    });

    this.saveBannerText = this.add
      .text(W / 2, H - 76, "", { fontSize: "11px", color: "#667788", fontFamily: "monospace", resolution: DPR })
      .setOrigin(0.5, 0)
      .setDepth(1);

    this.add.rectangle(W / 2, H - 58, W - 64, 1, 0x334455);
    this.buildBeginButton(W / 2, H - 36);
    this.refreshBeginButton();

    if (this.incomingSaveData) {
      this.applySave(this.incomingSaveData);
    } else {
      const lastId = SaveSystem.getLastCharacterId();
      if (lastId) {
        if (SaveSystem.hasExistingSave(lastId)) {
          this.applySave(SaveSystem.load(lastId)!);
        } else {
          SaveSystem.loadFromServer(lastId).then((save) => {
            if (save) this.applySave(save);
          });
        }
      }
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

  private buildCharCard(def: PlayerDef, cx: number, cy: number): void {
    const cardW = 270;
    const cardH = 480;
    const colorHex = "#" + def.color.toString(16).padStart(6, "0");
    const statMod = (v: number) => Math.floor((v - 10) / 2);

    const bg = this.add
      .rectangle(cx, cy, cardW, cardH, 0x111122)
      .setStrokeStyle(2, 0x334455)
      .setInteractive({ useHandCursor: true });
    this.charCardBgs.set(def.id, bg);

    bg.on("pointerover", () => {
      if (this.selectedPlayer?.id !== def.id) bg.setStrokeStyle(2, def.color & 0x7f7f7f);
    });
    bg.on("pointerout", () => {
      if (this.selectedPlayer?.id !== def.id) bg.setStrokeStyle(2, 0x334455);
    });
    bg.on("pointerdown", () => this.selectChar(def));

    const top = cy - cardH / 2;

    this.add.rectangle(cx, top + 50, 48, 48, def.color);
    this.add.text(cx, top + 90, def.name, {
      fontSize: "15px", color: "#ffffff", fontFamily: "monospace", resolution: DPR,
    }).setOrigin(0.5, 0);
    this.add.text(cx, top + 114, `${def.speciesName}  ${def.className} ${def.level}`, {
      fontSize: "11px", color: "#8899aa", fontFamily: "monospace", resolution: DPR,
    }).setOrigin(0.5, 0);

    this.add.rectangle(cx, top + 140, cardW - 32, 1, 0x334455);

    const atkMod = def.mainAttack.statKey === "str" ? statMod(def.str) : statMod(def.dex);
    const atkBonus = atkMod + def.proficiencyBonus;
    this.add.text(cx, top + 152, [
      `HP ${def.maxHp}   AC ${def.ac}   Speed ${def.speedFt} ft`,
      `Attack +${atkBonus}   Initiative ${statMod(def.dex) >= 0 ? "+" : ""}${statMod(def.dex)}`,
    ].join("\n"), {
      fontSize: "11px", color: "#aabbcc", fontFamily: "monospace", resolution: DPR,
      align: "center", lineSpacing: 6,
    }).setOrigin(0.5, 0);

    this.add.rectangle(cx, top + 202, cardW - 32, 1, 0x334455);

    this.add.text(cx, top + 214, this.charFeatures(def).join("\n"), {
      fontSize: "11px", color: "#99bbcc", fontFamily: "monospace", resolution: DPR,
      align: "center", lineSpacing: 8,
    }).setOrigin(0.5, 0);

    this.add.text(cx, top + cardH - 32, "SELECT", {
      fontSize: "13px", color: colorHex, fontFamily: "monospace", resolution: DPR,
    }).setOrigin(0.5, 0);
  }

  private selectChar(def: PlayerDef): void {
    for (const [id, b] of this.charCardBgs)
      b.setStrokeStyle(2, id === def.id ? def.color : 0x334455);
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

  private buildPremadeCard(def: PremadeEncounterDef, cx: number, cy: number): void {
    const top = cy - ENC_CARD_H / 2;
    const left = cx - ENC_CARD_W / 2;

    const bg = this.add
      .rectangle(cx, cy, ENC_CARD_W, ENC_CARD_H, 0x111122)
      .setStrokeStyle(1, 0x334455)
      .setInteractive({ useHandCursor: true });
    this.encounterCardBgs.set(def.id, bg);

    bg.on("pointerover", () => {
      if (this.selectedEncounter?.id !== def.id) bg.setStrokeStyle(1, 0x556677);
    });
    bg.on("pointerout", () => {
      if (this.selectedEncounter?.id !== def.id) bg.setStrokeStyle(1, 0x334455);
    });
    bg.on("pointerdown", () => this.selectEncounter(def));

    // Map label
    this.add.text(left + 14, top + 10, def.mapId.toUpperCase(), {
      fontSize: "9px", color: "#445566", fontFamily: "monospace", resolution: DPR, letterSpacing: 1,
    }).setOrigin(0, 0);

    // Title
    this.add.text(cx, top + 26, def.title, {
      fontSize: "14px", color: "#e8e8f8", fontFamily: "monospace", resolution: DPR,
    }).setOrigin(0.5, 0);

    // Type chips
    let chipX = left + 14;
    const chipY = top + 52;
    def.encounterTypes.forEach((t) => {
      const label = TYPE_LABEL[t];
      const color = TYPE_COLOR[t];
      const chipW = label.length * 7 + 12;
      this.add.rectangle(chipX + chipW / 2, chipY + 8, chipW, 16, color, 0.2)
        .setStrokeStyle(1, color);
      this.add.text(chipX + chipW / 2, chipY + 8, label, {
        fontSize: "9px", color: "#" + color.toString(16).padStart(6, "0"),
        fontFamily: "monospace", resolution: DPR,
      }).setOrigin(0.5, 0.5);
      chipX += chipW + 6;
    });

    // Description
    this.add.text(cx, top + 78, def.description, {
      fontSize: "10px", color: "#8899aa", fontFamily: "monospace", resolution: DPR,
      wordWrap: { width: ENC_CARD_W - 28 }, lineSpacing: 4, align: "left",
    }).setOrigin(0.5, 0);
  }

  private selectEncounter(def: PremadeEncounterDef): void {
    for (const [id, b] of this.encounterCardBgs)
      b.setStrokeStyle(1, id === def.id ? 0xe2b96f : 0x334455);
    this.selectedEncounter = def;
    this.refreshBeginButton();
  }

  private isReady(): boolean {
    return this.selectedPlayer !== null && this.selectedEncounter !== null;
  }

  private refreshBeginButton(): void {
    const ready = this.isReady();
    this.beginBg.setAlpha(ready ? 1 : 0.4);
    this.beginLabel.setAlpha(ready ? 1 : 0.4);
  }

  private buildBeginButton(cx: number, cy: number): void {
    this.beginBg = this.add
      .rectangle(cx, cy, 260, 36, 0x1a3a20)
      .setStrokeStyle(1, 0x556677)
      .setAlpha(0.4);
    this.beginLabel = this.add
      .text(cx, cy, "BEGIN ENCOUNTER", {
        fontSize: "14px", color: "#ffffff", fontFamily: "monospace", resolution: DPR,
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

      const selectedId = this.selectedPlayer!.id;
      const resume = this.resumeState && this.savedCharDefId === selectedId
        ? this.resumeState
        : undefined;

      const encounterTypes = this.selectedEncounter!.encounterTypes as EncounterType[];
      const maps = this.registry.get("maps") as SavedMapDef[];
      const savedMap = maps.find((m) => m.id === this.selectedEncounter!.mapId);

      const config: EncounterStartConfig = {
        encounterTypes,
        mapType: "saved",
        playerDefId:       this.selectedPlayer!.id,
        playerName:        this.selectedPlayer!.name,
        playerSpeciesName: this.selectedPlayer!.speciesName,
        playerClassName:   this.selectedPlayer!.className,
        playerLevel:       this.selectedPlayer!.level,
        playerMaxHp:       this.selectedPlayer!.maxHp,
        playerAc:          this.selectedPlayer!.ac,
        savedMapName:        savedMap?.name,
        savedMapDescription: savedMap?.description,
      };

      this.beginBg.disableInteractive();
      SaveSystem.startEncounter(config).then((encounterContext) => {
        this.scene.start("GameScene", {
          playerDef: this.selectedPlayer,
          mapType: "saved",
          encounterTypes,
          savedMap,
          resumeState: resume,
          encounterContext: encounterContext ?? undefined,
        });
      });
    });
  }
}
