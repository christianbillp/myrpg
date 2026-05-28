import Phaser from "phaser";
import { gameClient } from "../net/GameClient";
import type { MonsterDef } from "../data/monsters";
import { MapPreviewOverlay, MapPreviewData } from "../ui/MapPreviewOverlay";
import { DevMode } from "../devMode";
import { tilesetTextureKey } from "./BootScene";
import type { SavedMapDef } from "../net/types";
import { STARTING_ZONE_PLAYER, STARTING_ZONE_ENEMY, STARTING_ZONE_NEUTRAL } from "../../../shared/startingZones";
import { MonsterPicker } from "../ui/generate/MonsterPicker";
import { ZonePainter } from "../ui/generate/ZonePainter";
import { TriggerEditor, type ComposedTrigger } from "../ui/generate/TriggerEditor";
import { MapSelectorOverlay } from "../ui/generate/MapSelectorOverlay";
import { ENCOUNTER_ARCHETYPES } from "../data/encounterArchetypes";
import { pickArchetype, rollArchetype, buildStartingZonesFromAnchors, rollTriggersFromAnchors } from "../encounterRandomizer";
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
const DPR = window.devicePixelRatio;

const TITLE_Y = 28;
const TAB_BAR_Y = 86;
const CONTENT_TOP = 140;
const CONTENT_BOTTOM = H - 130;
const PANEL_PAD = 48;
const PANEL_GAP = 40;
const SIDE_PANEL_WIDTH = (W - PANEL_PAD * 2 - PANEL_GAP) / 2;
const LEFT_PANEL_X = PANEL_PAD;
const RIGHT_PANEL_X = PANEL_PAD + SIDE_PANEL_WIDTH + PANEL_GAP;

// Thumbnail (also serves as the zone painter) lives in the top-right of the
// encounter settings panel when a map has been accepted.
const THUMB_TILE_PX = 12;
const THUMB_MAX_W = 340;
const THUMB_MAX_H = 240;

type Tab = "deterministic" | "generative";

type Terrain = "grassland" | "forest" | "dungeon";
type Feature =
  | "ruins" | "buildings" | "campsites" | "path"
  | "coastline"
  | "3-room" | "5-room";

// Map controls are split into two columns ("outside" vs "inside") to surface
// which terrain + feature combinations are coherent. A terrain belongs to one
// column; the player can only have one terrain selected at a time across both.
const OUTSIDE_TERRAINS: Terrain[] = ["grassland", "forest"];
const INSIDE_TERRAINS: Terrain[] = ["dungeon"];
const OUTSIDE_FEATURES: Feature[] = ["ruins", "buildings", "campsites", "path", "coastline"];
const INSIDE_FEATURES: Feature[] = ["3-room", "5-room"];

const TERRAIN_LABEL: Record<Terrain, string> = {
  grassland: "GRASSLAND",
  forest: "FOREST",
  dungeon: "DUNGEON",
};
const FEATURE_LABEL: Record<Feature, string> = {
  ruins: "RUINS", buildings: "BUILDINGS", campsites: "CAMPSITES", path: "PATH",
  coastline: "COASTLINE",
  "3-room": "3 ROOMS", "5-room": "5 ROOMS",
};
function featureColumn(f: Feature): "outside" | "inside" {
  return (INSIDE_FEATURES as Feature[]).includes(f) ? "inside" : "outside";
}
function terrainColumn(t: Terrain): "outside" | "inside" {
  return (INSIDE_TERRAINS as Terrain[]).includes(t) ? "inside" : "outside";
}

interface PromptExample {
  title: string;
  body: string;
}

const PROMPT_EXAMPLES: PromptExample[] = [
  {
    title: "Moonlit Graveyard",
    body: "A moonlit graveyard with broken statues, mist clinging to the ground, and a lone gravedigger leaning on his shovel near a freshly opened pit.",
  },
  {
    title: "Goblin Warren",
    body: "A goblin warren with three chambers connected by narrow tunnels. The largest chamber holds a chained guard dog and a crude throne built from scavenged armour.",
  },
  {
    title: "Riverside Ambush",
    body: "A reed-lined riverbank at dawn. A narrow ford lets travellers cross, but two bandits crouch in the rushes on the far side, weapons drawn.",
  },
  {
    title: "Abandoned Watchtower",
    body: "The crumbling base of a stone watchtower stands at the edge of a windswept moor. An old hermit has made camp inside, suspicious but not hostile.",
  },
  {
    title: "Crossroads Market",
    body: "A small crossroads where two dirt paths meet. A travelling merchant has set up a tarp shelter; a wary blacksmith warms his hands at a brazier.",
  },
  {
    title: "Wolf Den",
    body: "A shallow cave nestled in a snowy pine forest. Inside, a wolf pack has bedded down for the night — three adults and two pups. Bones litter the entrance.",
  },
];

/**
 * GenerateSetupScene — the third top-level setup screen. Two tabs:
 *
 *  • DETERMINISTIC — left panel exposes the MapComposer toggles (terrain +
 *    feature chips, including path). The right panel is **gated** on an
 *    saved map: until the user presses SAVE on a map preview, the right
 *    side only shows "No map available". Once a map has been saved, the
 *    right panel exposes a thumbnail of the map (also serves
 *    as a click-and-paint surface for starting zones — Player / Enemy),
 *    encounter-type chips, a monster picker (every entry in `monsters`
 *    registry can be added as Ally or Enemy), and an optional description.
 *
 *  • GENERATIVE AI — left panel is a free-text prompt; right panel is a
 *    set of clickable example cards. Generates a map or full encounter
 *    via Claude.
 *
 * Character selection is intentionally NOT on this screen — the player picks
 * the character on `EncounterSetupScene` once the new encounter has been
 * authored.
 */
export class GenerateSetupScene extends Phaser.Scene {
  private tab: Tab = "deterministic";
  private detContainer!: Phaser.GameObjects.Container;
  private genContainer!: Phaser.GameObjects.Container;
  private detRightContainer!: Phaser.GameObjects.Container;
  private tabDetBg!: Phaser.GameObjects.Rectangle;
  private tabGenBg!: Phaser.GameObjects.Rectangle;
  private tabDetLabel!: Phaser.GameObjects.Text;
  private tabGenLabel!: Phaser.GameObjects.Text;

  // Deterministic — left controls
  private selectedTerrain: Terrain | null = "grassland";
  private selectedFeatures: Set<Feature> = new Set();
  private terrainChips: Map<Terrain, Phaser.GameObjects.Rectangle> = new Map();
  private featureChips: Map<Feature, Phaser.GameObjects.Rectangle> = new Map();

  // Deterministic — right (encounter-builder) state. Zone painting and the
  // monster picker live in their own UI components; the scene only holds
  // references so it can read final selections in the COMPOSE flow.
  /** The map currently shown in the preview overlay (saved or unsaved). Used by the SAVE button. */
  private previewedMap: MapPreviewData | null = null;
  /** The most recently SAVED map. The encounter builder on the right panel uses this. */
  private acceptedMap: MapPreviewData | null = null;
  /** Set true when a save happened during a preview; closeMapPreview rebuilds the right panel and clears this. */
  private rightPanelDirty = false;
  // Story-field state (custom title, intro, objective, completion flag).
  private detTitle = "";
  private detIntroduction = "";
  private detObjective = "";
  private detCompletionFlag = "";
  private detTitleInput: HTMLInputElement | null = null;
  private detIntroInput: HTMLTextAreaElement | null = null;
  private detObjectiveInput: HTMLInputElement | null = null;
  private detCompletionFlagInput: HTMLInputElement | null = null;
  private detDescription = "";
  private detDescInput: HTMLTextAreaElement | null = null;
  private zonePainter: ZonePainter | null = null;
  private monsterPicker: MonsterPicker | null = null;
  // Seeds for the next right-panel rebuild — populated by the RANDOMIZE flow so
  // a freshly-rebuilt zone painter + monster picker start populated. Cleared
  // by `runComposeEncounter` so a save-and-restart doesn't reuse stale rolls.
  private rolledPlayerCells: Set<string> | null = null;
  private rolledEnemyCells: Set<string> | null = null;
  private rolledNeutralCells: Set<string> | null = null;
  private rolledAllyIds: string[] | null = null;
  private rolledEnemyIds: string[] | null = null;
  private rolledNeutralIds: string[] | null = null;
  private rolledTriggers: ComposedTrigger[] | null = null;
  private triggerEditor: TriggerEditor | null = null;
  private monsterSubContainer: Phaser.GameObjects.Container | null = null;
  private triggerSubContainer: Phaser.GameObjects.Container | null = null;
  private pickerTab: "monsters" | "triggers" = "monsters";
  private monstersTabBg: Phaser.GameObjects.Rectangle | null = null;
  private monstersTabLabel: Phaser.GameObjects.Text | null = null;
  private triggersTabBg: Phaser.GameObjects.Rectangle | null = null;
  private triggersTabLabel: Phaser.GameObjects.Text | null = null;
  private detRandomBg!: Phaser.GameObjects.Rectangle;
  private detRandomLabel!: Phaser.GameObjects.Text;
  private detPickMapBg!: Phaser.GameObjects.Rectangle;
  private detPickMapLabel!: Phaser.GameObjects.Text;
  private detComposeMapBg!: Phaser.GameObjects.Rectangle;
  private detComposeMapLabel!: Phaser.GameObjects.Text;
  private detComposeEncBg!: Phaser.GameObjects.Rectangle;
  private detComposeEncLabel!: Phaser.GameObjects.Text;
  private mapSelector: MapSelectorOverlay | null = null;

