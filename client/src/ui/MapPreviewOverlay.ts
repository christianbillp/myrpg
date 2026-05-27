import Phaser from "phaser";
import { tilesetTextureKey } from "../scenes/BootScene";
import type { SavedMapDef } from "../net/types";
import { decodeTileGid, TILE_VOID_GID } from "../../../shared/tileGid";

export interface MapPreviewData {
  /** Set only when the map has been persisted (by `/generate/map/save`). Null/undefined for unsaved previews. */
  mapId?: string | null;
  width: number;
  height: number;
  terrainData: number[];
  objectData: number[];
  name: string;
  description: string;
  /** Tileset references the data uses. Carried through from the composer so a save call can preserve them. */
  tilesets?: Array<{ firstgid: number; source: string }>;
}

export interface MapPreviewZones {
  /** Cell keys formatted as `"x,y"` — player-start cells, rendered as a blue overlay. */
  playerCells: Set<string>;
  /** Cell keys formatted as `"x,y"` — enemy-start cells, rendered as a red overlay. */
  enemyCells: Set<string>;
  /** Cell keys formatted as `"x,y"` — neutral-NPC cells, rendered as an amber overlay. */
  neutralCells?: Set<string>;
  /** Trigger regions rendered as colour-coded outlined rectangles on top of the grid. */
  triggerRegions?: Array<{
    kind: 'perception' | 'log' | 'aigm' | 'combat';
    region: { x: number; y: number; w: number; h: number };
  }>;
}

export interface MapPreviewOptions {
  /** Optional starting-zone overlays drawn on top of the grid. */
  zones?: MapPreviewZones;
}

/**
 * In-scene preview of a freshly generated map. Renders the actual tileset
 * sprites at a reduced per-tile size so the player can eyeball the layout
 * before committing. The overlay lives inside the spawning scene as a
 * `Phaser.GameObjects.Container` (rather than an HTML BaseOverlay) because
 * it needs to use the preloaded tileset spritesheet textures.
 *
 * Lifecycle:
 *   • `new MapPreviewOverlay(scene, data, { onRegenerate, onClose })` —
 *     mounts and renders.
 *   • `update(newData)` — replaces the rendered map (used by REGENERATE).
 *   • `setBusy(true|false)` — toggles a "Regenerating…" overlay on the grid.
 *   • `destroy()` — tears down all Phaser objects in the container.
 */
/** Per-kind outline colour for trigger-region overlays. Matches `ZonePainter.TRIGGER_COLOR`. */
const TRIGGER_COLOR: Record<'perception' | 'log' | 'aigm' | 'combat', number> = {
  perception: 0x88ccaa,
  log:        0xc8d8e8,
  aigm:       0xe2b96f,
  combat:     0xff6644,
};

const PANEL_W = 1100;
const PANEL_H = 700;
const PREVIEW_AREA_H = 440;
const PREVIEW_AREA_W = PANEL_W - 80;
const TILE_PX = 14;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;
const ZOOM_STEP = 1.15;

export class MapPreviewOverlay {
  private readonly scene: Phaser.Scene;
  private readonly container: Phaser.GameObjects.Container;
  private readonly gridContainer: Phaser.GameObjects.Container;
  private readonly nameText: Phaser.GameObjects.Text;
  private readonly descText: Phaser.GameObjects.Text;
  private readonly busyText: Phaser.GameObjects.Text;
  private readonly regenBg: Phaser.GameObjects.Rectangle | null;
  private readonly regenLabel: Phaser.GameObjects.Text | null;
  private readonly saveBg: Phaser.GameObjects.Rectangle | null;
  private readonly saveLabel: Phaser.GameObjects.Text | null;
  private readonly savedAsText: Phaser.GameObjects.Text;
  private saved = false;
  /** The fallback single-tileset key, used when a map carries no `tilesets[]` (legacy AI previews). */
  private readonly fallbackTilesetKey: string;
  /** The current map's per-tileset key + firstgid, sorted by descending firstgid so a GID lookup picks the highest firstgid ≤ gid. */
  private tilesetRouting: Array<{ firstgid: number; key: string }> = [];
  private readonly viewportCenterX: number;
  private readonly viewportCenterY: number;
  private readonly zones: MapPreviewZones | null;
  private viewportHit!: Phaser.GameObjects.Rectangle;
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private dragging = false;
  private dragStartPointerX = 0;
  private dragStartPointerY = 0;
  private dragStartPanX = 0;
  private dragStartPanY = 0;
  private wheelHandler?: (
    pointer: Phaser.Input.Pointer,
    gameObjects: Phaser.GameObjects.GameObject[],
    deltaX: number,
    deltaY: number,
  ) => void;
  private moveHandler?: (pointer: Phaser.Input.Pointer) => void;
  private upHandler?: () => void;

