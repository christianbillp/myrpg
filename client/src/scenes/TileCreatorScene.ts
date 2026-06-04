import Phaser from "phaser";
import { gameClient, type TileLegendBlock, type TilesetMeta } from "../net/GameClient";
import type { TileLegendEntry } from "../../../shared/types";
import { rasterizeSvg, assembleSpritesheet } from "../ui/tileRaster";
import { createHtmlButton, createHtmlText, type HtmlButtonHandle, type HtmlTextHandle } from "../ui/htmlButtons";
import {
  buildLineInput as sharedBuildLineInput,
  buildTextarea as sharedBuildTextarea,
  buildSelect as sharedBuildSelect,
  attachPlacement as sharedAttachPlacement,
  type DomInputHandle,
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
 * TileCreatorScene — standalone page for authoring a tileset's per-tile
 * attributes (the global tile legend). The author picks a tileset, clicks a
 * frame from its sheet, and edits that frame's legend entry: name, layer,
 * blocksMovement, blocksSight, cover, obscurance, tags, and description.
 *
 * Layout (mirrors the Token Creator):
 *   • LEFT column — tileset picker, a large preview of the selected frame,
 *     and the attribute controls + SAVE.
 *   • RIGHT column — scrollable grid of the tiles declared in the chosen
 *     tileset's legend (not the raw spritesheet). Clicking a tile loads its
 *     current attributes for editing.
 *
 * SAVE goes through `PUT /tilesets/:tileset/tiles/:gid`, which writes the
 * entry into `<tileset>_legend.json` and reloads defs.
 */

const W = PLAYER_PANEL_WIDTH + GRID_COLS * TILE_SIZE + TARGET_PANEL_WIDTH;
const H = GRID_ROWS * TILE_SIZE + HUD_HEIGHT;

const TITLE_Y = 28;
const CONTENT_TOP = 92;
const CONTENT_BOTTOM = H - 110;
const PANEL_PAD = 40;
const COL_GAP = 28;
const LEFT_FRACTION = 0.42;
const API_HOST = "http://localhost:3000";

/** Legend keys assume the tileset is referenced at firstgid 1, so a frame's
 *  GID equals its frame index + 1 (the codebase's single configuration). */
const FRAME_TO_GID = 1;

type Chrome = HtmlButtonHandle | HtmlTextHandle | DomInputHandle<HTMLElement> | { setVisible(v: boolean): void; dispose(): void };

/** A blank entry used when the author selects a frame that has no legend
 *  entry yet. Floors are the safe default (block nothing). */
function blankEntry(): TileLegendEntry {
  return { name: "", blocksMovement: false, blocksSight: false, layer: "ground", description: "", tags: [] };
}

export class TileCreatorScene extends Phaser.Scene {
  private chrome: Chrome[] = [];
  private statusEl: HTMLDivElement | null = null;
  private busy = false;

  // Data loaded once at scene boot.
  private legends: TileLegendBlock[] = [];
  private metaByImage = new Map<string, TilesetMeta>();
  /** Tileset image (server-relative URL) → loaded <img> for canvas cropping. */
  private images = new Map<string, HTMLImageElement>();

  // Current selection.
  private activeTileset: string | null = null;
  private activeGid: number | null = null;
  private draft: TileLegendEntry = blankEntry();
  /** SVG of a just-generated, not-yet-saved tile. When set, the panel is in
   *  "generated draft" mode and SAVE writes a new tile to the `generated`
   *  tileset rather than editing an existing legend entry. */
  private genSvg: string | null = null;

  // DOM references reused across frame selections.
  private previewCanvas: HTMLCanvasElement | null = null;
  private previewLabel: HtmlTextHandle | null = null;
  private gridContainer: HTMLDivElement | null = null;
  private nameInput: HTMLInputElement | null = null;
  private layerSelect: HTMLSelectElement | null = null;
  private moveCheck: HTMLInputElement | null = null;
  private sightCheck: HTMLInputElement | null = null;
  private coverSelect: HTMLSelectElement | null = null;
  private obsSelect: HTMLSelectElement | null = null;
  private tagsInput: HTMLInputElement | null = null;
  private descInput: HTMLTextAreaElement | null = null;
  /** frame gid → its grid cell, so reselecting flips the active outline. */
  private cellEls = new Map<number, HTMLDivElement>();

  constructor() {
    super({ key: "TileCreatorScene" });
  }

  init(): void {
    this.chrome = [];
    this.legends = [];
    this.metaByImage = new Map();
    this.images = new Map();
    this.cellEls = new Map();
    this.activeTileset = null;
    this.activeGid = null;
    this.draft = blankEntry();
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
      text: "TILE CREATOR",
      fontSize: 22, color: "#e2b96f", align: "center", letterSpacing: 1,
    }));
    this.chrome.push(createHtmlText({
      scene: this, sceneWidth: W,
      x: 0, y: TITLE_Y + 50, w: W, h: 16,
      text: "Pick a tileset, click a tile, and set its attributes. Saved to the tile legend — applies to every map that uses the tileset.",
      fontSize: 11, color: "#88aacc", align: "center",
    }));

    this.buildStatusLine();
    this.buildBottomBar();
    if (this.statusEl) this.statusEl.textContent = "Loading tilesets…";

    try {
      const [{ tilesets }, meta] = await Promise.all([
        gameClient.listTileLegends(),
        gameClient.listTilesetMeta(),
      ]);
      this.legends = tilesets;
      for (const m of meta) this.metaByImage.set(m.imageUrl, m);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.statusEl) this.statusEl.textContent = `Failed to load tilesets: ${msg}`;
      return;
    }
    if (this.legends.length === 0) {
      if (this.statusEl) this.statusEl.textContent = "No tilesets found on the server.";
      return;
    }

    this.buildLeftColumn();
    this.buildRightColumn();
    this.selectTileset(this.legends[0].tileset);
    if (this.statusEl) this.statusEl.textContent = "";

    this.events.once("shutdown", () => this.teardown());
    this.events.once("destroy", () => this.teardown());
  }

  // ── Left column — tileset picker + preview + attribute controls ──────────

  private buildLeftColumn(): void {
    const colW = Math.floor((W - PANEL_PAD * 2 - COL_GAP) * LEFT_FRACTION);
    const colX = PANEL_PAD;
    let y = CONTENT_TOP;

    // Tileset picker.
    this.chrome.push(this.makeLabel(colX, y, colW, "TILESET"));
    const tilesetSelect = sharedBuildSelect({
      scene: this, sceneWidth: W, x: colX, y: y + 16, w: colW, h: 28,
      options: this.legends.map((t) => ({ value: t.tileset, label: t.tileset })),
      initialValue: this.legends[0].tileset,
      onChange: (val) => this.selectTileset(val),
    });
    this.chrome.push(tilesetSelect);
    y += 56;

    // Preview of the selected frame.
    const previewSize = Math.min(colW - 24, 192);
    const previewX = colX + (colW - previewSize) / 2;
    const canvas = document.createElement("canvas");
    canvas.width = previewSize; canvas.height = previewSize;
    canvas.style.cssText = `
      position: absolute; image-rendering: pixelated;
      background: #0a0e16; border: 1px solid #334455; z-index: 9;
    `;
    document.body.appendChild(canvas);
    this.attachPlacement(canvas, previewX, y, previewSize, previewSize);
    this.previewCanvas = canvas;
    this.previewLabel = createHtmlText({
      scene: this, sceneWidth: W,
      x: colX, y: y + previewSize + 4, w: colW, h: 14,
      text: "(no tile selected)", fontSize: 10, color: "#778899", align: "center",
    });
    this.chrome.push(this.previewLabel);
    y += previewSize + 28;

    // Attribute controls.
    const half = Math.floor((colW - 12) / 2);

    this.chrome.push(this.makeLabel(colX, y, colW, "NAME"));
    this.nameInput = this.lineInput(colX, y + 16, colW, 28, "e.g. stone_wall", (v) => { this.draft.name = v.trim(); });
    y += 50;

    this.chrome.push(this.makeLabel(colX, y, half, "LAYER"));
    const layerSel = sharedBuildSelect({
      scene: this, sceneWidth: W, x: colX, y: y + 16, w: half, h: 28,
      options: [{ value: "ground", label: "ground" }, { value: "object", label: "object" }],
      initialValue: "ground",
      onChange: (v) => { this.draft.layer = v === "object" ? "object" : "ground"; },
    });
    this.chrome.push(layerSel);
    this.layerSelect = layerSel.el;
    y += 50;

    this.moveCheck = this.checkbox(colX, y, "Blocks movement", (on) => { this.draft.blocksMovement = on; });
    this.sightCheck = this.checkbox(colX + half + 12, y, "Blocks sight", (on) => { this.draft.blocksSight = on; });
    y += 32;

    this.chrome.push(this.makeLabel(colX, y, half, "COVER"));
    const coverSel = sharedBuildSelect({
      scene: this, sceneWidth: W, x: colX, y: y + 16, w: half, h: 28,
      options: [
        { value: "", label: "none" },
        { value: "half", label: "half" },
        { value: "three-quarters", label: "three-quarters" },
        { value: "total", label: "total" },
      ],
      onChange: (v) => { if (v === "half" || v === "three-quarters" || v === "total") this.draft.cover = v; else delete this.draft.cover; },
    });
    this.chrome.push(coverSel);
    this.coverSelect = coverSel.el;
    this.chrome.push(this.makeLabel(colX + half + 12, y, half, "OBSCURANCE"));
    const obsSel = sharedBuildSelect({
      scene: this, sceneWidth: W, x: colX + half + 12, y: y + 16, w: half, h: 28,
      options: [
        { value: "", label: "none" },
        { value: "lightly", label: "lightly" },
        { value: "heavily", label: "heavily" },
      ],
      onChange: (v) => { if (v === "lightly" || v === "heavily") this.draft.obscurance = v; else delete this.draft.obscurance; },
    });
    this.chrome.push(obsSel);
    this.obsSelect = obsSel.el;
    y += 50;

    this.chrome.push(this.makeLabel(colX, y, colW, "TAGS (comma-separated)"));
    this.tagsInput = this.lineInput(colX, y + 16, colW, 28, "e.g. stone, wall, dungeon", (v) => {
      this.draft.tags = v.split(",").map((t) => t.trim()).filter(Boolean);
    });
    y += 50;

    this.chrome.push(this.makeLabel(colX, y, colW, "DESCRIPTION (shown to AI map generators)"));
    const descH = Math.max(48, CONTENT_BOTTOM - (y + 16));
    const descHandle = sharedBuildTextarea({
      scene: this, sceneWidth: W, x: colX, y: y + 16, w: colW, h: descH,
      placeholder: "What the tile looks like and how it should be used.",
      onInput: (v) => { this.draft.description = v; },
    });
    this.chrome.push(descHandle);
    this.descInput = descHandle.el;
  }

  // ── Right column — frame grid for the active tileset ─────────────────────

  private buildRightColumn(): void {
    const leftW = Math.floor((W - PANEL_PAD * 2 - COL_GAP) * LEFT_FRACTION);
    const colX = PANEL_PAD + leftW + COL_GAP;
    const colW = W - PANEL_PAD - colX;
    const colY = CONTENT_TOP;
    const colH = CONTENT_BOTTOM - colY;

    this.chrome.push(this.makeLabel(colX, colY, colW, "TILES — click to edit"));
    const container = document.createElement("div");
    container.style.cssText = `
      position: absolute; background: #0f1320; border: 1px solid #334455;
      padding: 8px; overflow-y: auto;
      display: grid; grid-template-columns: repeat(auto-fill, minmax(52px, 1fr));
      grid-auto-rows: min-content; gap: 4px; align-content: start;
      z-index: 9;
    `;
    document.body.appendChild(container);
    this.attachPlacement(container, colX, colY + 20, colW, colH - 20);
    this.gridContainer = container;
  }

  /** Switch the active tileset: (re)load its image, repaint the frame grid,
   *  and clear the current frame selection. */
  private selectTileset(tileset: string): void {
    const block = this.legends.find((t) => t.tileset === tileset);
    if (!block) return;
    this.activeTileset = tileset;
    this.activeGid = null;
    this.cellEls.clear();
    if (this.gridContainer) this.gridContainer.replaceChildren();
    if (this.previewLabel) this.previewLabel.setText("(no tile selected)");
    this.clearPreview();

    const meta = this.metaByImage.get(block.image);
    if (!meta) {
      if (this.statusEl) this.statusEl.textContent = `No slicing metadata for "${tileset}".`;
      return;
    }
    const img = this.loadImage(block.image);
    const paint = (): void => this.populateGrid(block, meta, img);
    if (img.complete && img.naturalWidth > 0) paint();
    else img.addEventListener("load", paint, { once: true });
  }

  private populateGrid(block: TileLegendBlock, meta: TilesetMeta, img: HTMLImageElement): void {
    if (!this.gridContainer) return;
    this.gridContainer.replaceChildren();
    this.cellEls.clear();
    // Only the tiles declared in the legend are shown — the grid is a view of
    // the legend, not the raw spritesheet. Grouped by layer (ground first,
    // then object), each group sorted by GID.
    const gids = Object.keys(block.tiles)
      .map(Number)
      .filter((g) => Number.isInteger(g) && g > 0)
      .sort((a, b) => a - b);
    const byLayer: Array<{ layer: "ground" | "object"; title: string }> = [
      { layer: "ground", title: "GROUND" },
      { layer: "object", title: "OBJECT" },
    ];
    for (const { layer, title } of byLayer) {
      const group = gids.filter((g) => block.tiles[String(g)].layer === layer);
      if (group.length === 0) continue;
      this.gridContainer.appendChild(this.makeLayerHeader(title));
      for (const gid of group) {
        this.gridContainer.appendChild(this.makeFrameCell(gid, gid - FRAME_TO_GID, meta, img, block.tiles[String(gid)]));
      }
    }
  }

  /** Full-width section header that spans the whole grid row. */
  private makeLayerHeader(title: string): HTMLDivElement {
    const header = document.createElement("div");
    header.textContent = title;
    header.style.cssText = `
      grid-column: 1 / -1;
      color: #88ccaa; font-family: monospace; font-size: 10px;
      letter-spacing: 2px; padding: 6px 2px 2px; opacity: 0.85;
    `;
    return header;
  }

  private makeFrameCell(gid: number, frame: number, meta: TilesetMeta, img: HTMLImageElement, entry: TileLegendEntry): HTMLDivElement {
    const cell = document.createElement("div");
    cell.title = `#${gid} — ${entry.name}`;
    cell.style.cssText = `
      width: 100%; aspect-ratio: 1 / 1; box-sizing: border-box;
      border: 2px solid #33415a;
      background: #0a0e16; cursor: pointer; overflow: hidden;
      position: relative;
    `;
    const canvas = document.createElement("canvas");
    canvas.width = 48; canvas.height = 48;
    canvas.style.cssText = "width: 100%; height: 100%; display: block; image-rendering: pixelated;";
    cell.appendChild(canvas);
    this.drawFrame(canvas, img, frame, meta);
    cell.addEventListener("click", () => this.selectFrame(gid, cell));
    this.cellEls.set(gid, cell);
    return cell;
  }

  /** Load a frame's entry (or defaults) into the editor controls. */
  private selectFrame(gid: number, cell: HTMLDivElement): void {
    this.genSvg = null; // editing an existing tile cancels any generated draft
    // Repaint the previous selection's border back to the resting colour.
    if (this.activeGid !== null) {
      const prev = this.cellEls.get(this.activeGid);
      if (prev) prev.style.borderColor = "#33415a";
    }
    cell.style.borderColor = "#88ccaa";
    this.activeGid = gid;

    const block = this.legends.find((t) => t.tileset === this.activeTileset);
    const existing = block?.tiles[String(gid)];
    this.draft = existing ? { ...existing, tags: [...existing.tags] } : blankEntry();

    // Push values into the controls.
    if (this.nameInput) this.nameInput.value = this.draft.name;
    if (this.layerSelect) this.layerSelect.value = this.draft.layer;
    if (this.moveCheck) this.moveCheck.checked = this.draft.blocksMovement;
    if (this.sightCheck) this.sightCheck.checked = this.draft.blocksSight;
    if (this.coverSelect) this.coverSelect.value = this.draft.cover ?? "";
    if (this.obsSelect) this.obsSelect.value = this.draft.obscurance ?? "";
    if (this.tagsInput) this.tagsInput.value = this.draft.tags.join(", ");
    if (this.descInput) this.descInput.value = this.draft.description;

    if (this.previewLabel) this.previewLabel.setText(`${this.activeTileset} · GID ${gid}`);
    this.paintPreview(gid);
    if (this.statusEl) this.statusEl.textContent = existing ? "" : "New tile — set its attributes and SAVE.";
  }

  private async runSave(): Promise<void> {
    if (this.busy) return;
    if (this.activeTileset === null || this.activeGid === null) {
      if (this.statusEl) this.statusEl.textContent = "Select a tile first.";
      return;
    }
    if (!this.draft.name.trim()) {
      if (this.statusEl) this.statusEl.textContent = "Name is required.";
      return;
    }
    this.busy = true;
    if (this.statusEl) this.statusEl.textContent = "Saving tile…";
    try {
      await gameClient.saveTileEntry(this.activeTileset, this.activeGid, this.draft);
      // Reflect the save in our local cache + grid outline.
      const block = this.legends.find((t) => t.tileset === this.activeTileset);
      if (block) block.tiles[String(this.activeGid)] = { ...this.draft, tags: [...this.draft.tags] };
      if (this.statusEl) this.statusEl.textContent = `Saved ${this.activeTileset} GID ${this.activeGid} (“${this.draft.name}”).`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.statusEl) this.statusEl.textContent = `Save failed: ${msg}`;
    } finally {
      this.busy = false;
    }
  }

  // ── Tile generation ──────────────────────────────────────────────────────

  /** Generate a tile from the DESCRIPTION field (used as the prompt). Stores
   *  the SVG as a draft, fills the attribute controls from the AIGM's
   *  suggestion, and previews it. SAVE then writes it to `generated`. */
  private async generateFromPrompt(): Promise<void> {
    if (this.busy) return;
    const prompt = this.draft.description.trim();
    if (!prompt) {
      if (this.statusEl) this.statusEl.textContent = "Type a DESCRIPTION first — it's the prompt.";
      return;
    }
    this.busy = true;
    if (this.statusEl) this.statusEl.textContent = "Generating tile…";
    try {
      const { svg, suggested } = await gameClient.generateTile(prompt);
      this.genSvg = svg;
      this.activeGid = null;
      this.applySuggested(suggested);
      await this.paintSvgPreview(svg);
      if (this.previewLabel) this.previewLabel.setText("✦ GENERATED (unsaved)");
      if (this.statusEl) this.statusEl.textContent = "Generated — review attributes and SAVE.";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.statusEl) this.statusEl.textContent = `Generation failed: ${msg}`;
    } finally {
      this.busy = false;
    }
  }

  /** Push an AIGM-suggested entry into the draft + every attribute control. */
  private applySuggested(s: TileLegendEntry): void {
    this.draft = { ...s, tags: [...(s.tags ?? [])] };
    if (this.nameInput) this.nameInput.value = this.draft.name;
    if (this.layerSelect) this.layerSelect.value = this.draft.layer;
    if (this.moveCheck) this.moveCheck.checked = this.draft.blocksMovement;
    if (this.sightCheck) this.sightCheck.checked = this.draft.blocksSight;
    if (this.coverSelect) this.coverSelect.value = this.draft.cover ?? "";
    if (this.obsSelect) this.obsSelect.value = this.draft.obscurance ?? "";
    if (this.tagsInput) this.tagsInput.value = this.draft.tags.join(", ");
    if (this.descInput) this.descInput.value = this.draft.description;
  }

  /** Rasterise the draft SVG into the preview canvas. */
  private async paintSvgPreview(svg: string): Promise<void> {
    if (!this.previewCanvas) return;
    const size = this.previewCanvas.width;
    const frame = await rasterizeSvg(svg, size);
    const ctx = this.previewCanvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(frame, 0, 0);
  }

  /** Persist the generated draft: re-rasterise every existing generated tile
   *  plus this one into the shared spritesheet and upload it with the legend
   *  entry. Reloads the scene so the new tile shows in the picker + grid. */
  private async saveGenerated(): Promise<void> {
    if (this.busy || !this.genSvg) return;
    if (!this.draft.name.trim()) {
      if (this.statusEl) this.statusEl.textContent = "Name is required.";
      return;
    }
    this.busy = true;
    if (this.statusEl) this.statusEl.textContent = "Assembling + saving generated tile…";
    try {
      const { tiles, tileSize, columns } = await gameClient.listGeneratedTiles();
      const svgs = [...tiles.map((t) => t.svg), this.genSvg];
      const pngBase64 = await assembleSpritesheet(svgs, tileSize, columns);
      const { gid } = await gameClient.saveGeneratedTile({ svg: this.genSvg, entry: this.draft, pngBase64 });
      this.genSvg = null;
      if (this.statusEl) this.statusEl.textContent = `Saved generated tile “${this.draft.name}” (gid ${gid}). Reloading…`;
      this.time.delayedCall(600, () => this.scene.restart());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.statusEl) this.statusEl.textContent = `Save failed: ${msg}`;
    } finally {
      this.busy = false;
    }
  }

  // ── Canvas cropping ──────────────────────────────────────────────────────

  private drawFrame(canvas: HTMLCanvasElement, img: HTMLImageElement, frame: number, meta: TilesetMeta): void {
    const sx = meta.margin + (frame % meta.columns) * (meta.tilewidth + meta.spacing);
    const sy = meta.margin + Math.floor(frame / meta.columns) * (meta.tileheight + meta.spacing);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, sx, sy, meta.tilewidth, meta.tileheight, 0, 0, canvas.width, canvas.height);
  }

  private paintPreview(gid: number): void {
    const block = this.legends.find((t) => t.tileset === this.activeTileset);
    if (!block || !this.previewCanvas) return;
    const meta = this.metaByImage.get(block.image);
    const img = this.images.get(block.image);
    if (!meta || !img) return;
    this.drawFrame(this.previewCanvas, img, gid - FRAME_TO_GID, meta);
  }

  private clearPreview(): void {
    const ctx = this.previewCanvas?.getContext("2d");
    if (ctx && this.previewCanvas) ctx.clearRect(0, 0, this.previewCanvas.width, this.previewCanvas.height);
  }

  private loadImage(serverUrl: string): HTMLImageElement {
    const cached = this.images.get(serverUrl);
    if (cached) return cached;
    const img = new Image();
    // The `generated` sheet is rewritten on every save, so bust the cache for
    // it (other tilesets are static and cache fine).
    const bust = serverUrl.includes("generated") ? `?v=${Date.now()}` : "";
    img.src = `${API_HOST}${serverUrl}${bust}`;
    this.images.set(serverUrl, img);
    return img;
  }

  // ── Chrome ───────────────────────────────────────────────────────────────

  private buildBottomBar(): void {
    this.add.rectangle(W / 2, H - 58, W - 64, 1, 0x334455);
    const btnH = 36;
    const y = H - 54;
    this.chrome.push(createHtmlButton({
      scene: this, sceneWidth: W,
      x: 40, y, w: 140, h: btnH,
      label: "BACK", variant: "ghost", fontSize: 13,
      onClick: () => this.scene.start("MainMenuScene"),
    }));
    // ✦ GENERATE — uses the DESCRIPTION field as the prompt; the AIGM returns
    // an SVG tile + suggested attributes for review.
    this.chrome.push(createHtmlButton({
      scene: this, sceneWidth: W,
      x: W - 560, y, w: 180, h: btnH,
      label: "✦ GENERATE", variant: "warn", fontSize: 13,
      onClick: () => void this.generateFromPrompt(),
    }));
    this.chrome.push(createHtmlButton({
      scene: this, sceneWidth: W,
      x: W - 360, y, w: 320, h: btnH,
      label: "✓ SAVE TILE", variant: "primary", fontSize: 14,
      // Generated draft → write a new tile to the `generated` tileset; an
      // existing selected frame → save its legend entry.
      onClick: () => void (this.genSvg ? this.saveGenerated() : this.runSave()),
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

  private makeLabel(x: number, y: number, w: number, text: string): HtmlTextHandle {
    return createHtmlText({
      scene: this, sceneWidth: W, x, y, w, h: 14,
      text, fontSize: 10, color: "#778899", align: "left", letterSpacing: 1,
    });
  }

  private lineInput(x: number, y: number, w: number, h: number, placeholder: string, onInput: (v: string) => void): HTMLInputElement {
    const handle = sharedBuildLineInput({ scene: this, sceneWidth: W, x, y, w, h, placeholder, onInput });
    this.chrome.push(handle);
    return handle.el;
  }

  /** A labelled checkbox positioned at scene coords. Returns the input so
   *  callers can set `.checked` when a frame loads. */
  private checkbox(x: number, y: number, label: string, onChange: (on: boolean) => void): HTMLInputElement {
    const wrap = document.createElement("label");
    wrap.style.cssText = `
      position: absolute; display: flex; align-items: center; gap: 6px;
      color: #bbccdd; font-family: monospace; font-size: 11px; cursor: pointer;
      z-index: 10;
    `;
    const box = document.createElement("input");
    box.type = "checkbox";
    box.style.cssText = "width: 15px; height: 15px; accent-color: #88ccaa; cursor: pointer;";
    box.addEventListener("change", () => onChange(box.checked));
    const span = document.createElement("span");
    span.textContent = label;
    wrap.appendChild(box);
    wrap.appendChild(span);
    document.body.appendChild(wrap);
    this.attachPlacement(wrap, x, y, 180, 24);
    return box;
  }

  private attachPlacement(el: HTMLElement, x: number, y: number, w: number, h: number): void {
    const handle = sharedAttachPlacement(el, { scene: this, sceneWidth: W, x, y, w, h });
    this.chrome.push(handle);
  }

  private teardown(): void {
    for (const c of this.chrome) c.dispose();
    this.chrome = [];
    if (this.statusEl) { this.statusEl.remove(); this.statusEl = null; }
    if (this.previewCanvas) { this.previewCanvas.remove(); this.previewCanvas = null; }
    if (this.gridContainer) { this.gridContainer.remove(); this.gridContainer = null; }
  }
}
