// ConversationOverlay — modal that drives the deterministic dialogue layer.
//
// Surfaced whenever `GameState.activeConversation` is non-null. The overlay
// renders the speaker's portrait + the current node's line + the choice
// buttons; clicking a choice ships a `conversationChoice` action to the
// server. The × button + "Goodbye" choice ship `conversationEnd`.
//
// Participant-agnostic from day one: speakers are rendered from the
// transcript's `currentSpeaker` ref, not hard-coded to NPCs. When simulation
// mode lands and the player can watch NPC-vs-NPC dialogue, the same component
// renders without changes — the only difference is choices come from a sim
// policy instead of the player.

import { BaseOverlay } from "./BaseOverlay";
import { UIScale } from "./UIScale";
import { DevMode } from "../devMode";
import type { ActiveConversation, ConversationDef, ConversationNode, ConversationChoice, ConversationExchange } from "../../../shared/types";

const ACCENT = "#e2b96f";
const ACCENT_DIM = "#7a6440";
const DIM = "#334455";
const BG_PANEL = "#11141e";
const BG_CHOICE = "#1a1f2e";

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface ConversationCallbacks {
  /** Player picked the choice at the given index. */
  onChoice: (index: number) => void;
  /** × button / backdrop / explicit GOODBYE — close the conversation. */
  onEnd: () => void;
  /** Player picked a choice with `openAigm: true`. The host scene opens the
   *  GM chat dropup pre-loaded with the conversation transcript (Phase 5). */
  onOpenAigm?: () => void;
}

export class ConversationOverlay extends BaseOverlay {
  private currentNodeId = "";
  /** Last-rendered exchange identity ({last entry's `at` timestamp} + length).
   *  We can't use just length: the server caps the exchange array at
   *  `EXCHANGE_CAP` and shifts the oldest off when full, so a new exchange
   *  added under the cap leaves length unchanged. The pair (lastAt, length)
   *  changes any time the array's tail or size changes — capturing both
   *  "append while under cap" and "eviction at cap" cases. When either
   *  shifts we rebuild the transcript; otherwise the refresh is a no-op
   *  and the player's scroll position is preserved. */
  private lastRenderedAt = "";
  private lastRenderedLength = 0;
  /** Number of attempted-check keys reflected in the current choice list.
   *  When the count grows mid-node (the player just resolved a check), the
   *  choice list re-renders so the attempted choice disappears (or picks
   *  up its `[DEV]` tag). */
  private renderedAttemptedCount = 0;
  private headerEl!: HTMLDivElement;
  private speakerNameEl!: HTMLDivElement;
  private transcriptEl!: HTMLDivElement;
  private choicesEl!: HTMLDivElement;

  constructor(
    scale: UIScale,
    private def: ConversationDef,
    state: ActiveConversation,
    /** Map of entity ref → display name for resolving the current speaker.
     *  The host scene maintains this from `state.npcs` + the player def. */
    private nameResolver: (ref: string) => string,
    /** Map of entity ref → token asset URL. Returns null when the speaker
     *  has no token (the overlay falls back to a coloured initial). */
    private tokenResolver: (ref: string) => string | null,
    private callbacks: ConversationCallbacks,
  ) {
    super(scale, 930, 780, ACCENT, () => callbacks.onEnd());
    this.buildLayout();
    this.refresh(state);
  }

