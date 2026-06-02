import Phaser from "phaser";
import { tilesetTextureKey } from "../scenes/BootScene";
import type { SavedMapDef } from "../../../shared/types";
import { decodeTileGid, TILE_VOID_GID } from "../../../shared/tileGid";

/**
 * EmbeddedMapPreview — renders a tile map inline inside a scene rectangle,
 * with pan/zoom. No backdrop, no chrome, no buttons — the host scene owns
 * those. Replaces the modal `MapPreviewOverlay` for use cases where the
 * preview should sit alongside other UI rather than over it.
 *
 * Lifecycle:
 *   • `new EmbeddedMapPreview(scene, viewport, options?)` — mounts the grid
 *     container at the given viewport rect (scene-space). No tiles drawn
 *     until `setData` is called.
 *   • `setData(data)` — paint a map.
 *   • `setBusy(true|false)` — toggles a "Generating…" overlay.
 *   • `setVisible(v)` — show/hide the whole preview.
 *   • `destroy()` — tears down all Phaser objects + input handlers.
 */

/**
 * Author-time named zone — a free-form set of tiles the map editor user has
 * tagged with a label (e.g. "guardtower", "altar", "road"). Zones are not
 * gameplay objects; they're semantic annotations carried along with the map
 * so future encounter-generation passes can read "the altar is at (12,4)"
 * and place narrative content accordingly. Tiles in `cells` are stored as
 * `"x,y"` strings so set-membership tests stay O(1).
 */
export interface MapZone {
  id: string;
  name: string;
  /** CSS hex string assigned at creation time. Used for the translucent fill
   *  + the chip-coloured pill rendered with the zone label. */
  color: string;
  /** Tile coordinates belonging to this zone, as `"x,y"` strings. */
  cells: string[];
}

export interface MapPreviewData {
  /** Set only when the map has been persisted. Null/undefined for unsaved previews. */
  mapId?: string | null;
  width: number;
  height: number;
  terrainData: number[];
  objectData: number[];
  name: string;
  description: string;
  tilesets?: Array<{ firstgid: number; source: string }>;
  /** Optional author-time zones — see `MapZone`. The renderer paints them as
   *  translucent tile overlays with a centered label when the `zones` layer
   *  visibility flag is on. */
  zones?: MapZone[];
}

/** Per-layer visibility toggle. Defaults to all-on. The editor's LAYERS
 *  dropdown writes these flags to switch what the preview paints. */
export interface MapPreviewLayerVisibility {
  terrain: boolean;
  object: boolean;
  zones: boolean;
}

export interface MapPreviewZones {
  playerCells: Set<string>;
  enemyCells: Set<string>;
  neutralCells?: Set<string>;
  triggerRegions?: Array<{
    kind:
      | 'perception' | 'log' | 'aigm' | 'combat' | 'xp'
      | 'announcement' | 'speech' | 'fade' | 'set_flag';
    region: { x: number; y: number; w: number; h: number };
  }>;
}

const TRIGGER_COLOR: Record<NonNullable<MapPreviewZones['triggerRegions']>[number]['kind'], number> = {
  perception:   0x88ccaa,
  log:          0xc8d8e8,
  aigm:         0xe2b96f,
  combat:       0xff6644,
  xp:           0x88ccff,
  announcement: 0xf4e6c1,
  speech:       0x5588aa,
  fade:         0x222222,
  set_flag:     0xaa88ff,
};

const TILE_PX = 14;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;
const ZOOM_STEP = 1.15;

/** Scene-space viewport rectangle into which the preview renders. */
export interface PreviewViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EmbeddedMapPreviewOptions {
  zones?: MapPreviewZones;
  /** Loading message shown on the busy overlay. Defaults to "Generating…". */
  busyText?: string;
  /** Optional click-on-cell callback. Used by the Map Editor's EDIT tab to
   *  paint tiles. Fires only on a click (pointerdown+pointerup with no drag
   *  in between), not on a drag-to-pan. Coordinates are (col, row) in the
   *  source data — convertible into a `data[y*width+x]` index. */
  onCellClick?: (col: number, row: number) => void;
}

