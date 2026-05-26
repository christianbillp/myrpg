import Phaser from "phaser";
import { gameClient } from "../net/GameClient";
import type { EncounterType } from "../net/types";
import type { MonsterDef } from "../data/monsters";
import { MapPreviewOverlay, MapPreviewData } from "../ui/MapPreviewOverlay";
import { DevMode } from "../devMode";
import { tilesetTextureKey } from "./BootScene";
import type { SavedMapDef } from "../net/types";
import { decodeTileGid, TILE_VOID_GID } from "../../../shared/tileGid";
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
type PaintMode = "player" | "enemy" | null;

const ALL_TYPES: EncounterType[] = ["simple_combat", "social_interaction", "exploration"];
const TYPE_LABEL: Record<EncounterType, string> = {
  simple_combat: "COMBAT",
  social_interaction: "SOCIAL",
  exploration: "EXPLORATION",
};
const TYPE_COLOR: Record<EncounterType, number> = {
  simple_combat: 0xaa3333,
  social_interaction: 0x3366aa,
  exploration: 0x2a8866,
};

type Terrain = "grassland" | "forest";
type Feature = "ruins" | "buildings" | "campsites" | "path";
const ALL_TERRAINS: Terrain[] = ["grassland", "forest"];
const TERRAIN_LABEL: Record<Terrain, string> = { grassland: "GRASSLAND", forest: "FOREST" };
const ALL_FEATURES: Feature[] = ["ruins", "buildings", "campsites", "path"];
const FEATURE_LABEL: Record<Feature, string> = {
  ruins: "RUINS", buildings: "BUILDINGS", campsites: "CAMPSITES", path: "PATH",
};

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
 *    accepted map: until the user presses ACCEPT on a map preview, the
 *    right side only shows "No map available". Once a map has been
 *    accepted, the right panel exposes a thumbnail of the map (also serves
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

  // Deterministic — right (encounter-builder) state
  private acceptedMap: MapPreviewData | null = null;
  private detSelectedTypes: Set<EncounterType> = new Set();
  private detDescription = "";
  private detDescInput: HTMLTextAreaElement | null = null;
  private detTypeChips: Map<EncounterType, Phaser.GameObjects.Rectangle> = new Map();
  private paintMode: PaintMode = null;
  private playerZoneCells: Set<string> = new Set();
  private enemyZoneCells: Set<string> = new Set();
  private allySelections: Map<string, number> = new Map();
  private enemySelections: Map<string, number> = new Map();
  private zoneOverlayCells: Map<string, Phaser.GameObjects.Rectangle> = new Map();
  private paintModePlayerBg: Phaser.GameObjects.Rectangle | null = null;
  private paintModeEnemyBg: Phaser.GameObjects.Rectangle | null = null;
  private paintModePlayerLabel: Phaser.GameObjects.Text | null = null;
  private paintModeEnemyLabel: Phaser.GameObjects.Text | null = null;
  private allyListText: Phaser.GameObjects.Text | null = null;
  private enemyListText: Phaser.GameObjects.Text | null = null;
  private monsterScrollContainer: Phaser.GameObjects.Container | null = null;
  private monsterScrollOffset = 0;
  private detComposeMapBg!: Phaser.GameObjects.Rectangle;
  private detComposeMapLabel!: Phaser.GameObjects.Text;
  private detComposeEncBg!: Phaser.GameObjects.Rectangle;
  private detComposeEncLabel!: Phaser.GameObjects.Text;

  // Generative AI tab state
  private genSelectedTypes: Set<EncounterType> = new Set();
  private genPromptInput: HTMLTextAreaElement | null = null;
  private genTypeChips: Map<EncounterType, Phaser.GameObjects.Rectangle> = new Map();
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
    this.detSelectedTypes.clear();
    this.detDescription = "";
    this.genSelectedTypes.clear();
    this.terrainChips.clear();
    this.featureChips.clear();
    this.detTypeChips.clear();
    this.genTypeChips.clear();
    this.acceptedMap = null;
    this.paintMode = null;
    this.playerZoneCells.clear();
    this.enemyZoneCells.clear();
    this.allySelections.clear();
    this.enemySelections.clear();
    this.zoneOverlayCells.clear();
    this.monsterScrollOffset = 0;
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

    const terrainY = CONTENT_TOP + 38;
    this.detContainer.add(this.makeSubLabel(LEFT_PANEL_X, terrainY, "TERRAIN"));
    let tcx = LEFT_PANEL_X;
    for (const t of ALL_TERRAINS) {
      const chip = this.buildTerrainChip(t, tcx, terrainY + 28);
      this.detContainer.add(chip.bg);
      this.detContainer.add(chip.label);
      tcx += 150;
    }

    const featuresY = terrainY + 78;
    this.detContainer.add(this.makeSubLabel(LEFT_PANEL_X, featuresY, "FEATURES"));
    let fcx = LEFT_PANEL_X;
    let fcy = featuresY + 28;
    let i = 0;
    for (const f of ALL_FEATURES) {
      const chip = this.buildFeatureChip(f, fcx, fcy);
      this.detContainer.add(chip.bg);
      this.detContainer.add(chip.label);
      fcx += 150;
      i++;
      if (i % 3 === 0) { fcx = LEFT_PANEL_X; fcy += 36; }
    }
  }

  // ── Deterministic RIGHT panel — rebuilt on accept / clear ──────────────

  private rebuildDeterministicRight(): void {
    this.detRightContainer.removeAll(true);
    this.detTypeChips.clear();
    this.zoneOverlayCells.clear();
    this.paintModePlayerBg = null;
    this.paintModeEnemyBg = null;
    this.paintModePlayerLabel = null;
    this.paintModeEnemyLabel = null;
    this.allyListText = null;
    this.enemyListText = null;
    this.monsterScrollContainer = null;

    // Hide the description textarea while the right panel is in its empty
    // state — the textarea is recreated when the map is accepted.
    if (this.detDescInput) {
      this.detDescInput.remove();
      this.detDescInput = null;
    }

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
      this.add.text(cx, cy + 24, "Compose a map on the left, then press ACCEPT in the preview.", {
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
    this.buildThumbnail(thumbX, thumbY, thumbW, thumbH, tileSize, map);

    // Footnote (small caption) immediately under the thumbnail. Single line.
    const footnoteY = thumbY + thumbH + 4;
    this.detRightContainer.add(
      this.add.text(thumbX + thumbW / 2, footnoteY, `${map.name}  ·  click to enlarge`, {
        fontSize: "10px", color: "#667788", fontFamily: "monospace", resolution: DPR,
      }).setOrigin(0.5, 0),
    );

    // Paint mode + clear, in their own row clear of the footnote.
    const paintLabelY = footnoteY + 18;
    this.detRightContainer.add(this.add.text(thumbX, paintLabelY, "STARTING ZONES", {
      fontSize: "10px", color: "#778899", fontFamily: "monospace", resolution: DPR, letterSpacing: 1,
    }).setOrigin(0, 0));
    const paintBtnY = paintLabelY + 28;
    this.buildPaintModeButtons(thumbX, paintBtnY, thumbW);

    // Encounter types — to the left of the thumbnail, near the top.
    const typesY = CONTENT_TOP + 38;
    this.detRightContainer.add(this.makeSubLabel(RIGHT_PANEL_X, typesY, "ENCOUNTER TYPES"));
    let dcx = RIGHT_PANEL_X;
    for (const t of ALL_TYPES) {
      const chip = this.buildEncounterTypeChip(t, dcx, typesY + 28, this.detSelectedTypes, this.detTypeChips);
      this.detRightContainer.add(chip.bg);
      this.detRightContainer.add(chip.label);
      dcx += 130;
    }

    // Description textarea — under the encounter types.
    const descY = typesY + 70;
    this.detRightContainer.add(this.makeSubLabel(RIGHT_PANEL_X, descY, "DESCRIPTION"));
    const descW = SIDE_PANEL_WIDTH - thumbW - 16;
    this.detDescInput = this.buildTextarea(
      RIGHT_PANEL_X, descY + 22, descW, 110,
      "Optional scene context for the in-game DM…",
      (val) => { this.detDescription = val; },
    );

    // Monster picker — full-width, below whichever right-side column ends
    // lower (paint buttons or description textarea).
    const monsterY = Math.max(paintBtnY + 26, descY + 22 + 110 + 16);
    this.buildMonsterPicker(RIGHT_PANEL_X, monsterY);
  }

  // ── Thumbnail + zone painter ────────────────────────────────────────────

  private buildThumbnail(x: number, y: number, w: number, h: number, tileSize: number, map: MapPreviewData): void {
    // Backing rectangle.
    this.detRightContainer.add(this.add.rectangle(x + w / 2, y + h / 2, w + 4, h + 4, 0x0a0e16).setStrokeStyle(1, 0x334455));

    const tilesetKey = pickTilesetKey(this);
    const hasTexture = this.scene && this.scene.systems.textures.exists(tilesetKey);
    const FIRSTGID = 1;

    // Draw all map tiles.
    for (let ty = 0; ty < map.height; ty++) {
      for (let tx = 0; tx < map.width; tx++) {
        const px = x + tx * tileSize + tileSize / 2;
        const py = y + ty * tileSize + tileSize / 2;
        const i = ty * map.width + tx;

        const groundGid = map.terrainData[i];
        if (hasTexture && groundGid > 0) {
          this.drawThumbTile(px, py, tileSize, groundGid, FIRSTGID, tilesetKey);
        } else {
          this.detRightContainer.add(this.add.rectangle(px, py, tileSize, tileSize, 0x556677));
        }
        const objectGid = map.objectData[i];
        if (hasTexture && objectGid > 0) {
          this.drawThumbTile(px, py, tileSize, objectGid, FIRSTGID, tilesetKey);
        }
      }
    }

    // Zone overlay cells (transparent rects drawn on top, recoloured by state).
    for (let ty = 0; ty < map.height; ty++) {
      for (let tx = 0; tx < map.width; tx++) {
        const px = x + tx * tileSize + tileSize / 2;
        const py = y + ty * tileSize + tileSize / 2;
        const key = `${tx},${ty}`;
        const cell = this.add.rectangle(px, py, tileSize, tileSize, 0x000000, 0)
          .setStrokeStyle(0)
          .setInteractive({ useHandCursor: true });
        this.zoneOverlayCells.set(key, cell);
        this.refreshZoneOverlay(key);
        // Click behaviour depends on paint mode: paint when a mode is active,
        // otherwise open the large preview overlay so the player can inspect
        // the map at a higher zoom with zones drawn on top.
        cell.on("pointerdown", () => {
          if (this.paintMode) this.paintCell(tx, ty);
          else this.openLargePreview();
        });
        cell.on("pointerover", (pointer: Phaser.Input.Pointer) => {
          if (this.paintMode && pointer.isDown) this.paintCell(tx, ty);
        });
        this.detRightContainer.add(cell);
      }
    }

    // (Footnote caption lives in buildFilledRightPanel so it can include
    // the "click to enlarge" hint and sits in the parent's layout flow.)
  }

  private openLargePreview(): void {
    if (!this.acceptedMap || this.mapPreview) return;
    this.setDomChromeVisible(false);
    this.mapPreview = new MapPreviewOverlay(
      this,
      this.acceptedMap,
      { onClose: () => this.closeMapPreview() },
      { zones: { playerCells: this.playerZoneCells, enemyCells: this.enemyZoneCells } },
    );
  }

  private drawThumbTile(px: number, py: number, sz: number, rawGid: number, firstGid: number, tilesetKey: string): void {
    const dec = decodeTileGid(rawGid);
    if (dec.gid === TILE_VOID_GID) {
      this.detRightContainer.add(this.add.rectangle(px, py, sz, sz, 0x000000));
      return;
    }
    const img = this.add.image(px, py, tilesetKey, dec.gid - firstGid).setDisplaySize(sz, sz);
    if (dec.angle !== 0) img.setAngle(dec.angle);
    if (dec.flipX) img.setFlipX(true);
    if (dec.flipY) img.setFlipY(true);
    this.detRightContainer.add(img);
  }

  private paintCell(x: number, y: number): void {
    if (!this.paintMode) return;
    const key = `${x},${y}`;
    if (this.paintMode === "player") {
      if (this.playerZoneCells.has(key)) {
        this.playerZoneCells.delete(key);
      } else {
        this.playerZoneCells.add(key);
        this.enemyZoneCells.delete(key);
      }
    } else {
      if (this.enemyZoneCells.has(key)) {
        this.enemyZoneCells.delete(key);
      } else {
        this.enemyZoneCells.add(key);
        this.playerZoneCells.delete(key);
      }
    }
    this.refreshZoneOverlay(key);
    this.refreshButtons();
  }

  private refreshZoneOverlay(key: string): void {
    const cell = this.zoneOverlayCells.get(key);
    if (!cell) return;
    if (this.playerZoneCells.has(key)) {
      cell.setFillStyle(0x3388ff, 0.5);
    } else if (this.enemyZoneCells.has(key)) {
      cell.setFillStyle(0xff4444, 0.5);
    } else {
      cell.setFillStyle(0x000000, 0);
    }
  }

  private buildPaintModeButtons(x: number, y: number, totalW: number): void {
    const btnW = (totalW - 20) / 3;
    const btnH = 26;
    const mkBtn = (cx: number, label: string, onClick: () => void): { bg: Phaser.GameObjects.Rectangle; lbl: Phaser.GameObjects.Text } => {
      const bg = this.add.rectangle(cx + btnW / 2, y, btnW, btnH, 0x1a1a2a).setStrokeStyle(1, 0x445566).setInteractive({ useHandCursor: true });
      const lbl = this.add.text(cx + btnW / 2, y, label, {
        fontSize: "10px", color: "#aabbcc", fontFamily: "monospace", resolution: DPR, letterSpacing: 1,
      }).setOrigin(0.5);
      bg.on("pointerdown", onClick);
      this.detRightContainer.add(bg);
      this.detRightContainer.add(lbl);
      return { bg, lbl };
    };
    const player = mkBtn(x, "PAINT: PLAYER", () => { this.paintMode = this.paintMode === "player" ? null : "player"; this.refreshPaintModeButtons(); });
    const enemy  = mkBtn(x + btnW + 10, "PAINT: ENEMY", () => { this.paintMode = this.paintMode === "enemy" ? null : "enemy"; this.refreshPaintModeButtons(); });
    mkBtn(x + 2 * (btnW + 10), "CLEAR ZONES", () => {
      this.playerZoneCells.clear();
      this.enemyZoneCells.clear();
      for (const key of this.zoneOverlayCells.keys()) this.refreshZoneOverlay(key);
      this.refreshButtons();
    });
    this.paintModePlayerBg = player.bg;
    this.paintModePlayerLabel = player.lbl;
    this.paintModeEnemyBg = enemy.bg;
    this.paintModeEnemyLabel = enemy.lbl;
    this.refreshPaintModeButtons();
  }

  private refreshPaintModeButtons(): void {
    if (this.paintModePlayerBg && this.paintModePlayerLabel) {
      const on = this.paintMode === "player";
      this.paintModePlayerBg.setFillStyle(on ? 0x3388ff : 0x1a1a2a, on ? 0.4 : 1).setStrokeStyle(2, on ? 0x3388ff : 0x445566);
      this.paintModePlayerLabel.setColor(on ? "#dde6ff" : "#aabbcc");
    }
    if (this.paintModeEnemyBg && this.paintModeEnemyLabel) {
      const on = this.paintMode === "enemy";
      this.paintModeEnemyBg.setFillStyle(on ? 0xaa3333 : 0x1a1a2a, on ? 0.4 : 1).setStrokeStyle(2, on ? 0xaa3333 : 0x445566);
      this.paintModeEnemyLabel.setColor(on ? "#ffd6d6" : "#aabbcc");
    }
  }

  // ── Monster picker ──────────────────────────────────────────────────────

  private buildMonsterPicker(x: number, y: number): void {
    this.detRightContainer.add(this.makeSubLabel(x, y, "MONSTERS — click +ALLY or +ENEMY to add to the encounter"));

    const listH = 130;
    const listW = SIDE_PANEL_WIDTH;
    const listY = y + 20;

    // Backing
    this.detRightContainer.add(this.add.rectangle(x + listW / 2, listY + listH / 2, listW, listH, 0x0a0e16).setStrokeStyle(1, 0x334455));

    // Scroll container (children clipped to listW × listH via mask).
    const scroll = this.add.container(x, listY);
    this.monsterScrollContainer = scroll;
    this.detRightContainer.add(scroll);

    const mask = this.make.graphics({ x: 0, y: 0 }, false);
    mask.fillStyle(0xffffff);
    mask.fillRect(x, listY, listW, listH);
    scroll.setMask(mask.createGeometryMask());

    const rowH = 22;
    this.monsters.forEach((mon, i) => {
      const ry = i * rowH;
      const rowBg = this.add.rectangle(listW / 2, ry + rowH / 2, listW - 4, rowH - 2, i % 2 === 0 ? 0x111122 : 0x141426);
      scroll.add(rowBg);
      const label = `${mon.name}  (${mon.type ?? "—"}, ${mon.maxHp} HP)`;
      scroll.add(this.add.text(12, ry + rowH / 2, label, {
        fontSize: "11px", color: "#aabbcc", fontFamily: "monospace", resolution: DPR,
      }).setOrigin(0, 0.5));

      const allyBg = this.add.rectangle(listW - 130, ry + rowH / 2, 70, 18, 0x1a3a55).setStrokeStyle(1, 0x4477aa).setInteractive({ useHandCursor: true });
      scroll.add(allyBg);
      scroll.add(this.add.text(listW - 130, ry + rowH / 2, "+ ALLY", {
        fontSize: "9px", color: "#cce4ff", fontFamily: "monospace", resolution: DPR, letterSpacing: 1,
      }).setOrigin(0.5));
      allyBg.on("pointerdown", () => this.addMonster(mon.id, "ally"));

      const enemyBg = this.add.rectangle(listW - 50, ry + rowH / 2, 70, 18, 0x551a1a).setStrokeStyle(1, 0xaa4444).setInteractive({ useHandCursor: true });
      scroll.add(enemyBg);
      scroll.add(this.add.text(listW - 50, ry + rowH / 2, "+ ENEMY", {
        fontSize: "9px", color: "#ffcccc", fontFamily: "monospace", resolution: DPR, letterSpacing: 1,
      }).setOrigin(0.5));
      enemyBg.on("pointerdown", () => this.addMonster(mon.id, "enemy"));
    });

    // Scene-level wheel listener — scoped by pointer position so it only
    // scrolls when the cursor is over the list. No hit rect needed (one
    // would just block clicks on the +ALLY / +ENEMY buttons inside `scroll`).
    const totalContentH = this.monsters.length * rowH;
    const maxScroll = Math.max(0, totalContentH - listH);
    this.input.on("wheel", (pointer: Phaser.Input.Pointer, _objs: unknown, _dx: number, dy: number) => {
      if (this.tab !== "deterministic" || !this.acceptedMap) return;
      if (pointer.x < x || pointer.x > x + listW || pointer.y < listY || pointer.y > listY + listH) return;
      this.monsterScrollOffset = Phaser.Math.Clamp(this.monsterScrollOffset + dy * 0.5, 0, maxScroll);
      scroll.setY(listY - this.monsterScrollOffset);
    });

    // Selected lists (allies + enemies) below the picker.
    const summaryY = listY + listH + 12;
    this.allyListText = this.add.text(x, summaryY, this.formatSelected(this.allySelections, "ALLIES"), {
      fontSize: "11px", color: "#cce4ff", fontFamily: "monospace", resolution: DPR,
      wordWrap: { width: SIDE_PANEL_WIDTH },
    }).setOrigin(0, 0);
    this.detRightContainer.add(this.allyListText);
    this.enemyListText = this.add.text(x, summaryY + 22, this.formatSelected(this.enemySelections, "ENEMIES"), {
      fontSize: "11px", color: "#ffcccc", fontFamily: "monospace", resolution: DPR,
      wordWrap: { width: SIDE_PANEL_WIDTH },
    }).setOrigin(0, 0);
    this.detRightContainer.add(this.enemyListText);

    // Clear-selections button.
    const clearBg = this.add.rectangle(x + SIDE_PANEL_WIDTH - 80, summaryY + 11, 140, 22, 0x222233).setStrokeStyle(1, 0x556677).setInteractive({ useHandCursor: true });
    this.detRightContainer.add(clearBg);
    this.detRightContainer.add(this.add.text(x + SIDE_PANEL_WIDTH - 80, summaryY + 11, "CLEAR MONSTERS", {
      fontSize: "9px", color: "#aabbcc", fontFamily: "monospace", resolution: DPR, letterSpacing: 1,
    }).setOrigin(0.5));
    clearBg.on("pointerdown", () => {
      this.allySelections.clear();
      this.enemySelections.clear();
      this.refreshSelectedLists();
    });
  }

  private addMonster(id: string, side: "ally" | "enemy"): void {
    const target = side === "ally" ? this.allySelections : this.enemySelections;
    target.set(id, (target.get(id) ?? 0) + 1);
    this.refreshSelectedLists();
  }

  private refreshSelectedLists(): void {
    if (this.allyListText)  this.allyListText.setText(this.formatSelected(this.allySelections, "ALLIES"));
    if (this.enemyListText) this.enemyListText.setText(this.formatSelected(this.enemySelections, "ENEMIES"));
  }

  private formatSelected(sel: Map<string, number>, label: string): string {
    if (sel.size === 0) return `${label}: (none)`;
    const parts = Array.from(sel.entries()).map(([id, n]) => {
      const mon = this.monsters.find((m) => m.id === id);
      return `${mon?.name ?? id}${n > 1 ? ` ×${n}` : ""}`;
    });
    return `${label}: ${parts.join(", ")}`;
  }

  // ── Generative AI panel ─────────────────────────────────────────────────

  private buildGenerativePanel(): void {
    this.genContainer.add(this.makeHeader(LEFT_PANEL_X + SIDE_PANEL_WIDTH / 2, CONTENT_TOP, "DESCRIBE THE SCENE"));
    this.genContainer.add(this.makeHeader(RIGHT_PANEL_X + SIDE_PANEL_WIDTH / 2, CONTENT_TOP, "EXAMPLE PROMPTS"));

    this.genContainer.add(this.makeBodyLine(LEFT_PANEL_X, CONTENT_TOP + 38,
      "Describe the scene you want to play. Click an example on the right to start from."));
    this.genPromptInput = this.buildTextarea(
      LEFT_PANEL_X, CONTENT_TOP + 78, SIDE_PANEL_WIDTH, 320,
      "A description of the scene…",
      () => { this.refreshButtons(); },
    );

    const typesY = CONTENT_TOP + 420;
    this.genContainer.add(this.makeSubLabel(LEFT_PANEL_X, typesY,
      "ENCOUNTER TYPES (optional — leave all off to let the DM choose)"));
    let gcx = LEFT_PANEL_X;
    for (const t of ALL_TYPES) {
      const chip = this.buildEncounterTypeChip(t, gcx, typesY + 28, this.genSelectedTypes, this.genTypeChips);
      this.genContainer.add(chip.bg);
      this.genContainer.add(chip.label);
      gcx += 160;
    }

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
    const w = 140, h = 26;
    const bg = this.add.rectangle(x + w / 2, y, w, h, 0x1a1a2a).setStrokeStyle(1, 0x445566).setInteractive({ useHandCursor: true });
    const label = this.add.text(x + w / 2, y, TERRAIN_LABEL[t], {
      fontSize: "10px", color: "#aabbcc", fontFamily: "monospace", resolution: DPR, letterSpacing: 1,
    }).setOrigin(0.5);
    this.terrainChips.set(t, bg);
    bg.on("pointerdown", () => {
      this.selectedTerrain = this.selectedTerrain === t ? null : t;
      this.refreshTerrainChips();
      this.refreshButtons();
    });
    this.refreshTerrainChips();
    return { bg, label };
  }

  private buildFeatureChip(f: Feature, x: number, y: number): { bg: Phaser.GameObjects.Rectangle; label: Phaser.GameObjects.Text } {
    const w = 140, h = 26;
    const bg = this.add.rectangle(x + w / 2, y, w, h, 0x1a1a2a).setStrokeStyle(1, 0x445566).setInteractive({ useHandCursor: true });
    const label = this.add.text(x + w / 2, y, FEATURE_LABEL[f], {
      fontSize: "10px", color: "#aabbcc", fontFamily: "monospace", resolution: DPR, letterSpacing: 1,
    }).setOrigin(0.5);
    this.featureChips.set(f, bg);
    bg.on("pointerdown", () => {
      if (this.selectedFeatures.has(f)) this.selectedFeatures.delete(f);
      else this.selectedFeatures.add(f);
      this.refreshFeatureChips();
      this.refreshButtons();
    });
    this.refreshFeatureChips();
    return { bg, label };
  }

  private buildEncounterTypeChip(
    t: EncounterType, x: number, y: number,
    target: Set<EncounterType>,
    chipMap: Map<EncounterType, Phaser.GameObjects.Rectangle>,
  ): { bg: Phaser.GameObjects.Rectangle; label: Phaser.GameObjects.Text } {
    const w = 120, h = 28;
    const bg = this.add.rectangle(x + w / 2, y, w, h, 0x1a1a2a).setStrokeStyle(1, 0x445566).setInteractive({ useHandCursor: true });
    const label = this.add.text(x + w / 2, y, TYPE_LABEL[t], {
      fontSize: "10px", color: "#aabbcc", fontFamily: "monospace", resolution: DPR, letterSpacing: 1,
    }).setOrigin(0.5);
    chipMap.set(t, bg);
    bg.on("pointerdown", () => {
      if (target.has(t)) target.delete(t);
      else target.add(t);
      this.refreshEncounterTypeChips(target, chipMap);
    });
    this.refreshEncounterTypeChips(target, chipMap);
    return { bg, label };
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
      const on = this.selectedFeatures.has(f);
      bg.setFillStyle(on ? 0xaa6633 : 0x1a1a2a, on ? 0.4 : 1);
      bg.setStrokeStyle(2, on ? 0xaa6633 : 0x445566);
    }
  }

  private refreshEncounterTypeChips(target: Set<EncounterType>, chips: Map<EncounterType, Phaser.GameObjects.Rectangle>): void {
    for (const [t, bg] of chips) {
      const on = target.has(t);
      bg.setFillStyle(on ? TYPE_COLOR[t] : 0x1a1a2a, on ? 0.4 : 1);
      bg.setStrokeStyle(2, on ? TYPE_COLOR[t] : 0x445566);
    }
  }

  // ── DOM textarea + status line ──────────────────────────────────────────

  private buildTextarea(
    x: number, y: number, w: number, h: number,
    placeholder: string,
    onInput: (value: string) => void,
  ): HTMLTextAreaElement {
    const el = document.createElement("textarea");
    el.placeholder = placeholder;
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

    const detMapCx = W / 2 - 160;
    const detEncCx = W / 2 + 160;
    this.detComposeMapBg = this.add.rectangle(detMapCx, H - 36, 280, 44, 0x1a2a3a).setStrokeStyle(2, 0x345566);
    this.detComposeMapLabel = this.add.text(detMapCx, H - 36, "COMPOSE MAP", {
      fontSize: "14px", color: "#c8d8e8", fontFamily: "monospace", resolution: DPR,
    }).setOrigin(0.5);
    this.detComposeEncBg = this.add.rectangle(detEncCx, H - 36, 280, 44, 0x1a3a2a).setStrokeStyle(2, 0x2a6655);
    this.detComposeEncLabel = this.add.text(detEncCx, H - 36, "COMPOSE ENCOUNTER", {
      fontSize: "14px", color: "#ffe9a8", fontFamily: "monospace", resolution: DPR,
    }).setOrigin(0.5);
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
          this.playerZoneCells.clear();
          this.enemyZoneCells.clear();
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
      const composeMapReady = !this.busy && this.selectedTerrain !== null;
      this.setButton(
        this.detComposeMapBg, this.detComposeMapLabel,
        composeMapReady, "#c8d8e8", 0x1a2a3a, 0x345566,
        () => this.runComposeMap(),
        composeMapReady ? null : (this.busy ? "Busy…" : "Select a terrain first (Grassland or Forest)."),
      );

      // COMPOSE ENCOUNTER requires an accepted map AND at least one player-start cell.
      let encGuard: string | null = null;
      if (this.busy) encGuard = "Busy…";
      else if (!this.acceptedMap) encGuard = "Compose a map and press ACCEPT in the preview first.";
      else if (this.playerZoneCells.size === 0) encGuard = "Paint at least one player-start cell on the thumbnail (PAINT: PLAYER).";
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
      this.openOrUpdatePreview(data as MapPreviewData, true);
    } catch (err) {
      this.handleError(err, "Compose map");
    } finally {
      this.busy = false;
      this.refreshButtons();
    }
  }

  private async runComposeEncounter(): Promise<void> {
    if (!this.acceptedMap) return;
    if (this.playerZoneCells.size === 0) return;
    this.busy = true;
    this.refreshButtons();
    if (this.statusEl) this.statusEl.textContent = "Composing encounter…";

    try {
      const map = this.acceptedMap;
      const startingZonesData = new Array<number>(map.width * map.height).fill(0);
      for (const key of this.playerZoneCells) {
        const [x, y] = key.split(",").map(Number);
        startingZonesData[y * map.width + x] = 1;
      }
      for (const key of this.enemyZoneCells) {
        const [x, y] = key.split(",").map(Number);
        startingZonesData[y * map.width + x] = 4;
      }
      const expand = (sel: Map<string, number>): string[] => {
        const out: string[] = [];
        for (const [id, n] of sel) for (let i = 0; i < n; i++) out.push(id);
        return out;
      };
      const result = await gameClient.composeEncounter({
        existingMapId: map.mapId,
        encounterTypes: Array.from(this.detSelectedTypes),
        description: this.detDescription,
        startingZonesData,
        allyIds: expand(this.allySelections),
        enemyIds: expand(this.enemySelections),
      });
      if (this.statusEl) this.statusEl.textContent = `Composed ${result.encounterId} — pick a character to begin.`;
      this.scene.start("EncounterSetupScene", { presetEncounterId: result.encounterId });
    } catch (err) {
      this.handleError(err, "Compose encounter");
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
    if (this.statusEl) this.statusEl.textContent = "The Dungeon Master is building your encounter… (10–30 seconds)";
    try {
      const { encounterId } = await gameClient.generateEncounter({
        prompt,
        encounterTypes: Array.from(this.genSelectedTypes),
      });
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
   * content. `allowAccept` controls whether the ACCEPT button is shown —
   * the deterministic flow needs it (so the player can commit a map and
   * unlock the encounter-builder right panel); the AI map-only iteration
   * flow does not.
   */
  private openOrUpdatePreview(data: MapPreviewData, allowAccept: boolean): void {
    if (this.mapPreview) {
      this.mapPreview.update(data);
      this.mapPreview.setBusy(false);
    } else {
      this.setDomChromeVisible(false);
      this.mapPreview = new MapPreviewOverlay(this, data, {
        onRegenerate: () => this.regeneratePreview(),
        onClose: () => this.closeMapPreview(),
        onAccept: allowAccept ? () => this.acceptMap(data) : undefined,
      });
    }
  }

  private acceptMap(data: MapPreviewData): void {
    // Closing the preview AND swapping the right panel to the encounter-
    // builder layout. Any previously-painted zones / monster picks are
    // discarded — they were tied to whatever was accepted before.
    this.acceptedMap = data;
    this.playerZoneCells.clear();
    this.enemyZoneCells.clear();
    this.allySelections.clear();
    this.enemySelections.clear();
    this.paintMode = null;
    this.monsterScrollOffset = 0;
    this.closeMapPreview();
    this.rebuildDeterministicRight();
    if (this.statusEl) this.statusEl.textContent = `Accepted ${data.name}. Paint a player zone, then COMPOSE ENCOUNTER.`;
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
      this.mapPreview.update(data as MapPreviewData);
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
    if (this.detDescInput)  this.detDescInput.style.display  = det ? "" : "none";
    if (this.genPromptInput) this.genPromptInput.style.display = !det ? "" : "none";
  }

  private setDomChromeVisible(visible: boolean): void {
    if (!visible) {
      if (this.detDescInput)   this.detDescInput.style.display  = "none";
      if (this.genPromptInput) this.genPromptInput.style.display = "none";
      if (this.statusEl)       this.statusEl.style.display       = "none";
    } else {
      this.setDomVisibility();
      if (this.statusEl) this.statusEl.style.display = "";
    }
  }

  private teardownDom(): void {
    if (this.detDescInput)   { this.detDescInput.remove();   this.detDescInput   = null; }
    if (this.genPromptInput) { this.genPromptInput.remove(); this.genPromptInput = null; }
    if (this.statusEl)       { this.statusEl.remove();       this.statusEl       = null; }
    if (this.mapPreview)     { this.mapPreview.destroy();    this.mapPreview     = null; }
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
