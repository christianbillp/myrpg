/**
 * ZonePainter — interactive map thumbnail + starting-zone painter for the
 * Deterministic tab of `GenerateSetupScene`. Renders the accepted map at a
 * shrunk-to-fit tile size, lets the user paint player (blue) and enemy (red)
 * starting cells by clicking/dragging, and surfaces a `CLEAR ZONES` mode plus
 * `PAINT: PLAYER` / `PAINT: ENEMY` toggle buttons below the thumbnail.
 *
 * The component owns its zone state and exposes it via Set references so the
 * caller can read live values without copying. When the player clicks a cell
 * with no paint mode active, `onClickEmpty` fires — the scene uses this to
 * open the larger Map Preview Overlay for inspection.
 */
import Phaser from "phaser";
import { decodeTileGid, TILE_VOID_GID } from "../../../../shared/tileGid";
import type { MapPreviewData } from "../MapPreviewOverlay";
import { createHtmlButton, type HtmlButtonHandle } from "../htmlButtons";

/** Per-kind outline colour for trigger-region overlays. */
const TRIGGER_COLOR: Record<TriggerRegion["kind"], number> = {
  perception:   0x88ccaa,  // muted teal — non-violent senses
  log:          0xc8d8e8,  // pale blue — neutral log message
  aigm:         0xe2b96f,  // amber — narrative cue
  combat:       0xff6644,  // hot red — fight starts here
  xp:           0x88ccff,  // sky blue — reward
  supertitle:   0xffffff,  // white — movie title card
  announcement: 0xf4e6c1,  // parchment — attention-grabbing card
  speech:       0x5588aa,  // bubble-blue
  fade:         0x222222,  // deep grey — blackout
};

export type PaintMode = "player" | "enemy" | "neutral" | null;

export interface ZonePainterOptions {
  scene: Phaser.Scene;
  parent: Phaser.GameObjects.Container;
  map: MapPreviewData;
  thumbX: number;
  thumbY: number;
  thumbW: number;
  thumbH: number;
  tileSize: number;
  tilesetKey: string;
  /** Fires whenever zone state changes — caller typically refreshes button enable-state. */
  onZonesChanged: () => void;
  /** Fires when a cell is clicked with no active paint mode (e.g. open the larger preview). */
  onClickEmpty: () => void;
  /** Optional preset zones (e.g. seeded by the RANDOMIZE flow). Each set holds "x,y" keys. */
  initialPlayerCells?: Set<string>;
  initialEnemyCells?: Set<string>;
  initialNeutralCells?: Set<string>;
  /** Scene's logical width — required by the HTML paint-mode buttons for scale calc. */
  sceneWidth: number;
}

/** A trigger region drawn on the thumbnail so the author can see what tiles fire the trigger. */
export interface TriggerRegion {
  id: string;
  kind:
    | "perception" | "log" | "aigm" | "combat" | "xp"
    | "supertitle" | "announcement" | "speech" | "fade";
  region: { x: number; y: number; w: number; h: number };
}

export class ZonePainter {
  private readonly playerCells = new Set<string>();
  private readonly enemyCells = new Set<string>();
  private readonly neutralCells = new Set<string>();
  private readonly zoneOverlayCells = new Map<string, Phaser.GameObjects.Rectangle>();
  private readonly triggerOverlay: Phaser.GameObjects.Graphics;
  private paintMode: PaintMode = null;
  private paintBtns: Array<{ mode: PaintMode; handle: HtmlButtonHandle }> = [];

  constructor(private readonly opts: ZonePainterOptions) {
    for (const k of opts.initialPlayerCells  ?? []) this.playerCells.add(k);
    for (const k of opts.initialEnemyCells   ?? []) this.enemyCells.add(k);
    for (const k of opts.initialNeutralCells ?? []) this.neutralCells.add(k);
    this.buildThumbnail();
    // Graphics layer on top of the zone overlay cells for trigger-region
    // outlines. Empty until `setTriggerRegions` is called.
    this.triggerOverlay = opts.scene.add.graphics();
    opts.parent.add(this.triggerOverlay);
  }

