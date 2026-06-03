import type Phaser from "phaser";
import type { MapPreviewData } from "../EmbeddedMapPreview";
import type { TileLegendEntry } from "../../../../shared/types";
import { createHtmlButton, createHtmlText, type HtmlButtonHandle, type HtmlTextHandle } from "../htmlButtons";
import { attachPlacement as sharedAttachPlacement } from "../sceneInputs";
import { tilesetTextureKey } from "../../scenes/BootScene";

/**
 * MapPalette — owns the EDIT-tab of `MapEditorScene`. Holds the per-tile
 * selection, rotation/mirror transform, layer choice, the scrollable
 * thumbnail palette, and the paint-into-the-preview routine.
 *
 * The scene only needs to:
 *   1. `build(x, y, w, h)` when activating the EDIT tab
 *   2. forward preview cell-clicks to `paintCell(col, row)`
 *   3. call `setVisible(false)` / `dispose()` when leaving the tab
 *
 * Everything inside (chip styling, tileset routing, GID encoding, palette
 * DOM construction) is internal. Keeping it scoped here also lets future
 * EDIT-tab additions (brush size, undo, multi-tile stamps) land here instead
 * of further bloating the scene.
 */

const ACCENT = "#7aadcc";

/** Per-tileset legend payload from `GET /tilesets/legends`. Each tileset's
 *  `tiles` keys are LOCAL gids (1-based within the sheet), independent of
 *  any map's firstgid offset. Mirrors the shape MapEditorScene reads from
 *  its registry. */
export interface PerTilesetLegend {
  tileset: string;
  image: string;
  notes: string;
  tiles: Record<string, TileLegendEntry>;
}
export interface TileLegendPayload {
  tilesets: PerTilesetLegend[];
}
/** Tileset descriptor returned by `GET /tilesets`. */
export interface TilesetDescriptor {
  imageUrl: string;
  tilewidth: number;
  tileheight: number;
  margin: number;
  spacing: number;
  columns: number;
}

/** Map from a user-facing transform `"rotationDeg_mirrorH_mirrorV"` to the
 *  Tiled flip-bit prefix that the renderer's `decodeTileGid` decodes back
 *  into the matching Phaser (angle, flipX, flipY). All 16 combinations are
 *  enumerated; some produce the same orientation by definition (e.g. 0° + H
 *  + V is visually identical to 180°) and so map to the same flag bits. The
 *  high bit value is intentionally written as a signed 32-bit literal
 *  (`| 0`) so the resulting `flags | gid` expression stays inside int32 —
 *  matching how the existing reference maps store rotated GIDs on disk. */
const TRANSFORM_FLAGS: Record<string, number> = {
  "0_0_0":   0,
  "0_1_0":   (0x80000000 | 0),
  "0_0_1":   (0x40000000 | 0),
  "0_1_1":   (0xC0000000 | 0),
  "90_0_0":  (0xA0000000 | 0),
  "90_1_0":  (0x20000000 | 0),
  "90_0_1":  (0xE0000000 | 0),
  "90_1_1":  (0x60000000 | 0),
  "180_0_0": (0xC0000000 | 0),
  "180_1_0": (0x40000000 | 0),
  "180_0_1": (0x80000000 | 0),
  "180_1_1": 0,
  "270_0_0": (0x60000000 | 0),
  "270_1_0": (0xE0000000 | 0),
  "270_0_1": (0x20000000 | 0),
  "270_1_1": (0xA0000000 | 0),
};

/** Strip leading directory + trailing `.tsj` from a map's `tilesets[].source`
 *  (e.g. `../tilesets/scribble.tsj` → `"scribble"`). Used by the paint code
 *  to match a tile's tileset of origin to the entries already on the map. */
function tilesetNameFromSource(source: string): string {
  const base = source.split("/").pop() ?? source;
  return base.replace(/\.tsj$/i, "");
}