export class EmbeddedMapPreview {
  private readonly scene: Phaser.Scene;
  private readonly container: Phaser.GameObjects.Container;
  private readonly gridContainer: Phaser.GameObjects.Container;
  private readonly viewportHit: Phaser.GameObjects.Rectangle;
  private readonly busyTextEl: HTMLDivElement;
  private readonly emptyTextEl: HTMLDivElement;
  private readonly fallbackTilesetKey: string;
  private tilesetRouting: Array<{ firstgid: number; key: string }> = [];
  private viewport: PreviewViewport;
  private viewportCenterX: number;
  private viewportCenterY: number;
  private zones: MapPreviewZones | null;
  private data: MapPreviewData | null = null;
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private dragging = false;
  private dragStartPointerX = 0;
  private dragStartPointerY = 0;
  private dragStartPanX = 0;
  private dragStartPanY = 0;
  private wheelHandler: (
    pointer: Phaser.Input.Pointer,
    gameObjects: Phaser.GameObjects.GameObject[],
    deltaX: number,
    deltaY: number,
  ) => void;
  private moveHandler: (pointer: Phaser.Input.Pointer) => void;
  private upHandler: (pointer?: Phaser.Input.Pointer) => void;
  private placeHandler: () => void;
  /** Distance (in scene px) the pointer can move between down + up and still
   *  count as a click rather than a drag. Anything beyond this threshold is
   *  treated as a drag-to-pan only. */
  private static readonly CLICK_PIXEL_THRESHOLD = 4;
  private onCellClick: ((col: number, row: number) => void) | null;
  /** Per-layer visibility. All-on by default; the editor's LAYERS dropdown
   *  flips these via `setLayerVisible`. The renderer skips a layer when its
   *  flag is false, which is cheaper than re-rendering an empty data array. */
  private layerVisibility: MapPreviewLayerVisibility = { terrain: true, object: true, zones: true };
  /** HTML label badges floated over the canvas — one per visible zone.
   *  Stored as DOM divs (not Phaser text) so the labels sit ABOVE the
   *  game canvas in the page's stacking order and can use proper CSS
   *  typography. Repositioned on every pan/zoom + every grid re-render. */
  private zoneLabelEls: HTMLDivElement[] = [];
  /** Geometry computed by `renderGrid` so the HTML-label positioner has
   *  access to each label's centroid (in local container-space) and color.
   *  Cleared at the top of every `renderGrid` pass. */
  private zoneLabelLayouts: Array<{ zone: MapZone; localCx: number; localCy: number; colorNum: number }> = [];

