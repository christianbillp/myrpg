/**
 * TriggerEditor — inline UI for authoring encounter triggers from the
 * Deterministic tab of `GenerateSetupScene`. Each trigger is a rectangular
 * region on the map plus one of four action templates (perception check,
 * log message, AIGM cue, start combat). The component owns its trigger
 * list; the scene reads it via `getTriggers()` when composing the encounter.
 *
 * Rendering mixes Phaser primitives (labels, framing rects, chips, buttons)
 * for layout with absolutely-positioned HTML inputs for editable text and
 * numbers. The inputs reposition themselves on `scale.resize`, mirroring
 * how `GenerateSetupScene.buildTextarea` already does it.
 */
import Phaser from "phaser";

const DPR = window.devicePixelRatio;
// Each trigger card has four stacked sub-rows (summary, kind chips, region,
// per-kind config) and is sized so two cards + the header + the ADD button
// roughly match the MonsterPicker's footprint in the shared picker band.
const ROW_H = 88;
const ADD_BTN_H = 28;
const MAX_VISIBLE_TRIGGERS = 2;

export type TriggerActionKind = "perception" | "log" | "aigm" | "combat";

export interface ComposedTrigger {
  id: string;
  region: { x: number; y: number; w: number; h: number };
  kind: TriggerActionKind;
  // Per-kind config — only the fields for the selected kind are used.
  dc: number;          // perception
  passMessage: string; // perception
  message: string;     // log + aigm
  defId: string;       // combat — single defId for hand-authored flip
  /**
   * Bulk-flip list for combat triggers — used by the RANDOMIZE flow to flip
   * every rolled monster type to enemy when the trigger fires. Coexists with
   * `defId`; the server unions both into a deduped flip list. The editor UI
   * doesn't expose this field — it's only set programmatically.
   */
  defIds?: string[];
}

export interface TriggerEditorOptions {
  scene: Phaser.Scene;
  parent: Phaser.GameObjects.Container;
  x: number;
  y: number;
  width: number;
  /** Scene width in logical pixels — used to scale absolutely-positioned DOM inputs. */
  sceneWidth: number;
  /** Map dimensions, used to clamp region inputs so they can't extend past the map. */
  mapW: number;
  mapH: number;
  /** Called whenever triggers change so the scene can refresh button enable-state etc. */
  onChange?: () => void;
  /** Pre-seed the editor with triggers (used by the RANDOMIZE flow). */
  initialTriggers?: ComposedTrigger[];
}

interface TriggerRowElements {
  card: Phaser.GameObjects.Rectangle;
  summary: Phaser.GameObjects.Text;
  removeBg: Phaser.GameObjects.Rectangle;
  removeLabel: Phaser.GameObjects.Text;
  kindChips: Map<TriggerActionKind, { bg: Phaser.GameObjects.Rectangle; label: Phaser.GameObjects.Text }>;
  regionInputs: HTMLInputElement[];   // [x, y, w, h]
  dcInput: HTMLInputElement;
  passMessageInput: HTMLTextAreaElement;
  messageInput: HTMLTextAreaElement;
  defIdInput: HTMLInputElement;
  // Phaser labels we toggle visibility on to show only the active kind's config.
  kindLabels: { perception: Phaser.GameObjects.Text[]; log: Phaser.GameObjects.Text[]; aigm: Phaser.GameObjects.Text[]; combat: Phaser.GameObjects.Text[] };
}

const KIND_LABEL: Record<TriggerActionKind, string> = {
  perception: "PERCEPTION",
  log: "LOG",
  aigm: "AIGM CUE",
  combat: "START COMBAT",
};

export class TriggerEditor {
  private readonly triggers: ComposedTrigger[] = [];
  private readonly rows: TriggerRowElements[] = [];
  private readonly scrollContainer: Phaser.GameObjects.Container;
  private addBg!: Phaser.GameObjects.Rectangle;
  private addLabel!: Phaser.GameObjects.Text;
  private placeHandlers: Array<() => void> = [];

