import { UIScale } from "./UIScale";

/**
 * Floating top-center button that drives the Bureau-office mission cycle:
 *
 *   • "TO MISSION"     — shown at the Bureau when a contract is pending
 *                        (world flag `mission_pending` resolves truthy).
 *                        Clicking transitions the player to the chosen
 *                        mission encounter via POST `/game/session/:id/transition`.
 *
 *   • "LEAVE MISSION"  — shown on a mission map, always. Clicking transitions
 *                        the player back to the Bureau Office. The mission's
 *                        own `mission_complete` trigger flips a flag on enemy
 *                        defeat; pressing LEAVE before that just walks the
 *                        player away from an unfinished contract (the
 *                        `mission_pending` flag stays set, so they can come
 *                        back to it).
 *
 * Rendered as a plain HTML overlay positioned by `UIScale` so it tracks
 * the canvas, same convention as `NextChapterButton`. Visibility is
 * driven by `setMode(...)` which the scene calls after every state tick.
 */

const ACCENT = "#88aacc";       // cool blue — distinct from the green NEXT CHAPTER button
const WARN_ACCENT = "#cc8866";  // warm amber — LEAVE MISSION reads as "back out"

export type MissionTopBarMode =
  | { kind: 'hidden' }
  | { kind: 'to-mission'; encounterId: string }
  | { kind: 'leave-mission' };

export class MissionTopBar {
  private readonly el: HTMLDivElement;
  private readonly offResize: () => void;
  private mode: MissionTopBarMode = { kind: 'hidden' };

  constructor(scale: UIScale, private readonly onTransition: (encounterId: string) => void) {
    this.el = document.createElement("div");
    this.el.style.cssText = `
      position: absolute;
      display: none;
      align-items: center;
      gap: 10px;
      padding: 8px 22px;
      background: rgba(20, 28, 40, 0.92);
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
    this.el.onmouseenter = () => {
      this.el.style.background = "rgba(40, 60, 90, 0.96)";
      this.el.style.color = "#e0eef8";
    };
    this.el.onmouseleave = () => this.applyVisuals();
    this.el.onclick = () => {
      if (this.mode.kind === 'to-mission') this.onTransition(this.mode.encounterId);
      else if (this.mode.kind === 'leave-mission') this.onTransition('bureau_office');
    };

    document.body.appendChild(this.el);

    const place = () => {
      const rect = scale.canvasRect;
      const TOP_MARGIN = 12;
      this.el.style.left = `${rect.left + rect.width / 2}px`;
      this.el.style.top  = `${rect.top + TOP_MARGIN}px`;
      this.el.style.transform = `translateX(-50%)`;
    };
    place();
    this.offResize = scale.onChange(place);
  }

  setMode(mode: MissionTopBarMode): void {
    this.mode = mode;
    this.applyVisuals();
  }

  /** Update colours + label + display from the current mode. */
  private applyVisuals(): void {
    if (this.mode.kind === 'hidden') {
      this.el.style.display = 'none';
      return;
    }
    this.el.style.display = 'flex';
    if (this.mode.kind === 'to-mission') {
      this.el.textContent = '▶ TO MISSION';
      this.el.style.borderColor = ACCENT;
      this.el.style.color = ACCENT;
      this.el.style.background = 'rgba(20, 28, 40, 0.92)';
    } else {
      this.el.textContent = '◀ LEAVE MISSION';
      this.el.style.borderColor = WARN_ACCENT;
      this.el.style.color = WARN_ACCENT;
      this.el.style.background = 'rgba(36, 24, 18, 0.92)';
    }
  }

  destroy(): void {
    this.offResize();
    this.el.remove();
  }
}
