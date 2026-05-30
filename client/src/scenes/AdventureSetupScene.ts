import Phaser from "phaser";
import { PlayerDef } from "../data/player";
import { ItemDef } from "../data/equipment";
import { gameClient } from "../net/GameClient";
import type { GameState, AdventureDef, AdventureSave, EquipmentSlots, EncounterRecord, StorylogEntry } from "../net/types";
import { StorylogOverlay } from "../ui/StorylogOverlay";
import { createHtmlButton, createHtmlText, type HtmlButtonHandle, type HtmlTextHandle } from "../ui/htmlButtons";
import { CharacterCarousel } from "../ui/setup/CharacterCarousel";
import { CharacterDetail } from "../ui/setup/CharacterDetail";
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

const CHAR_DIVIDER_X = 920;

const ADV_CARD_CX = (CHAR_DIVIDER_X + W) / 2;
const ADV_CARD_W = W - CHAR_DIVIDER_X - 64;
const ADV_CARD_H = 180;
const ADV_FIRST_CY = 211;
const ADV_GAP = 24;

const LAST_CHAR_KEY = "myrpg_last_character";
const saveKey = (id: string) => `myrpg_save_${id}`;

interface LocalSave {
  playerDefId: string;
  hp: number; xp: number;
  /** Coin purse balance in Copper Pieces — see `shared/currency.ts`. */
  balanceCp: number;
  inventoryIds: string[];
  equippedSlots?: EquipmentSlots;
  encounterLog?: EncounterRecord[];
  storylog?: StorylogEntry[];
  /** Mirror of `CharSave.levelUps` — length tells us how many levels above 1 the character has reached. */
  levelUps?: unknown[];
}

interface AdvCardElems {
  cardBtn: HtmlButtonHandle;
  progressEl: HTMLDivElement;
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
  private adventureSaves: Map<string, AdventureSave> = new Map();
  private charSaves: Map<string, LocalSave> = new Map();
  private selectedPlayer: PlayerDef | null = null;
  private selectedAdventure: AdventureDef | null = null;

  private advCards = new Map<string, AdvCardElems>();
  private characterCarousel: CharacterCarousel | null = null;
  private characterDetail: CharacterDetail | null = null;
  private htmlTexts: HtmlTextHandle[] = [];
  private htmlButtons: HtmlButtonHandle[] = [];
  private beginBtn!: HtmlButtonHandle;

  constructor() {
    super({ key: "AdventureSetupScene" });
  }

  init(): void {
    this.selectedPlayer = null;
    this.selectedAdventure = null;
    this.advCards.clear();
    this.adventureSaves.clear();
    this.charSaves.clear();
  }

