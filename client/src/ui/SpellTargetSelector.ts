/**
 * SpellTargetSelector — second-step picker for SRD "creature of your choice"
 * AOE spells (Sleep, …). After the AOE click places the area, this modal
 * lists every creature inside the area as a toggleable chip so the caster
 * can choose which ones to actually affect. Allies default to *unchecked*
 * (the assumption is the wizard isn't trying to sleep their own party);
 * non-allies default to *checked*.
 *
 * CONFIRM fires the cast with the chosen target ids; CANCEL aborts without
 * consuming the slot. Backdrop click also cancels.
 */
import { UIScale } from "./UIScale";
import { GRID_ROWS, TILE_SIZE, HUD_HEIGHT } from "../constants";

const GAME_H = GRID_ROWS * TILE_SIZE + HUD_HEIGHT;
const ACCENT = "#9ac8ff";
const PANEL_W = 480;
const PANEL_H = 360;

export interface SpellTargetCandidate {
  id: string;
  /** Display label shown in the chip (e.g. "Bridge Bandit (A)"). */
  label: string;
  /** True for ally / friendly creatures — used to default-unselect the chip. */
  isAlly: boolean;
}

export class SpellTargetSelector {
  private readonly backdropEl: HTMLDivElement;
  private readonly offResize: () => void;
  private readonly selected: Set<string>;

  constructor(
    scale: UIScale,
    spellName: string,
    candidates: SpellTargetCandidate[],
    onConfirm: (ids: string[]) => void,
    onCancel: () => void,
  ) {
    // Defaults: every non-ally pre-checked, allies left unchecked.
    this.selected = new Set(candidates.filter((c) => !c.isAlly).map((c) => c.id));

    this.backdropEl = document.createElement("div");
    this.backdropEl.className = "gui-overlay";
    this.backdropEl.addEventListener("pointerdown", (e) => {
      if (e.target === this.backdropEl) {
        onCancel();
        this.destroy();
      }
    });

    const panel = document.createElement("div");
    panel.className = "gui-modal";
    panel.style.cssText += `
      width: ${PANEL_W}px; height: ${PANEL_H}px; border: 2px solid ${ACCENT};
      padding: 22px; box-sizing: border-box; display: flex; flex-direction: column; gap: 12px;
    `;

    const header = document.createElement("div");
    header.textContent = `${spellName.toUpperCase()} — choose creatures to affect`;
    header.style.cssText = "font-size: 13px; color: #cce4ff; letter-spacing: 2px;";
    panel.appendChild(header);

    const help = document.createElement("div");
    help.textContent = "Tick the creatures in the area you want to target. Allies are unchecked by default.";
    help.style.cssText = "font-size: 11px; color: #778899; line-height: 1.5;";
    panel.appendChild(help);

    const counter = document.createElement("div");
    counter.style.cssText = "font-size: 11px; color: #88aacc;";
    const updateCounter = () => {
      counter.textContent = `${this.selected.size} / ${candidates.length} selected`;
    };
    updateCounter();
    panel.appendChild(counter);

    const list = document.createElement("div");
    list.style.cssText = "display: flex; flex-direction: column; gap: 6px; overflow-y: auto; flex: 1; min-height: 0;";

    if (candidates.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No creatures in the area.";
      empty.style.cssText = "font-size: 11px; color: #556677; font-style: italic; padding: 6px 0;";
      list.appendChild(empty);
    }

    for (const c of candidates) {
      const chip = document.createElement("button");
      chip.style.cssText = this.chipCss(this.selected.has(c.id), c.isAlly);
      chip.dataset.npcId = c.id;
      chip.textContent = `${this.selected.has(c.id) ? "✓ " : "  "}${c.label}${c.isAlly ? "  (ally)" : ""}`;
      chip.addEventListener("click", () => {
        if (this.selected.has(c.id)) this.selected.delete(c.id);
        else this.selected.add(c.id);
        chip.style.cssText = this.chipCss(this.selected.has(c.id), c.isAlly);
        chip.textContent = `${this.selected.has(c.id) ? "✓ " : "  "}${c.label}${c.isAlly ? "  (ally)" : ""}`;
        updateCounter();
      });
      list.appendChild(chip);
    }
    panel.appendChild(list);

    const actions = document.createElement("div");
    actions.style.cssText = "display: flex; justify-content: flex-end; gap: 10px;";

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "CANCEL";
    cancelBtn.style.cssText = this.buttonCss("#222233", "#556677", "#aabbcc");
    cancelBtn.addEventListener("click", () => {
      onCancel();
      this.destroy();
    });
    actions.appendChild(cancelBtn);

    const confirmBtn = document.createElement("button");
    confirmBtn.textContent = "CONFIRM";
    confirmBtn.style.cssText = this.buttonCss("#1a2a4a", "#345580", "#cce4ff");
    confirmBtn.addEventListener("click", () => {
      onConfirm(Array.from(this.selected));
      this.destroy();
    });
    actions.appendChild(confirmBtn);

    panel.appendChild(actions);

    const closeBtn = document.createElement("button");
    closeBtn.className = "gui-close-btn";
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", () => {
      onCancel();
      this.destroy();
    });
    panel.appendChild(closeBtn);

    this.backdropEl.appendChild(panel);
    document.body.appendChild(this.backdropEl);

    const place = () => scale.placeModal(panel, PANEL_W, PANEL_H, GAME_H);
    place();
    this.offResize = scale.onChange(place);
  }

  private buttonCss(bg: string, border: string, color: string): string {
    return `
      background: ${bg}; border: 2px solid ${border}; color: ${color};
      font-family: monospace; font-size: 12px; letter-spacing: 1px;
      padding: 8px 18px; cursor: pointer; box-sizing: border-box;
    `;
  }

  private chipCss(active: boolean, ally: boolean): string {
    const bg = active ? (ally ? "#3a2a1a" : "#1a3a5a") : "#1a1a2a";
    const border = active ? (ally ? "#aa7733" : "#7aaecc") : "#445566";
    const color = active ? (ally ? "#ffd699" : "#cce4ff") : "#aabbcc";
    return `
      background: ${bg}; border: 2px solid ${border}; color: ${color};
      font-family: monospace; font-size: 12px; padding: 6px 12px;
      cursor: pointer; box-sizing: border-box; text-align: left;
    `;
  }

  private destroyed = false;
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.offResize();
    this.backdropEl.remove();
  }
}
