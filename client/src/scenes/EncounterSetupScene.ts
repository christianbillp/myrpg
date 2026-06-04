import Phaser from "phaser";
import { PlayerDef } from "../../../shared/types";
import { ItemDef } from "../../../shared/types";
import { EncounterDef } from "../../../shared/types";
import type { AdventureDef } from "../../../shared/types";
import { SavedMapDef } from "../../../shared/types";
import { gameClient } from "../net/GameClient";
import type { GameState, EquipmentSlots, EncounterRecord, StorylogEntry } from "../../../shared/types";
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
/** Vertical centre of the first row of cards. */
const ENC_ROW_FIRST_CY = 211;
/** Vertical spacing between successive row centres. */
const ENC_ROW_SPACING = 169;
/** Visible band: top + bottom Y bounds (scene-space) the scroller clamps
 *  card positions into. Anything fully outside this rect is hidden so it
 *  doesn't bleed into the bottom-bar or character column. */
const ENC_VIEWPORT_TOP = ENC_ROW_FIRST_CY - ENC_CARD_H / 2 - 4;
const ENC_VIEWPORT_BOTTOM = 808;
/** Top of the scrollable content band (cards + section headers are laid out in
 *  content-space y, measured from here, then shifted by the scroll offset). */
const ENC_CONTENT_TOP = ENC_VIEWPORT_TOP + 4;
/** Section-header band height + the gaps framing it. */
const ENC_HEADER_H = 22;
const ENC_GAP_ABOVE_HEADER = 16;   // breathing room before a section (not the first)
const ENC_GAP_BELOW_HEADER = 8;    // header → its first card row
/** Vertical gap between successive card rows (keeps the old 169px row stride). */
const ENC_CARD_VGAP = ENC_ROW_SPACING - ENC_CARD_H;


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
  /** Encounter id this card represents. NOT unique across the list — the same
   *  encounter appears once per adventure that contains it, so selection
   *  highlights every card sharing this id. */
  defId: string;
  /** Content-space y (top edge) at scroll offset 0. `applyEncScrollOffset`
   *  subtracts the scroll offset to get the on-screen position. */
  top: number;
  /** Column x — kept verbatim because the columns don't move on scroll. */
  cx: number;
}

interface EncHeaderElems {
  handle: HtmlTextHandle;
  /** Content-space y (top edge) at scroll offset 0. */
  top: number;
}

export class EncounterSetupScene extends Phaser.Scene {
  private selectedPlayer: PlayerDef | null = null;
  private selectedEncounter: EncounterDef | null = null;

  /** All rendered encounter cards in layout order. An array (not a Map keyed by
   *  id) because the same encounter is shown once per adventure it belongs to. */
  private encCards: EncCardElems[] = [];
  /** Section-header labels (GENERATED / each adventure / OTHER), scrolled with the cards. */
  private encHeaders: EncHeaderElems[] = [];
  /** Total content height of the laid-out sections — drives the scroll range. */
  private encContentHeight = 0;
  private htmlTexts: HtmlTextHandle[] = [];
  private htmlButtons: HtmlButtonHandle[] = [];
  private beginBtn!: HtmlButtonHandle;
  private promoteBtn!: HtmlButtonHandle;
  private characterCarousel: CharacterCarousel | null = null;
  private characterDetail: CharacterDetail | null = null;

