import Phaser from "phaser";
import { gameClient, TokenExistsError } from "../net/GameClient";
import type { TokenSpec } from "../../../shared/types";
import { createHtmlButton, createHtmlText, type HtmlButtonHandle, type HtmlTextHandle } from "../ui/htmlButtons";
import { TokenPickerOverlay } from "../ui/generate/TokenPickerOverlay";
import { composeTokenSvg, composePartThumbnail, TOKEN_SLOTS, type TokenSlot } from "../ui/tokenComposer";
import { buildLineInput as sharedBuildLineInput, attachPlacement as sharedAttachPlacement } from "../ui/sceneInputs";
import {
  TILE_SIZE,
  GRID_COLS,
  GRID_ROWS,
  HUD_HEIGHT,
  PLAYER_PANEL_WIDTH,
  TARGET_PANEL_WIDTH,
} from "../constants";

/**
 * TokenCreatorScene — standalone page for assembling NPC tokens by mixing
 * SVG fragments (body / ears / face / beard / eyes / mouth / hair /
 * accessory) and three palette colours.
 *
 * Layout:
 *   • LEFT column — large live preview (256×256) of the current spec,
 *     palette pickers (body / skin / hair), ID input, RANDOMIZE button.
 *   • RIGHT column — scrollable slot picker. One section per slot showing
 *     every option as a small thumbnail; clicking selects.
 *   • BOTTOM bar — BACK, LOAD TOKEN, SAVE TOKEN.
 *
 * The composed SVG is saved through `POST /token`, which writes both the
 * flattened `data/tokens/<id>.svg` (referenced via `NPCDef.tokenAsset`) and
 * the editable `data/tokens/specs/<id>.json` so a re-open restores the
 * picks.
 */

const W = PLAYER_PANEL_WIDTH + GRID_COLS * TILE_SIZE + TARGET_PANEL_WIDTH;
const H = GRID_ROWS * TILE_SIZE + HUD_HEIGHT;

const TITLE_Y = 28;
const CONTENT_TOP = 92;
const CONTENT_BOTTOM = H - 110;
const PANEL_PAD = 40;
const COL_GAP = 28;
const LEFT_FRACTION = 0.42;
const ACCENT = "#88ccaa";

type Chrome = HtmlButtonHandle | HtmlTextHandle | { setVisible(v: boolean): void; dispose(): void };

export class TokenCreatorScene extends Phaser.Scene {
  private chrome: Chrome[] = [];
  private statusEl: HTMLDivElement | null = null;
  private busy = false;

  // Parts library — loaded once at scene boot.
  private partsBySlot: Record<string, Record<string, string>> = {};
  private catalog: Record<string, string[]> = {};

  // Current spec.
  private spec: TokenSpec = {
    id: "",
    slots: {
      body: "plain",
      ears: "round",
      face: "oval",
      beard: "none",
      eyes: "normal",
      mouth: "neutral",
      hair: "short",
      accessory: "none",
    },
    palette: { body: "#7a6a44", skin: "#e8b888", hair: "#3a2a1a" },
  };

  // DOM references (rebuilt on randomize/load).
  private previewEl: HTMLDivElement | null = null;
  private idInput: HTMLInputElement | null = null;
  private bodyColorInput: HTMLInputElement | null = null;
  private skinColorInput: HTMLInputElement | null = null;
  private hairColorInput: HTMLInputElement | null = null;
  /** Slot id → row container holding the thumb grid, so reselecting refreshes
   *  the "active" outline without re-rendering the whole picker. */
  private slotRows: Map<TokenSlot, HTMLDivElement> = new Map();
  /** Per-slot "currently selected thumb" element — held so we can flip its
   *  border colour when the user picks a different option. */
  private selectedThumbEls: Map<TokenSlot, HTMLDivElement> = new Map();

  // Overlay.
  private picker: TokenPickerOverlay | null = null;

