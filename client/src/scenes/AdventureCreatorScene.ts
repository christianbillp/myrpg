import { gameClient } from "../net/GameClient";
import type { AdventureDef, AdventureChapter, EncounterDef, SavedMapDef } from "../../../shared/types";
import type { AdventureRefineProposed, AdventureRefineChapter } from "../net/GameClient";
import { createHtmlButton, createHtmlText, type HtmlButtonHandle } from "../ui/htmlButtons";
import { EncounterPickerOverlay } from "../ui/generate/EncounterPickerOverlay";
import { AdventurePickerOverlay } from "../ui/generate/AdventurePickerOverlay";
import { attachPlacement as sharedAttachPlacement } from "../ui/sceneInputs";
import {
  BaseCreatorScene,
  CREATOR_SCENE_WIDTH as W,
  CREATOR_SCENE_HEIGHT as H,
  CREATOR_CONTENT_TOP as CONTENT_TOP,
  CREATOR_CONTENT_BOTTOM as CONTENT_BOTTOM,
  CREATOR_PANEL_PAD as PANEL_PAD,
  CREATOR_COL_GAP as COL_GAP,
} from "./BaseCreatorScene";

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

/** Form-level chapter row — kept separate from the persisted `AdventureChapter`
 *  shape so the UI can hold a partially-filled row before the user picks an
 *  encounter (e.g. when the chapter is freshly added). */
interface ChapterRow {
  id: string;
  title: string;
  encounterId: string;
  completionFlag: string;
}

export class AdventureCreatorScene extends BaseCreatorScene<AdventureRefineProposed> {
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
    this.resetCreatorScaffold();
    this.adventureId = "";
    this.formTitle = "";
    this.formDescription = "";
    this.formIntroduction = "";
    this.formAiContext = "";
    this.formRestEncounterId = "";
    this.chapters = [];
  }

  create(): void {
    this.clearKeyboardCaptureForHtmlInputs();
    this.buildCreatorHeader(
      "ADVENTURE CREATOR",
      "Assemble an adventure from existing encounters. Save here, play from the Adventure setup screen.",
    );

    this.buildOuterTabs();
    this.buildLeftColumn();
    this.buildRightColumn();
    this.buildAiProposalPanel({
      promptLabel: "PROMPT  —  describe what to change. The AI sees the current draft + the available encounter pool.",
      promptPlaceholder: "e.g. \"make this a 4-chapter rescue adventure starting at the bridge standoff, with the tavern as the rest stop, and dial up the cult presence in the AI context\".",
      diffPlaceholder:
        "No proposal yet. Describe changes and press GENERATE.\n\n" +
        "The AI sees the current draft + the encounter pool, and proposes edits — accept to merge, reject to discard. " +
        "Iterative prompts feed the latest draft back in.",
    });
    this.buildStatusLine();
    this.buildBottomBar();
    this.refreshOuterTabVisibility();

    this.events.once("shutdown", () => this.teardown());
    this.events.once("destroy",  () => this.teardown());
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
    bucket.push(sharedAttachPlacement(this.chapterListEl, { scene: this, sceneWidth: W, x: colX, y, w: colW, h: remainingH }));
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

  // ── Generative AI flow ──────────────────────────────────────────────────

  protected runAiGenerate(): Promise<void> {
    return this.runAiRefineRequest({
      emptyPromptMessage: "Describe what to change (at least a few words).",
      refine: (prompt) => gameClient.refineAdventure({
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
      }, prompt),
      renderDiff: (rationale, proposed) => this.renderProposalDiff(rationale, proposed),
    });
  }

  private renderProposalDiff(rationale: string, p: AdventureRefineProposed): void {
    this.beginProposalDiff(rationale);
    if (p.title         !== undefined) this.appendProposalCard("title",        this.formTitle,        p.title);
    if (p.description   !== undefined) this.appendProposalCard("description",  this.formDescription,  p.description);
    if (p.introduction  !== undefined) this.appendProposalCard("introduction", this.formIntroduction, p.introduction);
    if (p.aiContext     !== undefined) this.appendProposalCard("ai context",   this.formAiContext,    p.aiContext);
    if (p.restEncounterId !== undefined) this.appendProposalCard("rest encounter id", this.formRestEncounterId, p.restEncounterId);
    if (p.chapters !== undefined) {
      const fmtList = (list: Array<{ id: string; title: string; encounterId: string }>): string =>
        list.length === 0
          ? "(no chapters)"
          : list.map((c, i) => `  ${i + 1}. ${c.id} · "${c.title}" · enc=${c.encounterId}`).join("\n");
      this.appendProposalCard("chapters", fmtList(this.chapters), fmtList(p.chapters));
    }
    if (Object.keys(p).length === 0) this.appendProposalNoChangesNote();
  }

  /** Merge the pending proposal into the form state, sync the regular-tab
   *  inputs, and clear the proposal. */
  protected acceptAiProposal(): void {
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

    this.concludeAiProposalAccepted();
  }

  // ── Bottom bar ───────────────────────────────────────────────────────────

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

  private teardown(): void {
    this.disposeCreatorChrome();
    if (this.encounterPicker) { this.encounterPicker.destroy(); this.encounterPicker = null; }
    if (this.adventurePicker) { this.adventurePicker.destroy(); this.adventurePicker = null; }
  }
}
