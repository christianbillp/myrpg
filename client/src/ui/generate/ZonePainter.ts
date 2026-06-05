/**
 * ZonePainter — interactive map thumbnail + starting-zone painter used by
 * `MapEditorScene` and `EncounterCreatorScene`. Renders the accepted map
 * inside a configurable viewport rect, lets the user paint player / ally /
 * enemy / neutral starting cells by clicking and dragging in zones mode, or
 * bind individual entity tiles in exact-placement mode, and surfaces the
 * PAINT toggle buttons + CLEAR command for the caller to position.
 *
 * The component owns its zone state and exposes it via Set references so the
 * caller can read live values without copying. When the player clicks a cell
 * with no paint mode active and the click ends without a drag, the optional
 * `onClickEmpty` callback fires — used by MapEditorScene to open the
 * larger Map Preview Overlay; EncounterCreatorScene leaves it unset so the
 * in-place pan/zoom is the only inspection path.
 *
 * Pan + zoom note: this component installs four scene-level input listeners
 * (`pointerdown` / `pointermove` / `pointerup` / `wheel`) on `opts.scene` to
 * drive the viewport's drag-to-pan + wheel-to-zoom. Handlers early-out when
 * the pointer is outside the viewport rect, but if a future scene composes
 * its OWN scene-level input handlers, take care that the painter's
 * `destroy()` is called before the conflicting consumer registers — Phaser
 * fires all listeners and there is no priority ordering.
 */
import Phaser from "phaser";
import { decodeTileGid, TILE_VOID_GID } from "../../../../shared/tileGid";
import type { MapPreviewData, MapZone } from "../EmbeddedMapPreview";
import { createHtmlButton, type HtmlButtonHandle } from "../htmlButtons";
import type { EncounterPlacement } from "../../../../shared/types";

export type PlacementMode = "zones" | "exact";

/** Toggleable preview layers in the encounter editor's map viewport. */
type LayerKey = 'zones' | 'triggers' | 'monsters' | 'mapZones';

/** Per-kind outline colour for trigger-region overlays. */
const TRIGGER_COLOR: Record<TriggerRegion["kind"], number> = {
  perception:   0x88ccaa,  // muted teal — non-violent senses
  log:          0xc8d8e8,  // pale blue — neutral log message
  aigm:         0xe2b96f,  // amber — narrative cue
  combat:       0xff6644,  // hot red — fight starts here
  xp:           0x88ccff,  // sky blue — reward
  announcement: 0xf4e6c1,  // parchment — attention-grabbing card
  speech:       0x5588aa,  // bubble-blue
  fade:         0x222222,  // deep grey — blackout
  set_flag:     0xaa88ff,  // muted purple — world-state write
};

export type PaintMode = "player" | "ally" | "enemy" | "neutral" | null;

export interface ZonePainterOptions {
  scene: Phaser.Scene;
  parent: Phaser.GameObjects.Container;
  map: MapPreviewData;
  /** Map's top-left corner — where tile (0,0) gets drawn at default pan/zoom. */
  thumbX: number;
  thumbY: number;
  /** Map's natural pixel size (`tileSize × map.width/height`) — used to size
   *  the static backdrop behind the tile sprites. */
  thumbW: number;
  thumbH: number;
  tileSize: number;
  tilesetKey: string;
  /** Optional viewport bounds — the visible / clipped / pannable rectangle.
   *  When omitted (legacy callers) defaults to the map rect itself, matching
   *  the historical behaviour where map and viewport were identical. The
   *  encounter editor passes a larger viewport so the map sits centered in a
   *  full-column viewport that the user can pan + zoom around. */
  viewportX?: number;
  viewportY?: number;
  viewportW?: number;
  viewportH?: number;
  /** Fires whenever zone state changes — caller typically refreshes button enable-state. */
  onZonesChanged: () => void;
  /** Optional — fires when a cell is clicked with no active paint mode AND
   *  no pan drag occurred. The encounter editor leaves this unset because the
   *  in-place viewer is pan/zoomable; the legacy MapEditorScene flow uses
   *  it to open the large-preview overlay. */
  onClickEmpty?: () => void;
  /** Optional preset zones (e.g. seeded by the RANDOMIZE flow). Each set holds "x,y" keys. */
  initialPlayerCells?: Set<string>;
  initialAllyCells?: Set<string>;
  initialEnemyCells?: Set<string>;
  initialNeutralCells?: Set<string>;
  /** Placement mode — `"zones"` (random in zones, default) or `"exact"` (per-entity tiles). */
  initialPlacementMode?: PlacementMode;
  /** Exact-mode placements seed (consumed when `initialPlacementMode === "exact"`). */
  initialPlacements?: EncounterPlacement[];
  /** Encounter rosters used in exact mode to bind tiles to specific entity slots. */
  initialEnemyIds?: string[];
  initialAllyIds?: string[];
  initialNeutralIds?: string[];
  /** Scene's logical width — required by the HTML paint-mode buttons for scale calc. */
  sceneWidth: number;
}