  constructor(private readonly opts: TriggerEditorOptions) {
    const { scene, parent, x, y, width } = opts;

    parent.add(scene.add.text(x, y, "TRIGGERS — fires when the player enters the region", {
      fontSize: "10px", color: "#778899", fontFamily: "monospace", resolution: DPR, letterSpacing: 1,
    }).setOrigin(0, 0));

    // Backing rect for the scroll area.
    const scrollH = ROW_H * MAX_VISIBLE_TRIGGERS;
    const scrollY = y + 18;
    parent.add(scene.add.rectangle(x + width / 2, scrollY + scrollH / 2, width, scrollH, 0x0a0e16).setStrokeStyle(1, 0x334455));
    this.scrollContainer = scene.add.container(x, scrollY);
    parent.add(this.scrollContainer);
    const mask = scene.make.graphics({ x: 0, y: 0 }, false);
    mask.fillStyle(0xffffff).fillRect(x, scrollY, width, scrollH);
    this.scrollContainer.setMask(mask.createGeometryMask());

    // ADD TRIGGER button beneath the scroll area.
    const addY = scrollY + scrollH + 12;
    this.addBg = scene.add.rectangle(x + width / 2, addY, width, ADD_BTN_H, 0x2a3a55).setStrokeStyle(1, 0x5588aa).setInteractive({ useHandCursor: true });
    this.addLabel = scene.add.text(x + width / 2, addY, "+ ADD TRIGGER", {
      fontSize: "12px", color: "#cce4ff", fontFamily: "monospace", resolution: DPR, letterSpacing: 1,
    }).setOrigin(0.5);
    this.addBg.on("pointerdown", () => this.addTrigger());
    parent.add(this.addBg);
    parent.add(this.addLabel);

    // Seed from initial triggers if any were supplied (RANDOMIZE flow).
    if (opts.initialTriggers && opts.initialTriggers.length > 0) {
      for (const t of opts.initialTriggers.slice(0, MAX_VISIBLE_TRIGGERS)) {
        this.triggers.push({ ...t, region: { ...t.region } });
      }
      this.rebuildRows();
    }
  }

  /** Total vertical pixels the editor occupies (header + scroll + add button). Useful for stacking below. */
  totalHeight(): number {
    return 18 + ROW_H * MAX_VISIBLE_TRIGGERS + 12 + ADD_BTN_H;
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
    for (const row of this.rows) this.removeRowDom(row);
    this.rows.length = 0;
    for (const h of this.placeHandlers) this.opts.scene.scale.off("resize", h);
    this.placeHandlers = [];
  }

  /**
   * Show / hide every DOM input the editor owns. Called by the tab toggle
   * when the user flips between MONSTERS and TRIGGERS. Phaser objects are
   * already toggled by the parent container's `setVisible`.
   */
  setVisible(visible: boolean): void {
    const collect = (row: TriggerRowElements): HTMLElement[] => [...row.regionInputs, row.dcInput, row.passMessageInput, row.messageInput, row.defIdInput];
    for (const row of this.rows) {
      for (const el of collect(row)) {
        // When showing, restore only the inputs that match the row's active
        // kind — refreshKindVisibility owns the per-kind display logic, so
        // re-running it does the right thing. When hiding, force all off.
        el.style.display = visible ? "" : "none";
      }
      if (visible) this.refreshKindVisibility(row, this.triggers[this.rows.indexOf(row)].kind);
    }
  }

  // ── Trigger lifecycle ────────────────────────────────────────────────────

  private addTrigger(): void {
    if (this.triggers.length >= MAX_VISIBLE_TRIGGERS) return;
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
  }

  private removeTrigger(index: number): void {
    this.triggers.splice(index, 1);
    this.rebuildRows();
    this.opts.onChange?.();
  }

  // ── Row rendering ───────────────────────────────────────────────────────