export interface MapPaletteContext {
  scene: Phaser.Scene;
  sceneWidth: number;
  /** Currently-loaded preview map. The paint routine writes into its
   *  `terrainData` / `objectData` arrays in place. Returns null when no
   *  map is loaded yet — paint becomes a no-op. */
  getMap: () => MapPreviewData | null;
  /** Tell the embedded preview to re-render against the mutated map data. */
  repaintPreview: () => void;
  /** Surface a one-line feedback message (the editor's status div). */
  setStatus: (text: string) => void;
  /** Called when the map is mutated so the scene can clear `savedMapId` and
   *  re-enable SAVE MAP. */
  markMapDirty: () => void;
  /** Sync the bottom-bar button enabled states after a mutation. */
  refreshButtons: () => void;
}

/** Disposable handle for a single piece of EDIT-tab chrome. Matches the
 *  shape MapEditorScene's per-tab bucket expects. */
export interface PaletteHandle {
  setVisible(visible: boolean): void;
  dispose(): void;
}

export class MapPalette {
  /** Name of the tileset the currently-selected tile belongs to ("scribble",
   *  "water", ...). Null when the eraser is selected. */
  private tilesetName: string | null = null;
  /** Local 1-based id within `tilesetName`. 0 when the eraser is selected. */
  private localId = 0;
  /** Which layer the next click will paint into. Auto-switches to match the
   *  selected tile's native layer when the legend has one. */
  private layer: 'terrain' | 'object' = 'terrain';
  private rotationDeg: 0 | 90 | 180 | 270 = 0;
  private mirrorH = false;
  private mirrorV = false;

  private layerChips: { terrain: HtmlButtonHandle | null; object: HtmlButtonHandle | null } = { terrain: null, object: null };
  private rotChips: Map<0 | 90 | 180 | 270, HtmlButtonHandle> = new Map();
  private mirrorHChip: HtmlButtonHandle | null = null;
  private mirrorVChip: HtmlButtonHandle | null = null;
  private selectedTileEls: Map<string, HTMLDivElement> = new Map();
  private handles: PaletteHandle[] = [];
  private paletteEl: HTMLDivElement | null = null;

  constructor(private readonly ctx: MapPaletteContext) {}

