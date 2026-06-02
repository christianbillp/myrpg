import Phaser from "phaser";
import { gameClient } from "../net/GameClient";
import type { EncounterRefineDraft, EncounterRefineResponse } from "../net/GameClient";
import type { MonsterDef } from "../../../shared/types";
import type { MapPreviewData } from "../ui/EmbeddedMapPreview";
import { tilesetTextureKey } from "./BootScene";
import type { SavedMapDef, EncounterDef, EncounterTrigger, NPCDef } from "../../../shared/types";
import { STARTING_ZONE_PLAYER, STARTING_ZONE_ALLY, STARTING_ZONE_ENEMY, STARTING_ZONE_NEUTRAL } from "../../../shared/startingZones";
import { MonsterPicker } from "../ui/generate/MonsterPicker";
import { ZonePainter } from "../ui/generate/ZonePainter";
import { TriggerEditor, type ComposedTrigger, type ComposedAction } from "../ui/generate/TriggerEditor";
import { EncounterPickerOverlay } from "../ui/generate/EncounterPickerOverlay";
import { MapSelectorOverlay } from "../ui/generate/MapSelectorOverlay";
import { createHtmlButton, createHtmlText, type HtmlButtonHandle, type HtmlTextHandle } from "../ui/htmlButtons";
import { buildLineInput as sharedBuildLineInput, buildTextarea as sharedBuildTextarea } from "../ui/sceneInputs";
import { ScreenEffects } from "../ui/ScreenEffects";
import {
  TILE_SIZE,
  GRID_COLS,
  GRID_ROWS,
  HUD_HEIGHT,
  PLAYER_PANEL_WIDTH,
  TARGET_PANEL_WIDTH,
} from "../constants";

const W = PLAYER_PANEL_WIDTH + GRID_COLS * TILE_SIZE + TARGET_PANEL_WIDTH;
const H = GRID_ROWS * TILE_SIZE + HUD_HEIGHT;

const TITLE_Y = 28;
const OUTER_TAB_Y = 92;
const OUTER_TAB_H = 28;
const CONTENT_TOP = 138;
const CONTENT_BOTTOM = H - 110;
const PANEL_PAD = 48;
const COL_GAP = 40;

// LEFT / RIGHT split: ~64% / ~36%. The map fills the LEFT column at the
// largest tile size that fits both dimensions — pan/zoom takes over from
// there for inspection. No upper cap on tile size; the goal is "as big as
// possible" so author can read tile detail without scroll.
const LEFT_COL_FRACTION = 0.64;

type EncounterRecord = EncounterDef & { completionFlag?: string };

/** Anything the editor needs to show/hide as one and dispose on teardown.
 *  HtmlButtonHandle / HtmlTextHandle satisfy this shape natively; raw
 *  HTMLElements are wrapped via `htmlChromeHandle`. Tracked in two
 *  collections — `sceneChrome` (lives the whole scene) and `formChrome`
 *  (replaced every `rebuildForm`) — so adding a new element wires it into
 *  visibility toggling and shutdown disposal in one place. */
interface ChromeHandle {
  setVisible(visible: boolean): void;
  dispose(): void;
}
function htmlChromeHandle(el: HTMLElement): ChromeHandle {
  return {
    setVisible: (v) => { el.style.display = v ? "" : "none"; },
    dispose: () => el.remove(),
  };
}
/** Sub-components expose `destroy()` instead of `dispose()` — adapt. */
function subcomponentChromeHandle(c: { setVisible(v: boolean): void; destroy(): void }): ChromeHandle {
  return { setVisible: c.setVisible.bind(c), dispose: c.destroy.bind(c) };
}

/** Parse an `"x,y"` zone-cell key into a `[x, y]` tuple. */
function splitCell(key: string): [number, number] {
  const [xs, ys] = key.split(",");
  return [Number(xs), Number(ys)];
}

/** Seed values handed off to sub-components on every `rebuildForm()`.
 *  Decoded once from the loaded encounter and reset between loads. */
interface FormSeed {
  playerCells: Set<string>;
  allyCells: Set<string>;
  enemyCells: Set<string>;
  neutralCells: Set<string>;
  allyIds: string[];
  enemyIds: string[];
  neutralIds: string[];
  triggers: ComposedTrigger[];
  placementMode: 'zones' | 'exact';
  placements: import("../../../shared/types").EncounterPlacement[];
}

/** Layout values computed once per `rebuildForm()` pass and passed to the
 *  three section builders. Kept as a flat record so each builder can read
 *  what it needs without re-deriving column/viewport math. */
interface FormGeometry {
  map: MapPreviewData;
  leftX: number; rightX: number;
  leftColW: number; rightColW: number;
  viewportX: number; viewportY: number; viewportW: number; viewportH: number;
  tileSize: number; thumbX: number; thumbY: number; thumbW: number; thumbH: number;
  tabsY: number; tabsH: number; tabGap: number; tabW: number;
  pickerY: number; pickerH: number;
}

const EMPTY_FORM_SEED: FormSeed = {
  playerCells: new Set(), allyCells: new Set(), enemyCells: new Set(), neutralCells: new Set(),
  allyIds: [], enemyIds: [], neutralIds: [],
  triggers: [],
  // Default to exact mode for new encounters — placement is the more common
  // intent now. Legacy encounters that were saved before placementMode existed
  // still fall back to 'zones' at load time so their behaviour doesn't change
  // (see `enc.placementMode ?? 'zones'` in the loader).
  placementMode: 'exact',
  placements: [],
};

/**
 * EncounterCreatorScene — opens an existing encounter JSON, presents the same
 * form the deterministic compose flow uses (title / intro / description /
 * objective / completion flag, zone painter, monster picker, trigger editor),
 * and writes changes back via `POST /generate/encounter/update`.
 *
 * Layout:
 *   • LEFT column (~64% of content width) — the map. Fills the column with
 *     the largest tile size that fits, plus the paint-mode buttons beneath
 *     it. The map is the focal element.
 *   • RIGHT column (~36%) — three tabs:
 *     • BASIC INFORMATION — title, introduction, description, objective,
 *       completion flag.
 *     • MONSTERS — the MonsterPicker.
 *     • TRIGGERS — the TriggerEditor.
 *     Tab content uses the full remaining height so long content scrolls
 *     cleanly within its tab.
 *
 * All buttons are HTML (`createHtmlButton`) so they stay crisp at any zoom
 * and the in-list buttons receive clicks reliably. Phaser is used only for
 * the canvas-backed map thumbnail + zone overlay.
 */
export class EncounterCreatorScene extends Phaser.Scene {
  private loaded: EncounterRecord | null = null;
  private acceptedMap: MapPreviewData | null = null;

  // Form state — values currently in the BASIC INFO inputs (kept in sync via
  // each input's onInput handler). Names use the `form*` prefix to make it
  // obvious these are live form values, not seeds or decoded JSON.
  private formTitle = "";
  private formIntroduction = "";
  /** Player-facing one-paragraph card text. Stored on `EncounterDef.description`
   *  and rendered on the Single Encounter Setup card so the player sees a
   *  human summary before launching. Authored via the DESCRIPTION field in
   *  the editor's BASIC INFORMATION tab. */
  private formDescription = "";
  /** Long-form scene context handed silently to the AIGM. Stored on
   *  `EncounterDef.customContext`. Authored via the AIGM CONTEXT field in
   *  the editor. (The internal AI-proposal contract still uses the wire-name
   *  `description` for this slot for legacy reasons — translation happens
   *  at the save/load boundary.) */
  private formAigmContext = "";
  private formObjective = "";
  private formCompletionFlag = "";
  private formTitleInput: HTMLInputElement | null = null;
  /** HTML button rendered next to the title input that previews the title
   *  as the in-game supertitle (hides the editor for the duration). */
  private titlePreviewBtn: HtmlButtonHandle | null = null;
  private formIntroInput: HTMLTextAreaElement | null = null;
  private formDescriptionInput: HTMLTextAreaElement | null = null;
  private formAigmContextInput: HTMLTextAreaElement | null = null;
  private formObjectiveInput: HTMLInputElement | null = null;
  private formCompletionFlagInput: HTMLInputElement | null = null;

  // Sub-components.
  private formContainer!: Phaser.GameObjects.Container;
  private zonePainter: ZonePainter | null = null;
  private monsterPicker: MonsterPicker | null = null;
  private triggerEditor: TriggerEditor | null = null;
  private basicInfoSubContainer: Phaser.GameObjects.Container | null = null;
  private monsterSubContainer: Phaser.GameObjects.Container | null = null;
  private triggerSubContainer: Phaser.GameObjects.Container | null = null;
  private pickerTab: "basic" | "monsters" | "triggers" = "basic";
  private basicTabBtn: HtmlButtonHandle | null = null;
  private monstersTabBtn: HtmlButtonHandle | null = null;
  private triggersTabBtn: HtmlButtonHandle | null = null;

  /** Seed values handed off to sub-components on every `rebuildForm()`.
   *  Replaces a previous ~10 nullable `initial*` fields with one struct;
   *  reset to `EMPTY_FORM_SEED` between encounter loads. */
  private formSeed: FormSeed = EMPTY_FORM_SEED;
  /** HTML radio-style toggle for placement mode (Zones / Exact). */
  private placementModeBtn: HtmlButtonHandle | null = null;

  // Chrome.
  private titleText!: HtmlTextHandle;
  private subtitleText!: HtmlTextHandle;
  private openBtn!: HtmlButtonHandle;
  private loadMapBtn!: HtmlButtonHandle;
  private backBtn!: HtmlButtonHandle;
  private saveBtn!: HtmlButtonHandle;
  /** True when the user opened the form via LOAD MAP (no existing encounter
   *  yet). The first successful SAVE creates the encounter on the server;
   *  subsequent saves on the same draft fall back to update once an id is
   *  assigned. */
  private isDraft = false;
  private mapSelector: MapSelectorOverlay | null = null;

  // ── Outer tabs (Regular / Generative AI) ────────────────────────────────
  // The map column + bottom paint bar are mounted in both tabs since the
  // user authors against the same loaded map. Only the right column swaps.
  private outerTab: "regular" | "ai" = "regular";
  private regularTabBtn: HtmlButtonHandle | null = null;
  private aiTabBtn: HtmlButtonHandle | null = null;

  // AI tab — right-column inputs. Rebuilt by buildAiRightColumn each time the
  // form rebuilds, so geometry stays in sync with the loaded map.
  private aiPromptInput: HTMLTextAreaElement | null = null;
  private aiSubmitBtn: HtmlButtonHandle | null = null;
  private aiResetBtn: HtmlButtonHandle | null = null;
  private aiStatusEl: HTMLDivElement | null = null;
  private aiDiffEl: HTMLDivElement | null = null;
  private aiAcceptBtn: HtmlButtonHandle | null = null;
  private aiRejectBtn: HtmlButtonHandle | null = null;
  /** The pending proposal returned by the most recent refine call.
   *  Cleared on accept / reject / new submit. */
  private aiPendingProposal: EncounterRefineResponse | null = null;
  private aiBusy = false;
  /** Phaser text labels owned by the current `rebuildForm` pass — disposed on the next rebuild. */
  private formLabels: HtmlTextHandle[] = [];
  /** Subset of `formLabels` belonging to the BASIC INFO tab — toggled together with the tab. */
  private basicInfoLabels: HtmlTextHandle[] = [];
  /** Empty-state HTML text shown when no encounter is loaded. */
  private emptyStateText: HtmlTextHandle | null = null;
  private emptyStateHint: HtmlTextHandle | null = null;

