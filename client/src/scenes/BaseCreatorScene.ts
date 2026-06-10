import Phaser from "phaser";
import { createHtmlButton, createHtmlText, type HtmlButtonHandle, type HtmlTextHandle } from "../ui/htmlButtons";
import {
  buildLineInput as sharedBuildLineInput,
  buildSelect as sharedBuildSelect,
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
 * BaseCreatorScene — shared scaffold for the author-side creator scenes
 * (NPC Creator, Adventure Creator, Encounter Creator).
 *
 * Owns the parts every creator page repeats:
 *   • the scene backdrop, title + subtitle header, and layout constants;
 *   • the outer REGULAR / GENERATIVE AI tab bar with per-tab chrome buckets
 *     (`regularBucket` / `aiBucket`) toggled by `refreshOuterTabVisibility`;
 *   • chrome-handle tracking + bulk disposal (`chrome`, `disposeCreatorChrome`);
 *   • form-input wrappers around the shared `sceneInputs` builders;
 *   • the Generative AI propose / accept / reject panel scaffolding, the
 *     refine request flow, and the proposal-diff card rendering.
 *
 * Scenes whose layout diverges (EncounterCreatorScene's map-centric form)
 * override the hooks (`refreshOuterTabVisibility`, `buildStatusLine`,
 * `rejectAiProposal`) and skip the helpers they don't use.
 */

export const CREATOR_SCENE_WIDTH = PLAYER_PANEL_WIDTH + GRID_COLS * TILE_SIZE + TARGET_PANEL_WIDTH;
export const CREATOR_SCENE_HEIGHT = GRID_ROWS * TILE_SIZE + HUD_HEIGHT;

export const CREATOR_TITLE_Y = 28;
export const CREATOR_OUTER_TAB_Y = 92;
export const CREATOR_OUTER_TAB_H = 28;
export const CREATOR_CONTENT_TOP = 132;
export const CREATOR_CONTENT_BOTTOM = CREATOR_SCENE_HEIGHT - 110;
export const CREATOR_PANEL_PAD = 40;
export const CREATOR_COL_GAP = 28;

const W = CREATOR_SCENE_WIDTH;
const H = CREATOR_SCENE_HEIGHT;

/** Anything a creator scene needs to show/hide as one and dispose on
 *  teardown. HtmlButtonHandle / HtmlTextHandle / DomInputHandle satisfy this
 *  shape natively; raw HTMLElements are wrapped via `htmlChromeHandle`. */
export interface ChromeHandle {
  setVisible(visible: boolean): void;
  dispose(): void;
}

export function htmlChromeHandle(el: HTMLElement): ChromeHandle {
  return {
    setVisible: (v) => { el.style.display = v ? "" : "none"; },
    dispose: () => el.remove(),
  };
}

/** Sub-components expose `destroy()` instead of `dispose()` — adapt. */
export function subcomponentChromeHandle(c: { setVisible(v: boolean): void; destroy(): void }): ChromeHandle {
  return { setVisible: c.setVisible.bind(c), dispose: c.destroy.bind(c) };
}

/** Scene-specific strings for the shared Generative AI proposal panel. */
export interface AiProposalPanelText {
  promptLabel: string;
  promptPlaceholder: string;
  diffPlaceholder: string;
}

export abstract class BaseCreatorScene<Proposed extends object = object> extends Phaser.Scene {
  /** Scene-wide chrome — title, subtitle, tab buttons, bottom bar, status line. */
  protected chrome: ChromeHandle[] = [];
  /** REGULAR tab content. */
  protected regularBucket: ChromeHandle[] = [];
  /** GENERATIVE AI tab content. */
  protected aiBucket: ChromeHandle[] = [];
  protected statusEl: HTMLDivElement | null = null;
  protected busy = false;

  // Outer tab state.
  protected outerTab: "regular" | "ai" = "regular";
  protected regularTabBtn: HtmlButtonHandle | null = null;
  protected aiTabBtn: HtmlButtonHandle | null = null;

  // AI panel state.
  protected aiPromptInput: HTMLTextAreaElement | null = null;
  protected aiStatusEl: HTMLDivElement | null = null;
  protected aiDiffEl: HTMLDivElement | null = null;
  protected aiSubmitBtn: HtmlButtonHandle | null = null;
  protected aiResetBtn: HtmlButtonHandle | null = null;
  protected aiAcceptBtn: HtmlButtonHandle | null = null;
  protected aiRejectBtn: HtmlButtonHandle | null = null;
  /** Last proposal returned by the server — null when there's nothing to
   *  accept (initial state, after reject, or after accept). */
  protected aiProposal: Proposed | null = null;

  protected abstract runAiGenerate(): Promise<void>;
  protected abstract acceptAiProposal(): void;

  /** Reset every scaffold field. Call from the subclass's `init`. */
  protected resetCreatorScaffold(): void {
    this.chrome = [];
    this.regularBucket = [];
    this.aiBucket = [];
    this.outerTab = "regular";
    this.aiProposal = null;
    this.busy = false;
  }

  /** GameScene leaves global keyboard capture on for WASD movement; not
   *  clearing it would block typing W / A / S / D into any HTML input on
   *  this page. Call at the top of `create`. */
  protected clearKeyboardCaptureForHtmlInputs(): void {
    this.input.keyboard?.disableGlobalCapture();
    this.input.keyboard?.clearCaptures();
  }

  /** Backdrop, divider, page title, and subtitle — identical chrome across
   *  the creator scenes. */
  protected buildCreatorHeader(title: string, subtitle: string): void {
    this.add.rectangle(W / 2, H / 2, W, H, 0x0d0d1e);
    this.add.rectangle(W / 2, CREATOR_TITLE_Y + 38, W - 64, 1, 0x334455);
    this.chrome.push(createHtmlText({
      scene: this, sceneWidth: W,
      x: 0, y: CREATOR_TITLE_Y, w: W, h: 28,
      text: title,
      fontSize: 22, color: "#e2b96f", align: "center", letterSpacing: 1,
    }));
    this.chrome.push(createHtmlText({
      scene: this, sceneWidth: W,
      x: 0, y: CREATOR_TITLE_Y + 50, w: W, h: 16,
      text: subtitle,
      fontSize: 11, color: "#88aacc", align: "center",
    }));
  }

  // ── Outer tab bar (REGULAR / GENERATIVE AI) ─────────────────────────────

  protected buildOuterTabs(): void {
    const TAB_W = 220;
    const TAB_GAP = 8;
    const startX = (W - (TAB_W * 2 + TAB_GAP)) / 2;
    this.regularTabBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: startX, y: CREATOR_OUTER_TAB_Y, w: TAB_W, h: CREATOR_OUTER_TAB_H,
      label: "REGULAR", variant: "secondary", fontSize: 12,
      onClick: () => this.setOuterTab("regular"),
    });
    this.aiTabBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: startX + TAB_W + TAB_GAP, y: CREATOR_OUTER_TAB_Y, w: TAB_W, h: CREATOR_OUTER_TAB_H,
      label: "GENERATIVE AI", variant: "secondary", fontSize: 12,
      onClick: () => this.setOuterTab("ai"),
    });
    this.chrome.push(this.regularTabBtn, this.aiTabBtn);
    this.refreshOuterTabActiveState();
  }

  protected setOuterTab(tab: "regular" | "ai"): void {
    if (this.outerTab === tab) return;
    this.outerTab = tab;
    this.refreshOuterTabActiveState();
    this.refreshOuterTabVisibility();
  }

  protected refreshOuterTabActiveState(): void {
    if (this.regularTabBtn) this.regularTabBtn.setActive(this.outerTab === "regular");
    if (this.aiTabBtn)      this.aiTabBtn.setActive(this.outerTab === "ai");
  }

  /** Default visibility model: flip the two chrome buckets. Scenes whose
   *  tab content isn't bucket-tracked override this. */
  protected refreshOuterTabVisibility(): void {
    const isRegular = this.outerTab === "regular";
    for (const c of this.regularBucket) c.setVisible(isRegular);
    for (const c of this.aiBucket)      c.setVisible(!isRegular);
  }

  // ── Form-input building blocks ──────────────────────────────────────────

  protected makeLabel(x: number, y: number, w: number, text: string): HtmlTextHandle {
    return createHtmlText({
      scene: this, sceneWidth: W,
      x, y, w, h: 14,
      text,
      fontSize: 10, color: "#778899", align: "left", letterSpacing: 1,
    });
  }

  protected buildLineInput(x: number, y: number, w: number, h: number, placeholder: string, onInput: (val: string) => void, bucket: ChromeHandle[] = this.chrome): HTMLInputElement {
    const handle = sharedBuildLineInput({ scene: this, sceneWidth: W, x, y, w, h, placeholder, onInput });
    bucket.push(handle);
    return handle.el;
  }

  protected buildSelect(x: number, y: number, w: number, h: number, options: Array<{ value: string; label: string }>, onChange: (val: string) => void, bucket: ChromeHandle[] = this.chrome): HTMLSelectElement {
    const handle = sharedBuildSelect({ scene: this, sceneWidth: W, x, y, w, h, options, onChange });
    bucket.push(handle);
    return handle.el;
  }

  protected buildTextarea(x: number, y: number, w: number, h: number, placeholder: string, onInput: (val: string) => void, bucket: ChromeHandle[] = this.chrome): HTMLTextAreaElement {
    const handle = sharedBuildTextarea({ scene: this, sceneWidth: W, x, y, w, h, placeholder, onInput });
    bucket.push(handle);
    return handle.el;
  }

  protected buildStatusLine(): void {
    const status = document.createElement("div");
    status.style.cssText = `
      position: absolute;
      color: #e2b96f; font-family: monospace; font-size: 13px;
      text-align: center; pointer-events: none; z-index: 10;
    `;
    document.body.appendChild(status);
    this.statusEl = status;
    this.chrome.push(sharedAttachPlacement(status, { scene: this, sceneWidth: W, x: CREATOR_PANEL_PAD, y: CREATOR_CONTENT_BOTTOM + 14, w: W - CREATOR_PANEL_PAD * 2, h: 20 }));
  }

  // ── Generative AI panel ─────────────────────────────────────────────────

  /** Full-width Generative AI panel — sits in the same content rect as the
   *  REGULAR tab's columns and toggles visibility via the outer tab bar.
   *  Layout: PROMPT label + textarea on top, GENERATE / RESET row, status
   *  line, diff viewer, ACCEPT / REJECT row at the bottom. Iterative
   *  prompts feed the current form draft back to the server, so changes the
   *  user makes by hand in REGULAR are visible to the AI on the next round. */
  protected buildAiProposalPanel(text: AiProposalPanelText): void {
    const bucket = this.aiBucket;
    const x = CREATOR_PANEL_PAD;
    const w = W - CREATOR_PANEL_PAD * 2;
    const topY = CREATOR_CONTENT_TOP;
    const bottomY = CREATOR_CONTENT_BOTTOM;
    const totalH = bottomY - topY;

    const promptLabelH = 18;
    const buttonRowH = 32;
    const statusH = 20;
    const acceptRowH = 32;
    const gap = 10;
    const remaining = totalH - promptLabelH - buttonRowH - statusH - acceptRowH - gap * 4;
    const promptH = Math.max(110, Math.floor(remaining * 0.35));
    const diffH = Math.max(160, remaining - promptH);

    bucket.push(createHtmlText({
      scene: this, sceneWidth: W,
      x, y: topY, w, h: promptLabelH,
      text: text.promptLabel,
      fontSize: 10, color: "#7aadcc", align: "left", letterSpacing: 1,
    }));

    const promptY = topY + promptLabelH + 4;
    this.aiPromptInput = this.buildTextarea(
      x, promptY, w, promptH,
      text.promptPlaceholder,
      () => { /* read at submit time */ },
      bucket,
    );

    const btnRowY = promptY + promptH + gap;
    const btnW = Math.floor((w - gap) / 2);
    this.aiSubmitBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x, y: btnRowY, w: btnW, h: buttonRowH,
      label: "✨ GENERATE", variant: "primary", fontSize: 13,
      onClick: () => { void this.runAiGenerate(); },
    });
    bucket.push(this.aiSubmitBtn);
    this.aiResetBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: x + btnW + gap, y: btnRowY, w: btnW, h: buttonRowH,
      label: "RESET PROMPT", variant: "ghost", fontSize: 12,
      onClick: () => { if (this.aiPromptInput) this.aiPromptInput.value = ""; },
    });
    bucket.push(this.aiResetBtn);

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
    bucket.push(sharedAttachPlacement(this.aiStatusEl, { scene: this, sceneWidth: W, x, y: statusY, w, h: statusH }));

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
    this.aiDiffEl.textContent = text.diffPlaceholder;
    document.body.appendChild(this.aiDiffEl);
    bucket.push(sharedAttachPlacement(this.aiDiffEl, { scene: this, sceneWidth: W, x, y: diffY, w, h: diffH }));

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

  /** Shared refine request flow: validates the prompt, disables the panel
   *  buttons, calls the scene's refine endpoint, stores the proposal, and
   *  arms ACCEPT / REJECT when the proposal contains changes. */
  protected async runAiRefineRequest(opts: {
    emptyPromptMessage: string;
    refine: (prompt: string) => Promise<{ rationale: string; proposed: Proposed }>;
    renderDiff: (rationale: string, proposed: Proposed) => void;
  }): Promise<void> {
    if (this.busy) return;
    const prompt = (this.aiPromptInput?.value ?? "").trim();
    if (prompt.length < 4) {
      if (this.aiStatusEl) this.aiStatusEl.textContent = opts.emptyPromptMessage;
      return;
    }
    this.busy = true;
    this.aiSubmitBtn?.setDisabled(true);
    this.aiAcceptBtn?.setDisabled(true);
    this.aiRejectBtn?.setDisabled(true);
    if (this.aiStatusEl) this.aiStatusEl.textContent = "Asking the GM to revise the draft…";

    try {
      const result = await opts.refine(prompt);
      this.aiProposal = result.proposed;
      opts.renderDiff(result.rationale, result.proposed);
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

  // ── Proposal diff rendering ─────────────────────────────────────────────

  /** Clear the diff viewer and render the rationale header. Follow with
   *  `appendProposalCard` per changed field. */
  protected beginProposalDiff(rationale: string): void {
    if (!this.aiDiffEl) return;
    this.aiDiffEl.replaceChildren();
    const rationaleEl = document.createElement("div");
    rationaleEl.style.cssText = "color:#e2b96f;font-size:11px;letter-spacing:1px;padding:0 0 10px;border-bottom:1px solid #223344;margin-bottom:10px;";
    rationaleEl.textContent = `RATIONALE  —  ${rationale}`;
    this.aiDiffEl.appendChild(rationaleEl);
  }

  /** One field card: a small header + the BEFORE (current draft) and AFTER
   *  (proposed) values so the author can scan the diff before accepting. */
  protected appendProposalCard(label: string, before: string, after: string): void {
    if (!this.aiDiffEl) return;
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
    this.aiDiffEl.appendChild(wrap);
  }

  protected appendProposalNoChangesNote(): void {
    if (!this.aiDiffEl) return;
    const none = document.createElement("div");
    none.style.cssText = "color:#667788;font-style:italic;";
    none.textContent = "The model proposed no field changes.";
    this.aiDiffEl.appendChild(none);
  }

  /** Common epilogue after a subclass merges an accepted proposal into its
   *  form state. */
  protected concludeAiProposalAccepted(): void {
    this.aiProposal = null;
    this.aiAcceptBtn?.setDisabled(true);
    this.aiRejectBtn?.setDisabled(true);
    if (this.aiStatusEl) this.aiStatusEl.textContent = "Proposal applied. Switch to REGULAR to fine-tune, or iterate with another prompt.";
    if (this.aiDiffEl) {
      this.aiDiffEl.replaceChildren();
      this.aiDiffEl.textContent = "Proposal applied. Iterate with another prompt or switch to REGULAR to fine-tune.";
    }
  }

  protected rejectAiProposal(): void {
    this.aiProposal = null;
    this.aiAcceptBtn?.setDisabled(true);
    this.aiRejectBtn?.setDisabled(true);
    if (this.aiStatusEl) this.aiStatusEl.textContent = "Proposal discarded. Try another prompt.";
    if (this.aiDiffEl) {
      this.aiDiffEl.replaceChildren();
      this.aiDiffEl.textContent = "Proposal discarded.";
    }
  }

  /** Dispose every tracked chrome handle and clear the buckets. Call from
   *  the subclass's teardown before destroying scene-specific overlays. */
  protected disposeCreatorChrome(): void {
    for (const c of this.chrome) c.dispose();
    for (const c of this.regularBucket) c.dispose();
    for (const c of this.aiBucket) c.dispose();
    this.chrome = [];
    this.regularBucket = [];
    this.aiBucket = [];
    this.statusEl = null;
  }
}
