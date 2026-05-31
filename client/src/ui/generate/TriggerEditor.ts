/**
 * TriggerEditor — inline UI for authoring encounter triggers from the
 * Adjudicator-tab of `MapEditorScene` and from `EncounterCreatorScene`.
 *
 * Each trigger is a rectangular region on the map plus one of four action
 * templates (perception check, log message, AIGM cue, start combat). The
 * component owns its trigger list; the parent scene reads it via
 * `getTriggers()` when composing or updating the encounter.
 *
 * Rendering is HTML-based: the scrollable rows live inside an absolutely-
 * positioned `<div style="overflow:auto">` so native browser scrolling +
 * crisp font rendering replace the previous Phaser scroll container. The
 * "+ ADD TRIGGER" button is also HTML — Phaser-rendered click targets
 * were being occluded by sibling DOM inputs.
 */
import Phaser from "phaser";

const DPR = window.devicePixelRatio;
const ADD_BTN_H = 32;
const HEADER_H = 16;

export type TriggerActionKind =
  | "perception" | "log" | "aigm" | "combat" | "xp"
  | "announcement" | "speech" | "fade" | "set_flag"
  | "enable_long_rest" | "disable_long_rest";

export type TriggerWhenEvent =
  | "player_moved" | "encounter_started" | "encounter_completed" | "flag_set";

export interface ComposedTrigger {
  id: string;
  /** WHEN event the trigger fires on. `player_moved` uses the `region`;
   *  `encounter_started` and `encounter_completed` ignore it. */
  whenEvent?: TriggerWhenEvent;
  region: { x: number; y: number; w: number; h: number };
  kind: TriggerActionKind;
  dc: number;
  passMessage: string;
  message: string;
  defId: string;
  defIds?: string[];
  /** Amount granted by an `xp` trigger. Optional; defaults to 0 (no-op). */
  xpAmount?: number;
  /** Hold time (ms) for `announcement`; fade time for `fade`. */
  durationMs?: number;
  /** Entity ref for `speech` (e.g. `player`, `npc_<id>`, `enemy_A`). */
  entityRef?: string;
  /** Direction for `fade`. `dim` holds the overlay at 50% black (world still visible). */
  fadeMode?: "in" | "out" | "dim";
  /** Style for `announcement`. `focused` hides side panels + locks input + pauses world; `unfocused` keeps the UI live. */
  announcementMode?: "focused" | "unfocused";
  /** Flag name the `flag_set` WHEN matcher listens for. Blank matches every flag write. */
  whenFlagName?: string;
  /** Flag name the `set_flag` THEN action writes (always to `true`). Required by the THEN action; ignored otherwise. */
  setFlagName?: string;
}

export interface TriggerEditorOptions {
  scene: Phaser.Scene;
  parent: Phaser.GameObjects.Container;
  x: number;
  y: number;
  width: number;
  /** Total height the editor may consume (header + scroll area + add button). */
  height: number;
  /** Scene width in logical pixels — used to scale absolutely-positioned DOM. */
  sceneWidth: number;
  /** Map dimensions, used to clamp region inputs. */
  mapW: number;
  mapH: number;
  /** Called whenever triggers change. */
  onChange?: () => void;
  /** Pre-seed the editor with triggers. */
  initialTriggers?: ComposedTrigger[];
}

const KIND_LABEL: Record<TriggerActionKind, string> = {
  perception: "PERCEPTION",
  log: "LOG",
  aigm: "AIGM CUE",
  combat: "START COMBAT",
  xp: "AWARD XP",
  announcement: "ANNOUNCE",
  speech: "SPEECH",
  fade: "FADE",
  set_flag: "SET FLAG",
  enable_long_rest: "ENABLE LONG REST",
  disable_long_rest: "DISABLE LONG REST",
};

/** Per-kind swatch colour shown next to each trigger's summary so authors
 *  can match a trigger row to its outline on the map preview. Matches
 *  `ZonePainter.TRIGGER_COLOR` / `EmbeddedMapPreview.TRIGGER_COLOR`. */