  private statusEl: HTMLDivElement | null = null;
  private busy = false;
  private encounterPicker: EncounterPickerOverlay | null = null;
  private monsters: MonsterDef[] = [];
  private npcs: NPCDef[] = [];

  /** Chrome that lives the whole scene — registered once in `create()`. */
  private sceneChrome: ChromeHandle[] = [];
  /** Chrome rebuilt on every `rebuildForm()` — disposed wholesale at the
   *  start of each rebuild and on scene teardown. */
  private formChrome: ChromeHandle[] = [];

  constructor() {
    super({ key: "EncounterCreatorScene" });
  }

  init(): void {
    this.loaded = null;
    this.acceptedMap = null;
    this.formTitle = "";
    this.formIntroduction = "";
    this.formDescription = "";
    this.formAigmContext = "";
    this.formObjective = "";
    this.formCompletionFlag = "";
    this.formSeed = EMPTY_FORM_SEED;
    this.zonePainter = null;
    this.monsterPicker = null;
    this.triggerEditor = null;
    this.busy = false;
    this.outerTab = "regular";
    this.isDraft = false;
  }

  create(): void {
    // Defensive: a previous scene (especially GameScene with its WASD player
    // controls) may have left global keyboard capture on, which calls
    // preventDefault for W/A/S/D and blocks them from reaching any HTML
    // input on this page. Clear it so the inputs receive every key.
    this.input.keyboard?.disableGlobalCapture();
    this.input.keyboard?.clearCaptures();

    this.monsters = (this.registry.get("monsters") as MonsterDef[] | undefined) ?? [];
    this.npcs     = (this.registry.get("npcs")     as NPCDef[]     | undefined) ?? [];

    this.add.rectangle(W / 2, H / 2, W, H, 0x0d0d1e);
    this.titleText = createHtmlText({
      scene: this, sceneWidth: W,
      x: 0, y: TITLE_Y, w: W,
      text: "ENCOUNTER CREATOR",
      fontSize: 22, color: "#e2b96f", align: "center", letterSpacing: 1,
    });
    this.sceneChrome.push(this.titleText);
    this.add.rectangle(W / 2, TITLE_Y + 38, W - 64, 1, 0x334455);

    this.subtitleText = createHtmlText({
      scene: this, sceneWidth: W,
      x: 0, y: TITLE_Y + 50, w: W,
      text: "No encounter loaded — press OPEN ENCOUNTER or LOAD MAP",
      fontSize: 12, color: "#88aacc", align: "center",
    });
    this.sceneChrome.push(this.subtitleText);

    this.formContainer = this.add.container(0, 0);

    this.buildOuterTabs();
    this.buildStatusLine();
    this.buildBottomBar();

    this.events.once("shutdown", () => this.teardownDom());
    this.events.once("destroy",  () => this.teardownDom());
  }

  // ── Loading ─────────────────────────────────────────────────────────────

  private async openEncounterPicker(): Promise<void> {
    if (this.encounterPicker || this.busy) return;
    // Pull the latest lists from the server so encounters / maps created in
    // other scenes during this browser session are reflected here without a
    // reload. Cheap calls — fall back to the registry on failure.
    try {
      const [encs, maps] = await Promise.all([gameClient.listEncounters(), gameClient.listMaps()]);
      this.registry.set("encounters", encs);
      this.registry.set("maps", maps);
    } catch { /* fall back to whatever's in the registry */ }
    const encounters = (this.registry.get("encounters") as EncounterRecord[] | undefined) ?? [];
    const maps = (this.registry.get("maps") as SavedMapDef[] | undefined) ?? [];
    this.setDomChromeVisible(false);
    this.encounterPicker = new EncounterPickerOverlay(this, encounters, maps, {
      onSelect: (enc) => {
        this.closeEncounterPicker();
        this.loadEncounter(enc as EncounterRecord);
      },
      onClose: () => this.closeEncounterPicker(),
    });
  }

  private closeEncounterPicker(): void {
    if (this.encounterPicker) { this.encounterPicker.destroy(); this.encounterPicker = null; }
    this.setDomChromeVisible(true);
  }

  /** Open the saved-maps picker. Selecting a map starts a fresh draft on
   *  it — no existing encounter required. The first SAVE will create the
   *  encounter via `composeEncounter`. Re-fetches the list before opening
   *  so a map saved in another scene this session shows up without a
   *  browser reload. */
  private async openMapSelector(): Promise<void> {
    if (this.mapSelector || this.busy) return;
    try {
      const fresh = await gameClient.listMaps();
      this.registry.set("maps", fresh);
    } catch { /* fall back to whatever's in the registry */ }
    const maps = (this.registry.get("maps") as SavedMapDef[] | undefined) ?? [];
    if (maps.length === 0) {
      if (this.statusEl) this.statusEl.textContent = "No saved maps available. Use the Map Editor first.";
      return;
    }
    this.setDomChromeVisible(false);
    this.mapSelector = new MapSelectorOverlay(this, maps, {
      onSelect: (map) => {
        this.closeMapSelector();
        this.startDraftFromMap(map);
      },
      onClose: () => this.closeMapSelector(),
    });
  }

  private closeMapSelector(): void {
    if (this.mapSelector) { this.mapSelector.destroy(); this.mapSelector = null; }
    this.setDomChromeVisible(true);
  }

  /** Begin a fresh encounter draft on a previously-saved map. Resets every
   *  form field to its empty default and rebuilds the form. The draft has
   *  no encounter id until the first SAVE persists it. */
  private startDraftFromMap(map: MapPreviewData): void {
    if (!map.mapId) {
      if (this.statusEl) this.statusEl.textContent = "Selected map has no id — save it from the Map Editor first.";
      return;
    }
    this.loaded = {
      id: "",
      encounterTitle: "",
      description: "",
      mapId: map.mapId,
    } as EncounterRecord;
    this.acceptedMap = map;
    this.isDraft = true;
    this.formTitle          = "";
    this.formIntroduction   = "";
    this.formDescription    = "";
    this.formAigmContext    = "";
    this.formObjective      = "";
    this.formCompletionFlag = "";
    this.formSeed = EMPTY_FORM_SEED;
    this.subtitleText.setText(`New draft on map  ${map.mapId}  ·  ${map.name ?? ""}`);
    this.rebuildForm();
    if (this.statusEl) this.statusEl.textContent = "New draft started. Place a player tile and SAVE to create the encounter.";
    this.refreshButtons();
  }

  private loadEncounter(enc: EncounterRecord): void {
    const maps = (this.registry.get("maps") as SavedMapDef[] | undefined) ?? [];
    const savedMap = maps.find((m) => m.id === enc.mapId);
    if (!savedMap) {
      if (this.statusEl) this.statusEl.textContent = `Cannot open ${enc.id}: referenced map "${enc.mapId}" not found.`;
      return;
    }

    this.loaded = enc;
    this.acceptedMap = savedMapToPreview(savedMap);
    this.isDraft = false;
    this.formTitle          = enc.encounterTitle    ?? "";
    this.formIntroduction   = enc.customIntroduction ?? "";
    this.formDescription    = enc.description       ?? "";
    this.formAigmContext    = enc.customContext     ?? "";
    this.formObjective      = enc.objective         ?? "";
    this.formCompletionFlag = enc.completionFlag    ?? "";

    const triggers = reverseMapTriggers(enc.triggers ?? []);
    this.formSeed = {
      ...decodeStartingZones(enc.startingZones),
      allyIds:    [...(enc.allyIds  ?? [])],
      enemyIds:   [...(enc.enemyIds ?? [])],
      neutralIds: [...(enc.npcIds   ?? [])],
      triggers,
      placementMode: enc.placementMode ?? 'zones',
      placements:    enc.placements ? [...enc.placements] : [],
    };
    const skipped = (enc.triggers?.length ?? 0) - triggers.length;

    this.subtitleText.setText(`Editing  ${enc.id}  ·  ${enc.encounterTitle ?? ""}`);
    this.rebuildForm();
    if (this.statusEl) {
      this.statusEl.textContent = skipped > 0
        ? `Loaded ${enc.id}. ${skipped} trigger${skipped === 1 ? "" : "s"} skipped (not representable in editor).`
        : `Loaded ${enc.id}.`;
    }
    this.refreshButtons();
  }

  // ── Form build/destroy ──────────────────────────────────────────────────

  /**
   * Top-level rebuild. Disposes the previous pass's chrome + sub-components,
   * then either renders the empty state or composes the form via three
   * focused builders (left viewport, bottom paint bar, right tabs). Each
   * builder is short enough to hold in one screen and is the single place
   * that knows about its section.
   */
  private rebuildForm(): void {
    this.disposeFormChrome();
    this.resetFormRefs();

    if (!this.acceptedMap) {
      this.renderEmptyForm();
      this.refreshOuterTabVisibility();
      return;
    }
    const geo = this.computeFormGeometry(this.acceptedMap);
    this.buildLeftColumnViewport(geo);
    this.buildBottomPaintBar(geo);
    this.buildRightColumnTabs(geo);
    this.buildAiRightColumn(geo);
    this.syncTriggerRegionsToPreview();
    this.refreshOuterTabVisibility();
  }

  /** Tear down every formChrome handle and clear the array. */
  private disposeFormChrome(): void {
    for (const h of this.formChrome) h.dispose();
    this.formChrome = [];
  }

  /** Null out every scene-field reference that lived in formChrome so any
   *  external check fails cleanly on the next rebuild pass. */
  private resetFormRefs(): void {
    this.formContainer.removeAll(true);
    this.zonePainter = null;
    this.monsterPicker = null;
    this.triggerEditor = null;
    this.basicTabBtn = null;
    this.monstersTabBtn = null;
    this.triggersTabBtn = null;
    this.placementModeBtn = null;
    this.titlePreviewBtn = null;
    this.formTitleInput = null;
    this.formIntroInput = null;
    this.formDescriptionInput = null;
    this.formAigmContextInput = null;
    this.formObjectiveInput = null;
    this.formCompletionFlagInput = null;
    this.emptyStateText = null;
    this.emptyStateHint = null;
    this.basicInfoSubContainer = null;
    this.monsterSubContainer = null;
    this.triggerSubContainer = null;
    this.formLabels = [];
    this.basicInfoLabels = [];
    this.pickerTab = "basic";
    // AI right column refs — disposed via formChrome and rebuilt next pass.
    this.aiPromptInput = null;
    this.aiSubmitBtn = null;
    this.aiResetBtn = null;
    this.aiStatusEl = null;
    this.aiDiffEl = null;
    this.aiAcceptBtn = null;
    this.aiRejectBtn = null;
  }