/** A trigger region drawn on the thumbnail so the author can see what tiles fire the trigger. */
export interface TriggerRegion {
  id: string;
  kind:
    | "perception" | "log" | "aigm" | "combat" | "xp"
    | "announcement" | "speech" | "fade" | "set_flag";
  region: { x: number; y: number; w: number; h: number };
}

export class ZonePainter {
  private readonly playerCells = new Set<string>();
  private readonly allyCells = new Set<string>();
  private readonly enemyCells = new Set<string>();
  private readonly neutralCells = new Set<string>();
  private readonly zoneOverlayCells = new Map<string, Phaser.GameObjects.Rectangle>();
  private readonly triggerOverlay: Phaser.GameObjects.Graphics;
  /** Named map zones authored in the Map Creator (`SavedMapDef.zones`). Drawn
   *  as translucent colour-coded cell fills with a centred label, toggled by
   *  the MAP ZONES layer button. Distinct from the player/ally/enemy/neutral
   *  starting zones the painter edits. */
  private mapZonesOverlay!: Phaser.GameObjects.Graphics;
  private mapZoneLabels: Phaser.GameObjects.Text[] = [];
  private mapZones: MapZone[] = [];
  private paintMode: PaintMode = null;
  private paintBtns: Array<{ mode: PaintMode; handle: HtmlButtonHandle }> = [];
  // Placement-mode state. Empty / unused in zones mode.
  private placementMode: PlacementMode = "zones";
  private placements: EncounterPlacement[] = [];
  private enemyIds: string[] = [];
  private allyIds: string[] = [];
  private neutralIds: string[] = [];
  /** Per-tile placement markers (entity letter + index, e.g. "P", "E0", "A1"). */
  private readonly placementMarkers = new Map<string, { rect: Phaser.GameObjects.Rectangle; label: Phaser.GameObjects.Text }>();
  /** Per-layer visibility flags. Authors toggle these via the layer toolbar
   *  so the preview can be filtered down to just the layer they're currently
   *  inspecting (zones / triggers / monsters). Newly-created cells +
   *  markers honour the current flag at creation time so toggles persist
   *  across paint / placement changes. */
  private layerVisible = { zones: true, triggers: true, monsters: true, mapZones: true };
  private layerToggleBtns: Array<{ key: LayerKey; handle: HtmlButtonHandle }> = [];
  /** Callback so the scene can persist placement changes (mirrors onZonesChanged). */
  private onPlacementsChanged: () => void = () => {};

  /** Sub-container that owns every transformable map element (tiles, overlay
   *  cells, trigger graphics, placement markers). Pan/zoom set this
   *  container's `x/y/scale`. The viewport backdrop + mask stay in
   *  `opts.parent` so they don't move. */
  private mapContainer!: Phaser.GameObjects.Container;
  private maskShape?: Phaser.GameObjects.Graphics;
  // Drag-pan state (scene-level input, not per-cell).
  private clickPending = false;
  private clickStartX = 0;
  private clickStartY = 0;
  private dragStartContainerX = 0;
  private dragStartContainerY = 0;
  private panning = false;
  private readonly CLICK_DRAG_THRESHOLD = 4;
  private readonly ZOOM_MIN = 0.3;
  private readonly ZOOM_MAX = 6;
  private onPointerDown!: (pointer: Phaser.Input.Pointer) => void;
  private onPointerMove!: (pointer: Phaser.Input.Pointer) => void;
  private onPointerUp!:   (pointer: Phaser.Input.Pointer) => void;
  private onWheel!:       (pointer: Phaser.Input.Pointer, gos: Phaser.GameObjects.GameObject[], dx: number, dy: number) => void;