  private characters: PlayerDef[] = [];
  private encounters: EncounterDef[] = [];
  private adventures: AdventureDef[] = [];
  private allSaves: Map<string, LocalSave> = new Map();
  private selectedSave: LocalSave | null = null;
  /** Vertical scroll offset (in scene-space pixels) applied to every
   *  encounter card. Zero shows the first 8 cards; positive values shift
   *  cards upward to reveal lower rows. Clamped in `setEncScrollOffset`. */
  private encScrollOffset = 0;
  /** Optional scrollbar — visible only when the roster exceeds the viewport.
   *  Updated whenever the offset changes. */
  private encScrollbarTrack: Phaser.GameObjects.Rectangle | null = null;
  private encScrollbarThumb: Phaser.GameObjects.Rectangle | null = null;

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
    this.encCards = [];
    this.encHeaders = [];
    this.pendingEncounterId = data?.presetEncounterId ?? null;
  }

  create(): void {
    this.characters = this.registry.get("characters") as PlayerDef[];
    this.encounters = this.registry.get("encounters") as EncounterDef[];
    this.adventures = (this.registry.get("adventures") as AdventureDef[]) ?? [];

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
    const spells = this.registry.get("spells") as import("../../../shared/types").SpellDef[];
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
    // Map each character to its effective (leveled) level so the carousel
    // can display the actual playable level rather than the source JSON's
    // L1. The detail panel already does this server-side via the save
    // payload; the carousel needs the same projection.
    const effectiveLevels = new Map<string, number>();
    for (const c of this.characters) {
      const save = this.allSaves.get(c.id);
      effectiveLevels.set(c.id, c.level + (save?.levelUps?.length ?? 0));
    }
    this.characterCarousel = new CharacterCarousel({
      scene: this, sceneWidth: W,
      x: CHAR_COL_X, y: CAROUSEL_Y, width: CHAR_COL_W, height: CAROUSEL_H,
      characters: this.characters,
      effectiveLevels,
      onChange: (def) => this.selectChar(def),
    });

    // Encounters are grouped into sections — GENERATED first, then one per
    // adventure, then OTHER (authored encounters in no adventure). Within each
    // section the cards fill a 2-column grid; surplus content scrolls into view
    // via the wheel handler installed by `installEncScroll`.
    this.encScrollOffset = 0;
    this.buildEncounterSections();
    this.installEncScroll();
    this.applyEncScrollOffset();

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
        // The carousel's subtitle (`Wizard 4`) needs to stay in sync with
        // the detail panel — push the just-arrived level-up count into the
        // carousel so its subtitle reflects the leveled total even on a
        // fresh browser with no cached save.
        this.characterCarousel?.setEffectiveLevel(char.id, char.level + (save.levelUps?.length ?? 0));
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

  /** Group the encounters into sections and lay them out top-to-bottom:
   *  GENERATED, then one section per adventure (in load order), then OTHER for
   *  any authored encounter that belongs to no adventure. An encounter that
   *  appears in two adventures is rendered in each. */
  private buildEncounterSections(): void {
    const sections = this.computeEncounterSections();
    let y = 0;
    sections.forEach((section, sIdx) => {
      if (sIdx > 0) y += ENC_GAP_ABOVE_HEADER;
      this.buildSectionHeader(section.label, y);
      y += ENC_HEADER_H + ENC_GAP_BELOW_HEADER;
      section.encounters.forEach((def, i) => {
        const cx = i % 2 === 0 ? ENC_COL1_CX : ENC_COL2_CX;
        const top = y + Math.floor(i / 2) * (ENC_CARD_H + ENC_CARD_VGAP);
        this.buildEncounterCard(def, top, cx);
      });
      y += Math.ceil(section.encounters.length / 2) * (ENC_CARD_H + ENC_CARD_VGAP);
    });
    this.encContentHeight = y;
  }

  /** Build the ordered section list. GENERATED first; then each adventure's
   *  encounters (chapters in order, plus its rest encounter), deduped within
   *  the adventure but NOT across adventures; then OTHER for whatever authored
   *  encounter no adventure claimed. Empty sections are dropped. */
  private computeEncounterSections(): { label: string; encounters: EncounterDef[] }[] {
    const byId = new Map(this.encounters.map((e) => [e.id, e]));
    const sections: { label: string; encounters: EncounterDef[] }[] = [];
    const claimed = new Set<string>();

    const generated = this.encounters.filter((e) => (e as { generated?: boolean }).generated);
    if (generated.length > 0) {
      sections.push({ label: "Generated", encounters: generated });
      for (const e of generated) claimed.add(e.id);
    }

    for (const adv of this.adventures) {
      const seen = new Set<string>();
      const encs: EncounterDef[] = [];
      const add = (id: string | undefined): void => {
        if (!id || seen.has(id)) return;
        const def = byId.get(id);
        if (!def) return;
        seen.add(id);
        encs.push(def);
      };
      for (const ch of adv.chapters ?? []) add(ch.encounterId);
      add(adv.restEncounterId);
      if (encs.length === 0) continue;
      for (const e of encs) claimed.add(e.id);
      sections.push({ label: adv.title, encounters: encs });
    }

    const other = this.encounters.filter((e) => !claimed.has(e.id));
    if (other.length > 0) sections.push({ label: "Other", encounters: other });

    return sections;
  }

  /** A section header spanning both card columns, scrolled with the cards. */
  private buildSectionHeader(label: string, top: number): void {
    const left = ENC_COL1_CX - ENC_CARD_W / 2;
    const width = (ENC_COL2_CX + ENC_CARD_W / 2) - left;
    const handle = createHtmlText({
      scene: this, sceneWidth: W,
      x: left, y: ENC_CONTENT_TOP + top, w: width, h: ENC_HEADER_H,
      text: label.toUpperCase(),
      fontSize: 12, color: "#e2b96f", align: "left", letterSpacing: 2,
    });
    this.encHeaders.push({ handle, top });
  }

  private buildEncounterCard(def: EncounterDef, top: number, cx: number): void {
    const left = cx - ENC_CARD_W / 2;
    const topPx = ENC_CONTENT_TOP + top;

    const cardBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: left, y: topPx, w: ENC_CARD_W, h: ENC_CARD_H,
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

    this.encCards.push({ cardBtn, defId: def.id, top, cx });
  }

  // ── Scrolling ──────────────────────────────────────────────────────────

  /** Height of the visible content band (where cards + headers are shown). */
  private encViewportHeight(): number {
    return ENC_VIEWPORT_BOTTOM - ENC_CONTENT_TOP;
  }

  /** Maximum vertical scroll, in scene-space pixels. Zero when all sections
   *  fit in the viewport. */
  private encMaxScroll(): number {
    return Math.max(0, this.encContentHeight - this.encViewportHeight());
  }

  /** Install a Phaser wheel listener and the visual scrollbar. Wheel
   *  events only steer the encounter offset while the pointer is over the
   *  encounter column (right of the character/encounter divider). */
  private installEncScroll(): void {
    const max = this.encMaxScroll();
    if (max <= 0) return; // grid fits — no scroll, no scrollbar

    // Discrete scrollbar so the user knows scrolling is possible. Lives
    // along the right edge of the right column.
    const trackX = W - 28;
    const trackY = ENC_VIEWPORT_TOP;
    const trackH = ENC_VIEWPORT_BOTTOM - ENC_VIEWPORT_TOP;
    this.encScrollbarTrack = this.add.rectangle(trackX, trackY, 6, trackH, 0x1a2230, 1)
      .setOrigin(0.5, 0);
    this.encScrollbarThumb = this.add.rectangle(trackX, trackY, 6, trackH, 0x4a6a9a, 1)
      .setOrigin(0.5, 0);

    this.input.on("wheel", (pointer: Phaser.Input.Pointer, _g: Phaser.GameObjects.GameObject[], _dx: number, dy: number) => {
      // Only react when the pointer is over the encounter column — otherwise
      // wheel events on the character carousel would steer this scroller.
      const sx = pointer.x;
      const sy = pointer.y;
      if (sx < CHAR_DIVIDER_X) return;
      if (sy < ENC_VIEWPORT_TOP || sy > ENC_VIEWPORT_BOTTOM) return;
      this.setEncScrollOffset(this.encScrollOffset + Math.sign(dy) * (ENC_ROW_SPACING / 2));
    });
  }

  private setEncScrollOffset(value: number): void {
    const max = this.encMaxScroll();
    const clamped = Math.max(0, Math.min(max, value));
    if (clamped === this.encScrollOffset) return;
    this.encScrollOffset = clamped;
    this.applyEncScrollOffset();
  }

  /** Re-place every encounter card + section header based on the current
   *  scroll offset and hide anything fully outside the visible band. Also
   *  positions the scrollbar thumb. */
  private applyEncScrollOffset(): void {
    for (const elems of this.encCards) {
      const top = ENC_CONTENT_TOP + elems.top - this.encScrollOffset;
      const left = elems.cx - ENC_CARD_W / 2;
      const offscreen = top + ENC_CARD_H < ENC_VIEWPORT_TOP || top > ENC_VIEWPORT_BOTTOM;
      elems.cardBtn.setBounds(left, top, ENC_CARD_W, ENC_CARD_H);
      elems.cardBtn.setVisible(!offscreen);
    }
    const headerLeft = ENC_COL1_CX - ENC_CARD_W / 2;
    const headerW = (ENC_COL2_CX + ENC_CARD_W / 2) - headerLeft;
    for (const h of this.encHeaders) {
      const top = ENC_CONTENT_TOP + h.top - this.encScrollOffset;
      const offscreen = top + ENC_HEADER_H < ENC_VIEWPORT_TOP || top > ENC_VIEWPORT_BOTTOM;
      h.handle.setBounds(headerLeft, top, headerW, ENC_HEADER_H);
      h.handle.setVisible(!offscreen);
    }
    // Position the scrollbar thumb. Thumb height = visible fraction of the
    // total content; thumb y = lerped against the scroll offset.
    if (this.encScrollbarTrack && this.encScrollbarThumb) {
      const viewportH = this.encViewportHeight();
      const fraction = viewportH / Math.max(viewportH, this.encContentHeight);
      const trackH = ENC_VIEWPORT_BOTTOM - ENC_VIEWPORT_TOP;
      const thumbH = Math.max(20, Math.floor(trackH * fraction));
      const max = this.encMaxScroll();
      const t = max > 0 ? this.encScrollOffset / max : 0;
      const thumbY = ENC_VIEWPORT_TOP + (trackH - thumbH) * t;
      this.encScrollbarThumb.setSize(6, thumbH);
      this.encScrollbarThumb.setPosition(this.encScrollbarTrack.x, thumbY);
    }
  }

  private selectEncounter(def: EncounterDef): void {
    // The same encounter can have multiple cards (one per adventure) — light
    // up every card sharing the id so the selection reads consistently.
    for (const elems of this.encCards) {
      elems.cardBtn.el.style.borderColor = elems.defId === def.id ? "#e2b96f" : "#334455";
    }
    this.selectedEncounter = def;
    this.scrollEncounterIntoView(def);
    this.refreshBeginButton();
    this.refreshPromoteButton();
  }

  /** Ensure a card for `def` is fully visible in the encounter viewport. Used
   *  by `pendingEncounterId` auto-select and by manual selections so the user
   *  always sees what they just clicked. Scrolls to the first card for the id. */
  private scrollEncounterIntoView(def: EncounterDef): void {
    const elems = this.encCards.find((c) => c.defId === def.id);
    if (!elems) return;
    const topShown = ENC_CONTENT_TOP + elems.top - this.encScrollOffset;
    if (topShown >= ENC_VIEWPORT_TOP && topShown + ENC_CARD_H <= ENC_VIEWPORT_BOTTOM) return;
    // Centre the card in the visible band.
    const target = elems.top - (this.encViewportHeight() - ENC_CARD_H) / 2;
    this.setEncScrollOffset(target);
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

        const createRequest = {
          mapType: "saved" as const,
          playerDefId: player.id,
          savedMapId: enc.mapId,
          encounterId: enc.id,
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
          conversationOverrides: enc.conversationOverrides,
          resumeHp:            save?.hp,
          resumeXp:            save?.xp,
          resumeCp:            save?.balanceCp,
          resumeInventoryIds:  save?.inventoryIds,
          resumeEquippedSlots: save?.equippedSlots,
          resumeResources:     save?.resources,
        };
        gameClient.createSession(createRequest).then(({ state, playerDef }) => {
          // Use the server-returned PlayerDef rather than the registry's L1
          // copy — it already has the character's level-up history applied.
          // `createRequest` is threaded through so the DevTools panel's
          // Reload Encounter button can recreate the same session.
          this.scene.start("GameScene", { sessionId: state.sessionId, playerDef, createRequest });
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
    for (const c of this.encCards) c.cardBtn.dispose();
    for (const h of this.encHeaders) h.handle.dispose();
    this.htmlTexts = [];
    this.htmlButtons = [];
    this.encCards = [];
    this.encHeaders = [];
    this.encScrollbarTrack?.destroy(); this.encScrollbarTrack = null;
    this.encScrollbarThumb?.destroy(); this.encScrollbarThumb = null;
    this.characterCarousel?.destroy();
    this.characterCarousel = null;
    this.characterDetail?.destroy();
    this.characterDetail = null;
  }
}