  // Generative AI tab state
  private genPromptInput: HTMLTextAreaElement | null = null;
  private genMapBg!: Phaser.GameObjects.Rectangle;
  private genMapLabel!: Phaser.GameObjects.Text;
  private genEncBg!: Phaser.GameObjects.Rectangle;
  private genEncLabel!: Phaser.GameObjects.Text;

  // Shared
  private statusEl: HTMLDivElement | null = null;
  private busy = false;
  private mapPreview: MapPreviewOverlay | null = null;
  private monsters: MonsterDef[] = [];

  constructor() {
    super({ key: "GenerateSetupScene" });
  }

  init(): void {
    this.tab = "deterministic";
    this.selectedTerrain = "grassland";
    this.selectedFeatures.clear();
    this.detDescription = "";
    this.terrainChips.clear();
    this.featureChips.clear();
    this.acceptedMap = null;
    this.previewedMap = null;
    this.rightPanelDirty = false;
    this.detTitle = "";
    this.detIntroduction = "";
    this.detObjective = "";
    this.detCompletionFlag = "";
    this.zonePainter = null;
    this.monsterPicker = null;
    this.rolledPlayerCells = null;
    this.rolledEnemyCells = null;
    this.rolledNeutralCells = null;
    this.rolledAllyIds = null;
    this.rolledEnemyIds = null;
    this.rolledNeutralIds = null;
    this.rolledTriggers = null;
    this.busy = false;
  }

  create(): void {
    this.monsters = (this.registry.get("monsters") as MonsterDef[] | undefined) ?? [];

    this.add.rectangle(W / 2, H / 2, W, H, 0x0d0d1e);
    this.add.text(W / 2, TITLE_Y, "GENERATE ENCOUNTER", {
      fontSize: "22px", color: "#e2b96f", fontFamily: "monospace", resolution: DPR,
    }).setOrigin(0.5, 0);
    this.add.rectangle(W / 2, TITLE_Y + 38, W - 64, 1, 0x334455);

    this.buildTabBar();

    this.detContainer = this.add.container(0, 0);
    this.genContainer = this.add.container(0, 0);
    this.detRightContainer = this.add.container(0, 0);
    this.detContainer.add(this.detRightContainer);

    this.buildDeterministicLeft();
    this.buildGenerativePanel();

    this.buildStatusLine();
    // Bottom-bar buttons must exist before any refreshButtons() call —
    // rebuildDeterministicRight() and activateTab() both touch them.
    this.buildBottomBar();
    if (DevMode.enabled) this.buildDevButton();

    this.rebuildDeterministicRight();
    this.activateTab("deterministic");

    this.events.once("shutdown", () => this.teardownDom());
    this.events.once("destroy",  () => this.teardownDom());
  }

  // ── Tab bar ─────────────────────────────────────────────────────────────

  private buildTabBar(): void {
    const tabW = 240;
    const tabH = 36;
    const centerX = W / 2;
    const detX = centerX - tabW / 2 - 6;
    const genX = centerX + tabW / 2 + 6;

    this.tabDetBg = this.add.rectangle(detX, TAB_BAR_Y, tabW, tabH, 0x1a1a2e).setStrokeStyle(2, 0x334455).setInteractive({ useHandCursor: true });
    this.tabDetLabel = this.add.text(detX, TAB_BAR_Y, "DETERMINISTIC", {
      fontSize: "13px", color: "#aabbcc", fontFamily: "monospace", resolution: DPR, letterSpacing: 1,
    }).setOrigin(0.5);
    this.tabDetBg.on("pointerdown", () => this.activateTab("deterministic"));

    this.tabGenBg = this.add.rectangle(genX, TAB_BAR_Y, tabW, tabH, 0x1a1a2e).setStrokeStyle(2, 0x334455).setInteractive({ useHandCursor: true });
    this.tabGenLabel = this.add.text(genX, TAB_BAR_Y, "GENERATIVE AI", {
      fontSize: "13px", color: "#aabbcc", fontFamily: "monospace", resolution: DPR, letterSpacing: 1,
    }).setOrigin(0.5);
    this.tabGenBg.on("pointerdown", () => this.activateTab("generative"));
  }

  private activateTab(tab: Tab): void {
    this.tab = tab;
    const det = tab === "deterministic";
    this.tabDetBg.setFillStyle(det ? 0x2a2a4a : 0x1a1a2e).setStrokeStyle(2, det ? 0xe2b96f : 0x334455);
    this.tabDetLabel.setColor(det ? "#ffe9a8" : "#aabbcc");
    this.tabGenBg.setFillStyle(!det ? 0x2a2a4a : 0x1a1a2e).setStrokeStyle(2, !det ? 0xe2b96f : 0x334455);
    this.tabGenLabel.setColor(!det ? "#ffe9a8" : "#aabbcc");

    this.detContainer.setVisible(det);
    this.genContainer.setVisible(!det);
    this.setDomVisibility();
    this.refreshButtons();
  }

  // ── Deterministic LEFT panel (always visible while tab is active) ──────

  private buildDeterministicLeft(): void {
    this.detContainer.add(this.makeHeader(LEFT_PANEL_X + SIDE_PANEL_WIDTH / 2, CONTENT_TOP, "MAP CONTROLS"));

    // Single column: TERRAIN row first (all three terrains side by side),
    // FEATURES grid below (chips greyed out automatically when their column
    // doesn't match the active terrain — see `featureChipEnabled`).
    const x = LEFT_PANEL_X;
    const chipW = 120;
    const chipGap = 14;
    const allTerrains: Terrain[] = [...OUTSIDE_TERRAINS, ...INSIDE_TERRAINS];
    const allFeatures: Feature[] = [...OUTSIDE_FEATURES, ...INSIDE_FEATURES];

    const terrainLabelY = CONTENT_TOP + 36;
    this.detContainer.add(this.makeSubLabel(x, terrainLabelY, "TERRAIN"));
    const terrainRowY = terrainLabelY + 22;
    allTerrains.forEach((t, i) => {
      const chip = this.buildTerrainChip(t, x + i * (chipW + chipGap), terrainRowY);
      this.detContainer.add(chip.bg);
      this.detContainer.add(chip.label);
    });

    const featuresLabelY = terrainRowY + 40;
    this.detContainer.add(this.makeSubLabel(x, featuresLabelY, "FEATURES"));
    let fcx = x;
    let fcy = featuresLabelY + 22;
    allFeatures.forEach((f, j) => {
      const chip = this.buildFeatureChip(f, fcx, fcy);
      this.detContainer.add(chip.bg);
      this.detContainer.add(chip.label);
      const col = (j + 1) % 2;
      if (col === 0) { fcx = x; fcy += 32; }
      else fcx += chipW + chipGap;
    });
  }

  // ── Deterministic RIGHT panel — rebuilt on accept / clear ──────────────

