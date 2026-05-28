import Phaser from "phaser";
import { gameClient } from "../net/GameClient";
import type { MonsterDef } from "../data/monsters";
import { MapPreviewOverlay, MapPreviewData } from "../ui/MapPreviewOverlay";
import { tilesetTextureKey } from "./BootScene";
import type { SavedMapDef, EncounterDef, EncounterTrigger } from "../net/types";
import { STARTING_ZONE_PLAYER, STARTING_ZONE_ENEMY, STARTING_ZONE_NEUTRAL } from "../../../shared/startingZones";
import { MonsterPicker } from "../ui/generate/MonsterPicker";
import { ZonePainter } from "../ui/generate/ZonePainter";
import { TriggerEditor, type ComposedTrigger } from "../ui/generate/TriggerEditor";
import { EncounterPickerOverlay } from "../ui/generate/EncounterPickerOverlay";
import { createHtmlButton, createHtmlText, type HtmlButtonHandle, type HtmlTextHandle } from "../ui/htmlButtons";
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
const CONTENT_TOP = 100;
const CONTENT_BOTTOM = H - 110;
const PANEL_PAD = 48;
const COL_GAP = 40;

const THUMB_TILE_PX = 12;
const THUMB_MAX_W = 380;
const THUMB_MAX_H = 240;

type EncounterRecord = EncounterDef & { completionFlag?: string };

/**
 * EncounterEditorScene — opens an existing encounter JSON, presents the same
 * form the deterministic compose flow uses (title / intro / description /
 * objective / completion flag, zone painter, monster picker, trigger editor),
 * and writes changes back via `POST /generate/encounter/update`.
 *
 * Layout:
 *   • LEFT column — thumbnail + zone painter at the top, paint mode toggles
 *     beneath it, then the full story-field stack (title, introduction,
 *     description, objective + completion flag).
 *   • RIGHT column — MONSTERS / TRIGGERS tab toggle + the picker content
 *     using the full remaining page height so long monster rosters /
 *     multiple triggers scroll cleanly.
 *
 * All buttons are HTML (`createHtmlButton`) so they stay crisp at any zoom
 * and the in-list buttons receive clicks reliably. Phaser is used only for
 * the canvas-backed map thumbnail + zone overlay.
 */
export class EncounterEditorScene extends Phaser.Scene {
  private loaded: EncounterRecord | null = null;
  private acceptedMap: MapPreviewData | null = null;

  // Form state.
  private detTitle = "";
  private detIntroduction = "";
  private detDescription = "";
  private detObjective = "";
  private detCompletionFlag = "";
  private detTitleInput: HTMLInputElement | null = null;
  private detIntroInput: HTMLTextAreaElement | null = null;
  private detDescInput: HTMLTextAreaElement | null = null;
  private detObjectiveInput: HTMLInputElement | null = null;
  private detCompletionFlagInput: HTMLInputElement | null = null;

  // Sub-components.
  private formContainer!: Phaser.GameObjects.Container;
  private zonePainter: ZonePainter | null = null;
  private monsterPicker: MonsterPicker | null = null;
  private triggerEditor: TriggerEditor | null = null;
  private monsterSubContainer: Phaser.GameObjects.Container | null = null;
  private triggerSubContainer: Phaser.GameObjects.Container | null = null;
  private pickerTab: "monsters" | "triggers" = "monsters";
  private monstersTabBtn: HtmlButtonHandle | null = null;
  private triggersTabBtn: HtmlButtonHandle | null = null;

  // Initial-seed buckets for sub-components.
  private initialPlayerCells: Set<string> | null = null;
  private initialEnemyCells: Set<string> | null = null;
  private initialNeutralCells: Set<string> | null = null;
  private initialAllyIds: string[] | null = null;
  private initialEnemyIds: string[] | null = null;
  private initialNeutralIds: string[] | null = null;
  private initialTriggers: ComposedTrigger[] | null = null;

