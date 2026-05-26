import Phaser from "phaser";
import { tilesetTextureKey } from "../scenes/BootScene";
import type { SavedMapDef } from "../net/types";
import { decodeTileGid, TILE_VOID_GID } from "../../../shared/tileGid";

export interface MapPreviewData {
  mapId: string;
  width: number;
  height: number;
  terrainData: number[];
  objectData: number[];
  name: string;
  description: string;
}

export interface MapPreviewZones {
  /** Cell keys formatted as `"x,y"` — player-start cells, rendered as a blue overlay. */
  playerCells: Set<string>;
  /** Cell keys formatted as `"x,y"` — enemy-start cells, rendered as a red overlay. */
  enemyCells: Set<string>;
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
  private readonly tilesetKey: string;
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

  constructor(
    scene: Phaser.Scene,
    initial: MapPreviewData,
    callbacks: { onClose: () => void; onRegenerate?: () => void; onAccept?: () => void },
    options?: MapPreviewOptions,
  ) {
    this.scene = scene;
    this.zones = options?.zones ?? null;
    const w = scene.scale.width;
    const h = scene.scale.height;

    this.tilesetKey = pickTilesetKey(scene);

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
    // view-only mode (no onRegenerate, no onAccept) shows only a single
    // centred CLOSE button; the full editor (regenerate + accept + close)
    // spreads three buttons across the bottom.
    const buttonY = top + PANEL_H - 50;
    const showAccept = !!callbacks.onAccept;
    const showRegen  = !!callbacks.onRegenerate;
    const buttonsCenter = left + PANEL_W / 2;

    if (showRegen) {
      const regenX = showAccept ? buttonsCenter - 240 : buttonsCenter - 130;
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

    if (showAccept) {
      const acceptX = showRegen ? buttonsCenter : buttonsCenter - 130;
      const acceptBg = scene.add.rectangle(acceptX, buttonY, 220, 40, 0x2a3a55)
        .setStrokeStyle(2, 0x5588aa).setInteractive({ useHandCursor: true });
      const acceptLabel = scene.add.text(acceptX, buttonY, "✓ ACCEPT", {
        fontSize: "13px", color: "#cce4ff", fontFamily: "monospace",
      }).setOrigin(0.5);
      acceptBg.on("pointerdown", () => callbacks.onAccept!());
      this.container.add(acceptBg);
      this.container.add(acceptLabel);
    }

    // CLOSE always exists. Position depends on what's beside it.
    const closeX = (showRegen && showAccept) ? buttonsCenter + 240
                 : (showRegen || showAccept) ? buttonsCenter + 130
                 : buttonsCenter;
    const closeBg = scene.add.rectangle(closeX, buttonY, 220, 40, 0x222233)
      .setStrokeStyle(2, 0x556677).setInteractive({ useHandCursor: true });
    const closeLabel = scene.add.text(closeX, buttonY, "CLOSE", {
      fontSize: "13px", color: "#aabbcc", fontFamily: "monospace",
    }).setOrigin(0.5);
    closeBg.on("pointerdown", () => callbacks.onClose());
    this.container.add(closeBg);
    this.container.add(closeLabel);

    // "Saved as gen_..." footnote
    const savedAs = scene.add.text(w / 2, buttonY - 30, `Saved as ${initial.mapId}`, {
      fontSize: "10px", color: "#556677", fontFamily: "monospace",
    }).setOrigin(0.5);
    this.container.add(savedAs);
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
    this.renderGrid(data);
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
    if (this.wheelHandler) {
      this.scene.input.off("wheel", this.wheelHandler);
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
    this.scene.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      if (!this.dragging) return;
      this.panX = this.dragStartPanX + (pointer.x - this.dragStartPointerX);
      this.panY = this.dragStartPanY + (pointer.y - this.dragStartPointerY);
      this.applyTransform();
    });
    this.scene.input.on("pointerup", () => { this.dragging = false; });
    this.scene.input.on("pointerupoutside", () => { this.dragging = false; });
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

    const hasTexture = this.scene.textures.exists(this.tilesetKey);
    const FIRSTGID = 1; // Generated maps always use roguelike at firstgid=1.

    for (let y = 0; y < data.height; y++) {
      for (let x = 0; x < data.width; x++) {
        const i = y * data.width + x;
        const tx = startX + x * TILE_PX + TILE_PX / 2;
        const ty = startY + y * TILE_PX + TILE_PX / 2;

        const groundGid = data.terrainData[i];
        if (hasTexture && groundGid > 0) {
          this.drawTile(tx, ty, groundGid, FIRSTGID);
        } else {
          // Fallback: solid grey square so the layout still reads.
          this.gridContainer.add(
            this.scene.add.rectangle(tx, ty, TILE_PX, TILE_PX, 0x556677),
          );
        }

        const objectGid = data.objectData[i];
        if (hasTexture && objectGid > 0) {
          this.drawTile(tx, ty, objectGid, FIRSTGID);
        }

        // Starting-zone overlay (drawn on top of both terrain and objects).
        if (this.zones) {
          const key = `${x},${y}`;
          if (this.zones.playerCells.has(key)) {
            this.gridContainer.add(this.scene.add.rectangle(tx, ty, TILE_PX, TILE_PX, 0x3388ff, 0.5));
          } else if (this.zones.enemyCells.has(key)) {
            this.gridContainer.add(this.scene.add.rectangle(tx, ty, TILE_PX, TILE_PX, 0xff4444, 0.5));
          }
        }
      }
    }
  }

  /** Render a single tile (terrain or object) with flip-bit decoding applied. */
  private drawTile(tx: number, ty: number, rawGid: number, firstGid: number): void {
    const dec = decodeTileGid(rawGid);
    if (dec.gid === TILE_VOID_GID) {
      this.gridContainer.add(
        this.scene.add.rectangle(tx, ty, TILE_PX, TILE_PX, 0x000000),
      );
      return;
    }
    const img = this.scene.add.image(tx, ty, this.tilesetKey, dec.gid - firstGid)
      .setDisplaySize(TILE_PX, TILE_PX);
    if (dec.angle !== 0) img.setAngle(dec.angle);
    if (dec.flipX) img.setFlipX(true);
    if (dec.flipY) img.setFlipY(true);
    this.gridContainer.add(img);
  }
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
