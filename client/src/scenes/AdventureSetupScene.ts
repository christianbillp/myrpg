import Phaser from "phaser";
import { PlayerDef } from "../data/player";
import { ItemDef } from "../data/equipment";
import { gameClient } from "../net/GameClient";
import type { GameState, AdventureDef, AdventureSave, EquipmentSlots, EncounterRecord, StorylogEntry } from "../net/types";
import { StorylogOverlay } from "../ui/StorylogOverlay";
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

const CHAR_DIVIDER_X = 920;
const CHAR_CXS = [155, 460, 765];
const CARD_CY = Math.round(80 + (H - 80 - 100) / 2);

const ADV_CARD_CX = (CHAR_DIVIDER_X + W) / 2;
const ADV_CARD_W = W - CHAR_DIVIDER_X - 64;
const ADV_CARD_H = 180;
/** Center y of the first adventure card. Matches the EncounterSetupScene's first card row (cy=211) so the two screens share visual rhythm. */
const ADV_FIRST_CY = 211;
const ADV_GAP = 24;

const LAST_CHAR_KEY = "myrpg_last_character";
const saveKey = (id: string) => `myrpg_save_${id}`;

interface LocalSave {
  playerDefId: string;
  hp: number; xp: number; gold: number;
  inventoryIds: string[];
  equippedSlots?: EquipmentSlots;
  encounterLog?: EncounterRecord[];
  storylog?: StorylogEntry[];
}

interface SaveDisplay {
  deleteBg: Phaser.GameObjects.Rectangle;
  deleteLabel: Phaser.GameObjects.Text;
  storylogBg: Phaser.GameObjects.Rectangle;
  storylogLabel: Phaser.GameObjects.Text;
}

/**
 * AdventureSetupScene — character + adventure selection. Mirrors the visual
 * conventions of EncounterSetupScene but presents adventures (1-column stack
 * of larger cards with progress dots) instead of one-off encounters. Cards
 * for in-progress adventures show CONTINUE; otherwise BEGIN.
 */
export class AdventureSetupScene extends Phaser.Scene {
  private characters: PlayerDef[] = [];
  private adventures: AdventureDef[] = [];
  private adventureSaves: Map<string, AdventureSave> = new Map(); // keyed by characterId
  private charSaves: Map<string, LocalSave> = new Map(); // keyed by characterId — the persistent character save
  private selectedPlayer: PlayerDef | null = null;
  private selectedAdventure: AdventureDef | null = null;

  private charCardBgs = new Map<string, Phaser.GameObjects.Rectangle>();
  private saveDisplays = new Map<string, SaveDisplay>();
  private advCardBgs = new Map<string, Phaser.GameObjects.Rectangle>();
  private advCardLabels = new Map<string, Phaser.GameObjects.Text>();
  private advCardProgress = new Map<string, Phaser.GameObjects.Text>();
  private beginBg!: Phaser.GameObjects.Rectangle;
  private beginLabel!: Phaser.GameObjects.Text;

  constructor() {
    super({ key: "AdventureSetupScene" });
  }

  init(): void {
    this.selectedPlayer = null;
    this.selectedAdventure = null;
    this.charCardBgs.clear();
    this.saveDisplays.clear();
    this.advCardBgs.clear();
    this.advCardLabels.clear();
    this.advCardProgress.clear();
    this.adventureSaves.clear();
    this.charSaves.clear();
  }

