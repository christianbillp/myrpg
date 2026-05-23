import { marked } from 'marked';
import {
  TILE_SIZE, GRID_COLS, GRID_ROWS, HUD_HEIGHT,
  PLAYER_PANEL_WIDTH, TARGET_PANEL_WIDTH,
} from '../constants';
import { CombatMode, LogEntry, LogEntryStyle } from '../net/types';
import { NpcToken } from '../entities/NpcToken';
import { PlayerDef } from '../data/player';
import { UIScale } from './UIScale';

const GRID_H  = GRID_ROWS * TILE_SIZE;
const GRID_W  = GRID_COLS * TILE_SIZE;
const TOTAL_W = PLAYER_PANEL_WIDTH + GRID_W + TARGET_PANEL_WIDTH;

const LOG_ROWS = 5;
const ROW_H    = 14;
const CHIP_W   = 140;
const CHIP_H   = 22;
const CHIP_GAP = 8;
const BAR_H    = 30;

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

export interface HUDState {
  mode: CombatMode;
  playerDef: PlayerDef;
  playerHp: number;
  movesLeft: number;
  actionUsed: boolean;
  bonusActionUsed: boolean;
  playerHidden: boolean;
  playerConditions: string[];
  activeNpc: NpcToken | null;
  combatNpcs: NpcToken[];
  enemyVexed: boolean;
  enemyHidden: boolean;
  deathSaveSuccesses: number;
  deathSaveFailures: number;
  combatLog: LogEntry[];
  logScrollOffset: number;
  selectedNpc: NpcToken | null;
  searchAvailable: boolean;
}

export interface HUDCallbacks {
  onOpenDM: () => void;
  onNewEncounter: () => void;
  onScrollLog: (dy: number) => void;
}

export class HUD {
  private readonly hudEl: HTMLDivElement;
  private readonly turnOrderEl: HTMLDivElement;
  private readonly phaseEl: HTMLElement;
  private readonly enemyInfoEl: HTMLElement;
  private readonly logEl: HTMLElement;
  private readonly scrollHintEl: HTMLElement;
  private readonly offResize: () => void;

  constructor(scale: UIScale, callbacks: HUDCallbacks) {
    // ── Main HUD bar ──────────────────────────────────────────────────────────
    this.hudEl = document.createElement('div');
    this.hudEl.className = 'gui-panel';
    this.hudEl.style.cssText += `
      width: ${TOTAL_W}px;
      height: ${HUD_HEIGHT}px;
      background: #0d0d1e;
      border-top: 2px solid #445566;
      color: #aabbcc;
      z-index: 10;
    `;

    this.hudEl.innerHTML = `
      <button data-new-enc style="position:absolute;top:10px;right:148px;
        height:26px;padding:0 10px;background:#2a1a1a;border:1px solid #556677;
        color:#aabbcc;font-family:monospace;font-size:11px;cursor:pointer;">NEW ENCOUNTER</button>

      <button data-open-dm style="position:absolute;top:10px;right:12px;
        height:26px;padding:0 10px;background:#1a1020;border:1px solid #556677;
        color:#aabbcc;font-family:monospace;font-size:11px;cursor:pointer;">DUNGEON MASTER</button>

      <div data-phase style="position:absolute;top:10px;left:${PLAYER_PANEL_WIDTH + GRID_W / 2}px;
        transform:translateX(-50%);font-size:13px;color:#e2b96f;white-space:nowrap;"></div>

      <div data-enemy-info style="position:absolute;top:44px;right:12px;
        font-size:12px;color:#e74c3c;text-align:right;"></div>

      <div data-log style="position:absolute;top:40px;left:${PLAYER_PANEL_WIDTH + 12}px;
        width:${GRID_W - 24}px;height:${LOG_ROWS * ROW_H}px;overflow:hidden;cursor:default;"></div>

      <div data-scroll-hint style="position:absolute;top:${40 + LOG_ROWS * ROW_H}px;left:${PLAYER_PANEL_WIDTH + 12}px;
        font-size:10px;color:#445566;"></div>
    `;

    const ref = (a: string) => this.hudEl.querySelector(`[data-${a}]`) as HTMLElement;
    this.phaseEl      = ref('phase');
    this.enemyInfoEl  = ref('enemy-info');
    this.logEl        = ref('log');
    this.scrollHintEl = ref('scroll-hint');

    (ref('new-enc') as HTMLButtonElement).onclick = callbacks.onNewEncounter;
    (ref('open-dm') as HTMLButtonElement).onclick = callbacks.onOpenDM;

    this.logEl.addEventListener('wheel', (e) => {
      callbacks.onScrollLog(e.deltaY);
      e.preventDefault();
    }, { passive: false });

    document.body.appendChild(this.hudEl);

    // ── Turn order bar (overlays top of grid area) ────────────────────────────
    this.turnOrderEl = document.createElement('div');
    this.turnOrderEl.className = 'gui-panel';
    this.turnOrderEl.style.cssText += `
      width: ${GRID_W}px;
      height: ${BAR_H}px;
      background: rgba(7,7,15,0.92);
      border-bottom: 1px solid #334455;
      display: none;
      align-items: center;
      overflow: visible;
      z-index: 15;
    `;

    document.body.appendChild(this.turnOrderEl);

    const place = () => {
      scale.placePanel(this.hudEl,      0, GRID_H);
      scale.placePanel(this.turnOrderEl, PLAYER_PANEL_WIDTH, 0);
    };
    place();
    this.offResize = scale.onChange(place);
  }