  constructor(scene: Phaser.Scene, viewport: PreviewViewport, options: EmbeddedMapPreviewOptions = {}) {
    this.scene = scene;
    this.viewport = viewport;
    this.zones = options.zones ?? null;
    this.onCellClick = options.onCellClick ?? null;
    this.fallbackTilesetKey = pickTilesetKey(scene);
    this.viewportCenterX = viewport.x + viewport.width / 2;
    this.viewportCenterY = viewport.y + viewport.height / 2;

    this.container = scene.add.container(0, 0).setDepth(40);

    // Backing rect — subtle inset frame inside the viewport.
    const bg = scene.add.rectangle(
      this.viewportCenterX, this.viewportCenterY,
      viewport.width, viewport.height,
      0x0a0e16,
    ).setStrokeStyle(1, 0x334455);
    this.container.add(bg);

    // Wheel + drag hit target, sized to the viewport.
    this.viewportHit = scene.add.rectangle(
      this.viewportCenterX, this.viewportCenterY,
      viewport.width, viewport.height,
      0x000000, 0,
    ).setInteractive({ useHandCursor: false, draggable: false });
    this.container.add(this.viewportHit);

    this.gridContainer = scene.add.container(this.viewportCenterX, this.viewportCenterY);
    this.container.add(this.gridContainer);

    // Clip the grid to the viewport bounds.
    const maskShape = scene.make.graphics({ x: 0, y: 0 }, false);
    maskShape.fillStyle(0xffffff);
    maskShape.fillRect(viewport.x, viewport.y, viewport.width, viewport.height);
    this.gridContainer.setMask(maskShape.createGeometryMask());

    // Empty-state hint until a map is set.
    this.emptyTextEl = document.createElement("div");
    this.emptyTextEl.textContent = "No map yet — pick a mode and press GENERATE MAP.";
    this.emptyTextEl.style.cssText = `
      position: absolute;
      color: #556677; font-family: monospace; font-size: 12px;
      pointer-events: none; z-index: 8;
      display: flex; align-items: center; justify-content: center;
      text-align: center;
    `;
    document.body.appendChild(this.emptyTextEl);

    // Busy overlay — sits above the grid, hidden by default.
    this.busyTextEl = document.createElement("div");
    this.busyTextEl.textContent = options.busyText ?? "Generating…";
    this.busyTextEl.style.cssText = `
      position: absolute;
      color: #88ccaa; font-family: monospace; font-size: 14px;
      background: rgba(0, 0, 0, 0.7);
      padding: 6px 14px;
      pointer-events: none; z-index: 12;
      display: none;
      align-items: center; justify-content: center;
      text-align: center;
    `;
    document.body.appendChild(this.busyTextEl);

    this.placeHandler = () => this.placeOverlays();
    this.placeOverlays();
    scene.scale.on("resize", this.placeHandler);

    // Install pan/zoom handlers; pass through to private fields so destroy()
    // can detach.
    this.wheelHandler = (pointer, _objs, _dx, deltaY) => {
      if (!this.pointerInViewport(pointer)) return;
      const oldZoom = this.zoom;
      const factor = deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      const newZoom = Phaser.Math.Clamp(oldZoom * factor, ZOOM_MIN, ZOOM_MAX);
      if (newZoom === oldZoom) return;
      const localX = (pointer.x - this.viewportCenterX - this.panX) / oldZoom;
      const localY = (pointer.y - this.viewportCenterY - this.panY) / oldZoom;
      this.zoom = newZoom;
      this.panX = pointer.x - this.viewportCenterX - localX * newZoom;
      this.panY = pointer.y - this.viewportCenterY - localY * newZoom;
      this.applyTransform();
    };
    scene.input.on("wheel", this.wheelHandler);

    this.viewportHit.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      this.dragging = true;
      this.dragStartPointerX = pointer.x;
      this.dragStartPointerY = pointer.y;
      this.dragStartPanX = this.panX;
      this.dragStartPanY = this.panY;
    });
    this.moveHandler = (pointer: Phaser.Input.Pointer) => {
      if (!this.dragging) return;
      this.panX = this.dragStartPanX + (pointer.x - this.dragStartPointerX);
      this.panY = this.dragStartPanY + (pointer.y - this.dragStartPointerY);
      this.applyTransform();
    };
    this.upHandler = (pointer?: Phaser.Input.Pointer) => {
      if (!this.dragging) return;
      this.dragging = false;
      // If the pointer barely moved between down + up, treat as a click and
      // route through onCellClick (used by the Map Editor EDIT tab). A real
      // drag-to-pan will have moved more than the threshold and skips the
      // callback entirely.
      if (!pointer || !this.onCellClick || !this.data) return;
      const dx = pointer.x - this.dragStartPointerX;
      const dy = pointer.y - this.dragStartPointerY;
      if (Math.hypot(dx, dy) > EmbeddedMapPreview.CLICK_PIXEL_THRESHOLD) return;
      if (!this.pointerInViewport(pointer)) return;
      const cell = this.pointerToCell(pointer);
      if (!cell) return;
      this.onCellClick(cell.col, cell.row);
    };
    scene.input.on("pointermove", this.moveHandler);
    scene.input.on("pointerup", this.upHandler);
    scene.input.on("pointerupoutside", this.upHandler);
  }

  /** Convert a scene-space pointer to a (col, row) tile coordinate, or
   *  null when the pointer is outside the map's drawn area. */
  private pointerToCell(pointer: Phaser.Input.Pointer): { col: number; row: number } | null {
    if (!this.data) return null;
    const localX = (pointer.x - this.viewportCenterX - this.panX) / this.zoom;
    const localY = (pointer.y - this.viewportCenterY - this.panY) / this.zoom;
    const totalW = this.data.width * TILE_PX;
    const totalH = this.data.height * TILE_PX;
    const gridX = localX + totalW / 2;
    const gridY = localY + totalH / 2;
    if (gridX < 0 || gridY < 0 || gridX >= totalW || gridY >= totalH) return null;
    return {
      col: Math.floor(gridX / TILE_PX),
      row: Math.floor(gridY / TILE_PX),
    };
  }

  /** Replace the cell-click handler (e.g. enabled when EDIT tab activates,
   *  cleared when leaving it). */
  setOnCellClick(cb: ((col: number, row: number) => void) | null): void {
    this.onCellClick = cb;
  }

  /** Toggle one layer's visibility. Triggers an in-place re-render so the
   *  user sees the change immediately. Default state is all-true. */
  setLayerVisible(layer: keyof MapPreviewLayerVisibility, visible: boolean): void {
    if (this.layerVisibility[layer] === visible) return;
    this.layerVisibility[layer] = visible;
    this.renderGrid();
  }

  /** Snapshot of the current per-layer visibility — used by the editor's
   *  LAYERS dropdown to render the checkbox state. */
  getLayerVisibility(): MapPreviewLayerVisibility {
    return { ...this.layerVisibility };
  }

  /** Set the map currently displayed. Also resets pan/zoom and recomputes
   *  the tileset routing for the new map. */
  setData(data: MapPreviewData): void {
    this.data = data;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.applyTransform();
    this.refreshTilesetRouting(data);
    this.renderGrid();
    this.emptyTextEl.style.display = "none";
    // Fit the grid into the viewport on initial layout — the user can zoom in
    // from there. Centred and constrained so even a 30×22 map is fully visible.
    const naturalW = data.width * TILE_PX;
    const naturalH = data.height * TILE_PX;
    const fitZoom = Math.min(
      this.viewport.width  / Math.max(1, naturalW + 16),
      this.viewport.height / Math.max(1, naturalH + 16),
    );
    if (fitZoom < 1) {
      this.zoom = Math.max(ZOOM_MIN, fitZoom);
      this.applyTransform();
    }
  }

  setBusy(busy: boolean): void {
    this.busyTextEl.style.display = busy ? "flex" : "none";
  }

  /** Re-render the current map without touching pan / zoom. Used by the Map
   *  Editor's EDIT tab after each paint click — `setData` would otherwise
   *  reset the viewport on every brush stroke. The caller is responsible for
   *  having mutated the existing data reference before invoking. */
  repaintInPlace(): void {
    this.renderGrid();
  }

  setVisible(visible: boolean): void {
    this.container.setVisible(visible);
    this.busyTextEl.style.visibility = visible ? "" : "hidden";
    this.emptyTextEl.style.visibility = visible ? "" : "hidden";
    if (visible) {
      // Re-show empty-state if no data has been set.
      this.emptyTextEl.style.display = this.data ? "none" : "flex";
    }
  }

  /** Update the viewport rect (e.g. after a resize). Re-positions the grid
   *  + busy overlay accordingly. */
  setViewport(viewport: PreviewViewport): void {
    this.viewport = viewport;
    this.viewportCenterX = viewport.x + viewport.width / 2;
    this.viewportCenterY = viewport.y + viewport.height / 2;
    // The Phaser objects that depend on viewport center.
    this.viewportHit.setPosition(this.viewportCenterX, this.viewportCenterY);
    this.viewportHit.setSize(viewport.width, viewport.height);
    this.applyTransform();
    this.placeOverlays();
  }

  destroy(): void {
    this.scene.input.off("wheel", this.wheelHandler);
    this.scene.input.off("pointermove", this.moveHandler);
    this.scene.input.off("pointerup", this.upHandler);
    this.scene.input.off("pointerupoutside", this.upHandler);
    this.scene.scale.off("resize", this.placeHandler);
    this.container.destroy();
    this.busyTextEl.remove();
    this.emptyTextEl.remove();
    for (const el of this.zoneLabelEls) el.remove();
    this.zoneLabelEls = [];
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private placeOverlays(): void {
    const rect = this.scene.sys.game.canvas.getBoundingClientRect();
    const s = rect.width / this.scene.scale.width;
    const placeAt = (el: HTMLElement, vx: number, vy: number, vw: number, vh: number): void => {
      el.style.left = `${rect.left + vx * s}px`;
      el.style.top  = `${rect.top + vy * s}px`;
      el.style.width  = `${vw * s}px`;
      el.style.height = `${vh * s}px`;
      el.style.fontSize = `${12 * s}px`;
    };
    placeAt(this.emptyTextEl, this.viewport.x, this.viewport.y, this.viewport.width, this.viewport.height);
    // Centred 280×40 busy badge inside the viewport.
    const bw = 280;
    const bh = 40;
    placeAt(this.busyTextEl,
      this.viewport.x + (this.viewport.width - bw) / 2,
      this.viewport.y + (this.viewport.height - bh) / 2,
      bw, bh);
    // Window-resize → re-place every zone label too, since the canvas's
    // bounding rect (and therefore the page-space conversion) may have
    // changed without any pan/zoom delta.
    this.positionZoneLabels();
  }

  private pointerInViewport(pointer: Phaser.Input.Pointer): boolean {
    return (
      pointer.x >= this.viewport.x &&
      pointer.x <= this.viewport.x + this.viewport.width &&
      pointer.y >= this.viewport.y &&
      pointer.y <= this.viewport.y + this.viewport.height
    );
  }

  private applyTransform(): void {
    this.gridContainer.setScale(this.zoom);
    this.gridContainer.setPosition(this.viewportCenterX + this.panX, this.viewportCenterY + this.panY);
    this.positionZoneLabels();
  }

  /** Build (or refresh) one HTML div per zone-label layout entry. The divs
   *  are appended to <body> with `position: absolute` and are positioned
   *  by `positionZoneLabels`. Called once per `renderGrid` pass; the per-
   *  label position then updates on every pan/zoom via `applyTransform`. */
  private renderZoneLabels(): void {
    // Recycle existing divs when the layout count matches — avoids a
    // flicker on minor edits. Otherwise rebuild from scratch.
    if (this.zoneLabelEls.length !== this.zoneLabelLayouts.length) {
      for (const el of this.zoneLabelEls) el.remove();
      this.zoneLabelEls = [];
      for (let i = 0; i < this.zoneLabelLayouts.length; i++) {
        const el = document.createElement('div');
        el.style.cssText = `
          position: absolute; z-index: 11;
          font-family: monospace; font-size: 11px;
          letter-spacing: 1px;
          padding: 3px 8px;
          border-radius: 3px;
          pointer-events: none;
          transform: translate(-50%, -50%);
          white-space: nowrap;
          box-shadow: 0 1px 4px rgba(0,0,0,0.5);
          border: 1px solid rgba(0,0,0,0.4);
        `;
        document.body.appendChild(el);
        this.zoneLabelEls.push(el);
      }
    }
    for (let i = 0; i < this.zoneLabelLayouts.length; i++) {
      const el = this.zoneLabelEls[i];
      const { zone, colorNum } = this.zoneLabelLayouts[i];
      el.textContent = zone.name;
      el.style.background = zone.color;
      el.style.color = textColorForBg(colorNum);
    }
    this.positionZoneLabels();
  }

  /** Update every zone-label div's screen position from its local centroid,
   *  honoring the current pan/zoom and the canvas scaling factor that maps
   *  scene-space to page pixels. Clips labels that fall outside the
   *  viewport rect by hiding them — preserves the masked-grid aesthetic. */
  private positionZoneLabels(): void {
    if (this.zoneLabelLayouts.length === 0) return;
    const rect = this.scene.sys.game.canvas.getBoundingClientRect();
    const s = rect.width / this.scene.scale.width;
    const vxMin = rect.left + this.viewport.x * s;
    const vyMin = rect.top  + this.viewport.y * s;
    const vxMax = vxMin + this.viewport.width * s;
    const vyMax = vyMin + this.viewport.height * s;
    for (let i = 0; i < this.zoneLabelLayouts.length; i++) {
      const { localCx, localCy } = this.zoneLabelLayouts[i];
      // gridContainer transform: child at local (lx, ly) lands at
      //   sceneX = viewportCenterX + panX + lx * zoom
      // Convert to page-space by multiplying through the canvas scale.
      const sceneX = this.viewportCenterX + this.panX + localCx * this.zoom;
      const sceneY = this.viewportCenterY + this.panY + localCy * this.zoom;
      const pageX = rect.left + sceneX * s;
      const pageY = rect.top  + sceneY * s;
      const el = this.zoneLabelEls[i];
      if (pageX < vxMin || pageX > vxMax || pageY < vyMin || pageY > vyMax) {
        el.style.display = 'none';
      } else {
        el.style.display = '';
        el.style.left = `${pageX}px`;
        el.style.top  = `${pageY}px`;
      }
    }
  }

  private refreshTilesetRouting(data: MapPreviewData): void {
    if (data.tilesets && data.tilesets.length > 0) {
      this.tilesetRouting = [...data.tilesets]
        .map((ts) => ({ firstgid: ts.firstgid, key: tilesetTextureKey(tsetImageUrlFromSource(ts.source)) }))
        .sort((a, b) => b.firstgid - a.firstgid);
    } else {
      this.tilesetRouting = [{ firstgid: 1, key: this.fallbackTilesetKey }];
    }
  }

  private renderGrid(): void {
    const data = this.data;
    this.gridContainer.removeAll(true);
    for (const lbl of this.zoneLabelEls) lbl.remove();
    this.zoneLabelEls = [];
    this.zoneLabelLayouts = [];
    if (!data) {
      this.renderZoneLabels();
      return;
    }

    const totalW = data.width * TILE_PX;
    const totalH = data.height * TILE_PX;
    const startX = -totalW / 2;
    const startY = -totalH / 2;

    const back = this.scene.add.rectangle(0, 0, totalW + 8, totalH + 8, 0x0a0e16)
      .setStrokeStyle(1, 0x334455);
    this.gridContainer.add(back);

    const showTerrain = this.layerVisibility.terrain;
    const showObject  = this.layerVisibility.object;
    const showZones   = this.layerVisibility.zones;

    for (let y = 0; y < data.height; y++) {
      for (let x = 0; x < data.width; x++) {
        const i = y * data.width + x;
        const tx = startX + x * TILE_PX + TILE_PX / 2;
        const ty = startY + y * TILE_PX + TILE_PX / 2;
        const groundGid = data.terrainData[i];
        if (showTerrain) {
          // `!== 0` instead of `> 0`: rotated/flipped GIDs are negative
          // signed int32s (Tiled's H/V/D flag bits set on the high end).
          // Filtering them out as "empty" was hiding every rotated wall.
          if (groundGid !== 0) {
            this.drawTile(tx, ty, groundGid);
          } else {
            this.gridContainer.add(this.scene.add.rectangle(tx, ty, TILE_PX, TILE_PX, 0x556677));
          }
        } else {
          // Off-state placeholder so the grid still has visible cells when
          // the user just wants to inspect objects / zones in isolation.
          this.gridContainer.add(this.scene.add.rectangle(tx, ty, TILE_PX, TILE_PX, 0x10141c));
        }
        if (showObject) {
          const objectGid = data.objectData[i];
          if (objectGid !== 0) this.drawTile(tx, ty, objectGid);
        }

        if (this.zones) {
          const key = `${x},${y}`;
          if (this.zones.playerCells.has(key)) {
            this.gridContainer.add(this.scene.add.rectangle(tx, ty, TILE_PX, TILE_PX, 0x3388ff, 0.5));
          } else if (this.zones.enemyCells.has(key)) {
            this.gridContainer.add(this.scene.add.rectangle(tx, ty, TILE_PX, TILE_PX, 0xff4444, 0.5));
          } else if (this.zones.neutralCells?.has(key)) {
            this.gridContainer.add(this.scene.add.rectangle(tx, ty, TILE_PX, TILE_PX, 0xe2b96f, 0.5));
          }
        }
      }
    }

    // Author-time named zones — colored tile fill + perimeter outline
    // (NO per-cell internal borders) + an HTML label badge floated over
    // the canvas. Drawn AFTER tiles so the color overlay sits on top of
    // the floor. The HTML labels are positioned in `placeZoneLabels`
    // and re-positioned by `applyTransform` so they track pan/zoom.
    if (showZones && data.zones && data.zones.length > 0) {
      const zoneLayer = this.scene.add.graphics();
      for (const z of data.zones) {
        if (z.cells.length === 0) continue;
        const colorNum = parseInt(z.color.replace('#', ''), 16);
        // Solid-ish fill (alpha 0.55) so the zone's color is the dominant
        // visual signal on its tiles.
        zoneLayer.fillStyle(colorNum, 0.55);
        const inSet = new Set(z.cells);
        let sumX = 0, sumY = 0, count = 0;
        for (const cell of z.cells) {
          const [cx, cy] = cell.split(',').map(Number);
          if (cx < 0 || cy < 0 || cx >= data.width || cy >= data.height) continue;
          const rx = startX + cx * TILE_PX;
          const ry = startY + cy * TILE_PX;
          zoneLayer.fillRect(rx, ry, TILE_PX, TILE_PX);
          sumX += cx;
          sumY += cy;
          count++;
        }
        // Perimeter outline only — for each cell in the zone, stroke the
        // four edges whose neighbour is NOT also in the zone. Internal
        // shared edges between two zone cells are skipped, so the user
        // sees one continuous shape rather than a grid of bordered cells.
        zoneLayer.lineStyle(2, colorNum, 1);
        for (const cell of z.cells) {
          const [cx, cy] = cell.split(',').map(Number);
          if (cx < 0 || cy < 0 || cx >= data.width || cy >= data.height) continue;
          const rx = startX + cx * TILE_PX;
          const ry = startY + cy * TILE_PX;
          if (!inSet.has(`${cx},${cy - 1}`)) zoneLayer.lineBetween(rx, ry, rx + TILE_PX, ry);                          // N
          if (!inSet.has(`${cx},${cy + 1}`)) zoneLayer.lineBetween(rx, ry + TILE_PX, rx + TILE_PX, ry + TILE_PX);      // S
          if (!inSet.has(`${cx - 1},${cy}`)) zoneLayer.lineBetween(rx, ry, rx, ry + TILE_PX);                          // W
          if (!inSet.has(`${cx + 1},${cy}`)) zoneLayer.lineBetween(rx + TILE_PX, ry, rx + TILE_PX, ry + TILE_PX);      // E
        }
        if (count > 0) {
          const localCx = startX + ((sumX / count) + 0.5) * TILE_PX;
          const localCy = startY + ((sumY / count) + 0.5) * TILE_PX;
          this.zoneLabelLayouts.push({ zone: z, localCx, localCy, colorNum });
        }
      }
      this.gridContainer.add(zoneLayer);
    }
    this.renderZoneLabels();

    if (this.zones?.triggerRegions && this.zones.triggerRegions.length > 0) {
      const g = this.scene.add.graphics();
      for (const t of this.zones.triggerRegions) {
        const color = TRIGGER_COLOR[t.kind];
        const rx = startX + t.region.x * TILE_PX;
        const ry = startY + t.region.y * TILE_PX;
        const rw = t.region.w * TILE_PX;
        const rh = t.region.h * TILE_PX;
        g.fillStyle(color, 0.12).fillRect(rx, ry, rw, rh);
        g.lineStyle(2, color, 0.9).strokeRect(rx, ry, rw, rh);
      }
      this.gridContainer.add(g);
    }
  }

  private drawTile(tx: number, ty: number, rawGid: number): void {
    const dec = decodeTileGid(rawGid);
    if (dec.gid === TILE_VOID_GID) {
      this.gridContainer.add(this.scene.add.rectangle(tx, ty, TILE_PX, TILE_PX, 0x000000));
      return;
    }
    const owner = this.tilesetRouting.find((t) => dec.gid >= t.firstgid);
    if (!owner || !this.scene.textures.exists(owner.key)) {
      this.gridContainer.add(this.scene.add.rectangle(tx, ty, TILE_PX, TILE_PX, 0x556677));
      return;
    }
    const frame = dec.gid - owner.firstgid;
    const img = this.scene.add.image(tx, ty, owner.key, frame).setDisplaySize(TILE_PX, TILE_PX);
    if (dec.angle !== 0) img.setAngle(dec.angle);
    if (dec.flipX) img.setFlipX(true);
    if (dec.flipY) img.setFlipY(true);
    this.gridContainer.add(img);
  }
}

/** Pick a label text color that stays legible on top of an arbitrary
 *  zone-fill hex. Uses the standard luminance threshold (~0.6) — light
 *  background → black text; dark background → white. */
function textColorForBg(colorNum: number): string {
  const r = (colorNum >> 16) & 0xff;
  const g = (colorNum >>  8) & 0xff;
  const b =  colorNum        & 0xff;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#000000' : '#ffffff';
}

function tsetImageUrlFromSource(source: string): string {
  const base = (source.split("/").pop() ?? source).replace(/\.tsj$/i, ".png");
  return `/tilesets/${base}`;
}

function pickTilesetKey(scene: Phaser.Scene): string {
  const maps = (scene.registry.get("maps") as SavedMapDef[] | undefined) ?? [];
  for (const m of maps) {
    const url = m.tilesets?.[0]?.imageUrl;
    if (url) return tilesetTextureKey(url);
  }
  return tilesetTextureKey("/tilesets/roguelike.png");
}