  /** Empty-state message centered in the content area. */
  private renderEmptyForm(): void {
    const cy = (CONTENT_TOP + CONTENT_BOTTOM) / 2;
    this.emptyStateText = createHtmlText({
      scene: this, sceneWidth: W,
      x: 0, y: cy - 12, w: W,
      text: "No encounter loaded",
      fontSize: 16, color: "#556677", align: "center",
    });
    this.formChrome.push(this.emptyStateText);
    this.emptyStateHint = createHtmlText({
      scene: this, sceneWidth: W,
      x: 0, y: cy + 16, w: W,
      text: "Click OPEN ENCOUNTER to pick one.",
      fontSize: 11, color: "#445566", align: "center",
    });
    this.formChrome.push(this.emptyStateHint);
  }

  /** Resolve every geometric value the form's three sections need. */
  private computeFormGeometry(map: MapPreviewData): FormGeometry {
    const contentW = W - PANEL_PAD * 2 - COL_GAP;
    const leftColW = Math.floor(contentW * LEFT_COL_FRACTION);
    const rightColW = contentW - leftColW;
    const leftX = PANEL_PAD;
    const rightX = PANEL_PAD + leftColW + COL_GAP;
    const contentH = CONTENT_BOTTOM - CONTENT_TOP;

    // LEFT column viewport — map fills it, footnote sits beneath.
    const FOOTNOTE_H = 18;
    const viewportX = leftX;
    const viewportY = CONTENT_TOP + 8;
    const viewportW = leftColW;
    const viewportH = contentH - FOOTNOTE_H;
    const tileSize = Math.max(4, Math.min(
      Math.floor(viewportW / map.width),
      Math.floor(viewportH / map.height),
    ));
    const thumbW = tileSize * map.width;
    const thumbH = tileSize * map.height;
    const thumbX = viewportX + Math.floor((viewportW - thumbW) / 2);
    const thumbY = viewportY + Math.floor((viewportH - thumbH) / 2);

    // RIGHT column tab strip + picker.
    const tabsY = CONTENT_TOP + 8;
    const tabsH = 30;
    const tabGap = 8;
    const tabW = Math.floor((rightColW - tabGap * 2) / 3);
    const pickerY = tabsY + tabsH + 12;
    const pickerH = (CONTENT_BOTTOM - 8) - pickerY;

    return {
      map,
      leftX, rightX, leftColW, rightColW,
      viewportX, viewportY, viewportW, viewportH,
      tileSize, thumbX, thumbY, thumbW, thumbH,
      tabsY, tabsH, tabGap, tabW, pickerY, pickerH,
    };
  }

  /** LEFT column — pan/zoomable map viewport that fills the column, with a
   *  small footnote beneath the thumbnail. */
  private buildLeftColumnViewport(geo: FormGeometry): void {
    this.zonePainter = new ZonePainter({
      scene: this,
      parent: this.formContainer,
      map: geo.map,
      thumbX: geo.thumbX, thumbY: geo.thumbY,
      thumbW: geo.thumbW, thumbH: geo.thumbH, tileSize: geo.tileSize,
      viewportX: geo.viewportX, viewportY: geo.viewportY,
      viewportW: geo.viewportW, viewportH: geo.viewportH,
      tilesetKey: pickTilesetKey(this),
      sceneWidth: W,
      onZonesChanged: () => this.refreshButtons(),
      initialPlayerCells:   this.formSeed.playerCells,
      initialAllyCells:     this.formSeed.allyCells,
      initialEnemyCells:    this.formSeed.enemyCells,
      initialNeutralCells:  this.formSeed.neutralCells,
      initialPlacementMode: this.formSeed.placementMode,
      initialPlacements:    this.formSeed.placements,
      initialEnemyIds:      this.formSeed.enemyIds,
      initialAllyIds:       this.formSeed.allyIds,
      initialNeutralIds:    this.formSeed.neutralIds,
    });
    this.zonePainter.setOnPlacementsChanged(() => this.refreshButtons());
    this.formChrome.push(subcomponentChromeHandle(this.zonePainter));

    const footnote = createHtmlText({
      scene: this, sceneWidth: W,
      x: geo.viewportX, y: geo.viewportY + geo.viewportH + 4, w: geo.viewportW,
      text: `${geo.map.name}  ·  scroll to zoom · drag to pan`,
      fontSize: 10, color: "#667788", align: "center",
    });
    this.formLabels.push(footnote);
    this.formChrome.push(footnote);
  }

