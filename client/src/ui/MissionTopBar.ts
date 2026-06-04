import { UIScale } from "./UIScale";

/**
 * Floating top-center button group that drives the Bureau-office mission cycle:
 *
 *   • "TO MISSION"      — at the Bureau when a contract is pending (world flag
 *                         `mission_pending` resolves truthy). Transitions the
 *                         player to the chosen mission encounter.
 *   • "LEAVE MISSION"   — on a mission map. Transitions back to the Bureau. The
 *                         mission's own `mission_complete` trigger flips a flag
 *                         on enemy defeat; pressing LEAVE before that just walks
 *                         away from an unfinished contract.
 *   • "LEAVE ADVENTURE" — at the Bureau, always available. Ends the run and
 *                         returns to the menu. Bureau-only: leaving the
 *                         adventure is never offered from inside a mission.
 *
 * Each entry is an independent child of one top-center flex container, so
 * TO MISSION and LEAVE ADVENTURE sit side by side at the Bureau without
 * overlapping. Visibility is driven by `setButtons(...)`, which the scene calls
 * after every state tick.
 *
 * Rendered as a plain HTML overlay positioned by `UIScale` so it tracks the
 * canvas, same convention as `NextChapterButton`.
 */

interface ButtonStyle { accent: string; bg: string; hoverBg: string; hoverColor: string; }
const TO_MISSION_STYLE: ButtonStyle     = { accent: '#88aacc', bg: 'rgba(20, 28, 40, 0.92)', hoverBg: 'rgba(40, 60, 90, 0.96)', hoverColor: '#e0eef8' };
const LEAVE_MISSION_STYLE: ButtonStyle   = { accent: '#cc8866', bg: 'rgba(36, 24, 18, 0.92)', hoverBg: 'rgba(70, 44, 30, 0.96)', hoverColor: '#f4d8c4' };
const LEAVE_ADVENTURE_STYLE: ButtonStyle = { accent: '#88ccaa', bg: 'rgba(20, 32, 28, 0.92)', hoverBg: 'rgba(40, 78, 60, 0.96)', hoverColor: '#e8f8d8' };

/** Which buttons to surface this tick. An absent / false field hides that
 *  button; an empty set hides the whole bar. */
export interface MissionTopBarButtons {
  /** Encounter id of the pending contract — shows TO MISSION when set. */
  toMission?: string;
  /** On a mission map — shows LEAVE MISSION, transitioning to this hub
   *  encounter id (the hub that issued the contract). */
  leaveMission?: string;
  /** At the Bureau — shows LEAVE ADVENTURE (end the run / return to menu). */
  leaveAdventure?: boolean;
}

export interface MissionTopBarCallbacks {
  /** TO MISSION / LEAVE MISSION both transition to an encounter id. */
  onTransition: (encounterId: string) => void;
  /** LEAVE ADVENTURE ends the run. */
  onLeaveAdventure: () => void;
}

export class MissionTopBar {
  private readonly el: HTMLDivElement;
  private readonly offResize: () => void;

  constructor(scale: UIScale, private readonly callbacks: MissionTopBarCallbacks) {
    this.el = document.createElement("div");
    this.el.style.cssText = `
      position: absolute;
      display: none;
      align-items: center;
      gap: 10px;
      z-index: 12;
    `;
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

  /** Rebuild the visible buttons. Order left-to-right: TO MISSION, LEAVE
   *  MISSION, LEAVE ADVENTURE. The container centres itself, so one or two
   *  buttons both stay top-centre. */
  setButtons(buttons: MissionTopBarButtons): void {
    this.el.replaceChildren();
    if (buttons.toMission) {
      const target = buttons.toMission;
      this.el.appendChild(this.makeButton('▶ TO MISSION', TO_MISSION_STYLE, () => this.callbacks.onTransition(target)));
    }
    if (buttons.leaveMission) {
      const hub = buttons.leaveMission;
      this.el.appendChild(this.makeButton('◀ LEAVE MISSION', LEAVE_MISSION_STYLE, () => this.callbacks.onTransition(hub)));
    }
    if (buttons.leaveAdventure) {
      this.el.appendChild(this.makeButton('⏏ LEAVE ADVENTURE', LEAVE_ADVENTURE_STYLE, () => this.callbacks.onLeaveAdventure()));
    }
    this.el.style.display = this.el.childElementCount > 0 ? 'flex' : 'none';
  }

  private makeButton(label: string, style: ButtonStyle, onClick: () => void): HTMLDivElement {
    const btn = document.createElement("div");
    btn.textContent = label;
    btn.style.cssText = `
      padding: 8px 22px;
      background: ${style.bg};
      border: 2px solid ${style.accent};
      color: ${style.accent};
      font-family: monospace;
      font-size: 13px;
      letter-spacing: 2px;
      text-transform: uppercase;
      cursor: pointer;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
      transition: background 120ms, color 120ms;
    `;
    btn.onmouseenter = () => { btn.style.background = style.hoverBg; btn.style.color = style.hoverColor; };
    btn.onmouseleave = () => { btn.style.background = style.bg; btn.style.color = style.accent; };
    btn.onclick = onClick;
    return btn;
  }

  destroy(): void {
    this.offResize();
    this.el.remove();
  }
}
