import { marked } from 'marked';
import {
  TILE_SIZE, GRID_COLS, GRID_ROWS, HUD_HEIGHT,
  PLAYER_PANEL_WIDTH, TARGET_PANEL_WIDTH,
} from '../constants';
import { CombatMode, LogEntry, LogEntryStyle } from '../../../shared/types';
import { NpcToken } from '../entities/NpcToken';
import { PlayerDef } from '../../../shared/types';
import { UIScale } from './UIScale';
import { DevMode } from '../devMode';
import type { ChatMessage, GMPersona } from './AIGMOverlay';

const GRID_H  = GRID_ROWS * TILE_SIZE;
const GRID_W  = GRID_COLS * TILE_SIZE;
const TOTAL_W = PLAYER_PANEL_WIDTH + GRID_W + TARGET_PANEL_WIDTH;

const RESIZE_HANDLE_H  = 8;
const RESIZE_HANDLE_W  = 8;
const ROW_H            = 14;
// Turn-order chip sizes — square token tiles. The active chip is 30% bigger
// (per the LABELS/turn-order spec) and the bar height fits that enlarged
// chip with a few px of vertical padding.
const CHIP_SIZE        = 36;
const CHIP_ACTIVE_SIZE = Math.round(CHIP_SIZE * 1.3); // ≈ 47
const CHIP_GAP         = 6;
const BAR_H            = CHIP_ACTIVE_SIZE + 6;
const MIN_HUD_HEIGHT   = 80;
const MAX_HUD_HEIGHT   = 350;
const MIN_HUD_WIDTH    = 300;
const MAX_HUD_WIDTH    = Math.floor(TOTAL_W / 2);
const DEFAULT_HUD_WIDTH = 700;
const HUD_HEIGHT_KEY   = 'myrpg_hud_height';
const HUD_WIDTH_KEY    = 'myrpg_hud_width';

const ACCENT      = '#e2b96f';
const MSG_GAP     = 8;
const ROLL_PREFIX = '[Roll] ';
const DM_STYLE_ID = 'hud-dm-chat-style';

