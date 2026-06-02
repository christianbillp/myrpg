// Modal overlay surfaced when the server sets GameState.pendingReaction.
// The engine has paused the turn loop and is waiting for the player to decide
// whether to spend their Reaction (Opportunity Attack, Shield, …).
//
// Two buttons:
//   • TAKE REACTION    — accept; server fires the deferred effect and resumes.
//   • TAKE NO REACTION — decline; server skips the effect and resumes.
//
// Closing the overlay via the × button or backdrop click is the same as
// declining (we don't want a stray click to spend the player's reaction
// resource accidentally).

import { BaseOverlay } from "./BaseOverlay";
import { UIScale } from "./UIScale";
import type { PendingReaction } from "../../../shared/types";

const ACCENT = "#e2b96f";
const DIM    = "#334455";

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface ReactionPromptCallbacks {
  /** Send `resolveReaction { accept: true }` to the server. */
  onAccept: () => void;
  /** Send `resolveReaction { accept: false }` to the server. */
  onDecline: () => void;
}

export class ReactionPromptOverlay extends BaseOverlay {
  constructor(
    scale: UIScale,
    reaction: PendingReaction,
    callbacks: ReactionPromptCallbacks,
  ) {
    // Shield prompts that include a "Shield won't block this damage"
    // warning need extra vertical room for the warning panel. The base
    // 220 px fits the standard body + buttons; bump to 330 px when the
    // warning is rendered so it doesn't overflow the panel.
    const needsWarningHeight =
      reaction.kind === 'shield' &&
      (reaction.isCrit || reaction.attackTotal >= reaction.shieldedAc);
    const panelH = needsWarningHeight ? 330 : 220;
    // Closing via × or backdrop = decline.
    super(scale, 480, panelH, ACCENT, () => callbacks.onDecline());

    const { title, body, acceptLabel } = describe(reaction);

    const layout = document.createElement("div");
    layout.style.cssText = `padding:24px 24px 0;display:flex;flex-direction:column;gap:14px;height:calc(100% - 24px);box-sizing:border-box;`;
    layout.innerHTML = `
      <div style="font-size:14px;color:${ACCENT};text-align:center;letter-spacing:1px;">${escHtml(title)}</div>
      <div style="height:1px;background:${DIM};"></div>
      <div style="font-size:11px;color:#c8dae8;line-height:1.6;text-align:center;flex:1;">${body}</div>
      <div style="display:flex;gap:10px;padding-bottom:18px;">
        <button class="gui-btn-overlay" data-decline
          style="flex:1;height:36px;background:#1a1a2e;border:1px solid ${DIM};color:#889aaa;font-size:11px;">
          TAKE NO REACTION
        </button>
        <button class="gui-btn-overlay" data-accept
          style="flex:1;height:36px;background:#1a3a5a;border:1px solid ${ACCENT};color:${ACCENT};font-size:11px;">
          ${escHtml(acceptLabel)}
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

function describe(reaction: PendingReaction): { title: string; body: string; acceptLabel: string } {
  if (reaction.kind === "opportunity_attack") {
    return {
      title: "OPPORTUNITY ATTACK",
      body: `<strong style="color:#e8e8f8;">${escHtml(reaction.npcName)}</strong> is moving out of your reach.<br/><br/>Spend your Reaction to make a melee attack as they leave?`,
      acceptLabel: "ATTACK",
    };
  }
  // SRD Shield: crits bypass AC, and a non-crit attack that beats AC + 5
  // still lands even with the buff up — in both cases the +5 AC bonus
  // still protects against subsequent attacks until the start of the
  // player's next turn, but the player should know the damage *won't* be
  // blocked before deciding to spend the slot.
  const damageBlocked = !reaction.isCrit && reaction.attackTotal < reaction.shieldedAc;
  const warning = reaction.isCrit
    ? `<div style="margin-top:10px;padding:8px;border:1px solid #6a4040;background:#2a1414;color:#e89090;font-size:10px;line-height:1.5;">
         <strong>Critical hit — Shield cannot block it.</strong> The <strong>${reaction.incomingDamage}</strong> damage will still land. The +5 AC bonus persists until the start of your next turn.
       </div>`
    : !damageBlocked
      ? `<div style="margin-top:10px;padding:8px;border:1px solid #6a4040;background:#2a1414;color:#e89090;font-size:10px;line-height:1.5;">
           <strong>Shield isn't enough to block this attack.</strong> The attack roll of <strong>${reaction.attackTotal}</strong> still meets the shielded AC of <strong>${reaction.shieldedAc}</strong>, so the <strong>${reaction.incomingDamage}</strong> damage will land. The +5 AC bonus still protects you against subsequent attacks until your next turn.
         </div>`
      : "";
  const intro = damageBlocked
    ? `Spend a 1st-level slot to cast Shield (AC → ${reaction.shieldedAc}) and negate the hit?`
    : `Spend a 1st-level slot to cast Shield (AC → ${reaction.shieldedAc}) for the buff window?`;
  return {
    title: "REACTIVE SHIELD",
    body: `<strong style="color:#e8e8f8;">${escHtml(reaction.attackerName)}</strong> hits with an attack roll of <strong>${reaction.attackTotal}</strong> for <strong>${reaction.incomingDamage}</strong> damage.<br/><br/>${intro}${warning}`,
    acceptLabel: "CAST SHIELD",
  };
}