  create(): void {
    this.characters = this.registry.get("characters") as PlayerDef[];
    this.adventures = (this.registry.get("adventures") as AdventureDef[]) ?? [];

    // Seed character saves from localStorage so cards render with HP/XP/GP
    // immediately on first paint; the server sync below corrects any drift.
    for (const char of this.characters) {
      const raw = localStorage.getItem(saveKey(char.id));
      if (raw) {
        try { this.charSaves.set(char.id, JSON.parse(raw) as LocalSave); } catch { /* ignore */ }
      }
    }

    this.add.rectangle(W / 2, H / 2, W, H, 0x0d0d1e);
    this.add.text(W / 2, 28, "ADVENTURE SETUP", {
      fontSize: "22px", color: "#e2b96f", fontFamily: "monospace", resolution: DPR,
    }).setOrigin(0.5, 0);

    this.add.rectangle(W / 2, 66, W - 64, 1, 0x334455);
    this.add.rectangle(CHAR_DIVIDER_X, H / 2, 1, H - 140, 0x334455).setOrigin(0.5, 0.5);

    this.add.text(CHAR_DIVIDER_X / 2, 78, "CHARACTER", {
      fontSize: "11px", color: "#556677", fontFamily: "monospace", resolution: DPR, letterSpacing: 2,
    }).setOrigin(0.5, 0);
    this.add.text(CHAR_DIVIDER_X + (W - CHAR_DIVIDER_X) / 2, 78, "ADVENTURE", {
      fontSize: "11px", color: "#556677", fontFamily: "monospace", resolution: DPR, letterSpacing: 2,
    }).setOrigin(0.5, 0);

    this.characters.forEach((char, i) => {
      const cx = CHAR_CXS[i] ?? CHAR_CXS[CHAR_CXS.length - 1];
      this.buildCharCard(char, cx, CARD_CY);
    });

    this.adventures.forEach((adv, i) => {
      this.buildAdventureCard(adv, ADV_CARD_CX, ADV_FIRST_CY + i * (ADV_CARD_H + ADV_GAP));
    });

    this.add.rectangle(W / 2, H - 58, W - 64, 1, 0x334455);
    this.buildBackButton(120, H - 36);
    this.buildBeginButton(W / 2, H - 36);
    this.refreshBeginButton();

    const lastId = localStorage.getItem(LAST_CHAR_KEY);
    if (lastId) {
      const def = this.characters.find((c) => c.id === lastId);
      if (def) this.selectChar(def);
    }

    // Sync adventure saves for every character so cards show progress.
    for (const char of this.characters) {
      gameClient.loadAdventureSave(char.id).then((save) => {
        if (!this.scene.isActive()) return;
        if (save) {
          this.adventureSaves.set(char.id, save);
          this.refreshAdventureCards();
        }
      }).catch(() => {});
    }
  }

