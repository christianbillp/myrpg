// Modal overlay surfaced when the server sets GameState.pendingCombatStart.
// A player action (attack / aggressive cast) in the exploring phase WOULD start
// combat, so the engine PAUSED before acting and asks the player to confirm.
//
// Two buttons:
//   • FIGHT  — accept; roll initiative. The triggering action is NOT auto-performed;
//              the player acts normally on their turn.
//   • CANCEL — decline; nothing happens (no combat, no resources spent).
//
// Closing via the × button or backdrop click is the same as CANCEL — a stray
// click must never drag the player into combat.

import { BaseOverlay } from "./BaseOverlay";
import { UIScale } from "./UIScale";
import type { PendingCombatStart } from "../../../shared/types";

const ACCENT = "#d9534f";
const DIM    = "#334455";

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface CombatStartPromptCallbacks {
  /** Send `resolveCombatStart { accept: true }` to the server. */
  onAccept: () => void;
  /** Send `resolveCombatStart { accept: false }` to the server. */
  onDecline: () => void;
}

export class CombatStartPromptOverlay extends BaseOverlay {
  constructor(
    scale: UIScale,
    pending: PendingCombatStart,
    callbacks: CombatStartPromptCallbacks,
  ) {
    // Closing via × or backdrop = cancel (never start combat by accident).
    super(scale, 480, 220, ACCENT, () => callbacks.onDecline());

    const layout = document.createElement("div");
    layout.style.cssText = `padding:24px 24px 0;display:flex;flex-direction:column;gap:14px;height:calc(100% - 24px);box-sizing:border-box;`;
    layout.innerHTML = `
      <div style="font-size:14px;color:${ACCENT};text-align:center;letter-spacing:1px;">START COMBAT?</div>
      <div style="height:1px;background:${DIM};"></div>
      <div style="font-size:11px;color:#c8dae8;line-height:1.6;text-align:center;flex:1;">
        ${escHtml(pending.label)}<br/><br/>
        Initiative will be rolled. You then act on your turn.
      </div>
      <div style="display:flex;gap:10px;padding-bottom:18px;">
        <button class="gui-btn-overlay" data-decline
          style="flex:1;height:36px;background:#1a1a2e;border:1px solid ${DIM};color:#889aaa;font-size:11px;">
          CANCEL
        </button>
        <button class="gui-btn-overlay" data-accept
          style="flex:1;height:36px;background:#3a1a1a;border:1px solid ${ACCENT};color:${ACCENT};font-size:11px;">
          FIGHT
        </button>
      </div>
    `;
    this.panelEl.appendChild(layout);

    layout.querySelector<HTMLButtonElement>("[data-accept]")!.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      callbacks.onAccept();
      this.destroy();
    });
    layout.querySelector<HTMLButtonElement>("[data-decline]")!.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      callbacks.onDecline();
      this.destroy();
    });
  }
}