  /** Replace the drawn trigger-region outlines. Color-coded by kind. */
  setTriggerRegions(regions: TriggerRegion[]): void {
    const { thumbX: x, thumbY: y, tileSize } = this.opts;
    this.triggerOverlay.clear();
    for (const r of regions) {
      const color = TRIGGER_COLOR[r.kind];
      const px = x + r.region.x * tileSize;
      const py = y + r.region.y * tileSize;
      const pw = r.region.w * tileSize;
      const ph = r.region.h * tileSize;
      this.triggerOverlay.fillStyle(color, 0.15).fillRect(px, py, pw, ph);
      this.triggerOverlay.lineStyle(2, color, 0.9).strokeRect(px, py, pw, ph);
    }
  }

  /** Live reference — readers see edits as they happen. */
  getPlayerZones(): Set<string> { return this.playerCells; }
  getEnemyZones(): Set<string> { return this.enemyCells; }
  getNeutralZones(): Set<string> { return this.neutralCells; }

  /** Tear down the HTML paint-mode buttons. The Phaser objects parented to
   *  `opts.parent` are cleaned up by the scene when the parent container is
   *  destroyed. */
  destroy(): void {
    for (const { handle } of this.paintBtns) handle.dispose();
    this.paintBtns = [];
  }

  /**
   * Hide/show the HTML paint-mode buttons. The Phaser objects (thumbnail,
   * zone-overlay cells, trigger overlay) follow their parent container's
   * visibility; the HTML buttons live on `document.body` and need explicit
   * toggling when the deterministic tab is hidden.
   */
  setVisible(visible: boolean): void {
    for (const { handle } of this.paintBtns) handle.setVisible(visible);
  }