  /** Build the EDIT-tab chrome into the given scene-space rect. Returns
   *  the list of disposable handles so the caller can mass-toggle
   *  visibility / dispose at teardown. */
  build(x: number, y: number, w: number, h: number): PaletteHandle[] {
    const { scene, sceneWidth: W } = this.ctx;
    const wrap = (handle: HtmlButtonHandle | HtmlTextHandle): PaletteHandle => ({
      setVisible: (v) => handle.setVisible(v),
      dispose: () => handle.dispose(),
    });
    const push = (h: PaletteHandle): void => { this.handles.push(h); };

    push(wrap(createHtmlText({
      scene, sceneWidth: W,
      x, y, w, h: 14,
      text: "TILE PALETTE",
      fontSize: 10, color: "#556677", align: "center", letterSpacing: 2,
    })));

    const hintY = y + 22;
    push(wrap(createHtmlText({
      scene, sceneWidth: W,
      x, y: hintY, w, h: 28,
      text: "Pick a tile, then click a cell on the map to paint. Use rotation to orient walls and corners.",
      fontSize: 10, color: "#88aacc", fontFamily: "sans-serif", align: "center",
    })));

    const layerLabelY = hintY + 34;
    push(wrap(createHtmlText({
      scene, sceneWidth: W,
      x, y: layerLabelY, w, h: 14,
      text: "LAYER",
      fontSize: 10, color: "#778899", letterSpacing: 1,
    })));
    const layerRowY = layerLabelY + 18;
    const halfW = Math.floor((w - 10) / 2);
    this.layerChips.terrain = createHtmlButton({
      scene, sceneWidth: W,
      x, y: layerRowY, w: halfW, h: 26,
      label: "GROUND", variant: "secondary", fontSize: 10,
      onClick: () => { this.layer = 'terrain'; this.styleLayerChips(); },
    });
    this.layerChips.object = createHtmlButton({
      scene, sceneWidth: W,
      x: x + halfW + 10, y: layerRowY, w: halfW, h: 26,
      label: "OBJECT", variant: "secondary", fontSize: 10,
      onClick: () => { this.layer = 'object'; this.styleLayerChips(); },
    });
    push(wrap(this.layerChips.terrain));
    push(wrap(this.layerChips.object));
    this.styleLayerChips();

    const rotLabelY = layerRowY + 34;
    push(wrap(createHtmlText({
      scene, sceneWidth: W,
      x, y: rotLabelY, w, h: 14,
      text: "ROTATION",
      fontSize: 10, color: "#778899", letterSpacing: 1,
    })));
    const rotRowY = rotLabelY + 18;
    const rotW = Math.floor((w - 6) / 4) - 4;
    const rotGap = (w - 4 * rotW) / 3;
    const rotations: Array<0 | 90 | 180 | 270> = [0, 90, 180, 270];
    rotations.forEach((deg, i) => {
      const cx = x + i * (rotW + rotGap);
      const chip = createHtmlButton({
        scene, sceneWidth: W,
        x: cx, y: rotRowY, w: rotW, h: 26,
        label: deg + "°", variant: "secondary", fontSize: 11,
        onClick: () => { this.rotationDeg = deg; this.styleRotChips(); },
      });
      this.rotChips.set(deg, chip);
      push(wrap(chip));
    });
    this.styleRotChips();

    const mirrorLabelY = rotRowY + 34;
    push(wrap(createHtmlText({
      scene, sceneWidth: W,
      x, y: mirrorLabelY, w, h: 14,
      text: "MIRROR",
      fontSize: 10, color: "#778899", letterSpacing: 1,
    })));
    const mirrorRowY = mirrorLabelY + 18;
    const mirrorW = Math.floor((w - 10) / 2);
    this.mirrorHChip = createHtmlButton({
      scene, sceneWidth: W,
      x, y: mirrorRowY, w: mirrorW, h: 26,
      label: "↔ MIRROR H", variant: "secondary", fontSize: 10,
      onClick: () => { this.mirrorH = !this.mirrorH; this.styleMirrorChips(); },
    });
    this.mirrorVChip = createHtmlButton({
      scene, sceneWidth: W,
      x: x + mirrorW + 10, y: mirrorRowY, w: mirrorW, h: 26,
      label: "↕ MIRROR V", variant: "secondary", fontSize: 10,
      onClick: () => { this.mirrorV = !this.mirrorV; this.styleMirrorChips(); },
    });
    push(wrap(this.mirrorHChip));
    push(wrap(this.mirrorVChip));
    this.styleMirrorChips();

    // Scrollable thumbnail palette div.
    const paletteY = mirrorRowY + 36;
    const paletteH = Math.max(160, y + h - paletteY - 4);
    const palette = document.createElement("div");
    palette.style.cssText = `
      position: absolute;
      background: #0f1320;
      border: 1px solid #334455;
      box-sizing: border-box;
      overflow-y: auto;
      z-index: 9;
      padding: 6px;
      scrollbar-width: thin;
      scrollbar-color: #445566 transparent;
    `;
    document.body.appendChild(palette);
    this.paletteEl = palette;
    push(sharedAttachPlacement(palette, { scene, sceneWidth: W, x, y: paletteY, w, h: paletteH }));
    this.populatePalette(palette);

    return this.handles;
  }

  setVisible(visible: boolean): void {
    for (const h of this.handles) h.setVisible(visible);
  }

  dispose(): void {
    for (const h of this.handles) h.dispose();
    this.handles = [];
    this.paletteEl?.remove();
    this.paletteEl = null;
    this.layerChips = { terrain: null, object: null };
    this.rotChips.clear();
    this.mirrorHChip = null;
    this.mirrorVChip = null;
    this.selectedTileEls.clear();
  }

