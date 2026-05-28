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

export type TriggerActionKind = "perception" | "log" | "aigm" | "combat";

export interface ComposedTrigger {
  id: string;
  region: { x: number; y: number; w: number; h: number };
  kind: TriggerActionKind;
  dc: number;
  passMessage: string;
  message: string;
  defId: string;
  defIds?: string[];
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
};

export class TriggerEditor {
  private readonly triggers: ComposedTrigger[] = [];
  private readonly rowElements: HTMLDivElement[] = [];
  private readonly scene: Phaser.Scene;
  private readonly opts: TriggerEditorOptions;
  private listEl!: HTMLDivElement;
  private addBtn!: HTMLButtonElement;
  private placeHandlers: Array<() => void> = [];
  private visible = true;

  constructor(opts: TriggerEditorOptions) {
    this.scene = opts.scene;
    this.opts = opts;
    const { scene, parent, x, y, width } = opts;

    parent.add(scene.add.text(x, y, "TRIGGERS — fires when the player enters the region", {
      fontSize: "10px", color: "#778899", fontFamily: "monospace", resolution: DPR, letterSpacing: 1,
    }).setOrigin(0, 0));

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

    // Kind chips row.
    const chipRow = document.createElement("div");
    chipRow.style.cssText = "display: flex; gap: 4px; margin-bottom: 6px;";
    const kinds: TriggerActionKind[] = ["perception", "log", "aigm", "combat"];
    const chipBtns = new Map<TriggerActionKind, HTMLButtonElement>();
    for (const k of kinds) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.textContent = KIND_LABEL[k];
      chip.style.cssText = `
        flex: 1; background: #1a1a2a; color: #aabbcc;
        border: 1px solid #445566; padding: 2px 4px;
        font-family: monospace; font-size: 9px; letter-spacing: 1px;
        cursor: pointer;
      `;
      chip.addEventListener("click", () => {
        trig.kind = k;
        this.refreshChips(chipBtns, trig.kind);
        this.refreshKindVisibility(perceptionBlock, logBlock, aigmBlock, combatBlock, trig.kind);
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

    // Per-kind config blocks (only the active one is visible).
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
    row.appendChild(perceptionBlock);

    const logBlock = document.createElement("div");
    logBlock.appendChild(this.makeLabel("LOG MESSAGE"));
    logBlock.appendChild(this.makeTextarea(trig.message, (val) => {
      trig.message = val;
      this.opts.onChange?.();
    }));
    row.appendChild(logBlock);

    const aigmBlock = document.createElement("div");
    aigmBlock.appendChild(this.makeLabel("AIGM CUE"));
    aigmBlock.appendChild(this.makeTextarea(trig.message, (val) => {
      trig.message = val;
      this.opts.onChange?.();
    }));
    row.appendChild(aigmBlock);

    const combatBlock = document.createElement("div");
    combatBlock.appendChild(this.makeLabel("DEF ID (optional — flips this id to enemy)"));
    combatBlock.appendChild(this.makeTextInput(trig.defId, "e.g. cultist", (val) => {
      trig.defId = val.trim();
      this.opts.onChange?.();
    }));
    row.appendChild(combatBlock);

    this.refreshChips(chipBtns, trig.kind);
    this.refreshKindVisibility(perceptionBlock, logBlock, aigmBlock, combatBlock, trig.kind);
    void regionInputs;
    return row;
  }

  private refreshChips(chipBtns: Map<TriggerActionKind, HTMLButtonElement>, active: TriggerActionKind): void {
    for (const [k, btn] of chipBtns) {
      const on = k === active;
      btn.style.background = on ? "#2a3a55" : "#1a1a2a";
      btn.style.borderColor = on ? "#5588aa" : "#445566";
      btn.style.color = on ? "#cce4ff" : "#aabbcc";
    }
  }

  private refreshKindVisibility(
    perception: HTMLElement, log: HTMLElement, aigm: HTMLElement, combat: HTMLElement,
    active: TriggerActionKind,
  ): void {
    perception.style.display = active === "perception" ? "" : "none";
    log.style.display        = active === "log"        ? "" : "none";
    aigm.style.display       = active === "aigm"       ? "" : "none";
    combat.style.display     = active === "combat"     ? "" : "none";
  }

  private summarise(t: ComposedTrigger): string {
    const r = t.region;
    return `${KIND_LABEL[t.kind]}  @ (${r.x},${r.y}) ${r.w}×${r.h}`;
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
      el.style.fontSize = `${(el === this.addBtn ? 12 : 11) * s}px`;
    };
    place();
    this.scene.scale.on("resize", place);
    this.placeHandlers.push(place);
  }
}