  /** Bottom bar — STARTING ZONES paint buttons under the map column, MODE
   *  toggle under the right column. */
  private buildBottomPaintBar(geo: FormGeometry): void {
    if (!this.zonePainter) return;
    const paintLabelY = H - 104;
    const paintBtnY = H - 88;
    const paintBtnH = 28;
    const modeBtnW = 200;

    const zonesLabel = this.makeSubLabel(geo.leftX, paintLabelY, geo.leftColW, "STARTING ZONES");
    const modeLabel  = this.makeSubLabel(geo.rightX, paintLabelY, modeBtnW, "PLACEMENT MODE");
    this.formLabels.push(zonesLabel, modeLabel);
    this.formChrome.push(zonesLabel, modeLabel);

    // ZonePainter owns its paint buttons (PLAYER / ALLY / ENEMY / NEUTRAL /
    // CLEAR). They're disposed via the ZonePainter handle already in
    // formChrome — no separate tracking. The layer-visibility toolbar sits
    // 26 px above them so authors can filter the preview down to the
    // single layer they're currently working on.
    this.zonePainter.buildLayerToggleButtons(geo.leftX, paintBtnY - 26, geo.leftColW);
    this.zonePainter.buildPaintModeButtons(geo.leftX, paintBtnY, geo.leftColW);

    const modeLabelOf = (m: 'zones' | 'exact'): string => m === 'zones' ? "MODE: ZONES" : "MODE: EXACT";
    this.placementModeBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: geo.rightX, y: paintBtnY,
      w: modeBtnW, h: paintBtnH,
      label: modeLabelOf(this.zonePainter.getPlacementMode()),
      variant: "secondary",
      fontSize: 11,
      onClick: () => {
        if (!this.zonePainter || !this.placementModeBtn) return;
        const next = this.zonePainter.getPlacementMode() === 'zones' ? 'exact' : 'zones';
        this.zonePainter.setPlacementMode(next);
        this.placementModeBtn.setLabel(modeLabelOf(next));
        this.refreshButtons();
      },
    });
    this.formChrome.push(this.placementModeBtn);
  }

  /** RIGHT column — three tab buttons + their three sub-containers + the
   *  picker each tab owns (BasicInfo inline, MonsterPicker, TriggerEditor). */
  private buildRightColumnTabs(geo: FormGeometry): void {
    this.basicTabBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: geo.rightX, y: geo.tabsY, w: geo.tabW, h: geo.tabsH,
      label: "BASIC INFO", variant: "secondary", fontSize: 11,
      onClick: () => this.activatePickerTab("basic"),
    });
    this.monstersTabBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: geo.rightX + geo.tabW + geo.tabGap, y: geo.tabsY, w: geo.tabW, h: geo.tabsH,
      label: "NPCS AND MONSTERS", variant: "secondary", fontSize: 11,
      onClick: () => this.activatePickerTab("monsters"),
    });
    this.triggersTabBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: geo.rightX + (geo.tabW + geo.tabGap) * 2, y: geo.tabsY, w: geo.tabW, h: geo.tabsH,
      label: "TRIGGERS", variant: "secondary", fontSize: 11,
      onClick: () => this.activatePickerTab("triggers"),
    });
    this.formChrome.push(this.basicTabBtn, this.monstersTabBtn, this.triggersTabBtn);

    this.basicInfoSubContainer = this.add.container(0, 0);
    this.formContainer.add(this.basicInfoSubContainer);
    this.buildBasicInfoTab(geo.rightX, geo.pickerY, geo.rightColW, geo.pickerH);

    this.monsterSubContainer = this.add.container(0, 0);
    this.formContainer.add(this.monsterSubContainer);
    this.monsterPicker = new MonsterPicker({
      scene: this,
      parent: this.monsterSubContainer,
      monsters: this.monsters,
      npcs: this.npcs,
      x: geo.rightX, y: geo.pickerY, width: geo.rightColW, height: geo.pickerH,
      sceneWidth: W,
      initialAllyIds:    this.formSeed.allyIds,
      initialEnemyIds:   this.formSeed.enemyIds,
      initialNeutralIds: this.formSeed.neutralIds,
      // Push roster changes back into the ZonePainter so progress labels
      // refresh and any placements bound to a now-removed slot are pruned.
      onSelectionChanged: () => {
        this.zonePainter?.setEntityRoster({
          allyIds:    this.monsterPicker?.getAllyIds()    ?? [],
          enemyIds:   this.monsterPicker?.getEnemyIds()   ?? [],
          neutralIds: this.monsterPicker?.getNeutralIds() ?? [],
        });
      },
      // Per-slot REMOVE: shift placements bound to higher indices down by
      // one before the roster prune fires (otherwise the still-meaningful
      // placement at index+1 would be reassigned to a different monster).
      onSlotRemoved: (role, removedIndex) => {
        this.zonePainter?.removeSlotAt(role, removedIndex);
      },
    });
    this.formChrome.push(subcomponentChromeHandle(this.monsterPicker));

    this.triggerSubContainer = this.add.container(0, 0);
    this.formContainer.add(this.triggerSubContainer);
    this.triggerEditor = new TriggerEditor({
      scene: this,
      parent: this.triggerSubContainer,
      x: geo.rightX, y: geo.pickerY, width: geo.rightColW, height: geo.pickerH,
      sceneWidth: W,
      mapW: geo.map.width,
      mapH: geo.map.height,
      initialTriggers: this.formSeed.triggers,
      onChange: () => this.syncTriggerRegionsToPreview(),
    });
    this.formChrome.push(subcomponentChromeHandle(this.triggerEditor));
  }

  /**
   * Build the Generative-AI tab's right column. Lives in the same screen
   * region as the Regular tab's inner tabs + sub-content, and is toggled in
   * lockstep by `refreshOuterTabVisibility`. The map column + bottom paint
   * bar stay mounted in both tabs.
   *
   * Phase 3 lays out the inputs (prompt textarea, SUBMIT/RESET, status,
   * diff viewer, ACCEPT/REJECT). The wiring to the backend lives in Phase 4.
   */
  private buildAiRightColumn(geo: FormGeometry): void {
    const x = geo.rightX;
    const w = geo.rightColW;
    const topY = geo.tabsY; // align with where the inner tabs sit in Regular
    const bottomY = geo.pickerY + geo.pickerH;
    const totalH = bottomY - topY;

    // Vertical layout:
    //   prompt label + textarea (40%)
    //   SUBMIT / RESET row
    //   status line
    //   diff viewer (rest of column)
    //   ACCEPT / REJECT row
    const promptLabelH = 18;
    const buttonRowH = 30;
    const statusH = 18;
    const acceptRowH = 30;
    const gap = 8;
    const remaining = totalH - promptLabelH - buttonRowH - statusH - acceptRowH - gap * 4;
    const promptH = Math.max(110, Math.floor(remaining * 0.4));
    const diffH = Math.max(120, remaining - promptH);

    // PROMPT label
    const promptLbl = createHtmlText({
      scene: this, sceneWidth: W,
      x, y: topY, w, h: promptLabelH,
      text: "PROMPT",
      fontSize: 10, color: "#7aadcc", align: "left", letterSpacing: 2,
    });
    this.formLabels.push(promptLbl);
    this.formChrome.push(promptLbl);

    // Prompt textarea
    const promptY = topY + promptLabelH + 4;
    this.aiPromptInput = this.buildTextarea(
      x, promptY, w, promptH,
      "Describe what to change. e.g. \"add a wandering merchant who flees on sight\" or \"make the title more ominous\".",
      () => { /* prompt text is read at submit time */ },
      "",
    );
    this.formChrome.push(htmlChromeHandle(this.aiPromptInput));

    // SUBMIT / RESET row
    const btnRowY = promptY + promptH + gap;
    const btnW = Math.floor((w - gap) / 2);
    this.aiSubmitBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x, y: btnRowY, w: btnW, h: buttonRowH,
      label: "✨ GENERATE", variant: "primary", fontSize: 12,
      onClick: () => this.runAiGenerate(),
    });
    this.formChrome.push(this.aiSubmitBtn);
    this.aiResetBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: x + btnW + gap, y: btnRowY, w: btnW, h: buttonRowH,
      label: "RESET PROMPT", variant: "ghost", fontSize: 11,
      onClick: () => {
        if (this.aiPromptInput) this.aiPromptInput.value = "";
      },
    });
    this.formChrome.push(this.aiResetBtn);

    // Status line — positioned via the same scale-tracking pattern the
    // form's other inputs use. Raw scene-space pixel coords would render in
    // the wrong place on a scaled canvas.
    const statusY = btnRowY + buttonRowH + gap;
    this.aiStatusEl = document.createElement("div");
    this.aiStatusEl.style.cssText = `
      position: absolute;
      font-family: monospace;
      color: #88aacc;
      display: flex; align-items: center;
      z-index: 10;
      box-sizing: border-box;
      pointer-events: none;
    `;
    document.body.appendChild(this.aiStatusEl);
    this.attachScaledPlacement(this.aiStatusEl, x, statusY, w, statusH, 11);
    this.formChrome.push(htmlChromeHandle(this.aiStatusEl));

    // Diff viewer
    const diffY = statusY + statusH + gap;
    this.aiDiffEl = document.createElement("div");
    this.aiDiffEl.style.cssText = `
      position: absolute;
      background: #0f1320; border: 1px solid #334455;
      box-sizing: border-box; padding: 10px 12px;
      font-family: monospace;
      color: #aabbcc;
      overflow-y: auto; scrollbar-width: thin; scrollbar-color: #445566 transparent;
      white-space: pre-wrap; line-height: 1.5;
      z-index: 10;
    `;
    this.aiDiffEl.textContent =
      "No proposal yet. Describe changes and press GENERATE.\n\n" +
      "The AI sees the current draft and proposes edits — accept to merge, reject to discard. " +
      "Iterative prompts feed the latest draft back in.";
    document.body.appendChild(this.aiDiffEl);
    this.attachScaledPlacement(this.aiDiffEl, x, diffY, w, diffH, 11);
    this.formChrome.push(htmlChromeHandle(this.aiDiffEl));

    // ACCEPT / REJECT row
    const acceptY = diffY + diffH + gap;
    this.aiAcceptBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x, y: acceptY, w: btnW, h: acceptRowH,
      label: "✓ ACCEPT", variant: "primary", fontSize: 12,
      onClick: () => this.acceptAiProposal(),
    });
    this.aiAcceptBtn.setDisabled(true);
    this.formChrome.push(this.aiAcceptBtn);
    this.aiRejectBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: x + btnW + gap, y: acceptY, w: btnW, h: acceptRowH,
      label: "✗ REJECT", variant: "ghost", fontSize: 12,
      onClick: () => this.rejectAiProposal(),
    });
    this.aiRejectBtn.setDisabled(true);
    this.formChrome.push(this.aiRejectBtn);
  }

  /** Snapshot the current form state into the shape the refine endpoint
   *  expects. The AI sees rosters, current spawn positions, current
   *  triggers (as both one-line summaries and full objects), plus the map
   *  id so the server can build a passability grid. */
  private snapshotAiDraft(): EncounterRefineDraft {
    const currentTriggers = this.triggerEditor?.getTriggers() ?? this.formSeed.triggers;
    const triggers = currentTriggers.map((t, i) => {
      const region = `(${t.region.x},${t.region.y},${t.region.w}×${t.region.h})`;
      const bits: string[] = [`T${i}`, t.kind.toUpperCase(), region];
      if (t.whenEvent) bits.push(`when=${t.whenEvent}`);
      if (t.kind === "perception") bits.push(`DC=${t.dc}`);
      if (t.kind === "combat" && (t.defIds?.length ?? 0) > 0) bits.push(`flips=${t.defIds!.join(",")}`);
      else if (t.defId) bits.push(`def=${t.defId}`);
      if (t.message)     bits.push(`msg="${t.message.slice(0, 80)}"`);
      if (t.passMessage) bits.push(`pass="${t.passMessage.slice(0, 80)}"`);
      return bits.join(" · ");
    });
    // Triggers go in as the wire shape; their fields are a superset of what
    // the AI receives and a subset of what `ComposedTrigger` exposes.
    const triggerObjects = currentTriggers.map((t) => ({
      id: t.id,
      whenEvent: t.whenEvent,
      region: { ...t.region },
      kind: t.kind,
      dc: t.dc,
      passMessage: t.passMessage,
      message: t.message,
      defId: t.defId,
      defIds: t.defIds ? [...t.defIds] : undefined,
      xpAmount: t.xpAmount,
      durationMs: t.durationMs,
      entityRef: t.entityRef,
      fadeMode: t.fadeMode,
      announcementMode: t.announcementMode,
      whenFlagName: t.whenFlagName,
      setFlagName: t.setFlagName,
    }));
    // Current placements + zones — the AI uses these as the baseline for
    // any spatial proposal. Falls back to formSeed when the live painter
    // isn't built yet (no map loaded).
    const placements = this.zonePainter?.getPlacements() ?? this.formSeed.placements;
    const playerPlacement = placements.find((p) => p.role === "player") ?? null;
    const enemyPlacements   = placements.filter((p) => p.role === "enemy").map((p) => ({ index: p.index, x: p.x, y: p.y }));
    const allyPlacements    = placements.filter((p) => p.role === "ally").map((p) => ({ index: p.index, x: p.x, y: p.y }));
    const neutralPlacements = placements.filter((p) => p.role === "neutral").map((p) => ({ index: p.index, x: p.x, y: p.y }));
    const cellsAsPairs = (cells: Iterable<string>): Array<[number, number]> => {
      const out: Array<[number, number]> = [];
      for (const k of cells) {
        const [xs, ys] = k.split(",");
        const x = Number(xs);
        const y = Number(ys);
        if (Number.isFinite(x) && Number.isFinite(y)) out.push([x, y]);
      }
      return out;
    };
    const playerZones  = this.zonePainter ? cellsAsPairs(this.zonePainter.getPlayerZones())  : [...this.formSeed.playerCells].map((k) => splitCell(k));
    const allyZones    = this.zonePainter ? cellsAsPairs(this.zonePainter.getAllyZones())    : [...this.formSeed.allyCells].map((k) => splitCell(k));
    const enemyZones   = this.zonePainter ? cellsAsPairs(this.zonePainter.getEnemyZones())   : [...this.formSeed.enemyCells].map((k) => splitCell(k));
    const neutralZones = this.zonePainter ? cellsAsPairs(this.zonePainter.getNeutralZones()) : [...this.formSeed.neutralCells].map((k) => splitCell(k));
    return {
      title:          this.formTitle,
      introduction:   this.formIntroduction,
      aigmContext:    this.formAigmContext,
      description:    this.formDescription,
      objective:      this.formObjective,
      completionFlag: this.formCompletionFlag,
      allyIds:    this.monsterPicker?.getAllyIds()    ?? [...this.formSeed.allyIds],
      enemyIds:   this.monsterPicker?.getEnemyIds()   ?? [...this.formSeed.enemyIds],
      neutralIds: this.monsterPicker?.getNeutralIds() ?? [...this.formSeed.neutralIds],
      triggers,
      triggerObjects,
      mapId: this.acceptedMap?.mapId ?? "",
      playerPlacement: playerPlacement ? { x: playerPlacement.x, y: playerPlacement.y } : null,
      enemyPlacements,
      allyPlacements,
      neutralPlacements,
      playerZones,
      allyZones,
      enemyZones,
      neutralZones,
    };
  }

  /** Submit the prompt + current draft to the refine endpoint. On success
   *  shows the diff and arms ACCEPT/REJECT. */
  private async runAiGenerate(): Promise<void> {
    if (this.aiBusy) return;
    if (!this.loaded || !this.acceptedMap) {
      if (this.aiStatusEl) this.aiStatusEl.textContent = "Open an encounter first.";
      return;
    }
    const prompt = (this.aiPromptInput?.value ?? "").trim();
    if (prompt.length < 4) {
      if (this.aiStatusEl) this.aiStatusEl.textContent = "Describe what to change (at least a few words).";
      return;
    }
    this.aiBusy = true;
    if (this.aiSubmitBtn) this.aiSubmitBtn.setDisabled(true);
    if (this.aiStatusEl) this.aiStatusEl.textContent = "Asking the GM to revise the draft…";
    if (this.aiAcceptBtn) this.aiAcceptBtn.setDisabled(true);
    if (this.aiRejectBtn) this.aiRejectBtn.setDisabled(true);

    try {
      const draft = this.snapshotAiDraft();
      const result = await gameClient.refineEncounter(draft, prompt);
      this.aiPendingProposal = result;
      this.renderAiDiff(draft, result);
      if (this.aiAcceptBtn) this.aiAcceptBtn.setDisabled(false);
      if (this.aiRejectBtn) this.aiRejectBtn.setDisabled(false);
      if (this.aiStatusEl) this.aiStatusEl.textContent = "Proposal ready — review the diff and Accept or Reject.";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.aiStatusEl) this.aiStatusEl.textContent = `Refine failed: ${msg}`;
    } finally {
      this.aiBusy = false;
      if (this.aiSubmitBtn) this.aiSubmitBtn.setDisabled(false);
    }
  }

  /** Render a human-readable diff between the snapshotted draft and the
   *  AI's proposed update. Only fields the AI included are shown; missing
   *  fields are treated as unchanged and omitted from the report. */
  private renderAiDiff(base: EncounterRefineDraft, resp: EncounterRefineResponse): void {
    if (!this.aiDiffEl) return;
    this.aiDiffEl.replaceChildren();

    const rationale = document.createElement("div");
    rationale.style.cssText = "color:#e2b96f;font-style:italic;margin-bottom:10px;line-height:1.4;";
    rationale.textContent = resp.rationale;
    this.aiDiffEl.appendChild(rationale);

    const p = resp.proposed;
    const lines: HTMLElement[] = [];

    const addTextDiff = (label: string, before: string, after: string | undefined): void => {
      if (after === undefined || after === before) return;
      const wrap = document.createElement("div");
      wrap.style.cssText = "margin-bottom:8px;";
      const lbl = document.createElement("div");
      lbl.style.cssText = "color:#88aacc;font-size:10px;letter-spacing:1px;margin-bottom:2px;";
      lbl.textContent = label;
      wrap.appendChild(lbl);
      const beforeDiv = document.createElement("div");
      beforeDiv.style.cssText = "color:#aa5555;text-decoration:line-through;line-height:1.4;";
      beforeDiv.textContent = before || "(empty)";
      wrap.appendChild(beforeDiv);
      const afterDiv = document.createElement("div");
      afterDiv.style.cssText = "color:#77cc77;line-height:1.4;";
      afterDiv.textContent = after || "(empty)";
      wrap.appendChild(afterDiv);
      lines.push(wrap);
    };

    const addArrayDiff = (label: string, before: string[], after: string[] | undefined): void => {
      if (after === undefined) return;
      const b = new Set(before);
      const a = new Set(after);
      const added   = after.filter((x) => !b.has(x));
      const removed = before.filter((x) => !a.has(x));
      if (added.length === 0 && removed.length === 0) return;
      const wrap = document.createElement("div");
      wrap.style.cssText = "margin-bottom:8px;";
      const lbl = document.createElement("div");
      lbl.style.cssText = "color:#88aacc;font-size:10px;letter-spacing:1px;margin-bottom:2px;";
      lbl.textContent = label;
      wrap.appendChild(lbl);
      for (const id of added) {
        const row = document.createElement("div");
        row.style.cssText = "color:#77cc77;line-height:1.4;";
        row.textContent = `+ ${id}`;
        wrap.appendChild(row);
      }
      for (const id of removed) {
        const row = document.createElement("div");
        row.style.cssText = "color:#aa5555;line-height:1.4;";
        row.textContent = `− ${id}`;
        wrap.appendChild(row);
      }
      lines.push(wrap);
    };

    /** Heading + list block for spawn proposals. Each row reads
     *  "E0@(5,5)" so the user can sanity-check positions. */
    const addSpawnDiff = (label: string, prefix: string, before: unknown, after: unknown): void => {
      if (after === undefined) return;
      const wrap = document.createElement("div");
      wrap.style.cssText = "margin-bottom:8px;";
      const lbl = document.createElement("div");
      lbl.style.cssText = "color:#88aacc;font-size:10px;letter-spacing:1px;margin-bottom:2px;";
      lbl.textContent = label;
      wrap.appendChild(lbl);
      const beforeLine = document.createElement("div");
      beforeLine.style.cssText = "color:#aa5555;text-decoration:line-through;line-height:1.4;font-size:10px;";
      if (Array.isArray(before)) {
        const items = before as Array<{ index?: number; x: number; y: number }>;
        beforeLine.textContent = items.length === 0 ? "(none)" : items.map((s) => `${prefix}${s.index ?? ""}@(${s.x},${s.y})`).join("  ");
      } else if (before && typeof before === "object") {
        const s = before as { x: number; y: number };
        beforeLine.textContent = `${prefix}@(${s.x},${s.y})`;
      } else {
        beforeLine.textContent = "(unset)";
      }
      wrap.appendChild(beforeLine);
      const afterLine = document.createElement("div");
      afterLine.style.cssText = "color:#77cc77;line-height:1.4;font-size:10px;";
      if (Array.isArray(after)) {
        const items = after as Array<{ index?: number; x: number; y: number }>;
        afterLine.textContent = items.length === 0 ? "(cleared)" : items.map((s) => `${prefix}${s.index ?? ""}@(${s.x},${s.y})`).join("  ");
      } else if (after && typeof after === "object") {
        const s = after as { x: number; y: number };
        afterLine.textContent = `${prefix}@(${s.x},${s.y})`;
      }
      wrap.appendChild(afterLine);
      lines.push(wrap);
    };

    const addTriggersDiff = (after: import("../net/GameClient").RefinerTrigger[] | undefined): void => {
      if (after === undefined) return;
      const wrap = document.createElement("div");
      wrap.style.cssText = "margin-bottom:8px;";
      const lbl = document.createElement("div");
      lbl.style.cssText = "color:#88aacc;font-size:10px;letter-spacing:1px;margin-bottom:2px;";
      lbl.textContent = `TRIGGERS (${after.length} total — replaces ${base.triggerObjects.length})`;
      wrap.appendChild(lbl);
      if (after.length === 0) {
        const empty = document.createElement("div");
        empty.style.cssText = "color:#aa5555;text-decoration:line-through;line-height:1.4;font-size:10px;";
        empty.textContent = "(all current triggers cleared)";
        wrap.appendChild(empty);
      } else {
        for (let i = 0; i < after.length; i++) {
          const t = after[i];
          const row = document.createElement("div");
          row.style.cssText = "color:#77cc77;line-height:1.4;font-size:10px;";
          const bits: string[] = [`T${i}`, t.id, t.kind.toUpperCase(), `(${t.region.x},${t.region.y},${t.region.w}×${t.region.h})`];
          if (t.kind === "combat" && (t.defIds?.length ?? 0) > 0) bits.push(`flips=${t.defIds!.join(",")}`);
          if (t.message) bits.push(`"${t.message.slice(0, 60)}"`);
          row.textContent = `+ ${bits.join(" · ")}`;
          wrap.appendChild(row);
        }
      }
      lines.push(wrap);
    };

    addTextDiff("TITLE",           base.title,          p.title);
    addTextDiff("INTRODUCTION",    base.introduction,   p.introduction);
    addTextDiff("DESCRIPTION",     base.description,    p.description);
    addTextDiff("AIGM CONTEXT",    base.aigmContext,    p.aigmContext);
    addTextDiff("OBJECTIVE",       base.objective,      p.objective);
    addTextDiff("COMPLETION FLAG", base.completionFlag, p.completionFlag);
    addArrayDiff("ALLY IDS",       base.allyIds,        p.allyIds);
    addArrayDiff("ENEMY IDS",      base.enemyIds,       p.enemyIds);
    addArrayDiff("NEUTRAL NPC IDS",base.neutralIds,     p.neutralIds);
    addSpawnDiff("PLAYER SPAWN",  "P",  base.playerPlacement, p.playerSpawn);
    addSpawnDiff("ENEMY SPAWNS",  "E",  base.enemyPlacements,  p.enemySpawns);
    addSpawnDiff("ALLY SPAWNS",   "A",  base.allyPlacements,   p.allySpawns);
    addSpawnDiff("NEUTRAL SPAWNS","N",  base.neutralPlacements,p.neutralSpawns);
    addTriggersDiff(p.triggerObjects);

    if (lines.length === 0) {
      const note = document.createElement("div");
      note.style.cssText = "color:#778899;font-style:italic;";
      note.textContent = "The model returned a rationale but no field changes — try a more specific prompt.";
      this.aiDiffEl.appendChild(note);
    } else {
      for (const l of lines) this.aiDiffEl.appendChild(l);
    }
  }

  /** Merge the pending proposal into the live form state. Text + rosters
   *  flow into the HTML inputs and the MonsterPicker; spawn proposals are
   *  applied to the ZonePainter (and switch the painter into exact mode);
   *  triggerObjects replace the TriggerEditor's list wholesale. */
  private acceptAiProposal(): void {
    if (!this.aiPendingProposal) {
      if (this.aiStatusEl) this.aiStatusEl.textContent = "Nothing to accept yet.";
      return;
    }
    const p = this.aiPendingProposal.proposed;
    if (p.title          !== undefined) this.formTitle          = p.title;
    if (p.introduction   !== undefined) this.formIntroduction   = p.introduction;
    if (p.description    !== undefined) this.formDescription    = p.description;
    if (p.aigmContext    !== undefined) this.formAigmContext    = p.aigmContext;
    if (p.objective      !== undefined) this.formObjective      = p.objective;
    if (p.completionFlag !== undefined) this.formCompletionFlag = p.completionFlag;
    if (this.formTitleInput          && p.title          !== undefined) this.formTitleInput.value          = p.title;
    if (this.formIntroInput          && p.introduction   !== undefined) this.formIntroInput.value          = p.introduction;
    if (this.formDescriptionInput    && p.description    !== undefined) this.formDescriptionInput.value    = p.description;
    if (this.formAigmContextInput    && p.aigmContext    !== undefined) this.formAigmContextInput.value    = p.aigmContext;
    if (this.formObjectiveInput      && p.objective      !== undefined) this.formObjectiveInput.value      = p.objective;
    if (this.formCompletionFlagInput && p.completionFlag !== undefined) this.formCompletionFlagInput.value = p.completionFlag;

    // Apply roster changes via the MonsterPicker so its UI + the
    // ZonePainter's progress labels refresh.
    if (this.monsterPicker) {
      if (p.allyIds    !== undefined) this.monsterPicker.setAllyIds(p.allyIds);
      if (p.enemyIds   !== undefined) this.monsterPicker.setEnemyIds(p.enemyIds);
      if (p.neutralIds !== undefined) this.monsterPicker.setNeutralIds(p.neutralIds);
    } else {
      if (p.allyIds    !== undefined) this.formSeed.allyIds    = [...p.allyIds];
      if (p.enemyIds   !== undefined) this.formSeed.enemyIds   = [...p.enemyIds];
      if (p.neutralIds !== undefined) this.formSeed.neutralIds = [...p.neutralIds];
    }

    // Spawn proposals — collected and applied as one batched placement set.
    const hasSpawnProposal =
      p.playerSpawn    !== undefined ||
      p.enemySpawns    !== undefined ||
      p.allySpawns     !== undefined ||
      p.neutralSpawns  !== undefined;
    if (hasSpawnProposal) {
      // Switch to exact mode so the placements are honoured by SAVE. The
      // mode flip also tells the painter to render the per-slot markers.
      this.zonePainter?.setPlacementMode("exact");
      // Start from existing placements; replace each role independently.
      const existing = this.zonePainter?.getPlacements() ?? this.formSeed.placements;
      const next: import("../../../shared/types").EncounterPlacement[] = [];
      const playerProposed = p.playerSpawn !== undefined;
      const enemyProposed   = p.enemySpawns   !== undefined;
      const allyProposed    = p.allySpawns    !== undefined;
      const neutralProposed = p.neutralSpawns !== undefined;
      for (const e of existing) {
        if (e.role === "player"  && playerProposed)  continue;
        if (e.role === "enemy"   && enemyProposed)   continue;
        if (e.role === "ally"    && allyProposed)    continue;
        if (e.role === "neutral" && neutralProposed) continue;
        next.push(e);
      }
      if (p.playerSpawn) next.push({ role: "player", x: p.playerSpawn.x, y: p.playerSpawn.y });
      for (const s of p.enemySpawns   ?? []) if (s.index !== undefined) next.push({ role: "enemy",   index: s.index, x: s.x, y: s.y });
      for (const s of p.allySpawns    ?? []) if (s.index !== undefined) next.push({ role: "ally",    index: s.index, x: s.x, y: s.y });
      for (const s of p.neutralSpawns ?? []) if (s.index !== undefined) next.push({ role: "neutral", index: s.index, x: s.x, y: s.y });
      if (this.zonePainter) {
        this.zonePainter.setPlacements(next);
      } else {
        // No painter built (no map loaded). Seed for next rebuild.
        this.formSeed.placements = next;
        this.formSeed.placementMode = "exact";
      }
    }

    // Trigger objects — replace the editor's list wholesale. Then sync the
    // ZonePainter's trigger-region overlay so the map shows the new beats.
    if (p.triggerObjects !== undefined) {
      // The wire shape is a subset of ComposedTrigger; the missing optional
      // fields are filled with sensible defaults so the editor renders.
      const triggers = p.triggerObjects.map((t) => ({
        id: t.id,
        whenEvent: t.whenEvent ?? "player_moved",
        region: { ...t.region },
        kind: t.kind,
        dc: t.dc ?? 10,
        passMessage: t.passMessage ?? "",
        message: t.message,
        defId: t.defId ?? "",
        defIds: t.defIds ? [...t.defIds] : undefined,
        xpAmount: t.xpAmount,
        durationMs: t.durationMs,
        entityRef: t.entityRef,
        fadeMode: t.fadeMode,
        announcementMode: t.announcementMode,
        whenFlagName: t.whenFlagName,
        setFlagName: t.setFlagName,
      }));
      if (this.triggerEditor) {
        this.triggerEditor.setTriggers(triggers);
        this.syncTriggerRegionsToPreview();
      } else {
        this.formSeed.triggers = triggers;
      }
    }

    if (this.statusEl) this.statusEl.textContent = "Applied AI proposal — review and SAVE ENCOUNTER when ready.";
    if (this.aiStatusEl) this.aiStatusEl.textContent = "Proposal applied. Type another prompt to iterate.";
    this.aiPendingProposal = null;
    if (this.aiAcceptBtn) this.aiAcceptBtn.setDisabled(true);
    if (this.aiRejectBtn) this.aiRejectBtn.setDisabled(true);
    if (this.aiDiffEl) {
      this.aiDiffEl.replaceChildren();
      this.aiDiffEl.textContent = "Proposal applied. Iterate with another prompt or switch to Regular to fine-tune.";
    }
    this.refreshButtons();
  }

  private rejectAiProposal(): void {
    if (!this.aiPendingProposal) {
      if (this.aiStatusEl) this.aiStatusEl.textContent = "No proposal active.";
      return;
    }
    this.aiPendingProposal = null;
    if (this.aiAcceptBtn) this.aiAcceptBtn.setDisabled(true);
    if (this.aiRejectBtn) this.aiRejectBtn.setDisabled(true);
    if (this.aiStatusEl) this.aiStatusEl.textContent = "Proposal discarded.";
    if (this.aiDiffEl) {
      this.aiDiffEl.replaceChildren();
      this.aiDiffEl.textContent = "Discarded. Try a new prompt.";
    }
  }

  /**
   * Build the BASIC INFORMATION tab's contents inside the right column.
   * Stacks title (+PREVIEW button), introduction, description (player card
   * text), AIGM context (long-form scene grounding for the GM), and an
   * objective + completion-flag row. The two long textareas (introduction
   * + AIGM context) flex to fill the panel; the player description is a
   * single short textarea since the encounter card has limited room.
   */
  private buildBasicInfoTab(x: number, y: number, w: number, h: number): void {
    const oneLineH = 28;
    const descShortH = 70;
    // title(28+22) + intro(22) + desc(22+short+14) + aigm(22) + obj(22+28) + spacers
    const fixedHeight = (22 + oneLineH) + 14 + 22 + 14 + (22 + descShortH) + 14 + 22 + 14 + (22 + oneLineH);
    const textareaH = Math.max(60, Math.floor((h - fixedHeight) / 2));
    /** Push a label into the main label set, the basic-info subset (for
     *  tab toggling), and the formChrome (for bulk dispose). */
    const pushBasicLabel = (lbl: HtmlTextHandle): void => {
      this.formLabels.push(lbl);
      this.basicInfoLabels.push(lbl);
      this.formChrome.push(lbl);
    };
    /** Track an HTML input on formChrome so it disposes with the form. */
    const trackHtmlInput = <T extends HTMLElement>(el: T): T => {
      this.formChrome.push(htmlChromeHandle(el));
      return el;
    };

    // ── TITLE row (input + PREVIEW button) ─────────────────────────────
    const titleY = y;
    pushBasicLabel(this.makeSubLabel(x, titleY, w, "TITLE"));
    const previewBtnW = 110;
    const titleInputW = w - previewBtnW - 8;
    this.formTitleInput = trackHtmlInput(this.buildLineInput(
      x, titleY + 22, titleInputW, oneLineH,
      "Encounter title",
      (val) => { this.formTitle = val; },
      this.formTitle,
    ));
    this.titlePreviewBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: x + titleInputW + 8, y: titleY + 22,
      w: previewBtnW, h: oneLineH,
      label: "PREVIEW", variant: "secondary", fontSize: 11,
      onClick: () => this.previewTitleSupertitle(),
    });
    this.formChrome.push(this.titlePreviewBtn);

    // ── INTRODUCTION ──────────────────────────────────────────────────
    const introY = titleY + 22 + oneLineH + 14;
    pushBasicLabel(this.makeSubLabel(x, introY, w, "INTRODUCTION"));
    this.formIntroInput = trackHtmlInput(this.buildTextarea(
      x, introY + 22, w, textareaH,
      "Opening narration shown to the player…",
      (val) => { this.formIntroduction = val; },
      this.formIntroduction,
    ));

    // ── DESCRIPTION (player-facing card text) ─────────────────────────
    const descY = introY + 22 + textareaH + 14;
    pushBasicLabel(this.makeSubLabel(x, descY, w, "DESCRIPTION"));
    this.formDescriptionInput = trackHtmlInput(this.buildTextarea(
      x, descY + 22, w, descShortH,
      "Short summary shown on the encounter card — what the player sees before launching.",
      (val) => { this.formDescription = val; },
      this.formDescription,
    ));

    // ── AIGM CONTEXT (long-form scene grounding for the GM) ───────────
    const aigmY = descY + 22 + descShortH + 14;
    pushBasicLabel(this.makeSubLabel(x, aigmY, w, "AIGM CONTEXT"));
    this.formAigmContextInput = trackHtmlInput(this.buildTextarea(
      x, aigmY + 22, w, textareaH,
      "Scene context the AIGM sees silently — atmosphere, what NPCs know, what to gate behind checks, how the scene should resolve.",
      (val) => { this.formAigmContext = val; },
      this.formAigmContext,
    ));

    // ── OBJECTIVE + COMPLETION FLAG row ──────────────────────────────
    const objFlagY = aigmY + 22 + textareaH + 14;
    const halfW = Math.floor((w - 8) / 2);
    pushBasicLabel(this.makeSubLabel(x, objFlagY, halfW, "OBJECTIVE"));
    this.formObjectiveInput = trackHtmlInput(this.buildLineInput(
      x, objFlagY + 22, halfW, oneLineH,
      "Player-facing one-liner",
      (val) => { this.formObjective = val; },
      this.formObjective,
    ));
    pushBasicLabel(this.makeSubLabel(x + halfW + 8, objFlagY, halfW, "COMPLETION FLAG"));
    this.formCompletionFlagInput = trackHtmlInput(this.buildLineInput(
      x + halfW + 8, objFlagY + 22, halfW, oneLineH,
      "snake_case slug",
      (val) => { this.formCompletionFlag = val; },
      this.formCompletionFlag,
    ));
  }

  // ── Outer tabs (Regular / Generative AI) ────────────────────────────────

  /** Build the two outer tab buttons centred between title and content.
   *  Scene chrome — built once in `create()` and never rebuilt. The button
   *  only flips the outer tab; visibility is handled by `setOuterTab`. */
  private buildOuterTabs(): void {
    const TAB_W = 220;
    const TAB_GAP = 8;
    const totalW = TAB_W * 2 + TAB_GAP;
    const startX = (W - totalW) / 2;
    this.regularTabBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: startX, y: OUTER_TAB_Y, w: TAB_W, h: OUTER_TAB_H,
      label: "REGULAR", variant: "secondary", fontSize: 12,
      onClick: () => this.setOuterTab("regular"),
    });
    this.aiTabBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: startX + TAB_W + TAB_GAP, y: OUTER_TAB_Y, w: TAB_W, h: OUTER_TAB_H,
      label: "GENERATIVE AI", variant: "secondary", fontSize: 12,
      onClick: () => this.setOuterTab("ai"),
    });
    this.sceneChrome.push(this.regularTabBtn, this.aiTabBtn);
    this.refreshOuterTabActiveState();
  }

  /** Switch outer tab and reconcile right-column visibility. Map column +
   *  paint bar stay mounted in both tabs. */
  private setOuterTab(tab: "regular" | "ai"): void {
    if (this.outerTab === tab) return;
    this.outerTab = tab;
    this.refreshOuterTabActiveState();
    this.refreshOuterTabVisibility();
  }

  private refreshOuterTabActiveState(): void {
    if (this.regularTabBtn) this.regularTabBtn.setActive(this.outerTab === "regular");
    if (this.aiTabBtn)      this.aiTabBtn.setActive(this.outerTab === "ai");
  }

  /** Show one outer tab's right column and hide the other. Called after a
   *  tab switch AND after `rebuildForm` rebuilds both right columns. */
  private refreshOuterTabVisibility(): void {
    const isRegular = this.outerTab === "regular";
    // Regular right column = inner tab bar + the currently active sub-tab.
    if (this.basicTabBtn)    this.basicTabBtn.setVisible(isRegular);
    if (this.monstersTabBtn) this.monstersTabBtn.setVisible(isRegular);
    if (this.triggersTabBtn) this.triggersTabBtn.setVisible(isRegular);
    if (isRegular) {
      this.activatePickerTab(this.pickerTab);
    } else {
      if (this.basicInfoSubContainer) this.basicInfoSubContainer.setVisible(false);
      if (this.monsterSubContainer)   this.monsterSubContainer.setVisible(false);
      if (this.triggerSubContainer)   this.triggerSubContainer.setVisible(false);
      if (this.monsterPicker)         this.monsterPicker.setVisible(false);
      if (this.triggerEditor)         this.triggerEditor.setVisible(false);
      this.setBasicInfoDisplay(false);
    }
    this.setAiRightColumnVisible(!isRegular);
  }

  private setAiRightColumnVisible(visible: boolean): void {
    const d = visible ? "" : "none";
    if (this.aiPromptInput) this.aiPromptInput.style.display = d;
    if (this.aiStatusEl)    this.aiStatusEl.style.display    = d;
    if (this.aiDiffEl)      this.aiDiffEl.style.display      = d;
    if (this.aiSubmitBtn)   this.aiSubmitBtn.setVisible(visible);
    if (this.aiResetBtn)    this.aiResetBtn.setVisible(visible);
    if (this.aiAcceptBtn)   this.aiAcceptBtn.setVisible(visible);
    if (this.aiRejectBtn)   this.aiRejectBtn.setVisible(visible);
  }

  private activatePickerTab(tab: "basic" | "monsters" | "triggers"): void {
    this.pickerTab = tab;
    const showBasic = tab === "basic";
    const showMon = tab === "monsters";
    const showTrg = tab === "triggers";
    if (this.basicInfoSubContainer) this.basicInfoSubContainer.setVisible(showBasic);
    if (this.monsterSubContainer)   this.monsterSubContainer.setVisible(showMon);
    if (this.triggerSubContainer)   this.triggerSubContainer.setVisible(showTrg);
    if (this.monsterPicker) this.monsterPicker.setVisible(showMon);
    if (this.triggerEditor) this.triggerEditor.setVisible(showTrg);
    // Basic-info HTML inputs aren't inside a Phaser container; toggle their
    // own display so they hide alongside the other tabs.
    this.setBasicInfoDisplay(showBasic);
    if (this.basicTabBtn)    this.basicTabBtn.setActive(showBasic);
    if (this.monstersTabBtn) this.monstersTabBtn.setActive(showMon);
    if (this.triggersTabBtn) this.triggersTabBtn.setActive(showTrg);
  }

  /** Hide / show the BASIC INFO tab's HTML inputs + labels. The inputs are
   *  rendered directly into the DOM (not inside a Phaser container), so
   *  toggling tab visibility means toggling each element's `display`. */
  private setBasicInfoDisplay(visible: boolean): void {
    const d = visible ? "" : "none";
    if (this.formTitleInput)          this.formTitleInput.style.display          = d;
    if (this.formIntroInput)          this.formIntroInput.style.display          = d;
    if (this.formDescriptionInput)    this.formDescriptionInput.style.display    = d;
    if (this.formAigmContextInput)    this.formAigmContextInput.style.display    = d;
    if (this.formObjectiveInput)      this.formObjectiveInput.style.display      = d;
    if (this.formCompletionFlagInput) this.formCompletionFlagInput.style.display = d;
    if (this.titlePreviewBtn)        this.titlePreviewBtn.setVisible(visible);
    for (const lbl of this.basicInfoLabels) lbl.setVisible(visible);
  }

  private syncTriggerRegionsToPreview(): void {
    if (!this.zonePainter || !this.triggerEditor) return;
    const triggers = this.triggerEditor.getTriggers();
    // Only REGION-style triggers (whenEvent === 'player_moved') actually
    // attach to a map area. ON START / ON COMPLETE / ON FLAG fire on
    // engine events and shouldn't paint a rectangle on the map; passing
    // them through would draw a stray region at whatever stale x/y/w/h the
    // trigger still carries. The long-rest kinds (enable_long_rest /
    // disable_long_rest) are also event-only — even if the user happens to
    // set their WHEN to REGION, the painter doesn't have a colour swatch
    // for them, so filter them out here too.
    type RegionKind = Parameters<NonNullable<typeof this.zonePainter>['setTriggerRegions']>[0][number]['kind'];
    const regionKinds = new Set<string>([
      "perception", "log", "aigm", "combat", "xp",
      "announcement", "speech", "fade", "set_flag",
    ]);
    const regionTriggers = triggers
      .filter((t) => (t.whenEvent ?? "player_moved") === "player_moved")
      .filter((t) => regionKinds.has(t.kind));
    this.zonePainter.setTriggerRegions(regionTriggers.map((t) => ({
      id: t.id,
      kind: t.kind as RegionKind,
      region: t.region,
    })));
  }

  // ── Bottom bar + button state ───────────────────────────────────────────

  private buildBottomBar(): void {
    this.add.rectangle(W / 2, H - 58, W - 64, 1, 0x334455);
    // BACK — far left.
    this.backBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: 40, y: H - 54, w: 140, h: 36,
      label: "BACK", variant: "ghost",
      onClick: () => this.scene.start("MainMenuScene"),
    });
    this.sceneChrome.push(this.backBtn);

    // OPEN ENCOUNTER + LOAD MAP — left-of-center, side by side.
    this.openBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: 200, y: H - 54, w: 220, h: 36,
      label: "📂 OPEN ENCOUNTER", variant: "secondary",
      onClick: () => this.openEncounterPicker(),
    });
    this.sceneChrome.push(this.openBtn);
    this.loadMapBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: 432, y: H - 54, w: 220, h: 36,
      label: "🗺 LOAD MAP", variant: "secondary",
      onClick: () => this.openMapSelector(),
    });
    // Hint the role with a cooler purple so it reads as separate from OPEN.
    this.loadMapBtn.el.style.background = "#2a1a3a";
    this.loadMapBtn.el.style.borderColor = "#5a4480";
    this.loadMapBtn.el.style.color = "#d8c8e8";
    this.sceneChrome.push(this.loadMapBtn);

    // SAVE ENCOUNTER — far right.
    this.saveBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: W - 360, y: H - 54, w: 320, h: 36,
      label: "✓ SAVE ENCOUNTER", variant: "primary",
      onClick: () => this.runSave(),
    });
    this.sceneChrome.push(this.saveBtn);
    this.refreshButtons();
  }

  private refreshButtons(): void {
    let guard: string | null = null;
    if (this.busy) guard = "Busy…";
    // SAVE is enabled both for a loaded encounter AND for a fresh draft
    // started via LOAD MAP — the latter has acceptedMap but no encounter id.
    else if (!this.acceptedMap) guard = "Open an encounter or load a map first.";
    else if (!this.zonePainter) guard = "Open an encounter or load a map first.";
    else {
      // SAVE only needs SOMEWHERE for the player to spawn — either a paint
      // zone or an exact placement satisfies the requirement, regardless of
      // the placement mode in the UI. (Zones and exact placements both
      // survive the save round trip; the engine resolves them at session
      // start with exact-mode winning when both are present.)
      const hasPlayerPlacement = this.zonePainter.getPlacements().some((p) => p.role === 'player');
      const hasPlayerZone = this.zonePainter.getPlayerZones().size > 0;
      if (!hasPlayerPlacement && !hasPlayerZone) {
        guard = "Place a player tile (click PLAYER then a tile) or paint a player-start zone (PAINT: PLAYER).";
      }
    }
    const ready = guard === null;
    if (this.saveBtn) {
      this.saveBtn.setDisabled(!ready);
      this.saveBtn.setOnClick(ready ? (() => this.runSave()) : (() => {
        if (this.statusEl && guard) this.statusEl.textContent = guard;
      }));
    }
  }

  // ── Save ────────────────────────────────────────────────────────────────

  private async runSave(): Promise<void> {
    if (!this.loaded || !this.acceptedMap || !this.zonePainter) return;
    const playerCells = this.zonePainter.getPlayerZones();
    const playerPlacement = this.zonePainter.getPlacements().find((p) => p.role === 'player');
    const placementMode = this.zonePainter.getPlacementMode();
    // Either form of player start is acceptable. If both are missing, refuse.
    if (playerCells.size === 0 && !playerPlacement) return;
    this.busy = true;
    this.refreshButtons();
    if (this.statusEl) this.statusEl.textContent = this.isDraft ? "Creating encounter…" : "Saving encounter…";
    try {
      const map = this.acceptedMap;
      const startingZonesData = new Array<number>(map.width * map.height).fill(0);
      for (const key of playerCells) {
        const [x, y] = key.split(",").map(Number);
        startingZonesData[y * map.width + x] = STARTING_ZONE_PLAYER;
      }
      for (const key of this.zonePainter.getAllyZones()) {
        const [x, y] = key.split(",").map(Number);
        startingZonesData[y * map.width + x] = STARTING_ZONE_ALLY;
      }
      for (const key of this.zonePainter.getEnemyZones()) {
        const [x, y] = key.split(",").map(Number);
        startingZonesData[y * map.width + x] = STARTING_ZONE_ENEMY;
      }
      for (const key of this.zonePainter.getNeutralZones()) {
        const [x, y] = key.split(",").map(Number);
        startingZonesData[y * map.width + x] = STARTING_ZONE_NEUTRAL;
      }
      const placements = this.zonePainter.getPlacements();
      const triggers = this.triggerEditor?.getTriggers() ?? [];
      const commonFields = {
        aigmContext: this.formAigmContext,
        description: this.formDescription,
        startingZonesData,
        placementMode,
        placements,
        allyIds: this.monsterPicker?.getAllyIds() ?? [],
        enemyIds: this.monsterPicker?.getEnemyIds() ?? [],
        neutralIds: this.monsterPicker?.getNeutralIds() ?? [],
        customTitle: this.formTitle,
        customIntroduction: this.formIntroduction,
        customObjective: this.formObjective,
        completionFlag: this.formCompletionFlag,
        triggers,
      };

      let resultId: string;
      if (this.isDraft || !this.loaded.id) {
        // New encounter: compose a fresh one on the picked existing map.
        // The server allocates the id and returns it for subsequent updates.
        const { encounterId } = await gameClient.composeEncounter({
          existingMapId: this.acceptedMap.mapId ?? undefined,
          ...commonFields,
        });
        resultId = encounterId;
        this.loaded = { ...this.loaded, id: encounterId };
        this.isDraft = false;
        this.subtitleText.setText(`Editing  ${encounterId}  ·  ${this.formTitle ?? ""}`);
      } else {
        await gameClient.updateEncounter({
          encounterId: this.loaded.id,
          mapId: this.acceptedMap.mapId ?? undefined,
          ...commonFields,
        });
        resultId = this.loaded.id;
      }

      const [encs, maps] = await Promise.all([gameClient.listEncounters(), gameClient.listMaps()]);
      this.registry.set("encounters", encs);
      this.registry.set("maps", maps);

      if (this.statusEl) this.statusEl.textContent = `Saved ${resultId}.`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.statusEl) this.statusEl.textContent = `Save failed: ${msg}`;
    } finally {
      this.busy = false;
      this.refreshButtons();
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private makeSubLabel(x: number, y: number, w: number, text: string): HtmlTextHandle {
    return createHtmlText({
      scene: this, sceneWidth: W,
      x, y, w,
      text, fontSize: 10, color: "#778899", letterSpacing: 1,
    });
  }

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
      fontSize: 13, scaleFont: true,
      onInput,
    }).el;
  }

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
      fontSize: 13, lineHeight: 1.4,
      scaleFont: true,
      onInput,
    }).el;
  }

  /** Place a free-standing HTML element at the given scene-space rect using
   *  the canvas's current scale factor. Used for divs that aren't textareas
   *  / inputs / buttons — the AI tab's status line and diff viewer go
   *  through this so they track the canvas like every other input. */
  private attachScaledPlacement(el: HTMLElement, x: number, y: number, w: number, h: number, baseFontPx: number): void {
    const place = (): void => {
      const rect = this.sys.game.canvas.getBoundingClientRect();
      const s = rect.width / W;
      el.style.left = `${rect.left + x * s}px`;
      el.style.top  = `${rect.top  + y * s}px`;
      el.style.width  = `${w * s}px`;
      el.style.height = `${h * s}px`;
      el.style.fontSize = `${baseFontPx * s}px`;
    };
    place();
    this.scale.on("resize", place);
  }

  private buildStatusLine(): void {
    const status = document.createElement("div");
    status.style.cssText = `
      position: absolute; color: #889aac; font-family: monospace;
      font-size: 12px; pointer-events: none; z-index: 10;
      text-align: center; box-sizing: border-box;
    `;
    document.body.appendChild(status);
    this.statusEl = status;
    const place = (): void => {
      const rect = this.sys.game.canvas.getBoundingClientRect();
      const s = rect.width / W;
      // Centered across the canvas width — the "Loaded gen_xxx" feedback
      // should read as a global status, not a left-rail caption.
      status.style.left = `${rect.left}px`;
      status.style.top  = `${rect.top + (H - 24) * s}px`;
      status.style.width = `${rect.width}px`;
      status.style.fontSize = `${12 * s}px`;
    };
    place();
    this.scale.on("resize", place);
    this.sceneChrome.push(htmlChromeHandle(status));
  }

  /**
   * Play the encounter title as a full-screen supertitle so the author can
   * see exactly how it'll appear in-game (and whether it wraps unflatteringly,
   * runs into the edges, or fits cleanly on a single line). Hides every UI
   * element the editor owns for the duration, fades to black, plays the
   * supertitle, then fades back in and restores the chrome. Re-entry guarded
   * so a hammered button can't stack multiple previews.
   */
  private async previewTitleSupertitle(): Promise<void> {
    if (this.titlePreviewActive) return;
    const text = (this.formTitleInput?.value ?? this.formTitle).trim();
    if (!text) return;
    this.titlePreviewActive = true;
    this.setDomChromeVisible(false);
    const screenEffects = new ScreenEffects();
    try {
      await screenEffects.fadeOut(0);
      await screenEffects.showSupertitle(text, 2500);
      await screenEffects.fadeIn(600);
    } finally {
      screenEffects.destroy();
      this.setDomChromeVisible(true);
      this.titlePreviewActive = false;
    }
  }
  private titlePreviewActive = false;

  /**
   * Hide / show everything the editor owns. Both the scene-lifetime chrome
   * (`sceneChrome`) and the per-form chrome (`formChrome`) are toggled; on
   * show, the active picker tab is re-applied so sub-components respect
   * tab-aware visibility instead of all becoming visible at once.
   */
  private setDomChromeVisible(visible: boolean): void {
    for (const h of this.sceneChrome) h.setVisible(visible);
    for (const h of this.formChrome)  h.setVisible(visible);
    // Re-show only the elements that belong to the active outer tab so the
    // other tab's right-column content stays hidden across visibility flips.
    if (visible) this.refreshOuterTabVisibility();
  }

  /** Disposes every tracked handle (scene + form) plus the encounter picker
   *  if it's currently open. Called on scene shutdown + destroy events. */
  private teardownDom(): void {
    this.disposeFormChrome();
    for (const h of this.sceneChrome) h.dispose();
    this.sceneChrome = [];
    if (this.encounterPicker) { this.encounterPicker.destroy(); this.encounterPicker = null; }
    if (this.mapSelector)     { this.mapSelector.destroy();     this.mapSelector     = null; }
    // Field refs that lived in sceneChrome — null out so any stray check
    // fails cleanly post-teardown.
    this.zonePainter = null;
    this.monsterPicker = null;
    this.triggerEditor = null;
    this.statusEl = null;
  }
}

