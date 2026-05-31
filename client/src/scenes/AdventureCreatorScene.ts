import Phaser from "phaser";
import { gameClient } from "../net/GameClient";
import type { AdventureDef, AdventureChapter, EncounterDef, SavedMapDef } from "../net/types";
import type { AdventureRefineProposed, AdventureRefineChapter } from "../net/GameClient";
import { createHtmlButton, createHtmlText, type HtmlButtonHandle, type HtmlTextHandle } from "../ui/htmlButtons";
import { EncounterPickerOverlay } from "../ui/generate/EncounterPickerOverlay";
import { AdventurePickerOverlay } from "../ui/generate/AdventurePickerOverlay";
import {
  buildLineInput as sharedBuildLineInput,
  buildTextarea as sharedBuildTextarea,
  attachPlacement as sharedAttachPlacement,
} from "../ui/sceneInputs";
import {
  TILE_SIZE,
  GRID_COLS,
  GRID_ROWS,
  HUD_HEIGHT,
  PLAYER_PANEL_WIDTH,
  TARGET_PANEL_WIDTH,
} from "../constants";

/**
 * AdventureCreatorScene — author-side counterpart to the player-facing
 * AdventureSetupScene. Lets the user assemble an adventure from existing
 * encounter cards: title, description, AI context, an ordered chapter list,
 * and a single rest encounter the player can return to between chapters.
 *
 * Layout:
 *   • LEFT column — title, description, AI-context inputs. Plus the rest
 *     encounter selector + LOAD/SAVE controls at the top.
 *   • RIGHT column — the ordered chapter list. Each row shows the chapter
 *     id, title, the bound encounter id, and ↑ / ↓ / REMOVE controls. An
 *     "+ ADD CHAPTER" button at the bottom opens the EncounterPickerOverlay.
 *   • BOTTOM bar — BACK, LOAD ADVENTURE, SAVE ADVENTURE.
 */

const W = PLAYER_PANEL_WIDTH + GRID_COLS * TILE_SIZE + TARGET_PANEL_WIDTH;
const H = GRID_ROWS * TILE_SIZE + HUD_HEIGHT;

const TITLE_Y = 28;
const OUTER_TAB_Y = 92;
const OUTER_TAB_H = 28;
const CONTENT_TOP = 132;
const CONTENT_BOTTOM = H - 110;
const PANEL_PAD = 40;
const COL_GAP = 28;

type Chrome = HtmlButtonHandle | HtmlTextHandle | { setVisible(v: boolean): void; dispose(): void };

/** Form-level chapter row — kept separate from the persisted `AdventureChapter`
 *  shape so the UI can hold a partially-filled row before the user picks an
 *  encounter (e.g. when the chapter is freshly added). */
interface ChapterRow {
  id: string;
  title: string;
  encounterId: string;
  completionFlag: string;
}

export class AdventureCreatorScene extends Phaser.Scene {
  // Scene-wide chrome that lives in both outer tabs (title, subtitle, tab
  // buttons, bottom bar, status line).
  private chrome: Chrome[] = [];
  // Per-tab buckets — `regularBucket` holds the LEFT + RIGHT form columns,
  // `aiBucket` holds the Generative AI panel. Toggling outer tabs flips each
  // bucket's setVisible.
  private regularBucket: Chrome[] = [];
  private aiBucket: Chrome[] = [];
  private statusEl: HTMLDivElement | null = null;
  private busy = false;

  // Outer tab state.
  private outerTab: "regular" | "ai" = "regular";
  private regularTabBtn: HtmlButtonHandle | null = null;
  private aiTabBtn: HtmlButtonHandle | null = null;

  // Form state.
  private adventureId: string = "";
  private formTitle = "";
  private formDescription = "";
  private formIntroduction = "";
  private formAiContext = "";
  private formRestEncounterId = "";
  private chapters: ChapterRow[] = [];

  // Inputs.
  private idInput: HTMLInputElement | null = null;
  private titleInput: HTMLInputElement | null = null;
  private descInput: HTMLTextAreaElement | null = null;
  private introInput: HTMLTextAreaElement | null = null;
  private aiContextInput: HTMLTextAreaElement | null = null;
  private restSelectBtn: HtmlButtonHandle | null = null;
  private chapterListEl: HTMLDivElement | null = null;

  // AI panel state.
  private aiPromptInput: HTMLTextAreaElement | null = null;
  private aiStatusEl: HTMLDivElement | null = null;
  private aiDiffEl: HTMLDivElement | null = null;
  private aiSubmitBtn: HtmlButtonHandle | null = null;
  private aiResetBtn: HtmlButtonHandle | null = null;
  private aiAcceptBtn: HtmlButtonHandle | null = null;
  private aiRejectBtn: HtmlButtonHandle | null = null;
  /** Last proposal returned by the server — null when there's nothing to
   *  accept (initial state, after reject, or after accept). */
  private aiProposal: AdventureRefineProposed | null = null;

