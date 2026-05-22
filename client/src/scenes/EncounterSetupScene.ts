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
const ENC_CARD_H = 155;
const ENC_COL1_CX = 920;
const ENC_COL2_CX = 1420;

const TYPE_COLOR: Record<EncounterType, number> = {
  simple_combat:      0xcc4444,
  exploration:        0x44aa66,
  social_interaction: 0x4488cc,
};
const TYPE_LABEL: Record<EncounterType, string> = {
  simple_combat:      "Combat",
  exploration:        "Exploration",
  social_interaction: "Social",
};

interface SaveDisplay {
  infoText: Phaser.GameObjects.Text;
  equippedText: Phaser.GameObjects.Text;
  deleteBg: Phaser.GameObjects.Rectangle;
  deleteLabel: Phaser.GameObjects.Text;
}

export class EncounterSetupScene extends Phaser.Scene {
  private selectedPlayer: PlayerDef | null = null;
  private selectedEncounter: PremadeEncounterDef | null = null;

  private charCardBgs: Map<string, Phaser.GameObjects.Rectangle> = new Map();
  private encounterCardBgs: Map<string, Phaser.GameObjects.Rectangle> = new Map();
  private saveDisplays: Map<string, SaveDisplay> = new Map();
  private beginBg!: Phaser.GameObjects.Rectangle;
  private beginLabel!: Phaser.GameObjects.Text;

  private characters: PlayerDef[] = [];
  private premadeEncounters: PremadeEncounterDef[] = [];
  private allSaves: Map<string, SaveData> = new Map();
  private resumeState: ResumeState | null = null;
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
    this.allSaves.clear();
    this.charCardBgs.clear();
    this.encounterCardBgs.clear();
    this.saveDisplays.clear();

    // Load saves for all characters from localStorage (sync)
    for (const char of this.characters) {
      const save = this.incomingSaveData?.playerDefId === char.id
        ? this.incomingSaveData
        : SaveSystem.load(char.id);
      if (save) this.allSaves.set(char.id, save);
    }

    this.add.rectangle(W / 2, H / 2, W, H, 0x0d0d1e);
    this.add.text(W / 2, 28, "ENCOUNTER SETUP", {
      fontSize: "22px", color: "#e2b96f", fontFamily: "monospace", resolution: DPR,
    }).setOrigin(0.5, 0);

    this.add.rectangle(W / 2, 66, W - 64, 1, 0x334455);
    this.add.rectangle(CHAR_DIVIDER_X, H / 2, 1, H - 140, 0x334455).setOrigin(0.5, 0.5);

    this.add.text(CHAR_DIVIDER_X / 2, 78, "CHARACTER", {
      fontSize: "11px", color: "#556677", fontFamily: "monospace", resolution: DPR, letterSpacing: 2,
    }).setOrigin(0.5, 0);
    this.add.text(CHAR_DIVIDER_X + (W - CHAR_DIVIDER_X) / 2, 78, "PREMADE ENCOUNTER", {
      fontSize: "11px", color: "#556677", fontFamily: "monospace", resolution: DPR, letterSpacing: 2,
    }).setOrigin(0.5, 0);

    this.characters.forEach((char, i) => {
      const cx = i === 0 ? CHAR1_CX : CHAR2_CX;
      this.buildCharCard(char, cx, CONTENT_CY);
    });

    const encPositions: [number, number][] = [
      [ENC_COL1_CX, 211], [ENC_COL2_CX, 211],
      [ENC_COL1_CX, 380], [ENC_COL2_CX, 380],
      [ENC_COL1_CX, 549], [ENC_COL2_CX, 549],
      [ENC_COL1_CX, 718], [ENC_COL2_CX, 718],
    ];
    this.premadeEncounters.forEach((enc, i) => {
      const [cx, cy] = encPositions[i] ?? [ENC_COL1_CX, 216 + i * 161];
      this.buildPremadeCard(enc, cx, cy);
    });

    this.add.rectangle(W / 2, H - 58, W - 64, 1, 0x334455);
    this.buildBeginButton(W / 2, H - 36);
    this.refreshBeginButton();

    // Auto-select last played character
    const lastId = SaveSystem.getLastCharacterId();
    if (lastId) {
      const def = this.characters.find((c) => c.id === lastId);
      if (def) this.selectChar(def);
    }