  /** Tear down and rebuild all rows — simpler than diffing for a list this small. */
  private rebuildRows(): void {
    for (const row of this.rows) this.removeRowDom(row);
    this.rows.length = 0;
    this.scrollContainer.removeAll(true);
    for (let i = 0; i < this.triggers.length; i++) {
      const row = this.buildRow(this.triggers[i], i);
      this.rows.push(row);
    }
  }

  private buildRow(trig: ComposedTrigger, i: number): TriggerRowElements {
    const { scene, width } = this.opts;
    const top = i * ROW_H;
    const cardW = width - 8;

    const card = scene.add.rectangle(width / 2, top + ROW_H / 2, cardW, ROW_H - 4, i % 2 === 0 ? 0x111122 : 0x141426).setStrokeStyle(1, 0x334455);
    this.scrollContainer.add(card);

    const summary = scene.add.text(10, top + 6, this.summarise(trig), {
      fontSize: "10px", color: "#e2b96f", fontFamily: "monospace", resolution: DPR,
    }).setOrigin(0, 0);
    this.scrollContainer.add(summary);

    const removeBg = scene.add.rectangle(width - 30, top + 12, 48, 14, 0x551a1a).setStrokeStyle(1, 0xaa4444).setInteractive({ useHandCursor: true });
    const removeLabel = scene.add.text(width - 30, top + 12, "REMOVE", {
      fontSize: "9px", color: "#ffcccc", fontFamily: "monospace", resolution: DPR, letterSpacing: 1,
    }).setOrigin(0.5);
    removeBg.on("pointerdown", () => this.removeTrigger(i));
    this.scrollContainer.add(removeBg);
    this.scrollContainer.add(removeLabel);

    // Kind chips row (4 chips ~ 80px each).
    const kindChips = new Map<TriggerActionKind, { bg: Phaser.GameObjects.Rectangle; label: Phaser.GameObjects.Text }>();
    const kinds: TriggerActionKind[] = ["perception", "log", "aigm", "combat"];
    const chipW = 90, chipH = 16;
    kinds.forEach((k, idx) => {
      const cx = 10 + idx * (chipW + 4) + chipW / 2;
      const cy = top + 26;
      const bg = scene.add.rectangle(cx, cy, chipW, chipH, 0x1a1a2a).setStrokeStyle(1, 0x445566).setInteractive({ useHandCursor: true });
      const lbl = scene.add.text(cx, cy, KIND_LABEL[k], {
        fontSize: "9px", color: "#aabbcc", fontFamily: "monospace", resolution: DPR, letterSpacing: 1,
      }).setOrigin(0.5);
      bg.on("pointerdown", () => {
        trig.kind = k;
        this.refreshChips(row, trig.kind);
        this.refreshKindVisibility(row, trig.kind);
        summary.setText(this.summarise(trig));
        this.opts.onChange?.();
      });
      this.scrollContainer.add(bg);
      this.scrollContainer.add(lbl);
      kindChips.set(k, { bg, label: lbl });
    });

    // Region inputs (4 little number boxes — x, y, w, h).
    const regionLabel = scene.add.text(10, top + 46, "REGION  x", { fontSize: "9px", color: "#778899", fontFamily: "monospace", resolution: DPR }).setOrigin(0, 0);
    this.scrollContainer.add(regionLabel);
    const regionInputs: HTMLInputElement[] = [];
    const labelNames = ["x", "y", "w", "h"];
    const labelXs = [80, 145, 210, 275];
    labelNames.forEach((nm, k) => {
      const lbl = scene.add.text(labelXs[k] - 18, top + 46, nm, { fontSize: "9px", color: "#778899", fontFamily: "monospace", resolution: DPR }).setOrigin(0, 0);
      this.scrollContainer.add(lbl);
      const sceneX = this.opts.x + labelXs[k] - 8;
      const sceneY = this.opts.y + 18 + top + 42;
      const input = this.buildNumberInput(sceneX, sceneY, 50, 18, String(k === 2 || k === 3 ? trig.region.w : 0), (val) => {
        const n = Math.max(0, Math.floor(Number(val) || 0));
        if (k === 0) trig.region.x = Math.min(n, this.opts.mapW - 1);
        else if (k === 1) trig.region.y = Math.min(n, this.opts.mapH - 1);
        else if (k === 2) trig.region.w = Math.max(1, Math.min(n, this.opts.mapW - trig.region.x));
        else            trig.region.h = Math.max(1, Math.min(n, this.opts.mapH - trig.region.y));
        summary.setText(this.summarise(trig));
        this.opts.onChange?.();
      });
      input.value = String(k === 0 ? trig.region.x : k === 1 ? trig.region.y : k === 2 ? trig.region.w : trig.region.h);
      regionInputs.push(input);
    });

    // Kind-specific config rows (one set of inputs per kind; only the active one is visible).
    const cfgY = top + 66;
    // Perception: DC + pass message.
    const dcLabel = scene.add.text(10, cfgY, "DC", { fontSize: "9px", color: "#778899", fontFamily: "monospace", resolution: DPR }).setOrigin(0, 0);
    this.scrollContainer.add(dcLabel);
    const dcInput = this.buildNumberInput(this.opts.x + 32, this.opts.y + 18 + cfgY - 4, 50, 18, String(trig.dc), (val) => {
      trig.dc = Math.max(1, Math.min(30, Math.floor(Number(val) || 10)));
      summary.setText(this.summarise(trig));
      this.opts.onChange?.();
    });
    const passLabel = scene.add.text(90, cfgY, "PASS MSG", { fontSize: "9px", color: "#778899", fontFamily: "monospace", resolution: DPR }).setOrigin(0, 0);
    this.scrollContainer.add(passLabel);
    const passInput = this.buildTextareaInput(this.opts.x + 152, this.opts.y + 18 + cfgY - 4, width - 162, 20, trig.passMessage, (val) => {
      trig.passMessage = val;
      this.opts.onChange?.();
    });

    // Log + AIGM: single message textarea (shared box per kind so they don't trample each other).
    const msgLabel = scene.add.text(10, cfgY, "MESSAGE", { fontSize: "9px", color: "#778899", fontFamily: "monospace", resolution: DPR }).setOrigin(0, 0);
    this.scrollContainer.add(msgLabel);
    const messageInput = this.buildTextareaInput(this.opts.x + 72, this.opts.y + 18 + cfgY - 4, width - 82, 20, trig.message, (val) => {
      trig.message = val;
      this.opts.onChange?.();
    });

    // Combat: defId input.
    const defIdLabel = scene.add.text(10, cfgY, "DEF ID (optional)", { fontSize: "9px", color: "#778899", fontFamily: "monospace", resolution: DPR }).setOrigin(0, 0);
    this.scrollContainer.add(defIdLabel);
    const defIdInput = this.buildTextInput(this.opts.x + 130, this.opts.y + 18 + cfgY - 4, width - 140, 18, trig.defId, "e.g. cultist (flips to enemy)", (val) => {
      trig.defId = val.trim();
      this.opts.onChange?.();
    });

    const row: TriggerRowElements = {
      card, summary, removeBg, removeLabel, kindChips, regionInputs, dcInput, passMessageInput: passInput, messageInput, defIdInput,
      kindLabels: { perception: [dcLabel, passLabel], log: [msgLabel], aigm: [msgLabel], combat: [defIdLabel] },
    };
    this.refreshChips(row, trig.kind);
    this.refreshKindVisibility(row, trig.kind);
    return row;
  }

