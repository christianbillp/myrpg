/**
 * TriggerEditor — inline UI for authoring encounter triggers from the
 * Adjudicator-tab of `GenerateSetupScene` and from `EncounterEditorScene`.
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
  | "supertitle" | "announcement" | "speech" | "fade";

export interface ComposedTrigger {
  id: string;
  region: { x: number; y: number; w: number; h: number };
  kind: TriggerActionKind;
  dc: number;
  passMessage: string;
  message: string;
  defId: string;
  defIds?: string[];
  /** Amount granted by an `xp` trigger. Optional; defaults to 0 (no-op). */
  xpAmount?: number;
  /** Hold time (ms) for `supertitle` / `announcement`; fade time for `fade`. */
  durationMs?: number;
  /** Entity ref for `speech` (e.g. `player`, `npc_<id>`, `enemy_A`). */
  entityRef?: string;
  /** Direction for `fade`. `dim` holds the overlay at 50% black (world still visible). */
  fadeMode?: "in" | "out" | "dim";
  /** Style for `announcement`. `focused` hides side panels + locks input + pauses world; `unfocused` keeps the UI live. */
  announcementMode?: "focused" | "unfocused";
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
  supertitle: "SUPERTITLE",
  announcement: "ANNOUNCE",
  speech: "SPEECH",
  fade: "FADE",
};