// ── Module helpers ───────────────────────────────────────────────────────

/** Decode a `startingZones` layer into four per-role cell sets keyed `"x,y"`. */
function decodeStartingZones(
  layer: import("../../../shared/types").EncounterDef["startingZones"],
): { playerCells: Set<string>; allyCells: Set<string>; enemyCells: Set<string>; neutralCells: Set<string> } {
  const playerCells = new Set<string>();
  const allyCells = new Set<string>();
  const enemyCells = new Set<string>();
  const neutralCells = new Set<string>();
  if (!layer || !layer.data) return { playerCells, allyCells, enemyCells, neutralCells };
  for (let y = 0; y < layer.height; y++) {
    for (let x = 0; x < layer.width; x++) {
      const v = layer.data[y * layer.width + x];
      if      (v === STARTING_ZONE_PLAYER)  playerCells.add(`${x},${y}`);
      else if (v === STARTING_ZONE_ALLY)    allyCells.add(`${x},${y}`);
      else if (v === STARTING_ZONE_ENEMY)   enemyCells.add(`${x},${y}`);
      else if (v === STARTING_ZONE_NEUTRAL) neutralCells.add(`${x},${y}`);
    }
  }
  return { playerCells, allyCells, enemyCells, neutralCells };
}

function reverseMapTriggers(triggers: EncounterTrigger[]): ComposedTrigger[] {
  const out: ComposedTrigger[] = [];
  for (const t of triggers) {
    const isRegion = t.when.event === "player_moved" && "in_area" in t.when && !!t.when.in_area;
    const whenEvent = isRegion ? "player_moved"
      : t.when.event === "encounter_started" ? "encounter_started"
      : t.when.event === "encounter_completed" ? "encounter_completed"
      : t.when.event === "flag_set" ? "flag_set"
      : null;
    if (!whenEvent) continue;
    // Region triggers carry their own bounds; lifecycle triggers have none —
    // use a sentinel 1×1 at origin so the editor's region inputs still have
    // a value (the row hides them anyway).
    const region = (isRegion && "in_area" in t.when && t.when.in_area)
      ? t.when.in_area
      : { x: 0, y: 0, w: 1, h: 1 };
    const whenFlagName = whenEvent === "flag_set" && "name" in t.when ? t.when.name : undefined;

    // Walk the trigger's `then` array, recognising the multi-action
    // combat template (N × set_disposition_by_def_id(enemy) + trigger_combat)
    // and turning each other recognised action into a single ComposedAction.
    // Unknown actions are silently skipped — the server's preservation
    // patch in /generate/encounter/update keeps them in the on-disk JSON.
    const composedActions: ComposedAction[] = [];
    let i = 0;
    while (i < t.then.length) {
      const a = t.then[i];
      // Combat template: consecutive set_disposition_by_def_id (enemy)
      // followed by a trigger_combat.
      if (a.type === "set_disposition_by_def_id" && a.disposition === "enemy") {
        const flipIds: string[] = [a.defId];
        let j = i + 1;
        while (j < t.then.length) {
          const b = t.then[j];
          if (b.type === "set_disposition_by_def_id" && b.disposition === "enemy") {
            flipIds.push(b.defId);
            j++;
          } else {
            break;
          }
        }
        const trailer = t.then[j];
        if (trailer && trailer.type === "trigger_combat") {
          composedActions.push({
            kind: "combat",
            defId: flipIds[0],
            defIds: flipIds.length > 1 ? flipIds : undefined,
          });
          i = j + 1;
          continue;
        }
        // Stray set_disposition without a trigger_combat trailer — skip and
        // let it round-trip via the server preservation patch.
      }
      const composed = singleActionToComposed(a);
      if (composed) composedActions.push(composed);
      i++;
    }
    if (composedActions.length === 0) continue;

    // First recognised action drives the trigger's primary `kind` and per-
    // kind fields. Subsequent actions land in `extraActions` so the editor
    // can render them as additional consequences of the same condition.
    const primary = composedActions[0];
    const extras = composedActions.slice(1);
    out.push({
      id: t.id,
      whenEvent,
      region,
      whenFlagName,
      // Defaults for required-on-trigger fields the primary action may omit.
      dc: 10, passMessage: "", message: "", defId: "",
      // Spread the primary action's fields over the defaults.
      ...primary,
      extraActions: extras.length > 0 ? extras : undefined,
    });
  }
  return out;
}

