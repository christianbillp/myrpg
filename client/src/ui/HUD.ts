import { marked } from 'marked';
import {
  TILE_SIZE, GRID_COLS, GRID_ROWS, HUD_HEIGHT,
  PLAYER_PANEL_WIDTH, TARGET_PANEL_WIDTH,
} from '../constants';
import { CombatMode, LogEntry, LogEntryStyle } from '../net/types';
import { NpcToken } from '../entities/NpcToken';
import { PlayerDef } from '../data/player';
import { UIScale } from './UIScale';
import { DevMode } from '../devMode';
import type { ChatMessage, DMPersona } from './AIDMOverlay';

const GRID_H  = GRID_ROWS * TILE_SIZE;
const GRID_W  = GRID_COLS * TILE_SIZE;
const TOTAL_W = PLAYER_PANEL_WIDTH + GRID_W + TARGET_PANEL_WIDTH;

const RESIZE_HANDLE_H  = 8;
const RESIZE_HANDLE_W  = 8;
const ROW_H            = 14;
const CHIP_W           = 140;
const CHIP_H           = 22;
const CHIP_GAP         = 8;
const BAR_H            = 30;
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
  /** Display label inside the chip — combat label letter for NPCs, '' for player. */
  label: string;
  /** Display name — player name or NPC's revealed/known name. */
  name: string;
  /** Token colour. */
  color: number;
  /** Currently taking their turn. */
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
  combatLog: LogEntry[];
  selectedNpcName: string | null;
}

export interface HUDCallbacks {
  onSendAIDM: (message: string, persona: DMPersona) => Promise<{ reply: string; rollResults: string[] }>;
  onDisableKeyboard: () => void;
  onEnableKeyboard: () => void;
}

export class HUD {
  private readonly hudEl: HTMLDivElement;
  private readonly turnOrderEl: HTMLDivElement;
  private readonly logEl: HTMLElement;
  private readonly logTabBtn: HTMLButtonElement;
  private readonly dmTabBtn: HTMLButtonElement;
  private readonly dmContentEl: HTMLElement;
  private readonly dmChatEl: HTMLDivElement;
  private readonly dmInputEl: HTMLInputElement;
  private readonly dmStatusEl: HTMLElement;
  private readonly dmStoryChip: HTMLButtonElement;
  private readonly dmDevChip: HTMLButtonElement | null;
  private readonly offResize: () => void;
  private readonly scale: UIScale;
  private readonly callbacks: HUDCallbacks;
  private hudHeight: number;
  private hudWidth: number;
  private turnOrderWidth = 0;
  private readonly dmModeBtn: HTMLButtonElement;
  private dmMode: 'dm' | 'sayto' = 'dm';
  private dmDropup: HTMLDivElement | null = null;
  private dmDropupCleanup: (() => void) | null = null;
  private playerName = '';
  private selectedNpcName: string | null = null;
  private dmHistory: ChatMessage[] = [];
  private dmPersona: DMPersona = 'story';
  private dmThinking = false;