  /** When set, BACK routes back to the named scene (and SAVE drops the saved
   *  tokenAsset path into that scene's preset). Driven by `init({ returnTo })`. */
  private returnTo: "npc-creator" | null = null;
  /** Path of the most recently saved token in this session — picked up by
   *  the BACK button as the `presetTokenAsset` payload for the return scene. */
  private lastSavedTokenAsset: string | null = null;

  constructor() {
    super({ key: "TokenCreatorScene" });
  }

  init(data?: { returnTo?: "npc-creator" }): void {
    this.chrome = [];
    this.partsBySlot = {};
    this.catalog = {};
    this.slotRows.clear();
    this.selectedThumbEls.clear();
    this.busy = false;
    this.lastSavedTokenAsset = null;
    this.returnTo = data?.returnTo ?? null;
    this.spec = {
      id: "",
      slots: { body: "plain", ears: "round", face: "oval", eyes: "normal", mouth: "neutral", hair: "short" },
      palette: { body: "#7a6a44", skin: "#e8b888", hair: "#3a2a1a" },
    };
  }

  async create(): Promise<void> {
    // WASD-capture defence (matches the other creator scenes).
    this.input.keyboard?.disableGlobalCapture();
    this.input.keyboard?.clearCaptures();

    this.add.rectangle(W / 2, H / 2, W, H, 0x0d0d1e);
    this.add.rectangle(W / 2, TITLE_Y + 38, W - 64, 1, 0x334455);

    this.chrome.push(createHtmlText({
      scene: this, sceneWidth: W,
      x: 0, y: TITLE_Y, w: W, h: 28,
      text: "TOKEN CREATOR",
      fontSize: 22, color: "#e2b96f", align: "center", letterSpacing: 1,
    }));
    this.chrome.push(createHtmlText({
      scene: this, sceneWidth: W,
      x: 0, y: TITLE_Y + 50, w: W, h: 16,
      text: "Mix and match parts to build a token. Save to disk, then reference it from any NPC's tokenAsset.",
      fontSize: 11, color: "#88aacc", align: "center",
    }));

    this.buildStatusLine();
    this.buildBottomBar();
    if (this.statusEl) this.statusEl.textContent = "Loading parts library…";

    // Fetch the parts library before laying out the columns — without it
    // we'd render zero thumbnails. The fetch is a single payload (~50KB),
    // so this is a one-shot blocking load.
    try {
      const { slots, catalog } = await gameClient.listTokenParts();
      this.partsBySlot = slots;
      this.catalog = catalog;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.statusEl) this.statusEl.textContent = `Parts library failed to load: ${msg}`;
      return;
    }

    this.buildLeftColumn();
    this.buildRightColumn();
    if (this.statusEl) this.statusEl.textContent = "";
    this.refreshPreview();

