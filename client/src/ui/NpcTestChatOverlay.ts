/**
 * NpcTestChatOverlay — author-side preview of how Claude will roleplay an
 * NPC against the current persona draft. Modeled on the in-game GM chat
 * (HUD's `data-gm-chat` panel): same visual treatment (user prompts in
 * accent gold prefixed with ▸, NPC replies rendered as markdown in cool
 * grey via `hud-dm-msg`), same Enter-to-send convention.
 *
 * The overlay is standalone — it doesn't require a game session. The host
 * scene passes the current draft fields on construction; each send
 * round-trips through `gameClient.testNpcChat` with the running history.
 */
import { gameClient } from "../net/GameClient";
import { marked } from "marked";

const ACCENT = "#e2b96f";
const DIM = "#334455";
const BG_BACKDROP = "rgba(0,0,0,0.78)";
const BG_PANEL = "#11141e";
const TEXT = "#c8d8e8";

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface NpcTestChatDraft {
  name: string;
  monsterClass?: string;
  factionId?: string;
  persona: string;
}

export interface NpcTestChatCallbacks {
  onClose: () => void;
}

interface ChatMessage { role: "user" | "assistant"; content: string; }

export class NpcTestChatOverlay {
  private root: HTMLDivElement;
  private chatEl!: HTMLDivElement;
  private inputEl!: HTMLInputElement;
  private sendBtn!: HTMLButtonElement;
  private statusEl!: HTMLDivElement;
  private styleEl: HTMLStyleElement;
  private history: ChatMessage[] = [];
  private busy = false;
  private getDraft: () => NpcTestChatDraft;

  constructor(getDraft: () => NpcTestChatDraft, callbacks: NpcTestChatCallbacks) {
    this.getDraft = getDraft;

    // Reusable HUD-style markdown rules. Scoped via a class so other
    // markdown surfaces aren't affected.
    this.styleEl = document.createElement("style");
    this.styleEl.dataset.npcTestChat = "true";
    this.styleEl.textContent = `
      .npc-test-msg p  { margin: 0 0 4px 0; }
      .npc-test-msg strong { color: #f0e0c0; }
      .npc-test-msg em { color: #d0c090; font-style: italic; }
      .npc-test-msg ul, .npc-test-msg ol { margin: 4px 0; padding-left: 16px; }
      .npc-test-msg li { margin: 2px 0; }
      .npc-test-msg h1, .npc-test-msg h2, .npc-test-msg h3 { color: ${ACCENT}; margin: 6px 0 2px; font-size: 13px; }
      .npc-test-msg code { background: #1a1a2e; padding: 0 3px; border-radius: 2px; font-family: monospace; }
      .npc-test-msg pre  { background: #1a1a2e; padding: 6px 8px; border-radius: 3px; overflow-x: auto; margin: 4px 0; }
      .npc-test-msg blockquote { border-left: 2px solid ${ACCENT}; padding-left: 8px; color: #a0b0c0; margin: 4px 0; }
      .npc-test-msg hr { border: none; border-top: 1px solid ${DIM}; margin: 6px 0; }
    `;
    document.head.appendChild(this.styleEl);

    this.root = document.createElement("div");
    this.root.style.cssText = `
      position: fixed; inset: 0; z-index: 1100;
      background: ${BG_BACKDROP};
      display: flex; align-items: center; justify-content: center;
      font-family: monospace;
    `;
    this.root.addEventListener("click", (e) => {
      if (e.target === this.root) callbacks.onClose();
    });
    this.buildPanel(callbacks);
    document.body.appendChild(this.root);
    this.renderHistory();
    setTimeout(() => this.inputEl?.focus(), 0);
  }

  destroy(): void {
    this.root.remove();
    this.styleEl.remove();
  }