  private rebuildDeterministicRight(): void {
    this.detRightContainer.removeAll(true);
    // Detach previous sub-component listeners (otherwise each accept stacks
    // a new wheel handler on the scene).
    if (this.monsterPicker) {
      this.monsterPicker.destroy();
      this.monsterPicker = null;
    }
    if (this.triggerEditor) {
      this.triggerEditor.destroy();
      this.triggerEditor = null;
    }
    if (this.zonePainter) {
      this.zonePainter.destroy();
      this.zonePainter = null;
    }
    this.monsterSubContainer = null;
    this.triggerSubContainer = null;
    this.monstersTabBg = null;
    this.monstersTabLabel = null;
    this.triggersTabBg = null;
    this.triggersTabLabel = null;
    this.pickerTab = "monsters";

    // Hide the description textarea + story-field inputs while the right
    // panel is in its empty state — they're recreated when the map is saved.
    if (this.detTitleInput)         { this.detTitleInput.remove();          this.detTitleInput = null; }
    if (this.detDescInput)          { this.detDescInput.remove();           this.detDescInput = null; }
    if (this.detIntroInput)         { this.detIntroInput.remove();          this.detIntroInput = null; }
    if (this.detObjectiveInput)     { this.detObjectiveInput.remove();      this.detObjectiveInput = null; }
    if (this.detCompletionFlagInput){ this.detCompletionFlagInput.remove(); this.detCompletionFlagInput = null; }

    this.detRightContainer.add(this.makeHeader(RIGHT_PANEL_X + SIDE_PANEL_WIDTH / 2, CONTENT_TOP, "ENCOUNTER SETTINGS"));

    if (!this.acceptedMap) {
      this.buildEmptyRightPanel();
    } else {
      this.buildFilledRightPanel();
    }
    this.refreshButtons();
  }

  private buildEmptyRightPanel(): void {
    const cy = (CONTENT_TOP + CONTENT_BOTTOM) / 2;
    const cx = RIGHT_PANEL_X + SIDE_PANEL_WIDTH / 2;
    this.detRightContainer.add(
      this.add.text(cx, cy, "No map available", {
        fontSize: "16px", color: "#556677", fontFamily: "monospace", resolution: DPR,
      }).setOrigin(0.5),
    );
    this.detRightContainer.add(
      this.add.text(cx, cy + 24, "Compose a map on the left, then press SAVE in the preview.", {
        fontSize: "11px", color: "#445566", fontFamily: "monospace", resolution: DPR,
      }).setOrigin(0.5),
    );
  }

  private buildFilledRightPanel(): void {
    const map = this.acceptedMap!;

    // Thumbnail (top-right of right panel). Sized so it leaves enough room
    // beside it for the encounter-types chips + description textarea.
    const tileSize = Math.min(
      Math.floor(THUMB_MAX_W / map.width),
      Math.floor(THUMB_MAX_H / map.height),
      THUMB_TILE_PX,
    );
    const thumbW = tileSize * map.width;
    const thumbH = tileSize * map.height;
    const thumbRight = RIGHT_PANEL_X + SIDE_PANEL_WIDTH;
    const thumbX = thumbRight - thumbW;
    const thumbY = CONTENT_TOP + 38;

    // ZonePainter owns the thumbnail rendering + zone-cell interaction.
    this.zonePainter = new ZonePainter({
      scene: this,
      parent: this.detRightContainer,
      map,
      thumbX, thumbY, thumbW, thumbH, tileSize,
      tilesetKey: pickTilesetKey(this),
      sceneWidth: W,
      onZonesChanged: () => this.refreshButtons(),
      onClickEmpty:   () => this.openLargePreview(),
      initialPlayerCells:  this.rolledPlayerCells  ?? undefined,
      initialEnemyCells:   this.rolledEnemyCells   ?? undefined,
      initialNeutralCells: this.rolledNeutralCells ?? undefined,
    });

    // Caption beneath the thumbnail.
    const footnoteY = thumbY + thumbH + 4;
    this.detRightContainer.add(
      this.add.text(thumbX + thumbW / 2, footnoteY, `${map.name}  ·  click to enlarge`, {
        fontSize: "10px", color: "#667788", fontFamily: "monospace", resolution: DPR,
      }).setOrigin(0.5, 0),
    );

    // Paint-mode buttons row.
    const paintLabelY = footnoteY + 18;
    this.detRightContainer.add(this.add.text(thumbX, paintLabelY, "STARTING ZONES", {
      fontSize: "10px", color: "#778899", fontFamily: "monospace", resolution: DPR, letterSpacing: 1,
    }).setOrigin(0, 0));
    const paintBtnY = paintLabelY + 28;
    this.zonePainter.buildPaintModeButtons(thumbX, paintBtnY, thumbW);

    // Story-field stack on the left column of the right panel:
    //   • TITLE (single-line; overrides the map name as encounterTitle)
    //   • INTRODUCTION (in-fiction opener shown in the event log)
    //   • DESCRIPTION (context the AIGM sees silently)
    //   • OBJECTIVE + COMPLETION FLAG side by side
    // Sizes are tight so the picker tab still fits below.
    const inputW = SIDE_PANEL_WIDTH - thumbW - 16;
    const introBoxH = 60;
    const descBoxH = 60;
    const oneLineH = 28;

    const titleY = CONTENT_TOP + 38;
    this.detRightContainer.add(this.makeSubLabel(RIGHT_PANEL_X, titleY, "TITLE"));
    this.detTitleInput = this.buildLineInput(
      RIGHT_PANEL_X, titleY + 22, inputW, oneLineH,
      "Encounter title (defaults to map name)",
      (val) => { this.detTitle = val; },
      this.detTitle,
    );

    const introY = titleY + 22 + oneLineH + 14;
    this.detRightContainer.add(this.makeSubLabel(RIGHT_PANEL_X, introY, "INTRODUCTION"));
    this.detIntroInput = this.buildTextarea(
      RIGHT_PANEL_X, introY + 22, inputW, introBoxH,
      "Optional opening narration shown to the player…",
      (val) => { this.detIntroduction = val; },
      this.detIntroduction,
    );

    const descY = introY + 22 + introBoxH + 14;
    this.detRightContainer.add(this.makeSubLabel(RIGHT_PANEL_X, descY, "DESCRIPTION"));
    this.detDescInput = this.buildTextarea(
      RIGHT_PANEL_X, descY + 22, inputW, descBoxH,
      "Optional scene context (the AIGM sees this silently)…",
      (val) => { this.detDescription = val; },
      this.detDescription,
    );

    const objFlagY = descY + 22 + descBoxH + 14;
    const halfW = Math.floor((inputW - 8) / 2);
    this.detRightContainer.add(this.makeSubLabel(RIGHT_PANEL_X, objFlagY, "OBJECTIVE"));
    this.detObjectiveInput = this.buildLineInput(
      RIGHT_PANEL_X, objFlagY + 22, halfW, oneLineH,
      "Player-facing one-liner",
      (val) => { this.detObjective = val; },
      this.detObjective,
    );
    this.detRightContainer.add(this.makeSubLabel(RIGHT_PANEL_X + halfW + 8, objFlagY, "COMPLETION FLAG"));
    this.detCompletionFlagInput = this.buildLineInput(
      RIGHT_PANEL_X + halfW + 8, objFlagY + 22, halfW, oneLineH,
      "snake_case slug",
      (val) => { this.detCompletionFlag = val; },
      this.detCompletionFlag,
    );

    // MONSTERS / TRIGGERS tab toggle just above the picker section. Both
    // pickers occupy the same vertical band — only one is visible at a time.
    const tabsY = Math.max(paintBtnY + 26, objFlagY + 22 + oneLineH + 12);
    this.buildPickerTabs(RIGHT_PANEL_X, tabsY, SIDE_PANEL_WIDTH);

    const pickerY = tabsY + 32;

    // MonsterPicker — full-width, occupies the remaining vertical space
    // beneath the picker tabs.
    const pickerHeight = (CONTENT_BOTTOM - 8) - pickerY;
    this.monsterSubContainer = this.add.container(0, 0);
    this.detRightContainer.add(this.monsterSubContainer);
    this.monsterPicker = new MonsterPicker({
      scene: this,
      parent: this.monsterSubContainer,
      monsters: this.monsters,
      x: RIGHT_PANEL_X,
      y: pickerY,
      width: SIDE_PANEL_WIDTH,
      height: pickerHeight,
      sceneWidth: W,
      initialAllyIds:    this.rolledAllyIds    ?? undefined,
      initialEnemyIds:   this.rolledEnemyIds   ?? undefined,
      initialNeutralIds: this.rolledNeutralIds ?? undefined,
    });

    // TriggerEditor — shares the same band.
    this.triggerSubContainer = this.add.container(0, 0);
    this.detRightContainer.add(this.triggerSubContainer);
    this.triggerEditor = new TriggerEditor({
      scene: this,
      parent: this.triggerSubContainer,
      x: RIGHT_PANEL_X,
      y: pickerY,
      width: SIDE_PANEL_WIDTH,
      height: pickerHeight,
      sceneWidth: W,
      mapW: map.width,
      mapH: map.height,
      initialTriggers: this.rolledTriggers ?? undefined,
      onChange: () => this.syncTriggerRegionsToPreview(),
    });

    // Reflect any pre-seeded trigger regions on the thumbnail immediately.
    this.syncTriggerRegionsToPreview();

    this.activatePickerTab(this.pickerTab);
  }