  constructor(private readonly opts: ZonePainterOptions) {
    for (const k of opts.initialPlayerCells  ?? []) this.playerCells.add(k);
    for (const k of opts.initialAllyCells    ?? []) this.allyCells.add(k);
    for (const k of opts.initialEnemyCells   ?? []) this.enemyCells.add(k);
    for (const k of opts.initialNeutralCells ?? []) this.neutralCells.add(k);
    this.placementMode = opts.initialPlacementMode ?? "zones";
    this.placements = [...(opts.initialPlacements ?? [])];
    this.enemyIds   = [...(opts.initialEnemyIds   ?? [])];
    this.allyIds    = [...(opts.initialAllyIds    ?? [])];
    this.neutralIds = [...(opts.initialNeutralIds ?? [])];

    // Resolve viewport rect — defaults to the map rect for legacy callers
    // (MapEditorScene). EncounterCreatorScene passes a larger viewport so
    // the map sits centered in a full-column inspection area.
    const { scene, parent } = opts;
    const vx = opts.viewportX ?? opts.thumbX;
    const vy = opts.viewportY ?? opts.thumbY;
    const vw = opts.viewportW ?? opts.thumbW;
    const vh = opts.viewportH ?? opts.thumbH;

    // Static viewport backdrop — fills the entire viewport, stays put under
    // pan/zoom so the frame is always visible.
    parent.add(scene.add.rectangle(vx + vw / 2, vy + vh / 2, vw + 4, vh + 4, 0x0a0e16).setStrokeStyle(1, 0x334455));

    // Transformable container — every tile/cell/overlay sits inside this so
    // pan and zoom apply uniformly.
    this.mapContainer = scene.add.container(0, 0);
    parent.add(this.mapContainer);

    // Geometry mask clips children to the viewport rect. The mask lives in
    // scene coordinates and is NOT inside mapContainer, so it stays fixed
    // when mapContainer transforms.
    this.maskShape = scene.make.graphics({}, false);
    this.maskShape.fillStyle(0xffffff);
    this.maskShape.fillRect(vx, vy, vw, vh);
    this.mapContainer.setMask(this.maskShape.createGeometryMask());

    this.buildThumbnail();
    // Named map-zone overlay sits above the tiles but below the trigger
    // outlines + placement markers, so authored regions read as a ground tint.
    this.mapZonesOverlay = scene.add.graphics();
    this.mapZonesOverlay.setVisible(this.layerVisible.mapZones);
    this.mapContainer.add(this.mapZonesOverlay);
    this.setMapZones(opts.map.zones ?? []);
    // Graphics layer on top of the zone overlay cells for trigger-region
    // outlines. Empty until `setTriggerRegions` is called.
    this.triggerOverlay = scene.add.graphics();
    this.triggerOverlay.setVisible(this.layerVisible.triggers);
    this.mapContainer.add(this.triggerOverlay);
    this.renderPlacementMarkers();

    // Pan + zoom — scene-level handlers so we catch events even when the
    // pointer is over an interactive cell (cells handle paint; the scene
    // handlers handle the camera).
    this.onPointerDown = (p) => this.handlePointerDown(p);
    this.onPointerMove = (p) => this.handlePointerMove(p);
    this.onPointerUp   = (p) => this.handlePointerUp(p);
    this.onWheel       = (p, _gos, _dx, dy) => this.handleWheel(p, dy);
    scene.input.on("pointerdown", this.onPointerDown);
    scene.input.on("pointermove", this.onPointerMove);
    scene.input.on("pointerup",   this.onPointerUp);
    scene.input.on("wheel",       this.onWheel);
  }

  /** Replace the encounter's monster roster (called by the scene when the
   *  MonsterPicker selection changes — placements bound to a now-removed
   *  entity slot are silently pruned on the next read). */
  setEntityRoster(roster: { enemyIds: string[]; allyIds: string[]; neutralIds: string[] }): void {
    this.enemyIds   = [...roster.enemyIds];
    this.allyIds    = [...roster.allyIds];
    this.neutralIds = [...roster.neutralIds];
    // Prune placements whose role/index no longer have a slot.
    this.placements = this.placements.filter((p) => {
      if (p.role === 'player')  return true;
      if (p.role === 'enemy')   return p.index < this.enemyIds.length;
      if (p.role === 'ally')    return p.index < this.allyIds.length;
      if (p.role === 'neutral') return p.index < this.neutralIds.length;
      return false;
    });
    this.renderPlacementMarkers();
    this.refreshPaintModeButtons();
  }

  /** Splice a single slot out of a role's array. Drops the placement bound
   *  to that exact index (if any) and shifts every higher-indexed placement
   *  in the same role down by one so it follows the slot it was bound to.
   *  Call BEFORE the host updates the roster via `setEntityRoster` so the
   *  re-binding has the old indices to work with. */
  removeSlotAt(role: 'enemy' | 'ally' | 'neutral', removedIndex: number): void {
    this.placements = this.placements
      .filter((p) => !(p.role === role && p.index === removedIndex))
      .map((p) => {
        if (p.role === role && p.index > removedIndex) {
          return { ...p, index: p.index - 1 };
        }
        return p;
      });
    this.renderPlacementMarkers();
  }

