import { marked } from "marked";
import { BaseOverlay } from "./BaseOverlay";
import { UIScale } from "./UIScale";
import { DevMode } from "../devMode";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export type DMPersona = "story" | "dev";

const ACCENT   = "#e2b96f";
const MSG_GAP  = 8;
const ROLL_PREFIX = "[Roll] ";

function isRollMessage(content: string): boolean { return content.startsWith(ROLL_PREFIX); }
function isRollSuccess(content: string): boolean  { return /SUCCESS/.test(content); }

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const CHAT_STYLE_ID = "aidm-chat-style";

function injectChatStyle(): void {
  if (document.getElementById(CHAT_STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = CHAT_STYLE_ID;
  el.textContent = `
    .aidm-msg p  { margin: 0 0 4px 0; }
    .aidm-msg strong { color: #f0e0c0; }
    .aidm-msg em { color: #d0c090; font-style: italic; }
    .aidm-msg ul, .aidm-msg ol { margin: 4px 0; padding-left: 16px; }
    .aidm-msg li { margin: 2px 0; }
    .aidm-msg h1, .aidm-msg h2, .aidm-msg h3 {
      color: #e2b96f; margin: 6px 0 4px; font-size: 1em;
      text-transform: uppercase; letter-spacing: 0.05em;
    }
    .aidm-msg code { background: #1a1a2e; padding: 0 3px; border-radius: 2px; font-family: monospace; }
    .aidm-msg pre  { background: #1a1a2e; padding: 6px 8px; border-radius: 3px; overflow-x: auto; margin: 4px 0; }
    .aidm-msg blockquote { border-left: 2px solid #e2b96f; padding-left: 8px; color: #a0b0c0; margin: 4px 0; }
    .aidm-msg hr { border: none; border-top: 1px solid #334455; margin: 6px 0; }
  `;
  document.head.appendChild(el);
}

export class AIDMOverlay extends BaseOverlay {
  private readonly chatEl: HTMLDivElement;
  private readonly inputEl: HTMLInputElement;
  private readonly statusEl: HTMLDivElement;
  private readonly storyChip: HTMLButtonElement;
  private readonly devChip: HTMLButtonElement | null;
  private history: ChatMessage[];
  private thinking = false;
  private dmPersona: DMPersona;
  private readonly onSend: (
    playerMessage: string,
    dmPersona: DMPersona,
  ) => Promise<{ reply: string; rollResults: string[] }>;
  private readonly disableKeyboard: () => void;
  private readonly enableKeyboard: () => void;

  constructor(
    scale: UIScale,
    initialHistory: ChatMessage[],
    initialPersona: DMPersona,
    onSend: (
      playerMessage: string,
      dmPersona: DMPersona,
    ) => Promise<{ reply: string; rollResults: string[] }>,
    onClose: (history: ChatMessage[], persona: DMPersona) => void,
    disableKeyboard: () => void,
    enableKeyboard: () => void,
  ) {
    super(scale, 640, 480, ACCENT, () => {
      enableKeyboard();
      onClose(this.history, this.dmPersona);
    });

    injectChatStyle();

    this.history = [...initialHistory];
    this.dmPersona = initialPersona;
    this.onSend = onSend;
    this.disableKeyboard = disableKeyboard;
    this.enableKeyboard = enableKeyboard;

    disableKeyboard();

    this.panelEl.insertAdjacentHTML('beforeend', `
      <div style="display:flex;flex-direction:column;height:100%;padding:12px 16px 12px;box-sizing:border-box;">

        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-shrink:0;padding-right:26px;">
          <div style="font-size:15px;color:${ACCENT};">DUNGEON MASTER</div>
          <div style="display:flex;gap:6px;">
            <button data-chip="story" style="width:56px;height:18px;font-family:monospace;font-size:9px;cursor:pointer;border:1px solid #443300;background:#1a1a00;color:#665533;">STORY</button>
            ${DevMode.enabled ? `<button data-chip="dev" style="width:56px;height:18px;font-family:monospace;font-size:9px;cursor:pointer;border:1px solid #224422;background:#001a00;color:#336633;">DEV</button>` : ''}
          </div>
        </div>

        <div style="height:1px;background:#334455;flex-shrink:0;margin-bottom:6px;"></div>

        <div data-chat style="flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;
          scrollbar-width:thin;scrollbar-color:${ACCENT} transparent;
          background:#080812;padding:6px 10px;box-sizing:border-box;
          font-size:11px;line-height:1.55;color:#c8d8e8;"></div>

        <div style="height:1px;background:#334455;flex-shrink:0;margin-top:6px;"></div>
        <div data-status style="font-size:10px;color:#b8960c;min-height:16px;padding:2px 0;flex-shrink:0;"></div>
        <div style="height:1px;background:#334455;flex-shrink:0;margin-bottom:6px;"></div>

        <div style="display:flex;gap:8px;flex-shrink:0;">
          <input data-input type="text" maxlength="300" autocomplete="off"
            placeholder="Speak to the Dungeon Master…"
            style="flex:1;height:30px;background:#111122;border:1px solid #554422;
              color:#e0d0a0;font-family:monospace;font-size:12px;padding:0 8px;
              outline:none;box-sizing:border-box;caret-color:${ACCENT};" />
          <button data-send class="gui-btn-overlay" style="width:72px;height:30px;background:#2a1e08;
            border:1px solid ${ACCENT};color:${ACCENT};font-size:12px;flex-shrink:0;">SEND</button>
        </div>
      </div>
    `);

    const ref = (a: string) => this.panelEl.querySelector(`[data-${a}]`) as HTMLElement;
    this.chatEl   = ref("chat")  as HTMLDivElement;
    this.inputEl  = ref("input") as HTMLInputElement;
    this.statusEl = ref("status") as HTMLDivElement;
    this.storyChip = this.panelEl.querySelector('[data-chip="story"]') as HTMLButtonElement;
    this.devChip   = this.panelEl.querySelector('[data-chip="dev"]')   as HTMLButtonElement;

    this.refreshChips();

    this.storyChip.addEventListener("pointerdown", () => { this.dmPersona = "story"; this.refreshChips(); });
    this.devChip?.addEventListener("pointerdown",  () => { this.dmPersona = "dev";   this.refreshChips(); });

    (ref("send") as HTMLButtonElement).addEventListener("pointerdown",  () => this.send());

    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); this.send(); }
      else if (e.key === "ArrowUp")   { e.preventDefault(); this.chatEl.scrollTop -= 48; }
      else if (e.key === "ArrowDown") { e.preventDefault(); this.chatEl.scrollTop += 48; }
    });

    if (this.history.length > 0) this.renderHistory();
    this.inputEl.focus();
  }

  private refreshChips(): void {
    const isStory = this.dmPersona === "story";
    this.storyChip.style.borderColor = isStory ? ACCENT   : "#443300";
    this.storyChip.style.color       = isStory ? ACCENT   : "#665533";
    if (this.devChip) {
      this.devChip.style.borderColor = !isStory ? "#44cc44" : "#224422";
      this.devChip.style.color       = !isStory ? "#66ee66" : "#336633";
    }
  }

  private async send(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text || this.thinking) return;
    this.inputEl.value = "";
    await this.sendText(text);
  }

  private async sendText(text: string): Promise<void> {
    if (this.thinking) return;
    this.thinking = true;
    this.inputEl.disabled = true;
    this.history.push({ role: "user", content: text });
    this.renderHistory();
    this.statusEl.textContent = "The Dungeon Master considers…";

    try {
      const { reply, rollResults } = await this.onSend(text, this.dmPersona);
      for (const r of rollResults) {
        this.history.push({ role: "user", content: ROLL_PREFIX + r });
      }
      this.history.push({ role: "assistant", content: reply });
    } catch {
      this.history.push({ role: "assistant", content: "(The Dungeon Master is silent.)" });
    }

    this.thinking = false;
    this.inputEl.disabled = false;
    this.inputEl.focus();
    this.statusEl.textContent = "";
    this.renderHistory();
    this.disableKeyboard();
  }

  private renderHistory(): void {
    let html = "";
    for (const msg of this.history) {
      const roll = isRollMessage(msg.content);
      if (roll) {
        const content = escHtml(msg.content.slice(ROLL_PREFIX.length));
        const color = isRollSuccess(msg.content) ? "#66ee88" : "#ee6644";
        html += `<div style="color:${color};margin-bottom:${MSG_GAP}px">🎲 ${content}</div>`;
      } else if (msg.role === "user") {
        html += `<div style="color:${ACCENT};margin-bottom:${MSG_GAP}px">▸ ${escHtml(msg.content)}</div>`;
      } else {
        const md = String(marked.parse(msg.content));
        html += `<div class="aidm-msg" style="color:#c8d8e8;margin-bottom:${MSG_GAP}px">${md}</div>`;
      }
    }
    this.chatEl.innerHTML = html;
    this.chatEl.scrollTop = this.chatEl.scrollHeight;
  }
}
