import Phaser from "phaser";
import { PlayerDef } from "../data/player";
import { ItemDef } from "../data/equipment";
import { EncounterDef } from "../data/encounterContext";
import { SavedMapDef } from "../data/maps";
import { gameClient } from "../net/GameClient";
import type { GameState, EquipmentSlots, EncounterRecord, StorylogEntry } from "../net/types";
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
const CHAR1_CX = 155;
const CHAR2_CX = 460;
const CHAR3_CX = 765;
const CHAR_CXS = [CHAR1_CX, CHAR2_CX, CHAR3_CX];
const CHAR_CARD_W = 270;
const CHAR_CARD_H = 550;
const CONTENT_CY = Math.round(80 + (H - 80 - 100) / 2);

const ENC_CARD_W = 360;
const ENC_CARD_H = 155;
const ENC_COL1_CX = 1120;
const ENC_COL2_CX = 1500;


const LAST_CHAR_KEY = 'myrpg_last_character';
const saveKey = (id: string) => `myrpg_save_${id}`;

interface LocalSave {
  playerDefId: string;
  hp: number; xp: number; gold: number;
  inventoryIds: string[];
  resources?: Record<string, number>;
  equippedSlots?: EquipmentSlots;
  encounterLog?: EncounterRecord[];
  storylog?: StorylogEntry[];
}

interface CharCardElems {
  cardBtn: HtmlButtonHandle;
  infoEl: HTMLDivElement;
  equippedEl: HTMLDivElement;
  deleteBtn: HtmlButtonHandle;
  storylogBtn: HtmlButtonHandle;
}

interface EncCardElems {
  cardBtn: HtmlButtonHandle;
}

export class EncounterSetupScene extends Phaser.Scene {
  private selectedPlayer: PlayerDef | null = null;
  private selectedEncounter: EncounterDef | null = null;

  private charCards: Map<string, CharCardElems> = new Map();
  private encounterCards: Map<string, EncCardElems> = new Map();
  private htmlTexts: HtmlTextHandle[] = [];
  private htmlButtons: HtmlButtonHandle[] = [];
  private beginBtn!: HtmlButtonHandle;
  private promoteBtn!: HtmlButtonHandle;

  private characters: PlayerDef[] = [];
  private encounters: EncounterDef[] = [];
  private allSaves: Map<string, LocalSave> = new Map();
  private selectedSave: LocalSave | null = null;

  constructor() {
    super({ key: "EncounterSetupScene" });
  }

  /** Optional encounter id to pre-select on create. Set by GenerateSetupScene
   * after a fresh encounter has been authored so the player lands on the
   * character-pick screen with that encounter already highlighted. */
  private pendingEncounterId: string | null = null;

  init(data?: { presetEncounterId?: string }): void {
    this.selectedPlayer = null;
    this.selectedEncounter = null;
    this.selectedSave = null;
    this.allSaves.clear();
    this.charCards.clear();
    this.encounterCards.clear();
    this.pendingEncounterId = data?.presetEncounterId ?? null;
  }