  /** Click handler installed on the embedded preview while the EDIT tab is
   *  active. Writes the currently-selected tile (with rotation flags) into
   *  the chosen layer's data array, then re-renders the preview so the user
   *  sees the change. SAVE MAP afterwards persists. */
  paintCell(col: number, row: number): void {
    const data = this.ctx.getMap();
    if (!data) {
      this.ctx.setStatus("Generate or load a map before painting.");
      return;
    }
    const idx = row * data.width + col;
    const gid = this.resolvePaintGid(data);
    const layerArr = this.layer === 'terrain' ? data.terrainData : data.objectData;
    if (layerArr[idx] === gid) return; // no-op
    layerArr[idx] = gid;
    this.ctx.markMapDirty();
    this.ctx.repaintPreview();
    const what = gid === 0
      ? "Cleared"
      : `Painted ${this.tilesetName} #${this.localId}`;
    const xform: string[] = [];
    if (this.rotationDeg !== 0) xform.push(`${this.rotationDeg}°`);
    if (this.mirrorH) xform.push("↔");
    if (this.mirrorV) xform.push("↕");
    const xformLabel = xform.length > 0 ? ` (${xform.join(" ")})` : "";
    this.ctx.setStatus(`${what}${xformLabel} at (${col},${row}). Press SAVE MAP to persist.`);
    this.ctx.refreshButtons();
  }

  // ── Palette population ────────────────────────────────────────────────

  private populatePalette(palette: HTMLDivElement): void {
    const legend = (this.ctx.scene.registry.get("tileLegend") as TileLegendPayload | null) ?? { tilesets: [] };
    const tilesetMetaArr = (this.ctx.scene.registry.get("tilesetMeta") as TilesetDescriptor[] | null) ?? [];
    const metaByUrl = new Map(tilesetMetaArr.map((m) => [m.imageUrl, m]));
    const disabledTiles = (this.ctx.scene.registry.get("disabledTiles") as Record<string, number[]> | null) ?? {};

    palette.appendChild(this.makeEraserEntry());

    for (const ts of legend.tilesets) {
      const meta = metaByUrl.get(ts.image);
      if (!meta) continue;
      const disabledIds = new Set(disabledTiles[ts.tileset] ?? []);
      const header = document.createElement("div");
      header.textContent = ts.tileset.toUpperCase() + " TILESET";
      header.style.cssText = `
        color: #e2b96f; font-family: monospace; font-size: 10px;
        letter-spacing: 2px; padding: 12px 4px 4px; margin-top: 6px;
        border-bottom: 1px solid #334455;
      `;
      palette.appendChild(header);

      const groundIds: number[] = [];
      const objectIds: number[] = [];
      for (const k of Object.keys(ts.tiles)) {
        const id = parseInt(k, 10);
        if (!Number.isFinite(id) || id <= 0) continue;
        if (disabledIds.has(id)) continue;
        if (ts.tiles[k].layer === 'object') objectIds.push(id);
        else groundIds.push(id);
      }
      groundIds.sort((a, b) => a - b);
      objectIds.sort((a, b) => a - b);

      const addSubsection = (title: string, ids: number[]): void => {
        if (ids.length === 0) return;
        const sub = document.createElement("div");
        sub.textContent = title;
        sub.style.cssText = `
          color: #88ccaa; font-family: monospace; font-size: 9px;
          letter-spacing: 1px; padding: 6px 4px 2px; opacity: 0.8;
        `;
        palette.appendChild(sub);
        const grid = document.createElement("div");
        grid.style.cssText = `
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(54px, 1fr));
          gap: 4px;
          padding: 4px 0 8px;
        `;
        for (const id of ids) {
          const entry = ts.tiles[String(id)];
          grid.appendChild(this.makePaletteEntry(ts, meta, id, entry.name));
        }
        palette.appendChild(grid);
      };
      addSubsection("GROUND", groundIds);
      addSubsection("OBJECT", objectIds);
    }
  }

