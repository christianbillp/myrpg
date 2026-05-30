import Phaser from "phaser";
import { PlayerDef } from "../data/player";
import { ItemDef } from "../data/equipment";
import { EncounterDef } from "../data/encounterContext";
import { SavedMapDef } from "../data/maps";
import { gameClient } from "../net/GameClient";
import type { GameState, EquipmentSlots, EncounterRecord, StorylogEntry } from "../net/types";
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

const ENC_CARD_W = 360;
const ENC_CARD_H = 155;
const ENC_COL1_CX = 1120;
const ENC_COL2_CX = 1500;


const LAST_CHAR_KEY = 'myrpg_last_character';
const saveKey = (id: string) => `myrpg_save_${id}`;

interface LocalSave {
  playerDefId: string;
  hp: number; xp: number;
  /** Coin purse balance in Copper Pieces — see `shared/currency.ts`. */
  balanceCp: number;
  inventoryIds: string[];
  resources?: Record<string, number>;
  equippedSlots?: EquipmentSlots;
  encounterLog?: EncounterRecord[];
  storylog?: StorylogEntry[];
  /** Mirror of `CharSave.levelUps` — length tells us how many levels above 1 the character has reached. */
  levelUps?: unknown[];
}

interface EncCardElems {
  cardBtn: HtmlButtonHandle;
}

export class EncounterSetupScene extends Phaser.Scene {
  private selectedPlayer: PlayerDef | null = null;
  private selectedEncounter: EncounterDef | null = null;

  private encounterCards: Map<string, EncCardElems> = new Map();
  private htmlTexts: HtmlTextHandle[] = [];
  private htmlButtons: HtmlButtonHandle[] = [];
  private beginBtn!: HtmlButtonHandle;
  private promoteBtn!: HtmlButtonHandle;
  private characterCarousel: CharacterCarousel | null = null;
  private characterDetail: CharacterDetail | null = null;

  private characters: PlayerDef[] = [];
  private encounters: EncounterDef[] = [];
  private allSaves: Map<string, LocalSave> = new Map();
  private selectedSave: LocalSave | null = null;

  constructor() {
    super({ key: "EncounterSetupScene" });
  }

  /** Optional encounter id to pre-select on create. Set by MapEditorScene
   * after a fresh encounter has been authored so the player lands on the
   * character-pick screen with that encounter already highlighted. */
  private pendingEncounterId: string | null = null;

  init(data?: { presetEncounterId?: string }): void {
    this.selectedPlayer = null;
    this.selectedEncounter = null;
    this.selectedSave = null;
    this.allSaves.clear();
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
        try {
          const parsed = JSON.parse(raw) as LocalSave & { gold?: number };
          // One-time migration: pre-currency saves stored `gold` (whole GP).
          // Convert to CP and drop the legacy field.
          if (parsed.balanceCp == null && typeof parsed.gold === "number") {
            parsed.balanceCp = parsed.gold * 100;
            delete parsed.gold;
            localStorage.setItem(saveKey(char.id), JSON.stringify(parsed));
          }
          this.allSaves.set(char.id, parsed);
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

    // ── Character column: carousel up top, full sheet below ────────────
    // Carousel sits centered horizontally in the character column. The
    // detail panel fills the remaining vertical space beneath it. Both
    // components self-position via the scale-tracking attachPlace pattern.
    const CHAR_COL_X = 24;
    const CHAR_COL_W = CHAR_DIVIDER_X - CHAR_COL_X - 24;
    const CAROUSEL_Y = 100;
    const CAROUSEL_H = 240;
    const DETAIL_Y = CAROUSEL_Y + CAROUSEL_H + 12;
    const DETAIL_H = H - 100 - DETAIL_Y;  // 100px reserved for the bottom button band
    const items = this.registry.get("equipment") as ItemDef[];
    const spells = this.registry.get("spells") as import("../net/types").SpellDef[];
    this.characterDetail = new CharacterDetail({
      scene: this, sceneWidth: W,
      x: CHAR_COL_X, y: DETAIL_Y, width: CHAR_COL_W, height: DETAIL_H,
      equipment: items ?? [],
      spells: spells ?? [],
      callbacks: {
        onDeleteSave: (def) => {
          localStorage.removeItem(saveKey(def.id));
          this.allSaves.delete(def.id);
          if (this.selectedPlayer?.id === def.id) this.selectedSave = null;
          gameClient.deleteSave(def.id).catch(() => {});
          this.characterDetail?.setSave(null);
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
    if (lastId) this.characterCarousel?.setSelectedId(lastId);

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
        // Detail panel + cached selection state refresh only when the save
        // we just received belongs to the character on display.
        if (this.selectedPlayer?.id === char.id) {
          this.selectedSave = save;
          this.characterDetail?.setSave(save);
        }
      }).catch(() => {});
    }

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.teardown());
    this.events.once(Phaser.Scenes.Events.DESTROY, () => this.teardown());
  }

  /** Server reports no save for this character — purge the stale local mirror. */
  private clearStaleLocalSave(def: PlayerDef): void {
    localStorage.removeItem(saveKey(def.id));
    this.allSaves.delete(def.id);
    if (this.selectedPlayer?.id === def.id) {
      this.selectedSave = null;
      this.characterDetail?.setSave(null);
    }
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
    this.selectedPlayer = def;
    this.selectedSave = this.allSaves.get(def.id) ?? null;
    localStorage.setItem(LAST_CHAR_KEY, def.id);
    this.characterDetail?.setCharacter(def);
    this.characterDetail?.setSave(this.selectedSave);
    this.refreshBeginButton();
    this.refreshPromoteButton();
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
          allowsLongRest: enc.allowsLongRest,
          completionFlag: enc.completionFlag,
          tileProperties: enc.tileProperties,
          startingZones: enc.startingZones,
          placementMode: enc.placementMode,
          placements: enc.placements,
          triggers: enc.triggers,
          resumeHp:            save?.hp,
          resumeXp:            save?.xp,
          resumeCp:            save?.balanceCp,
          resumeInventoryIds:  save?.inventoryIds,
          resumeEquippedSlots: save?.equippedSlots,
          resumeResources:     save?.resources,
        }).then(({ state, playerDef }) => {
          // Use the server-returned PlayerDef rather than the registry's L1
          // copy — it already has the character's level-up history applied.
          this.scene.start("GameScene", { sessionId: state.sessionId, playerDef });
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
    for (const c of this.encounterCards.values()) c.cardBtn.dispose();
    this.htmlTexts = [];
    this.htmlButtons = [];
    this.encounterCards.clear();
    this.characterCarousel?.destroy();
    this.characterCarousel = null;
    this.characterDetail?.destroy();
    this.characterDetail = null;
  }
}