  // Chrome.
  private titleText!: HtmlTextHandle;
  private subtitleText!: HtmlTextHandle;
  private openBtn!: HtmlButtonHandle;
  private backBtn!: HtmlButtonHandle;
  private saveBtn!: HtmlButtonHandle;
  /** Phaser text labels owned by the current `rebuildForm` pass — disposed on the next rebuild. */
  private formLabels: HtmlTextHandle[] = [];
  /** Empty-state HTML text shown when no encounter is loaded. */
  private emptyStateText: HtmlTextHandle | null = null;
  private emptyStateHint: HtmlTextHandle | null = null;

  private statusEl: HTMLDivElement | null = null;
  private busy = false;
  private mapPreview: MapPreviewOverlay | null = null;
  private encounterPicker: EncounterPickerOverlay | null = null;
  private monsters: MonsterDef[] = [];

  constructor() {
    super({ key: "EncounterEditorScene" });
  }

  init(): void {
    this.loaded = null;
    this.acceptedMap = null;
    this.detTitle = "";
    this.detIntroduction = "";
    this.detDescription = "";
    this.detObjective = "";
    this.detCompletionFlag = "";
    this.initialPlayerCells = null;
    this.initialEnemyCells = null;
    this.initialNeutralCells = null;
    this.initialAllyIds = null;
    this.initialEnemyIds = null;
    this.initialNeutralIds = null;
    this.initialTriggers = null;
    this.zonePainter = null;
    this.monsterPicker = null;
    this.triggerEditor = null;
    this.busy = false;
  }

