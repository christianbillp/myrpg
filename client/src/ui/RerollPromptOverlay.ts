// Modal overlay surfaced when the server sets GameState.pendingReroll (US-109a).
// The engine has resolved a player d20 (currently the attack roll) but PAUSED
// before applying any consequence, offering the player a chance to spend Heroic
// Inspiration to reroll.
//
// Two buttons:
//   • REROLL    — accept; spend Heroic Inspiration, re-resolve, apply the new roll.
//   • KEEP ROLL — decline; apply the roll the player already saw, inspiration kept.
//
// Closing via the × button or backdrop click is the same as KEEP ROLL — a stray
// click must never spend the player's Heroic Inspiration.

import { BaseOverlay } from "./BaseOverlay";
import { UIScale } from "./UIScale";
import type { PendingReroll } from "../../../shared/types";

const ACCENT = "#e2b96f";
const DIM    = "#334455";

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface RerollPromptCallbacks {
  /** Send `resolveReroll { accept: true }` to the server. */
  onAccept: () => void;
  /** Send `resolveReroll { accept: false }` to the server. */
  onDecline: () => void;
}

export class RerollPromptOverlay extends BaseOverlay {
  constructor(
    scale: UIScale,
    reroll: PendingReroll,
    callbacks: RerollPromptCallbacks,
  ) {
    // Closing via × or backdrop = keep the roll (never spend inspiration).
    super(scale, 480, 240, ACCENT, () => callbacks.onDecline());

    const layout = document.createElement("div");
    layout.style.cssText = `padding:24px 24px 0;display:flex;flex-direction:column;gap:14px;height:calc(100% - 24px);box-sizing:border-box;`;
    layout.innerHTML = `
      <div style="font-size:14px;color:${ACCENT};text-align:center;letter-spacing:1px;">HEROIC INSPIRATION</div>
      <div style="height:1px;background:${DIM};"></div>
      <div style="font-size:11px;color:#c8dae8;line-height:1.6;text-align:center;flex:1;">
        ${escHtml(reroll.label)} — you rolled a natural <strong style="color:#e8e8f8;">${reroll.rolledNatural}</strong>.<br/>
        <span style="color:#9fb4c6;">${escHtml(reroll.outcomePreview)}</span><br/><br/>
        Spend your <strong style="color:${ACCENT};">Heroic Inspiration</strong> to reroll the d20 and keep the new result?
      </div>
      <div style="display:flex;gap:10px;padding-bottom:18px;">
        <button class="gui-btn-overlay" data-decline
          style="flex:1;height:36px;background:#1a1a2e;border:1px solid ${DIM};color:#889aaa;font-size:11px;">
          KEEP ROLL
        </button>
        <button class="gui-btn-overlay" data-accept
          style="flex:1;height:36px;background:#1a3a5a;border:1px solid ${ACCENT};color:${ACCENT};font-size:11px;">
          REROLL
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