  constructor(
    scene: Phaser.Scene,
    initial: MapPreviewData,
    callbacks: { onClose: () => void; onRegenerate?: () => void; onSave?: () => void },
    options?: MapPreviewOptions,
  ) {
    this.scene = scene;
    this.zones = options?.zones ?? null;
    const w = scene.scale.width;
    const h = scene.scale.height;

    this.fallbackTilesetKey = pickTilesetKey(scene);
    this.refreshTilesetRouting(initial);

    this.container = scene.add.container(0, 0).setDepth(1000);

    // Backdrop
    const backdrop = scene.add.rectangle(w / 2, h / 2, w, h, 0x000000, 0.75)
      .setInteractive();
    backdrop.on("pointerdown", () => { /* swallow clicks behind the panel */ });
    this.container.add(backdrop);

    // Panel
    const panel = scene.add.rectangle(w / 2, h / 2, PANEL_W, PANEL_H, 0x141426)
      .setStrokeStyle(2, 0x88ccaa);
    this.container.add(panel);

    const top = h / 2 - PANEL_H / 2;
    const left = w / 2 - PANEL_W / 2;

    // Header
    const headerTag = scene.add.text(w / 2, top + 22, "MAP PREVIEW", {
      fontSize: "11px", color: "#88ccaa", fontFamily: "monospace", letterSpacing: 2,
    }).setOrigin(0.5, 0);
    this.container.add(headerTag);

    this.nameText = scene.add.text(w / 2, top + 42, initial.name, {
      fontSize: "20px", color: "#e8e8f8", fontFamily: "monospace",
    }).setOrigin(0.5, 0);
    this.container.add(this.nameText);

    this.descText = scene.add.text(w / 2, top + 72, initial.description, {
      fontSize: "12px", color: "#aabbcc", fontFamily: "monospace",
      align: "center", wordWrap: { width: PANEL_W - 80 },
    }).setOrigin(0.5, 0);
    this.container.add(this.descText);

    // Preview area (centered group of tile images)
    this.viewportCenterX = w / 2;
    this.viewportCenterY = top + 110 + PREVIEW_AREA_H / 2;

    // Invisible hit-target sized to the preview viewport. Catches wheel +
    // drag events so the user can zoom around the cursor and pan the grid.
    // Sits *above* the panel but *below* the grid so the grid still renders
    // on top — we manually re-add it after the grid container.
    this.viewportHit = scene.add.rectangle(
      this.viewportCenterX, this.viewportCenterY,
      PREVIEW_AREA_W, PREVIEW_AREA_H,
      0x000000, 0,
    ).setInteractive({ useHandCursor: false, draggable: false });
    this.container.add(this.viewportHit);

    this.gridContainer = scene.add.container(this.viewportCenterX, this.viewportCenterY);
    this.container.add(this.gridContainer);

    // Clip the grid container to the viewport bounds so panning/zooming
    // doesn't spill tiles past the preview area onto the panel chrome.
    const maskShape = scene.make.graphics({ x: 0, y: 0 }, false);
    maskShape.fillStyle(0xffffff);
    maskShape.fillRect(
      this.viewportCenterX - PREVIEW_AREA_W / 2,
      this.viewportCenterY - PREVIEW_AREA_H / 2,
      PREVIEW_AREA_W, PREVIEW_AREA_H,
    );
    this.gridContainer.setMask(maskShape.createGeometryMask());

    this.installZoomPanHandlers();

    this.renderGrid(initial);

    this.busyText = scene.add.text(w / 2, top + 110 + PREVIEW_AREA_H / 2, "Regenerating…", {
      fontSize: "14px", color: "#88ccaa", fontFamily: "monospace",
      backgroundColor: "rgba(0,0,0,0.7)", padding: { x: 14, y: 8 },
    }).setOrigin(0.5).setVisible(false);
    this.container.add(this.busyText);

    // Buttons row. Layout adapts to which callbacks were supplied —
    // view-only mode (no onRegenerate, no onSave) shows only a single
    // centred CLOSE button; the full editor (regenerate + save + close)
    // spreads three buttons across the bottom.
    const buttonY = top + PANEL_H - 50;
    const showSave  = !!callbacks.onSave;
    const showRegen = !!callbacks.onRegenerate;
    const buttonsCenter = left + PANEL_W / 2;

    if (showRegen) {
      const regenX = showSave ? buttonsCenter - 240 : buttonsCenter - 130;
      this.regenBg = scene.add.rectangle(regenX, buttonY, 220, 40, 0x1a3a2a)
        .setStrokeStyle(2, 0x2a6655).setInteractive({ useHandCursor: true });
      this.regenLabel = scene.add.text(regenX, buttonY, "↻ REGENERATE", {
        fontSize: "13px", color: "#ffe9a8", fontFamily: "monospace",
      }).setOrigin(0.5);
      this.regenBg.on("pointerdown", () => callbacks.onRegenerate!());
      this.container.add(this.regenBg);
      this.container.add(this.regenLabel);
    } else {
      this.regenBg = null;
      this.regenLabel = null;
    }

    if (showSave) {
      const saveX = showRegen ? buttonsCenter : buttonsCenter - 130;
      this.saveBg = scene.add.rectangle(saveX, buttonY, 220, 40, 0x2a3a55)
        .setStrokeStyle(2, 0x5588aa).setInteractive({ useHandCursor: true });
      this.saveLabel = scene.add.text(saveX, buttonY, "✓ SAVE", {
        fontSize: "13px", color: "#cce4ff", fontFamily: "monospace",
      }).setOrigin(0.5);
      this.saveBg.on("pointerdown", () => {
        if (this.saved) return;
        callbacks.onSave!();
      });
      this.container.add(this.saveBg);
      this.container.add(this.saveLabel);
    } else {
      this.saveBg = null;
      this.saveLabel = null;
    }

    // CLOSE always exists. Position depends on what's beside it.
    const closeX = (showRegen && showSave) ? buttonsCenter + 240
                 : (showRegen || showSave) ? buttonsCenter + 130
                 : buttonsCenter;
    const closeBg = scene.add.rectangle(closeX, buttonY, 220, 40, 0x222233)
      .setStrokeStyle(2, 0x556677).setInteractive({ useHandCursor: true });
    const closeLabel = scene.add.text(closeX, buttonY, "CLOSE", {
      fontSize: "13px", color: "#aabbcc", fontFamily: "monospace",
    }).setOrigin(0.5);
    closeBg.on("pointerdown", () => callbacks.onClose());
    this.container.add(closeBg);
    this.container.add(closeLabel);

    // "Saved as gen_..." footnote — hidden until the user clicks SAVE.
    this.savedAsText = scene.add.text(w / 2, buttonY - 30, "", {
      fontSize: "10px", color: "#556677", fontFamily: "monospace",
    }).setOrigin(0.5).setVisible(false);
    this.container.add(this.savedAsText);
  }