  private makeEraserEntry(): HTMLDivElement {
    const cell = document.createElement("div");
    cell.title = "Eraser — click a cell to clear it";
    cell.style.cssText = `
      width: 100%; height: 32px; box-sizing: border-box;
      border: 2px solid #445566; background: #0a0e16;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; margin-bottom: 4px;
    `;
    const label = document.createElement("span");
    label.textContent = "ERASE";
    label.style.cssText = "color: #aabbcc; font-family: monospace; font-size: 10px; letter-spacing: 2px;";
    cell.appendChild(label);
    cell.addEventListener("mouseenter", () => {
      if (this.tilesetName !== null) cell.style.borderColor = ACCENT;
    });
    cell.addEventListener("mouseleave", () => {
      if (this.tilesetName !== null) cell.style.borderColor = "#445566";
    });
    cell.addEventListener("click", () => this.selectPaletteTile(null, 0, null));
    this.selectedTileEls.set("_eraser", cell);
    return cell;
  }

  private makePaletteEntry(
    ts: PerTilesetLegend,
    meta: TilesetDescriptor,
    localId: number,
    name: string,
  ): HTMLDivElement {
    const key = `${ts.tileset}:${localId}`;
    const cell = document.createElement("div");
    cell.title = `${ts.tileset} #${localId} — ${name}`;
    cell.style.cssText = `
      width: 100%; aspect-ratio: 1 / 1; box-sizing: border-box;
      border: 2px solid #1a1a2a;
      background: #0a0e16;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; position: relative;
      overflow: hidden;
    `;
    const isSelected = (): boolean => this.tilesetName === ts.tileset && this.localId === localId;
    cell.addEventListener("mouseenter", () => { if (!isSelected()) cell.style.borderColor = ACCENT; });
    cell.addEventListener("mouseleave", () => { if (!isSelected()) cell.style.borderColor = "#1a1a2a"; });
    cell.addEventListener("click", () => this.selectPaletteTile(ts.tileset, localId, ts.tiles[String(localId)]?.layer ?? null));
    this.selectedTileEls.set(key, cell);

    const canvas = document.createElement("canvas");
    canvas.width = 48; canvas.height = 48;
    canvas.style.cssText = "width: 100%; height: 100%; display: block;";
    cell.appendChild(canvas);
    const tkey = tilesetTextureKey(meta.imageUrl);
    const tex = this.ctx.scene.textures.get(tkey);
    const src = tex?.source[0]?.image as HTMLImageElement | undefined;
    const drawIt = (): void => this.drawTileThumbnail(
      canvas, src as HTMLImageElement, localId - 1,
      meta.tilewidth, meta.tileheight, meta.columns, meta.margin, meta.spacing,
    );
    if (src && src.complete) drawIt();
    else if (src) src.addEventListener("load", drawIt);
    return cell;
  }

  private drawTileThumbnail(
    canvas: HTMLCanvasElement,
    src: HTMLImageElement,
    frameIndex: number,
    tw: number, th: number, cols: number,
    margin: number, spacing: number,
  ): void {
    const sx = margin + (frameIndex % cols) * (tw + spacing);
    const sy = margin + Math.floor(frameIndex / cols) * (th + spacing);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(src, sx, sy, tw, th, 0, 0, canvas.width, canvas.height);
  }