  private buildCharCard(def: PlayerDef, cx: number, cy: number): void {
    const cardW = 270;
    const cardH = 550;
    const colorHex = "#" + def.color.toString(16).padStart(6, "0");
    const statMod = (v: number) => Math.floor((v - 10) / 2);
    const items = this.registry.get("equipment") as ItemDef[];
    const save = this.charSaves.get(def.id) ?? null;

    const bg = this.add.rectangle(cx, cy, cardW, cardH, 0x111122).setStrokeStyle(2, 0x334455).setInteractive({ useHandCursor: true });
    this.charCardBgs.set(def.id, bg);
    bg.on("pointerover", () => { if (this.selectedPlayer?.id !== def.id) bg.setStrokeStyle(2, def.color & 0x7f7f7f); });
    bg.on("pointerout",  () => { if (this.selectedPlayer?.id !== def.id) bg.setStrokeStyle(2, 0x334455); });
    bg.on("pointerdown", () => this.selectChar(def));

    const top = cy - cardH / 2;

    this.add.rectangle(cx, top + 50, 48, 48, def.color);
    this.add.text(cx, top + 90, def.name, { fontSize: "15px", color: "#ffffff", fontFamily: "monospace", resolution: DPR }).setOrigin(0.5, 0);
    this.add.text(cx, top + 114, `${def.speciesName}  ${def.className} ${def.level}`, { fontSize: "11px", color: "#8899aa", fontFamily: "monospace", resolution: DPR }).setOrigin(0.5, 0);
    this.add.rectangle(cx, top + 140, cardW - 32, 1, 0x334455);

    const atkMod = def.mainAttack.statKey === "str" ? statMod(def.str) : statMod(def.dex);
    const atkBonus = atkMod + def.proficiencyBonus;
    this.add.text(cx, top + 152, [
      `HP ${def.maxHp}   AC ${def.ac}   Speed ${def.speed} ft`,
      `Attack +${atkBonus}   Initiative ${statMod(def.dex) >= 0 ? "+" : ""}${statMod(def.dex)}`,
    ].join("\n"), { fontSize: "11px", color: "#aabbcc", fontFamily: "monospace", resolution: DPR, align: "center", lineSpacing: 6 }).setOrigin(0.5, 0);

    this.add.rectangle(cx, top + 200, cardW - 32, 1, 0x334455);
    this.add.text(cx, top + 212, def.description ?? '', {
      fontSize: "11px", color: "#99bbcc", fontFamily: "monospace", resolution: DPR,
      align: "center", lineSpacing: 8, wordWrap: { width: cardW - 48 },
    }).setOrigin(0.5, 0);

    this.add.rectangle(cx, top + 410, cardW - 32, 1, 0x223344);

    this.add.text(cx, top + 422, save ? this.saveInfoLine(save, def) : "No save data", {
      fontSize: "10px", color: save ? "#aabbcc" : "#445566", fontFamily: "monospace", resolution: DPR,
    }).setOrigin(0.5, 0);
    this.add.text(cx, top + 440, save ? this.equippedLine(save, items) : "", {
      fontSize: "10px", color: "#667788", fontFamily: "monospace", resolution: DPR,
    }).setOrigin(0.5, 0);

    // DELETE SAVE — clears both the character save AND the adventure save so
    // the player can replay the adventure from chapter 1 with default gear.
    const deleteBg = this.add.rectangle(cx, top + 470, 110, 22, 0x1a0808)
      .setStrokeStyle(1, save ? 0x663333 : 0x222222).setAlpha(save ? 1 : 0.3);
    const deleteLabel = this.add.text(cx, top + 470, "DELETE SAVE", {
      fontSize: "10px", color: save ? "#995555" : "#445566", fontFamily: "monospace", resolution: DPR,
    }).setOrigin(0.5).setAlpha(save ? 1 : 0.3);
    if (save) {
      deleteBg.setInteractive({ useHandCursor: true });
      deleteBg.on("pointerover", () => { deleteBg.setStrokeStyle(1, 0xaa4444); deleteLabel.setColor("#cc6666"); });
      deleteBg.on("pointerout",  () => { deleteBg.setStrokeStyle(1, 0x663333); deleteLabel.setColor("#995555"); });
      deleteBg.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
        pointer.event.stopPropagation();
        this.deleteSaves(def);
      });
    }

    // STORY LOG — opens the same overlay used by EncounterSetupScene.
    const storylogBg = this.add.rectangle(cx, top + 498, 110, 22, 0x0d1a1a)
      .setStrokeStyle(1, save ? 0x2a7766 : 0x222222).setAlpha(save ? 1 : 0.3);
    const storylogLabel = this.add.text(cx, top + 498, "STORY LOG", {
      fontSize: "10px", color: save ? "#44aa88" : "#445566", fontFamily: "monospace", resolution: DPR,
    }).setOrigin(0.5).setAlpha(save ? 1 : 0.3);
    if (save) {
      storylogBg.setInteractive({ useHandCursor: true });
      storylogBg.on("pointerover", () => { storylogBg.setStrokeStyle(1, 0x44aa88); storylogLabel.setColor("#66ccaa"); });
      storylogBg.on("pointerout",  () => { storylogBg.setStrokeStyle(1, 0x2a7766); storylogLabel.setColor("#44aa88"); });
      storylogBg.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
        pointer.event.stopPropagation();
        this.openStorylogOverlay(def);
      });
    }
    this.saveDisplays.set(def.id, { deleteBg, deleteLabel, storylogBg, storylogLabel });

    this.add.text(cx, top + cardH - 24, "SELECT", { fontSize: "13px", color: colorHex, fontFamily: "monospace", resolution: DPR }).setOrigin(0.5, 0);
  }

  /**
   * Deletes both the character save and the adventure save for this player so
   * the next BEGIN ADVENTURE starts from chapter 1 with default gear / HP.
   * Greys out the two action buttons in place; no scene reset needed.
   */
  private deleteSaves(def: PlayerDef): void {
    localStorage.removeItem(saveKey(def.id));
    this.charSaves.delete(def.id);
    this.adventureSaves.delete(def.id);
    gameClient.deleteSave(def.id).catch(() => {});
    gameClient.deleteAdventureSave(def.id).catch(() => {});
    const display = this.saveDisplays.get(def.id);
    if (display) {
      display.deleteBg.disableInteractive().setStrokeStyle(1, 0x222222).setAlpha(0.3);
      display.deleteLabel.setColor("#445566").setAlpha(0.3);
      display.storylogBg.disableInteractive().setStrokeStyle(1, 0x222222).setAlpha(0.3);
      display.storylogLabel.setColor("#445566").setAlpha(0.3);
    }
    this.refreshAdventureCards();
  }

  private openStorylogOverlay(def: PlayerDef): void {
    const save = this.charSaves.get(def.id);
    if (!save) return;
    const handleUpdated = (updated: StorylogEntry[]) => {
      save.storylog = updated;
      this.charSaves.set(def.id, save);
      localStorage.setItem(saveKey(def.id), JSON.stringify(save));
    };
    new StorylogOverlay(
      def.name,
      save.encounterLog ?? [],
      save.storylog ?? [],
      () => gameClient.generateStorylog(def.id),
      () => gameClient.generateStorylog(def.id, true),
      handleUpdated,
    );
  }

  private saveInfoLine(save: LocalSave, def: PlayerDef): string {
    return `HP ${save.hp}/${def.maxHp}  ·  ${save.xp} XP  ·  ${save.gold} GP`;
  }

  private equippedLine(save: LocalSave, items: ItemDef[]): string {
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    const weapon = save.equippedSlots?.weaponId ? byId[save.equippedSlots.weaponId]?.name : null;
    const armor  = save.equippedSlots?.armorId  ? byId[save.equippedSlots.armorId]?.name  : null;
    const shield = save.equippedSlots?.shieldId ? byId[save.equippedSlots.shieldId]?.name : null;
    return [weapon, armor, shield].filter(Boolean).join("  ·  ") || "—";
  }

  private buildAdventureCard(adv: AdventureDef, cx: number, cy: number): void {
    const bg = this.add.rectangle(cx, cy, ADV_CARD_W, ADV_CARD_H, 0x141426).setStrokeStyle(2, 0x334455).setInteractive({ useHandCursor: true });
    this.advCardBgs.set(adv.id, bg);
    bg.on("pointerover", () => { if (this.selectedAdventure?.id !== adv.id) bg.setStrokeStyle(2, 0x6688aa); });
    bg.on("pointerout",  () => { if (this.selectedAdventure?.id !== adv.id) bg.setStrokeStyle(2, 0x334455); });
    bg.on("pointerdown", () => this.selectAdventure(adv));

    const top = cy - ADV_CARD_H / 2;
    const left = cx - ADV_CARD_W / 2;

    this.add.text(left + 16, top + 14, adv.title, {
      fontSize: "16px", color: "#e2b96f", fontFamily: "monospace", resolution: DPR,
    }).setOrigin(0, 0);

    const progressText = this.add.text(left + ADV_CARD_W - 16, top + 14, "", {
      fontSize: "11px", color: "#88aacc", fontFamily: "monospace", resolution: DPR, align: "right",
    }).setOrigin(1, 0);
    this.advCardProgress.set(adv.id, progressText);

    this.add.text(left + 16, top + 44, `${adv.chapters.length} chapters`, {
      fontSize: "11px", color: "#778899", fontFamily: "monospace", resolution: DPR,
    }).setOrigin(0, 0);

    const desc = this.add.text(left + 16, top + 72, adv.description, {
      fontSize: "12px", color: "#bbccdd", fontFamily: "sans-serif", resolution: DPR,
      wordWrap: { width: ADV_CARD_W - 32 },
    });
    this.advCardLabels.set(adv.id, desc);
  }

  private refreshAdventureCards(): void {
    if (!this.selectedPlayer) return;
    const save = this.adventureSaves.get(this.selectedPlayer.id);
    for (const adv of this.adventures) {
      const text = this.advCardProgress.get(adv.id);
      if (!text) continue;
      if (save && save.adventureId === adv.id) {
        const completed = save.completedChapterIds.length;
        text.setText(`IN PROGRESS · ${completed}/${adv.chapters.length}`);
        text.setColor("#88ccaa");
      } else {
        text.setText("");
      }
    }
    this.refreshBeginButton();
  }

  private selectChar(def: PlayerDef): void {
    this.selectedPlayer = def;
    localStorage.setItem(LAST_CHAR_KEY, def.id);
    for (const [id, bg] of this.charCardBgs) {
      bg.setStrokeStyle(2, id === def.id ? def.color : 0x334455);
    }
    this.refreshAdventureCards();
    this.refreshBeginButton();
  }

  private selectAdventure(adv: AdventureDef): void {
    this.selectedAdventure = adv;
    for (const [id, bg] of this.advCardBgs) {
      bg.setStrokeStyle(2, id === adv.id ? 0xe2b96f : 0x334455);
    }
    this.refreshBeginButton();
  }

  private buildBackButton(cx: number, cy: number): void {
    const bg = this.add.rectangle(cx, cy, 160, 36, 0x222233).setStrokeStyle(1, 0x556677).setInteractive({ useHandCursor: true });
    this.add.text(cx, cy, "BACK", {
      fontSize: "13px", color: "#aabbcc", fontFamily: "monospace", resolution: DPR,
    }).setOrigin(0.5);
    bg.on("pointerdown", () => this.scene.start("MainMenuScene"));
  }

  private buildBeginButton(cx: number, cy: number): void {
    this.beginBg = this.add.rectangle(cx, cy, 240, 44, 0x1a3a2a).setStrokeStyle(2, 0x2a6655);
    this.beginLabel = this.add.text(cx, cy, "BEGIN ADVENTURE", {
      fontSize: "14px", color: "#ffe9a8", fontFamily: "monospace", resolution: DPR,
    }).setOrigin(0.5);
  }

  private refreshBeginButton(): void {
    const ready = !!(this.selectedPlayer && this.selectedAdventure);
    const save = this.selectedPlayer && this.selectedAdventure
      ? this.adventureSaves.get(this.selectedPlayer.id)
      : null;
    const continuing = !!save && save.adventureId === this.selectedAdventure?.id && save.completedChapterIds.length > 0;

    this.beginLabel.setText(continuing ? "CONTINUE ADVENTURE" : "BEGIN ADVENTURE");
    if (ready) {
      this.beginBg.setFillStyle(0x1a3a2a).setStrokeStyle(2, 0x2a6655).setInteractive({ useHandCursor: true });
      this.beginLabel.setColor("#ffe9a8");
      this.beginBg.removeAllListeners("pointerdown").on("pointerdown", () => this.beginAdventure());
    } else {
      this.beginBg.disableInteractive().setFillStyle(0x1a2222).setStrokeStyle(2, 0x334455);
      this.beginLabel.setColor("#556677");
    }
  }

  private beginAdventure(): void {
    if (!this.selectedPlayer || !this.selectedAdventure) return;
    this.beginBg.disableInteractive();
    gameClient.startAdventure(this.selectedPlayer.id, this.selectedAdventure.id).then((initialState: GameState) => {
      this.scene.start("GameScene", { sessionId: initialState.sessionId, playerDef: this.selectedPlayer! });
    }).catch((err: unknown) => {
      console.error("Failed to start adventure:", err);
      this.beginBg.setInteractive({ useHandCursor: true });
    });
  }
}
