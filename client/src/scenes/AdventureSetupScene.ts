import Phaser from "phaser";
import { PlayerDef } from "../data/player";
import { ItemDef } from "../data/equipment";
import { gameClient } from "../net/GameClient";
import { fixedHpForClass } from "../../../shared/xpTable";
import type { GameState, AdventureDef, AdventureSave, EquipmentSlots, EncounterRecord, StorylogEntry } from "../net/types";
import { StorylogOverlay } from "../ui/StorylogOverlay";
import { tokenAssetForPlayer } from "../data/tokens";
import { createHtmlButton, createHtmlText, type HtmlButtonHandle, type HtmlTextHandle } from "../ui/htmlButtons";
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

const API_URL = "http://localhost:3000";

const CHAR_DIVIDER_X = 920;
const CHAR_CXS = [155, 460, 765];
const CHAR_CARD_W = 270;
const CHAR_CARD_H = 550;
const CARD_CY = Math.round(80 + (H - 80 - 100) / 2);

const ADV_CARD_CX = (CHAR_DIVIDER_X + W) / 2;
const ADV_CARD_W = W - CHAR_DIVIDER_X - 64;
const ADV_CARD_H = 180;
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
  /** Mirror of `CharSave.levelUps` — length tells us how many levels above 1 the character has reached. */
  levelUps?: unknown[];
}

interface CharCardElems {
  cardBtn: HtmlButtonHandle;
  subEl: HTMLDivElement;
  statsEl: HTMLDivElement;
  infoEl: HTMLDivElement;
  equippedEl: HTMLDivElement;
  deleteBtn: HtmlButtonHandle;
  storylogBtn: HtmlButtonHandle;
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

  private charCards = new Map<string, CharCardElems>();
  private advCards = new Map<string, AdvCardElems>();
  private htmlTexts: HtmlTextHandle[] = [];
  private htmlButtons: HtmlButtonHandle[] = [];
  private beginBtn!: HtmlButtonHandle;

  constructor() {
    super({ key: "AdventureSetupScene" });
  }