  /**
   * Build the four-button paint mode toolbar below the thumbnail. PLAYER /
   * ENEMY / NEUTRAL toggle the active paint mode (clicking the active mode
   * deactivates); CLEAR wipes every painted zone.
   */
  buildPaintModeButtons(x: number, y: number, totalW: number): void {
    const btnW = (totalW - 30) / 4;
    const btnH = 28;
    const mk = (mode: PaintMode | "clear", label: string, slot: number, variant: "secondary" | "danger" | "warn" | "primary"): HtmlButtonHandle => {
      const bx = x + slot * (btnW + 10);
      return createHtmlButton({
        scene: this.opts.scene,
        sceneWidth: this.opts.sceneWidth,
        x: bx, y, w: btnW, h: btnH,
        label, variant,
        fontSize: 11,
        onClick: () => {
          if (mode === "clear") {
            this.playerCells.clear();
            this.enemyCells.clear();
            this.neutralCells.clear();
            for (const key of this.zoneOverlayCells.keys()) this.refreshZoneOverlay(key);
            this.opts.onZonesChanged();
          } else {
            this.paintMode = this.paintMode === mode ? null : mode;
            this.refreshPaintModeButtons();
          }
        },
      });
    };
    this.paintBtns = [
      { mode: "player",  handle: mk("player",  "PLAYER",  0, "secondary") },
      { mode: "enemy",   handle: mk("enemy",   "ENEMY",   1, "danger") },
      { mode: "neutral", handle: mk("neutral", "NEUTRAL", 2, "warn") },
    ];
    // CLEAR is a non-toggleable command — store separately so refresh skips it.
    const clear = mk("clear", "CLEAR", 3, "primary");
    this.paintBtns.push({ mode: null, handle: clear });
    this.refreshPaintModeButtons();
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private buildThumbnail(): void {
    const { scene, parent, map, thumbX: x, thumbY: y, thumbW: w, thumbH: h, tileSize, tilesetKey } = this.opts;
    parent.add(scene.add.rectangle(x + w / 2, y + h / 2, w + 4, h + 4, 0x0a0e16).setStrokeStyle(1, 0x334455));
    const hasTexture = scene.textures.exists(tilesetKey);
    const FIRSTGID = 1;

    // Tile sprites.
    for (let ty = 0; ty < map.height; ty++) {
      for (let tx = 0; tx < map.width; tx++) {
        const px = x + tx * tileSize + tileSize / 2;
        const py = y + ty * tileSize + tileSize / 2;
        const i = ty * map.width + tx;
        const groundGid = map.terrainData[i];
        if (hasTexture && groundGid > 0) {
          this.drawTile(px, py, tileSize, groundGid, FIRSTGID, tilesetKey);
        } else {
          parent.add(scene.add.rectangle(px, py, tileSize, tileSize, 0x556677));
        }
        const objectGid = map.objectData[i];
        if (hasTexture && objectGid > 0) this.drawTile(px, py, tileSize, objectGid, FIRSTGID, tilesetKey);
      }
    }

    // Transparent click cells on top, recoloured per zone state.
    for (let ty = 0; ty < map.height; ty++) {
      for (let tx = 0; tx < map.width; tx++) {
        const px = x + tx * tileSize + tileSize / 2;
        const py = y + ty * tileSize + tileSize / 2;
        const key = `${tx},${ty}`;
        const cell = scene.add.rectangle(px, py, tileSize, tileSize, 0x000000, 0)
          .setStrokeStyle(0)
          .setInteractive({ useHandCursor: true });
        this.zoneOverlayCells.set(key, cell);
        this.refreshZoneOverlay(key);
        cell.on("pointerdown", () => {
          if (this.paintMode) this.paintCell(tx, ty);
          else this.opts.onClickEmpty();
        });
        cell.on("pointerover", (pointer: Phaser.Input.Pointer) => {
          if (this.paintMode && pointer.isDown) this.paintCell(tx, ty);
        });
        parent.add(cell);
      }
    }
  }

  private drawTile(px: number, py: number, sz: number, rawGid: number, firstGid: number, tilesetKey: string): void {
    const { scene, parent } = this.opts;
    const dec = decodeTileGid(rawGid);
    if (dec.gid === TILE_VOID_GID) {
      parent.add(scene.add.rectangle(px, py, sz, sz, 0x000000));
      return;
    }
    const img = scene.add.image(px, py, tilesetKey, dec.gid - firstGid).setDisplaySize(sz, sz);
    if (dec.angle !== 0) img.setAngle(dec.angle);
    if (dec.flipX) img.setFlipX(true);
    if (dec.flipY) img.setFlipY(true);
    parent.add(img);
  }

  private paintCell(x: number, y: number): void {
    const key = `${x},${y}`;
    // Painting a cell with the current mode toggles that mode for the cell.
    // Switching modes clears the cell from the other two sets so each cell
    // belongs to at most one zone.
    if (this.paintMode === "player") {
      if (this.playerCells.has(key)) this.playerCells.delete(key);
      else { this.playerCells.add(key); this.enemyCells.delete(key); this.neutralCells.delete(key); }
    } else if (this.paintMode === "enemy") {
      if (this.enemyCells.has(key)) this.enemyCells.delete(key);
      else { this.enemyCells.add(key); this.playerCells.delete(key); this.neutralCells.delete(key); }
    } else if (this.paintMode === "neutral") {
      if (this.neutralCells.has(key)) this.neutralCells.delete(key);
      else { this.neutralCells.add(key); this.playerCells.delete(key); this.enemyCells.delete(key); }
    }
    this.refreshZoneOverlay(key);
    this.opts.onZonesChanged();
  }

  private refreshZoneOverlay(key: string): void {
    const cell = this.zoneOverlayCells.get(key);
    if (!cell) return;
    if (this.playerCells.has(key))       cell.setFillStyle(0x3388ff, 0.5);
    else if (this.enemyCells.has(key))   cell.setFillStyle(0xff4444, 0.5);
    else if (this.neutralCells.has(key)) cell.setFillStyle(0xe2b96f, 0.5);
    else                                 cell.setFillStyle(0x000000, 0);
  }

  private refreshPaintModeButtons(): void {
    for (const { mode, handle } of this.paintBtns) {
      if (mode === null) continue;  // CLEAR — not a toggle.
      handle.setActive(this.paintMode === mode);
    }
  }
}
