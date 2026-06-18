import Phaser from "phaser";
import { gameClient } from "../net/GameClient";
import { EmbeddedMapPreview, type MapPreviewData } from "../ui/EmbeddedMapPreview";
import { MapSelectorOverlay } from "../ui/generate/MapSelectorOverlay";
import type { SavedMapDef } from "../../../shared/types";
import { DevMode } from "../devMode";
import {
  createHtmlButton,
  createHtmlText,
  type HtmlButtonHandle,
  type HtmlTextHandle,
} from "../ui/htmlButtons";
import {
  buildLineInput as sharedBuildLineInput,
  buildTextarea as sharedBuildTextarea,
} from "../ui/sceneInputs";
import { MapPalette } from "../ui/edit/MapPalette";
import { StructureList, TAKES_ROOMS, type StructureSpec } from "../ui/edit/StructureList";
import { RegionList, type RegionRowSpec, type BigMapSize } from "../ui/edit/RegionList";
import {
  TILE_SIZE,
  GRID_COLS,
  GRID_ROWS,
  HUD_HEIGHT,
  PLAYER_PANEL_WIDTH,
  TARGET_PANEL_WIDTH,
} from "../constants";

/**
 * MapEditorScene — top-level page focused exclusively on producing and
 * saving maps. The Encounter Creator picks up the saved maps from there.
 *
 * Layout:
 *   • LEFT (2/3 width) — generated content: name, description, embedded map
 *     preview with pan + zoom. Empty state on first load.
 *   • RIGHT (1/3 width) — controls. Two underlined chip-row tabs
 *     (DETERMINISTIC / GENERATIVE AI) drive what appears here:
 *       - DETERMINISTIC: terrain + feature chips.
 *       - GENERATIVE AI: free-text prompt + example cards.
 *   • BOTTOM — BACK + GENERATE MAP + SAVE MAP. GENERATE MAP runs either
 *     deterministic composition or AI generation depending on the active
 *     tab. SAVE MAP persists the latest preview.
 */

const W = PLAYER_PANEL_WIDTH + GRID_COLS * TILE_SIZE + TARGET_PANEL_WIDTH;
const H = GRID_ROWS * TILE_SIZE + HUD_HEIGHT;

const TITLE_Y = 28;
const CONTENT_TOP = 92;
const CONTENT_BOTTOM = H - 120;
const PANEL_PAD = 32;
const COL_GAP = 24;
const LEFT_FRACTION = 2 / 3;

type Tab = "deterministic" | "generative" | "edit" | "zones";
type BucketName = "always" | "det" | "gen" | "edit" | "zones";
type Disposable = HtmlButtonHandle | HtmlTextHandle | EditTabHandle;
/** Generic disposable used by the EDIT-tab bucket — MapPalette and the
 *  palette's scrollable thumbnail div both expose this shape. */
interface EditTabHandle {
  setVisible(visible: boolean): void;
  dispose(): void;
}

type Terrain = "grassland" | "forest" | "dungeon" | "cave" | "urban";
type Feature = "campsites" | "coastline" | "path" | "intersection" | "3-room" | "5-room" | "stairs";

const OUTSIDE_TERRAINS: Terrain[] = ["grassland", "forest", "urban"];
const INSIDE_TERRAINS:  Terrain[] = ["dungeon", "cave"];
const OUTSIDE_FEATURES: Feature[] = ["campsites", "coastline", "path", "intersection"];
const INSIDE_FEATURES:  Feature[] = ["3-room", "5-room", "stairs"];

/** Per-terrain whitelist of features the composer actually consumes. The
 *  Map Editor's feature chips enable / disable themselves against this
 *  table — outdoor features only fire on `grassland` / `forest`, the
 *  room-count features only fire on `dungeon` / `cave` (small vs large),
 *  and `urban` only consumes the `buildings` count. */
const TERRAIN_COMPATIBLE_FEATURES: Record<Terrain, Feature[]> = {
  grassland: OUTSIDE_FEATURES,
  forest:    OUTSIDE_FEATURES,
  dungeon:   INSIDE_FEATURES,
  cave:      INSIDE_FEATURES,
  urban:     [],
};

const TERRAIN_LABEL: Record<Terrain, string> = {
  grassland: "GRASSLAND",
  forest: "FOREST",
  dungeon: "DUNGEON",
  cave: "CAVE",
  urban: "TOWN",
};
const FEATURE_LABEL: Record<Feature, string> = {
  campsites: "CAMPSITES",
  coastline: "COASTLINE",
  path: "PATH",
  intersection: "INTERSECTION",
  "3-room": "3 ROOMS",
  "5-room": "5 ROOMS",
  stairs: "STAIRS",
};

/** Default canvas size when composing a single-terrain map carrying placeables
 *  (structures + set-pieces) — a comfortable field with room for a few. */
const PLACEABLE_MAP_SIZE = { width: 30, height: 22 };
function featureColumn(_f: Feature): "outside" | "inside" {
  return "outside";
}
function terrainColumn(_t: Terrain): "outside" | "inside" {
  return "outside";
}

interface PromptExample { title: string; body: string; }
// Map-only examples — focus on terrain, architecture, layout, atmosphere.
// Do NOT mention NPCs, monsters, conflicts, or anything an encounter would
// own (story / objective / dialogue). The Encounter Creator handles those
// later on top of a saved map.
const PROMPT_EXAMPLES: PromptExample[] = [
  { title: "Flooded Cavern",       body: "A natural cave: an open cavern of dust and gravel floor with rocky walls all around. A still underground pool fills the north-east corner, and a narrow bottomless chasm splits the cave near the centre. A single passage exits to the south." },
  { title: "Market Square",        body: "A paved town square of cobbles and large slabs, with a small plaza of finer stone at its centre. Three brick buildings face the square, each with a door onto it, linked by stone paths. Market stalls (crates and barrels) cluster near the centre." },
  { title: "River Crossing",       body: "A river runs north to south across grassland, splitting the map. The east bank is open field with a campsite; the west bank is forest. A path leads down to the water on each side where a crossing meets the bank." },
  { title: "Five-Room Dungeon",    body: "A stone dungeon of five chambers linked by corridors, carved from solid rock. The entrance room opens at the south edge; the deepest chamber to the north is a vault. Cracked-stone floors, a couple of pools as hazards." },
  { title: "Forest Clearing",      body: "An irregular clearing in a pine forest, roughly twenty tiles across. Grass in the centre fading to dense trees at the edges, with scattered flowers. A cold campfire sits near the west tree line." },
  { title: "Tavern Common Room",   body: "Interior of a tavern: wood-plank floor, walls on all four sides with a single door on the south edge. A long bar along the north wall and several tables with chairs spaced around the room." },
];

