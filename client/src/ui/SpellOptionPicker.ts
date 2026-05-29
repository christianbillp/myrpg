/**
 * SpellOptionPicker — small modal that asks the player to pick from a list
 * of options before continuing a spell cast. Used by Chromatic Orb (damage
 * type) and any future spell with a similar "choose at cast time" prompt.
 *
 * Lives outside `BaseOverlay` because it's narrow + single-purpose: chip
 * grid + CANCEL, dismissed on selection or backdrop click.
 */
import { UIScale } from "./UIScale";
import { GRID_ROWS, TILE_SIZE, HUD_HEIGHT } from "../constants";

const GAME_H = GRID_ROWS * TILE_SIZE + HUD_HEIGHT;
const ACCENT = "#9ac8ff";
const PANEL_W = 380;
const PANEL_H = 200;

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export class SpellOptionPicker {
  private readonly backdropEl: HTMLDivElement;
  private readonly offResize: () => void;

  constructor(
    scale: UIScale,
    title: string,
    description: string,
    options: string[],
    onPick: (option: string) => void,
    onCancel: () => void,
  ) {
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
      padding: 20px; box-sizing: border-box; display: flex; flex-direction: column; gap: 10px;
    `;

    const header = document.createElement("div");
    header.textContent = title.toUpperCase();
    header.style.cssText = "font-size: 14px; color: #cce4ff; letter-spacing: 2px;";
    panel.appendChild(header);

    const help = document.createElement("div");
    help.textContent = description;
    help.style.cssText = "font-size: 11px; color: #778899; line-height: 1.5;";
    panel.appendChild(help);

    const chips = document.createElement("div");
    chips.style.cssText = "display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px;";
    for (const opt of options) {
      const chip = document.createElement("button");
      chip.textContent = titleCase(opt);
      chip.style.cssText = `
        background: #1a1a2a; border: 2px solid #445566; color: #aabbcc;
        font-family: monospace; font-size: 11px; padding: 4px 12px;
        cursor: pointer; box-sizing: border-box;
      `;
      chip.addEventListener("click", () => {
        onPick(opt);
        this.destroy();
      });
      chips.appendChild(chip);
    }
    panel.appendChild(chips);

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

  private destroyed = false;
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.offResize();
    this.backdropEl.remove();
  }
}