  refresh(state: HUDState): void {
    this.refreshEnemyInfo(state);
    this.refreshTurnOrder(state);
    this.refreshPhase(state);
    this.refreshLog(state.combatLog, state.logScrollOffset);
  }

  private refreshEnemyInfo(state: HUDState): void {
    const npc = (state.selectedNpc && !state.selectedNpc.isDead()) ? state.selectedNpc : state.activeNpc;
    if (npc) {
      const isActive = npc === state.activeNpc;
      const vexed  = isActive && state.enemyVexed  ? '  [VEXED]'  : '';
      const hidden = isActive && state.enemyHidden  ? '  [HIDDEN]' : '';
      this.enemyInfoEl.textContent = `${npc.def.name}  ${npc.hp}/${npc.maxHp} HP${hidden}${vexed}`;
    } else {
      this.enemyInfoEl.textContent = '';
    }
  }

  private refreshTurnOrder(state: HUDState): void {
    const inCombat = state.mode !== 'exploring' && state.combatNpcs.length > 0;
    this.turnOrderEl.style.display = inCombat ? 'flex' : 'none';
    if (!inCombat) return;

    const chips = [
      { label: '',   name: state.playerDef.name,  color: state.playerDef.color,
        isActive: state.mode === 'player_turn' || state.mode === 'death_saves',
        isDead: state.playerHp <= 0 },
      ...state.combatNpcs.map(n => ({
        label: n.label, name: n.def.name, color: n.def.color,
        isActive: state.activeNpc === n, isDead: n.isDead(),
      })),
    ];

    const totalW = chips.length * CHIP_W + (chips.length - 1) * CHIP_GAP;
    const startX = (GRID_W - totalW) / 2;

    this.turnOrderEl.innerHTML = chips.map((chip, i) => {
      const x = startX + i * (CHIP_W + CHIP_GAP);
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

  private refreshPhase(state: HUDState): void {
    const { mode, playerDef, movesLeft, actionUsed, bonusActionUsed, playerHidden,
            playerConditions, deathSaveSuccesses, deathSaveFailures, searchAvailable } = state;
    let text = '', color = '#e2b96f';

    switch (mode) {
      case 'exploring': {
        const hint = searchAvailable ? '  ·  search available' : '';
        text = `Exploring — WASD / arrow keys to move${hint}`;
        break;
      }
      case 'player_turn': {
        const hidden = playerHidden ? '  [HIDDEN]' : '';
        const conds  = playerConditions.filter(c => c !== 'dashing').map(c => `  [${c.toUpperCase()}]`).join('');
        const acted  = actionUsed     ? '  · action used' : '';
        const bonus  = bonusActionUsed ? '  · bonus used'  : '';
        text = `Your turn — ${movesLeft}/${playerDef.speed} moves${hidden}${conds}${acted}${bonus}`;
        break;
      }
      case 'enemy_turn': {
        const an = state.activeNpc;
        text = `${an?.label ? an.label + ' · ' : ''}${an?.def.name ?? 'Enemy'}'s turn...`;
        break;
      }
      case 'death_saves':
        color = '#ff7777';
        text = `${playerDef.name} is unconscious!  ✓ ${deathSaveSuccesses}/3  ✗ ${deathSaveFailures}/3`;
        break;
      case 'defeat':
        color = '#ff4444';
        text = deathSaveSuccesses >= 3 ? '💀 Stabilized — combat over.' : '☠ You have died.';
        break;
    }

    this.phaseEl.textContent = text;
    this.phaseEl.style.color = color;
  }

  private refreshLog(combatLog: LogEntry[], logScrollOffset: number): void {
    const total  = combatLog.length;
    const offset = Math.min(logScrollOffset, Math.max(0, total - LOG_ROWS));
    const end    = total - offset;
    const start  = Math.max(0, end - LOG_ROWS);
    const visible = combatLog.slice(start, end);

    let html = '';
    for (let i = 0; i < LOG_ROWS; i++) {
      const entry = visible[i];
      if (!entry) {
        html += `<div style="height:${ROW_H}px"></div>`;
        continue;
      }
      const lc = styleColor(entry.style);
      const rc = styleColorDim(entry.style);
      const lhtml = String(marked.parseInline(entry.left));
      const rhtml = entry.right ? escHtml(entry.right) : '';
      html += `<div style="display:flex;justify-content:space-between;height:${ROW_H}px;
        overflow:hidden;white-space:nowrap;">
        <span style="color:${lc};flex:1;overflow:hidden;text-overflow:ellipsis;">${lhtml}</span>
        <span style="color:${rc};padding-left:8px;flex-shrink:0;">${rhtml}</span>
      </div>`;
    }
    this.logEl.innerHTML = html;

    if (offset > 0) {
      this.scrollHintEl.textContent = `▼ ${offset} newer`;
    } else if (total > LOG_ROWS) {
      this.scrollHintEl.textContent = '↑ scroll for history';
    } else {
      this.scrollHintEl.textContent = '';
    }
  }

  destroy(): void {
    this.offResize();
    this.hudEl.remove();
    this.turnOrderEl.remove();
  }
}