  // Streaming AIDM state. While `dmStreaming` is true, the last entry of
  // `dmHistory` is an assistant message being grown by aidm_chunk events;
  // `dmStreamBaseline` is the text length BEFORE the latest run of chunks so
  // aidm_speculative_discard can roll it back.
  private dmStreaming = false;
  private dmStreamBaseline = 0;

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
        color:#ddeeff;text-transform:uppercase;letter-spacing:0.08em;">COMBAT LOG</button>
      <button data-tab-dm style="padding:6px 16px;font-size:10px;font-family:monospace;cursor:pointer;
        background:transparent;border:none;border-bottom:2px solid transparent;
        color:#556677;text-transform:uppercase;letter-spacing:0.08em;">DUNGEON MASTER</button>
    `;
    this.hudEl.appendChild(tabBar);

    this.logTabBtn = tabBar.querySelector('[data-tab-log]') as HTMLButtonElement;
    this.dmTabBtn  = tabBar.querySelector('[data-tab-dm]')  as HTMLButtonElement;
    this.logTabBtn.onclick = () => this.switchTab('log');
    this.dmTabBtn.onclick  = () => this.switchTab('dm');

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

    // ── DM tab content ────────────────────────────────────────────────────────
    this.dmContentEl = document.createElement('div');
    this.dmContentEl.style.cssText = `
      flex: 1;
      display: none;
      flex-direction: column;
      min-height: 0;
      padding: 8px 12px 8px;
    `;
    this.dmContentEl.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-shrink:0;">
        <button data-dm-chip="story" style="width:56px;height:18px;font-family:monospace;font-size:9px;
          cursor:pointer;border:1px solid ${ACCENT};background:#1a1a00;color:${ACCENT};">STORY</button>
        ${DevMode.enabled ? `<button data-dm-chip="dev" style="width:56px;height:18px;font-family:monospace;font-size:9px;
          cursor:pointer;border:1px solid #224422;background:#001a00;color:#336633;">DEV</button>` : ''}
      </div>
      <div data-dm-chat style="flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;
        scrollbar-width:thin;scrollbar-color:${ACCENT} transparent;
        background:#080812;padding:6px 10px;box-sizing:border-box;
        font-size:11px;line-height:1.55;color:#c8d8e8;"></div>
      <div style="height:1px;background:#334455;flex-shrink:0;margin-top:6px;"></div>
      <div data-dm-status style="font-size:10px;color:#b8960c;min-height:16px;padding:2px 0;flex-shrink:0;"></div>
      <div style="height:1px;background:#334455;flex-shrink:0;margin-bottom:6px;"></div>
      <div style="display:flex;gap:6px;flex-shrink:0;">
        <button data-dm-mode style="height:30px;padding:0 8px;flex-shrink:0;
          font-family:monospace;font-size:10px;cursor:pointer;
          background:#111122;border:1px solid #445566;color:#aabbcc;
          white-space:nowrap;">DM ▾</button>
        <input data-dm-input type="text" maxlength="300" autocomplete="off"
          placeholder="Speak to the Dungeon Master…"
          style="flex:1;height:30px;background:#111122;border:1px solid #554422;
            color:#e0d0a0;font-family:monospace;font-size:12px;padding:0 8px;
            outline:none;box-sizing:border-box;caret-color:${ACCENT};" />
        <button data-dm-send class="gui-btn-hud" style="width:72px;height:30px;background:#2a1e08;
          border:1px solid ${ACCENT};color:${ACCENT};font-size:12px;flex-shrink:0;">SEND</button>
      </div>
    `;
    this.hudEl.appendChild(this.dmContentEl);

    const dmRef = (a: string) => this.dmContentEl.querySelector(`[data-${a}]`) as HTMLElement;
    this.dmChatEl   = dmRef('dm-chat')   as HTMLDivElement;
    this.dmChatEl.classList.add('gui-selectable');
    this.dmInputEl  = dmRef('dm-input')  as HTMLInputElement;
    this.dmStatusEl = dmRef('dm-status');
    this.dmModeBtn  = dmRef('dm-mode')   as HTMLButtonElement;
    this.dmStoryChip = this.dmContentEl.querySelector('[data-dm-chip="story"]') as HTMLButtonElement;
    this.dmDevChip   = this.dmContentEl.querySelector('[data-dm-chip="dev"]')   as HTMLButtonElement | null;

    this.dmStoryChip.addEventListener('pointerdown', () => { this.dmPersona = 'story'; this.refreshDmChips(); });
    this.dmDevChip?.addEventListener('pointerdown',  () => { this.dmPersona = 'dev';   this.refreshDmChips(); });

    this.dmModeBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.openDmDropup(); });
    (dmRef('dm-send') as HTMLButtonElement).addEventListener('pointerdown', () => this.sendDm());
    this.dmInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter')      { e.preventDefault(); this.sendDm(); }
      else if (e.key === 'ArrowUp')   { e.preventDefault(); this.dmChatEl.scrollTop -= 48; }
      else if (e.key === 'ArrowDown') { e.preventDefault(); this.dmChatEl.scrollTop += 48; }
    });
    this.dmInputEl.addEventListener('focus', () => callbacks.onDisableKeyboard());
    this.dmInputEl.addEventListener('blur',  () => callbacks.onEnableKeyboard());

    // ── Width resize handle (left edge) ───────────────────────────────────────
    this.hudEl.appendChild(this.buildWidthHandle());

    document.body.appendChild(this.hudEl);

    // ── Turn order bar ────────────────────────────────────────────────────────
    this.turnOrderEl = document.createElement('div');
    this.turnOrderEl.className = 'gui-panel';
    this.turnOrderEl.style.cssText += `
      height: ${BAR_H}px;
      background: rgba(7,7,15,0.92);
      border-bottom: 1px solid #334455;
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

  private switchTab(tab: 'log' | 'dm'): void {
    const onLog = tab === 'log';
    this.logEl.style.display = onLog ? 'block' : 'none';
    this.dmContentEl.style.display = onLog ? 'none' : 'flex';
    this.logTabBtn.style.borderBottomColor = onLog ? '#aabbcc' : 'transparent';
    this.logTabBtn.style.color             = onLog ? '#ddeeff' : '#556677';
    this.dmTabBtn.style.borderBottomColor  = onLog ? 'transparent' : ACCENT;
    this.dmTabBtn.style.color              = onLog ? '#556677' : ACCENT;
    if (!onLog) this.dmInputEl.focus();
  }