  /** Lock the SAVE button into a "✓ SAVED" disabled state. Cleared by `update`. */
  markSaved(mapId: string): void {
    this.saved = true;
    if (this.saveBg && this.saveLabel) {
      this.saveBg.disableInteractive();
      this.saveBg.setFillStyle(0x1a2222);
      this.saveBg.setStrokeStyle(2, 0x334455);
      this.saveLabel.setText("✓ SAVED").setColor("#556677");
    }
    this.savedAsText.setText(`Saved as ${mapId}`).setVisible(true);
  }

  update(data: MapPreviewData): void {
    this.nameText.setText(data.name);
    this.descText.setText(data.description);
    // Reset zoom/pan on a fresh map — the previous view is meaningless for a
    // different layout.
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.applyTransform();
    this.refreshTilesetRouting(data);
    this.renderGrid(data);
    // A regenerated map is unsaved — re-enable the SAVE button.
    this.saved = false;
    if (this.saveBg && this.saveLabel) {
      this.saveBg.setInteractive({ useHandCursor: true });
      this.saveBg.setFillStyle(0x2a3a55);
      this.saveBg.setStrokeStyle(2, 0x5588aa);
      this.saveLabel.setText("✓ SAVE").setColor("#cce4ff");
    }
    this.savedAsText.setVisible(false);
  }