export const KIND_SWATCH: Record<TriggerActionKind, string> = {
  perception:   "#88ccaa",
  log:          "#c8d8e8",
  aigm:         "#e2b96f",
  combat:       "#ff6644",
  xp:           "#88ccff",
  announcement: "#f4e6c1",
  speech:       "#5588aa",
  fade:         "#222222",
  set_flag:     "#aa88ff",
  enable_long_rest:  "#66cc99",
  disable_long_rest: "#996644",
};

const KIND_TOOLTIP: Record<TriggerActionKind, string> = {
  perception: "Roll a Perception check vs DC. On pass, show the log line.",
  log: "Write a line to the Event Log.",
  aigm: "Queue a cue for the AIGM's next reply.",
  combat: "Flip the named def to enemy and start combat.",
  xp: "Award the player XP.",
  announcement: "Show a centered announcement card; mirrored to the Event Log.",
  speech: "Show a speech bubble above the named entity's token.",
  fade: "Fade the screen to or from black. Pair an OUT with an IN.",
  set_flag: "Set a world flag to true. Pair with the encounter's completionFlag to end a non-combat encounter.",
  enable_long_rest:  "Surface the LONG REST button on the Player Panel — turns this encounter into a safe rest stop.",
  disable_long_rest: "Hide the LONG REST button — useful when an authored beat turns a previously safe encounter hostile.",
};

export class TriggerEditor {
  private readonly triggers: ComposedTrigger[] = [];
  private readonly rowElements: HTMLDivElement[] = [];
  private readonly scene: Phaser.Scene;
  private readonly opts: TriggerEditorOptions;
  private titleEl!: HTMLDivElement;
  private listEl!: HTMLDivElement;
  private addBtn!: HTMLButtonElement;
  private placeHandlers: Array<() => void> = [];
  private visible = true;

  constructor(opts: TriggerEditorOptions) {
    this.scene = opts.scene;
    this.opts = opts;
    const { x, y, width } = opts;

    // HTML title — matches the rest of the editor's crisp HTML rendering
    // instead of a blurry Phaser text. Sized to the same logical-pixel
    // footprint and rescaled with the canvas via attachPlace().
    this.titleEl = document.createElement("div");
    this.titleEl.textContent = "TRIGGERS — fires when the player enters the region";
    this.titleEl.style.cssText = `
      position: absolute;
      color: #778899;
      font-family: monospace;
      letter-spacing: 1px;
      z-index: 9;
      pointer-events: none;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    `;
    document.body.appendChild(this.titleEl);
    this.attachPlace(this.titleEl, x, y, width, HEADER_H);

    // Scrollable HTML list — sized so the ADD button can sit beneath it.
    const listY = y + HEADER_H + 4;
    const listH = opts.height - HEADER_H - ADD_BTN_H - 14;

    this.listEl = document.createElement("div");
    this.listEl.style.cssText = `
      position: absolute;
      background: #0a0e16;
      border: 1px solid #334455;
      box-sizing: border-box;
      overflow-y: auto;
      overflow-x: hidden;
      z-index: 9;
      padding: 4px;
    `;
    document.body.appendChild(this.listEl);
    this.attachPlace(this.listEl, x, listY, width, listH);

    // ADD TRIGGER button as a real HTML button beneath the list.
    const addY = listY + listH + 6;
    this.addBtn = document.createElement("button");
    this.addBtn.type = "button";
    this.addBtn.textContent = "+ ADD TRIGGER";
    this.addBtn.style.cssText = `
      position: absolute;
      background: #2a3a55;
      color: #cce4ff;
      border: 2px solid #5588aa;
      padding: 0 12px;
      font-family: monospace;
      font-size: 12px;
      letter-spacing: 1px;
      cursor: pointer;
      z-index: 10;
      box-sizing: border-box;
    `;
    this.addBtn.addEventListener("mouseenter", () => { this.addBtn.style.background = "#3a4f70"; });
    this.addBtn.addEventListener("mouseleave", () => { this.addBtn.style.background = "#2a3a55"; });
    this.addBtn.addEventListener("click", () => this.addTrigger());
    document.body.appendChild(this.addBtn);
    this.attachPlace(this.addBtn, x, addY, width, ADD_BTN_H);

    // Seed from initialTriggers if any were supplied.
    if (opts.initialTriggers && opts.initialTriggers.length > 0) {
      for (const t of opts.initialTriggers) {
        this.triggers.push({ ...t, region: { ...t.region } });
      }
      this.rebuildRows();
    }
  }