  private refreshDmChips(): void {
    const isStory = this.dmPersona === 'story';
    this.dmStoryChip.style.borderColor = isStory ? ACCENT   : '#443300';
    this.dmStoryChip.style.color       = isStory ? ACCENT   : '#665533';
    if (this.dmDevChip) {
      this.dmDevChip.style.borderColor = !isStory ? '#44cc44' : '#224422';
      this.dmDevChip.style.color       = !isStory ? '#66ee66' : '#336633';
    }
  }

  private async sendDm(): Promise<void> {
    const text = this.dmInputEl.value.trim();
    if (!text || this.dmThinking) return;
    this.dmInputEl.value = '';

    const prompt = (this.dmMode === 'sayto' && this.selectedNpcName)
      ? `[${this.playerName} says to ${this.selectedNpcName}]: ${text}`
      : text;

    this.dmThinking = true;
    this.dmInputEl.disabled = true;
    this.dmHistory.push({ role: 'user', content: prompt });
    this.renderDmHistory();
    this.dmStatusEl.textContent = 'The Dungeon Master considers…';

    try {
      // Streaming chunks arrive in parallel via aidmChunk(). The HTTP promise
      // resolves after the final aidm_done has fired. We rely on aidmDone() to
      // append the rollResults and finalize the streaming bubble; the HTTP
      // result is just a confirmation that the round completed.
      await this.callbacks.onSendAIDM(prompt, this.dmPersona);
    } catch {
      // If streaming never produced anything, leave an apology in the bubble.
      if (this.dmStreaming) {
        this.aidmDone('(The Dungeon Master is silent.)', []);
      } else {
        this.dmHistory.push({ role: 'assistant', content: '(The Dungeon Master is silent.)' });
        this.renderDmHistory();
      }
    }

    this.dmThinking = false;
    this.dmInputEl.disabled = false;
    this.dmInputEl.focus();
    this.dmStatusEl.textContent = '';
    this.callbacks.onDisableKeyboard();
  }

  // ── Streaming AIDM handlers (called from GameClient via GameScene) ─────────

  aidmStart(): void {
    // Open a fresh assistant bubble that incoming chunks will append to.
    this.dmHistory.push({ role: 'assistant', content: '' });
    this.dmStreaming = true;
    this.dmStreamBaseline = 0;
    this.renderDmHistory();
  }

  aidmChunk(text: string): void {
    if (!this.dmStreaming) return;
    const last = this.dmHistory[this.dmHistory.length - 1];
    if (!last || last.role !== 'assistant') return;
    last.content += text;
    this.renderDmHistory();
  }

  aidmCheckpoint(): void {
    if (!this.dmStreaming) return;
    const last = this.dmHistory[this.dmHistory.length - 1];
    if (!last || last.role !== 'assistant') return;
    // The current run of chunks is canonical — future discards can only revert
    // to here, not earlier.
    this.dmStreamBaseline = last.content.length;
  }

  aidmSpeculativeDiscard(): void {
    if (!this.dmStreaming) return;
    const last = this.dmHistory[this.dmHistory.length - 1];
    if (!last || last.role !== 'assistant') return;
    last.content = last.content.slice(0, this.dmStreamBaseline);
    this.renderDmHistory();
  }

  aidmDone(reply: string, rollResults: string[]): void {
    if (this.dmStreaming) {
      // Replace the streamed text with the canonical reply (handles any
      // post-processing trim/whitespace differences) and append roll results.
      const last = this.dmHistory[this.dmHistory.length - 1];
      if (last && last.role === 'assistant') {
        // Insert roll results BEFORE the final assistant reply so they appear
        // in the same order as the non-streaming path.
        this.dmHistory.pop();
        for (const r of rollResults) {
          this.dmHistory.push({ role: 'user', content: ROLL_PREFIX + r });
        }
        this.dmHistory.push({ role: 'assistant', content: reply });
      }
    } else {
      for (const r of rollResults) {
        this.dmHistory.push({ role: 'user', content: ROLL_PREFIX + r });
      }
      this.dmHistory.push({ role: 'assistant', content: reply });
    }
    this.dmStreaming = false;
    this.dmStreamBaseline = 0;
    this.renderDmHistory();
  }