const ACCENT = "#7aadcc";
const TAB_INK = "#ffe9a8";

export class MapEditorScene extends Phaser.Scene {
  private tab: Tab = "deterministic";
  private tabDetBtn: HtmlButtonHandle | null = null;
  private tabGenBtn: HtmlButtonHandle | null = null;
  private tabEditBtn: HtmlButtonHandle | null = null;
  private tabZonesBtn: HtmlButtonHandle | null = null;
  private buckets: Record<BucketName, Disposable[]> = { always: [], det: [], gen: [], edit: [], zones: [] };

  // EDIT tab — the entire palette / paint controller lives in MapPalette.
  // Constructed lazily by `buildEditPanel` so the registry-backed legend
  // payloads are guaranteed to be loaded at first use.
  private mapPalette: MapPalette | null = null;

  // ZONES tab — manager for author-time named tile regions. Same lazy
  // construction pattern as MapPalette.
  private zonePalette: import("../ui/edit/ZonePalette").ZonePalette | null = null;

  // LAYERS dropdown — toggles per-layer visibility on the preview. The
  // button sits over the preview; the panel slides down from it.
  private layersBtn: HtmlButtonHandle | null = null;
  private layersPanel: HTMLDivElement | null = null;

  // Deterministic tab state.
  private selectedTerrain: Terrain | null = "grassland";
  private selectedFeatures: Set<Feature> = new Set();
  private terrainChips: Map<Terrain, HtmlButtonHandle> = new Map();
  private featureChips: Map<Feature, HtmlButtonHandle> = new Map();
  /** The unified placeable catalog (structures + set-pieces) authored via the
   *  STRUCTURES list — each entry a building/ruin/tavern/watchtower/… stamped
   *  onto the terrain or big map (Phase B 4a). */
  private structures: StructureSpec[] = [];
  private structureList: StructureList | null = null;
  /** BIG MAP mode (US-126): 2+ regions switch GENERATE to the multi-region
   *  composer; the single-terrain controls are ignored while active. */
  private regions: RegionRowSpec[] = [];
  private bigMapSize: BigMapSize = { width: 60, height: 28 };
  private regionList: RegionList | null = null;

  // Generative AI tab state.
  private genPromptInput: HTMLTextAreaElement | null = null;

  // Bottom-bar buttons.
  private loadBtn!: HtmlButtonHandle;
  private generateBtn!: HtmlButtonHandle;
  private regenBtn: HtmlButtonHandle | null = null;
  private saveBtn!: HtmlButtonHandle;

  // Placed structures on the current preview (Phase B) — for in-place interior
  // re-roll without recomposing the whole map.
  private lastPlacements: import("../net/AuthoringApi").PlacementRecord[] = [];

  // Left-column preview.
  private preview: EmbeddedMapPreview | null = null;
  private previewedMap: MapPreviewData | null = null;
  private savedMapId: string | null = null;
  private nameInput: HTMLInputElement | null = null;
  private descInput: HTMLTextAreaElement | null = null;
  /** When set, the current preview is an edit of a saved map. The next
   *  SAVE MAP overwrites that map in place instead of allocating a new
   *  id. Cleared whenever the user generates a fresh map. */
  private editingMapId: string | null = null;
  private mapSelector: MapSelectorOverlay | null = null;

  // Shared chrome.
  private statusEl: HTMLDivElement | null = null;
  private busy = false;

  constructor() {
    super({ key: "MapEditorScene" });
  }

  init(): void {
    this.tab = "deterministic";
    this.selectedTerrain = "grassland";
    this.selectedFeatures.clear();
    this.structures = [];
    this.terrainChips.clear();
    this.featureChips.clear();
    this.buckets = { always: [], det: [], gen: [], edit: [], zones: [] };
    this.previewedMap = null;
    this.savedMapId = null;
    this.editingMapId = null;
    this.busy = false;
    this.mapPalette = null;
  }

  create(): void {
    // Defensive: a previous scene (especially GameScene with its WASD player
    // controls) may have left global keyboard capture on, which calls
    // preventDefault for W/A/S/D and blocks them from reaching any HTML
    // input on this page. Clear it so the inputs receive every key.
    this.input.keyboard?.disableGlobalCapture();
    this.input.keyboard?.clearCaptures();

    this.add.rectangle(W / 2, H / 2, W, H, 0x0d0d1e);
    this.add.rectangle(W / 2, TITLE_Y + 38, W - 64, 1, 0x334455);

    this.addToBucket("always", createHtmlText({
      scene: this, sceneWidth: W,
      x: 0, y: TITLE_Y, w: W, h: 28,
      text: "MAP CREATOR",
      fontSize: 22, color: "#e2b96f", align: "center", letterSpacing: 1,
    }));
    this.addToBucket("always", createHtmlText({
      scene: this, sceneWidth: W,
      x: 0, y: TITLE_Y + 50, w: W, h: 16,
      text: "Author maps here. Build encounters from them in the Encounter Creator.",
      fontSize: 11, color: "#88aacc", align: "center",
    }));

    this.buildLeftColumn();
    this.buildRightColumn();
    this.buildStatusLine();
    this.buildBottomBar();
    if (DevMode.enabled) this.buildDevButton();

    this.activateTab("deterministic");

    this.events.once("shutdown", () => this.teardownDom());
    this.events.once("destroy",  () => this.teardownDom());
  }

  // ── Left column: name, description, embedded preview ──────────────────