function injectDmStyle(): void {
  if (document.getElementById(DM_STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = DM_STYLE_ID;
  el.textContent = `
    .hud-dm-msg p  { margin: 0 0 4px 0; }
    .hud-dm-msg strong { color: #f0e0c0; }
    .hud-dm-msg em { color: #d0c090; font-style: italic; }
    .hud-dm-msg ul, .hud-dm-msg ol { margin: 4px 0; padding-left: 16px; }
    .hud-dm-msg li { margin: 2px 0; }
    .hud-dm-msg h1, .hud-dm-msg h2, .hud-dm-msg h3 {
      color: ${ACCENT}; margin: 6px 0 4px; font-size: 1em;
      text-transform: uppercase; letter-spacing: 0.05em;
    }
    .hud-dm-msg code { background: #1a1a2e; padding: 0 3px; border-radius: 2px; font-family: monospace; }
    .hud-dm-msg pre  { background: #1a1a2e; padding: 6px 8px; border-radius: 3px; overflow-x: auto; margin: 4px 0; }
    .hud-dm-msg blockquote { border-left: 2px solid ${ACCENT}; padding-left: 8px; color: #a0b0c0; margin: 4px 0; }
    .hud-dm-msg hr { border: none; border-top: 1px solid #334455; margin: 6px 0; }
  `;
  document.head.appendChild(el);
}

function styleColor(s?: LogEntryStyle): string {
  switch (s) {
    case 'hit':    return '#7ec8a0';
    case 'crit':   return '#ffe080';
    case 'kill':   return '#ff8888';
    case 'heal':   return '#88dd88';
    case 'status': return '#88aacc';
    case 'header': return '#ddeeff';
    case 'miss':   return '#667788';
    default:       return '#aabbcc';
  }
}

function styleColorDim(s?: LogEntryStyle): string {
  switch (s) {
    case 'hit':    return '#5a9070';
    case 'crit':   return '#b8a050';
    case 'kill':   return '#b86060';
    case 'heal':   return '#60a060';
    case 'status': return '#607890';
    case 'header': return '#99bbcc';
    case 'miss':   return '#445566';
    default:       return '#778899';
  }
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isDmRoll(content: string): boolean { return content.startsWith(ROLL_PREFIX); }
function isDmRollSuccess(content: string): boolean { return /SUCCESS/.test(content); }

export interface TurnOrderChip {
  /** Combat label letter overlaid on the token (e.g. `A`, `B`). Empty for
   *  the player (player has no combat label) and for neutral NPCs that
   *  haven't been assigned a label. */
  label: string;
  /** Display name — surfaced via the chip's `title` (tooltip) attribute so
   *  the bar can stay compact while still revealing creature identity on
   *  hover. */
  name: string;
  /** Token colour — used for the active-chip outline + dead-token tint. */
  color: number;
  /** Resolved token-SVG URL (absolute, including the API origin so the
   *  HUD's HTML `<img>` can fetch it directly). */
  tokenUrl: string;
  /** Currently taking their turn — renders 30% larger with a coloured ring. */
  isActive: boolean;
  /** Dead — dimmed in the bar. */
  isDead: boolean;
}

export interface HUDState {
  mode: CombatMode;
  playerDef: PlayerDef;
  playerHp: number;
  /** Initiative-ordered chips for the turn-order bar; empty when not in combat. */
  turnOrderChips: TurnOrderChip[];
  eventLog: LogEntry[];
  selectedNpcName: string | null;
}

export interface HUDCallbacks {
  onSendAIGM: (message: string, persona: GMPersona) => Promise<{ reply: string; rollResults: string[] }>;
  onDisableKeyboard: () => void;
  onEnableKeyboard: () => void;
  /** Fires when the player toggles the LABELS chip in the GM panel.
   *  GameScene iterates its NpcTokens and calls `setNameVisible(visible)`
   *  on each so nameplates show or hide in sync. */
  onLabelsToggle: (visible: boolean) => void;
  /** Fires when the player sends a `sayto` chat message (either through the
   *  HUD's chat input while the GM-mode dropup is set to `sayto`, or through
   *  the TALK button on the Player Panel which routes through
   *  `HUD.sendSayto`). The scene reads its own `selectedEntityId` to find
   *  the avoid-target so the bubble flips below the player when it would
   *  otherwise cover the target token. */
  onPlayerSays?: (text: string) => void;
}

export class HUD {
  private readonly hudEl: HTMLDivElement;
  private readonly turnOrderEl: HTMLDivElement;
  private readonly logEl: HTMLElement;
  private readonly logTabBtn: HTMLButtonElement;
  private readonly gmTabBtn: HTMLButtonElement;
  private readonly gmContentEl: HTMLElement;
  private readonly gmChatEl: HTMLDivElement;
  private readonly gmInputEl: HTMLInputElement;
  private readonly gmStatusEl: HTMLElement;
  private readonly gmStoryChip: HTMLButtonElement;
  private readonly gmDevChip: HTMLButtonElement | null;
  private readonly gmLabelsChip: HTMLButtonElement;
  private labelsVisible = false;
  private readonly offResize: () => void;
  private readonly scale: UIScale;
  private readonly callbacks: HUDCallbacks;
  private hudHeight: number;
  private hudWidth: number;
  private turnOrderWidth = 0;
  private readonly gmModeBtn: HTMLButtonElement;
  private gmMode: 'gm' | 'sayto' = 'gm';
  private gmDropup: HTMLDivElement | null = null;
  private gmDropupCleanup: (() => void) | null = null;
  private playerName = '';
  private selectedNpcName: string | null = null;
  private gmHistory: ChatMessage[] = [];
  private gmPersona: GMPersona = 'story';
  private gmThinking = false;

  // Streaming AIGM state. `gmStreamingBubble` is the specific assistant
  // message reference being grown by aigm_chunk events — we track it by
  // identity rather than "last entry" because mid-stream side-effects (NPC
  // speech mirrors via `addNpcSpeech`) can push other entries after it.
  // `gmStreamBaseline` is the text length BEFORE the latest run of chunks so
  // aigm_speculative_discard can roll it back.
  private gmStreaming = false;
  private gmStreamingBubble: ChatMessage | null = null;
  private gmStreamBaseline = 0;

  constructor(scale: UIScale, callbacks: HUDCallbacks) {
    this.scale = scale;
    this.callbacks = callbacks;
    injectDmStyle();

    this.hudHeight = Math.max(MIN_HUD_HEIGHT, Math.min(MAX_HUD_HEIGHT,
      parseInt(localStorage.getItem(HUD_HEIGHT_KEY) ?? '') || HUD_HEIGHT,
    ));
    this.hudWidth = Math.max(MIN_HUD_WIDTH, Math.min(MAX_HUD_WIDTH,
      parseInt(localStorage.getItem(HUD_WIDTH_KEY) ?? '') || DEFAULT_HUD_WIDTH,
    ));

    // ── Main HUD panel ────────────────────────────────────────────────────────
    this.hudEl = document.createElement('div');
    this.hudEl.className = 'gui-panel';
    this.hudEl.style.cssText += `
      width: ${this.hudWidth}px;
      height: ${this.hudHeight}px;
      background: #0d0d1e;
      border-top: 2px solid #445566;
      border-left: 2px solid #445566;
      color: #aabbcc;
      z-index: 10;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    `;

    // ── Height resize handle (top edge) ───────────────────────────────────────
    this.hudEl.appendChild(this.buildHeightHandle());

    // ── Tab bar ───────────────────────────────────────────────────────────────
    const tabBar = document.createElement('div');
    tabBar.style.cssText = `display:flex;flex-shrink:0;border-bottom:1px solid #223344;`;
    tabBar.innerHTML = `
      <button data-tab-log style="padding:6px 16px;font-size:10px;font-family:monospace;cursor:pointer;
        background:transparent;border:none;border-bottom:2px solid #aabbcc;
        color:#ddeeff;text-transform:uppercase;letter-spacing:0.08em;">EVENT LOG</button>
      <button data-tab-dm style="padding:6px 16px;font-size:10px;font-family:monospace;cursor:pointer;
        background:transparent;border:none;border-bottom:2px solid transparent;
        color:#556677;text-transform:uppercase;letter-spacing:0.08em;">GAME MASTER</button>
    `;
    this.hudEl.appendChild(tabBar);

    this.logTabBtn = tabBar.querySelector('[data-tab-log]') as HTMLButtonElement;
    this.gmTabBtn  = tabBar.querySelector('[data-tab-dm]')  as HTMLButtonElement;
    this.logTabBtn.onclick = () => this.switchTab('log');
    this.gmTabBtn.onclick  = () => this.switchTab('gm');

    // ── Combat log content ────────────────────────────────────────────────────
    this.logEl = document.createElement('div');
    this.logEl.className = 'gui-selectable';
    this.logEl.style.cssText = `
      flex: 1;
      overflow-y: auto;
      padding: 4px 12px 6px;
      font-size: 11px;
      font-family: monospace;
      scrollbar-width: thin;
      scrollbar-color: #445566 transparent;
      min-height: 0;
    `;
    this.hudEl.appendChild(this.logEl);

    // ── GM tab content ────────────────────────────────────────────────────────
    this.gmContentEl = document.createElement('div');
    this.gmContentEl.style.cssText = `
      flex: 1;
      display: none;
      flex-direction: column;
      min-height: 0;
      padding: 8px 12px 8px;
    `;
    this.gmContentEl.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-shrink:0;">
        <button data-gm-chip="story" style="width:56px;height:18px;font-family:monospace;font-size:9px;
          cursor:pointer;border:1px solid ${ACCENT};background:#1a1a00;color:${ACCENT};">STORY</button>
        ${DevMode.enabled ? `<button data-gm-chip="dev" style="width:56px;height:18px;font-family:monospace;font-size:9px;
          cursor:pointer;border:1px solid #224422;background:#001a00;color:#336633;">DEV</button>` : ''}
        <div style="flex:1;"></div>
        <button data-gm-labels style="width:64px;height:18px;font-family:monospace;font-size:9px;
          cursor:pointer;border:1px solid #4a78d8;background:#0c1830;color:#9cc4ff;">LABELS</button>
      </div>
      <div data-gm-chat style="flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;
        scrollbar-width:thin;scrollbar-color:${ACCENT} transparent;
        background:#080812;padding:6px 10px;box-sizing:border-box;
        font-size:11px;line-height:1.55;color:#c8d8e8;"></div>
      <div data-gm-status style="font-size:10px;color:#b8960c;padding:2px 0 4px;flex-shrink:0;min-height:0;"></div>
      <div style="height:1px;background:#334455;flex-shrink:0;margin:0 0 6px;"></div>
      <div style="display:flex;gap:6px;flex-shrink:0;">
        <button data-gm-mode style="height:30px;padding:0 8px;flex-shrink:0;
          font-family:monospace;font-size:10px;cursor:pointer;
          background:#111122;border:1px solid #445566;color:#aabbcc;
          white-space:nowrap;">GM ▾</button>
        <input data-gm-input type="text" maxlength="300" autocomplete="off"
          placeholder="Speak to the Game Master…"
          style="flex:1;height:30px;background:#111122;border:1px solid #554422;
            color:#e0d0a0;font-family:monospace;font-size:12px;padding:0 8px;
            outline:none;box-sizing:border-box;caret-color:${ACCENT};" />
        <button data-gm-send class="gui-btn-hud" style="width:72px;height:30px;background:#2a1e08;
          border:1px solid ${ACCENT};color:${ACCENT};font-size:12px;flex-shrink:0;">SEND</button>
      </div>
    `;
    this.hudEl.appendChild(this.gmContentEl);

    const gmRef = (a: string) => this.gmContentEl.querySelector(`[data-${a}]`) as HTMLElement;
    this.gmChatEl   = gmRef('gm-chat')   as HTMLDivElement;
    this.gmChatEl.classList.add('gui-selectable');
    this.gmInputEl  = gmRef('gm-input')  as HTMLInputElement;
    this.gmStatusEl = gmRef('gm-status');
    this.gmModeBtn  = gmRef('gm-mode')   as HTMLButtonElement;
    this.gmStoryChip = this.gmContentEl.querySelector('[data-gm-chip="story"]') as HTMLButtonElement;
    this.gmDevChip   = this.gmContentEl.querySelector('[data-gm-chip="dev"]')   as HTMLButtonElement | null;
    this.gmLabelsChip = this.gmContentEl.querySelector('[data-gm-labels]')      as HTMLButtonElement;

    this.gmStoryChip.addEventListener('pointerdown', () => { this.gmPersona = 'story'; this.refreshDmChips(); });
    this.gmDevChip?.addEventListener('pointerdown',  () => { this.gmPersona = 'dev';   this.refreshDmChips(); });
    this.gmLabelsChip.addEventListener('pointerdown', () => {
      this.labelsVisible = !this.labelsVisible;
      this.refreshLabelsChip();
      this.callbacks.onLabelsToggle(this.labelsVisible);
    });
    this.refreshLabelsChip();

    this.gmModeBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.openDmDropup(); });
    (gmRef('gm-send') as HTMLButtonElement).addEventListener('pointerdown', () => this.sendGm());
    this.gmInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter')      { e.preventDefault(); this.sendGm(); }
      else if (e.key === 'ArrowUp')   { e.preventDefault(); this.gmChatEl.scrollTop -= 48; }
      else if (e.key === 'ArrowDown') { e.preventDefault(); this.gmChatEl.scrollTop += 48; }
    });
    this.gmInputEl.addEventListener('focus', () => callbacks.onDisableKeyboard());
    this.gmInputEl.addEventListener('blur',  () => callbacks.onEnableKeyboard());

    // ── Width resize handle (left edge) ───────────────────────────────────────
    this.hudEl.appendChild(this.buildWidthHandle());

    document.body.appendChild(this.hudEl);

    // ── Turn order bar ────────────────────────────────────────────────────────
    this.turnOrderEl = document.createElement('div');
    // No `gui-panel` class — we want a transparent, borderless bar so the
    // chips float against the game canvas without a panel chrome behind
    // them. Position is absolute so `scale.placePanel` can pin it.
    this.turnOrderEl.style.cssText += `
      position: absolute;
      height: ${BAR_H}px;
      background: transparent;
      border: none;
      display: none;
      align-items: center;
      overflow: visible;
      z-index: 15;
    `;
    document.body.appendChild(this.turnOrderEl);

    this.place();
    this.offResize = scale.onChange(() => this.place());
  }

  private place(): void {
    const gameX = TOTAL_W - this.hudWidth;
    const gameY = GRID_H + HUD_HEIGHT - this.hudHeight;
    this.scale.placePanel(this.hudEl, gameX, gameY);
    const barX = Math.round((TOTAL_W - this.turnOrderWidth) / 2);
    this.scale.placePanel(this.turnOrderEl, barX, 0);
  }

  private buildHeightHandle(): HTMLDivElement {
    const handle = document.createElement('div');
    handle.style.cssText = `
      height: ${RESIZE_HANDLE_H}px;
      flex-shrink: 0;
      cursor: row-resize;
    `;
    handle.title = 'Drag to resize height';

    let dragging = false;
    let dragStartY = 0;
    let dragStartH = 0;

    handle.addEventListener('pointerdown', (e) => {
      dragging = true;
      dragStartY = e.clientY;
      dragStartH = this.hudHeight;
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const newH = Math.max(MIN_HUD_HEIGHT, Math.min(MAX_HUD_HEIGHT,
        dragStartH + (dragStartY - e.clientY) / this.scale.factor,
      ));
      this.hudHeight = newH;
      this.hudEl.style.height = `${newH}px`;
      this.place();
    });
    handle.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      localStorage.setItem(HUD_HEIGHT_KEY, String(Math.round(this.hudHeight)));
    });

    return handle;
  }

  private buildWidthHandle(): HTMLDivElement {
    const handle = document.createElement('div');
    handle.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: ${RESIZE_HANDLE_W}px;
      height: 100%;
      cursor: col-resize;
      z-index: 20;
    `;
    handle.title = 'Drag to resize width';

    let dragging = false;
    let dragStartX = 0;
    let dragStartW = 0;

    handle.addEventListener('pointerdown', (e) => {
      dragging = true;
      dragStartX = e.clientX;
      dragStartW = this.hudWidth;
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const newW = Math.max(MIN_HUD_WIDTH, Math.min(MAX_HUD_WIDTH,
        dragStartW + (dragStartX - e.clientX) / this.scale.factor,
      ));
      this.hudWidth = newW;
      this.hudEl.style.width = `${newW}px`;
      this.place();
    });
    handle.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      localStorage.setItem(HUD_WIDTH_KEY, String(Math.round(this.hudWidth)));
    });

    return handle;
  }

  private switchTab(tab: 'log' | 'gm'): void {
    const onLog = tab === 'log';
    this.logEl.style.display = onLog ? 'block' : 'none';
    this.gmContentEl.style.display = onLog ? 'none' : 'flex';
    this.logTabBtn.style.borderBottomColor = onLog ? '#aabbcc' : 'transparent';
    this.logTabBtn.style.color             = onLog ? '#ddeeff' : '#556677';
    this.gmTabBtn.style.borderBottomColor  = onLog ? 'transparent' : ACCENT;
    this.gmTabBtn.style.color              = onLog ? '#556677' : ACCENT;
    // No auto-focus when revealing the GM tab. The user must explicitly
    // click into the input to start typing — otherwise WASD keeps moving
    // the player while the chat is visible.
  }

  private refreshDmChips(): void {
    const isStory = this.gmPersona === 'story';
    this.gmStoryChip.style.borderColor = isStory ? ACCENT   : '#443300';
    this.gmStoryChip.style.color       = isStory ? ACCENT   : '#665533';
    if (this.gmDevChip) {
      this.gmDevChip.style.borderColor = !isStory ? '#44cc44' : '#224422';
      this.gmDevChip.style.color       = !isStory ? '#66ee66' : '#336633';
    }
  }

  /** Active (labels visible): bright blue border + text. Inactive: greyed out. */
  private refreshLabelsChip(): void {
    if (this.labelsVisible) {
      this.gmLabelsChip.style.borderColor = '#5588ff';
      this.gmLabelsChip.style.background  = '#0c1830';
      this.gmLabelsChip.style.color       = '#cce0ff';
    } else {
      this.gmLabelsChip.style.borderColor = '#334455';
      this.gmLabelsChip.style.background  = '#0a0a14';
      this.gmLabelsChip.style.color       = '#556677';
    }
  }

  private async sendGm(): Promise<void> {
    const text = this.gmInputEl.value.trim();
    if (!text || this.gmThinking) return;
    this.gmInputEl.value = '';
    await this.dispatchPlayerMessage(text, this.gmMode);
    // No forced re-focus after send: if the user pressed Enter to send,
    // focus is already on the input and they can keep typing. If they
    // clicked SEND with the mouse, leaving focus on the body lets WASD
    // movement work immediately.
  }

  /** Public entry point for the Player Panel's TALK button. Forces the
   *  message through the `sayto` branch (wrapped + speech-bubble emitted)
   *  using whichever target is currently selected. No-op when no target is
   *  selected or the GM is already mid-response. */
  async sendSayto(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || !this.selectedNpcName) return;
    await this.dispatchPlayerMessage(trimmed, 'sayto');
  }

  /** Shared implementation behind both the in-HUD chat send and the Player
   *  Panel TALK button. Emits the player-speech-bubble callback when the
   *  message is a sayto, then ships the (possibly wrapped) prompt to the
   *  AIGM streaming path. */
  private async dispatchPlayerMessage(text: string, mode: 'gm' | 'sayto'): Promise<void> {
    if (!text || this.gmThinking) return;
    const isSayto = mode === 'sayto' && !!this.selectedNpcName;
    const prompt = isSayto
      ? `[${this.playerName} says to ${this.selectedNpcName}]: ${text}`
      : text;
    if (isSayto) {
      // Surface the spoken line above the player token so the player sees
      // their own dialogue visualised the same way NPC speech is.
      this.callbacks.onPlayerSays?.(text);
    }

    this.gmThinking = true;
    this.gmInputEl.disabled = true;
    this.gmHistory.push({ role: 'user', content: prompt });
    this.renderDmHistory();
    this.gmStatusEl.textContent = 'The Game Master considers…';

    try {
      // Streaming chunks arrive in parallel via aigmChunk(). The HTTP promise
      // resolves after the final aigm_done has fired. We rely on aigmDone() to
      // append the rollResults and finalize the streaming bubble; the HTTP
      // result is just a confirmation that the round completed.
      await this.callbacks.onSendAIGM(prompt, this.gmPersona);
    } catch {
      // If streaming never produced anything, leave an apology in the bubble.
      if (this.gmStreaming) {
        this.aigmDone('(The Game Master is silent.)', []);
      } else {
        this.gmHistory.push({ role: 'assistant', content: '(The Game Master is silent.)' });
        this.renderDmHistory();
      }
    }

    this.gmThinking = false;
    this.gmInputEl.disabled = false;
    this.gmStatusEl.textContent = '';
  }

  // ── Streaming AIGM handlers (called from GameClient via GameScene) ─────────

  aigmStart(): void {
    // Open a fresh assistant bubble that incoming chunks will append to. Keep
    // a reference to it so mid-stream pushes by addNpcSpeech don't shadow it.
    const bubble: ChatMessage = { role: 'assistant', content: '' };
    this.gmHistory.push(bubble);
    this.gmStreamingBubble = bubble;
    this.gmStreaming = true;
    this.gmStreamBaseline = 0;
    this.renderDmHistory();
  }

  aigmChunk(text: string): void {
    if (!this.gmStreaming || !this.gmStreamingBubble) return;
    this.gmStreamingBubble.content += text;
    this.renderDmHistory();
  }

  aigmCheckpoint(): void {
    if (!this.gmStreaming || !this.gmStreamingBubble) return;
    // The current run of chunks is canonical — future discards can only revert
    // to here, not earlier.
    this.gmStreamBaseline = this.gmStreamingBubble.content.length;
  }

  aigmSpeculativeDiscard(): void {
    if (!this.gmStreaming || !this.gmStreamingBubble) return;
    this.gmStreamingBubble.content = this.gmStreamingBubble.content.slice(0, this.gmStreamBaseline);
    this.renderDmHistory();
  }

  aigmDone(reply: string, rollResults: string[]): void {
    if (this.gmStreaming && this.gmStreamingBubble) {
      // Replace the streamed text with the canonical reply (handles any
      // post-processing trim/whitespace differences) IN PLACE on the
      // tracked bubble — never pop the array's last entry, because
      // addNpcSpeech may have appended NPC-speech mirrors after the bubble
      // mid-stream (popping would silently delete the last NPC line).
      this.gmStreamingBubble.content = reply;
      // Insert roll results immediately before the streaming bubble so they
      // appear in the same order as the non-streaming path.
      const idx = this.gmHistory.indexOf(this.gmStreamingBubble);
      if (idx >= 0 && rollResults.length > 0) {
        const rollMsgs: ChatMessage[] = rollResults.map((r) => ({ role: 'user', content: ROLL_PREFIX + r }));
        this.gmHistory.splice(idx, 0, ...rollMsgs);
      }
    } else {
      for (const r of rollResults) {
        this.gmHistory.push({ role: 'user', content: ROLL_PREFIX + r });
      }
      this.gmHistory.push({ role: 'assistant', content: reply });
    }
    this.gmStreaming = false;
    this.gmStreamingBubble = null;
    this.gmStreamBaseline = 0;
    this.renderDmHistory();
  }

  private renderDmHistory(): void {
    let html = '';
    for (const msg of this.gmHistory) {
      const roll = isDmRoll(msg.content);
      if (roll) {
        const content = escHtml(msg.content.slice(ROLL_PREFIX.length));
        const color = isDmRollSuccess(msg.content) ? '#66ee88' : '#ee6644';
        html += `<div style="color:${color};margin-bottom:${MSG_GAP}px">🎲 ${content}</div>`;
      } else if (msg.role === 'user') {
        html += `<div style="color:${ACCENT};margin-bottom:${MSG_GAP}px">▸ ${escHtml(msg.content)}</div>`;
      } else {
        const md = String(marked.parse(msg.content));
        html += `<div class="hud-dm-msg" style="color:#c8d8e8;margin-bottom:${MSG_GAP}px">${md}</div>`;
      }
    }
    this.gmChatEl.innerHTML = html;
    this.gmChatEl.scrollTop = this.gmChatEl.scrollHeight;
  }

  seedGmHistory(history: ChatMessage[]): void {
    if (history.length > 0) {
      this.gmHistory = [...history];
      this.renderDmHistory();
    }
  }

  /**
   * Append a one-shot assistant message to the GM chat without going through
   * the streaming pipeline. Used by the IntroductionOverlay close handler so
   * the opening narration stays visible in the chat after the modal is
   * dismissed.
   */
  addGmAssistantMessage(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.gmHistory.push({ role: 'assistant', content: trimmed });
    this.renderDmHistory();
  }

  /** Focus the GM input — used by the ConversationOverlay's "Speak freely"
   *  hand-off (Phase 5 will pre-load the transcript here). */
  openGmInput(): void {
    this.gmInputEl.focus();
  }

  /**
   * Mirror an NPC's spoken line into the GM chat so it persists as a
   * scrollable record alongside the transient speech bubble above the
   * speaker's token. Formats the entry so the speaker is visually distinct
   * from regular GM prose.
   */
  addNpcSpeech(speakerName: string, text: string): void {
    const t = text.trim();
    if (!t) return;
    this.gmHistory.push({ role: 'assistant', content: `**${speakerName}:** "${t}"` });
    this.renderDmHistory();
  }

  refresh(state: HUDState): void {
    this.playerName = state.playerDef.name;
    this.selectedNpcName = state.selectedNpcName;
    if (this.gmMode === 'sayto' && !this.selectedNpcName) this.gmMode = 'gm';
    this.refreshDmModeBtn();
    this.refreshTurnOrder(state);
    this.refreshLog(state.eventLog);
  }

  private refreshDmModeBtn(): void {
    if (this.gmMode === 'gm') {
      this.gmModeBtn.textContent = 'GM ▾';
      this.gmModeBtn.style.color       = '#aabbcc';
      this.gmModeBtn.style.borderColor = '#445566';
    } else {
      const short = this.selectedNpcName!.split(' ')[0].toUpperCase();
      this.gmModeBtn.textContent = `${short} ▾`;
      this.gmModeBtn.style.color       = ACCENT;
      this.gmModeBtn.style.borderColor = ACCENT;
    }
  }

  private openDmDropup(): void {
    this.closeDmDropup();

    const rect = this.gmModeBtn.getBoundingClientRect();

    const menu = document.createElement('div');
    menu.style.cssText = `
      position:fixed;
      left:${rect.left}px;
      bottom:${window.innerHeight - rect.top}px;
      background:#0d0d1e;
      border:1px solid #445566;
      z-index:200;
      min-width:${rect.width}px;
      font-family:monospace;
      font-size:11px;
      color:#aabbcc;
    `;

    const options: { label: string; value: 'gm' | 'sayto'; disabled: boolean }[] = [
      { label: 'Game Master',
        value: 'gm',
        disabled: false },
      { label: this.selectedNpcName ? `Say to ${this.selectedNpcName}` : 'Say to (no target)',
        value: 'sayto',
        disabled: !this.selectedNpcName },
    ];

    for (const opt of options) {
      const item = document.createElement('div');
      const isActive = opt.value === this.gmMode;
      item.style.cssText = `
        padding:6px 10px;
        cursor:${opt.disabled ? 'default' : 'pointer'};
        color:${opt.disabled ? '#334455' : isActive ? '#ddeeff' : '#aabbcc'};
        background:${isActive ? '#1a2a3a' : 'transparent'};
        white-space:nowrap;
      `;
      item.textContent = opt.label;
      if (!opt.disabled) {
        item.addEventListener('pointerover', () => { item.style.background = '#1a2a3a'; });
        item.addEventListener('pointerout',  () => { item.style.background = isActive ? '#1a2a3a' : 'transparent'; });
        item.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          this.gmMode = opt.value;
          this.refreshDmModeBtn();
          this.closeDmDropup();
        });
      }
      menu.appendChild(item);
    }

    document.body.appendChild(menu);
    this.gmDropup = menu;

    const onOutside = (e: PointerEvent) => {
      if (!menu.contains(e.target as Node) && e.target !== this.gmModeBtn) this.closeDmDropup();
    };
    setTimeout(() => document.addEventListener('pointerdown', onOutside), 0);
    this.gmDropupCleanup = () => document.removeEventListener('pointerdown', onOutside);
  }

  private closeDmDropup(): void {
    this.gmDropupCleanup?.();
    this.gmDropupCleanup = null;
    this.gmDropup?.remove();
    this.gmDropup = null;
  }

  private refreshTurnOrder(state: HUDState): void {
    const inCombat = state.mode !== 'exploring' && state.turnOrderChips.length > 0;
    this.turnOrderEl.style.display = inCombat ? 'flex' : 'none';
    if (!inCombat) return;

    const chips = state.turnOrderChips;

    // Per-chip widths vary (active is 30% larger); compute the total so the
    // bar self-centres on the canvas.
    const widths = chips.map((c) => (c.isActive ? CHIP_ACTIVE_SIZE : CHIP_SIZE));
    const totalW = widths.reduce((a, w) => a + w, 0) + (chips.length - 1) * CHIP_GAP;
    this.turnOrderWidth = totalW;
    this.turnOrderEl.style.width = `${totalW}px`;
    this.place();

    let x = 0;
    this.turnOrderEl.innerHTML = chips.map((chip, i) => {
      const size = widths[i];
      const opacity = chip.isDead ? '0.3' : '1';
      // Top-align so the active (taller) chip grows DOWN from the same
      // baseline as the resting chips, rather than upward into the bar.
      const top = 3;
      const left = x;
      x += size + CHIP_GAP;
      // No chip background or border — the token sprite is the chip. The
      // 30% size bump is the active-state indicator. Combat label still
      // appears as a small floating badge in the bottom-right corner.
      const labelBadge = chip.label
        ? `<div style="position:absolute;right:-2px;bottom:-2px;min-width:14px;height:14px;
            padding:0 3px;background:#0a0a14;color:#ffe9a8;
            font-family:monospace;font-size:10px;font-weight:bold;display:flex;
            align-items:center;justify-content:center;border-radius:2px;">${escHtml(chip.label)}</div>`
        : '';
      return `
        <div title="${escHtml(chip.name)}" style="position:absolute;left:${left}px;top:${top}px;
          width:${size}px;height:${size}px;opacity:${opacity};">
          <img src="${escHtml(chip.tokenUrl)}" alt="" draggable="false"
            style="width:${size}px;height:${size}px;display:block;pointer-events:none;" />
          ${labelBadge}
        </div>`;
    }).join('');
  }

  private refreshLog(eventLog: LogEntry[]): void {
    const atBottom = this.logEl.scrollHeight - this.logEl.clientHeight <= this.logEl.scrollTop + 20;

    this.logEl.innerHTML = eventLog.map(entry => {
      const lc    = styleColor(entry.style);
      const rc    = styleColorDim(entry.style);
      const lhtml = String(marked.parseInline(entry.left));
      const rhtml = entry.right ? escHtml(entry.right) : '';
      return `<div style="display:flex;justify-content:space-between;align-items:flex-start;min-height:${ROW_H}px;padding:1px 0;">
        <span style="color:${lc};flex:1;min-width:0;overflow-wrap:break-word;word-break:break-word;padding-left:12px;text-indent:-12px;">${lhtml}</span>
        ${rhtml ? `<span style="color:${rc};padding-left:8px;flex-shrink:0;">${rhtml}</span>` : ''}
      </div>`;
    }).join('');

    if (atBottom) this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  destroy(): void {
    this.closeDmDropup();
    this.offResize();
    this.hudEl.remove();
    this.turnOrderEl.remove();
  }

  /** Show / hide the HUD chrome (main bar + turn-order bar). Used by the
   *  focused-announcement flow on the scene so the player can't read past
   *  the announcement at the same time. Must restore the explicit `flex`
   *  layout — the original cssText sets `display: flex` and the `.gui-panel`
   *  class has no display rule, so an empty string would fall back to
   *  block-layout and collapse the chat area + push the input upward. */
  setVisible(visible: boolean): void {
    this.hudEl.style.display = visible ? 'flex' : 'none';
    this.hudEl.style.opacity = '1';
    this.hudEl.style.transition = '';
    // The turn-order bar's own visibility is driven by combat state; only
    // hide it on top of that — the next `refresh()` flips it back to `flex`
    // (combat) or `none` (out of combat) as appropriate.
    if (!visible) this.turnOrderEl.style.display = 'none';
  }

  /** Animated counterpart to `setVisible(false)` — fades the HUD and turn
   *  order bar out over `durationMs`. Resolves once the transition is done
   *  and the elements have been moved to `display: none`. Pairs with
   *  `fadeIn` for the focused-announcement lead-in / lead-out. */
  fadeOut(durationMs = 250): Promise<void> {
    if (this.hudEl.style.display === 'none') return Promise.resolve();
    this.hudEl.style.transition = `opacity ${durationMs}ms ease-in`;
    this.turnOrderEl.style.transition = `opacity ${durationMs}ms ease-in`;
    this.hudEl.style.opacity = '0';
    this.turnOrderEl.style.opacity = '0';
    return new Promise<void>((resolve) => setTimeout(() => {
      this.hudEl.style.display = 'none';
      this.turnOrderEl.style.display = 'none';
      resolve();
    }, durationMs));
  }

  fadeIn(durationMs = 250): Promise<void> {
    this.hudEl.style.display = 'flex';
    this.hudEl.style.transition = '';
    this.turnOrderEl.style.transition = '';
    this.hudEl.style.opacity = '0';
    this.turnOrderEl.style.opacity = '0';
    void this.hudEl.offsetWidth;
    this.hudEl.style.transition = `opacity ${durationMs}ms ease-out`;
    this.turnOrderEl.style.transition = `opacity ${durationMs}ms ease-out`;
    this.hudEl.style.opacity = '1';
    this.turnOrderEl.style.opacity = '1';
    return new Promise<void>((resolve) => setTimeout(resolve, durationMs));
  }
}