  create(): void {
    this.monsters = (this.registry.get("monsters") as MonsterDef[] | undefined) ?? [];

    this.add.rectangle(W / 2, H / 2, W, H, 0x0d0d1e);
    this.titleText = createHtmlText({
      scene: this, sceneWidth: W,
      x: 0, y: TITLE_Y, w: W,
      text: "ENCOUNTER EDITOR",
      fontSize: 22, color: "#e2b96f", align: "center", letterSpacing: 1,
    });
    this.add.rectangle(W / 2, TITLE_Y + 38, W - 64, 1, 0x334455);

    this.subtitleText = createHtmlText({
      scene: this, sceneWidth: W,
      x: 0, y: TITLE_Y + 50, w: W,
      text: "No encounter loaded — press OPEN ENCOUNTER",
      fontSize: 12, color: "#88aacc", align: "center",
    });

    // OPEN ENCOUNTER button — top-right.
    this.openBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: W - 308, y: TITLE_Y + 4, w: 280, h: 36,
      label: "📂 OPEN ENCOUNTER",
      variant: "secondary",
      onClick: () => this.openEncounterPicker(),
    });

    this.formContainer = this.add.container(0, 0);

    this.buildStatusLine();
    this.buildBottomBar();

    this.events.once("shutdown", () => this.teardownDom());
    this.events.once("destroy",  () => this.teardownDom());
  }

  // ── Loading ─────────────────────────────────────────────────────────────

  private openEncounterPicker(): void {
    if (this.encounterPicker || this.busy) return;
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

  private loadEncounter(enc: EncounterRecord): void {
    const maps = (this.registry.get("maps") as SavedMapDef[] | undefined) ?? [];
    const savedMap = maps.find((m) => m.id === enc.mapId);
    if (!savedMap) {
      if (this.statusEl) this.statusEl.textContent = `Cannot open ${enc.id}: referenced map "${enc.mapId}" not found.`;
      return;
    }

    this.loaded = enc;
    this.acceptedMap = savedMapToPreview(savedMap);
    this.detTitle = enc.encounterTitle ?? "";
    this.detIntroduction = enc.customIntroduction ?? "";
    this.detDescription = enc.customContext ?? "";
    this.detObjective = enc.objective ?? "";
    this.detCompletionFlag = enc.completionFlag ?? "";

    const playerCells = new Set<string>();
    const enemyCells = new Set<string>();
    const neutralCells = new Set<string>();
    const layer = enc.startingZones;
    if (layer && layer.data) {
      for (let y = 0; y < layer.height; y++) {
        for (let x = 0; x < layer.width; x++) {
          const v = layer.data[y * layer.width + x];
          if (v === STARTING_ZONE_PLAYER) playerCells.add(`${x},${y}`);
          else if (v === STARTING_ZONE_ENEMY) enemyCells.add(`${x},${y}`);
          else if (v === STARTING_ZONE_NEUTRAL) neutralCells.add(`${x},${y}`);
        }
      }
    }
    this.initialPlayerCells = playerCells;
    this.initialEnemyCells = enemyCells;
    this.initialNeutralCells = neutralCells;

    this.initialAllyIds = [...(enc.allyIds ?? [])];
    this.initialEnemyIds = [...(enc.enemyIds ?? [])];
    this.initialNeutralIds = [...(enc.npcIds ?? [])];

    this.initialTriggers = reverseMapTriggers(enc.triggers ?? []);
    const skipped = (enc.triggers?.length ?? 0) - this.initialTriggers.length;

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

  private rebuildForm(): void {
    this.formContainer.removeAll(true);
    if (this.monsterPicker) { this.monsterPicker.destroy(); this.monsterPicker = null; }
    if (this.triggerEditor) { this.triggerEditor.destroy(); this.triggerEditor = null; }
    if (this.zonePainter)   { this.zonePainter.destroy();   this.zonePainter   = null; }
    if (this.monstersTabBtn) { this.monstersTabBtn.dispose(); this.monstersTabBtn = null; }
    if (this.triggersTabBtn) { this.triggersTabBtn.dispose(); this.triggersTabBtn = null; }
    for (const lbl of this.formLabels) lbl.dispose();
    this.formLabels = [];
    if (this.emptyStateText) { this.emptyStateText.dispose(); this.emptyStateText = null; }
    if (this.emptyStateHint) { this.emptyStateHint.dispose(); this.emptyStateHint = null; }
    this.monsterSubContainer = null;
    this.triggerSubContainer = null;
    this.pickerTab = "monsters";

    if (this.detTitleInput)          { this.detTitleInput.remove();          this.detTitleInput          = null; }
    if (this.detIntroInput)          { this.detIntroInput.remove();          this.detIntroInput          = null; }
    if (this.detDescInput)           { this.detDescInput.remove();           this.detDescInput           = null; }
    if (this.detObjectiveInput)      { this.detObjectiveInput.remove();      this.detObjectiveInput      = null; }
    if (this.detCompletionFlagInput) { this.detCompletionFlagInput.remove(); this.detCompletionFlagInput = null; }

    if (!this.acceptedMap) {
      const cy = (CONTENT_TOP + CONTENT_BOTTOM) / 2;
      this.emptyStateText = createHtmlText({
        scene: this, sceneWidth: W,
        x: 0, y: cy - 12, w: W,
        text: "No encounter loaded",
        fontSize: 16, color: "#556677", align: "center",
      });
      this.emptyStateHint = createHtmlText({
        scene: this, sceneWidth: W,
        x: 0, y: cy + 16, w: W,
        text: "Click OPEN ENCOUNTER to pick one.",
        fontSize: 11, color: "#445566", align: "center",
      });
      return;
    }

    const map = this.acceptedMap;

    // ── Column geometry ─────────────────────────────────────────────────
    const colW = (W - PANEL_PAD * 2 - COL_GAP) / 2;
    const LEFT_X = PANEL_PAD;
    const RIGHT_X = PANEL_PAD + colW + COL_GAP;
    const contentH = CONTENT_BOTTOM - CONTENT_TOP;

    // ── LEFT column: thumbnail + paint buttons + story fields ───────────
    const tileSize = Math.min(
      Math.floor(THUMB_MAX_W / map.width),
      Math.floor(THUMB_MAX_H / map.height),
      THUMB_TILE_PX,
    );
    const thumbW = tileSize * map.width;
    const thumbH = tileSize * map.height;
    const thumbX = LEFT_X + (colW - thumbW) / 2;
    const thumbY = CONTENT_TOP + 8;

    this.zonePainter = new ZonePainter({
      scene: this,
      parent: this.formContainer,
      map,
      thumbX, thumbY, thumbW, thumbH, tileSize,
      tilesetKey: pickTilesetKey(this),
      sceneWidth: W,
      onZonesChanged: () => this.refreshButtons(),
      onClickEmpty:   () => this.openLargePreview(),
      initialPlayerCells:  this.initialPlayerCells  ?? undefined,
      initialEnemyCells:   this.initialEnemyCells   ?? undefined,
      initialNeutralCells: this.initialNeutralCells ?? undefined,
    });

    const footnoteY = thumbY + thumbH + 4;
    this.formLabels.push(createHtmlText({
      scene: this, sceneWidth: W,
      x: thumbX, y: footnoteY, w: thumbW,
      text: `${map.name}  ·  click to enlarge`,
      fontSize: 10, color: "#667788", align: "center",
    }));

    const paintLabelY = footnoteY + 18;
    this.formLabels.push(this.makeSubLabel(thumbX, paintLabelY, colW, "STARTING ZONES"));
    const paintBtnY = paintLabelY + 22;
    this.zonePainter.buildPaintModeButtons(thumbX, paintBtnY, thumbW);

    // Story field stack below the paint buttons, full LEFT column width.
    const storyTop = paintBtnY + 50;
    const inputW = colW;
    const oneLineH = 28;
    const remaining = (CONTENT_BOTTOM - 8) - storyTop;
    // Allocate space: TITLE (oneLine+22 label) + 14 gap +
    //   INTRO (label+22 + textarea) + 14 +
    //   DESC (label+22 + textarea) + 14 +
    //   OBJ+FLAG row (label+22 + oneLine)
    // Solve for textarea height.
    const fixedHeight = (22 + oneLineH) + 14 + 22 + 14 + 22 + 14 + (22 + oneLineH);
    const textareaH = Math.max(60, Math.floor((remaining - fixedHeight) / 2));

    const titleY = storyTop;
    this.formLabels.push(this.makeSubLabel(LEFT_X, titleY, inputW, "TITLE"));
    this.detTitleInput = this.buildLineInput(
      LEFT_X, titleY + 22, inputW, oneLineH,
      "Encounter title",
      (val) => { this.detTitle = val; },
      this.detTitle,
    );

    const introY = titleY + 22 + oneLineH + 14;
    this.formLabels.push(this.makeSubLabel(LEFT_X, introY, inputW, "INTRODUCTION"));
    this.detIntroInput = this.buildTextarea(
      LEFT_X, introY + 22, inputW, textareaH,
      "Opening narration shown to the player…",
      (val) => { this.detIntroduction = val; },
      this.detIntroduction,
    );

    const descY = introY + 22 + textareaH + 14;
    this.formLabels.push(this.makeSubLabel(LEFT_X, descY, inputW, "DESCRIPTION"));
    this.detDescInput = this.buildTextarea(
      LEFT_X, descY + 22, inputW, textareaH,
      "Scene context (the AIDM sees this silently)…",
      (val) => { this.detDescription = val; },
      this.detDescription,
    );

    const objFlagY = descY + 22 + textareaH + 14;
    const halfW = Math.floor((inputW - 8) / 2);
    this.formLabels.push(this.makeSubLabel(LEFT_X, objFlagY, halfW, "OBJECTIVE"));
    this.detObjectiveInput = this.buildLineInput(
      LEFT_X, objFlagY + 22, halfW, oneLineH,
      "Player-facing one-liner",
      (val) => { this.detObjective = val; },
      this.detObjective,
    );
    this.formLabels.push(this.makeSubLabel(LEFT_X + halfW + 8, objFlagY, halfW, "COMPLETION FLAG"));
    this.detCompletionFlagInput = this.buildLineInput(
      LEFT_X + halfW + 8, objFlagY + 22, halfW, oneLineH,
      "snake_case slug",
      (val) => { this.detCompletionFlag = val; },
      this.detCompletionFlag,
    );

    // ── RIGHT column: tab toggle + picker (full height) ──────────────────
    const tabsH = 30;
    const tabsY = CONTENT_TOP + 8;
    const tabW = (colW - 8) / 2;
    this.monstersTabBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: RIGHT_X, y: tabsY, w: tabW, h: tabsH,
      label: "MONSTERS", variant: "secondary",
      onClick: () => this.activatePickerTab("monsters"),
    });
    this.triggersTabBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: RIGHT_X + tabW + 8, y: tabsY, w: tabW, h: tabsH,
      label: "TRIGGERS", variant: "secondary",
      onClick: () => this.activatePickerTab("triggers"),
    });

    const pickerY = tabsY + tabsH + 12;
    const pickerH = (CONTENT_BOTTOM - 8) - pickerY;

    this.monsterSubContainer = this.add.container(0, 0);
    this.formContainer.add(this.monsterSubContainer);
    this.monsterPicker = new MonsterPicker({
      scene: this,
      parent: this.monsterSubContainer,
      monsters: this.monsters,
      x: RIGHT_X, y: pickerY, width: colW, height: pickerH,
      sceneWidth: W,
      initialAllyIds:    this.initialAllyIds    ?? undefined,
      initialEnemyIds:   this.initialEnemyIds   ?? undefined,
      initialNeutralIds: this.initialNeutralIds ?? undefined,
    });

    this.triggerSubContainer = this.add.container(0, 0);
    this.formContainer.add(this.triggerSubContainer);
    this.triggerEditor = new TriggerEditor({
      scene: this,
      parent: this.triggerSubContainer,
      x: RIGHT_X, y: pickerY, width: colW, height: pickerH,
      sceneWidth: W,
      mapW: map.width,
      mapH: map.height,
      initialTriggers: this.initialTriggers ?? undefined,
      onChange: () => this.syncTriggerRegionsToPreview(),
    });

    this.syncTriggerRegionsToPreview();
    this.activatePickerTab(this.pickerTab);

    void contentH;  // reserved for future spacing tweaks
  }

  private activatePickerTab(tab: "monsters" | "triggers"): void {
    this.pickerTab = tab;
    const showMon = tab === "monsters";
    if (this.monsterSubContainer) this.monsterSubContainer.setVisible(showMon);
    if (this.triggerSubContainer) this.triggerSubContainer.setVisible(!showMon);
    if (this.monsterPicker) this.monsterPicker.setVisible(showMon);
    if (this.triggerEditor) this.triggerEditor.setVisible(!showMon);
    if (this.monstersTabBtn) this.monstersTabBtn.setActive(showMon);
    if (this.triggersTabBtn) this.triggersTabBtn.setActive(!showMon);
  }

  private syncTriggerRegionsToPreview(): void {
    if (!this.zonePainter || !this.triggerEditor) return;
    const triggers = this.triggerEditor.getTriggers();
    this.zonePainter.setTriggerRegions(triggers.map((t) => ({ id: t.id, kind: t.kind, region: t.region })));
  }

  private openLargePreview(): void {
    if (!this.acceptedMap || this.mapPreview || !this.zonePainter) return;
    this.setDomChromeVisible(false);
    const triggerRegions = (this.triggerEditor?.getTriggers() ?? []).map((t) => ({ kind: t.kind, region: t.region }));
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

  private closeMapPreview(): void {
    if (this.mapPreview) { this.mapPreview.destroy(); this.mapPreview = null; }
    this.setDomChromeVisible(true);
  }

  // ── Bottom bar + button state ───────────────────────────────────────────

  private buildBottomBar(): void {
    this.add.rectangle(W / 2, H - 58, W - 64, 1, 0x334455);
    this.backBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: 40, y: H - 54, w: 160, h: 36,
      label: "BACK", variant: "ghost",
      onClick: () => this.scene.start("MainMenuScene"),
    });
    this.saveBtn = createHtmlButton({
      scene: this, sceneWidth: W,
      x: W - 360, y: H - 54, w: 320, h: 36,
      label: "✓ SAVE ENCOUNTER", variant: "primary",
      onClick: () => this.runSave(),
    });
    this.refreshButtons();
  }

  private refreshButtons(): void {
    let guard: string | null = null;
    if (this.busy) guard = "Busy…";
    else if (!this.loaded || !this.acceptedMap) guard = "Open an encounter first.";
    else if (!this.zonePainter || this.zonePainter.getPlayerZones().size === 0) guard = "Paint at least one player-start cell (PAINT: PLAYER).";
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
    if (playerCells.size === 0) return;
    this.busy = true;
    this.refreshButtons();
    if (this.statusEl) this.statusEl.textContent = "Saving encounter…";
    try {
      const map = this.acceptedMap;
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
      await gameClient.updateEncounter({
        encounterId: this.loaded.id,
        mapId: this.acceptedMap.mapId ?? undefined,
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

      const [encs, maps] = await Promise.all([gameClient.listEncounters(), gameClient.listMaps()]);
      this.registry.set("encounters", encs);
      this.registry.set("maps", maps);

      if (this.statusEl) this.statusEl.textContent = `Saved ${this.loaded.id}.`;
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
    const el = document.createElement("input");
    el.type = "text";
    el.placeholder = placeholder;
    if (initialValue) el.value = initialValue;
    el.style.cssText = `
      position: absolute; background: #141426; color: #e0e8f0;
      border: 1px solid #445566; padding: 0 12px;
      font-family: monospace; font-size: 13px; z-index: 10; box-sizing: border-box;
    `;
    document.body.appendChild(el);
    const place = (): void => {
      const rect = this.sys.game.canvas.getBoundingClientRect();
      const s = rect.width / W;
      el.style.left = `${rect.left + x * s}px`;
      el.style.top  = `${rect.top  + y * s}px`;
      el.style.width  = `${w * s}px`;
      el.style.height = `${h * s}px`;
      el.style.fontSize = `${13 * s}px`;
    };
    place();
    this.scale.on("resize", place);
    el.oninput = (): void => onInput(el.value);
    return el;
  }

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
      position: absolute; background: #141426; color: #e0e8f0;
      border: 1px solid #445566; padding: 10px 12px;
      font-family: monospace; font-size: 13px; line-height: 1.4;
      resize: none; z-index: 10; box-sizing: border-box;
    `;
    document.body.appendChild(el);
    const place = (): void => {
      const rect = this.sys.game.canvas.getBoundingClientRect();
      const s = rect.width / W;
      el.style.left = `${rect.left + x * s}px`;
      el.style.top  = `${rect.top  + y * s}px`;
      el.style.width  = `${w * s}px`;
      el.style.height = `${h * s}px`;
      el.style.fontSize = `${13 * s}px`;
    };
    place();
    this.scale.on("resize", place);
    el.oninput = (): void => onInput(el.value);
    return el;
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
  }

  private setDomChromeVisible(visible: boolean): void {
    const inputs = [this.detTitleInput, this.detIntroInput, this.detDescInput, this.detObjectiveInput, this.detCompletionFlagInput];
    for (const el of inputs) if (el) el.style.display = visible ? "" : "none";
    if (this.statusEl) this.statusEl.style.display = visible ? "" : "none";
    if (this.titleText)    this.titleText.setVisible(visible);
    if (this.subtitleText) this.subtitleText.setVisible(visible);
    for (const lbl of this.formLabels) lbl.setVisible(visible);
    if (this.emptyStateText) this.emptyStateText.setVisible(visible);
    if (this.emptyStateHint) this.emptyStateHint.setVisible(visible);
    if (this.openBtn) this.openBtn.setVisible(visible);
    if (this.backBtn) this.backBtn.setVisible(visible);
    if (this.saveBtn) this.saveBtn.setVisible(visible);
    if (this.monstersTabBtn) this.monstersTabBtn.setVisible(visible);
    if (this.triggersTabBtn) this.triggersTabBtn.setVisible(visible);
    if (this.monsterPicker)  this.monsterPicker.setVisible(visible && this.pickerTab === "monsters");
    if (this.triggerEditor) {
      if (!visible) this.triggerEditor.setVisible(false);
      else this.triggerEditor.setVisible(this.pickerTab === "triggers");
    }
  }

  private teardownDom(): void {
    if (this.detTitleInput)          { this.detTitleInput.remove();          this.detTitleInput          = null; }
    if (this.detIntroInput)          { this.detIntroInput.remove();          this.detIntroInput          = null; }
    if (this.detDescInput)           { this.detDescInput.remove();           this.detDescInput           = null; }
    if (this.detObjectiveInput)      { this.detObjectiveInput.remove();      this.detObjectiveInput      = null; }
    if (this.detCompletionFlagInput) { this.detCompletionFlagInput.remove(); this.detCompletionFlagInput = null; }
    if (this.statusEl)               { this.statusEl.remove();               this.statusEl               = null; }
    if (this.mapPreview)             { this.mapPreview.destroy();            this.mapPreview             = null; }
    if (this.encounterPicker)        { this.encounterPicker.destroy();       this.encounterPicker        = null; }
    if (this.triggerEditor)          { this.triggerEditor.destroy();         this.triggerEditor          = null; }
    if (this.monsterPicker)          { this.monsterPicker.destroy();         this.monsterPicker          = null; }
    if (this.zonePainter)            { this.zonePainter.destroy();           this.zonePainter            = null; }
    if (this.openBtn)                { this.openBtn.dispose(); }
    if (this.backBtn)                { this.backBtn.dispose(); }
    if (this.saveBtn)                { this.saveBtn.dispose(); }
    if (this.monstersTabBtn)         { this.monstersTabBtn.dispose(); this.monstersTabBtn = null; }
    if (this.triggersTabBtn)         { this.triggersTabBtn.dispose(); this.triggersTabBtn = null; }
    if (this.titleText)              { this.titleText.dispose(); }
    if (this.subtitleText)           { this.subtitleText.dispose(); }
    for (const lbl of this.formLabels) lbl.dispose();
    this.formLabels = [];
    if (this.emptyStateText)         { this.emptyStateText.dispose(); this.emptyStateText = null; }
    if (this.emptyStateHint)         { this.emptyStateHint.dispose(); this.emptyStateHint = null; }
  }
}

// ── Module helpers ───────────────────────────────────────────────────────

function reverseMapTriggers(triggers: EncounterTrigger[]): ComposedTrigger[] {
  const out: ComposedTrigger[] = [];
  for (const t of triggers) {
    if (t.when.event !== "player_moved" || !t.when.in_area) continue;
    const region = t.when.in_area;
    const first = t.then[0];
    if (!first) continue;

    if (first.type === "player_ability_check" && first.skill === "perception") {
      const pass = first.onPass[0];
      const passMessage = pass && pass.type === "show_log" ? pass.message : "";
      out.push({ id: t.id, region, kind: "perception", dc: first.dc, passMessage, message: "", defId: "" });
      continue;
    }
    if (first.type === "show_log") {
      out.push({ id: t.id, region, kind: "log", dc: 10, passMessage: "", message: first.message, defId: "" });
      continue;
    }
    if (first.type === "send_aigm_message") {
      out.push({ id: t.id, region, kind: "aigm", dc: 10, passMessage: "", message: first.message, defId: "" });
      continue;
    }
    if (t.then.some((a) => a.type === "trigger_combat")) {
      const flipIds: string[] = [];
      for (const a of t.then) {
        if (a.type === "set_disposition_by_def_id" && a.disposition === "enemy") flipIds.push(a.defId);
      }
      out.push({
        id: t.id, region, kind: "combat", dc: 10, passMessage: "", message: "",
        defId: flipIds[0] ?? "",
        defIds: flipIds.length > 1 ? flipIds : undefined,
      });
      continue;
    }
  }
  return out;
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