  private refreshChips(row: TriggerRowElements, active: TriggerActionKind): void {
    for (const [k, chip] of row.kindChips) {
      const on = k === active;
      chip.bg.setFillStyle(on ? 0x2a3a55 : 0x1a1a2a, on ? 1 : 1).setStrokeStyle(2, on ? 0x5588aa : 0x445566);
      chip.label.setColor(on ? "#cce4ff" : "#aabbcc");
    }
  }

  /** Show / hide the per-kind config rows. We can't unmount the DOM inputs
   *  cheaply, so we just toggle their CSS display.  */
  private refreshKindVisibility(row: TriggerRowElements, active: TriggerActionKind): void {
    const set = (el: HTMLElement, show: boolean) => { el.style.display = show ? "" : "none"; };
    const showPerception = active === "perception";
    const showLogOrAigm = active === "log" || active === "aigm";
    const showCombat = active === "combat";
    set(row.dcInput, showPerception);
    set(row.passMessageInput, showPerception);
    set(row.messageInput, showLogOrAigm);
    set(row.defIdInput, showCombat);
    // Phaser labels — must also toggle so the prompt text doesn't bleed
    // through behind the active inputs.
    for (const lbl of row.kindLabels.perception) lbl.setVisible(showPerception);
    for (const lbl of row.kindLabels.log) lbl.setVisible(showLogOrAigm);
    for (const lbl of row.kindLabels.combat) lbl.setVisible(showCombat);
  }