  /** Update the overlay to reflect a new `activeConversation` state. Called
   *  from `OverlayManager.syncConversation` on every state tick. Appends any
   *  new exchanges to the transcript and re-renders the choice list when
   *  the active node has changed. */
  refresh(state: ActiveConversation): void {
    // Transcript sync. The server caps the exchange array at EXCHANGE_CAP
    // and shifts the oldest entry off when adding a new one at the cap, so
    // length alone is not a reliable change signal — once cap is reached,
    // length stays put while content rotates. We detect change via the
    // (lastAt, length) tuple: any tail change or length change is a
    // rebuild. Rebuild cost is bounded (cap is small, render is plain DOM).
    const lastAt = state.exchanges.length > 0
      ? state.exchanges[state.exchanges.length - 1].at
      : "";
    const tailChanged = lastAt !== this.lastRenderedAt
      || state.exchanges.length !== this.lastRenderedLength;
    if (tailChanged) {
      this.transcriptEl.replaceChildren();
      for (const exchange of state.exchanges) {
        this.transcriptEl.appendChild(this.renderExchange(exchange));
      }
      this.lastRenderedAt = lastAt;
      this.lastRenderedLength = state.exchanges.length;
      // Auto-scroll so the newest line is visible. Wait one frame so the
      // browser has a chance to lay the appended rows out — otherwise
      // `scrollHeight` may still read the pre-rebuild value and the new
      // content stays just below the fold.
      requestAnimationFrame(() => {
        this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
      });
    }

    const attemptedCount = state.attemptedCheckKeys?.length ?? 0;
    const nodeChanged = state.currentNodeId !== this.currentNodeId;
    const attemptedGrew = attemptedCount !== this.renderedAttemptedCount;
    if (!nodeChanged && !attemptedGrew) return;
    this.currentNodeId = state.currentNodeId;
    this.renderedAttemptedCount = attemptedCount;
    const node = this.def.nodes.find((n) => n.id === state.currentNodeId);
    if (!node) return;

    // Header — only rebuild when the active node changed. An attempted-only
    // refresh (the player just resolved a check inside the same node) skips
    // the token swap so it doesn't flicker.
    if (nodeChanged) {
      this.speakerNameEl.textContent = this.nameResolver(state.currentSpeaker);
      const tokenUrl = this.tokenResolver(state.currentSpeaker);
      this.headerEl.querySelector("[data-token]")?.remove();
      const tokenWrap = document.createElement("div");
      tokenWrap.dataset.token = "true";
      tokenWrap.style.cssText = `
        width: 44px; height: 44px;
        background: #0f1320; border: 1px solid ${DIM};
        border-radius: 4px; overflow: hidden; flex-shrink: 0;
        display: flex; align-items: center; justify-content: center;
      `;
      if (tokenUrl) {
        const img = document.createElement("img");
        img.src = tokenUrl;
        img.style.cssText = "width: 100%; height: 100%; object-fit: contain;";
        tokenWrap.appendChild(img);
      } else {
        const initial = document.createElement("div");
        initial.textContent = this.nameResolver(state.currentSpeaker).slice(0, 1).toUpperCase();
        initial.style.cssText = `font-family: serif; color: ${ACCENT}; font-size: 22px;`;
        tokenWrap.appendChild(initial);
      }
      this.headerEl.insertBefore(tokenWrap, this.headerEl.firstChild);
    }

    // Choices.
    this.choicesEl.replaceChildren();
    if (node.ends) {
      // Terminal node — give the player a single dismiss button. The server
      // already closed the conversation, but the overlay stays open so the
      // final line is readable.
      const btn = this.makeChoiceButton("(Continue)", () => this.callbacks.onEnd(), null);
      this.choicesEl.appendChild(btn);
      return;
    }
    const attemptedKeys = new Set(state.attemptedCheckKeys ?? []);
    const allowRetry = DevMode.allowRetryChecks;
    node.choices.forEach((choice, i) => {
      const isCheck = !!choice.check;
      const checkKey = `${node.id}#${i}`;
      const alreadyTried = isCheck && attemptedKeys.has(checkKey);
      // Hide spent ability checks unless the dev override is on. The choice
      // remains in the conversation graph; it's just removed from the
      // visible list so the player can't simply spam-click for a re-roll.
      if (alreadyTried && !allowRetry) return;
      const dcTag = formatDcTag(choice);
      const btn = this.makeChoiceButton(
        choice.label,
        () => {
          if (choice.openAigm) {
            this.callbacks.onOpenAigm?.();
            return;
          }
          this.callbacks.onChoice(i);
        },
        dcTag,
        alreadyTried ? "DEV" : null,
      );
      this.choicesEl.appendChild(btn);
    });
    // Always-available GOODBYE — gives the player an explicit exit even
    // when the author didn't script one.
    const goodbye = this.makeChoiceButton("(Goodbye)", () => this.callbacks.onEnd(), null);
    goodbye.style.opacity = "0.7";
    this.choicesEl.appendChild(goodbye);
  }