  private renderDmHistory(): void {
    let html = '';
    for (const msg of this.dmHistory) {
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
    this.dmChatEl.innerHTML = html;
    this.dmChatEl.scrollTop = this.dmChatEl.scrollHeight;
  }

  seedDmHistory(history: ChatMessage[]): void {
    if (history.length > 0) {
      this.dmHistory = [...history];
      this.renderDmHistory();
    }
  }

  refresh(state: HUDState): void {
    this.playerName = state.playerDef.name;
    this.selectedNpcName = state.selectedNpcName;
    if (this.dmMode === 'sayto' && !this.selectedNpcName) this.dmMode = 'dm';
    this.refreshDmModeBtn();
    this.refreshTurnOrder(state);
    this.refreshLog(state.combatLog);
  }

  private refreshDmModeBtn(): void {
    if (this.dmMode === 'dm') {
      this.dmModeBtn.textContent = 'DM ▾';
      this.dmModeBtn.style.color       = '#aabbcc';
      this.dmModeBtn.style.borderColor = '#445566';
    } else {
      const short = this.selectedNpcName!.split(' ')[0].toUpperCase();
      this.dmModeBtn.textContent = `${short} ▾`;
      this.dmModeBtn.style.color       = ACCENT;
      this.dmModeBtn.style.borderColor = ACCENT;
    }
  }

  private openDmDropup(): void {
    this.closeDmDropup();

    const rect = this.dmModeBtn.getBoundingClientRect();

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

    const options: { label: string; value: 'dm' | 'sayto'; disabled: boolean }[] = [
      { label: 'Dungeon Master',
        value: 'dm',
        disabled: false },
      { label: this.selectedNpcName ? `Say to ${this.selectedNpcName}` : 'Say to (no target)',
        value: 'sayto',
        disabled: !this.selectedNpcName },
    ];

    for (const opt of options) {
      const item = document.createElement('div');
      const isActive = opt.value === this.dmMode;
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
          this.dmMode = opt.value;
          this.refreshDmModeBtn();
          this.closeDmDropup();
        });
      }
      menu.appendChild(item);
    }

    document.body.appendChild(menu);
    this.dmDropup = menu;

    const onOutside = (e: PointerEvent) => {
      if (!menu.contains(e.target as Node) && e.target !== this.dmModeBtn) this.closeDmDropup();
    };
    setTimeout(() => document.addEventListener('pointerdown', onOutside), 0);
    this.dmDropupCleanup = () => document.removeEventListener('pointerdown', onOutside);
  }

  private closeDmDropup(): void {
    this.dmDropupCleanup?.();
    this.dmDropupCleanup = null;
    this.dmDropup?.remove();
    this.dmDropup = null;
  }

  private refreshTurnOrder(state: HUDState): void {
    const inCombat = state.mode !== 'exploring' && state.turnOrderChips.length > 0;
    this.turnOrderEl.style.display = inCombat ? 'flex' : 'none';
    if (!inCombat) return;

    const chips = state.turnOrderChips;

    const totalW = chips.length * CHIP_W + (chips.length - 1) * CHIP_GAP;
    this.turnOrderWidth = totalW;
    this.turnOrderEl.style.width = `${totalW}px`;
    this.place();

    this.turnOrderEl.innerHTML = chips.map((chip, i) => {
      const x = i * (CHIP_W + CHIP_GAP);
      const colorHex = '#' + chip.color.toString(16).padStart(6, '0');
      const fillBg   = chip.isActive ? '#1a3a20' : '#0f0f1e';
      const stroke   = chip.isActive ? '#55aa66' : '#334455';
      const textCol  = chip.isActive ? '#ffffff'  : '#778899';
      const opacity  = chip.isDead ? '0.3' : '1';
      const display  = chip.label ? `${chip.label} · ${chip.name}` : chip.name;
      return `
        <div style="position:absolute;left:${x}px;top:${(BAR_H - CHIP_H) / 2}px;
          width:${CHIP_W}px;height:${CHIP_H}px;background:${fillBg};
          border:1px solid ${stroke};opacity:${opacity};display:flex;align-items:center;gap:0;">
          <div style="width:8px;height:8px;background:${colorHex};margin:0 6px;flex-shrink:0;"></div>
          <span style="font-size:10px;color:${textCol};white-space:nowrap;overflow:hidden;
            text-overflow:ellipsis;font-family:monospace;">${escHtml(display)}</span>
        </div>`;
    }).join('');
  }

  private refreshLog(combatLog: LogEntry[]): void {
    const atBottom = this.logEl.scrollHeight - this.logEl.clientHeight <= this.logEl.scrollTop + 20;

    this.logEl.innerHTML = combatLog.map(entry => {
      const lc    = styleColor(entry.style);
      const rc    = styleColorDim(entry.style);
      const lhtml = String(marked.parseInline(entry.left));
      const rhtml = entry.right ? escHtml(entry.right) : '';
      return `<div style="display:flex;justify-content:space-between;min-height:${ROW_H}px;padding:1px 0;">
        <span style="color:${lc};flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${lhtml}</span>
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
}