  init(): void {
    this.selectedPlayer = null;
    this.selectedAdventure = null;
    this.charCards.clear();
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
        try { this.charSaves.set(char.id, JSON.parse(raw) as LocalSave); } catch { /* ignore */ }
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

    this.characters.forEach((char, i) => {
      const cx = CHAR_CXS[i] ?? CHAR_CXS[CHAR_CXS.length - 1];
      this.buildCharCard(char, cx, CARD_CY);
    });

    this.adventures.forEach((adv, i) => {
      this.buildAdventureCard(adv, ADV_CARD_CX, ADV_FIRST_CY + i * (ADV_CARD_H + ADV_GAP));
    });

    this.buildBackButton(120, H - 36);
    this.buildBeginButton(W / 2, H - 36);
    this.refreshBeginButton();

    const lastId = localStorage.getItem(LAST_CHAR_KEY);
    if (lastId) {
      const def = this.characters.find((c) => c.id === lastId);
      if (def) this.selectChar(def);
    }

    for (const char of this.characters) {
      gameClient.loadAdventureSave(char.id).then((save) => {
        if (!this.scene.isActive()) return;
        if (save) {
          this.adventureSaves.set(char.id, save);
          this.refreshAdventureCards();
        }
      }).catch(() => {});

      // Refresh the character save too — picks up any level-ups that
      // happened in a prior session so the card shows the right level + HP.
      gameClient.loadSave(char.id).then((data) => {
        if (!this.scene.isActive() || !data) return;
        const save = data as LocalSave;
        localStorage.setItem(saveKey(char.id), JSON.stringify(save));
        this.charSaves.set(char.id, save);
        const elems = this.charCards.get(char.id);
        if (!elems) return;
        const effectiveLevel = char.level + (save.levelUps?.length ?? 0);
        const maxHp = effectiveMaxHp(char, save);
        const statMod = (v: number) => Math.floor((v - 10) / 2);
        const atkMod = char.mainAttack.statKey === "str" ? statMod(char.str) : statMod(char.dex);
        const atkBonus = atkMod + char.proficiencyBonus;
        const initMod = statMod(char.dex);
        elems.subEl.textContent = `${char.speciesName}  ${char.className} ${effectiveLevel}`;
        elems.statsEl.textContent = `HP ${maxHp}   AC ${char.ac}   Speed ${char.speed} ft\nAttack +${atkBonus}   Initiative ${initMod >= 0 ? "+" : ""}${initMod}`;
        elems.infoEl.textContent = this.saveInfoLine(save, char);
      }).catch(() => {});
    }

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.teardown());
    this.events.once(Phaser.Scenes.Events.DESTROY, () => this.teardown());
  }

  private buildCharCard(def: PlayerDef, cx: number, cy: number): void {
    const colorHex = "#" + def.color.toString(16).padStart(6, "0");
    const statMod = (v: number) => Math.floor((v - 10) / 2);
    const items = this.registry.get("equipment") as ItemDef[];
    const save = this.charSaves.get(def.id) ?? null;
    const atkMod = def.mainAttack.statKey === "str" ? statMod(def.str) : statMod(def.dex);
    const atkBonus = atkMod + def.proficiencyBonus;
    const initMod = statMod(def.dex);

    const left = cx - CHAR_CARD_W / 2;
    const top = cy - CHAR_CARD_H / 2;

    const cardBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: left, y: top, w: CHAR_CARD_W, h: CHAR_CARD_H,
      label: "", variant: "ghost",
      onClick: () => this.selectChar(def),
    });
    cardBtn.el.textContent = "";
    cardBtn.el.style.padding = "0";
    cardBtn.el.style.background = "#111122";
    cardBtn.el.style.borderColor = "#334455";
    cardBtn.el.style.borderWidth = "2px";
    cardBtn.el.style.display = "flex";
    cardBtn.el.style.flexDirection = "column";
    cardBtn.el.style.alignItems = "center";
    cardBtn.el.style.justifyContent = "flex-start";
    cardBtn.el.style.fontFamily = "monospace";
    cardBtn.el.style.whiteSpace = "normal";
    cardBtn.el.style.overflow = "hidden";

    // Layout: a top section (avatar / name / stats / description) that fills
    // the free vertical space, and a bottom section (info / equipped + the
    // two action buttons + SELECT footer) pinned to the bottom. Padding-bottom
    // reserves a fixed band for the action buttons so the inner text never
    // creeps under them.
    const BOTTOM_BAND = 130;

    const inner = document.createElement("div");
    inner.style.cssText = `
      display: flex; flex-direction: column; align-items: center;
      width: 100%; height: 100%; padding: 18px 14px ${BOTTOM_BAND}px; box-sizing: border-box;
      pointer-events: none;
    `;
    cardBtn.el.appendChild(inner);

    const avatar = document.createElement("img");
    avatar.src = `${API_URL}${tokenAssetForPlayer(def)}`;
    avatar.alt = def.name;
    avatar.style.cssText = "display: block; width: 64px; height: 64px;";
    inner.appendChild(avatar);

    const nameEl = document.createElement("div");
    nameEl.textContent = def.name;
    nameEl.style.cssText = "margin-top: 8px; font-size: 15px; color: #ffffff; text-align: center;";
    inner.appendChild(nameEl);

    const effectiveLevel = def.level + (save?.levelUps?.length ?? 0);
    const subEl = document.createElement("div");
    subEl.textContent = `${def.speciesName}  ${def.className} ${effectiveLevel}`;
    subEl.style.cssText = "margin-top: 6px; font-size: 11px; color: #8899aa; text-align: center;";
    inner.appendChild(subEl);

    const divider1 = document.createElement("div");
    divider1.style.cssText = "width: 88%; height: 1px; background: #334455; margin-top: 14px;";
    inner.appendChild(divider1);

    const maxHp = effectiveMaxHp(def, save);
    const statsEl = document.createElement("div");
    statsEl.textContent = `HP ${maxHp}   AC ${def.ac}   Speed ${def.speed} ft\nAttack +${atkBonus}   Initiative ${initMod >= 0 ? "+" : ""}${initMod}`;
    statsEl.style.cssText = "margin-top: 10px; width: 88%; font-size: 11px; color: #aabbcc; text-align: center; line-height: 1.7; white-space: pre-line;";
    inner.appendChild(statsEl);

    const divider2 = document.createElement("div");
    divider2.style.cssText = "width: 88%; height: 1px; background: #334455; margin-top: 8px;";
    inner.appendChild(divider2);

    const descEl = document.createElement("div");
    descEl.textContent = def.description ?? "";
    descEl.style.cssText = "margin-top: 10px; width: 88%; font-size: 11px; color: #99bbcc; text-align: center; line-height: 1.55; overflow: hidden;";
    inner.appendChild(descEl);

    const divider3 = document.createElement("div");
    divider3.style.cssText = "width: 88%; height: 1px; background: #223344; margin-top: auto;";
    inner.appendChild(divider3);

    const infoEl = document.createElement("div");
    infoEl.textContent = save ? this.saveInfoLine(save, def) : "No save data";
    infoEl.style.cssText = `margin-top: 8px; width: 88%; font-size: 10px; color: ${save ? "#aabbcc" : "#445566"}; text-align: center;`;
    inner.appendChild(infoEl);

    const equippedEl = document.createElement("div");
    equippedEl.textContent = save ? this.equippedLine(save, items) : "";
    equippedEl.style.cssText = "margin-top: 4px; width: 88%; font-size: 10px; color: #667788; text-align: center;";
    inner.appendChild(equippedEl);

    const selectFooter = document.createElement("div");
    selectFooter.textContent = "SELECT";
    selectFooter.style.cssText = `
      position: absolute; left: 0; right: 0; bottom: 14px;
      text-align: center; font-size: 13px; color: ${colorHex}; pointer-events: none;
      letter-spacing: 2px;
    `;
    cardBtn.el.style.position = "absolute";
    cardBtn.el.appendChild(selectFooter);

    const btnW = 130;
    const btnH = 22;
    const deleteX = cx - btnW / 2;
    const deleteY = top + CHAR_CARD_H - 80;
    const deleteBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: deleteX, y: deleteY, w: btnW, h: btnH,
      label: "DELETE SAVE",
      variant: "danger",
      fontSize: 10,
      onClick: () => this.deleteSaves(def),
    });
    deleteBtn.el.addEventListener("click", (e) => e.stopPropagation());

    const storylogY = deleteY + btnH + 7;
    const storylogBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: deleteX, y: storylogY, w: btnW, h: btnH,
      label: "STORY LOG",
      variant: "primary",
      fontSize: 10,
      onClick: () => this.openStorylogOverlay(def),
    });
    storylogBtn.el.addEventListener("click", (e) => e.stopPropagation());

    if (!save) {
      deleteBtn.setDisabled(true);
      storylogBtn.setDisabled(true);
    }

    this.charCards.set(def.id, { cardBtn, subEl, statsEl, infoEl, equippedEl, deleteBtn, storylogBtn });
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
    const elems = this.charCards.get(def.id);
    if (elems) {
      elems.infoEl.textContent = "No save data";
      elems.infoEl.style.color = "#445566";
      elems.equippedEl.textContent = "";
      elems.deleteBtn.setDisabled(true);
      elems.storylogBtn.setDisabled(true);
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
    return `HP ${save.hp}/${effectiveMaxHp(def, save)}  ·  ${save.xp} XP  ·  ${save.gold} GP`;
  }

  private equippedLine(save: LocalSave, items: ItemDef[]): string {
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    const weapon = save.equippedSlots?.weaponId ? byId[save.equippedSlots.weaponId]?.name : null;
    const armor  = save.equippedSlots?.armorId  ? byId[save.equippedSlots.armorId]?.name  : null;
    const shield = save.equippedSlots?.shieldId ? byId[save.equippedSlots.shieldId]?.name : null;
    return [weapon, armor, shield].filter(Boolean).join("  ·  ") || "—";
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
    for (const [id, elems] of this.charCards) {
      const active = id === def.id;
      elems.cardBtn.el.style.borderColor = active
        ? "#" + def.color.toString(16).padStart(6, "0")
        : "#334455";
    }
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
    for (const c of this.charCards.values()) {
      c.cardBtn.dispose();
      c.deleteBtn.dispose();
      c.storylogBtn.dispose();
    }
    for (const c of this.advCards.values()) c.cardBtn.dispose();
    this.htmlTexts = [];
    this.htmlButtons = [];
    this.charCards.clear();
    this.advCards.clear();
  }
}

/**
 * Derive the character's current max HP from the L1 starting value plus
 * recorded level-ups. Mirrors the SRD "Fixed Hit Points by Class" table the
 * server's `Leveling.ts` applies on commit.
 */
function effectiveMaxHp(def: PlayerDef, save: LocalSave | null): number {
  const levelsGained = save?.levelUps?.length ?? 0;
  if (levelsGained === 0) return def.maxHp;
  const conMod = Math.floor((def.con - 10) / 2);
  const perLevel = Math.max(1, fixedHpForClass(def.className) + conMod);
  return def.maxHp + levelsGained * perLevel;
}