  setPlacementMode(mode: PlacementMode): void {
    if (this.placementMode === mode) return;
    this.placementMode = mode;
    // Switching modes deactivates the active brush — clicking a tile means
    // different things in each mode, and silently keeping the brush active
    // through a mode switch would surprise the author.
    this.paintMode = null;
    // Labels change between modes (exact mode adds "0/N" progress), so
    // refresh them too.
    this.refreshPaintModeButtons();
    this.renderPlacementMarkers();
  }

  getPlacementMode(): PlacementMode { return this.placementMode; }
  getPlacements(): EncounterPlacement[] { return [...this.placements]; }

  setOnPlacementsChanged(fn: () => void): void { this.onPlacementsChanged = fn; }

  /** Replace the placement list wholesale. Used by the AI accept flow to
   *  drop a fresh batch of spawns (player + monsters) onto the map. The
   *  caller is responsible for setting placementMode to 'exact' first if
   *  the placements should be honoured by SAVE. */
  setPlacements(placements: EncounterPlacement[]): void {
    this.placements = placements.map((p) => ({ ...p }));
    this.renderPlacementMarkers();
    this.refreshPaintModeButtons();
    this.onPlacementsChanged();
  }

  /** Replace all four zone sets in one shot. Used by the AI accept flow
   *  when the proposal includes zone-based starts instead of (or in
   *  addition to) exact placements. Iterates touched keys and lets
   *  `refreshZoneOverlay` repaint each cell's existing overlay rect. */
  setZones(zones: { player?: Iterable<string>; ally?: Iterable<string>; enemy?: Iterable<string>; neutral?: Iterable<string> }): void {
    const touched = new Set<string>();
    const applyRole = (role: 'player' | 'ally' | 'enemy' | 'neutral', incoming: Iterable<string> | undefined, current: Set<string>): void => {
      if (!incoming) return;
      for (const k of current) touched.add(k);
      current.clear();
      for (const k of incoming) {
        current.add(k);
        touched.add(k);
      }
      void role;
    };
    applyRole('player',  zones.player,  this.playerCells);
    applyRole('ally',    zones.ally,    this.allyCells);
    applyRole('enemy',   zones.enemy,   this.enemyCells);
    applyRole('neutral', zones.neutral, this.neutralCells);
    for (const k of touched) this.refreshZoneOverlay(k);
    this.refreshPaintModeButtons();
    this.opts.onZonesChanged();
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

  /** Replace the drawn named map-zone overlay. Each zone fills its cells with
   *  its colour at low alpha and stamps a centred label. */
  setMapZones(zones: MapZone[]): void {
    this.mapZones = zones;
    const { thumbX: x, thumbY: y, tileSize } = this.opts;
    this.mapZonesOverlay.clear();
    for (const t of this.mapZoneLabels) t.destroy();
    this.mapZoneLabels = [];
    for (const z of zones) {
      const color = parseCssHex(z.color, 0x88ccaa);
      let sx = 0, sy = 0, n = 0;
      for (const cell of z.cells) {
        const [cx, cy] = cell.split(",").map(Number);
        if (Number.isNaN(cx) || Number.isNaN(cy)) continue;
        const px = x + cx * tileSize;
        const py = y + cy * tileSize;
        this.mapZonesOverlay.fillStyle(color, 0.22).fillRect(px, py, tileSize, tileSize);
        this.mapZonesOverlay.lineStyle(1, color, 0.6).strokeRect(px + 0.5, py + 0.5, tileSize - 1, tileSize - 1);
        sx += cx; sy += cy; n++;
      }
      if (n > 0 && z.name) {
        const label = this.opts.scene.add.text(
          x + (sx / n + 0.5) * tileSize,
          y + (sy / n + 0.5) * tileSize,
          z.name,
          { fontFamily: "monospace", fontSize: "10px", color: "#ffffff", backgroundColor: "#000000aa", padding: { x: 3, y: 1 } },
        ).setOrigin(0.5, 0.5);
        label.setVisible(this.layerVisible.mapZones);
        this.mapContainer.add(label);
        this.mapZoneLabels.push(label);
      }
    }
  }

  /** Live reference — readers see edits as they happen. */
  getPlayerZones(): Set<string> { return this.playerCells; }
  getAllyZones(): Set<string> { return this.allyCells; }
  getEnemyZones(): Set<string> { return this.enemyCells; }
  getNeutralZones(): Set<string> { return this.neutralCells; }

  /** Tear down the HTML paint-mode buttons and scene-level input listeners.
   *  The Phaser objects parented to `opts.parent` are cleaned up by the
   *  scene when the parent container is destroyed; the mask graphics is not
   *  in any container so we destroy it explicitly. */
  destroy(): void {
    for (const { handle } of this.paintBtns) handle.dispose();
    for (const { handle } of this.layerToggleBtns) handle.dispose();
    this.paintBtns = [];
    this.layerToggleBtns = [];
    const sceneInput = this.opts.scene.input;
    sceneInput.off("pointerdown", this.onPointerDown);
    sceneInput.off("pointermove", this.onPointerMove);
    sceneInput.off("pointerup",   this.onPointerUp);
    sceneInput.off("wheel",       this.onWheel);
    this.maskShape?.destroy();
    this.maskShape = undefined;
  }

  // ── Pan / zoom ──────────────────────────────────────────────────────────

  /** True when the pointer is inside the viewport rect in scene-space. */
  private isPointerOverViewport(pointer: Phaser.Input.Pointer): boolean {
    const x = this.opts.viewportX ?? this.opts.thumbX;
    const y = this.opts.viewportY ?? this.opts.thumbY;
    const w = this.opts.viewportW ?? this.opts.thumbW;
    const h = this.opts.viewportH ?? this.opts.thumbH;
    return pointer.x >= x && pointer.x <= x + w && pointer.y >= y && pointer.y <= y + h;
  }

  private handlePointerDown(pointer: Phaser.Input.Pointer): void {
    if (!this.isPointerOverViewport(pointer)) return;
    // Paint / place is handled by the cell-level pointerdown; only arm a pan
    // candidate when no brush is active.
    if (this.paintMode !== null) return;
    this.clickPending = true;
    this.panning = false;
    this.clickStartX = pointer.x;
    this.clickStartY = pointer.y;
    this.dragStartContainerX = this.mapContainer.x;
    this.dragStartContainerY = this.mapContainer.y;
  }

  private handlePointerMove(pointer: Phaser.Input.Pointer): void {
    if (!this.clickPending) return;
    if (!pointer.isDown) { this.clickPending = false; return; }
    const dx = pointer.x - this.clickStartX;
    const dy = pointer.y - this.clickStartY;
    if (!this.panning && Math.hypot(dx, dy) > this.CLICK_DRAG_THRESHOLD) {
      this.panning = true;
    }
    if (this.panning) {
      this.mapContainer.x = this.dragStartContainerX + dx;
      this.mapContainer.y = this.dragStartContainerY + dy;
    }
  }

  private handlePointerUp(_pointer: Phaser.Input.Pointer): void {
    // A click without drag inside the viewport with no active brush is a
    // "click on empty space" — currently used by MapEditorScene to open
    // the large preview. EncounterCreatorScene leaves the callback unset.
    if (this.clickPending && !this.panning) this.opts.onClickEmpty?.();
    this.clickPending = false;
    this.panning = false;
  }

  private handleWheel(pointer: Phaser.Input.Pointer, deltaY: number): void {
    if (!this.isPointerOverViewport(pointer)) return;
    const oldScale = this.mapContainer.scaleX;
    const factor = deltaY > 0 ? 0.9 : 1 / 0.9;
    const newScale = Phaser.Math.Clamp(oldScale * factor, this.ZOOM_MIN, this.ZOOM_MAX);
    if (newScale === oldScale) return;
    // Pivot zoom around the cursor: the world point currently under the
    // pointer should stay under the pointer after the scale change.
    const localX = (pointer.x - this.mapContainer.x) / oldScale;
    const localY = (pointer.y - this.mapContainer.y) / oldScale;
    this.mapContainer.setScale(newScale);
    this.mapContainer.x = pointer.x - localX * newScale;
    this.mapContainer.y = pointer.y - localY * newScale;
  }

  /**
   * Hide/show the HTML paint-mode buttons. The Phaser objects (thumbnail,
   * zone-overlay cells, trigger overlay) follow their parent container's
   * visibility; the HTML buttons live on `document.body` and need explicit
   * toggling when the deterministic tab is hidden.
   */
  setVisible(visible: boolean): void {
    for (const { handle } of this.paintBtns) handle.setVisible(visible);
    for (const { handle } of this.layerToggleBtns) handle.setVisible(visible);
  }

  /**
   * Toggle visibility of each preview layer. Authors use this to filter the
   * map down to a single concern (just zones, just triggers, just monster
   * placements) so the view doesn't overclutter when all three are dense.
   * Newly-painted cells / re-rendered placements honour the current flag.
   */
  setLayerVisibility(layers: Partial<Record<LayerKey, boolean>>): void {
    if (layers.zones !== undefined) {
      this.layerVisible.zones = layers.zones;
      for (const cell of this.zoneOverlayCells.values()) cell.setVisible(layers.zones);
    }
    if (layers.triggers !== undefined) {
      this.layerVisible.triggers = layers.triggers;
      this.triggerOverlay.setVisible(layers.triggers);
    }
    if (layers.monsters !== undefined) {
      this.layerVisible.monsters = layers.monsters;
      for (const { rect, label } of this.placementMarkers.values()) {
        rect.setVisible(layers.monsters);
        label.setVisible(layers.monsters);
      }
    }
    if (layers.mapZones !== undefined) {
      this.layerVisible.mapZones = layers.mapZones;
      this.mapZonesOverlay.setVisible(layers.mapZones);
      for (const t of this.mapZoneLabels) t.setVisible(layers.mapZones);
    }
    this.refreshLayerToggleButtons();
  }

  getLayerVisibility(): Record<LayerKey, boolean> {
    return { ...this.layerVisible };
  }

  /**
   * Build the visibility toolbar — ZONES / TRIGGERS / MONSTERS / MAP ZONES.
   * Each button toggles its layer's visibility on/off. Sits above the
   * paint-mode toolbar; the host scene picks the y-coordinate so the chip
   * row fits in whatever leftover space is available.
   */
  buildLayerToggleButtons(x: number, y: number, totalW: number): void {
    const slots: Array<{ key: LayerKey; label: string }> = [
      { key: 'zones',    label: 'ZONES' },
      { key: 'triggers', label: 'TRIGGERS' },
      { key: 'monsters', label: 'MONSTERS' },
      { key: 'mapZones', label: 'MAP ZONES' },
    ];
    const cols = slots.length;
    const gap = 8;
    const btnW = (totalW - gap * (cols - 1)) / cols;
    const btnH = 22;
    const make = (key: LayerKey, label: string, slot: number): HtmlButtonHandle => {
      const bx = x + slot * (btnW + gap);
      return createHtmlButton({
        scene: this.opts.scene,
        sceneWidth: this.opts.sceneWidth,
        x: bx, y, w: btnW, h: btnH,
        label, variant: 'secondary', fontSize: 10,
        onClick: () => this.setLayerVisibility({ [key]: !this.layerVisible[key] }),
      });
    };
    this.layerToggleBtns = slots.map((s, i) => ({ key: s.key, handle: make(s.key, s.label, i) }));
    this.refreshLayerToggleButtons();
  }

  private refreshLayerToggleButtons(): void {
    for (const { key, handle } of this.layerToggleBtns) {
      const on = this.layerVisible[key];
      handle.el.style.background   = on ? '#243250' : '#15151f';
      handle.el.style.borderColor  = on ? '#4a6a9a' : '#445566';
      handle.el.style.color        = on ? '#cce4ff' : '#556677';
    }
  }

  /**
   * Build the four-button paint mode toolbar below the thumbnail. PLAYER /
   * ENEMY / NEUTRAL toggle the active paint mode (clicking the active mode
   * deactivates); CLEAR wipes every painted zone.
   */
  buildPaintModeButtons(x: number, y: number, totalW: number): void {
    // 5 buttons (PLAYER, ALLY, ENEMY, NEUTRAL, CLEAR) with 10px gaps.
    const btnW = (totalW - 40) / 5;
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
            this.allyCells.clear();
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
      { mode: "ally",    handle: mk("ally",    "ALLY",    1, "secondary") },
      { mode: "enemy",   handle: mk("enemy",   "ENEMY",   2, "danger") },
      { mode: "neutral", handle: mk("neutral", "NEUTRAL", 3, "warn") },
    ];
    // CLEAR is a non-toggleable command — store separately so refresh skips it.
    const clear = mk("clear", "CLEAR", 4, "primary");
    this.paintBtns.push({ mode: null, handle: clear });
    this.refreshPaintModeButtons();
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private buildThumbnail(): void {
    const { scene, map, thumbX: x, thumbY: y, tileSize, tilesetKey } = this.opts;
    const hasTexture = scene.textures.exists(tilesetKey);
    const FIRSTGID = 1;

    // Tile sprites — added to mapContainer so they pan/zoom together.
    for (let ty = 0; ty < map.height; ty++) {
      for (let tx = 0; tx < map.width; tx++) {
        const px = x + tx * tileSize + tileSize / 2;
        const py = y + ty * tileSize + tileSize / 2;
        const i = ty * map.width + tx;
        const groundGid = map.terrainData[i];
        // `!== 0` instead of `> 0`: rotated tiles set the high flip bit
        // (Tiled's H/V/D flags), which makes their signed int32 GID negative.
        // The renderer's decodeTileGid handles the flag bits; the test only
        // needs to know whether a tile was painted at all.
        if (hasTexture && groundGid !== 0) {
          this.drawTile(px, py, tileSize, groundGid, FIRSTGID, tilesetKey);
        } else {
          this.mapContainer.add(scene.add.rectangle(px, py, tileSize, tileSize, 0x556677));
        }
        const objectGid = map.objectData[i];
        if (hasTexture && objectGid !== 0) this.drawTile(px, py, tileSize, objectGid, FIRSTGID, tilesetKey);
      }
    }

    // Transparent click cells on top, recoloured per zone state. Paint/place
    // actions live on the cell; pan/zoom lives on the scene-level handler.
    for (let ty = 0; ty < map.height; ty++) {
      for (let tx = 0; tx < map.width; tx++) {
        const px = x + tx * tileSize + tileSize / 2;
        const py = y + ty * tileSize + tileSize / 2;
        const key = `${tx},${ty}`;
        const cell = scene.add.rectangle(px, py, tileSize, tileSize, 0x000000, 0)
          .setStrokeStyle(0)
          .setInteractive({ useHandCursor: true });
        cell.setVisible(this.layerVisible.zones);
        this.zoneOverlayCells.set(key, cell);
        this.refreshZoneOverlay(key);
        cell.on("pointerdown", () => {
          if (this.placementMode === "exact") {
            const m = this.paintMode;
            if (m === "player" || m === "ally" || m === "enemy" || m === "neutral") {
              this.bindNextPlacement(m, tx, ty);
            }
            return;
          }
          if (this.paintMode) this.paintCell(tx, ty);
        });
        cell.on("pointerover", (pointer: Phaser.Input.Pointer) => {
          // Drag-paint applies only in zones mode; in exact mode every
          // placement is an explicit single click. Suppressed during pan so
          // a drag away from the start cell doesn't accidentally paint.
          if (this.panning) return;
          if (this.placementMode === "zones" && this.paintMode && pointer.isDown) {
            this.paintCell(tx, ty);
          }
        });
        this.mapContainer.add(cell);
      }
    }
  }

  private drawTile(px: number, py: number, sz: number, rawGid: number, firstGid: number, tilesetKey: string): void {
    const { scene } = this.opts;
    const dec = decodeTileGid(rawGid);
    if (dec.gid === TILE_VOID_GID) {
      this.mapContainer.add(scene.add.rectangle(px, py, sz, sz, 0x000000));
      return;
    }
    const img = scene.add.image(px, py, tilesetKey, dec.gid - firstGid).setDisplaySize(sz, sz);
    if (dec.angle !== 0) img.setAngle(dec.angle);
    if (dec.flipX) img.setFlipX(true);
    if (dec.flipY) img.setFlipY(true);
    this.mapContainer.add(img);
  }

  private paintCell(x: number, y: number): void {
    const key = `${x},${y}`;
    // Painting a cell with the current mode toggles that mode for the cell.
    // Switching modes clears the cell from the other two sets so each cell
    // belongs to at most one zone.
    // Each cell belongs to at most one role; painting with the current mode
    // toggles the cell, and removes it from the three other role sets.
    const sets = {
      player:  this.playerCells,
      ally:    this.allyCells,
      enemy:   this.enemyCells,
      neutral: this.neutralCells,
    } as const;
    const mode = this.paintMode;
    if (mode && mode in sets) {
      const target = sets[mode];
      if (target.has(key)) {
        target.delete(key);
      } else {
        for (const [name, set] of Object.entries(sets)) {
          if (name === mode) continue;
          set.delete(key);
        }
        target.add(key);
      }
    }
    this.refreshZoneOverlay(key);
    this.opts.onZonesChanged();
  }

  private refreshZoneOverlay(key: string): void {
    const cell = this.zoneOverlayCells.get(key);
    if (!cell) return;
    if (this.playerCells.has(key))       cell.setFillStyle(0x3388ff, 0.5);
    else if (this.allyCells.has(key))    cell.setFillStyle(0x66cc88, 0.5);
    else if (this.enemyCells.has(key))   cell.setFillStyle(0xff4444, 0.5);
    else if (this.neutralCells.has(key)) cell.setFillStyle(0xe2b96f, 0.5);
    else                                 cell.setFillStyle(0x000000, 0);
  }

  /** Compose the label for an entity brush. In exact mode the label shows
   *  placement progress so the author can see, at a glance, how many slots
   *  are bound out of the total (e.g. `"ENEMY 1/3"`). Player is a singleton
   *  — its progress reads `1/1` once placed. In zones mode the labels are
   *  the bare role name. */
  private labelForBrush(mode: PaintMode): string {
    if (mode === null) return "CLEAR";
    const base = mode.toUpperCase();
    if (this.placementMode !== "exact") return base;
    if (mode === "player") {
      const placed = this.placements.some((p) => p.role === "player") ? 1 : 0;
      return `${base} ${placed}/1`;
    }
    const total =
      mode === "enemy"   ? this.enemyIds.length :
      mode === "ally"    ? this.allyIds.length  :
                            this.neutralIds.length;
    const placed = this.placements.filter((p) => p.role === mode).length;
    return `${base} ${placed}/${total}`;
  }

  private refreshPaintModeButtons(): void {
    for (const { mode, handle } of this.paintBtns) {
      if (mode === null) continue;  // CLEAR — not a toggle.
      handle.setActive(this.paintMode === mode);
      handle.setLabel(this.labelForBrush(mode));
    }
  }

  /**
   * Bind the next-available slot of a role to the given tile. If the tile is
   * already bound to a placement of this role, remove it instead — single
   * click toggles. Player is a singleton: clicking with PLAYER active sets
   * the player tile (or removes the player placement when re-clicking the
   * same tile).
   */
  private bindNextPlacement(role: "player" | "ally" | "enemy" | "neutral", x: number, y: number): void {
    if (role === "player") {
      const existing = this.placements.findIndex((p) => p.role === "player");
      if (existing >= 0) {
        const p = this.placements[existing];
        if (p.x === x && p.y === y) { this.placements.splice(existing, 1); }
        else { this.placements[existing] = { role: "player", x, y }; }
      } else {
        this.placements.push({ role: "player", x, y });
      }
    } else {
      // Already-bound at this tile? Remove (toggle).
      const matchIdx = this.placements.findIndex((p) => p.role === role && p.x === x && p.y === y);
      if (matchIdx >= 0) {
        this.placements.splice(matchIdx, 1);
      } else {
        // Find lowest free index for this role within the available slot count.
        const slotCount =
          role === "enemy"   ? this.enemyIds.length :
          role === "ally"    ? this.allyIds.length  :
                                this.neutralIds.length;
        if (slotCount === 0) return;  // nothing to bind to
        const usedIndices = new Set<number>();
        for (const p of this.placements) {
          if (p.role === role) usedIndices.add(p.index);
        }
        let nextIdx = -1;
        for (let i = 0; i < slotCount; i++) if (!usedIndices.has(i)) { nextIdx = i; break; }
        if (nextIdx < 0) return;  // every slot already placed
        this.placements.push({ role, index: nextIdx, x, y });
      }
    }
    this.renderPlacementMarkers();
    this.refreshPaintModeButtons();
    this.onPlacementsChanged();
  }

  /**
   * Repaint the placement-marker layer from `this.placements`. Each marker
   * is a small filled square plus a label ("P" / "E0" / "N1") drawn at the
   * tile's centre. Only visible in exact mode — zones mode hides them all.
   */
  private renderPlacementMarkers(): void {
    const { scene, thumbX, thumbY, tileSize } = this.opts;
    for (const { rect, label } of this.placementMarkers.values()) {
      rect.destroy();
      label.destroy();
    }
    this.placementMarkers.clear();
    if (this.placementMode !== "exact") return;
    for (const p of this.placements) {
      const px = thumbX + p.x * tileSize + tileSize / 2;
      const py = thumbY + p.y * tileSize + tileSize / 2;
      const colour =
        p.role === "player"  ? 0x3388ff :
        p.role === "enemy"   ? 0xff4444 :
        p.role === "ally"    ? 0x66cc88 :
                                0xe2b96f;  // neutral
      const rect = scene.add.rectangle(px, py, tileSize - 2, tileSize - 2, colour, 0.7)
        .setStrokeStyle(2, colour, 1);
      const labelText = p.role === "player" ? "P" : `${p.role.charAt(0).toUpperCase()}${p.index}`;
      const fontSize = Math.max(8, Math.floor(tileSize * 0.5));
      const label = scene.add.text(px, py, labelText, {
        fontSize: `${fontSize}px`,
        color: "#0a0e16",
        fontFamily: "monospace",
        fontStyle: "bold",
      }).setOrigin(0.5);
      rect.setVisible(this.layerVisible.monsters);
      label.setVisible(this.layerVisible.monsters);
      this.mapContainer.add(rect);
      this.mapContainer.add(label);
      this.placementMarkers.set(`${p.role}:${p.x},${p.y}`, { rect, label });
    }
  }
}

/** Parse a `#rrggbb` (or `#rgb`) CSS hex string to a Phaser numeric colour,
 *  falling back to `fallback` on anything unparseable. */
function parseCssHex(hex: string, fallback: number): number {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex?.trim() ?? "");
  if (!m) return fallback;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return parseInt(h, 16);
}