  private buildLeftColumn(): void {
    const colW = Math.floor((W - PANEL_PAD * 2 - COL_GAP) * LEFT_FRACTION);
    const colX = PANEL_PAD;
    const colY = CONTENT_TOP;
    const colH = CONTENT_BOTTOM - CONTENT_TOP;

    // Title + description editable inputs at the top of the left column.
    // Both are commit-on-input — the values flow straight onto `previewedMap`
    // so the next SAVE MAP writes the user-edited copy.
    const titleH = 30;
    const descH = 56;
    this.nameInput = this.buildLineInput(
      colX, colY, colW, titleH,
      "Map title",
      (val) => {
        if (this.previewedMap) this.previewedMap = { ...this.previewedMap, name: val };
        // Any edit re-arms SAVE so the user can persist the change.
        this.savedMapId = null;
        this.refreshButtons();
      },
      "",
    );
    // Centered, larger, more title-like styling — overrides the default.
    this.nameInput.style.textAlign = "center";
    this.nameInput.style.fontSize = "18px";
    this.nameInput.style.color = "#e8e8f8";
    this.nameInput.style.borderColor = "#334455";
    this.nameInput.style.background = "transparent";

    this.descInput = this.buildTextarea(
      colX, colY + titleH + 6, colW, descH,
      "Short flavour description shown alongside the preview.",
      (val) => {
        if (this.previewedMap) this.previewedMap = { ...this.previewedMap, description: val };
        this.savedMapId = null;
        this.refreshButtons();
      },
      "",
    );
    this.descInput.style.fontSize = "12px";
    this.descInput.style.color = "#aabbcc";
    this.descInput.style.borderColor = "#334455";
    this.descInput.style.background = "transparent";

    // Map preview viewport — fills the rest of the left column.
    const previewY = colY + titleH + 6 + descH + 14;
    const previewH = colY + colH - previewY;
    this.preview = new EmbeddedMapPreview(this, {
      x: colX, y: previewY, width: colW, height: previewH,
    }, { busyText: "Building map… (the AI is placing features step by step)" });

    // LAYERS toggle — small chip in the top-right corner of the preview
    // viewport. Clicking it pops the per-layer checkboxes panel.
    this.buildLayersToggle(colX + colW - 90, previewY + 8);
  }

  /** Floating LAYERS button + dropdown overlay anchored to the preview
   *  viewport. Toggles per-layer visibility on the embedded preview without
   *  mutating the map data. */
  private buildLayersToggle(x: number, y: number): void {
    const btn = createHtmlButton({
      scene: this, sceneWidth: W,
      x, y, w: 80, h: 24,
      label: "LAYERS ▾", variant: "secondary", fontSize: 10,
      onClick: () => this.toggleLayersPanel(),
    });
    this.layersBtn = btn;
    this.addToBucket("always", btn);
  }

  private toggleLayersPanel(): void {
    if (this.layersPanel) {
      // Run the per-panel cleanup hook installed at open time so the
      // window resize listener doesn't leak after the panel is dropped.
      const c = (this.layersPanel as HTMLElement & { __cleanup?: () => void }).__cleanup;
      if (c) c();
      this.layersPanel.remove();
      this.layersPanel = null;
      return;
    }
    if (!this.preview || !this.layersBtn) return;
    const panel = document.createElement("div");
    panel.style.cssText = `
      position: absolute;
      background: #0f1320; border: 1px solid #334455;
      color: #cce4ff; font-family: monospace; font-size: 11px;
      padding: 10px 12px; z-index: 60;
      display: flex; flex-direction: column; gap: 8px;
      pointer-events: auto;
    `;
    // Swallow all pointer events on the panel so they don't reach the
    // Phaser canvas underneath. Without this, click + drag inside the
    // panel can still drag the embedded preview's pan / fire stray cell
    // clicks. The panel stays open until the LAYERS button is clicked
    // again — no outside-click auto-close.
    const swallow = (e: Event): void => e.stopPropagation();
    panel.addEventListener("mousedown", swallow);
    panel.addEventListener("mouseup", swallow);
    panel.addEventListener("click", swallow);
    panel.addEventListener("wheel", swallow);
    document.body.appendChild(panel);

    // Anchor the panel directly under the LAYERS button.
    const place = (): void => {
      const r = (this.layersBtn!.el as HTMLElement).getBoundingClientRect();
      panel.style.left = `${r.left}px`;
      panel.style.top  = `${r.bottom + 4}px`;
      panel.style.minWidth = `${Math.max(160, r.width + 80)}px`;
    };
    place();
    const onResize = (): void => place();
    window.addEventListener("resize", onResize);
    // Cleanup hook so we can drop the resize listener when the panel is
    // removed via the LAYERS toggle button.
    (panel as HTMLElement & { __cleanup?: () => void }).__cleanup = () => {
      window.removeEventListener("resize", onResize);
    };

    const initial = this.preview.getLayerVisibility();
    const addRow = (key: 'terrain' | 'object' | 'zones', label: string): void => {
      const row = document.createElement("label");
      row.style.cssText = "display:flex; gap:10px; align-items:center; cursor:pointer; padding:2px 0;";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = initial[key];
      cb.addEventListener("change", () => {
        this.preview?.setLayerVisible(key, cb.checked);
      });
      const txt = document.createElement("span");
      txt.textContent = label;
      row.appendChild(cb);
      row.appendChild(txt);
      panel.appendChild(row);
    };
    addRow("terrain", "Terrain");
    addRow("object",  "Objects");
    addRow("zones",   "Zones");

    this.layersPanel = panel;
  }

  /** Single-line cousin of `buildTextarea`. Used by the editable map title. */
  private buildLineInput(
    x: number, y: number, w: number, h: number,
    placeholder: string,
    onInput: (value: string) => void,
    initialValue = "",
  ): HTMLInputElement {
    return sharedBuildLineInput({
      scene: this, sceneWidth: W,
      x, y, w, h,
      placeholder, initialValue,
      fontSize: 13,
      onInput,
    }).el;
  }

  // ── Right column: chip-style tabs + per-tab controls ──────────────────

  private buildRightColumn(): void {
    const leftColW = Math.floor((W - PANEL_PAD * 2 - COL_GAP) * LEFT_FRACTION);
    const colX = PANEL_PAD + leftColW + COL_GAP;
    const colW = W - PANEL_PAD - colX;
    const colY = CONTENT_TOP;

    // Chip-row tabs — match CharacterSheetOverlay styling (text label with
    // underline accent on the active tab).
    const tabBarH = 30;
    this.buildOuterTabBar(colX, colY, colW, tabBarH);

    const innerTop = colY + tabBarH + 12;
    const innerH = CONTENT_BOTTOM - innerTop;

    this.buildDeterministicPanel(colX, innerTop, colW, innerH);
    this.buildGenerativePanel(colX, innerTop, colW, innerH);
    this.buildEditPanel(colX, innerTop, colW, innerH);
    this.buildZonesPanel(colX, innerTop, colW, innerH);
  }