  create(): void {
    this.characters = this.registry.get("characters") as PlayerDef[];
    this.encounters = this.registry.get("encounters") as EncounterDef[];

    if (this.pendingEncounterId && !this.encounters.find((e) => e.id === this.pendingEncounterId)) {
      Promise.all([gameClient.listEncounters(), gameClient.listMaps()]).then(([encs, maps]) => {
        if (!this.scene.isActive()) return;
        this.registry.set("encounters", encs as EncounterDef[]);
        this.registry.set("maps", maps as SavedMapDef[]);
        this.scene.restart({ presetEncounterId: this.pendingEncounterId });
      }).catch(() => { /* fall through to render existing list */ });
    }

    for (const char of this.characters) {
      const raw = localStorage.getItem(saveKey(char.id));
      if (raw) {
        try { this.allSaves.set(char.id, JSON.parse(raw) as LocalSave); } catch { /* ignore */ }
      }
    }

    this.add.rectangle(W / 2, H / 2, W, H, 0x0d0d1e);
    this.add.rectangle(W / 2, 66, W - 64, 1, 0x334455);
    this.add.rectangle(CHAR_DIVIDER_X, H / 2, 1, H - 140, 0x334455).setOrigin(0.5, 0.5);
    this.add.rectangle(W / 2, H - 58, W - 64, 1, 0x334455);

    this.htmlTexts.push(createHtmlText({
      scene: this, sceneWidth: W,
      x: 0, y: 22, w: W, h: 28,
      text: "ENCOUNTER SETUP",
      fontSize: 22, color: "#e2b96f", align: "center",
      letterSpacing: 1,
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
      text: "ENCOUNTER",
      fontSize: 11, color: "#556677", align: "center", letterSpacing: 2,
    }));

    this.characters.forEach((char, i) => {
      const cx = CHAR_CXS[i] ?? CHAR_CXS[CHAR_CXS.length - 1];
      this.buildCharCard(char, cx, CONTENT_CY);
    });

    const encPositions: [number, number][] = [
      [ENC_COL1_CX, 211], [ENC_COL2_CX, 211],
      [ENC_COL1_CX, 380], [ENC_COL2_CX, 380],
      [ENC_COL1_CX, 549], [ENC_COL2_CX, 549],
      [ENC_COL1_CX, 718], [ENC_COL2_CX, 718],
    ];
    this.encounters.forEach((enc, i) => {
      const [cx, cy] = encPositions[i] ?? [ENC_COL1_CX, 216 + i * 161];
      this.buildEncounterCard(enc, cx, cy);
    });

    this.buildBackButton(120, H - 36);
    this.buildBeginButton(W / 2, H - 36);
    this.buildPromoteButton(W - 200, H - 36);
    this.refreshBeginButton();
    this.refreshPromoteButton();

    const lastId = localStorage.getItem(LAST_CHAR_KEY);
    if (lastId) {
      const def = this.characters.find((c) => c.id === lastId);
      if (def) this.selectChar(def);
    }

    if (this.pendingEncounterId) {
      const enc = this.encounters.find((e) => e.id === this.pendingEncounterId);
      if (enc) this.selectEncounter(enc);
    }

    for (const char of this.characters) {
      gameClient.loadSave(char.id).then((data) => {
        if (!this.scene.isActive()) return;
        if (!data) {
          this.clearStaleLocalSave(char);
          return;
        }
        const save = data as LocalSave;
        localStorage.setItem(saveKey(char.id), JSON.stringify(save));
        this.allSaves.set(char.id, save);
        this.updateSaveDisplay(char, save);
      }).catch(() => {});
    }

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.teardown());
    this.events.once(Phaser.Scenes.Events.DESTROY, () => this.teardown());
  }

  /** Server reports no save for this character — purge the stale local mirror. */
  private clearStaleLocalSave(def: PlayerDef): void {
    localStorage.removeItem(saveKey(def.id));
    this.allSaves.delete(def.id);
    if (this.selectedPlayer?.id === def.id) this.selectedSave = null;
    const elems = this.charCards.get(def.id);
    if (!elems) return;
    elems.infoEl.textContent = "No save data";
    elems.infoEl.style.color = "#445566";
    elems.equippedEl.textContent = "";
    elems.deleteBtn.setDisabled(true);
    elems.storylogBtn.setDisabled(true);
  }

  private updateSaveDisplay(def: PlayerDef, save: LocalSave): void {
    const elems = this.charCards.get(def.id);
    if (!elems) return;
    const items = this.registry.get("equipment") as ItemDef[];
    elems.infoEl.textContent = this.saveInfoLine(save, def);
    elems.infoEl.style.color = "#aabbcc";
    elems.equippedEl.textContent = this.equippedLine(save, items);
    elems.deleteBtn.setDisabled(false);
    elems.storylogBtn.setDisabled(false);
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

  private buildCharCard(def: PlayerDef, cx: number, cy: number): void {
    const colorHex = "#" + def.color.toString(16).padStart(6, "0");
    const statMod = (v: number) => Math.floor((v - 10) / 2);
    const items = this.registry.get("equipment") as ItemDef[];
    const save = this.allSaves.get(def.id) ?? null;
    const atkMod = def.mainAttack.statKey === "str" ? statMod(def.str) : statMod(def.dex);
    const atkBonus = atkMod + def.proficiencyBonus;
    const initMod = statMod(def.dex);

    const left = cx - CHAR_CARD_W / 2;
    const top = cy - CHAR_CARD_H / 2;

    // The card itself is a clickable ghost button — we replace its inner DOM
    // with structured content (avatar, name, stats, save block, two child
    // buttons). The two child buttons are sibling HTML buttons absolutely-
    // positioned over the card so their click handlers don't fire the card.
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
    cardBtn.el.style.color = "#aabbcc";
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

    // Avatar (SVG token loaded straight from the API).
    const avatar = document.createElement("img");
    avatar.src = `${API_URL}${tokenAssetForPlayer(def)}`;
    avatar.alt = def.name;
    avatar.style.cssText = "display: block; width: 64px; height: 64px;";
    inner.appendChild(avatar);

    const nameEl = document.createElement("div");
    nameEl.textContent = def.name;
    nameEl.style.cssText = "margin-top: 8px; font-size: 15px; color: #ffffff; text-align: center;";
    inner.appendChild(nameEl);

    const subEl = document.createElement("div");
    subEl.textContent = `${def.speciesName}  ${def.className} ${def.level}`;
    subEl.style.cssText = "margin-top: 6px; font-size: 11px; color: #8899aa; text-align: center;";
    inner.appendChild(subEl);

    const divider1 = document.createElement("div");
    divider1.style.cssText = "width: 88%; height: 1px; background: #334455; margin-top: 14px;";
    inner.appendChild(divider1);

    const statsEl = document.createElement("div");
    statsEl.textContent = `HP ${def.maxHp}   AC ${def.ac}   Speed ${def.speed} ft\nAttack +${atkBonus}   Initiative ${initMod >= 0 ? "+" : ""}${initMod}`;
    statsEl.style.cssText = "margin-top: 10px; width: 88%; font-size: 11px; color: #aabbcc; text-align: center; line-height: 1.7; white-space: pre-line;";
    inner.appendChild(statsEl);

    const divider2 = document.createElement("div");
    divider2.style.cssText = "width: 88%; height: 1px; background: #334455; margin-top: 8px;";
    inner.appendChild(divider2);

    const descEl = document.createElement("div");
    descEl.textContent = def.description ?? "";
    descEl.style.cssText = "margin-top: 10px; width: 88%; font-size: 11px; color: #99bbcc; text-align: center; line-height: 1.55; overflow: hidden;";
    inner.appendChild(descEl);

    // Bottom info/equipped section pinned just above the reserved button band.
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

    // The two action buttons. They sit just above the SELECT footer inside
    // the reserved bottom band and need to absorb their own clicks so the
    // card click handler doesn't also fire.
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
      onClick: () => {
        localStorage.removeItem(saveKey(def.id));
        this.allSaves.delete(def.id);
        if (this.selectedPlayer?.id === def.id) this.selectedSave = null;
        gameClient.deleteSave(def.id).catch(() => {});
        const cur = this.charCards.get(def.id);
        if (cur) {
          cur.infoEl.textContent = "No save data";
          cur.infoEl.style.color = "#445566";
          cur.equippedEl.textContent = "";
          cur.deleteBtn.setDisabled(true);
          cur.storylogBtn.setDisabled(true);
        }
      },
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

    this.charCards.set(def.id, { cardBtn, infoEl, equippedEl, deleteBtn, storylogBtn });
  }

  private openStorylogOverlay(def: PlayerDef): void {
    const save = this.allSaves.get(def.id);
    if (!save) return;
    const handleUpdated = (updated: StorylogEntry[]) => {
      save.storylog = updated;
      this.allSaves.set(def.id, save);
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

  private selectChar(def: PlayerDef): void {
    for (const [id, elems] of this.charCards) {
      const active = id === def.id;
      elems.cardBtn.el.style.borderColor = active
        ? "#" + def.color.toString(16).padStart(6, "0")
        : "#334455";
    }
    this.selectedPlayer = def;
    this.selectedSave = this.allSaves.get(def.id) ?? null;
    localStorage.setItem(LAST_CHAR_KEY, def.id);
    this.refreshBeginButton();
  }

  private buildEncounterCard(def: EncounterDef, cx: number, cy: number): void {
    const left = cx - ENC_CARD_W / 2;
    const top = cy - ENC_CARD_H / 2;

    const cardBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: left, y: top, w: ENC_CARD_W, h: ENC_CARD_H,
      label: "", variant: "ghost",
      onClick: () => this.selectEncounter(def),
    });
    cardBtn.el.textContent = "";
    cardBtn.el.style.padding = "0";
    cardBtn.el.style.background = "#111122";
    cardBtn.el.style.borderColor = "#334455";
    cardBtn.el.style.whiteSpace = "normal";
    cardBtn.el.style.overflow = "hidden";

    const inner = document.createElement("div");
    inner.style.cssText = `
      position: relative; display: flex; flex-direction: column;
      width: 100%; height: 100%; padding: 10px 14px; box-sizing: border-box;
      font-family: monospace; color: #aabbcc; pointer-events: none;
    `;
    cardBtn.el.appendChild(inner);

    const mapTag = document.createElement("div");
    mapTag.textContent = def.mapId.toUpperCase();
    mapTag.style.cssText = "font-size: 9px; color: #445566; letter-spacing: 1px;";
    inner.appendChild(mapTag);

    if ((def as { generated?: boolean }).generated) {
      const tag = document.createElement("div");
      tag.textContent = "✦ GENERATED";
      tag.style.cssText = "position: absolute; right: 14px; top: 10px; font-size: 9px; color: #88ccaa; letter-spacing: 1px;";
      inner.appendChild(tag);
    }

    const title = document.createElement("div");
    title.textContent = def.encounterTitle;
    title.style.cssText = "margin-top: 6px; text-align: center; font-size: 14px; color: #e8e8f8;";
    inner.appendChild(title);

    const desc = document.createElement("div");
    desc.textContent = def.description;
    desc.style.cssText = "margin-top: 10px; font-size: 10px; color: #8899aa; line-height: 1.5;";
    inner.appendChild(desc);

    this.encounterCards.set(def.id, { cardBtn });
  }

  private selectEncounter(def: EncounterDef): void {
    for (const [id, elems] of this.encounterCards) {
      const active = id === def.id;
      elems.cardBtn.el.style.borderColor = active ? "#e2b96f" : "#334455";
    }
    this.selectedEncounter = def;
    this.refreshBeginButton();
    this.refreshPromoteButton();
  }

  private isReady(): boolean {
    return this.selectedPlayer !== null && this.selectedEncounter !== null;
  }

  private refreshBeginButton(): void {
    this.beginBtn.setDisabled(!this.isReady());
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
    const w = 260;
    const h = 36;
    this.beginBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: cx - w / 2, y: cy - h / 2, w, h,
      label: "BEGIN ENCOUNTER",
      variant: "primary",
      fontSize: 14,
      onClick: () => {
        if (!this.isReady()) return;
        this.beginBtn.setDisabled(true);

        const enc = this.selectedEncounter!;
        const player = this.selectedPlayer!;
        const maps = this.registry.get("maps") as SavedMapDef[];
        const savedMap = maps.find((m) => m.id === enc.mapId);
        const save = this.selectedSave;

        gameClient.createSession({
          mapType: "saved",
          playerDefId: player.id,
          savedMapId: enc.mapId,
          encounterTitle: enc.encounterTitle,
          savedMapName: savedMap?.name,
          savedMapDescription: savedMap?.mapdescription,
          npcIds: enc.npcIds,
          allyIds: enc.allyIds,
          enemyIds: enc.enemyIds,
          customIntroduction: enc.customIntroduction,
          customContext: enc.customContext,
          customObjective: enc.objective,
          tileProperties: enc.tileProperties,
          startingZones: enc.startingZones,
          triggers: enc.triggers,
          resumeHp:            save?.hp,
          resumeXp:            save?.xp,
          resumeGold:          save?.gold,
          resumeInventoryIds:  save?.inventoryIds,
          resumeEquippedSlots: save?.equippedSlots,
          resumeResources:     save?.resources,
        }).then((initialState: GameState) => {
          this.scene.start("GameScene", { sessionId: initialState.sessionId, playerDef: player });
        }).catch((err: unknown) => {
          console.error('Failed to create session:', err);
          this.beginBtn.setDisabled(false);
        });
      },
    });
    this.htmlButtons.push(this.beginBtn);
  }

  /**
   * SAVE AS PREMADE — only enabled when the currently selected encounter
   * carries the `generated` flag. Strips the `gen_*` namespace from the
   * encounter (and, when reachable, its map) so the encounter is no longer
   * subject to the "Delete all generated maps" dev cleanup.
   */
  private buildPromoteButton(cx: number, cy: number): void {
    const w = 200;
    const h = 36;
    this.promoteBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: cx - w / 2, y: cy - h / 2, w, h,
      label: "SAVE AS PREMADE",
      variant: "warn",
      fontSize: 13,
      onClick: async () => {
        const enc = this.selectedEncounter as (EncounterDef & { generated?: boolean }) | null;
        if (!enc?.generated) return;
        this.promoteBtn.setDisabled(true);
        this.promoteBtn.setLabel("SAVING…");
        try {
          const { encounterId } = await gameClient.promoteEncounter(enc.id);
          const fresh = await gameClient.listEncounters();
          this.registry.set("encounters", fresh);
          this.scene.restart({ presetEncounterId: encounterId });
        } catch (err) {
          console.error("[promote encounter] failed", err);
          this.promoteBtn.setLabel("SAVE AS PREMADE");
          this.promoteBtn.setDisabled(false);
        }
      },
    });
    this.htmlButtons.push(this.promoteBtn);
  }

  private refreshPromoteButton(): void {
    const enc = this.selectedEncounter as (EncounterDef & { generated?: boolean }) | null;
    this.promoteBtn.setDisabled(!enc?.generated);
  }

  private teardown(): void {
    for (const t of this.htmlTexts) t.dispose();
    for (const b of this.htmlButtons) b.dispose();
    for (const c of this.charCards.values()) {
      c.cardBtn.dispose();
      c.deleteBtn.dispose();
      c.storylogBtn.dispose();
    }
    for (const c of this.encounterCards.values()) c.cardBtn.dispose();
    this.htmlTexts = [];
    this.htmlButtons = [];
    this.charCards.clear();
    this.encounterCards.clear();
  }
}