  private summarise(t: ComposedTrigger): string {
    const r = t.region;
    const tag = KIND_LABEL[t.kind];
    return `${tag}  @ (${r.x},${r.y}) ${r.w}×${r.h}`;
  }

  private removeRowDom(row: TriggerRowElements): void {
    const els: HTMLElement[] = [...row.regionInputs, row.dcInput, row.passMessageInput, row.messageInput, row.defIdInput];
    for (const el of els) el.remove();
  }

  // ── DOM input helpers (mirror GenerateSetupScene.buildTextarea pattern). ──

  private buildNumberInput(x: number, y: number, w: number, h: number, initial: string, onInput: (val: string) => void): HTMLInputElement {
    const el = document.createElement("input");
    el.type = "number";
    el.value = initial;
    el.style.cssText = `
      position: absolute; background: #141426; color: #e0e8f0;
      border: 1px solid #445566; padding: 0 6px;
      font-family: monospace; font-size: 11px; z-index: 10; box-sizing: border-box;
    `;
    document.body.appendChild(el);
    this.attachPlace(el, x, y, w, h);
    el.oninput = () => onInput(el.value);
    return el;
  }

  private buildTextInput(x: number, y: number, w: number, h: number, initial: string, placeholder: string, onInput: (val: string) => void): HTMLInputElement {
    const el = document.createElement("input");
    el.type = "text";
    el.value = initial;
    el.placeholder = placeholder;
    el.style.cssText = `
      position: absolute; background: #141426; color: #e0e8f0;
      border: 1px solid #445566; padding: 0 6px;
      font-family: monospace; font-size: 11px; z-index: 10; box-sizing: border-box;
    `;
    document.body.appendChild(el);
    this.attachPlace(el, x, y, w, h);
    el.oninput = () => onInput(el.value);
    return el;
  }

  private buildTextareaInput(x: number, y: number, w: number, h: number, initial: string, onInput: (val: string) => void): HTMLTextAreaElement {
    const el = document.createElement("textarea");
    el.value = initial;
    el.style.cssText = `
      position: absolute; background: #141426; color: #e0e8f0;
      border: 1px solid #445566; padding: 2px 6px;
      font-family: monospace; font-size: 11px; line-height: 1.2;
      resize: none; z-index: 10; box-sizing: border-box;
    `;
    document.body.appendChild(el);
    this.attachPlace(el, x, y, w, h);
    el.oninput = () => onInput(el.value);
    return el;
  }

  private attachPlace(el: HTMLElement, x: number, y: number, w: number, h: number): void {
    const place = () => {
      const rect = this.opts.scene.sys.game.canvas.getBoundingClientRect();
      const s = rect.width / this.opts.sceneWidth;
      el.style.left = `${rect.left + x * s}px`;
      el.style.top  = `${rect.top + y * s}px`;
      el.style.width  = `${w * s}px`;
      el.style.height = `${h * s}px`;
      el.style.fontSize = `${11 * s}px`;
    };
    place();
    this.opts.scene.scale.on("resize", place);
    this.placeHandlers.push(place);
  }
}