  setBusy(busy: boolean): void {
    this.busyText.setVisible(busy);
    if (!this.regenBg || !this.regenLabel) return;
    if (busy) {
      this.regenBg.disableInteractive().setFillStyle(0x1a2222);
      this.regenLabel.setColor("#556677");
    } else {
      this.regenBg.setInteractive({ useHandCursor: true }).setFillStyle(0x1a3a2a);
      this.regenLabel.setColor("#ffe9a8");
    }
  }

  destroy(): void {
    if (this.wheelHandler) this.scene.input.off("wheel", this.wheelHandler);
    if (this.moveHandler)  this.scene.input.off("pointermove", this.moveHandler);
    if (this.upHandler) {
      this.scene.input.off("pointerup", this.upHandler);
      this.scene.input.off("pointerupoutside", this.upHandler);
    }
    this.container.destroy();
  }

  // ── Zoom + pan ──────────────────────────────────────────────────────────

  private installZoomPanHandlers(): void {
    // Mouse wheel zooms the grid around the cursor. We translate the wheel
    // event into a scale change and adjust the pan so the world point under
    // the cursor stays put — that's the natural feel for image zooming.
    this.wheelHandler = (pointer, _objs, _dx, deltaY) => {
      if (!this.pointerInViewport(pointer)) return;
      const oldZoom = this.zoom;
      const factor = deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      const newZoom = Phaser.Math.Clamp(oldZoom * factor, ZOOM_MIN, ZOOM_MAX);
      if (newZoom === oldZoom) return;
      // World point currently under the cursor (in grid-local coordinates).
      const localX = (pointer.x - this.viewportCenterX - this.panX) / oldZoom;
      const localY = (pointer.y - this.viewportCenterY - this.panY) / oldZoom;
      this.zoom = newZoom;
      // Adjust pan so that same local point lands under the cursor again.
      this.panX = pointer.x - this.viewportCenterX - localX * newZoom;
      this.panY = pointer.y - this.viewportCenterY - localY * newZoom;
      this.applyTransform();
    };
    this.scene.input.on("wheel", this.wheelHandler);

    // Drag-to-pan on the viewport hit target.
    this.viewportHit.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      this.dragging = true;
      this.dragStartPointerX = pointer.x;
      this.dragStartPointerY = pointer.y;
      this.dragStartPanX = this.panX;
      this.dragStartPanY = this.panY;
    });
    // Store handler refs so `destroy()` can detach them — otherwise each
    // overlay open stacks a new listener on the scene.
    this.moveHandler = (pointer: Phaser.Input.Pointer) => {
      if (!this.dragging) return;
      this.panX = this.dragStartPanX + (pointer.x - this.dragStartPointerX);
      this.panY = this.dragStartPanY + (pointer.y - this.dragStartPointerY);
      this.applyTransform();
    };
    this.upHandler = () => { this.dragging = false; };
    this.scene.input.on("pointermove", this.moveHandler);
    this.scene.input.on("pointerup", this.upHandler);
    this.scene.input.on("pointerupoutside", this.upHandler);
  }

  private pointerInViewport(pointer: Phaser.Input.Pointer): boolean {
    const halfW = PREVIEW_AREA_W / 2;
    const halfH = PREVIEW_AREA_H / 2;
    return (
      pointer.x >= this.viewportCenterX - halfW &&
      pointer.x <= this.viewportCenterX + halfW &&
      pointer.y >= this.viewportCenterY - halfH &&
      pointer.y <= this.viewportCenterY + halfH
    );
  }

  private applyTransform(): void {
    this.gridContainer.setScale(this.zoom);
    this.gridContainer.setPosition(this.viewportCenterX + this.panX, this.viewportCenterY + this.panY);
  }

  // ── Tile rendering ──────────────────────────────────────────────────────

  /**
   * Build the per-map GID→spritesheet lookup. Reads `data.tilesets` when
   * present and pre-resolves each entry to a Phaser texture key sorted by
   * descending firstgid (so a lookup picks the highest firstgid ≤ gid). Falls
   * back to a single-tileset routing at firstgid=1 when the data carries no
   * tilesets metadata.
   */
  private refreshTilesetRouting(data: MapPreviewData): void {
    if (data.tilesets && data.tilesets.length > 0) {
      this.tilesetRouting = [...data.tilesets]
        .map((ts) => ({ firstgid: ts.firstgid, key: tilesetTextureKey(tsetImageUrlFromSource(ts.source)) }))
        .sort((a, b) => b.firstgid - a.firstgid);
    } else {
      this.tilesetRouting = [{ firstgid: 1, key: this.fallbackTilesetKey }];
    }
  }

  private renderGrid(data: MapPreviewData): void {
    // Clear any previous tiles
    this.gridContainer.removeAll(true);

    const totalW = data.width * TILE_PX;
    const totalH = data.height * TILE_PX;
    const startX = -totalW / 2;
    const startY = -totalH / 2;

    // Subtle backing rect so the preview reads as a coherent block.
    const back = this.scene.add.rectangle(0, 0, totalW + 8, totalH + 8, 0x0a0e16)
      .setStrokeStyle(1, 0x334455);
    this.gridContainer.add(back);

    for (let y = 0; y < data.height; y++) {
      for (let x = 0; x < data.width; x++) {
        const i = y * data.width + x;
        const tx = startX + x * TILE_PX + TILE_PX / 2;
        const ty = startY + y * TILE_PX + TILE_PX / 2;

        const groundGid = data.terrainData[i];
        if (groundGid > 0) {
          this.drawTile(tx, ty, groundGid);
        } else {
          // Fallback: solid grey square so the layout still reads.
          this.gridContainer.add(
            this.scene.add.rectangle(tx, ty, TILE_PX, TILE_PX, 0x556677),
          );
        }

        const objectGid = data.objectData[i];
        if (objectGid > 0) {
          this.drawTile(tx, ty, objectGid);
        }

        // Starting-zone overlay (drawn on top of both terrain and objects).
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

    // Trigger region outlines, drawn after the per-cell overlays so the
    // outline reads on top of zone fills. One graphics object covers all
    // trigger rectangles.
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

  /** Render a single tile (terrain or object) with flip-bit decoding applied. */
  private drawTile(tx: number, ty: number, rawGid: number): void {
    const dec = decodeTileGid(rawGid);
    if (dec.gid === TILE_VOID_GID) {
      this.gridContainer.add(
        this.scene.add.rectangle(tx, ty, TILE_PX, TILE_PX, 0x000000),
      );
      return;
    }
    // Find the owning tileset by firstgid (sorted descending so the first
    // match wins). Skip the tile entirely if no tileset claims the GID — a
    // grey square shows through from the backing rect instead.
    const owner = this.tilesetRouting.find((t) => dec.gid >= t.firstgid);
    if (!owner || !this.scene.textures.exists(owner.key)) {
      this.gridContainer.add(
        this.scene.add.rectangle(tx, ty, TILE_PX, TILE_PX, 0x556677),
      );
      return;
    }
    const frame = dec.gid - owner.firstgid;
    const img = this.scene.add.image(tx, ty, owner.key, frame)
      .setDisplaySize(TILE_PX, TILE_PX);
    if (dec.angle !== 0) img.setAngle(dec.angle);
    if (dec.flipX) img.setFlipX(true);
    if (dec.flipY) img.setFlipY(true);
    this.gridContainer.add(img);
  }
}

/**
 * Translate a Tiled-style relative tileset path (e.g. `../tilesets/water.tsj`)
 * into the `/tilesets/<name>.png` url Phaser uses to key the spritesheet.
 */
function tsetImageUrlFromSource(source: string): string {
  const base = (source.split("/").pop() ?? source).replace(/\.tsj$/i, ".png");
  return `/tilesets/${base}`;
}

function pickTilesetKey(scene: Phaser.Scene): string {
  // Generated maps reference the roguelike tileset. Pull the imageUrl from
  // any existing map in the registry — they all share the tileset.
  const maps = (scene.registry.get("maps") as SavedMapDef[] | undefined) ?? [];
  for (const m of maps) {
    const url = m.tilesets?.[0]?.imageUrl;
    if (url) return tilesetTextureKey(url);
  }
  // Last-resort default — keeps the preview functional even if no maps
  // happen to be loaded yet (the fallback grey-square rendering kicks in).
  return tilesetTextureKey("/tilesets/roguelike.png");
}