  /** Snapshot of the current triggers. */
  getTriggers(): ComposedTrigger[] {
    return this.triggers.map((t) => ({
      ...t,
      region: { ...t.region },
      defIds: t.defIds ? [...t.defIds] : undefined,
    }));
  }

  /** Replace the trigger list wholesale. Used by the AI accept flow when
   *  the proposal includes a fresh trigger set. Rebuilds every row from
   *  scratch and fires `onChange` so the host scene can sync the painter's
   *  region overlays. */
  setTriggers(triggers: ComposedTrigger[]): void {
    this.triggers.length = 0;
    for (const t of triggers) {
      this.triggers.push({
        ...t,
        region: { ...t.region },
        defIds: t.defIds ? [...t.defIds] : undefined,
      });
    }
    this.rebuildRows();
    this.opts.onChange?.();
  }

  destroy(): void {
    for (const row of this.rowElements) row.remove();
    this.rowElements.length = 0;
    this.titleEl.remove();
    this.listEl.remove();
    this.addBtn.remove();
    for (const h of this.placeHandlers) this.opts.scene.scale.off("resize", h);
    this.placeHandlers = [];
  }

  /**
   * Show / hide every DOM element the editor owns. Called by the tab toggle
   * when the user flips between MONSTERS and TRIGGERS.
   */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.titleEl.style.display = visible ? "" : "none";
    this.listEl.style.display = visible ? "" : "none";
    this.addBtn.style.display = visible ? "" : "none";
  }

  // ── Trigger lifecycle ────────────────────────────────────────────────────

  private addTrigger(): void {
    const id = `gen_trigger_${this.triggers.length + 1}`;
    const region = { x: 0, y: 0, w: Math.min(5, this.opts.mapW), h: Math.min(5, this.opts.mapH) };
    const trig: ComposedTrigger = {
      id, region, kind: "perception",
      whenEvent: "player_moved",
      dc: 10, passMessage: "You sense something nearby.",
      message: "",
      defId: "",
    };
    this.triggers.push(trig);
    this.rebuildRows();
    this.opts.onChange?.();
    // Scroll new row into view.
    this.listEl.scrollTop = this.listEl.scrollHeight;
  }

  private removeTrigger(index: number): void {
    this.triggers.splice(index, 1);
    this.rebuildRows();
    this.opts.onChange?.();
  }

  // ── Row rendering ───────────────────────────────────────────────────────

  private rebuildRows(): void {
    for (const row of this.rowElements) row.remove();
    this.rowElements.length = 0;
    this.listEl.innerHTML = "";
    for (let i = 0; i < this.triggers.length; i++) {
      const row = this.buildRow(this.triggers[i], i);
      this.rowElements.push(row);
      this.listEl.appendChild(row);
    }
  }

  /**
   * Build one trigger row. Orchestration only — each visual section delegates
   * to a dedicated builder so this method stays the place a reader looks to
   * understand the layout (head / WHEN / chips / region / flag-matcher / one
   * of the per-kind blocks). Mutations from any builder route through a
   * single `onChange` closure that re-summarises the row + refreshes the
   * trigger-colour swatch + notifies the parent.
   */
  private buildRow(trig: ComposedTrigger, i: number): HTMLDivElement {
    const row = document.createElement("div");
    row.style.cssText = `
      background: ${i % 2 === 0 ? "#111122" : "#141426"};
      border: 1px solid #334455;
      padding: 6px 8px;
      margin-bottom: 4px;
      box-sizing: border-box;
      font-family: monospace;
      font-size: 11px;
      color: #aabbcc;
    `;

    const { head, summary, refreshSwatch } = this.buildHeadRow(trig, i);
    const onChange = (): void => {
      summary.textContent = this.summarise(trig);
      refreshSwatch();
      this.opts.onChange?.();
    };

    const regionRow   = this.buildRegionRow(trig, onChange);
    const whenFlagRow = this.buildWhenFlagRow(trig, onChange);

    // Build every per-kind block first so the chip-row's click handlers can
    // flip block visibility by reference.
    const blocks = new Map<TriggerActionKind, HTMLElement>([
      ["perception",   this.buildPerceptionBlock(trig, onChange)],
      ["log",          this.buildLogBlock(trig, onChange)],
      ["aigm",         this.buildAigmBlock(trig, onChange)],
      ["combat",       this.buildCombatBlock(trig, onChange)],
      ["xp",           this.buildXpBlock(trig, onChange)],
      ["announcement", this.buildAnnouncementBlock(trig, onChange)],
      ["speech",       this.buildSpeechBlock(trig, onChange)],
      ["fade",         this.buildFadeBlock(trig, onChange)],
      ["set_flag",     this.buildSetFlagBlock(trig, onChange)],
    ]);

    const whenRow = this.buildWhenSelector(trig, regionRow, whenFlagRow, onChange);
    const chipRow = this.buildChipRow(trig, blocks, onChange);

    row.appendChild(head);
    row.appendChild(whenRow);
    row.appendChild(chipRow);
    row.appendChild(regionRow);
    row.appendChild(whenFlagRow);
    for (const block of blocks.values()) row.appendChild(block);

    this.refreshKindVisibility(blocks, trig.kind);
    return row;
  }

  /** Head row — colour swatch + summary + REMOVE button. Returns the live
   *  swatch refresher so kind/whenEvent changes can recolour it. */
  private buildHeadRow(trig: ComposedTrigger, index: number):
    { head: HTMLDivElement; summary: HTMLSpanElement; refreshSwatch: () => void } {
    const head = document.createElement("div");
    head.style.cssText = "display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; gap: 6px;";
    const summaryLine = document.createElement("div");
    summaryLine.style.cssText = "display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0;";

    const swatch = document.createElement("span");
    swatch.style.cssText = "width: 12px; height: 12px; flex-shrink: 0; box-sizing: border-box;";
    summaryLine.appendChild(swatch);

    const summary = document.createElement("span");
    summary.style.cssText = "color: #e2b96f; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
    summary.textContent = this.summarise(trig);
    summaryLine.appendChild(summary);
    head.appendChild(summaryLine);

    const refreshSwatch = (): void => {
      // Lifecycle / flag triggers paint no region outline, so the swatch
      // renders hollow to match. Region triggers fill with the kind colour.
      const region = (trig.whenEvent ?? "player_moved") === "player_moved";
      swatch.style.background = region ? KIND_SWATCH[trig.kind] : "transparent";
      swatch.style.border = `1px solid ${region ? KIND_SWATCH[trig.kind] : "#445566"}`;
    };
    refreshSwatch();

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "REMOVE";
    remove.style.cssText = `
      background: #551a1a; color: #ffcccc; border: 1px solid #aa4444;
      padding: 1px 8px; font-family: monospace; font-size: 9px;
      cursor: pointer; letter-spacing: 1px;
    `;
    remove.addEventListener("click", () => this.removeTrigger(index));
    head.appendChild(remove);

    return { head, summary, refreshSwatch };
  }

  /** WHEN selector — flips trigger.whenEvent and the visibility of the
   *  region / flag-matcher rows the caller passes in by reference. */
  private buildWhenSelector(
    trig: ComposedTrigger,
    regionRow: HTMLDivElement,
    whenFlagRow: HTMLDivElement,
    onChange: () => void,
  ): HTMLDivElement {
    const row = document.createElement("div");
    row.style.cssText = "display: flex; gap: 4px; margin-bottom: 6px; align-items: center;";
    row.appendChild(this.makeLabel("WHEN"));

    const buttons = new Map<TriggerWhenEvent, HTMLButtonElement>();
    const refresh = (active: TriggerWhenEvent): void => {
      for (const [m, b] of buttons) {
        const on = m === active;
        b.style.background = on ? "#2a3a55" : "#1a1a2a";
        b.style.color = on ? "#cce4ff" : "#aabbcc";
      }
    };
    const make = (we: TriggerWhenEvent, label: string, tooltip: string): HTMLButtonElement => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = label;
      btn.title = tooltip;
      btn.style.cssText = `
        flex: 1; background: #1a1a2a; color: #aabbcc;
        border: 1px solid #445566; padding: 2px 4px;
        font-family: monospace; font-size: 9px; letter-spacing: 1px;
        cursor: pointer; white-space: nowrap;
      `;
      btn.addEventListener("click", () => {
        trig.whenEvent = we;
        refresh(we);
        regionRow.style.display   = we === "player_moved" ? "" : "none";
        whenFlagRow.style.display = we === "flag_set"     ? "" : "none";
        onChange();
      });
      buttons.set(we, btn);
      return btn;
    };
    row.appendChild(make("player_moved",       "REGION",      "Fires when the player walks into the region defined below."));
    row.appendChild(make("encounter_started",  "ON START",    "Fires once when the encounter begins."));
    row.appendChild(make("encounter_completed","ON COMPLETE", "Fires once when the encounter resolves (combat-victory or completionFlag set)."));
    row.appendChild(make("flag_set",           "ON FLAG",     "Fires when a world flag is set. Leave the flag-name blank to match every flag."));
    refresh(trig.whenEvent ?? "player_moved");
    return row;
  }

  /** Kind chip row — selects which per-kind block is visible. */
  private buildChipRow(
    trig: ComposedTrigger,
    blocks: Map<TriggerActionKind, HTMLElement>,
    onChange: () => void,
  ): HTMLDivElement {
    const row = document.createElement("div");
    row.style.cssText = "display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px;";
    const kinds: TriggerActionKind[] = [
      "perception", "log", "aigm", "combat", "xp",
      "announcement", "speech", "fade", "set_flag",
      "enable_long_rest", "disable_long_rest",
    ];
    const chipBtns = new Map<TriggerActionKind, HTMLButtonElement>();
    for (const k of kinds) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.textContent = KIND_LABEL[k];
      chip.title = KIND_TOOLTIP[k];
      chip.style.cssText = `
        flex: 1 0 18%; background: #1a1a2a; color: #aabbcc;
        border: 1px solid #445566; padding: 2px 4px;
        font-family: monospace; font-size: 9px; letter-spacing: 1px;
        cursor: pointer; white-space: nowrap;
      `;
      chip.addEventListener("click", () => {
        trig.kind = k;
        this.refreshChips(chipBtns, trig.kind);
        this.refreshKindVisibility(blocks, trig.kind);
        onChange();
      });
      chipBtns.set(k, chip);
      row.appendChild(chip);
    }
    this.refreshChips(chipBtns, trig.kind);
    return row;
  }

  /** Region xywh inputs. Hidden when the trigger is not `player_moved`. */
  private buildRegionRow(trig: ComposedTrigger, onChange: () => void): HTMLDivElement {
    const row = document.createElement("div");
    row.style.cssText = "display: flex; gap: 6px; margin-bottom: 6px; align-items: center;";
    if ((trig.whenEvent ?? "player_moved") !== "player_moved") row.style.display = "none";
    row.appendChild(this.makeLabel("REGION"));
    const dims: Array<keyof { x: 1; y: 1; w: 1; h: 1 }> = ["x", "y", "w", "h"];
    for (const nm of dims) {
      row.appendChild(this.makeLabel(nm));
      row.appendChild(this.makeNumberInput(String(trig.region[nm]), (val) => {
        const n = Math.max(0, Math.floor(Number(val) || 0));
        if      (nm === "x") trig.region.x = Math.min(n, this.opts.mapW - 1);
        else if (nm === "y") trig.region.y = Math.min(n, this.opts.mapH - 1);
        else if (nm === "w") trig.region.w = Math.max(1, Math.min(n, this.opts.mapW - trig.region.x));
        else                 trig.region.h = Math.max(1, Math.min(n, this.opts.mapH - trig.region.y));
        onChange();
      }));
    }
    return row;
  }

  /** Flag-name matcher row. Hidden when WHEN is not `flag_set`. */
  private buildWhenFlagRow(trig: ComposedTrigger, onChange: () => void): HTMLDivElement {
    const row = document.createElement("div");
    row.style.cssText = "display: flex; gap: 6px; margin-bottom: 6px; align-items: center;";
    if ((trig.whenEvent ?? "player_moved") !== "flag_set") row.style.display = "none";
    row.appendChild(this.makeLabel("FLAG NAME (blank = any)"));
    row.appendChild(this.makeTextInput(trig.whenFlagName ?? "", "e.g. tutorial_complete", (val) => {
      trig.whenFlagName = val.trim();
      onChange();
    }));
    return row;
  }

  // ── Per-kind THEN blocks ────────────────────────────────────────────────

  private buildPerceptionBlock(trig: ComposedTrigger, onChange: () => void): HTMLElement {
    const block = document.createElement("div");
    block.style.cssText = "display: flex; flex-direction: column; gap: 4px;";
    const dcRow = document.createElement("div");
    dcRow.style.cssText = "display: flex; gap: 6px; align-items: center;";
    dcRow.appendChild(this.makeLabel("DC"));
    dcRow.appendChild(this.makeNumberInput(String(trig.dc), (val) => {
      trig.dc = Math.max(1, Math.min(30, Math.floor(Number(val) || 10)));
      onChange();
    }));
    block.appendChild(dcRow);
    block.appendChild(this.makeLabel("PASS MESSAGE"));
    block.appendChild(this.makeTextarea(trig.passMessage, (val) => { trig.passMessage = val; onChange(); }));
    return block;
  }

  private buildLogBlock(trig: ComposedTrigger, onChange: () => void): HTMLElement {
    const block = document.createElement("div");
    block.appendChild(this.makeLabel("LOG MESSAGE"));
    block.appendChild(this.makeTextarea(trig.message, (val) => { trig.message = val; onChange(); }));
    return block;
  }

  private buildAigmBlock(trig: ComposedTrigger, onChange: () => void): HTMLElement {
    const block = document.createElement("div");
    block.appendChild(this.makeLabel("AIGM CUE"));
    block.appendChild(this.makeTextarea(trig.message, (val) => { trig.message = val; onChange(); }));
    return block;
  }

  private buildCombatBlock(trig: ComposedTrigger, onChange: () => void): HTMLElement {
    const block = document.createElement("div");
    block.appendChild(this.makeLabel("DEF ID (optional — flips this id to enemy)"));
    block.appendChild(this.makeTextInput(trig.defId, "e.g. cultist", (val) => { trig.defId = val.trim(); onChange(); }));
    return block;
  }

  private buildXpBlock(trig: ComposedTrigger, onChange: () => void): HTMLElement {
    const block = document.createElement("div");
    const row = document.createElement("div");
    row.style.cssText = "display: flex; gap: 6px; align-items: center;";
    row.appendChild(this.makeLabel("AMOUNT"));
    row.appendChild(this.makeNumberInput(String(trig.xpAmount ?? 0), (val) => {
      trig.xpAmount = Math.max(0, Math.floor(Number(val) || 0));
      onChange();
    }));
    block.appendChild(row);
    return block;
  }

  private buildAnnouncementBlock(trig: ComposedTrigger, onChange: () => void): HTMLElement {
    const block = this.buildTextDurationBlock(
      "ANNOUNCEMENT TEXT", trig.message, "DURATION (ms, default 3500)", trig.durationMs,
      (text) => { trig.message = text; onChange(); },
      (ms)   => { trig.durationMs = ms; onChange(); },
    );
    // FOCUSED hides UI + pauses the world + locks input; UNFOCUSED keeps the
    // UI live with an edge-fade card.
    block.appendChild(this.buildModeToggleRow<"focused" | "unfocused">(
      "MODE",
      [["focused", "FOCUSED"], ["unfocused", "UNFOCUSED"]],
      trig.announcementMode ?? "focused",
      (mode) => { trig.announcementMode = mode; onChange(); },
    ));
    return block;
  }

  private buildSpeechBlock(trig: ComposedTrigger, onChange: () => void): HTMLElement {
    const block = document.createElement("div");
    block.style.cssText = "display: flex; flex-direction: column; gap: 4px;";
    block.appendChild(this.makeLabel("ENTITY (player, npc_<id>, enemy_A, ally_A)"));
    block.appendChild(this.makeTextInput(trig.entityRef ?? "", "e.g. npc_wanderer_0", (val) => {
      trig.entityRef = val.trim();
      onChange();
    }));
    block.appendChild(this.makeLabel("SPOKEN LINE"));
    block.appendChild(this.makeTextarea(trig.message, (val) => { trig.message = val; onChange(); }));
    return block;
  }

  private buildFadeBlock(trig: ComposedTrigger, onChange: () => void): HTMLElement {
    const block = document.createElement("div");
    block.style.cssText = "display: flex; flex-direction: column; gap: 4px;";
    block.appendChild(this.buildModeToggleRow<"in" | "out" | "dim">(
      "MODE",
      [["out", "FADE OUT"], ["dim", "FADE DIM (50%)"], ["in", "FADE IN"]],
      trig.fadeMode ?? "out",
      (mode) => { trig.fadeMode = mode; onChange(); },
    ));
    const durRow = document.createElement("div");
    durRow.style.cssText = "display: flex; gap: 6px; align-items: center;";
    durRow.appendChild(this.makeLabel("DURATION (ms, default 1200)"));
    durRow.appendChild(this.makeNumberInput(String(trig.durationMs ?? 1200), (val) => {
      trig.durationMs = Math.max(0, Math.floor(Number(val) || 0));
      onChange();
    }));
    block.appendChild(durRow);
    return block;
  }

  /** SET FLAG block — writes the named flag to `true` when the trigger
   *  fires. Pair with the encounter's COMPLETION FLAG to end non-combat
   *  encounters from a trigger (e.g. parley success, region reached). */
  private buildSetFlagBlock(trig: ComposedTrigger, onChange: () => void): HTMLElement {
    const block = document.createElement("div");
    block.style.cssText = "display: flex; flex-direction: column; gap: 4px;";
    block.appendChild(this.makeLabel("FLAG NAME (snake_case, set to true)"));
    block.appendChild(this.makeTextInput(trig.setFlagName ?? "", "e.g. tomb_opened", (val) => {
      trig.setFlagName = val.trim();
      onChange();
    }));
    return block;
  }

  /** Generic mode-toggle row — labelled chip strip with one option active.
   *  Used by ANNOUNCE (FOCUSED / UNFOCUSED) and FADE (OUT / DIM / IN). */
  private buildModeToggleRow<M extends string>(
    label: string,
    options: Array<readonly [M, string]>,
    initial: M,
    onSelect: (mode: M) => void,
  ): HTMLDivElement {
    const row = document.createElement("div");
    row.style.cssText = "display: flex; gap: 6px; align-items: center; margin-top: 2px;";
    row.appendChild(this.makeLabel(label));
    const buttons = new Map<M, HTMLButtonElement>();
    const refresh = (active: M): void => {
      for (const [m, b] of buttons) {
        const on = m === active;
        b.style.background = on ? "#2a3a55" : "#1a1a2a";
        b.style.color = on ? "#cce4ff" : "#aabbcc";
      }
    };
    for (const [mode, text] of options) {
      const btn = this.makeToggleButton(text, () => { refresh(mode); onSelect(mode); });
      buttons.set(mode, btn);
      row.appendChild(btn);
    }
    refresh(initial);
    return row;
  }

  private buildTextDurationBlock(
    textLabel: string, initialText: string,
    durationLabel: string, initialDuration: number | undefined,
    onTextChange: (val: string) => void,
    onDurationChange: (ms: number) => void,
  ): HTMLDivElement {
    const block = document.createElement("div");
    block.style.cssText = "display: flex; flex-direction: column; gap: 4px;";
    block.appendChild(this.makeLabel(textLabel));
    block.appendChild(this.makeTextarea(initialText, onTextChange));
    const durRow = document.createElement("div");
    durRow.style.cssText = "display: flex; gap: 6px; align-items: center;";
    durRow.appendChild(this.makeLabel(durationLabel));
    durRow.appendChild(this.makeNumberInput(String(initialDuration ?? ""), (val) => {
      const trimmed = val.trim();
      if (trimmed === "") onDurationChange(0);
      else onDurationChange(Math.max(0, Math.floor(Number(trimmed) || 0)));
    }));
    block.appendChild(durRow);
    return block;
  }

  private makeToggleButton(label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.style.cssText = `
      flex: 1; background: #1a1a2a; color: #aabbcc;
      border: 1px solid #445566; padding: 2px 6px;
      font-family: monospace; font-size: 10px; letter-spacing: 1px;
      cursor: pointer; white-space: nowrap;
    `;
    btn.addEventListener("click", onClick);
    return btn;
  }

  private refreshChips(chipBtns: Map<TriggerActionKind, HTMLButtonElement>, active: TriggerActionKind): void {
    for (const [k, btn] of chipBtns) {
      const on = k === active;
      btn.style.background = on ? "#2a3a55" : "#1a1a2a";
      btn.style.borderColor = on ? "#5588aa" : "#445566";
      btn.style.color = on ? "#cce4ff" : "#aabbcc";
    }
  }

  private refreshKindVisibility(blocks: Map<TriggerActionKind, HTMLElement>, active: TriggerActionKind): void {
    for (const [kind, el] of blocks) el.style.display = kind === active ? "" : "none";
  }

  private summarise(t: ComposedTrigger): string {
    const r = t.region;
    let tail = "";
    if (t.kind === "xp")    tail = ` (+${t.xpAmount ?? 0})`;
    else if (t.kind === "fade") tail = ` ${(t.fadeMode ?? "out").toUpperCase()}`;
    else if (t.kind === "speech" && t.entityRef) tail = ` ${t.entityRef}`;
    else if (t.kind === "set_flag") tail = ` ${(t.setFlagName ?? "?")}`;
    const when = t.whenEvent ?? "player_moved";
    const whenSuffix = when === "player_moved"
      ? `@ (${r.x},${r.y}) ${r.w}×${r.h}`
      : when === "encounter_started" ? "ON START"
      : when === "encounter_completed" ? "ON COMPLETE"
      : `ON FLAG ${(t.whenFlagName ?? "any")}`;
    return `${KIND_LABEL[t.kind]}${tail}  ${whenSuffix}`;
  }

  // ── DOM helpers ─────────────────────────────────────────────────────────

  private makeLabel(text: string): HTMLSpanElement {
    const el = document.createElement("span");
    el.textContent = text;
    el.style.cssText = "color: #778899; font-family: monospace; font-size: 9px; letter-spacing: 1px;";
    return el;
  }

  private makeNumberInput(initial: string, onInput: (val: string) => void): HTMLInputElement {
    const el = document.createElement("input");
    el.type = "number";
    el.value = initial;
    el.style.cssText = `
      background: #141426; color: #e0e8f0; border: 1px solid #445566;
      padding: 1px 4px; font-family: monospace; font-size: 11px;
      width: 50px; box-sizing: border-box;
    `;
    el.addEventListener("input", () => onInput(el.value));
    return el;
  }

  private makeTextInput(initial: string, placeholder: string, onInput: (val: string) => void): HTMLInputElement {
    const el = document.createElement("input");
    el.type = "text";
    el.value = initial;
    el.placeholder = placeholder;
    el.style.cssText = `
      background: #141426; color: #e0e8f0; border: 1px solid #445566;
      padding: 1px 6px; font-family: monospace; font-size: 11px;
      width: 100%; box-sizing: border-box;
    `;
    el.addEventListener("input", () => onInput(el.value));
    return el;
  }

  private makeTextarea(initial: string, onInput: (val: string) => void): HTMLTextAreaElement {
    const el = document.createElement("textarea");
    el.value = initial;
    el.rows = 2;
    el.style.cssText = `
      background: #141426; color: #e0e8f0; border: 1px solid #445566;
      padding: 2px 6px; font-family: monospace; font-size: 11px;
      line-height: 1.3; resize: none; width: 100%; box-sizing: border-box;
    `;
    el.addEventListener("input", () => onInput(el.value));
    return el;
  }

  private attachPlace(el: HTMLElement, x: number, y: number, w: number, h: number): void {
    const place = (): void => {
      const rect = this.scene.sys.game.canvas.getBoundingClientRect();
      const s = rect.width / this.opts.sceneWidth;
      el.style.left = `${rect.left + x * s}px`;
      el.style.top  = `${rect.top  + y * s}px`;
      el.style.width  = `${w * s}px`;
      el.style.height = `${h * s}px`;
      const basePx = el === this.addBtn ? 12 : el === this.titleEl ? 10 : 11;
      el.style.fontSize = `${basePx * s}px`;
    };
    place();
    this.scene.scale.on("resize", place);
    this.placeHandlers.push(place);
  }
}