  /** Render one transcript entry as a styled DOM node. Kind-specific
   *  presentation keeps spoken lines, player choices, roll outcomes, and
   *  scripted events visually distinct so the player can scan the history. */
  private renderExchange(ex: ConversationExchange): HTMLDivElement {
    const row = document.createElement("div");
    row.style.cssText = "padding: 4px 0; line-height: 1.5;";
    switch (ex.kind) {
      case "line": {
        const speaker = document.createElement("div");
        speaker.textContent = ex.speakerName;
        speaker.style.cssText = `color: ${ACCENT}; font-size: 11px; letter-spacing: 0.5px; margin-bottom: 2px;`;
        row.appendChild(speaker);
        const text = document.createElement("div");
        text.textContent = ex.text;
        text.style.cssText = `font-family: monospace; font-size: 13px; color: #d8e2f0;`;
        row.appendChild(text);
        break;
      }
      case "choice": {
        row.style.padding = "6px 0 4px";
        const text = document.createElement("div");
        text.textContent = `▸ ${ex.speakerName}: "${ex.text}"`;
        text.style.cssText = `font-family: monospace; font-size: 12px; color: #88aacc;`;
        row.appendChild(text);
        break;
      }
      case "roll": {
        const passed = / — SUCCESS$/.test(ex.text);
        row.style.cssText = `
          padding: 4px 6px; margin: 4px 0;
          background: ${passed ? "#0e1a10" : "#1a0e10"};
          border-left: 2px solid ${passed ? "#88aa66" : "#aa6666"};
          font-family: monospace; font-size: 11px;
          color: ${passed ? "#aaccaa" : "#ccaaaa"};
        `;
        row.textContent = `🎲 ${ex.text}`;
        break;
      }
      case "event": {
        row.style.cssText = `
          padding: 3px 6px; margin: 2px 0;
          font-family: monospace; font-size: 11px;
          color: #99aab8; font-style: italic;
        `;
        row.textContent = `· ${ex.text}`;
        break;
      }
      case "aigm": {
        const speaker = document.createElement("div");
        speaker.textContent = `${ex.speakerName} (GM)`;
        speaker.style.cssText = `color: ${ACCENT}; font-size: 11px; letter-spacing: 0.5px; margin-bottom: 2px;`;
        row.appendChild(speaker);
        const text = document.createElement("div");
        text.textContent = ex.text;
        text.style.cssText = `font-family: monospace; font-size: 13px; color: #e8d8b0; font-style: italic;`;
        row.appendChild(text);
        break;
      }
    }
    return row;
  }

  // ── Internal layout ─────────────────────────────────────────────────────