  /** Push the current TriggerEditor regions onto the zone painter thumbnail. */
  private syncTriggerRegionsToPreview(): void {
    if (!this.zonePainter || !this.triggerEditor) return;
    const triggers = this.triggerEditor.getTriggers();
    this.zonePainter.setTriggerRegions(triggers.map((t) => ({ id: t.id, kind: t.kind, region: t.region })));
  }

  private buildPickerTabs(x: number, y: number, totalW: number): void {
    const tabW = (totalW - 8) / 2;
    const tabH = 26;
    const mkTab = (cx: number, label: string, onClick: () => void): { bg: Phaser.GameObjects.Rectangle; lbl: Phaser.GameObjects.Text } => {
      const bg = this.add.rectangle(cx + tabW / 2, y, tabW, tabH, 0x1a1a2a).setStrokeStyle(1, 0x445566).setInteractive({ useHandCursor: true });
      const lbl = this.add.text(cx + tabW / 2, y, label, {
        fontSize: "11px", color: "#aabbcc", fontFamily: "monospace", resolution: DPR, letterSpacing: 1,
      }).setOrigin(0.5);
      bg.on("pointerdown", onClick);
      this.detRightContainer.add(bg);
      this.detRightContainer.add(lbl);
      return { bg, lbl };
    };
    const m = mkTab(x, "MONSTERS", () => this.activatePickerTab("monsters"));
    const t = mkTab(x + tabW + 8, "TRIGGERS", () => this.activatePickerTab("triggers"));
    this.monstersTabBg = m.bg; this.monstersTabLabel = m.lbl;
    this.triggersTabBg = t.bg; this.triggersTabLabel = t.lbl;
  }

  private activatePickerTab(tab: "monsters" | "triggers"): void {
    this.pickerTab = tab;
    const showMon = tab === "monsters";
    if (this.monsterSubContainer) this.monsterSubContainer.setVisible(showMon);
    if (this.triggerSubContainer) this.triggerSubContainer.setVisible(!showMon);
    if (this.monsterPicker) this.monsterPicker.setVisible(showMon);
    if (this.triggerEditor) this.triggerEditor.setVisible(!showMon);
    // Tab visual state — active tab is brighter.
    const paint = (bg: Phaser.GameObjects.Rectangle | null, lbl: Phaser.GameObjects.Text | null, active: boolean) => {
      if (!bg || !lbl) return;
      bg.setFillStyle(active ? 0x2a3a55 : 0x1a1a2a, 1).setStrokeStyle(2, active ? 0x5588aa : 0x445566);
      lbl.setColor(active ? "#cce4ff" : "#aabbcc");
    };
    paint(this.monstersTabBg, this.monstersTabLabel, showMon);
    paint(this.triggersTabBg, this.triggersTabLabel, !showMon);
  }

  /** Drop any pending RANDOMIZE seeds so the next right-panel rebuild starts blank. */
  private clearRolledState(): void {
    this.rolledPlayerCells = null;
    this.rolledEnemyCells = null;
    this.rolledNeutralCells = null;
    this.rolledAllyIds = null;
    this.rolledEnemyIds = null;
    this.rolledNeutralIds = null;
    this.rolledTriggers = null;
  }

  private openMapSelector(): void {
    if (this.mapSelector) return;
    const maps = (this.registry.get("maps") as SavedMapDef[] | undefined) ?? [];
    this.setDomChromeVisible(false);
    this.mapSelector = new MapSelectorOverlay(this, maps, {
      onSelect: (map) => {
        this.acceptedMap = map;
        this.previewedMap = null;
        // Picking a different map invalidates the previous roll's zones +
        // monster picks (they were sized for the rolled map).
        this.clearRolledState();
        this.closeMapSelector();
        this.rebuildDeterministicRight();
      },
      onClose: () => this.closeMapSelector(),
    });
  }

  private closeMapSelector(): void {
    if (this.mapSelector) { this.mapSelector.destroy(); this.mapSelector = null; }
    this.setDomChromeVisible(true);
  }

  private openLargePreview(): void {
    if (!this.acceptedMap || this.mapPreview || !this.zonePainter) return;
    this.setDomChromeVisible(false);
    const triggerRegions = (this.triggerEditor?.getTriggers() ?? []).map((t) => ({
      kind: t.kind, region: t.region,
    }));
    this.mapPreview = new MapPreviewOverlay(
      this,
      this.acceptedMap,
      { onClose: () => this.closeMapPreview() },
      { zones: {
          playerCells: this.zonePainter.getPlayerZones(),
          enemyCells: this.zonePainter.getEnemyZones(),
          neutralCells: this.zonePainter.getNeutralZones(),
          triggerRegions,
      } },
    );
  }

  // ── Generative AI panel ─────────────────────────────────────────────────

  private buildGenerativePanel(): void {
    this.genContainer.add(this.makeHeader(LEFT_PANEL_X + SIDE_PANEL_WIDTH / 2, CONTENT_TOP, "DESCRIBE THE SCENE"));
    this.genContainer.add(this.makeHeader(RIGHT_PANEL_X + SIDE_PANEL_WIDTH / 2, CONTENT_TOP, "EXAMPLE PROMPTS"));

    this.genContainer.add(this.makeBodyLine(LEFT_PANEL_X, CONTENT_TOP + 38,
      "Describe the scene you want to play. Click an example on the right to start from."));
    this.genPromptInput = this.buildTextarea(
      LEFT_PANEL_X, CONTENT_TOP + 78, SIDE_PANEL_WIDTH, 380,
      "A description of the scene…",
      () => { this.refreshButtons(); },
    );

    const cardW = SIDE_PANEL_WIDTH - 8;
    const cardH = 80;
    const startY = CONTENT_TOP + 50;
    PROMPT_EXAMPLES.forEach((ex, idx) => {
      const cy = startY + idx * (cardH + 8);
      const cardCx = RIGHT_PANEL_X + cardW / 2;
      const bg = this.add.rectangle(cardCx, cy + cardH / 2, cardW, cardH, 0x141426).setStrokeStyle(1, 0x334455).setInteractive({ useHandCursor: true });
      bg.on("pointerover", () => bg.setStrokeStyle(1, 0x2a6655));
      bg.on("pointerout",  () => bg.setStrokeStyle(1, 0x334455));
      bg.on("pointerdown", () => {
        if (this.genPromptInput) {
          this.genPromptInput.value = ex.body;
          this.genPromptInput.focus();
          this.refreshButtons();
        }
      });
      const title = this.add.text(RIGHT_PANEL_X + 12, cy + 10, ex.title, {
        fontSize: "13px", color: "#e2b96f", fontFamily: "monospace", resolution: DPR,
      }).setOrigin(0, 0);
      const body = this.add.text(RIGHT_PANEL_X + 12, cy + 32, ex.body, {
        fontSize: "10px", color: "#8899aa", fontFamily: "sans-serif", resolution: DPR,
        wordWrap: { width: cardW - 24 }, lineSpacing: 2,
      }).setOrigin(0, 0);
      this.genContainer.add(bg);
      this.genContainer.add(title);
      this.genContainer.add(body);
    });
  }

