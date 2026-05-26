import { UIScale } from "./UIScale";

const ACCENT = "#88ccaa";

/**
 * Persistent floating button that appears at the top-center of the screen
 * once the player has dismissed the chapter-complete overlay. Clicking it
 * advances the adventure to the next chapter (or returns to the main menu
 * on the final chapter).
 *
 * The button is rendered as a plain HTML element positioned by `UIScale`
 * so it tracks the canvas as the window resizes, same convention used by
 * `PlayerPanel`, `TargetPanel`, and `HUD`.
 */
export class NextChapterButton {
  private readonly el: HTMLDivElement;
  private readonly offResize: () => void;

  constructor(scale: UIScale, label: string, onClick: () => void) {
    this.el = document.createElement("div");
    this.el.style.cssText = `
      position: absolute;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 22px;
      background: rgba(20, 32, 28, 0.92);
      border: 2px solid ${ACCENT};
      color: ${ACCENT};
      font-family: monospace;
      font-size: 13px;
      letter-spacing: 2px;
      text-transform: uppercase;
      cursor: pointer;
      z-index: 12;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
      transition: background 120ms, color 120ms;
    `;
    this.el.textContent = label;
    this.el.onmouseenter = () => {
      this.el.style.background = "rgba(40, 78, 60, 0.96)";
      this.el.style.color = "#e8f8d8";
    };
    this.el.onmouseleave = () => {
      this.el.style.background = "rgba(20, 32, 28, 0.92)";
      this.el.style.color = ACCENT;
    };
    this.el.onclick = () => onClick();

    document.body.appendChild(this.el);

    const place = () => {
      // Top-center of the canvas, with a small margin from the top edge.
      const rect = scale.canvasRect;
      const TOP_MARGIN = 12;
      this.el.style.left = `${rect.left + rect.width / 2}px`;
      this.el.style.top  = `${rect.top + TOP_MARGIN}px`;
      this.el.style.transform = `translateX(-50%)`;
    };
    place();
    this.offResize = scale.onChange(place);
  }

  destroy(): void {
    this.offResize();
    this.el.remove();
  }
}