  private buildPanel(callbacks: NpcTestChatCallbacks): void {
    const panel = document.createElement("div");
    panel.style.cssText = `
      width: 720px; max-width: 92vw;
      height: 640px; max-height: 88vh;
      background: ${BG_PANEL};
      border: 2px solid ${ACCENT};
      display: flex; flex-direction: column;
      color: ${TEXT};
      overflow: hidden; box-sizing: border-box;
    `;
    this.root.appendChild(panel);

    // Header
    const header = document.createElement("div");
    header.style.cssText = `
      padding: 16px 20px 10px;
      border-bottom: 1px solid ${DIM};
      display: flex; align-items: center; gap: 12px;
    `;
    const draft = this.getDraft();
    const title = document.createElement("div");
    title.style.cssText = `flex: 1; font-size: 14px; color: ${ACCENT}; letter-spacing: 1px;`;
    title.innerHTML = `TEST CHAT — ${escHtml(draft.name || "(unnamed)")} `;
    const subtitle = document.createElement("span");
    subtitle.style.cssText = "font-size: 10px; color: #88aacc; letter-spacing: 1px;";
    subtitle.textContent = "Roleplay preview · uses the live persona draft";
    title.appendChild(subtitle);
    header.appendChild(title);
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "×";
    closeBtn.style.cssText = `
      background: transparent; color: #889aac;
      border: none; font-size: 24px; cursor: pointer;
      padding: 0 6px;
    `;
    closeBtn.addEventListener("click", () => callbacks.onClose());
    header.appendChild(closeBtn);
    panel.appendChild(header);

    // Chat scroll area — mirrors HUD's data-gm-chat styling.
    this.chatEl = document.createElement("div");
    this.chatEl.style.cssText = `
      flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden;
      scrollbar-width: thin; scrollbar-color: ${ACCENT} transparent;
      background: #080812;
      padding: 12px 16px; box-sizing: border-box;
      font-size: 12px; line-height: 1.55; color: ${TEXT};
    `;
    panel.appendChild(this.chatEl);

    // Status line (busy + errors)
    this.statusEl = document.createElement("div");
    this.statusEl.style.cssText = `
      font-size: 11px; color: #b8960c; padding: 4px 16px; min-height: 16px;
    `;
    panel.appendChild(this.statusEl);

    // Divider
    const div = document.createElement("div");
    div.style.cssText = `height: 1px; background: ${DIM}; flex-shrink: 0;`;
    panel.appendChild(div);

    // Input row
    const inputRow = document.createElement("div");
    inputRow.style.cssText = "display: flex; gap: 8px; padding: 12px 16px;";
    this.inputEl = document.createElement("input");
    this.inputEl.type = "text";
    this.inputEl.maxLength = 600;
    this.inputEl.autocomplete = "off";
    this.inputEl.placeholder = `Speak to ${draft.name || "the NPC"}…`;
    this.inputEl.style.cssText = `
      flex: 1; height: 32px;
      background: #111122; border: 1px solid #554422;
      color: #e0d0a0; font-family: monospace; font-size: 12px;
      padding: 0 10px; box-sizing: border-box;
      outline: none; caret-color: ${ACCENT};
    `;
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void this.send();
      }
    });
    inputRow.appendChild(this.inputEl);

    this.sendBtn = document.createElement("button");
    this.sendBtn.type = "button";
    this.sendBtn.textContent = "SEND";
    this.sendBtn.style.cssText = `
      width: 80px; height: 32px;
      background: #2a1e08; color: ${ACCENT};
      border: 1px solid ${ACCENT};
      font-family: monospace; font-size: 12px; cursor: pointer;
    `;
    this.sendBtn.addEventListener("click", () => { void this.send(); });
    inputRow.appendChild(this.sendBtn);
    panel.appendChild(inputRow);
  }

  private async send(): Promise<void> {
    if (this.busy) return;
    const prompt = this.inputEl.value.trim();
    if (!prompt) return;
    const draft = this.getDraft();
    if (!draft.persona.trim()) {
      this.statusEl.textContent = "Add a PERSONA to the form before testing chat.";
      return;
    }
    this.busy = true;
    this.sendBtn.disabled = true;
    this.inputEl.disabled = true;
    this.inputEl.value = "";
    this.history.push({ role: "user", content: prompt });
    this.renderHistory();
    this.statusEl.textContent = `${draft.name || "The NPC"} is thinking…`;

    try {
      const { reply } = await gameClient.testNpcChat(
        {
          name: draft.name,
          monsterClass: draft.monsterClass,
          factionId: draft.factionId,
          persona: draft.persona,
        },
        // Send the history WITHOUT the just-pushed user prompt — the server
        // appends the prompt itself, so passing it again would double up.
        this.history.slice(0, -1),
        prompt,
      );
      this.history.push({ role: "assistant", content: reply });
      this.renderHistory();
      this.statusEl.textContent = "";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.statusEl.textContent = `Failed: ${msg}`;
      // Roll back the user message so the player can edit + retry.
      this.history.pop();
      this.inputEl.value = prompt;
    } finally {
      this.busy = false;
      this.sendBtn.disabled = false;
      this.inputEl.disabled = false;
      this.inputEl.focus();
    }
  }

  private renderHistory(): void {
    let html = "";
    if (this.history.length === 0) {
      html = `<div style="color:#667788;font-style:italic;font-size:11px;text-align:center;padding:40px 8px;">No messages yet. Try greeting them, asking who they are, or sketching a scene. The NPC speaks ONLY from their persona — the responses tell you whether the voice you wrote actually lands.</div>`;
    }
    for (const msg of this.history) {
      if (msg.role === "user") {
        html += `<div style="color:${ACCENT};margin-bottom:8px">▸ ${escHtml(msg.content)}</div>`;
      } else {
        const md = String(marked.parse(msg.content));
        html += `<div class="npc-test-msg" style="color:${TEXT};margin-bottom:8px">${md}</div>`;
      }
    }
    this.chatEl.innerHTML = html;
    this.chatEl.scrollTop = this.chatEl.scrollHeight;
  }
}