  private buildLayout(): void {
    const layout = document.createElement("div");
    layout.style.cssText = `
      padding: 18px 20px 20px;
      display: flex; flex-direction: column;
      gap: 12px; height: calc(100% - 18px); box-sizing: border-box;
    `;
    this.panelEl.appendChild(layout);

    // Header row.
    this.headerEl = document.createElement("div");
    this.headerEl.style.cssText = `display:flex;align-items:center;gap:12px;`;
    this.speakerNameEl = document.createElement("div");
    this.speakerNameEl.style.cssText = `
      font-family: monospace; font-size: 15px; color: ${ACCENT};
      letter-spacing: 1px; flex: 1;
    `;
    this.headerEl.appendChild(this.speakerNameEl);
    layout.appendChild(this.headerEl);

    const div1 = document.createElement("div");
    div1.style.cssText = `height: 1px; background: ${DIM};`;
    layout.appendChild(div1);

    // Scrollable transcript — every exchange the conversation has produced
    // so far. Auto-scrolls to the newest line whenever a new entry arrives,
    // but the player can scroll up to re-read earlier beats at any time.
    // `min-height: 0` is the flex-with-overflow incantation: without it
    // the transcript grows to fit its content and pushes the choices row
    // below the visible area of the panel after the dialogue gets long.
    this.transcriptEl = document.createElement("div");
    this.transcriptEl.style.cssText = `
      flex: 2 1 0;
      min-height: 0;
      padding: 8px 4px 8px;
      overflow-y: auto;
      scrollbar-width: thin; scrollbar-color: ${DIM} transparent;
    `;
    layout.appendChild(this.transcriptEl);

    const div2 = document.createElement("div");
    div2.style.cssText = `height: 1px; background: ${DIM};`;
    layout.appendChild(div2);

    // Choices — scrollable list. The author can ship arbitrarily many.
    // Same `min-height: 0` fix the transcript uses, so a long choice list
    // scrolls internally instead of inflating the panel.
    this.choicesEl = document.createElement("div");
    this.choicesEl.style.cssText = `
      display: flex; flex-direction: column; gap: 6px;
      flex: 1 1 0;
      min-height: 0;
      overflow-y: auto;
      scrollbar-width: thin; scrollbar-color: ${DIM} transparent;
      padding-right: 4px;
    `;
    layout.appendChild(this.choicesEl);
  }

  /** `devTag` (default null) renders an extra `[DEV]` chip next to any DC
   *  tag — used to flag choices that are only reachable because the
   *  `allowRetryChecks` dev override is on. */
  private makeChoiceButton(
    label: string,
    onClick: () => void,
    dcTag: string | null,
    devTag: string | null = null,
  ): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.style.cssText = `
      width: 100%; text-align: left;
      background: ${BG_CHOICE}; border: 1px solid ${DIM};
      color: #c8d8e8; padding: 10px 12px;
      font-family: monospace; font-size: 12px; line-height: 1.45;
      cursor: pointer; box-sizing: border-box;
      display: flex; align-items: center; gap: 10px;
    `;
    const labelEl = document.createElement("span");
    labelEl.textContent = label;
    labelEl.style.cssText = "flex: 1;";
    btn.appendChild(labelEl);
    if (dcTag) {
      const tagEl = document.createElement("span");
      tagEl.textContent = dcTag;
      tagEl.style.cssText = `
        color: ${ACCENT_DIM}; font-size: 10px; letter-spacing: 1px;
        padding: 2px 6px; border: 1px solid ${ACCENT_DIM};
        border-radius: 2px; flex-shrink: 0;
      `;
      btn.appendChild(tagEl);
    }
    if (devTag) {
      const dev = document.createElement("span");
      dev.textContent = devTag;
      dev.style.cssText = `
        color: #ff7777; font-size: 10px; letter-spacing: 1px; font-weight: bold;
        padding: 2px 6px; border: 1px solid #aa4444;
        background: #2a0e0e; border-radius: 2px; flex-shrink: 0;
      `;
      btn.appendChild(dev);
    }
    btn.addEventListener("mouseenter", () => {
      btn.style.background = "#243043";
      btn.style.borderColor = ACCENT_DIM;
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.background = BG_CHOICE;
      btn.style.borderColor = DIM;
    });
    btn.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      onClick();
    });
    return btn;
  }
}

function formatDcTag(choice: ConversationChoice): string | null {
  if (!choice.check) return null;
  const what = choice.check.skill ?? choice.check.ability ?? "check";
  return `DC ${choice.check.dc} · ${what.toUpperCase()}`;
}