  // Overlays.
  private encounterPicker: EncounterPickerOverlay | null = null;
  private adventurePicker: AdventurePickerOverlay | null = null;
  /** Tracks which slot the next encounter pick should populate: a chapter
   *  index (number ≥ 0), the rest slot (`"rest"`), or a fresh chapter at
   *  the end of the list (`"new"`). */
  private pendingEncounterTarget: number | "rest" | "new" | null = null;

  constructor() {
    super({ key: "AdventureCreatorScene" });
  }

  init(): void {
    this.chrome = [];
    this.regularBucket = [];
    this.aiBucket = [];
    this.outerTab = "regular";
    this.adventureId = "";
    this.formTitle = "";
    this.formDescription = "";
    this.formIntroduction = "";
    this.formAiContext = "";
    this.formRestEncounterId = "";
    this.chapters = [];
    this.aiProposal = null;
    this.busy = false;
  }

  create(): void {
    // Defensive: a previous scene (especially GameScene with its WASD player
    // controls) may have left global keyboard capture on, which calls
    // preventDefault for W/A/S/D and blocks them from reaching any HTML
    // input on this page. Clear it so the inputs receive every key.
    this.input.keyboard?.disableGlobalCapture();
    this.input.keyboard?.clearCaptures();

    this.add.rectangle(W / 2, H / 2, W, H, 0x0d0d1e);
    this.add.rectangle(W / 2, TITLE_Y + 38, W - 64, 1, 0x334455);

    const title = createHtmlText({
      scene: this, sceneWidth: W,
      x: 0, y: TITLE_Y, w: W, h: 28,
      text: "ADVENTURE CREATOR",
      fontSize: 22, color: "#e2b96f", align: "center", letterSpacing: 1,
    });
    this.chrome.push(title);

    const subtitle = createHtmlText({
      scene: this, sceneWidth: W,
      x: 0, y: TITLE_Y + 50, w: W, h: 16,
      text: "Assemble an adventure from existing encounters. Save here, play from the Adventure setup screen.",
      fontSize: 11, color: "#88aacc", align: "center",
    });
    this.chrome.push(subtitle);

    this.buildOuterTabs();
    this.buildLeftColumn();
    this.buildRightColumn();
    this.buildAiPanel();
    this.buildStatusLine();
    this.buildBottomBar();
    this.refreshOuterTabActiveState();
    this.refreshOuterTabVisibility();

    this.events.once("shutdown", () => this.teardown());
    this.events.once("destroy",  () => this.teardown());
  }

  // ── Outer tab bar (REGULAR / GENERATIVE AI) ─────────────────────────────