function singleActionToComposed(a: EncounterTrigger["then"][number]): ComposedAction | null {
  switch (a.type) {
    case "player_ability_check": {
      if (a.skill !== "perception") return null;
      const pass = a.onPass[0];
      return {
        kind: "perception",
        dc: a.dc,
        passMessage: pass && pass.type === "show_log" ? pass.message : "",
      };
    }
    case "show_log":         return { kind: "log", message: a.message };
    case "send_aigm_message":return { kind: "aigm", message: a.message };
    case "award_xp":         return { kind: "xp", xpAmount: a.amount };
    case "show_announcement":return { kind: "announcement", message: a.text, durationMs: a.durationMs, announcementMode: a.mode };
    case "npc_speaks":       return { kind: "speech", message: a.text, entityRef: a.entity };
    case "fade_screen":      return { kind: "fade", fadeMode: a.mode, durationMs: a.durationMs };
    case "set_flag":         return { kind: "set_flag", setFlagName: a.name };
    case "set_long_rest":    return { kind: a.allowed ? "enable_long_rest" : "disable_long_rest" };
    case "set_npc_hidden":   return { kind: "hide_npc", defId: a.defId, hidden: a.hidden, hideDC: a.hideDC, revealedBy: a.revealedBy };
    case "set_npc_dead": {
      const out: ComposedAction = { kind: "kill_npc", defId: a.defId };
      if (a.dropInventory === false) out.dropInventory = false;
      if (a.corpseSearch) {
        out.corpseSearchDc = a.corpseSearch.dc;
        out.corpseSearchSuccess = a.corpseSearch.successText;
        out.corpseSearchFail = a.corpseSearch.failureText;
      }
      return out;
    }
    case "start_conversation":
      return { kind: "open_conversation", npcRef: a.npcRef, conversationId: a.conversationId };
    default:
      return null;
  }
}

function savedMapToPreview(saved: SavedMapDef): MapPreviewData {
  const terrainData: number[] = [];
  for (const row of saved.gidGrid) terrainData.push(...row);
  const objectData: number[] = [];
  if (saved.objectGidGrid) {
    for (const row of saved.objectGidGrid) objectData.push(...row);
  } else {
    for (let i = 0; i < terrainData.length; i++) objectData.push(0);
  }
  return {
    mapId: saved.id,
    width: saved.cols,
    height: saved.rows,
    terrainData,
    objectData,
    name: saved.name,
    description: saved.mapdescription,
    tilesets: saved.tilesets.map((t) => ({
      firstgid: t.firstgid,
      source: `../tilesets/${(t.imageUrl.split("/").pop() ?? "").replace(/\.png$/i, ".tsj")}`,
    })),
  };
}

function pickTilesetKey(scene: Phaser.Scene): string {
  const maps = (scene.registry.get("maps") as SavedMapDef[] | undefined) ?? [];
  for (const m of maps) {
    const url = m.tilesets?.[0]?.imageUrl;
    if (url) return tilesetTextureKey(url);
  }
  return tilesetTextureKey("/tilesets/scribble.png");
}