const KIND_TOOLTIP: Record<TriggerActionKind, string> = {
  perception: "Roll a Perception check vs DC. On pass, show the log line.",
  log: "Write a line to the Event Log.",
  aigm: "Queue a cue for the AIGM's next reply.",
  combat: "Flip the named def to enemy and start combat.",
  xp: "Award the player XP.",
  supertitle: "Show a movie-style centered title (huge white text).",
  announcement: "Show a centered announcement card; mirrored to the Event Log.",
  speech: "Show a speech bubble above the named entity's token.",
  fade: "Fade the screen to or from black. Pair an OUT with an IN.",
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

    // Summary line + REMOVE button.
    const head = document.createElement("div");
    head.style.cssText = "display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;";
    const summary = document.createElement("span");
    summary.style.color = "#e2b96f";
    summary.textContent = this.summarise(trig);
    head.appendChild(summary);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "REMOVE";
    remove.style.cssText = `
      background: #551a1a; color: #ffcccc; border: 1px solid #aa4444;
      padding: 1px 8px; font-family: monospace; font-size: 9px;
      cursor: pointer; letter-spacing: 1px;
    `;
    remove.addEventListener("click", () => this.removeTrigger(i));
    head.appendChild(remove);
    row.appendChild(head);

    // Kind chips row. With 9 chip kinds we wrap onto two rows so each chip
    // stays readable rather than getting squeezed to a few pixels.
    const chipRow = document.createElement("div");
    chipRow.style.cssText = "display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px;";
    const kinds: TriggerActionKind[] = [
      "perception", "log", "aigm", "combat", "xp",
      "supertitle", "announcement", "speech", "fade",
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
        summary.textContent = this.summarise(trig);
        this.opts.onChange?.();
      });
      chipBtns.set(k, chip);
      chipRow.appendChild(chip);
    }
    row.appendChild(chipRow);

    // Region inputs.
    const regionRow = document.createElement("div");
    regionRow.style.cssText = "display: flex; gap: 6px; margin-bottom: 6px; align-items: center;";
    regionRow.appendChild(this.makeLabel("REGION"));
    const regionInputs: HTMLInputElement[] = [];
    const labelNames: Array<keyof { x: 1; y: 1; w: 1; h: 1 }> = ["x", "y", "w", "h"];
    for (const nm of labelNames) {
      regionRow.appendChild(this.makeLabel(nm));
      const input = this.makeNumberInput(String(trig.region[nm]), (val) => {
        const n = Math.max(0, Math.floor(Number(val) || 0));
        if (nm === "x") trig.region.x = Math.min(n, this.opts.mapW - 1);
        else if (nm === "y") trig.region.y = Math.min(n, this.opts.mapH - 1);
        else if (nm === "w") trig.region.w = Math.max(1, Math.min(n, this.opts.mapW - trig.region.x));
        else trig.region.h = Math.max(1, Math.min(n, this.opts.mapH - trig.region.y));
        summary.textContent = this.summarise(trig);
        this.opts.onChange?.();
      });
      regionInputs.push(input);
      regionRow.appendChild(input);
    }
    row.appendChild(regionRow);

    // Per-kind config blocks (only the active one is visible). One block per
    // TriggerActionKind, keyed in a Map so adding a new kind only requires
    // appending one entry plus a chip — no extra branches in the toggle.
    const blocks = new Map<TriggerActionKind, HTMLElement>();

    const perceptionBlock = document.createElement("div");
    perceptionBlock.style.cssText = "display: flex; flex-direction: column; gap: 4px;";
    const dcRow = document.createElement("div");
    dcRow.style.cssText = "display: flex; gap: 6px; align-items: center;";
    dcRow.appendChild(this.makeLabel("DC"));
    dcRow.appendChild(this.makeNumberInput(String(trig.dc), (val) => {
      trig.dc = Math.max(1, Math.min(30, Math.floor(Number(val) || 10)));
      summary.textContent = this.summarise(trig);
      this.opts.onChange?.();
    }));
    perceptionBlock.appendChild(dcRow);
    perceptionBlock.appendChild(this.makeLabel("PASS MESSAGE"));
    perceptionBlock.appendChild(this.makeTextarea(trig.passMessage, (val) => {
      trig.passMessage = val;
      this.opts.onChange?.();
    }));
    blocks.set("perception", perceptionBlock);

    const logBlock = document.createElement("div");
    logBlock.appendChild(this.makeLabel("LOG MESSAGE"));
    logBlock.appendChild(this.makeTextarea(trig.message, (val) => {
      trig.message = val;
      this.opts.onChange?.();
    }));
    blocks.set("log", logBlock);

    const aigmBlock = document.createElement("div");
    aigmBlock.appendChild(this.makeLabel("AIGM CUE"));
    aigmBlock.appendChild(this.makeTextarea(trig.message, (val) => {
      trig.message = val;
      this.opts.onChange?.();
    }));
    blocks.set("aigm", aigmBlock);

    const combatBlock = document.createElement("div");
    combatBlock.appendChild(this.makeLabel("DEF ID (optional — flips this id to enemy)"));
    combatBlock.appendChild(this.makeTextInput(trig.defId, "e.g. cultist", (val) => {
      trig.defId = val.trim();
      this.opts.onChange?.();
    }));
    blocks.set("combat", combatBlock);

    const xpBlock = document.createElement("div");
    const xpRow = document.createElement("div");
    xpRow.style.cssText = "display: flex; gap: 6px; align-items: center;";
    xpRow.appendChild(this.makeLabel("AMOUNT"));
    xpRow.appendChild(this.makeNumberInput(String(trig.xpAmount ?? 0), (val) => {
      trig.xpAmount = Math.max(0, Math.floor(Number(val) || 0));
      summary.textContent = this.summarise(trig);
      this.opts.onChange?.();
    }));
    xpBlock.appendChild(xpRow);
    blocks.set("xp", xpBlock);

    const supertitleBlock = this.buildTextDurationBlock(
      "TITLE TEXT", trig.message, "DURATION (ms, default 3000)", trig.durationMs,
      (text) => { trig.message = text; this.opts.onChange?.(); },
      (ms)   => { trig.durationMs = ms; this.opts.onChange?.(); },
    );
    blocks.set("supertitle", supertitleBlock);

    const announcementBlock = this.buildTextDurationBlock(
      "ANNOUNCEMENT TEXT", trig.message, "DURATION (ms, default 3500)", trig.durationMs,
      (text) => { trig.message = text; this.opts.onChange?.(); },
      (ms)   => { trig.durationMs = ms; this.opts.onChange?.(); },
    );
    // Mode toggle: FOCUSED (orange-bordered, hides UI, pauses world, locks
    // input) vs UNFOCUSED (borderless edge-fade card, UI stays live).
    const announceModeRow = document.createElement("div");
    announceModeRow.style.cssText = "display: flex; gap: 6px; align-items: center; margin-top: 2px;";
    announceModeRow.appendChild(this.makeLabel("MODE"));
    const announceButtons = new Map<"focused" | "unfocused", HTMLButtonElement>();
    const refreshAnnounceButtons = (active: "focused" | "unfocused"): void => {
      for (const [m, b] of announceButtons) {
        const on = m === active;
        b.style.background = on ? "#2a3a55" : "#1a1a2a";
        b.style.color = on ? "#cce4ff" : "#aabbcc";
      }
    };
    const makeAnnounceBtn = (mode: "focused" | "unfocused", label: string): HTMLButtonElement => {
      const btn = this.makeToggleButton(label, () => {
        trig.announcementMode = mode;
        refreshAnnounceButtons(mode);
        this.opts.onChange?.();
      });
      announceButtons.set(mode, btn);
      return btn;
    };
    announceModeRow.appendChild(makeAnnounceBtn("focused", "FOCUSED"));
    announceModeRow.appendChild(makeAnnounceBtn("unfocused", "UNFOCUSED"));
    refreshAnnounceButtons(trig.announcementMode ?? "focused");
    announcementBlock.appendChild(announceModeRow);
    blocks.set("announcement", announcementBlock);

    const speechBlock = document.createElement("div");
    speechBlock.style.cssText = "display: flex; flex-direction: column; gap: 4px;";
    speechBlock.appendChild(this.makeLabel("ENTITY (player, npc_<id>, enemy_A, ally_A)"));
    speechBlock.appendChild(this.makeTextInput(trig.entityRef ?? "", "e.g. npc_wanderer_0", (val) => {
      trig.entityRef = val.trim();
      summary.textContent = this.summarise(trig);
      this.opts.onChange?.();
    }));
    speechBlock.appendChild(this.makeLabel("SPOKEN LINE"));
    speechBlock.appendChild(this.makeTextarea(trig.message, (val) => {
      trig.message = val;
      this.opts.onChange?.();
    }));
    blocks.set("speech", speechBlock);

    const fadeBlock = document.createElement("div");
    fadeBlock.style.cssText = "display: flex; flex-direction: column; gap: 4px;";
    const fadeModeRow = document.createElement("div");
    fadeModeRow.style.cssText = "display: flex; gap: 6px; align-items: center;";
    fadeModeRow.appendChild(this.makeLabel("MODE"));
    const fadeButtons = new Map<"in" | "out" | "dim", HTMLButtonElement>();
    const refreshFadeButtons = (active: "in" | "out" | "dim"): void => {
      for (const [m, b] of fadeButtons) {
        const on = m === active;
        b.style.background = on ? "#2a3a55" : "#1a1a2a";
        b.style.color = on ? "#cce4ff" : "#aabbcc";
      }
    };
    const makeFadeBtn = (mode: "in" | "out" | "dim", label: string): HTMLButtonElement => {
      const btn = this.makeToggleButton(label, () => {
        trig.fadeMode = mode;
        refreshFadeButtons(mode);
        summary.textContent = this.summarise(trig);
        this.opts.onChange?.();
      });
      fadeButtons.set(mode, btn);
      return btn;
    };
    fadeModeRow.appendChild(makeFadeBtn("out", "FADE OUT"));
    fadeModeRow.appendChild(makeFadeBtn("dim", "FADE DIM (50%)"));
    fadeModeRow.appendChild(makeFadeBtn("in", "FADE IN"));
    refreshFadeButtons(trig.fadeMode ?? "out");
    fadeBlock.appendChild(fadeModeRow);
    const fadeDurRow = document.createElement("div");
    fadeDurRow.style.cssText = "display: flex; gap: 6px; align-items: center;";
    fadeDurRow.appendChild(this.makeLabel("DURATION (ms, default 1200)"));
    fadeDurRow.appendChild(this.makeNumberInput(String(trig.durationMs ?? 1200), (val) => {
      trig.durationMs = Math.max(0, Math.floor(Number(val) || 0));
      this.opts.onChange?.();
    }));
    fadeBlock.appendChild(fadeDurRow);
    blocks.set("fade", fadeBlock);

    for (const block of blocks.values()) row.appendChild(block);

    this.refreshChips(chipBtns, trig.kind);
    this.refreshKindVisibility(blocks, trig.kind);
    void regionInputs;
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
    return `${KIND_LABEL[t.kind]}${tail}  @ (${r.x},${r.y}) ${r.w}×${r.h}`;
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