    // Async server sync for characters without a local save
    for (const char of this.characters) {
      if (!this.allSaves.has(char.id)) {
        SaveSystem.loadFromServer(char.id).then((save) => {
          if (save && this.scene.isActive()) {
            this.allSaves.set(char.id, save);
            this.updateSaveDisplay(char, save);
          }
        });
      }
    }
  }

  private updateSaveDisplay(def: PlayerDef, save: SaveData): void {
    const display = this.saveDisplays.get(def.id);
    if (!display) return;
    const items = this.registry.get("items") as ItemDef[];
    display.infoText.setText(this.saveInfoLine(save, def));
    display.equippedText.setText(this.equippedLine(save, items));
    display.deleteBg.setInteractive({ useHandCursor: true });
    display.deleteBg.setAlpha(1);
    display.deleteLabel.setAlpha(1);
  }

  private saveInfoLine(save: SaveData, def: PlayerDef): string {
    return `HP ${save.hp}/${def.maxHp}  ·  ${save.xp} XP  ·  ${save.gold} GP`;
  }

  private equippedLine(save: SaveData, items: ItemDef[]): string {
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    const weapon = save.equippedSlots?.weaponId ? byId[save.equippedSlots.weaponId]?.name : null;
    const armor  = save.equippedSlots?.armorId  ? byId[save.equippedSlots.armorId]?.name  : null;
    const shield = save.equippedSlots?.shieldId ? byId[save.equippedSlots.shieldId]?.name : null;
    return [weapon, armor, shield].filter(Boolean).join("  ·  ") || "—";
  }

  private buildCharCard(def: PlayerDef, cx: number, cy: number): void {
    const cardW = 270;
    const cardH = 490;
    const colorHex = "#" + def.color.toString(16).padStart(6, "0");
    const statMod = (v: number) => Math.floor((v - 10) / 2);
    const items = this.registry.get("items") as ItemDef[];
    const save = this.allSaves.get(def.id) ?? null;

    const bg = this.add
      .rectangle(cx, cy, cardW, cardH, 0x111122)
      .setStrokeStyle(2, 0x334455)
      .setInteractive({ useHandCursor: true });
    this.charCardBgs.set(def.id, bg);
    bg.on("pointerover", () => { if (this.selectedPlayer?.id !== def.id) bg.setStrokeStyle(2, def.color & 0x7f7f7f); });
    bg.on("pointerout",  () => { if (this.selectedPlayer?.id !== def.id) bg.setStrokeStyle(2, 0x334455); });
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

    this.add.rectangle(cx, top + 200, cardW - 32, 1, 0x334455);

    this.add.text(cx, top + 212, this.charFeatures(def).join("\n"), {
      fontSize: "11px", color: "#99bbcc", fontFamily: "monospace", resolution: DPR,
      align: "center", lineSpacing: 8,
    }).setOrigin(0.5, 0);

    // ── Save section ──────────────────────────────────────────────
    this.add.rectangle(cx, top + 308, cardW - 32, 1, 0x223344);

    const infoText = this.add.text(cx, top + 320, save ? this.saveInfoLine(save, def) : "No save data", {
      fontSize: "10px", color: save ? "#aabbcc" : "#445566", fontFamily: "monospace", resolution: DPR,
    }).setOrigin(0.5, 0);

    const equippedText = this.add.text(cx, top + 338, save ? this.equippedLine(save, items) : "", {
      fontSize: "10px", color: "#667788", fontFamily: "monospace", resolution: DPR,
    }).setOrigin(0.5, 0);

    const deleteBg = this.add
      .rectangle(cx, top + 366, 110, 22, 0x1a0808)
      .setStrokeStyle(1, save ? 0x663333 : 0x222222)
      .setAlpha(save ? 1 : 0.3);
    const deleteLabel = this.add
      .text(cx, top + 366, "DELETE SAVE", {
        fontSize: "10px", color: save ? "#995555" : "#445566", fontFamily: "monospace", resolution: DPR,
      })
      .setOrigin(0.5)
      .setAlpha(save ? 1 : 0.3);

    if (save) {
      deleteBg.setInteractive({ useHandCursor: true });
      deleteBg.on("pointerover", () => { deleteBg.setStrokeStyle(1, 0xaa4444); deleteLabel.setColor("#cc6666"); });
      deleteBg.on("pointerout",  () => { deleteBg.setStrokeStyle(1, 0x663333); deleteLabel.setColor("#995555"); });
      deleteBg.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
        pointer.event.stopPropagation();
        SaveSystem.deleteSave(def.id);
        this.allSaves.delete(def.id);
        if (this.selectedPlayer?.id === def.id) this.resumeState = null;
        infoText.setText("No save data").setColor("#445566");
        equippedText.setText("");
        deleteBg.disableInteractive().setStrokeStyle(1, 0x222222).setAlpha(0.3);
        deleteLabel.setColor("#445566").setAlpha(0.3);
      });
    }

    this.saveDisplays.set(def.id, { infoText, equippedText, deleteBg, deleteLabel });

    // ── SELECT label ──────────────────────────────────────────────
    this.add.text(cx, top + cardH - 24, "SELECT", {
      fontSize: "13px", color: colorHex, fontFamily: "monospace", resolution: DPR,
    }).setOrigin(0.5, 0);
  }

  private selectChar(def: PlayerDef): void {
    for (const [id, b] of this.charCardBgs)
      b.setStrokeStyle(2, id === def.id ? def.color : 0x334455);
    this.selectedPlayer = def;
    const save = this.allSaves.get(def.id);
    if (save) {
      const items = this.registry.get("items") as ItemDef[];
      this.resumeState = resumeFromSave(save, items, def.defaultEquipment);
    } else {
      this.resumeState = null;
    }
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
    bg.on("pointerover", () => { if (this.selectedEncounter?.id !== def.id) bg.setStrokeStyle(1, 0x556677); });
    bg.on("pointerout",  () => { if (this.selectedEncounter?.id !== def.id) bg.setStrokeStyle(1, 0x334455); });
    bg.on("pointerdown", () => this.selectEncounter(def));

    this.add.text(left + 14, top + 10, def.mapId.toUpperCase(), {
      fontSize: "9px", color: "#445566", fontFamily: "monospace", resolution: DPR, letterSpacing: 1,
    }).setOrigin(0, 0);
    this.add.text(cx, top + 26, def.title, {
      fontSize: "14px", color: "#e8e8f8", fontFamily: "monospace", resolution: DPR,
    }).setOrigin(0.5, 0);

    let chipX = left + 14;
    const chipY = top + 52;
    def.encounterTypes.forEach((t) => {
      const label = TYPE_LABEL[t as EncounterType];
      const color = TYPE_COLOR[t as EncounterType];
      const chipW = label.length * 7 + 12;
      this.add.rectangle(chipX + chipW / 2, chipY + 8, chipW, 16, color, 0.2).setStrokeStyle(1, color);
      this.add.text(chipX + chipW / 2, chipY + 8, label, {
        fontSize: "9px", color: "#" + color.toString(16).padStart(6, "0"),
        fontFamily: "monospace", resolution: DPR,
      }).setOrigin(0.5, 0.5);
      chipX += chipW + 6;
    });

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
    this.beginBg.on("pointerover", () => { if (this.isReady()) this.beginBg.setAlpha(0.75); });
    this.beginBg.on("pointerout",  () => { if (this.isReady()) this.beginBg.setAlpha(1); });
    this.beginBg.on("pointerdown", () => {
      if (!this.isReady()) return;

      const encounterTypes = this.selectedEncounter!.encounterTypes as EncounterType[];
      const maps = this.registry.get("maps") as SavedMapDef[];
      const savedMap = maps.find((m) => m.id === this.selectedEncounter!.mapId);

      const config: EncounterStartConfig = {
        encounterTypes,
        mapType: "saved",
        playerDefId:         this.selectedPlayer!.id,
        playerName:          this.selectedPlayer!.name,
        playerSpeciesName:   this.selectedPlayer!.speciesName,
        playerClassName:     this.selectedPlayer!.className,
        playerLevel:         this.selectedPlayer!.level,
        playerMaxHp:         this.selectedPlayer!.maxHp,
        playerAc:            this.selectedPlayer!.ac,
        savedMapName:        savedMap?.name,
        savedMapDescription: savedMap?.description,
        npcId:               this.selectedEncounter!.npcId,
      };

      this.beginBg.disableInteractive();
      SaveSystem.startEncounter(config).then((encounterContext) => {
        this.scene.start("GameScene", {
          playerDef:      this.selectedPlayer,
          mapType:        "saved",
          encounterTypes,
          savedMap,
          resumeState:    this.resumeState ?? undefined,
          encounterContext: encounterContext ?? undefined,
          npcId:           this.selectedEncounter!.npcId,
          passiveNpcCount: this.selectedEncounter!.passiveNpcCount ?? 0,
        });
      });
    });
  }
}