  private buildOuterTabBar(x: number, y: number, w: number, h: number): void {
    const slotW = Math.floor(w / 4);
    this.tabDetBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x, y, w: slotW, h,
      label: "DETERMINISTIC", variant: "secondary", fontSize: 11,
      onClick: () => this.activateTab("deterministic"),
    });
    this.tabGenBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: x + slotW, y, w: slotW, h,
      label: "GENERATIVE AI", variant: "secondary", fontSize: 11,
      onClick: () => this.activateTab("generative"),
    });
    this.tabEditBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: x + 2 * slotW, y, w: slotW, h,
      label: "EDIT", variant: "secondary", fontSize: 11,
      onClick: () => this.activateTab("edit"),
    });
    this.tabZonesBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: x + 3 * slotW, y, w: w - 3 * slotW, h,
      label: "ZONES", variant: "secondary", fontSize: 11,
      onClick: () => this.activateTab("zones"),
    });
    this.styleChipTab(this.tabDetBtn, this.tab === "deterministic");
    this.styleChipTab(this.tabGenBtn, this.tab === "generative");
    this.styleChipTab(this.tabEditBtn, this.tab === "edit");
    this.styleChipTab(this.tabZonesBtn, this.tab === "zones");
    this.addToBucket("always", this.tabDetBtn);
    this.addToBucket("always", this.tabGenBtn);
    this.addToBucket("always", this.tabEditBtn);
    this.addToBucket("always", this.tabZonesBtn);
  }

  /** Style the tab button as a transparent chip with an accent underline
   *  when active. Mirrors the look of the in-game CharacterSheetOverlay. */
  private styleChipTab(btn: HtmlButtonHandle, active: boolean): void {
    btn.el.style.background = active ? "#0d2a3a" : "transparent";
    btn.el.style.border = "none";
    btn.el.style.borderBottom = `2px solid ${active ? ACCENT : "transparent"}`;
    btn.el.style.color = active ? ACCENT : "#778899";
    btn.el.style.letterSpacing = "1px";
  }

  private activateTab(tab: Tab): void {
    this.tab = tab;
    if (this.tabDetBtn)   this.styleChipTab(this.tabDetBtn,   tab === "deterministic");
    if (this.tabGenBtn)   this.styleChipTab(this.tabGenBtn,   tab === "generative");
    if (this.tabEditBtn)  this.styleChipTab(this.tabEditBtn,  tab === "edit");
    if (this.tabZonesBtn) this.styleChipTab(this.tabZonesBtn, tab === "zones");
    this.setBucketVisible("det",   tab === "deterministic");
    this.setBucketVisible("gen",   tab === "generative");
    this.setBucketVisible("edit",  tab === "edit");
    this.setBucketVisible("zones", tab === "zones");
    if (this.genPromptInput) this.genPromptInput.style.display = tab === "generative" ? "" : "none";
    // Preview cell-click handler: EDIT paints tiles; ZONES toggles tiles
    // in the active zone; the other tabs strip the handler entirely so a
    // stray click doesn't mutate the map.
    if (this.preview) {
      if (tab === "edit") {
        this.preview.setOnCellClick((col, row) => this.paintCell(col, row));
      } else if (tab === "zones") {
        this.preview.setOnCellClick((col, row) => this.zonePalette?.paintCell(col, row));
      } else {
        this.preview.setOnCellClick(null);
      }
    }
    this.refreshButtons();
  }

  // ── Deterministic right-column controls ────────────────────────────────

  private buildDeterministicPanel(x: number, y: number, w: number, h: number): void {
    void h; // height not consumed directly — layout flows top-down within the column
    this.addToBucket("det", createHtmlText({
      scene: this, sceneWidth: W,
      x, y, w, h: 14,
      text: "MAP CONTROLS",
      fontSize: 10, color: "#556677", align: "center", letterSpacing: 2,
    }));

    const chipW = Math.min(160, Math.floor((w - 14) / 2));
    const chipGap = 14;
    const allTerrains: Terrain[] = [...OUTSIDE_TERRAINS, ...INSIDE_TERRAINS];
    const allFeatures: Feature[] = [...OUTSIDE_FEATURES, ...INSIDE_FEATURES];

    const terrainLabelY = y + 28;
    this.addToBucket("det", createHtmlText({
      scene: this, sceneWidth: W,
      x, y: terrainLabelY, w, h: 14,
      text: "TERRAIN",
      fontSize: 10, color: "#778899", letterSpacing: 1,
    }));

    // Terrain chips stack vertically — only 3 of them, plenty of width.
    const terrainRowY = terrainLabelY + 22;
    allTerrains.forEach((t, i) => {
      const cx = x + (i % 2) * (chipW + chipGap);
      const cy = terrainRowY + Math.floor(i / 2) * 32;
      this.buildTerrainChip(t, cx, cy, chipW);
    });
    const terrainEndY = terrainRowY + Math.ceil(allTerrains.length / 2) * 32;

    // Features header + grid below.
    const featuresLabelY = terrainEndY + 14;
    this.addToBucket("det", createHtmlText({
      scene: this, sceneWidth: W,
      x, y: featuresLabelY, w, h: 14,
      text: "FEATURES",
      fontSize: 10, color: "#778899", letterSpacing: 1,
    }));
    const featuresRowY = featuresLabelY + 22;
    allFeatures.forEach((f, j) => {
      const cx = x + (j % 2) * (chipW + chipGap);
      const cy = featuresRowY + Math.floor(j / 2) * 32;
      this.buildFeatureChip(f, cx, cy, chipW);
    });
    const featuresEndY = featuresRowY + Math.ceil(allFeatures.length / 2) * 32;

    // Set-pieces — prebuilt recipes stamped on a flat field (one click, no LLM).
    // Structures & set-pieces — one unified catalog (Phase B 4a): add buildings,
    // ruins, taverns, watchtowers, … each placed onto the terrain or big map.
    const structLabelY = featuresEndY + 14;
    this.addToBucket("det", createHtmlText({
      scene: this, sceneWidth: W,
      x, y: structLabelY, w, h: 14,
      text: "STRUCTURES & SET-PIECES",
      fontSize: 10, color: "#778899", letterSpacing: 1,
    }));
    const listY = structLabelY + 20;
    // Split the remaining column between STRUCTURES and BIG MAP — REGIONS.
    const remaining = Math.max(220, y + h - listY);
    const listH = Math.max(96, Math.floor(remaining * 0.45) - 34);
    this.structureList = new StructureList({
      scene: this, sceneWidth: W,
      get: () => this.structures,
      set: (next) => { this.structures = next; this.refreshButtons(); },
      // Region names for big-map structure targeting (Phase B #3).
      getRegions: () => this.regions.length >= 2 ? this.regions.map((r, i) => `${i + 1} · ${r.terrain}`) : [],
    });
    this.addToBucket("det", this.structureList.build(x, listY, w, listH));
    this.structureList.setApplicable(this.structuresApplicable());

    // BIG MAP — REGIONS (US-126): 2-5 biome bands composed as one large map.
    const regionLabelY = listY + listH + 14;
    this.addToBucket("det", createHtmlText({
      scene: this, sceneWidth: W,
      x, y: regionLabelY, w, h: 14,
      text: "BIG MAP — REGIONS",
      fontSize: 10, color: "#778899", letterSpacing: 1,
    }));
    const regionListY = regionLabelY + 20;
    const regionListH = Math.max(96, y + h - regionListY);
    this.regionList = new RegionList({
      scene: this, sceneWidth: W,
      get: () => this.regions,
      set: (next) => {
        this.regions = next;
        // Crossing the big-map threshold flips whether structures + road features apply.
        this.structureList?.setApplicable(this.structuresApplicable());
        this.refreshFeatureChips();
        this.refreshButtons();
      },
      getSize: () => this.bigMapSize,
      setSize: (next) => { this.bigMapSize = next; },
    });
    this.addToBucket("det", this.regionList.build(x, regionListY, w, regionListH));
  }

  // ── Generative AI right-column controls ────────────────────────────────

  private buildGenerativePanel(x: number, y: number, w: number, h: number): void {
    this.addToBucket("gen", createHtmlText({
      scene: this, sceneWidth: W,
      x, y, w, h: 14,
      text: "DESCRIBE THE MAP",
      fontSize: 10, color: "#556677", align: "center", letterSpacing: 2,
    }));
    const hintY = y + 22;
    this.addToBucket("gen", createHtmlText({
      scene: this, sceneWidth: W,
      x, y: hintY, w, h: 28,
      text: "Describe a place — caves, towns, rivers, dungeons. The AI builds it step by step (may take ~20s).",
      fontSize: 11, color: "#aabbcc", fontFamily: "sans-serif", align: "center",
    }));

    const promptY = hintY + 36;
    const promptH = 140;
    this.genPromptInput = this.buildTextarea(
      x, promptY, w, promptH,
      "A description of the map…",
      () => this.refreshButtons(),
    );

    // Examples below the textarea — vertical list filling the rest.
    const examplesY = promptY + promptH + 14;
    this.addToBucket("gen", createHtmlText({
      scene: this, sceneWidth: W,
      x, y: examplesY, w, h: 14,
      text: "EXAMPLES",
      fontSize: 10, color: "#778899", letterSpacing: 1, align: "left",
    }));
    const cardY0 = examplesY + 20;
    const availH = (y + h) - cardY0;
    const cardCount = PROMPT_EXAMPLES.length;
    const cardGap = 6;
    const cardH = Math.max(56, Math.floor((availH - (cardCount - 1) * cardGap) / cardCount));
    PROMPT_EXAMPLES.forEach((ex, idx) => {
      const cy = cardY0 + idx * (cardH + cardGap);
      const cardBtn = createHtmlButton({
        scene: this, sceneWidth: W,
        x, y: cy, w, h: cardH,
        label: "", variant: "ghost",
        onClick: () => {
          if (this.genPromptInput) {
            this.genPromptInput.value = ex.body;
            this.genPromptInput.focus();
            this.refreshButtons();
          }
        },
      });
      cardBtn.el.textContent = "";
      cardBtn.el.style.padding = "8px 10px";
      cardBtn.el.style.background = "#141426";
      cardBtn.el.style.borderColor = "#334455";
      cardBtn.el.style.display = "flex";
      cardBtn.el.style.flexDirection = "column";
      cardBtn.el.style.alignItems = "stretch";
      cardBtn.el.style.justifyContent = "flex-start";
      cardBtn.el.style.whiteSpace = "normal";
      cardBtn.el.style.overflow = "hidden";
      const title = document.createElement("div");
      title.textContent = ex.title;
      title.style.cssText = "font-size: 12px; color: #e2b96f; font-family: monospace; text-align: left;";
      cardBtn.el.appendChild(title);
      const body = document.createElement("div");
      body.textContent = ex.body;
      body.style.cssText = "margin-top: 6px; font-size: 10px; color: #8899aa; font-family: sans-serif; line-height: 1.4; text-align: left;";
      cardBtn.el.appendChild(body);
      this.addToBucket("gen", cardBtn);
    });
  }

  // ── EDIT tab — tile palette + paint controls ───────────────────────────

  private buildEditPanel(x: number, y: number, w: number, h: number): void {
    if (this.mapPalette) this.mapPalette.dispose();
    this.mapPalette = new MapPalette({
      scene: this,
      sceneWidth: W,
      getMap: () => this.previewedMap,
      repaintPreview: () => { this.preview?.repaintInPlace(); },
      reloadPreview: () => { if (this.preview && this.previewedMap) this.preview.setData(this.previewedMap); },
      setStatus: (text) => { if (this.statusEl) this.statusEl.textContent = text; },
      markMapDirty: () => { this.savedMapId = null; },
      refreshButtons: () => this.refreshButtons(),
    });
    for (const handle of this.mapPalette.build(x, y, w, h)) {
      this.addToBucket("edit", handle);
    }
  }

  /** Forward an EDIT-tab cell click to the palette. Wired in `activateTab`. */
  private paintCell(col: number, row: number): void {
    this.mapPalette?.paintCell(col, row);
  }

  /** Build the ZONES tab — author-time named tile regions. Lazy
   *  construction mirrors `buildEditPanel`. */
  private async buildZonesPanel(x: number, y: number, w: number, h: number): Promise<void> {
    // Dynamic import keeps the ZonePalette out of the initial scene bundle
    // until the user actually visits the ZONES tab the first time.
    const { ZonePalette } = await import("../ui/edit/ZonePalette");
    if (this.zonePalette) this.zonePalette.dispose();
    this.zonePalette = new ZonePalette({
      scene: this,
      sceneWidth: W,
      getMap: () => this.previewedMap,
      repaintPreview: () => { this.preview?.repaintInPlace(); },
      setStatus: (text) => { if (this.statusEl) this.statusEl.textContent = text; },
      markMapDirty: () => { this.savedMapId = null; this.refreshButtons(); },
    });
    for (const handle of this.zonePalette.build(x, y, w, h)) {
      this.addToBucket("zones", handle);
    }
    // Hidden by default — only shown when the user picks the ZONES tab.
    this.setBucketVisible("zones", this.tab === "zones");
  }

  // ── Bucket / chip helpers ───────────────────────────────────────────────

  private addToBucket(bucket: BucketName, handle: Disposable): void {
    this.buckets[bucket].push(handle);
  }
  private setBucketVisible(bucket: BucketName, visible: boolean): void {
    for (const h of this.buckets[bucket]) h.setVisible(visible);
  }
  private disposeBucket(bucket: BucketName): void {
    for (const h of this.buckets[bucket]) h.dispose();
    this.buckets[bucket] = [];
  }

  private buildTerrainChip(t: Terrain, x: number, y: number, w: number): void {
    const h = 26;
    const btn = createHtmlButton({
      scene: this, sceneWidth: W,
      x, y, w, h,
      label: TERRAIN_LABEL[t], variant: "secondary", fontSize: 10,
      onClick: () => {
        const wasSelected = this.selectedTerrain === t;
        this.selectedTerrain = wasSelected ? null : t;
        this.selectedFeatures.clear();
        this.refreshTerrainChips();
        this.refreshFeatureChips();
        this.structureList?.setApplicable(this.structuresApplicable());
        this.refreshButtons();
      },
    });
    this.terrainChips.set(t, btn);
    this.addToBucket("det", btn);
    this.refreshTerrainChips();
  }

  /** Placeables (structures + set-pieces) apply on a BIG MAP (stamped onto the
   *  regions) or on a single OPEN terrain (grassland/forest/town). */
  private structuresApplicable(): boolean {
    if (this.regions.length >= 2) return true;
    return this.selectedTerrain !== null && OUTSIDE_TERRAINS.includes(this.selectedTerrain);
  }

  private buildFeatureChip(f: Feature, x: number, y: number, w: number): void {
    const h = 26;
    const btn = createHtmlButton({
      scene: this, sceneWidth: W,
      x, y, w, h,
      label: FEATURE_LABEL[f], variant: "secondary", fontSize: 10,
      onClick: () => {
        if (!this.featureChipEnabled(f)) return;
        if (f === "3-room" || f === "5-room") {
          // Room count is a radio pair: selecting one clears the other (you can
          // pick 3 OR 5 rooms, never both). STAIRS stays an independent toggle.
          this.selectedFeatures.delete(f === "3-room" ? "5-room" : "3-room");
          if (this.selectedFeatures.has(f)) this.selectedFeatures.delete(f);
          else this.selectedFeatures.add(f);
        } else {
          if (this.selectedFeatures.has(f)) this.selectedFeatures.delete(f);
          else this.selectedFeatures.add(f);
        }
        this.refreshFeatureChips();
        this.refreshButtons();
      },
    });
    this.featureChips.set(f, btn);
    this.addToBucket("det", btn);
    this.refreshFeatureChips();
  }

  private featureChipEnabled(f: Feature): boolean {
    // BIG MAP: only the road features (path / intersection) apply — they're laid
    // across the open bands. The rest are per-terrain / per-region fill.
    if (this.regions.length >= 2) return f === "path" || f === "intersection";
    if (this.selectedTerrain === null) return false;
    return TERRAIN_COMPATIBLE_FEATURES[this.selectedTerrain].includes(f);
  }

  private refreshTerrainChips(): void {
    for (const [t, btn] of this.terrainChips) {
      const on = this.selectedTerrain === t;
      btn.el.style.background = on ? "#2a8866" : "#1a1a2a";
      btn.el.style.borderColor = on ? "#2a8866" : "#445566";
      btn.el.style.color = on ? "#ffffff" : "#aabbcc";
      btn.el.style.opacity = on ? "0.85" : "1";
      btn.el.style.cursor = "pointer";
    }
  }

  private refreshFeatureChips(): void {
    for (const [f, btn] of this.featureChips) {
      const enabled = this.featureChipEnabled(f);
      const on = enabled && this.selectedFeatures.has(f);
      if (!enabled) {
        btn.el.style.background = "#14141e";
        btn.el.style.borderColor = "#2a3340";
        btn.el.style.color = "#3a4555";
        btn.el.style.opacity = "1";
        btn.el.style.cursor = "default";
      } else {
        btn.el.style.background = on ? "#aa6633" : "#1a1a2a";
        btn.el.style.borderColor = on ? "#aa6633" : "#445566";
        btn.el.style.color = on ? "#ffffff" : "#aabbcc";
        btn.el.style.opacity = on ? "0.85" : "1";
        btn.el.style.cursor = "pointer";
      }
    }
  }

  // ── DOM textarea + status line ──────────────────────────────────────────

  private buildTextarea(
    x: number, y: number, w: number, h: number,
    placeholder: string,
    onInput: (value: string) => void,
    initialValue = "",
  ): HTMLTextAreaElement {
    return sharedBuildTextarea({
      scene: this, sceneWidth: W,
      x, y, w, h,
      placeholder, initialValue,
      fontSize: 12, lineHeight: 1.4,
      scaleFont: true,
      onInput,
    }).el;
  }

  private buildStatusLine(): void {
    const status = document.createElement("div");
    status.style.cssText = `
      position: absolute;
      color: #889aac;
      font-family: monospace;
      font-size: 12px;
      pointer-events: none;
      z-index: 10;
    `;
    document.body.appendChild(status);
    this.statusEl = status;
    const place = () => {
      const rect = this.sys.game.canvas.getBoundingClientRect();
      const s = rect.width / W;
      status.style.left = `${rect.left + PANEL_PAD * s}px`;
      status.style.top  = `${rect.top + (CONTENT_BOTTOM - 4) * s}px`;
      status.style.fontSize = `${12 * s}px`;
    };
    place();
    this.scale.on("resize", place);
  }

  // ── Bottom bar ──────────────────────────────────────────────────────────

  private buildBottomBar(): void {
    this.add.rectangle(W / 2, H - 58, W - 64, 1, 0x334455);
    const btnH = 44;
    const y = H - 36 - btnH / 2;

    // BACK — left.
    const back = createHtmlButton({
      scene: this, sceneWidth: W,
      x: 40, y, w: 140, h: btnH,
      label: "BACK", variant: "secondary", fontSize: 13,
      onClick: () => this.scene.start("MainMenuScene"),
    });
    this.addToBucket("always", back);

    // LOAD MAP — between BACK and GENERATE. Picks an existing saved map
    // into the preview for editing; subsequent SAVE MAP updates that map.
    this.loadBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: 196, y, w: 200, h: btnH,
      label: "🗺 LOAD MAP", variant: "secondary", fontSize: 13,
      onClick: () => this.openMapSelector(),
    });
    this.loadBtn.el.style.background = "#2a1a3a";
    this.loadBtn.el.style.borderColor = "#5a4480";
    this.loadBtn.el.style.color = "#d8c8e8";
    this.addToBucket("always", this.loadBtn);

    // GENERATE MAP — centred. Drives both tabs.
    this.generateBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: W / 2 - 200 - 8, y, w: 280, h: btnH,
      label: "✨ GENERATE MAP", variant: "primary", fontSize: 14,
      onClick: () => this.runGenerate(),
    });
    this.addToBucket("always", this.generateBtn);

    // SAVE MAP — to the right of GENERATE.
    this.saveBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: W / 2 + 92, y, w: 220, h: btnH,
      label: "✓ SAVE MAP", variant: "secondary", fontSize: 14,
      onClick: () => this.runSaveMap(),
    });
    // Match the cooler blue from the prior modal's SAVE styling.
    this.saveBtn.el.style.background = "#2a3a55";
    this.saveBtn.el.style.borderColor = "#5588aa";
    this.saveBtn.el.style.color = "#cce4ff";
    this.addToBucket("always", this.saveBtn);

    // ↻ REGEN INTERIORS — re-rolls placed structures' interiors (e.g. a tavern's
    // furniture) in place, without recomposing the rest of the map. Only useful
    // when the current preview has placed structures.
    this.regenBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: W / 2 + 92 + 230, y, w: 210, h: btnH,
      label: "↻ REGEN INTERIORS", variant: "secondary", fontSize: 12,
      onClick: () => this.runRegenInteriors(),
    });
    this.regenBtn.el.style.background = "#23332a";
    this.regenBtn.el.style.borderColor = "#3f7a55";
    this.regenBtn.el.style.color = "#cfe9d6";
    this.addToBucket("always", this.regenBtn);
  }

  /** Re-roll the interiors of all placed structures on the current preview,
   *  leaving the rest of the map untouched. */
  private async runRegenInteriors(): Promise<void> {
    if (this.busy || !this.previewedMap || this.lastPlacements.length === 0) return;
    const m = this.previewedMap as unknown as {
      width: number; height: number; terrainData: number[]; objectData: number[];
      name?: string; description?: string;
      zones?: Array<{ id: string; name: string; color: string; cells: string[]; lightLevel?: 'bright' | 'dim' | 'dark' }>;
    };
    this.busy = true;
    this.refreshButtons();
    if (this.statusEl) this.statusEl.textContent = "Regenerating interiors…";
    if (this.preview) this.preview.setBusy(true);
    try {
      const data = await gameClient.restampMap({
        width: m.width, height: m.height, terrainData: m.terrainData, objectData: m.objectData,
        name: m.name, description: m.description, zones: m.zones, placements: this.lastPlacements,
      });
      if (this.statusEl) this.statusEl.textContent = "";
      this.applyPreviewData(data as MapPreviewData, { preserveView: true });
    } catch (err) {
      this.handleError(err, "Regenerate interiors");
    } finally {
      this.busy = false;
      if (this.preview) this.preview.setBusy(false);
      this.refreshButtons();
    }
  }

  private buildDevButton(): void {
    const btn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: W - 230, y: H - 50, w: 220, h: 28,
      label: "DEV: DELETE ALL GEN MAPS",
      variant: "danger", fontSize: 10,
      onClick: async () => {
        if (this.busy) return;
        this.busy = true;
        btn.setLabel("DELETING…");
        try {
          const { mapsDeleted, encountersDeleted } = await gameClient.deleteAllGeneratedMaps();
          if (this.statusEl) this.statusEl.textContent = `Deleted ${mapsDeleted} maps and ${encountersDeleted} encounters.`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (this.statusEl) this.statusEl.textContent = `Delete failed: ${msg}`;
        } finally {
          btn.setLabel("DEV: DELETE ALL GEN MAPS");
          this.busy = false;
          this.refreshButtons();
        }
      },
    });
    this.addToBucket("always", btn);
  }

  // ── Button enable/disable state ─────────────────────────────────────────

  private refreshButtons(): void {
    let genReady: boolean;
    if (this.tab === "deterministic") {
      genReady = (!!this.selectedTerrain || this.structures.length > 0 || this.regions.length >= 2) && !this.busy;
    } else {
      const promptLen = this.genPromptInput?.value.trim().length ?? 0;
      genReady = promptLen >= 8 && !this.busy;
    }
    this.generateBtn.setDisabled(!genReady);
    // REGEN INTERIORS is only meaningful when the preview has placed structures.
    if (this.regenBtn) {
      const canRegen = !!this.previewedMap && this.lastPlacements.length > 0 && !this.busy;
      this.regenBtn.setDisabled(!canRegen);
      this.regenBtn.el.style.opacity = canRegen ? "1" : "0.4";
    }
    // SAVE is enabled when we have an unsaved preview.
    const canSave = !!this.previewedMap && !this.savedMapId && !this.busy;
    this.saveBtn.setDisabled(!canSave);
    if (this.savedMapId) {
      this.saveBtn.setLabel("✓ SAVED");
      this.saveBtn.el.style.background = "#1a2222";
      this.saveBtn.el.style.borderColor = "#334455";
      this.saveBtn.el.style.color = "#556677";
    } else {
      this.saveBtn.setLabel("✓ SAVE MAP");
      this.saveBtn.el.style.background = "#2a3a55";
      this.saveBtn.el.style.borderColor = "#5588aa";
      this.saveBtn.el.style.color = canSave ? "#cce4ff" : TAB_INK;
    }
  }

  // ── Generate / Save ─────────────────────────────────────────────────────

  /** Single entry point for GENERATE MAP. Dispatches to deterministic
   *  compose or AI generate depending on the active tab. */
  private async runGenerate(): Promise<void> {
    if (this.tab === "deterministic") {
      await this.runComposeMap();
    } else {
      await this.runGenerateMap();
    }
  }

  private async runComposeMap(): Promise<void> {
    const bigMap = this.regions.length >= 2;
    if (!bigMap && !this.selectedTerrain && this.structures.length === 0) return;
    this.busy = true;
    this.refreshButtons();
    if (this.statusEl) this.statusEl.textContent = bigMap ? "Composing big map…" : "Composing map…";
    if (this.preview) this.preview.setBusy(true);
    try {
      // The unified placeable list (structures + set-pieces) is stamped onto the
      // base — a big map (regions), the selected open terrain, or a grass field —
      // re-rolling until everything fits cleanly. Building/ruin/tavern carry a room
      // count; set-pieces don't.
      const placeables = this.structures.map((s) => ({
        id: s.type,
        rooms: TAKES_ROOMS(s.type) ? s.rooms : undefined,
        region: s.region,
      }));
      const features = Array.from(this.selectedFeatures);
      const data = bigMap
        ? await gameClient.composeMap({ regions: this.regions, placeables, features, width: this.bigMapSize.width, height: this.bigMapSize.height })
        : await gameClient.composeMap({
            terrain: this.selectedTerrain ?? "grassland",
            features,
            placeables,
            width: PLACEABLE_MAP_SIZE.width,
            height: PLACEABLE_MAP_SIZE.height,
          });
      if (this.statusEl) this.statusEl.textContent = "";
      this.applyPreviewData(data as MapPreviewData);
    } catch (err) {
      this.handleError(err, "Compose map");
    } finally {
      this.busy = false;
      if (this.preview) this.preview.setBusy(false);
      this.refreshButtons();
    }
  }

  private async runGenerateMap(): Promise<void> {
    if (!this.genPromptInput) return;
    const prompt = this.genPromptInput.value.trim();
    if (prompt.length < 8) return;
    this.busy = true;
    this.refreshButtons();
    if (this.statusEl) this.statusEl.textContent = "Generating map…";
    if (this.preview) this.preview.setBusy(true);
    try {
      const data = await gameClient.generateMap(prompt);
      if (this.statusEl) this.statusEl.textContent = "";
      this.applyPreviewData(data as MapPreviewData);
    } catch (err) {
      this.handleError(err, "Map generate");
    } finally {
      this.busy = false;
      if (this.preview) this.preview.setBusy(false);
      this.refreshButtons();
    }
  }

  /** Push a freshly-produced map into the embedded preview + the left column
   *  header text. A new preview always starts unsaved and not in edit-mode.
   *  `preserveView` keeps the current zoom/pan (interior re-roll — same bounds). */
  private applyPreviewData(data: MapPreviewData, opts?: { preserveView?: boolean }): void {
    this.previewedMap = data;
    this.lastPlacements = (data as unknown as { placements?: import("../net/AuthoringApi").PlacementRecord[] }).placements ?? [];
    this.savedMapId = null;
    this.editingMapId = null;
    if (this.preview) this.preview.setData(data, opts);
    // Refresh the ZONES tab list against the new map's zones — without this
    // the user has to switch tabs to see them after a generate / load.
    this.zonePalette?.refresh();
    // Seed the editable inputs from the freshly-generated map. The user can
    // then refine before SAVE MAP commits.
    if (this.nameInput) this.nameInput.value = data.name || "";
    if (this.descInput) this.descInput.value = data.description || "";
  }

  private async runSaveMap(): Promise<void> {
    if (!this.previewedMap || this.savedMapId) return;
    const data = this.previewedMap;
    this.busy = true;
    this.refreshButtons();
    if (this.statusEl) this.statusEl.textContent = this.editingMapId ? "Updating map…" : "Saving map…";
    try {
      const { mapId } = await gameClient.saveMap({
        name: data.name,
        description: data.description,
        width: data.width,
        height: data.height,
        terrainData: data.terrainData,
        objectData: data.objectData,
        tilesets: data.tilesets,
        zones: data.zones,
        existingMapId: this.editingMapId ?? undefined,
      });
      this.savedMapId = mapId;
      this.previewedMap = { ...data, mapId };
      // The saved map list needs to refresh so the Encounter Creator sees
      // the new (or updated) entry on its next LOAD MAP without a page
      // reload. Also caches it locally as the "loaded" map so further
      // SAVEs continue to overwrite the same id.
      try {
        const maps = await gameClient.listMaps();
        this.registry.set("maps", maps);
      } catch { /* non-fatal — the next openMapSelector will retry */ }
      this.editingMapId = mapId;
      if (this.statusEl) this.statusEl.textContent = `Saved ${mapId}.`;
    } catch (err) {
      this.handleError(err, "Save map");
    } finally {
      this.busy = false;
      this.refreshButtons();
    }
  }

  /** Open the map picker. Choosing a map seeds the editor with that map's
   *  tiles + metadata; subsequent SAVE MAP overwrites it in place. */
  private openMapSelector(): void {
    if (this.mapSelector || this.busy) return;
    const maps = (this.registry.get("maps") as SavedMapDef[] | undefined) ?? [];
    if (maps.length === 0) {
      if (this.statusEl) this.statusEl.textContent = "No saved maps yet. Generate one first.";
      return;
    }
    this.mapSelector = new MapSelectorOverlay(this, maps, {
      onSelect: (map) => {
        this.closeMapSelector();
        this.loadSavedMap(map);
      },
      onClose: () => this.closeMapSelector(),
    });
  }

  private closeMapSelector(): void {
    if (this.mapSelector) { this.mapSelector.destroy(); this.mapSelector = null; }
  }

  private loadSavedMap(map: MapPreviewData): void {
    if (!map.mapId) {
      if (this.statusEl) this.statusEl.textContent = "Selected map has no id.";
      return;
    }
    this.previewedMap = map;
    this.savedMapId = null;
    this.editingMapId = map.mapId;
    if (this.preview) this.preview.setData(map);
    if (this.nameInput) this.nameInput.value = map.name || "";
    if (this.descInput) this.descInput.value = map.description || "";
    if (this.statusEl) this.statusEl.textContent = `Editing ${map.mapId}. SAVE MAP overwrites it; GENERATE MAP starts fresh.`;
    // Same refresh as in `applyPreviewData` — the user must see the loaded
    // map's existing zones in the ZONES tab without having to switch tabs.
    this.zonePalette?.refresh();
    this.refreshButtons();
  }

  private handleError(err: unknown, label: string): void {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${label} failed:`, msg);
    if (this.statusEl) this.statusEl.textContent = `${label} failed: ${msg}`;
    if (this.preview) this.preview.setBusy(false);
  }

  private teardownDom(): void {
    if (this.genPromptInput) { this.genPromptInput.remove(); this.genPromptInput = null; }
    if (this.nameInput)      { this.nameInput.remove();      this.nameInput      = null; }
    if (this.descInput)      { this.descInput.remove();      this.descInput      = null; }
    if (this.statusEl)       { this.statusEl.remove();       this.statusEl       = null; }
    if (this.preview)        { this.preview.destroy();       this.preview        = null; }
    if (this.mapSelector)    { this.mapSelector.destroy();   this.mapSelector    = null; }
    if (this.layersPanel) {
      const c = (this.layersPanel as HTMLElement & { __cleanup?: () => void }).__cleanup;
      if (c) c();
      this.layersPanel.remove();
      this.layersPanel = null;
    }
    for (const bucket of Object.keys(this.buckets) as BucketName[]) this.disposeBucket(bucket);
    this.terrainChips.clear();
    this.featureChips.clear();
  }
}