  /** Set the current paint selection. `tilesetName === null` selects the
   *  eraser. Auto-switches the active layer chip to the tile's native layer
   *  per the legend's `layer` field. */
  private selectPaletteTile(tilesetName: string | null, localId: number, layer: 'ground' | 'object' | null): void {
    const prevKey = this.tilesetName === null ? "_eraser" : `${this.tilesetName}:${this.localId}`;
    const prev = this.selectedTileEls.get(prevKey);
    if (prev) prev.style.borderColor = this.tilesetName === null ? "#445566" : "#1a1a2a";

    this.tilesetName = tilesetName;
    this.localId = localId;

    const curKey = tilesetName === null ? "_eraser" : `${tilesetName}:${localId}`;
    const cur = this.selectedTileEls.get(curKey);
    if (cur) cur.style.borderColor = ACCENT;

    if (layer === 'object') this.layer = 'object';
    else if (layer === 'ground') this.layer = 'terrain';
    this.styleLayerChips();

    this.ctx.setStatus(tilesetName === null
      ? "Eraser selected — click a cell to clear it."
      : `Selected ${tilesetName} #${localId}. Click a cell to paint.`);
  }

  // ── Chip styling ──────────────────────────────────────────────────────

  private styleLayerChips(): void {
    const t = this.layerChips.terrain;
    const o = this.layerChips.object;
    if (t) {
      t.el.style.background = this.layer === 'terrain' ? "#0d2a3a" : "transparent";
      t.el.style.color = this.layer === 'terrain' ? ACCENT : "#778899";
      t.el.style.borderColor = this.layer === 'terrain' ? ACCENT : "#334455";
    }
    if (o) {
      o.el.style.background = this.layer === 'object' ? "#0d2a3a" : "transparent";
      o.el.style.color = this.layer === 'object' ? ACCENT : "#778899";
      o.el.style.borderColor = this.layer === 'object' ? ACCENT : "#334455";
    }
  }

  private styleRotChips(): void {
    for (const [deg, chip] of this.rotChips) {
      const active = this.rotationDeg === deg;
      chip.el.style.background = active ? "#0d2a3a" : "transparent";
      chip.el.style.color = active ? ACCENT : "#778899";
      chip.el.style.borderColor = active ? ACCENT : "#334455";
    }
  }

  private styleMirrorChips(): void {
    const apply = (chip: HtmlButtonHandle | null, active: boolean): void => {
      if (!chip) return;
      chip.el.style.background = active ? "#0d2a3a" : "transparent";
      chip.el.style.color = active ? ACCENT : "#778899";
      chip.el.style.borderColor = active ? ACCENT : "#334455";
    };
    apply(this.mirrorHChip, this.mirrorH);
    apply(this.mirrorVChip, this.mirrorV);
  }

  // ── Tile → encoded GID ────────────────────────────────────────────────

  private encodeRotatedGid(baseGid: number): number {
    if (baseGid === 0) return 0;
    const key = `${this.rotationDeg}_${this.mirrorH ? 1 : 0}_${this.mirrorV ? 1 : 0}`;
    const flags = TRANSFORM_FLAGS[key] ?? 0;
    return flags | baseGid;
  }

  /** Resolve the absolute paint GID from the current selection + the map's
   *  `tilesets` array. When the selected tile's tileset isn't yet referenced
   *  by the map, we auto-extend the map's tilesets list with the next
   *  available firstgid — picked at 1000-granularity past every existing
   *  entry so there's no chance of overlap with the prior tileset's tile
   *  range (the largest shipped sheet only has 154 tiles). */
  private resolvePaintGid(data: MapPreviewData): number {
    if (this.tilesetName === null || this.localId === 0) return 0;
    const mapTilesets = data.tilesets ?? (data.tilesets = []);
    let entry = mapTilesets.find((t) => tilesetNameFromSource(t.source) === this.tilesetName);
    if (!entry) {
      let firstgid: number;
      if (mapTilesets.length === 0) {
        firstgid = 1;
      } else {
        const maxExisting = mapTilesets.reduce((acc, t) => Math.max(acc, t.firstgid), 0);
        firstgid = Math.ceil((maxExisting + 1) / 1000) * 1000;
      }
      entry = { firstgid, source: `../tilesets/${this.tilesetName}.tsj` };
      mapTilesets.push(entry);
    }
    return this.encodeRotatedGid(entry.firstgid + this.localId - 1);
  }
}