    this.events.once("shutdown", () => this.teardown());
    this.events.once("destroy",  () => this.teardown());
  }

  // ── Left column — preview + palette + id ─────────────────────────────────

  private buildLeftColumn(): void {
    const colW = Math.floor((W - PANEL_PAD * 2 - COL_GAP) * LEFT_FRACTION);
    const colX = PANEL_PAD;
    const colY = CONTENT_TOP;

    // Preview area: a 256×256 SVG drawn into a square box.
    const previewSize = Math.min(colW - 24, 256);
    const previewX = colX + (colW - previewSize) / 2;
    const previewY = colY;
    const preview = document.createElement("div");
    preview.style.cssText = `
      position: absolute;
      background: #0a0e16;
      border: 1px solid #334455;
      box-sizing: border-box;
      display: flex; align-items: center; justify-content: center;
      z-index: 9;
    `;
    document.body.appendChild(preview);
    this.previewEl = preview;
    this.attachPlacement(preview, previewX, previewY, previewSize, previewSize);
    this.chrome.push({ setVisible: (v) => { preview.style.display = v ? "" : "none"; }, dispose: () => preview.remove() });

    // Below preview: ID input + palette pickers.
    let y = previewY + previewSize + 18;

    this.chrome.push(this.makeLabel(colX, y, colW, "ID (snake_case)"));
    y += 18;
    this.idInput = this.buildLineInput(colX, y, colW, 28, "e.g. dwarf_innkeeper", (val) => {
      this.spec.id = val.trim();
    });
    y += 28 + 14;

    this.chrome.push(this.makeLabel(colX, y, colW, "PALETTE"));
    y += 18;
    const pH = 26;
    const labelW = 60;
    const swatchW = 16;
    const inputW = colW - labelW - swatchW - 8;

    const buildColorRow = (label: string, key: keyof TokenSpec["palette"], yRow: number): void => {
      this.chrome.push(createHtmlText({
        scene: this, sceneWidth: W,
        x: colX, y: yRow + 6, w: labelW, h: 14,
        text: label,
        fontSize: 11, color: "#aabbcc", align: "left", letterSpacing: 1,
      }));
      const input = this.buildLineInput(colX + labelW, yRow, inputW, pH, "#aabbcc", (val) => {
        if (!this.spec.palette) this.spec.palette = {};
        this.spec.palette[key] = val.trim() || undefined;
        this.refreshPreview();
        // Swatches reflect the current colour next to the input.
        if (key === "body" && this.bodyColorInput) this.bodyColorInput.style.background = val;
        if (key === "skin" && this.skinColorInput) this.skinColorInput.style.background = val;
        if (key === "hair" && this.hairColorInput) this.hairColorInput.style.background = val;
      });
      input.value = (this.spec.palette?.[key] as string) ?? "";
      if (key === "body") this.bodyColorInput = input;
      if (key === "skin") this.skinColorInput = input;
      if (key === "hair") this.hairColorInput = input;
      // Live colour swatch next to the input — also clickable, opens the
      // browser's native colour picker so the user can pick a hue visually
      // without typing the hex code. Changes flow back into the text input
      // and the spec via the same `oninput` plumbing.
      const swatch = document.createElement("input");
      swatch.type = "color";
      swatch.value = normaliseHex(input.value);
      swatch.style.cssText = `
        position: absolute; padding: 0; margin: 0;
        border: 1px solid #445566; background: ${input.value || "#aabbcc"};
        cursor: pointer; z-index: 10;
        -webkit-appearance: none; appearance: none;
      `;
      // Hide the default colour swatch chrome the browser draws inside the
      // input so the swatch reads as a flat coloured square.
      const styleEl = document.createElement("style");
      styleEl.textContent = `input[type="color"]::-webkit-color-swatch{border:none;padding:0;} input[type="color"]::-webkit-color-swatch-wrapper{padding:0;border:none;}`;
      if (!document.head.querySelector("style[data-token-color-swatch]")) {
        styleEl.setAttribute("data-token-color-swatch", "true");
        document.head.appendChild(styleEl);
      }
      swatch.addEventListener("input", () => {
        const hex = swatch.value;
        input.value = hex;
        if (!this.spec.palette) this.spec.palette = {};
        this.spec.palette[key] = hex;
        swatch.style.background = hex;
        this.refreshPreview();
      });
      document.body.appendChild(swatch);
      this.attachPlacement(swatch, colX + labelW + inputW + 6, yRow + 4, swatchW, pH - 8);
      this.chrome.push({ setVisible: (v) => { swatch.style.display = v ? "" : "none"; }, dispose: () => swatch.remove() });
    };
    buildColorRow("BODY", "body", y);
    y += pH + 8;
    buildColorRow("SKIN", "skin", y);
    y += pH + 8;
    buildColorRow("HAIR", "hair", y);
    y += pH + 14;

    // RANDOMIZE
    this.chrome.push(createHtmlButton({
      scene: this, sceneWidth: W,
      x: colX, y, w: colW, h: 30,
      label: "🎲 RANDOMIZE", variant: "secondary", fontSize: 11,
      onClick: () => this.randomize(),
    }));
  }

  // ── Right column — slot picker grid ─────────────────────────────────────

  private buildRightColumn(): void {
    const leftColW = Math.floor((W - PANEL_PAD * 2 - COL_GAP) * LEFT_FRACTION);
    const colX = PANEL_PAD + leftColW + COL_GAP;
    const colW = W - PANEL_PAD - colX;
    const colY = CONTENT_TOP;
    const colH = CONTENT_BOTTOM - colY;

    this.chrome.push(this.makeLabel(colX, colY, colW, "PARTS"));

    const container = document.createElement("div");
    container.style.cssText = `
      position: absolute;
      background: #0f1320;
      border: 1px solid #334455;
      box-sizing: border-box;
      padding: 8px;
      overflow-y: auto;
      z-index: 9;
      scrollbar-width: thin;
      scrollbar-color: #445566 transparent;
    `;
    document.body.appendChild(container);
    this.attachPlacement(container, colX, colY + 20, colW, colH - 20);
    this.chrome.push({ setVisible: (v) => { container.style.display = v ? "" : "none"; }, dispose: () => container.remove() });

    for (const slot of TOKEN_SLOTS) {
      this.buildSlotSection(container, slot);
    }
  }

  /** One slot row in the picker: a header line followed by a grid of small
   *  thumbnails the user can click to pick a part. A sentinel "NONE" cell is
   *  always prepended so every slot can be cleared from the UI — selecting it
   *  drops the slot from `spec.slots` entirely. */
  private buildSlotSection(host: HTMLDivElement, slot: TokenSlot): void {
    const section = document.createElement("div");
    section.style.cssText = "margin-bottom: 10px;";
    host.appendChild(section);
    const header = document.createElement("div");
    header.textContent = slot.toUpperCase();
    header.style.cssText = `
      color: ${ACCENT}; font-family: monospace; font-size: 10px;
      letter-spacing: 2px; padding: 6px 2px 4px;
      border-bottom: 1px solid #223344; margin-bottom: 6px;
    `;
    section.appendChild(header);

    const grid = document.createElement("div");
    grid.style.cssText = `
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(48px, 1fr));
      gap: 4px;
    `;
    section.appendChild(grid);
    this.slotRows.set(slot, grid);

    grid.appendChild(this.buildNoneThumbnail(slot));
    const ids = this.catalog[slot] ?? [];
    for (const id of ids) {
      if (id === "none") continue; // legacy placeholder — sentinel covers it
      const cell = this.buildPartThumbnail(slot, id);
      grid.appendChild(cell);
    }
  }

  /** Sentinel "clear this slot" thumbnail. `partId === null` is the UI's
   *  signal to omit the slot from the saved spec; the server then skips it
   *  at compose time the same as any unset slot. */
  private buildNoneThumbnail(slot: TokenSlot): HTMLDivElement {
    const cell = document.createElement("div");
    const isSelected = (): boolean => !this.spec.slots?.[slot];
    cell.title = `${slot} · none`;
    cell.style.cssText = `
      width: 100%; aspect-ratio: 1 / 1; box-sizing: border-box;
      border: 2px solid ${isSelected() ? ACCENT : "#1a1a2a"};
      background: #0a0e16;
      cursor: pointer; overflow: hidden;
      display: flex; align-items: center; justify-content: center;
      color: #556677; font-family: monospace; font-size: 9px;
      letter-spacing: 1px;
    `;
    cell.textContent = "NONE";
    cell.addEventListener("mouseenter", () => { if (!isSelected()) cell.style.borderColor = "#557788"; });
    cell.addEventListener("mouseleave", () => { if (!isSelected()) cell.style.borderColor = "#1a1a2a"; });
    cell.addEventListener("click", () => this.selectPart(slot, null, cell));
    if (isSelected()) this.selectedThumbEls.set(slot, cell);
    return cell;
  }

  private buildPartThumbnail(slot: TokenSlot, partId: string): HTMLDivElement {
    const cell = document.createElement("div");
    const isSelected = (): boolean => this.spec.slots?.[slot] === partId;
    cell.title = `${slot} · ${partId}`;
    cell.style.cssText = `
      width: 100%; aspect-ratio: 1 / 1; box-sizing: border-box;
      border: 2px solid ${isSelected() ? ACCENT : "#1a1a2a"};
      background: #0a0e16;
      cursor: pointer; overflow: hidden;
      display: flex; align-items: center; justify-content: center;
    `;
    cell.innerHTML = composePartThumbnail(slot, partId, this.partsBySlot, this.spec.palette);
    const inner = cell.firstElementChild as SVGElement | null;
    if (inner) {
      inner.setAttribute("width", "100%");
      inner.setAttribute("height", "100%");
    }
    cell.addEventListener("mouseenter", () => {
      if (!isSelected()) cell.style.borderColor = "#557788";
    });
    cell.addEventListener("mouseleave", () => {
      if (!isSelected()) cell.style.borderColor = "#1a1a2a";
    });
    cell.addEventListener("click", () => this.selectPart(slot, partId, cell));
    if (isSelected()) this.selectedThumbEls.set(slot, cell);
    return cell;
  }

  /** `partId === null` clears the slot — the spec drops the key so the
   *  server's compose loop skips it. Otherwise sets the slot to the picked
   *  part id. */
  private selectPart(slot: TokenSlot, partId: string | null, cell: HTMLDivElement): void {
    const prev = this.selectedThumbEls.get(slot);
    if (prev) prev.style.borderColor = "#1a1a2a";
    const nextSlots = { ...this.spec.slots };
    if (partId === null) delete nextSlots[slot];
    else nextSlots[slot] = partId;
    this.spec.slots = nextSlots as TokenSpec["slots"];
    cell.style.borderColor = ACCENT;
    this.selectedThumbEls.set(slot, cell);
    this.refreshPreview();
  }

  // ── Live preview render ──────────────────────────────────────────────────

  private refreshPreview(): void {
    if (!this.previewEl) return;
    this.previewEl.innerHTML = composeTokenSvg(this.spec, this.partsBySlot);
    const svg = this.previewEl.firstElementChild as SVGElement | null;
    if (svg) {
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "100%");
    }
  }

  // ── RANDOMIZE ──────────────────────────────────────────────────────────

  private randomize(): void {
    const pick = (ids: string[]): string => ids[Math.floor(Math.random() * ids.length)];
    const newSlots: Record<string, string> = {};
    for (const slot of TOKEN_SLOTS) {
      const ids = this.catalog[slot];
      if (ids?.length) newSlots[slot] = pick(ids);
    }
    // Random palette from a short curated set so the result still looks
    // intentional rather than parseInt-hex chaos.
    const bodyOpts = ["#7050a0", "#445566", "#7a6a44", "#553a22", "#221a16", "#33302a", "#445544"];
    const skinOpts = ["#f1c9a5", "#e0b083", "#d8a070", "#c89878", "#a87858", "#fbe6c8", "#fff0d8"];
    const hairOpts = ["#1a1614", "#3a2a1a", "#7a4a2a", "#a04444", "#a08050", "#dddddd", "#88ccff"];
    this.spec.palette = {
      body: pick(bodyOpts),
      skin: pick(skinOpts),
      hair: pick(hairOpts),
    };
    this.spec.slots = newSlots as TokenSpec["slots"];

    // Sync inputs + selected-thumb borders.
    if (this.bodyColorInput) { this.bodyColorInput.value = this.spec.palette.body ?? ""; this.bodyColorInput.style.background = this.spec.palette.body ?? ""; }
    if (this.skinColorInput) { this.skinColorInput.value = this.spec.palette.skin ?? ""; this.skinColorInput.style.background = this.spec.palette.skin ?? ""; }
    if (this.hairColorInput) { this.hairColorInput.value = this.spec.palette.hair ?? ""; this.hairColorInput.style.background = this.spec.palette.hair ?? ""; }
    this.reflowSelectedThumbs();
    this.refreshPreview();
  }

  /** After load/randomize the selected slot picks change wholesale — walk
   *  the picker grids and flip every thumb's border to match the new spec.
   *  Grid layout: cell 0 is the sentinel "NONE" thumbnail; cells 1..N are
   *  the catalog entries (skipping any legacy "none" placeholder so indices
   *  line up with `cellIds`). */
  private reflowSelectedThumbs(): void {
    for (const slot of TOKEN_SLOTS) {
      const grid = this.slotRows.get(slot);
      if (!grid) continue;
      const wanted = this.spec.slots?.[slot];
      this.selectedThumbEls.get(slot)?.style.setProperty("border-color", "#1a1a2a");
      this.selectedThumbEls.delete(slot);

      const noneCell = grid.children[0] as HTMLDivElement | undefined;
      if (noneCell) {
        if (!wanted) {
          noneCell.style.borderColor = ACCENT;
          this.selectedThumbEls.set(slot, noneCell);
        } else {
          noneCell.style.borderColor = "#1a1a2a";
        }
      }

      const cellIds = (this.catalog[slot] ?? []).filter((id) => id !== "none");
      cellIds.forEach((id, i) => {
        const cell = grid.children[i + 1] as HTMLDivElement | undefined;
        if (!cell) return;
        if (id === wanted) {
          cell.style.borderColor = ACCENT;
          this.selectedThumbEls.set(slot, cell);
        } else {
          cell.style.borderColor = "#1a1a2a";
        }
      });
    }
  }

  // ── LOAD flow ──────────────────────────────────────────────────────────

  private async openPicker(): Promise<void> {
    if (this.picker || this.busy) return;
    try {
      const [files, specs] = await Promise.all([gameClient.listTokens(), gameClient.listTokenSpecs()]);
      this.picker = new TokenPickerOverlay(files, specs, {
        onSelect: (id) => {
          void this.loadTokenById(id);
          this.closePicker();
        },
        onClose: () => this.closePicker(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.statusEl) this.statusEl.textContent = `Load list failed: ${msg}`;
    }
  }

  private closePicker(): void {
    if (this.picker) { this.picker.destroy(); this.picker = null; }
  }

  private async loadTokenById(id: string): Promise<void> {
    if (this.statusEl) this.statusEl.textContent = `Loading ${id}…`;
    try {
      const spec = await gameClient.loadTokenSpec(id);
      if (!spec) {
        if (this.statusEl) this.statusEl.textContent = `"${id}" has no editable spec — it's a legacy hand-authored token.`;
        return;
      }
      this.spec = spec;
      if (this.idInput) this.idInput.value = spec.id;
      if (this.bodyColorInput) { this.bodyColorInput.value = spec.palette?.body ?? ""; this.bodyColorInput.style.background = spec.palette?.body ?? "#aabbcc"; }
      if (this.skinColorInput) { this.skinColorInput.value = spec.palette?.skin ?? ""; this.skinColorInput.style.background = spec.palette?.skin ?? "#aabbcc"; }
      if (this.hairColorInput) { this.hairColorInput.value = spec.palette?.hair ?? ""; this.hairColorInput.style.background = spec.palette?.hair ?? "#aabbcc"; }
      this.reflowSelectedThumbs();
      this.refreshPreview();
      if (this.statusEl) this.statusEl.textContent = `Loaded ${id}.`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.statusEl) this.statusEl.textContent = `Load failed: ${msg}`;
    }
  }

  // ── SAVE flow ──────────────────────────────────────────────────────────

  private async runSave(overwrite = false): Promise<void> {
    if (this.busy) return;
    if (!/^[a-z0-9_]+$/.test(this.spec.id)) {
      if (this.statusEl) this.statusEl.textContent = "ID must be snake_case (lowercase letters, digits, underscores).";
      return;
    }
    this.busy = true;
    if (this.statusEl) this.statusEl.textContent = "Saving token…";
    try {
      const { tokenAsset } = await gameClient.saveToken(this.spec, { overwrite });
      this.lastSavedTokenAsset = tokenAsset;
      if (this.statusEl) {
        this.statusEl.textContent = this.returnTo === "npc-creator"
          ? `Saved ${this.spec.id}. Click BACK to return to NPC Creator and use ${tokenAsset}.`
          : `Saved ${this.spec.id}. NPC tokenAsset path: ${tokenAsset}`;
      }
    } catch (err) {
      if (err instanceof TokenExistsError) {
        this.busy = false;
        const confirmed = typeof window !== "undefined" && window.confirm(
          `A token with id "${this.spec.id}" already exists. Overwrite it?`,
        );
        if (confirmed) {
          await this.runSave(true);
          return;
        }
        if (this.statusEl) this.statusEl.textContent = `Save cancelled — token "${this.spec.id}" already exists.`;
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (this.statusEl) this.statusEl.textContent = `Save failed: ${msg}`;
    } finally {
      this.busy = false;
    }
  }

  // ── Bottom bar + status line ────────────────────────────────────────────

  private buildBottomBar(): void {
    this.add.rectangle(W / 2, H - 58, W - 64, 1, 0x334455);
    const btnH = 36;
    const y = H - 54;
    const backLabel = this.returnTo === "npc-creator" ? "↩ BACK TO NPC" : "BACK";
    const backW = this.returnTo === "npc-creator" ? 200 : 140;
    this.chrome.push(createHtmlButton({
      scene: this, sceneWidth: W,
      x: 40, y, w: backW, h: btnH,
      label: backLabel, variant: "ghost", fontSize: 13,
      onClick: () => {
        if (this.returnTo === "npc-creator") {
          this.scene.start("NpcCreatorScene", this.lastSavedTokenAsset ? { presetTokenAsset: this.lastSavedTokenAsset } : undefined);
        } else {
          this.scene.start("MainMenuScene");
        }
      },
    }));
    this.chrome.push(createHtmlButton({
      scene: this, sceneWidth: W,
      x: 200, y, w: 200, h: btnH,
      label: "📂 LOAD TOKEN", variant: "secondary", fontSize: 13,
      onClick: () => this.openPicker(),
    }));
    this.chrome.push(createHtmlButton({
      scene: this, sceneWidth: W,
      x: W - 360, y, w: 320, h: btnH,
      label: "✓ SAVE TOKEN", variant: "primary", fontSize: 14,
      onClick: () => this.runSave(),
    }));
  }

  private buildStatusLine(): void {
    const status = document.createElement("div");
    status.style.cssText = `
      position: absolute;
      color: #e2b96f; font-family: monospace; font-size: 13px;
      text-align: center; pointer-events: none; z-index: 10;
    `;
    document.body.appendChild(status);
    this.statusEl = status;
    this.attachPlacement(status, PANEL_PAD, CONTENT_BOTTOM + 14, W - PANEL_PAD * 2, 20);
  }

  // ── DOM building blocks ─────────────────────────────────────────────────

  private makeLabel(x: number, y: number, w: number, text: string): HtmlTextHandle {
    return createHtmlText({
      scene: this, sceneWidth: W,
      x, y, w, h: 14,
      text,
      fontSize: 10, color: "#778899", align: "left", letterSpacing: 1,
    });
  }

  private buildLineInput(x: number, y: number, w: number, h: number, placeholder: string, onInput: (val: string) => void): HTMLInputElement {
    const handle = sharedBuildLineInput({ scene: this, sceneWidth: W, x, y, w, h, placeholder, onInput });
    this.chrome.push(handle);
    return handle.el;
  }

  private attachPlacement(el: HTMLElement, x: number, y: number, w: number, h: number): void {
    sharedAttachPlacement(el, { scene: this, sceneWidth: W, x, y, w, h });
  }

  private teardown(): void {
    for (const c of this.chrome) c.dispose();
    this.chrome = [];
    if (this.statusEl) { this.statusEl.remove(); this.statusEl = null; }
    if (this.picker)   { this.picker.destroy(); this.picker = null; }
  }
}

/** `<input type="color">` requires a 7-character `#rrggbb` value. Normalise
 *  user-entered hex so the swatch always has a valid starting value. */
function normaliseHex(raw: string | undefined): string {
  if (!raw) return "#aabbcc";
  const s = raw.trim().replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(s) ? `#${s.toLowerCase()}` : "#aabbcc";
}