  private buildOuterTabs(): void {
    const TAB_W = 220;
    const TAB_GAP = 8;
    const startX = (W - (TAB_W * 2 + TAB_GAP)) / 2;
    this.regularTabBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: startX, y: OUTER_TAB_Y, w: TAB_W, h: OUTER_TAB_H,
      label: "REGULAR", variant: "secondary", fontSize: 12,
      onClick: () => this.setOuterTab("regular"),
    });
    this.aiTabBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: startX + TAB_W + TAB_GAP, y: OUTER_TAB_Y, w: TAB_W, h: OUTER_TAB_H,
      label: "GENERATIVE AI", variant: "secondary", fontSize: 12,
      onClick: () => this.setOuterTab("ai"),
    });
    this.chrome.push(this.regularTabBtn, this.aiTabBtn);
  }

  private setOuterTab(tab: "regular" | "ai"): void {
    if (this.outerTab === tab) return;
    this.outerTab = tab;
    this.refreshOuterTabActiveState();
    this.refreshOuterTabVisibility();
  }

  private refreshOuterTabActiveState(): void {
    if (this.regularTabBtn) this.regularTabBtn.setActive(this.outerTab === "regular");
    if (this.aiTabBtn)      this.aiTabBtn.setActive(this.outerTab === "ai");
  }

  private refreshOuterTabVisibility(): void {
    const isRegular = this.outerTab === "regular";
    for (const c of this.regularBucket) c.setVisible(isRegular);
    for (const c of this.aiBucket)      c.setVisible(!isRegular);
  }

  // ── Left column — id / title / description / introduction / ai-context ──

  private buildLeftColumn(): void {
    const colW = Math.floor((W - PANEL_PAD * 2 - COL_GAP) * 0.55);
    const colX = PANEL_PAD;
    const colY = CONTENT_TOP;
    const colH = CONTENT_BOTTOM - CONTENT_TOP;

    const lineH = 28;
    const gap = 12;
    let y = colY;
    const bucket = this.regularBucket;

    // ID input.
    bucket.push(this.makeLabel(colX, y, colW, "ID (snake_case)"));
    y += 18;
    this.idInput = this.buildLineInput(colX, y, colW, lineH, "e.g. the_long_road", (val) => { this.adventureId = val.trim(); }, bucket);
    y += lineH + gap;

    // Title input.
    bucket.push(this.makeLabel(colX, y, colW, "TITLE"));
    y += 18;
    this.titleInput = this.buildLineInput(colX, y, colW, lineH, "Adventure title", (val) => { this.formTitle = val; }, bucket);
    y += lineH + gap;

    // Description textarea.
    bucket.push(this.makeLabel(colX, y, colW, "DESCRIPTION (player-facing prose)"));
    y += 18;
    const descH = 90;
    this.descInput = this.buildTextarea(colX, y, colW, descH, "What the player sees on the adventure card.", (val) => { this.formDescription = val; }, bucket);
    y += descH + gap;

    // Introduction textarea.
    bucket.push(this.makeLabel(colX, y, colW, "INTRODUCTION (shown before chapter 1)"));
    y += 18;
    const introH = 80;
    this.introInput = this.buildTextarea(colX, y, colW, introH, "Opening narration for chapter 1.", (val) => { this.formIntroduction = val; }, bucket);
    y += introH + gap;

    // AI context textarea — takes the remaining height.
    bucket.push(this.makeLabel(colX, y, colW, "AI CONTEXT (Game Master sees this every chapter)"));
    y += 18;
    const aiH = Math.max(80, colY + colH - y - 8);
    this.aiContextInput = this.buildTextarea(colX, y, colW, aiH, "Backstory, factions, themes, plot hooks. Feeds the AIGM prompt for every encounter played as part of this adventure.", (val) => { this.formAiContext = val; }, bucket);
  }

  // ── Right column — ordered chapter list + rest encounter selector ───────

  private buildRightColumn(): void {
    const leftColW = Math.floor((W - PANEL_PAD * 2 - COL_GAP) * 0.55);
    const colX = PANEL_PAD + leftColW + COL_GAP;
    const colW = W - PANEL_PAD - colX;
    const colY = CONTENT_TOP;
    const bucket = this.regularBucket;

    let y = colY;

    // REST ENCOUNTER selector (top).
    bucket.push(this.makeLabel(colX, y, colW, "REST ENCOUNTER"));
    y += 18;
    this.restSelectBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: colX, y, w: colW, h: 32,
      label: this.formatRestLabel(),
      variant: "secondary", fontSize: 11,
      onClick: () => this.openEncounterPickerFor("rest"),
    });
    bucket.push(this.restSelectBtn);
    y += 32 + 6;

    const hint = createHtmlText({
      scene: this, sceneWidth: W,
      x: colX, y, w: colW, h: 14,
      text: "An inn or campsite the player returns to between chapters.",
      fontSize: 10, color: "#778899", align: "left",
    });
    bucket.push(hint);
    y += 14 + 14;

    // CHAPTERS — header + scrollable list + ADD button.
    bucket.push(this.makeLabel(colX, y, colW, "CHAPTERS (in play order)"));
    y += 18;

    const addBtnH = 32;
    const remainingH = CONTENT_BOTTOM - y - addBtnH - 6;
    this.chapterListEl = document.createElement("div");
    this.chapterListEl.style.cssText = `
      position: absolute;
      background: #0f1320;
      border: 1px solid #334455;
      box-sizing: border-box;
      overflow-y: auto;
      z-index: 9;
      padding: 4px;
      scrollbar-width: thin;
      scrollbar-color: #445566 transparent;
    `;
    document.body.appendChild(this.chapterListEl);
    this.attachPlacement(this.chapterListEl, colX, y, colW, remainingH);
    bucket.push(htmlChromeHandle(this.chapterListEl));
    y += remainingH + 6;

    const addBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: colX, y, w: colW, h: addBtnH,
      label: "+ ADD CHAPTER", variant: "primary", fontSize: 12,
      onClick: () => this.openEncounterPickerFor("new"),
    });
    bucket.push(addBtn);

    this.renderChapterList();
  }

  private renderChapterList(): void {
    if (!this.chapterListEl) return;
    this.chapterListEl.replaceChildren();
    if (this.chapters.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "color:#445566;font-family:monospace;font-size:11px;padding:14px;font-style:italic;text-align:center;";
      empty.textContent = "No chapters yet. Press + ADD CHAPTER to pick the first encounter.";
      this.chapterListEl.appendChild(empty);
      return;
    }
    this.chapters.forEach((ch, idx) => {
      const row = document.createElement("div");
      row.style.cssText = `
        display: flex; align-items: center;
        background: ${idx % 2 === 0 ? "#111122" : "#141426"};
        padding: 6px 8px; margin-bottom: 2px;
        box-sizing: border-box;
        font-family: monospace; font-size: 11px; color: #aabbcc;
        gap: 4px;
      `;
      const idxTag = document.createElement("span");
      idxTag.textContent = `Ch ${idx + 1}`;
      idxTag.style.cssText = "color:#e2b96f;font-weight:bold;width:42px;flex-shrink:0;";
      row.appendChild(idxTag);

      const titleEl = document.createElement("div");
      titleEl.style.cssText = "flex:1;min-width:0;overflow:hidden;";
      const t1 = document.createElement("div");
      t1.textContent = ch.title || "(untitled chapter)";
      t1.style.cssText = "color:#c8d8e8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      titleEl.appendChild(t1);
      const t2 = document.createElement("div");
      t2.textContent = `${ch.id}  ·  encounter: ${ch.encounterId || "(unset)"}`;
      t2.style.cssText = "color:#778899;font-size:9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      titleEl.appendChild(t2);
      row.appendChild(titleEl);

      const upBtn = this.makeRowButton("↑", () => this.moveChapter(idx, -1));
      upBtn.disabled = idx === 0;
      if (upBtn.disabled) upBtn.style.opacity = "0.3";
      row.appendChild(upBtn);

      const downBtn = this.makeRowButton("↓", () => this.moveChapter(idx, +1));
      downBtn.disabled = idx === this.chapters.length - 1;
      if (downBtn.disabled) downBtn.style.opacity = "0.3";
      row.appendChild(downBtn);

      const editBtn = this.makeRowButton("EDIT", () => this.openEncounterPickerFor(idx));
      row.appendChild(editBtn);

      const removeBtn = this.makeRowButton("✗", () => this.removeChapter(idx));
      removeBtn.style.borderColor = "#884444";
      removeBtn.style.color = "#ffaaaa";
      row.appendChild(removeBtn);

      this.chapterListEl!.appendChild(row);
    });
  }

  private makeRowButton(label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.style.cssText = `
      background: #1a1a2a; color: #aabbcc; border: 1px solid #445566;
      padding: 2px 8px; margin-left: 2px;
      font-family: monospace; font-size: 10px; letter-spacing: 1px;
      cursor: pointer; flex-shrink: 0;
    `;
    btn.addEventListener("click", onClick);
    return btn;
  }

  private moveChapter(idx: number, delta: number): void {
    const j = idx + delta;
    if (j < 0 || j >= this.chapters.length) return;
    const tmp = this.chapters[idx];
    this.chapters[idx] = this.chapters[j];
    this.chapters[j] = tmp;
    this.renderChapterList();
  }

  private removeChapter(idx: number): void {
    this.chapters.splice(idx, 1);
    this.renderChapterList();
  }

  // ── Encounter / adventure picker overlays ──────────────────────────────

  private async openEncounterPickerFor(target: number | "rest" | "new"): Promise<void> {
    if (this.encounterPicker || this.busy) return;
    // Refresh from the server so the picker reflects any encounters the
    // user just authored in a different scene without a browser reload.
    try {
      const [encs, maps] = await Promise.all([gameClient.listEncounters(), gameClient.listMaps()]);
      this.registry.set("encounters", encs);
      this.registry.set("maps", maps);
    } catch { /* fall back to whatever's cached */ }
    const encounters = (this.registry.get("encounters") as EncounterDef[] | undefined) ?? [];
    const maps = (this.registry.get("maps") as SavedMapDef[] | undefined) ?? [];
    if (encounters.length === 0) {
      if (this.statusEl) this.statusEl.textContent = "No encounters available — author one in the Encounter Creator first.";
      return;
    }
    this.pendingEncounterTarget = target;
    this.encounterPicker = new EncounterPickerOverlay(this, encounters, maps, {
      onSelect: (enc) => {
        // Apply BEFORE closing — closeEncounterPicker resets pendingEncounterTarget,
        // which applyEncounterPick needs to read to know which slot to fill.
        this.applyEncounterPick(enc);
        this.closeEncounterPicker();
      },
      onClose: () => this.closeEncounterPicker(),
    });
  }

  private closeEncounterPicker(): void {
    if (this.encounterPicker) { this.encounterPicker.destroy(); this.encounterPicker = null; }
    this.pendingEncounterTarget = null;
  }

  private applyEncounterPick(enc: EncounterDef): void {
    const target = this.pendingEncounterTarget;
    this.pendingEncounterTarget = null;
    if (target === "rest") {
      this.formRestEncounterId = enc.id;
      if (this.restSelectBtn) this.restSelectBtn.setLabel(this.formatRestLabel());
      return;
    }
    if (target === "new") {
      // Auto-generate a unique chapter id based on the existing list length.
      const id = `ch${this.chapters.length + 1}_${enc.id}`.slice(0, 48);
      this.chapters.push({
        id,
        title: enc.encounterTitle || `Chapter ${this.chapters.length + 1}`,
        encounterId: enc.id,
        completionFlag: "",
      });
      this.renderChapterList();
      return;
    }
    if (typeof target === "number" && target >= 0 && target < this.chapters.length) {
      this.chapters[target] = {
        ...this.chapters[target],
        encounterId: enc.id,
        // Keep the existing chapter title; only update it if previously empty.
        title: this.chapters[target].title || enc.encounterTitle || this.chapters[target].title,
      };
      this.renderChapterList();
    }
  }

  private formatRestLabel(): string {
    return this.formRestEncounterId
      ? `Rest: ${this.formRestEncounterId}  (click to change)`
      : "Pick a rest encounter";
  }

  private async openAdventurePicker(): Promise<void> {
    if (this.adventurePicker || this.busy) return;
    try {
      const fresh = await gameClient.listAdventures();
      this.registry.set("adventures", fresh);
    } catch { /* fall through to whatever's cached */ }
    const adventures = (this.registry.get("adventures") as AdventureDef[] | undefined) ?? [];
    this.adventurePicker = new AdventurePickerOverlay(adventures, {
      onSelect: (adv) => {
        this.closeAdventurePicker();
        this.loadAdventureIntoForm(adv);
      },
      onClose: () => this.closeAdventurePicker(),
    });
  }

  private closeAdventurePicker(): void {
    if (this.adventurePicker) { this.adventurePicker.destroy(); this.adventurePicker = null; }
  }

  private loadAdventureIntoForm(adv: AdventureDef): void {
    this.adventureId       = adv.id;
    this.formTitle         = adv.title       ?? "";
    this.formDescription   = adv.description ?? "";
    this.formIntroduction  = adv.introduction ?? "";
    this.formAiContext     = adv.aiContext   ?? "";
    this.formRestEncounterId = adv.restEncounterId ?? "";
    this.chapters = (adv.chapters ?? []).map((c) => ({
      id: c.id,
      title: c.title,
      encounterId: c.encounterId,
      completionFlag: c.completionFlag ?? "",
    }));
    if (this.idInput)        this.idInput.value        = this.adventureId;
    if (this.titleInput)     this.titleInput.value     = this.formTitle;
    if (this.descInput)      this.descInput.value      = this.formDescription;
    if (this.introInput)     this.introInput.value     = this.formIntroduction;
    if (this.aiContextInput) this.aiContextInput.value = this.formAiContext;
    if (this.restSelectBtn)  this.restSelectBtn.setLabel(this.formatRestLabel());
    this.renderChapterList();
    if (this.statusEl) this.statusEl.textContent = `Loaded ${adv.id}.`;
  }

  // ── Save ───────────────────────────────────────────────────────────────

  private async runSave(): Promise<void> {
    if (this.busy) return;
    if (!/^[a-z0-9_]+$/.test(this.adventureId)) {
      if (this.statusEl) this.statusEl.textContent = "ID must be snake_case (lowercase letters, digits, underscores).";
      return;
    }
    if (!this.formTitle.trim()) {
      if (this.statusEl) this.statusEl.textContent = "Title is required.";
      return;
    }
    if (this.chapters.length === 0) {
      if (this.statusEl) this.statusEl.textContent = "Add at least one chapter before saving.";
      return;
    }
    for (const ch of this.chapters) {
      if (!ch.id || !ch.encounterId) {
        if (this.statusEl) this.statusEl.textContent = "Every chapter needs an id and a bound encounter.";
        return;
      }
    }
    const adv: AdventureDef = {
      id: this.adventureId,
      title: this.formTitle.trim(),
      description: this.formDescription.trim(),
      introduction: this.formIntroduction.trim(),
      chapters: this.chapters.map<AdventureChapter>((c) => ({
        id: c.id,
        title: c.title,
        encounterId: c.encounterId,
        ...(c.completionFlag ? { completionFlag: c.completionFlag } : {}),
      })),
      ...(this.formAiContext.trim() ? { aiContext: this.formAiContext.trim() } : {}),
      ...(this.formRestEncounterId ? { restEncounterId: this.formRestEncounterId } : {}),
    };
    this.busy = true;
    if (this.statusEl) this.statusEl.textContent = "Saving adventure…";
    try {
      const { adventureId } = await gameClient.saveAdventure(adv);
      // Refresh the cached registry so the player-side AdventureSetupScene
      // sees the new entry on its next visit without a browser reload.
      try {
        const fresh = await gameClient.listAdventures();
        this.registry.set("adventures", fresh);
      } catch { /* non-fatal */ }
      if (this.statusEl) this.statusEl.textContent = `Saved ${adventureId}.`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.statusEl) this.statusEl.textContent = `Save failed: ${msg}`;
    } finally {
      this.busy = false;
    }
  }

  // ── Generative AI panel ─────────────────────────────────────────────────

  /** Full-width Generative AI panel — sits in the same content rect as the
   *  REGULAR tab's LEFT + RIGHT columns and toggles visibility via the outer
   *  tab bar. Layout: PROMPT label + textarea on top, SUBMIT / RESET row,
   *  status line, diff viewer, ACCEPT / REJECT row at the bottom. Iterative
   *  prompts feed the current form draft back to the server, so changes the
   *  user makes by hand in REGULAR are visible to the AI on the next round. */
  private buildAiPanel(): void {
    const bucket = this.aiBucket;
    const x = PANEL_PAD;
    const w = W - PANEL_PAD * 2;
    const topY = CONTENT_TOP;
    const bottomY = CONTENT_BOTTOM;
    const totalH = bottomY - topY;

    const promptLabelH = 18;
    const buttonRowH = 32;
    const statusH = 20;
    const acceptRowH = 32;
    const gap = 10;
    const remaining = totalH - promptLabelH - buttonRowH - statusH - acceptRowH - gap * 4;
    const promptH = Math.max(110, Math.floor(remaining * 0.35));
    const diffH = Math.max(160, remaining - promptH);

    // PROMPT label.
    bucket.push(createHtmlText({
      scene: this, sceneWidth: W,
      x, y: topY, w, h: promptLabelH,
      text: "PROMPT  —  describe what to change. The AI sees the current draft + the available encounter pool.",
      fontSize: 10, color: "#7aadcc", align: "left", letterSpacing: 1,
    }));

    // Prompt textarea.
    const promptY = topY + promptLabelH + 4;
    this.aiPromptInput = this.buildTextarea(
      x, promptY, w, promptH,
      "e.g. \"make this a 4-chapter rescue adventure starting at the bridge standoff, with the tavern as the rest stop, and dial up the cult presence in the AI context\".",
      () => { /* read at submit time */ },
      bucket,
    );

    // SUBMIT / RESET row.
    const btnRowY = promptY + promptH + gap;
    const btnW = Math.floor((w - gap) / 2);
    this.aiSubmitBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x, y: btnRowY, w: btnW, h: buttonRowH,
      label: "✨ GENERATE", variant: "primary", fontSize: 13,
      onClick: () => this.runAiGenerate(),
    });
    bucket.push(this.aiSubmitBtn);
    this.aiResetBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: x + btnW + gap, y: btnRowY, w: btnW, h: buttonRowH,
      label: "RESET PROMPT", variant: "ghost", fontSize: 12,
      onClick: () => { if (this.aiPromptInput) this.aiPromptInput.value = ""; },
    });
    bucket.push(this.aiResetBtn);

    // Status line.
    const statusY = btnRowY + buttonRowH + gap;
    this.aiStatusEl = document.createElement("div");
    this.aiStatusEl.style.cssText = `
      position: absolute;
      font-family: monospace; font-size: 12px; color: #88aacc;
      display: flex; align-items: center;
      z-index: 10; box-sizing: border-box;
      pointer-events: none;
    `;
    document.body.appendChild(this.aiStatusEl);
    this.attachPlacement(this.aiStatusEl, x, statusY, w, statusH);
    bucket.push(htmlChromeHandle(this.aiStatusEl));

    // Diff viewer.
    const diffY = statusY + statusH + gap;
    this.aiDiffEl = document.createElement("div");
    this.aiDiffEl.style.cssText = `
      position: absolute;
      background: #0f1320; border: 1px solid #334455;
      box-sizing: border-box; padding: 10px 12px;
      font-family: monospace; font-size: 12px; color: #aabbcc;
      overflow-y: auto; scrollbar-width: thin; scrollbar-color: #445566 transparent;
      white-space: pre-wrap; line-height: 1.5;
      z-index: 10;
    `;
    this.aiDiffEl.textContent =
      "No proposal yet. Describe changes and press GENERATE.\n\n" +
      "The AI sees the current draft + the encounter pool, and proposes edits — accept to merge, reject to discard. " +
      "Iterative prompts feed the latest draft back in.";
    document.body.appendChild(this.aiDiffEl);
    this.attachPlacement(this.aiDiffEl, x, diffY, w, diffH);
    bucket.push(htmlChromeHandle(this.aiDiffEl));

    // ACCEPT / REJECT row.
    const acceptY = diffY + diffH + gap;
    this.aiAcceptBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x, y: acceptY, w: btnW, h: acceptRowH,
      label: "✓ ACCEPT PROPOSAL", variant: "primary", fontSize: 13,
      onClick: () => this.acceptAiProposal(),
    });
    this.aiAcceptBtn.setDisabled(true);
    bucket.push(this.aiAcceptBtn);
    this.aiRejectBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: x + btnW + gap, y: acceptY, w: btnW, h: acceptRowH,
      label: "✗ REJECT", variant: "ghost", fontSize: 12,
      onClick: () => this.rejectAiProposal(),
    });
    this.aiRejectBtn.setDisabled(true);
    bucket.push(this.aiRejectBtn);
  }

  private async runAiGenerate(): Promise<void> {
    if (this.busy) return;
    const prompt = (this.aiPromptInput?.value ?? "").trim();
    if (prompt.length < 4) {
      if (this.aiStatusEl) this.aiStatusEl.textContent = "Describe what to change (at least a few words).";
      return;
    }
    this.busy = true;
    this.aiSubmitBtn?.setDisabled(true);
    this.aiAcceptBtn?.setDisabled(true);
    this.aiRejectBtn?.setDisabled(true);
    if (this.aiStatusEl) this.aiStatusEl.textContent = "Asking the GM to revise the draft…";

    try {
      const draft = {
        id: this.adventureId,
        title: this.formTitle,
        description: this.formDescription,
        introduction: this.formIntroduction,
        aiContext: this.formAiContext,
        chapters: this.chapters.map((c) => ({
          id: c.id,
          title: c.title,
          encounterId: c.encounterId,
          ...(c.completionFlag ? { completionFlag: c.completionFlag } : {}),
        })),
        restEncounterId: this.formRestEncounterId,
      };
      const result = await gameClient.refineAdventure(draft, prompt);
      this.aiProposal = result.proposed;
      this.renderProposalDiff(result.rationale, result.proposed);
      const hasAnyChange = Object.keys(result.proposed).length > 0;
      this.aiAcceptBtn?.setDisabled(!hasAnyChange);
      this.aiRejectBtn?.setDisabled(!hasAnyChange);
      if (this.aiStatusEl) {
        this.aiStatusEl.textContent = hasAnyChange
          ? "Proposal ready — review the diff and Accept or Reject."
          : "The model returned no changes. Try a more specific prompt.";
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.aiStatusEl) this.aiStatusEl.textContent = `Refine failed: ${msg}`;
      if (this.aiDiffEl) this.aiDiffEl.textContent = `Refine failed: ${msg}\n\nAdjust the prompt and try again.`;
    } finally {
      this.busy = false;
      this.aiSubmitBtn?.setDisabled(false);
    }
  }

  /** Render the proposal as a series of field cards: each field that the
   *  model proposes to change gets a small header + the BEFORE (current
   *  draft) and AFTER (proposed) values side by side so the author can scan
   *  the diff before accepting. */
  private renderProposalDiff(rationale: string, p: AdventureRefineProposed): void {
    if (!this.aiDiffEl) return;
    this.aiDiffEl.replaceChildren();

    const rationaleEl = document.createElement("div");
    rationaleEl.style.cssText = "color:#e2b96f;font-size:11px;letter-spacing:1px;padding:0 0 10px;border-bottom:1px solid #223344;margin-bottom:10px;";
    rationaleEl.textContent = `RATIONALE  —  ${rationale}`;
    this.aiDiffEl.appendChild(rationaleEl);

    const card = (label: string, before: string, after: string): void => {
      const wrap = document.createElement("div");
      wrap.style.cssText = "padding:6px 0;border-bottom:1px solid #1a2a3a;margin-bottom:6px;";
      const lbl = document.createElement("div");
      lbl.style.cssText = "color:#7aadcc;font-size:10px;letter-spacing:2px;margin-bottom:4px;";
      lbl.textContent = label.toUpperCase();
      wrap.appendChild(lbl);
      const beforeEl = document.createElement("div");
      beforeEl.style.cssText = "color:#667788;font-size:11px;padding:2px 6px;margin:2px 0;background:#0a1018;border-left:2px solid #445566;white-space:pre-wrap;";
      beforeEl.textContent = `– ${before || "(empty)"}`;
      wrap.appendChild(beforeEl);
      const afterEl = document.createElement("div");
      afterEl.style.cssText = "color:#aaccaa;font-size:11px;padding:2px 6px;margin:2px 0;background:#0e1a10;border-left:2px solid #88aa66;white-space:pre-wrap;";
      afterEl.textContent = `+ ${after || "(empty)"}`;
      wrap.appendChild(afterEl);
      this.aiDiffEl!.appendChild(wrap);
    };

    if (p.title         !== undefined) card("title",        this.formTitle,        p.title);
    if (p.description   !== undefined) card("description",  this.formDescription,  p.description);
    if (p.introduction  !== undefined) card("introduction", this.formIntroduction, p.introduction);
    if (p.aiContext     !== undefined) card("ai context",   this.formAiContext,    p.aiContext);
    if (p.restEncounterId !== undefined) card("rest encounter id", this.formRestEncounterId, p.restEncounterId);
    if (p.chapters !== undefined) {
      const fmtList = (list: Array<{ id: string; title: string; encounterId: string }>): string =>
        list.length === 0
          ? "(no chapters)"
          : list.map((c, i) => `  ${i + 1}. ${c.id} · "${c.title}" · enc=${c.encounterId}`).join("\n");
      card("chapters", fmtList(this.chapters), fmtList(p.chapters));
    }
    if (Object.keys(p).length === 0) {
      const none = document.createElement("div");
      none.style.cssText = "color:#667788;font-style:italic;";
      none.textContent = "The model proposed no field changes.";
      this.aiDiffEl.appendChild(none);
    }
  }

  /** Merge the pending proposal into the form state, sync the regular-tab
   *  inputs, and clear the proposal. */
  private acceptAiProposal(): void {
    const p = this.aiProposal;
    if (!p) return;
    if (p.title         !== undefined) this.formTitle         = p.title;
    if (p.description   !== undefined) this.formDescription   = p.description;
    if (p.introduction  !== undefined) this.formIntroduction  = p.introduction;
    if (p.aiContext     !== undefined) this.formAiContext     = p.aiContext;
    if (p.restEncounterId !== undefined) this.formRestEncounterId = p.restEncounterId;
    if (p.chapters !== undefined) {
      this.chapters = p.chapters.map<ChapterRow>((c: AdventureRefineChapter) => ({
        id: c.id,
        title: c.title,
        encounterId: c.encounterId,
        completionFlag: c.completionFlag ?? "",
      }));
    }

    if (this.titleInput     && p.title         !== undefined) this.titleInput.value     = this.formTitle;
    if (this.descInput      && p.description   !== undefined) this.descInput.value      = this.formDescription;
    if (this.introInput     && p.introduction  !== undefined) this.introInput.value     = this.formIntroduction;
    if (this.aiContextInput && p.aiContext     !== undefined) this.aiContextInput.value = this.formAiContext;
    if (this.restSelectBtn  && p.restEncounterId !== undefined) this.restSelectBtn.setLabel(this.formatRestLabel());
    if (p.chapters !== undefined) this.renderChapterList();

    this.aiProposal = null;
    this.aiAcceptBtn?.setDisabled(true);
    this.aiRejectBtn?.setDisabled(true);
    if (this.aiStatusEl) this.aiStatusEl.textContent = "Proposal applied. Switch to REGULAR to fine-tune, or iterate with another prompt.";
    if (this.aiDiffEl) {
      this.aiDiffEl.replaceChildren();
      this.aiDiffEl.textContent = "Proposal applied. Iterate with another prompt or switch to REGULAR to fine-tune.";
    }
  }

  private rejectAiProposal(): void {
    this.aiProposal = null;
    this.aiAcceptBtn?.setDisabled(true);
    this.aiRejectBtn?.setDisabled(true);
    if (this.aiStatusEl) this.aiStatusEl.textContent = "Proposal discarded. Try another prompt.";
    if (this.aiDiffEl) {
      this.aiDiffEl.replaceChildren();
      this.aiDiffEl.textContent = "Proposal discarded.";
    }
  }

  // ── Bottom bar + status ─────────────────────────────────────────────────

  private buildBottomBar(): void {
    this.add.rectangle(W / 2, H - 58, W - 64, 1, 0x334455);
    const btnH = 36;
    const y = H - 54;
    const back = createHtmlButton({
      scene: this, sceneWidth: W,
      x: 40, y, w: 140, h: btnH,
      label: "BACK", variant: "ghost", fontSize: 13,
      onClick: () => this.scene.start("MainMenuScene"),
    });
    this.chrome.push(back);
    const load = createHtmlButton({
      scene: this, sceneWidth: W,
      x: 200, y, w: 220, h: btnH,
      label: "📂 LOAD ADVENTURE", variant: "secondary", fontSize: 13,
      onClick: () => this.openAdventurePicker(),
    });
    this.chrome.push(load);
    const save = createHtmlButton({
      scene: this, sceneWidth: W,
      x: W - 360, y, w: 320, h: btnH,
      label: "✓ SAVE ADVENTURE", variant: "primary", fontSize: 14,
      onClick: () => this.runSave(),
    });
    this.chrome.push(save);
  }

  private buildStatusLine(): void {
    const status = document.createElement("div");
    status.style.cssText = `
      position: absolute;
      color: #889aac; font-family: monospace; font-size: 12px;
      pointer-events: none; z-index: 10;
    `;
    document.body.appendChild(status);
    this.statusEl = status;
    // Sits in the gap between the content area and the bottom bar so it
    // doesn't overlap (and visually obscure) the right column's ADD CHAPTER
    // button. Centered horizontally so it reads as a banner.
    this.attachPlacement(status, PANEL_PAD, CONTENT_BOTTOM + 14, W - PANEL_PAD * 2, 20);
    status.style.textAlign = "center";
    status.style.fontSize = "13px";
    status.style.color = "#e2b96f";
  }

  // ── Building blocks ────────────────────────────────────────────────────

  private makeLabel(x: number, y: number, w: number, text: string): HtmlTextHandle {
    return createHtmlText({
      scene: this, sceneWidth: W,
      x, y, w, h: 14,
      text,
      fontSize: 10, color: "#778899", align: "left", letterSpacing: 1,
    });
  }

  private buildLineInput(x: number, y: number, w: number, h: number, placeholder: string, onInput: (val: string) => void, bucket: Chrome[] = this.chrome): HTMLInputElement {
    const handle = sharedBuildLineInput({ scene: this, sceneWidth: W, x, y, w, h, placeholder, onInput });
    bucket.push(handle);
    return handle.el;
  }

  private buildTextarea(x: number, y: number, w: number, h: number, placeholder: string, onInput: (val: string) => void, bucket: Chrome[] = this.chrome): HTMLTextAreaElement {
    const handle = sharedBuildTextarea({ scene: this, sceneWidth: W, x, y, w, h, placeholder, onInput });
    bucket.push(handle);
    return handle.el;
  }

  /** Place an HTML element at the given scene-space rect with canvas-scale
   *  tracking, so DOM stays aligned with the Phaser canvas at any zoom. */
  private attachPlacement(el: HTMLElement, x: number, y: number, w: number, h: number): void {
    sharedAttachPlacement(el, { scene: this, sceneWidth: W, x, y, w, h });
  }

  private teardown(): void {
    for (const c of this.chrome) c.dispose();
    for (const c of this.regularBucket) c.dispose();
    for (const c of this.aiBucket) c.dispose();
    this.chrome = [];
    this.regularBucket = [];
    this.aiBucket = [];
    if (this.statusEl)        { this.statusEl.remove();        this.statusEl        = null; }
    if (this.encounterPicker) { this.encounterPicker.destroy(); this.encounterPicker = null; }
    if (this.adventurePicker) { this.adventurePicker.destroy(); this.adventurePicker = null; }
  }
}

function htmlChromeHandle(el: HTMLElement): Chrome {
  return {
    setVisible: (v) => { el.style.display = v ? "" : "none"; },
    dispose: () => el.remove(),
  };
}