  // ── Reusable chip + helper builders ─────────────────────────────────────

  private makeHeader(cx: number, y: number, text: string): Phaser.GameObjects.Text {
    return this.add.text(cx, y, text, {
      fontSize: "11px", color: "#556677", fontFamily: "monospace", resolution: DPR, letterSpacing: 2,
    }).setOrigin(0.5, 0);
  }

  private makeSubLabel(x: number, y: number, text: string): Phaser.GameObjects.Text {
    return this.add.text(x, y, text, {
      fontSize: "10px", color: "#778899", fontFamily: "monospace", resolution: DPR, letterSpacing: 1,
    }).setOrigin(0, 0);
  }

  private makeBodyLine(x: number, y: number, text: string): Phaser.GameObjects.Text {
    return this.add.text(x, y, text, {
      fontSize: "11px", color: "#aabbcc", fontFamily: "sans-serif", resolution: DPR,
    }).setOrigin(0, 0);
  }

  private buildTerrainChip(t: Terrain, x: number, y: number): { bg: Phaser.GameObjects.Rectangle; label: Phaser.GameObjects.Text } {
    const w = 120, h = 26;
    const bg = this.add.rectangle(x + w / 2, y, w, h, 0x1a1a2a).setStrokeStyle(1, 0x445566).setInteractive({ useHandCursor: true });
    const label = this.add.text(x + w / 2, y, TERRAIN_LABEL[t], {
      fontSize: "10px", color: "#aabbcc", fontFamily: "monospace", resolution: DPR, letterSpacing: 1,
    }).setOrigin(0.5);
    this.terrainChips.set(t, bg);
    bg.on("pointerdown", () => {
      const wasSelected = this.selectedTerrain === t;
      this.selectedTerrain = wasSelected ? null : t;
      // Switching columns invalidates any features selected on the now-disabled
      // side, so clear them rather than carry phantom toggles. Dungeon features
      // are radio-like (only one of 3-room / 5-room), so we also enforce that
      // here when switching INTO the inside column.
      this.selectedFeatures.clear();
      this.refreshTerrainChips();
      this.refreshFeatureChips();
      this.refreshButtons();
    });
    this.refreshTerrainChips();
    return { bg, label };
  }

  private buildFeatureChip(f: Feature, x: number, y: number): { bg: Phaser.GameObjects.Rectangle; label: Phaser.GameObjects.Text } {
    const w = 120, h = 26;
    const bg = this.add.rectangle(x + w / 2, y, w, h, 0x1a1a2a).setStrokeStyle(1, 0x445566).setInteractive({ useHandCursor: true });
    const label = this.add.text(x + w / 2, y, FEATURE_LABEL[f], {
      fontSize: "10px", color: "#aabbcc", fontFamily: "monospace", resolution: DPR, letterSpacing: 1,
    }).setOrigin(0.5);
    this.featureChips.set(f, bg);
    bg.on("pointerdown", () => {
      // Disabled when the chip's column doesn't match the active terrain.
      if (!this.featureChipEnabled(f)) return;
      if (featureColumn(f) === "inside") {
        // Inside features are radio-like — only one room-count active.
        const wasOn = this.selectedFeatures.has(f);
        this.selectedFeatures.clear();
        if (!wasOn) this.selectedFeatures.add(f);
      } else {
        if (this.selectedFeatures.has(f)) this.selectedFeatures.delete(f);
        else this.selectedFeatures.add(f);
      }
      this.refreshFeatureChips();
      this.refreshButtons();
    });
    this.refreshFeatureChips();
    return { bg, label };
  }

  /** A feature chip is interactive only when its column matches the current terrain. */
  private featureChipEnabled(f: Feature): boolean {
    if (this.selectedTerrain === null) return false;
    return featureColumn(f) === terrainColumn(this.selectedTerrain);
  }

  private refreshTerrainChips(): void {
    for (const [t, bg] of this.terrainChips) {
      const on = this.selectedTerrain === t;
      bg.setFillStyle(on ? 0x2a8866 : 0x1a1a2a, on ? 0.4 : 1);
      bg.setStrokeStyle(2, on ? 0x2a8866 : 0x445566);
    }
  }