  create(): void {
    this.characters = this.registry.get("characters") as PlayerDef[];
    this.adventures = (this.registry.get("adventures") as AdventureDef[]) ?? [];

    for (const char of this.characters) {
      const raw = localStorage.getItem(saveKey(char.id));
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as LocalSave & { gold?: number };
          // One-time migration: pre-currency saves stored `gold` (whole GP).
          if (parsed.balanceCp == null && typeof parsed.gold === "number") {
            parsed.balanceCp = parsed.gold * 100;
            delete parsed.gold;
            localStorage.setItem(saveKey(char.id), JSON.stringify(parsed));
          }
          this.charSaves.set(char.id, parsed);
        } catch { /* ignore */ }
      }
    }

    this.add.rectangle(W / 2, H / 2, W, H, 0x0d0d1e);
    this.add.rectangle(W / 2, 66, W - 64, 1, 0x334455);
    this.add.rectangle(CHAR_DIVIDER_X, H / 2, 1, H - 140, 0x334455).setOrigin(0.5, 0.5);
    this.add.rectangle(W / 2, H - 58, W - 64, 1, 0x334455);

    this.htmlTexts.push(createHtmlText({
      scene: this, sceneWidth: W,
      x: 0, y: 22, w: W, h: 28,
      text: "ADVENTURE SETUP",
      fontSize: 22, color: "#e2b96f", align: "center", letterSpacing: 1,
    }));

    this.htmlTexts.push(createHtmlText({
      scene: this, sceneWidth: W,
      x: 0, y: 78, w: CHAR_DIVIDER_X, h: 14,
      text: "CHARACTER",
      fontSize: 11, color: "#556677", align: "center", letterSpacing: 2,
    }));

    this.htmlTexts.push(createHtmlText({
      scene: this, sceneWidth: W,
      x: CHAR_DIVIDER_X, y: 78, w: W - CHAR_DIVIDER_X, h: 14,
      text: "ADVENTURE",
      fontSize: 11, color: "#556677", align: "center", letterSpacing: 2,
    }));

    // ── Character column: carousel up top, full sheet below ────────────
    // Same layout as EncounterSetupScene — share the components and the
    // measurements so the two scenes feel uniform.
    const CHAR_COL_X = 24;
    const CHAR_COL_W = CHAR_DIVIDER_X - CHAR_COL_X - 24;
    const CAROUSEL_Y = 100;
    const CAROUSEL_H = 240;
    const DETAIL_Y = CAROUSEL_Y + CAROUSEL_H + 12;
    const DETAIL_H = H - 100 - DETAIL_Y;
    const items = this.registry.get("equipment") as ItemDef[];
    const spells = this.registry.get("spells") as import("../net/types").SpellDef[];
    this.characterDetail = new CharacterDetail({
      scene: this, sceneWidth: W,
      x: CHAR_COL_X, y: DETAIL_Y, width: CHAR_COL_W, height: DETAIL_H,
      equipment: items ?? [],
      spells: spells ?? [],
      callbacks: {
        // Adventure setup deletes BOTH the character save and the adventure
        // save so the next BEGIN ADVENTURE starts fresh from chapter 1.
        onDeleteSave: (def) => {
          localStorage.removeItem(saveKey(def.id));
          this.charSaves.delete(def.id);
          this.adventureSaves.delete(def.id);
          gameClient.deleteSave(def.id).catch(() => {});
          gameClient.deleteAdventureSave(def.id).catch(() => {});
          this.characterDetail?.setSave(null);
          this.refreshAdventureCards();
          this.refreshBeginButton();
        },
        onStorylog: (def) => this.openStorylogOverlay(def),
      },
    });
    this.characterCarousel = new CharacterCarousel({
      scene: this, sceneWidth: W,
      x: CHAR_COL_X, y: CAROUSEL_Y, width: CHAR_COL_W, height: CAROUSEL_H,
      characters: this.characters,
      onChange: (def) => this.selectChar(def),
    });

    this.adventures.forEach((adv, i) => {
      this.buildAdventureCard(adv, ADV_CARD_CX, ADV_FIRST_CY + i * (ADV_CARD_H + ADV_GAP));
    });

    this.buildBackButton(120, H - 36);
    this.buildBeginButton(W / 2, H - 36);
    this.refreshBeginButton();

    const lastId = localStorage.getItem(LAST_CHAR_KEY);
    if (lastId) this.characterCarousel?.setSelectedId(lastId);

    for (const char of this.characters) {
      gameClient.loadAdventureSave(char.id).then((save) => {
        if (!this.scene.isActive()) return;
        if (save) {
          this.adventureSaves.set(char.id, save);
          this.refreshAdventureCards();
        }
      }).catch(() => {});

      // Refresh the character save so the detail panel reflects any
      // level-ups the player picked up in a previous session.
      gameClient.loadSave(char.id).then((data) => {
        if (!this.scene.isActive() || !data) return;
        const save = data as LocalSave;
        localStorage.setItem(saveKey(char.id), JSON.stringify(save));
        this.charSaves.set(char.id, save);
        if (this.selectedPlayer?.id === char.id) this.characterDetail?.setSave(save);
      }).catch(() => {});
    }

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.teardown());
    this.events.once(Phaser.Scenes.Events.DESTROY, () => this.teardown());
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


  private buildAdventureCard(adv: AdventureDef, cx: number, cy: number): void {
    const left = cx - ADV_CARD_W / 2;
    const top = cy - ADV_CARD_H / 2;

    const cardBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: left, y: top, w: ADV_CARD_W, h: ADV_CARD_H,
      label: "", variant: "ghost",
      onClick: () => this.selectAdventure(adv),
    });
    cardBtn.el.textContent = "";
    cardBtn.el.style.padding = "0";
    cardBtn.el.style.background = "#141426";
    cardBtn.el.style.borderColor = "#334455";
    cardBtn.el.style.borderWidth = "2px";
    cardBtn.el.style.whiteSpace = "normal";
    cardBtn.el.style.overflow = "hidden";

    const inner = document.createElement("div");
    inner.style.cssText = `
      position: relative; display: flex; flex-direction: column;
      width: 100%; height: 100%; padding: 14px 16px; box-sizing: border-box;
      font-family: monospace; color: #bbccdd; pointer-events: none;
    `;
    cardBtn.el.appendChild(inner);

    const title = document.createElement("div");
    title.textContent = adv.title;
    title.style.cssText = "font-size: 16px; color: #e2b96f;";
    inner.appendChild(title);

    const progressEl = document.createElement("div");
    progressEl.style.cssText = "position: absolute; right: 16px; top: 14px; font-size: 11px; color: #88aacc; text-align: right;";
    inner.appendChild(progressEl);

    const chapters = document.createElement("div");
    chapters.textContent = `${adv.chapters.length} chapters`;
    chapters.style.cssText = "margin-top: 14px; font-size: 11px; color: #778899;";
    inner.appendChild(chapters);

    const desc = document.createElement("div");
    desc.textContent = adv.description;
    desc.style.cssText = "margin-top: 14px; font-size: 12px; color: #bbccdd; font-family: sans-serif; line-height: 1.5;";
    inner.appendChild(desc);

    this.advCards.set(adv.id, { cardBtn, progressEl });
  }

  private refreshAdventureCards(): void {
    if (!this.selectedPlayer) return;
    const save = this.adventureSaves.get(this.selectedPlayer.id);
    for (const adv of this.adventures) {
      const elems = this.advCards.get(adv.id);
      if (!elems) continue;
      if (save && save.adventureId === adv.id) {
        const completed = save.completedChapterIds.length;
        elems.progressEl.textContent = `IN PROGRESS · ${completed}/${adv.chapters.length}`;
        elems.progressEl.style.color = "#88ccaa";
      } else {
        elems.progressEl.textContent = "";
      }
    }
    this.refreshBeginButton();
  }

  private selectChar(def: PlayerDef): void {
    this.selectedPlayer = def;
    localStorage.setItem(LAST_CHAR_KEY, def.id);
    this.characterDetail?.setCharacter(def);
    this.characterDetail?.setSave(this.charSaves.get(def.id) ?? null);
    this.refreshAdventureCards();
    this.refreshBeginButton();
  }

  private selectAdventure(adv: AdventureDef): void {
    this.selectedAdventure = adv;
    for (const [id, elems] of this.advCards) {
      const active = id === adv.id;
      elems.cardBtn.el.style.borderColor = active ? "#e2b96f" : "#334455";
    }
    this.refreshBeginButton();
  }

  private buildBackButton(cx: number, cy: number): void {
    const w = 160;
    const h = 36;
    const btn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: cx - w / 2, y: cy - h / 2, w, h,
      label: "BACK",
      variant: "secondary",
      onClick: () => this.scene.start("MainMenuScene"),
    });
    this.htmlButtons.push(btn);
  }

  private buildBeginButton(cx: number, cy: number): void {
    const w = 240;
    const h = 44;
    this.beginBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: cx - w / 2, y: cy - h / 2, w, h,
      label: "BEGIN ADVENTURE",
      variant: "primary",
      fontSize: 14,
      onClick: () => this.beginAdventure(),
    });
    this.htmlButtons.push(this.beginBtn);
  }

  private refreshBeginButton(): void {
    const ready = !!(this.selectedPlayer && this.selectedAdventure);
    const save = this.selectedPlayer && this.selectedAdventure
      ? this.adventureSaves.get(this.selectedPlayer.id)
      : null;
    const continuing = !!save && save.adventureId === this.selectedAdventure?.id && save.completedChapterIds.length > 0;

    this.beginBtn.setLabel(continuing ? "CONTINUE ADVENTURE" : "BEGIN ADVENTURE");
    this.beginBtn.setDisabled(!ready);
  }

  private beginAdventure(): void {
    if (!this.selectedPlayer || !this.selectedAdventure) return;
    this.beginBtn.setDisabled(true);
    gameClient.startAdventure(this.selectedPlayer.id, this.selectedAdventure.id).then(({ state, playerDef }) => {
      // Use the server-returned PlayerDef so the HUD reflects the character's
      // current level (level-up history already replayed engine-side).
      this.scene.start("GameScene", { sessionId: state.sessionId, playerDef });
    }).catch((err: unknown) => {
      console.error("Failed to start adventure:", err);
      this.beginBtn.setDisabled(false);
    });
  }

  private teardown(): void {
    for (const t of this.htmlTexts) t.dispose();
    for (const b of this.htmlButtons) b.dispose();
    for (const c of this.advCards.values()) c.cardBtn.dispose();
    this.htmlTexts = [];
    this.htmlButtons = [];
    this.advCards.clear();
    this.characterCarousel?.destroy();
    this.characterCarousel = null;
    this.characterDetail?.destroy();
    this.characterDetail = null;
  }
}