  private refreshFeatureChips(): void {
    for (const [f, bg] of this.featureChips) {
      const enabled = this.featureChipEnabled(f);
      const on = enabled && this.selectedFeatures.has(f);
      if (!enabled) {
        bg.setFillStyle(0x14141e, 1);
        bg.setStrokeStyle(1, 0x2a3340);
      } else {
        bg.setFillStyle(on ? 0xaa6633 : 0x1a1a2a, on ? 0.4 : 1);
        bg.setStrokeStyle(2, on ? 0xaa6633 : 0x445566);
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
    const el = document.createElement("textarea");
    el.placeholder = placeholder;
    if (initialValue) el.value = initialValue;
    el.style.cssText = `
      position: absolute;
      background: #141426;
      color: #e0e8f0;
      border: 1px solid #445566;
      padding: 10px 12px;
      font-family: monospace;
      font-size: 13px;
      line-height: 1.4;
      resize: none;
      z-index: 10;
      box-sizing: border-box;
    `;
    document.body.appendChild(el);
    const place = () => {
      const rect = this.sys.game.canvas.getBoundingClientRect();
      const s = rect.width / W;
      el.style.left = `${rect.left + x * s}px`;
      el.style.top  = `${rect.top + y * s}px`;
      el.style.width  = `${w * s}px`;
      el.style.height = `${h * s}px`;
      el.style.fontSize = `${13 * s}px`;
    };
    place();
    this.scale.on("resize", place);
    el.oninput = () => onInput(el.value);
    return el;
  }

  /** Single-line cousin of `buildTextarea` for short author-supplied strings (objective, completion flag). */
  private buildLineInput(
    x: number, y: number, w: number, h: number,
    placeholder: string,
    onInput: (value: string) => void,
    initialValue = "",
  ): HTMLInputElement {
    const el = document.createElement("input");
    el.type = "text";
    el.placeholder = placeholder;
    if (initialValue) el.value = initialValue;
    el.style.cssText = `
      position: absolute;
      background: #141426;
      color: #e0e8f0;
      border: 1px solid #445566;
      padding: 0 12px;
      font-family: monospace;
      font-size: 13px;
      z-index: 10;
      box-sizing: border-box;
    `;
    document.body.appendChild(el);
    const place = () => {
      const rect = this.sys.game.canvas.getBoundingClientRect();
      const s = rect.width / W;
      el.style.left = `${rect.left + x * s}px`;
      el.style.top  = `${rect.top + y * s}px`;
      el.style.width  = `${w * s}px`;
      el.style.height = `${h * s}px`;
      el.style.fontSize = `${13 * s}px`;
    };
    place();
    this.scale.on("resize", place);
    el.oninput = () => onInput(el.value);
    return el;
  }

  private buildStatusLine(): void {
    const status = document.createElement("div");
    status.style.cssText = `
      position: absolute;
      color: #889aac;
      font-family: monospace;
      font-size: 13px;
      pointer-events: none;
      z-index: 10;
    `;
    document.body.appendChild(status);
    this.statusEl = status;
    const place = () => {
      const rect = this.sys.game.canvas.getBoundingClientRect();
      const s = rect.width / W;
      status.style.left = `${rect.left + PANEL_PAD * s}px`;
      status.style.top  = `${rect.top + (CONTENT_BOTTOM - 8) * s}px`;
      status.style.fontSize = `${13 * s}px`;
    };
    place();
    this.scale.on("resize", place);
  }

  // ── Bottom bar (buttons) ────────────────────────────────────────────────

  private buildBottomBar(): void {
    this.add.rectangle(W / 2, H - 58, W - 64, 1, 0x334455);
    this.buildBackButton(120, H - 36);

    // Layout: BACK | RANDOMIZE | PICK MAP | COMPOSE MAP | COMPOSE ENCOUNTER.
    // Centers spaced so each adjacent pair has ~30px between edges; dev
    // button (added later) still has room at the right.
    const detRandCx = 360;
    const detPickCx = 580;
    const detMapCx  = 820;
    const detEncCx  = 1090;

    this.detRandomBg = this.add.rectangle(detRandCx, H - 36, 180, 44, 0x3a2a1a).setStrokeStyle(2, 0xaa7733);
    this.detRandomLabel = this.add.text(detRandCx, H - 36, "★ RANDOMIZE", {
      fontSize: "14px", color: "#ffd699", fontFamily: "monospace", resolution: DPR,
    }).setOrigin(0.5);
    this.detPickMapBg = this.add.rectangle(detPickCx, H - 36, 180, 44, 0x2a1a3a).setStrokeStyle(2, 0x5a4480);
    this.detPickMapLabel = this.add.text(detPickCx, H - 36, "PICK MAP", {
      fontSize: "14px", color: "#d8c8e8", fontFamily: "monospace", resolution: DPR,
    }).setOrigin(0.5);
    this.detComposeMapBg = this.add.rectangle(detMapCx, H - 36, 240, 44, 0x1a2a3a).setStrokeStyle(2, 0x345566);
    this.detComposeMapLabel = this.add.text(detMapCx, H - 36, "COMPOSE MAP", {
      fontSize: "14px", color: "#c8d8e8", fontFamily: "monospace", resolution: DPR,
    }).setOrigin(0.5);
    this.detComposeEncBg = this.add.rectangle(detEncCx, H - 36, 240, 44, 0x1a3a2a).setStrokeStyle(2, 0x2a6655);
    this.detComposeEncLabel = this.add.text(detEncCx, H - 36, "SAVE ENCOUNTER", {
      fontSize: "14px", color: "#ffe9a8", fontFamily: "monospace", resolution: DPR,
    }).setOrigin(0.5);
    this.detContainer.add(this.detRandomBg);
    this.detContainer.add(this.detRandomLabel);
    this.detContainer.add(this.detPickMapBg);
    this.detContainer.add(this.detPickMapLabel);
    this.detContainer.add(this.detComposeMapBg);
    this.detContainer.add(this.detComposeMapLabel);
    this.detContainer.add(this.detComposeEncBg);
    this.detContainer.add(this.detComposeEncLabel);

    const genMapCx = W / 2 - 160;
    const genEncCx = W / 2 + 160;
    this.genMapBg = this.add.rectangle(genMapCx, H - 36, 280, 44, 0x1a2a3a).setStrokeStyle(2, 0x345566);
    this.genMapLabel = this.add.text(genMapCx, H - 36, "GENERATE MAP ONLY", {
      fontSize: "14px", color: "#c8d8e8", fontFamily: "monospace", resolution: DPR,
    }).setOrigin(0.5);
    this.genEncBg = this.add.rectangle(genEncCx, H - 36, 280, 44, 0x1a3a2a).setStrokeStyle(2, 0x2a6655);
    this.genEncLabel = this.add.text(genEncCx, H - 36, "GENERATE ENCOUNTER", {
      fontSize: "14px", color: "#ffe9a8", fontFamily: "monospace", resolution: DPR,
    }).setOrigin(0.5);
    this.genContainer.add(this.genMapBg);
    this.genContainer.add(this.genMapLabel);
    this.genContainer.add(this.genEncBg);
    this.genContainer.add(this.genEncLabel);
  }

  private buildBackButton(cx: number, cy: number): void {
    const bg = this.add.rectangle(cx, cy, 160, 36, 0x222233).setStrokeStyle(1, 0x556677).setInteractive({ useHandCursor: true });
    this.add.text(cx, cy, "BACK", { fontSize: "13px", color: "#aabbcc", fontFamily: "monospace", resolution: DPR }).setOrigin(0.5);
    bg.on("pointerdown", () => this.scene.start("MainMenuScene"));
  }

  // ── Dev button: delete all generated maps ───────────────────────────────

  private buildDevButton(): void {
    const cx = W - 200;
    const cy = H - 36;
    const bg = this.add.rectangle(cx, cy, 220, 28, 0x2a1818).setStrokeStyle(1, 0x663333).setInteractive({ useHandCursor: true });
    const label = this.add.text(cx, cy, "DEV: DELETE ALL GEN MAPS", {
      fontSize: "10px", color: "#cc8888", fontFamily: "monospace", resolution: DPR, letterSpacing: 1,
    }).setOrigin(0.5);
    bg.on("pointerdown", async () => {
      if (this.busy) return;
      this.busy = true;
      label.setText("DELETING…");
      try {
        const { mapsDeleted, encountersDeleted } = await gameClient.deleteAllGeneratedMaps();
        if (this.statusEl) this.statusEl.textContent = `Deleted ${mapsDeleted} maps and ${encountersDeleted} encounters.`;
        if (this.acceptedMap) {
          this.acceptedMap = null;
          this.rebuildDeterministicRight();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (this.statusEl) this.statusEl.textContent = `Delete failed: ${msg}`;
      } finally {
        label.setText("DEV: DELETE ALL GEN MAPS");
        this.busy = false;
        this.refreshButtons();
      }
    });
  }

  // ── Button state ────────────────────────────────────────────────────────

  private refreshButtons(): void {
    const det = this.tab === "deterministic";

    if (det) {
      const randomReady = !this.busy;
      this.setButton(
        this.detRandomBg, this.detRandomLabel,
        randomReady, "#ffd699", 0x3a2a1a, 0xaa7733,
        () => this.runRandomizeEncounter(),
        randomReady ? null : "Busy…",
      );

      const pickReady = !this.busy;
      this.setButton(
        this.detPickMapBg, this.detPickMapLabel,
        pickReady, "#d8c8e8", 0x2a1a3a, 0x5a4480,
        () => this.openMapSelector(),
        pickReady ? null : "Busy…",
      );

      const composeMapReady = !this.busy && this.selectedTerrain !== null;
      this.setButton(
        this.detComposeMapBg, this.detComposeMapLabel,
        composeMapReady, "#c8d8e8", 0x1a2a3a, 0x345566,
        () => this.runComposeMap(),
        composeMapReady ? null : (this.busy ? "Busy…" : "Select a terrain first (Grassland or Forest)."),
      );

      // SAVE ENCOUNTER requires an accepted map AND at least one player-start cell.
      let encGuard: string | null = null;
      if (this.busy) encGuard = "Busy…";
      else if (!this.acceptedMap) encGuard = "Compose a map and press SAVE in the preview first.";
      else if (!this.zonePainter || this.zonePainter.getPlayerZones().size === 0) encGuard = "Paint at least one player-start cell on the thumbnail (PAINT: PLAYER).";
      const composeEncReady = encGuard === null;
      this.setButton(
        this.detComposeEncBg, this.detComposeEncLabel,
        composeEncReady, "#ffe9a8", 0x1a3a2a, 0x2a6655,
        () => this.runComposeEncounter(),
        encGuard,
      );
    } else {
      const hasPrompt = !!this.genPromptInput && this.genPromptInput.value.trim().length >= 8;
      const ready = !this.busy && hasPrompt;
      const guard = this.busy ? "Busy…" : (hasPrompt ? null : "Type a scene description (at least 8 characters), or click an example card on the right.");
      this.setButton(
        this.genMapBg, this.genMapLabel, ready, "#c8d8e8", 0x1a2a3a, 0x345566,
        () => this.runGenerateMap(), guard,
      );
      this.setButton(
        this.genEncBg, this.genEncLabel, ready, "#ffe9a8", 0x1a3a2a, 0x2a6655,
        () => this.runGenerateEncounter(), guard,
      );
    }
  }

  /**
   * Wire a button's visual state and click behaviour. The button is ALWAYS
   * interactive — when not "ready" it stays clickable but the pointerdown
   * handler surfaces `guardMessage` in the status line instead of doing
   * nothing, so the player can see why the button isn't proceeding.
   */
  private setButton(
    bg: Phaser.GameObjects.Rectangle,
    label: Phaser.GameObjects.Text,
    ready: boolean,
    activeColor: string,
    activeFill: number,
    activeStroke: number,
    onClick: () => void,
    guardMessage: string | null,
  ): void {
    bg.setInteractive({ useHandCursor: true });
    bg.removeAllListeners("pointerdown");
    if (ready) {
      bg.setFillStyle(activeFill).setStrokeStyle(2, activeStroke);
      label.setColor(activeColor);
      bg.on("pointerdown", onClick);
    } else {
      bg.setFillStyle(0x1a2222).setStrokeStyle(2, 0x334455);
      label.setColor("#556677");
      bg.on("pointerdown", () => {
        if (this.statusEl && guardMessage) this.statusEl.textContent = guardMessage;
      });
    }
  }

  // ── Generation flows ────────────────────────────────────────────────────

  private async runComposeMap(): Promise<void> {
    if (!this.selectedTerrain) return;
    this.busy = true;
    this.refreshButtons();
    if (this.statusEl) this.statusEl.textContent = "Composing map…";
    try {
      const data = await gameClient.composeMap({
        terrain: this.selectedTerrain,
        features: Array.from(this.selectedFeatures),
      });
      if (this.statusEl) this.statusEl.textContent = "";
      this.previewedMap = data as MapPreviewData;
      this.openOrUpdatePreview(this.previewedMap, true);
    } catch (err) {
      this.handleError(err, "Compose map");
    } finally {
      this.busy = false;
      this.refreshButtons();
    }
  }

  private async runComposeEncounter(): Promise<void> {
    if (!this.acceptedMap || !this.zonePainter) return;
    const playerCells = this.zonePainter.getPlayerZones();
    if (playerCells.size === 0) return;
    this.busy = true;
    this.refreshButtons();
    if (this.statusEl) this.statusEl.textContent = "Composing encounter…";

    try {
      // If the map hasn't been persisted yet (RANDOMIZE leaves it in memory
      // only), save it now so the encounter has a stable `existingMapId` to
      // reference. Explicit COMPOSE MAP → SAVE-in-preview takes the same
      // code path; the second save is skipped because `mapId` is already set.
      let map = this.acceptedMap;
      if (!map.mapId) {
        const { mapId } = await gameClient.saveMap({
          name: map.name,
          description: map.description,
          width: map.width,
          height: map.height,
          terrainData: map.terrainData,
          objectData: map.objectData,
          tilesets: map.tilesets,
        });
        map = { ...map, mapId };
        this.acceptedMap = map;
      }
      const startingZonesData = new Array<number>(map.width * map.height).fill(0);
      for (const key of playerCells) {
        const [x, y] = key.split(",").map(Number);
        startingZonesData[y * map.width + x] = STARTING_ZONE_PLAYER;
      }
      for (const key of this.zonePainter.getEnemyZones()) {
        const [x, y] = key.split(",").map(Number);
        startingZonesData[y * map.width + x] = STARTING_ZONE_ENEMY;
      }
      for (const key of this.zonePainter.getNeutralZones()) {
        const [x, y] = key.split(",").map(Number);
        startingZonesData[y * map.width + x] = STARTING_ZONE_NEUTRAL;
      }
      const result = await gameClient.composeEncounter({
        existingMapId: map.mapId ?? undefined,
        description: this.detDescription,
        startingZonesData,
        allyIds: this.monsterPicker?.getAllyIds() ?? [],
        enemyIds: this.monsterPicker?.getEnemyIds() ?? [],
        neutralIds: this.monsterPicker?.getNeutralIds() ?? [],
        customTitle: this.detTitle,
        customIntroduction: this.detIntroduction,
        customObjective: this.detObjective,
        completionFlag: this.detCompletionFlag,
        triggers: this.triggerEditor?.getTriggers() ?? [],
      });
      if (this.statusEl) this.statusEl.textContent = `Composed ${result.encounterId} — pick a character to begin.`;
      this.scene.start("EncounterSetupScene", { presetEncounterId: result.encounterId });
    } catch (err) {
      this.handleError(err, "Compose encounter");
      this.busy = false;
      this.refreshButtons();
    }
  }

  /**
   * Roll a random archetype and populate every Adjudicator-tab field so the
   * user can inspect and edit before committing. Composes + saves the map (the
   * encounter builder needs a saved map to reference), but does NOT persist
   * the encounter — that's the SAVE ENCOUNTER button's job. Picker and painter
   * are seeded via scene-level `rolled*` fields and a right-panel rebuild.
   */
  private async runRandomizeEncounter(): Promise<void> {
    this.busy = true;
    this.refreshButtons();
    if (this.statusEl) this.statusEl.textContent = "Rolling a random encounter…";

    try {
      const archetype = pickArchetype(ENCOUNTER_ARCHETYPES);
      const rolled = rollArchetype(archetype);

      // Reflect the rolled terrain / features in the left-panel chips so the
      // user can see what the archetype chose and tweak before regenerating.
      this.selectedTerrain = archetype.terrain;
      this.selectedFeatures = new Set(rolled.features);
      this.refreshTerrainChips();
      this.refreshFeatureChips();

      if (this.statusEl) this.statusEl.textContent = `Composing "${rolled.title}"…`;
      const composed = await gameClient.composeMap({
        terrain: archetype.terrain,
        features: rolled.features,
      });

      // The rolled map is held in memory only — `runComposeEncounter`
      // persists it on the user's behalf when SAVE ENCOUNTER is clicked. The
      // user may also explicitly persist it earlier via the COMPOSE MAP
      // preview's SAVE button.
      this.acceptedMap = { ...composed, mapId: null } as MapPreviewData;
      this.previewedMap = null;

      // Anchor-driven placement against the composed map: player at the
      // archetype's `playerAnchors` (entrance, path endpoint, …), hostile-
      // intent monsters at `enemyAnchors` (vault, campfire, ruin).
      // `buildStartingZonesFromAnchors` paints the would-be enemy cells as
      // NEUTRAL so the encounter starts in exploration phase — rolled
      // monsters spawn neutral and a combat trigger (or the player
      // attacking) escalates to combat.
      const zoneArray = buildStartingZonesFromAnchors(
        composed.width, composed.height,
        composed.anchors,
        archetype.playerAnchors,
        archetype.enemyAnchors,
      );
      const playerCells = new Set<string>();
      const neutralCells = new Set<string>();
      for (let y = 0; y < composed.height; y++) {
        for (let x = 0; x < composed.width; x++) {
          const v = zoneArray[y * composed.width + x];
          if (v === STARTING_ZONE_PLAYER) playerCells.add(`${x},${y}`);
          else if (v === STARTING_ZONE_NEUTRAL) neutralCells.add(`${x},${y}`);
        }
      }

      // Roll triggers from the archetype's templates against the same anchors
      // used for spawn placement, so the trigger regions land at story-
      // relevant tiles (perception checks at the path's edge, AIDM cues at
      // the vault door, etc.). Combat triggers receive the deduped list of
      // every rolled hostile-intent monster so they can flip them all when
      // the player crosses the region.
      const rolledTriggers = rollTriggersFromAnchors(
        composed.width, composed.height,
        composed.anchors,
        archetype.triggerTemplates,
        rolled.enemyIds,
      );

      // Stash rolled values + zones so the right-panel rebuild seeds inputs,
      // monster picker, zone painter, and trigger editor from the rolled state.
      this.detTitle = rolled.title;
      this.detIntroduction = rolled.introduction;
      this.detDescription = rolled.description;
      this.detObjective = rolled.objective;
      this.detCompletionFlag = rolled.completionFlag ?? "";
      this.rolledPlayerCells  = playerCells;
      this.rolledEnemyCells   = new Set<string>();
      this.rolledNeutralCells = neutralCells;
      this.rolledAllyIds      = rolled.allyIds;
      this.rolledEnemyIds     = [];
      // Rolled hostile-intent creatures spawn neutral. A combat trigger flips
      // them on demand; failing that, attacking one wakes the rest via faction
      // aggro. This keeps the encounter in exploration phase at session start.
      this.rolledNeutralIds   = rolled.enemyIds;
      this.rolledTriggers     = rolledTriggers;

      this.rebuildDeterministicRight();

      if (this.statusEl) {
        this.statusEl.textContent = `Rolled "${rolled.title}" (${archetype.name}). Inspect or edit, then press SAVE ENCOUNTER.`;
      }
    } catch (err) {
      this.handleError(err, "Randomize");
    } finally {
      this.busy = false;
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
    try {
      const data = await gameClient.generateMap(prompt);
      if (this.statusEl) this.statusEl.textContent = "";
      this.openOrUpdatePreview(data as MapPreviewData, false);
    } catch (err) {
      this.handleError(err, "Map generate");
    } finally {
      this.busy = false;
      this.refreshButtons();
    }
  }

  private async runGenerateEncounter(): Promise<void> {
    if (!this.genPromptInput) return;
    const prompt = this.genPromptInput.value.trim();
    if (prompt.length < 8) return;
    this.busy = true;
    this.refreshButtons();
    if (this.statusEl) this.statusEl.textContent = "The Game Master is building your encounter… (10–30 seconds)";
    try {
      const { encounterId } = await gameClient.generateEncounter({ prompt });
      if (this.statusEl) this.statusEl.textContent = "Loading the new scenario…";
      this.scene.start("EncounterSetupScene", { presetEncounterId: encounterId });
    } catch (err) {
      this.handleError(err, "Generate");
      this.busy = false;
      this.refreshButtons();
    }
  }

  /**
   * Open the preview overlay if not already open, otherwise refresh its
   * content. `allowSave` controls whether the SAVE button is shown — the
   * deterministic flow needs it (so the player can persist a map and unlock
   * the encounter-builder right panel); the AI map-only iteration flow does
   * not.
   */
  private openOrUpdatePreview(data: MapPreviewData, allowSave: boolean): void {
    if (this.mapPreview) {
      this.mapPreview.update(data);
      this.mapPreview.setBusy(false);
    } else {
      this.setDomChromeVisible(false);
      this.mapPreview = new MapPreviewOverlay(this, data, {
        onRegenerate: () => this.regeneratePreview(),
        onClose: () => this.closeMapPreview(),
        onSave: allowSave ? () => this.saveCurrentMap() : undefined,
      });
    }
  }

  /**
   * Persist the current preview to disk. After a successful save the SAVE
   * button locks into "✓ SAVED" (regenerating reactivates it), the encounter
   * builder gains access to the saved map, and the status line confirms the
   * new id. The preview stays open so the user can SAVE → regenerate →
   * SAVE again without rebuilding their selections.
   */
  private async saveCurrentMap(): Promise<void> {
    if (!this.previewedMap || !this.mapPreview) return;
    const data = this.previewedMap;
    this.busy = true;
    this.refreshButtons();
    if (this.statusEl) this.statusEl.textContent = "Saving map…";
    try {
      const { mapId } = await gameClient.saveMap({
        name: data.name,
        description: data.description,
        width: data.width,
        height: data.height,
        terrainData: data.terrainData,
        objectData: data.objectData,
        tilesets: data.tilesets,
      });
      // Record the persisted id on the preview so the encounter builder can
      // reference it, then lock the SAVE button into its disabled state. We
      // intentionally do NOT rebuild the right panel here — the rebuild
      // creates a fresh description textarea (HTML DOM element) which would
      // float over the preview canvas. Defer it to `closeMapPreview` via the
      // `rightPanelDirty` flag.
      const savedData: MapPreviewData = { ...data, mapId };
      this.previewedMap = savedData;
      this.acceptedMap = savedData;
      this.rightPanelDirty = true;
      this.mapPreview.markSaved(mapId);
      if (this.statusEl) this.statusEl.textContent = `Saved ${mapId}. Close the preview to place zones, or REGENERATE to try a different layout.`;
    } catch (err) {
      this.handleError(err, "Save map");
    } finally {
      this.busy = false;
      this.refreshButtons();
    }
  }

  private async regeneratePreview(): Promise<void> {
    if (!this.mapPreview) return;
    this.mapPreview.setBusy(true);
    this.busy = true;
    this.refreshButtons();
    try {
      const data = this.tab === "deterministic"
        ? await gameClient.composeMap({
            terrain: this.selectedTerrain!,
            features: Array.from(this.selectedFeatures),
          })
        : await gameClient.generateMap(this.genPromptInput?.value.trim() ?? '');
      const next = data as MapPreviewData;
      this.previewedMap = next;
      this.mapPreview.update(next);
    } catch (err) {
      this.handleError(err, "Regenerate");
    } finally {
      if (this.mapPreview) this.mapPreview.setBusy(false);
      this.busy = false;
      this.refreshButtons();
    }
  }

  private closeMapPreview(): void {
    if (this.mapPreview) { this.mapPreview.destroy(); this.mapPreview = null; }
    this.previewedMap = null;
    // If the user saved a new map during this preview, rebuild the right
    // panel now (deferred from `saveCurrentMap` so the description textarea
    // doesn't pop over the open preview).
    if (this.rightPanelDirty) {
      this.rightPanelDirty = false;
      this.rebuildDeterministicRight();
    }
    this.setDomChromeVisible(true);
  }

  private handleError(err: unknown, label: string): void {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${label} failed:`, msg);
    if (this.statusEl) this.statusEl.textContent = `${label} failed: ${msg}`;
    if (this.mapPreview) this.mapPreview.setBusy(false);
  }

  // ── DOM visibility ──────────────────────────────────────────────────────

  private setDomVisibility(): void {
    const det = this.tab === "deterministic";
    const detInputs = [this.detTitleInput, this.detDescInput, this.detIntroInput, this.detObjectiveInput, this.detCompletionFlagInput];
    for (const el of detInputs) if (el) el.style.display = det ? "" : "none";
    if (this.genPromptInput) this.genPromptInput.style.display = !det ? "" : "none";
    // The sub-components (TriggerEditor, MonsterPicker) own absolutely-
    // positioned DOM nodes; Phaser container visibility doesn't reach them,
    // so toggle them explicitly. When det is true the picker sub-tab logic
    // takes over via activatePickerTab.
    if (!det) {
      if (this.triggerEditor) this.triggerEditor.setVisible(false);
      if (this.monsterPicker) this.monsterPicker.setVisible(false);
    } else {
      this.activatePickerTab(this.pickerTab);
    }
  }

  private setDomChromeVisible(visible: boolean): void {
    if (!visible) {
      const detInputs = [this.detTitleInput, this.detDescInput, this.detIntroInput, this.detObjectiveInput, this.detCompletionFlagInput];
      for (const el of detInputs) if (el) el.style.display = "none";
      if (this.genPromptInput) this.genPromptInput.style.display = "none";
      if (this.statusEl)       this.statusEl.style.display       = "none";
      if (this.triggerEditor)  this.triggerEditor.setVisible(false);
      if (this.monsterPicker)  this.monsterPicker.setVisible(false);
    } else {
      this.setDomVisibility();
      if (this.statusEl) this.statusEl.style.display = "";
    }
  }

  private teardownDom(): void {
    if (this.detTitleInput)          { this.detTitleInput.remove();          this.detTitleInput          = null; }
    if (this.detDescInput)           { this.detDescInput.remove();           this.detDescInput           = null; }
    if (this.detIntroInput)          { this.detIntroInput.remove();          this.detIntroInput          = null; }
    if (this.detObjectiveInput)      { this.detObjectiveInput.remove();      this.detObjectiveInput      = null; }
    if (this.detCompletionFlagInput) { this.detCompletionFlagInput.remove(); this.detCompletionFlagInput = null; }
    if (this.genPromptInput)         { this.genPromptInput.remove();         this.genPromptInput         = null; }
    if (this.statusEl)               { this.statusEl.remove();               this.statusEl               = null; }
    if (this.mapPreview)             { this.mapPreview.destroy();            this.mapPreview             = null; }
    if (this.mapSelector)            { this.mapSelector.destroy();           this.mapSelector            = null; }
    // ZonePainter + MonsterPicker + TriggerEditor all own their own DOM
    // elements (paint buttons, monster list, trigger rows). Without this,
    // those DOM nodes stay parented to document.body after the scene unloads
    // and leak visibly across navigations.
    if (this.zonePainter)            { this.zonePainter.destroy();           this.zonePainter            = null; }
    if (this.triggerEditor)          { this.triggerEditor.destroy();         this.triggerEditor          = null; }
    if (this.monsterPicker)          { this.monsterPicker.destroy();         this.monsterPicker          = null; }
  }
}

function pickTilesetKey(scene: Phaser.Scene): string {
  const maps = (scene.registry.get("maps") as SavedMapDef[] | undefined) ?? [];
  for (const m of maps) {
    const url = m.tilesets?.[0]?.imageUrl;
    if (url) return tilesetTextureKey(url);
  }
  return tilesetTextureKey("/tilesets/scribble.png");
}
