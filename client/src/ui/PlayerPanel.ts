import { PLAYER_PANEL_WIDTH, GRID_ROWS, TILE_SIZE, HUD_HEIGHT } from '../constants';
import { PlayerDef } from '../data/player';
import { AvailableActions, CombatMode } from '../net/types';
import { UIScale } from './UIScale';

const GRID_H   = GRID_ROWS * TILE_SIZE;
const PANEL_H  = GRID_H + HUD_HEIGHT;
const MAX_PICKER_SLOTS = 6;
const PANEL_MIN_WIDTH = 120;
const PANEL_MAX_WIDTH = 480;
const PANEL_WIDTH_KEY = 'myrpg_player_panel_width';

export interface QuestDisplay {
  title: string;
  progress: number;
  target: number;
  completed: boolean;
}

export interface PlayerPanelActionState {
  mode: CombatMode;
  actionUsed: boolean;
  bonusActionUsed: boolean;
  movesLeft: number;
  moveMode: boolean;
  throwableItems: Array<{ id: string; name: string }>;
  availableActions: AvailableActions;
}

export interface PlayerPanelCallbacks {
  onOpenInventory: () => void;
  onSearch: () => void;
  onAttack: () => void;
  onThrow: (itemId: string) => void;
  onDash: () => void;
  onDodge: () => void;
  onDisengage: () => void;
  onSecondWind: () => void;
  onHide: () => void;
  onDeathSave: () => void;
  onShortRest: () => void;
  onToggleMoveMode: () => void;
  onEndTurn: () => void;
  onLeaveEncounter: () => void;
}

function hpColor(pct: number): string {
  return pct > 0.5 ? '#27ae60' : pct > 0.25 ? '#f39c12' : '#e74c3c';
}

function statMod(v: number): string {
  const m = Math.floor((v - 10) / 2);
  return (m >= 0 ? '+' : '') + m;
}

export class PlayerPanel {
  private readonly el: HTMLDivElement;
  private readonly hpFill: HTMLElement;
  private readonly hpText: HTMLElement;
  private readonly statsEl: HTMLElement;
  private readonly xpEl: HTMLElement;
  private readonly questsEl: HTMLElement;
  private readonly actionArea: HTMLElement;
  private readonly searchBtn: HTMLButtonElement;
  private readonly endTurnBtn: HTMLButtonElement;
  private readonly offResize: () => void;

  private visible = true;
  private pickerOpen = false;
  private lastActionState: PlayerPanelActionState | null = null;
  private readonly callbacks: PlayerPanelCallbacks;
  private readonly playerDef: PlayerDef;
  private readonly scale: UIScale;

  constructor(scale: UIScale, def: PlayerDef, callbacks: PlayerPanelCallbacks) {
    this.scale = scale;
    this.playerDef = def;
    this.callbacks = callbacks;

    const colorHex = '#' + def.color.toString(16).padStart(6, '0');
    const abilities = (['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'] as const)
      .map((n, i) => {
        const val = [def.str, def.dex, def.con, def.int, def.wis, def.cha][i];
        return `${n}  ${String(val).padStart(2)}  (${statMod(val)})`;
      })
      .join('\n');

    const savedWidth = parseInt(localStorage.getItem(PANEL_WIDTH_KEY) ?? '', 10);
    const initWidth = savedWidth >= PANEL_MIN_WIDTH ? savedWidth : PLAYER_PANEL_WIDTH;

    this.el = document.createElement('div');
    this.el.className = 'gui-panel';
    this.el.style.cssText += `
      width: ${initWidth}px;
      height: ${PANEL_H}px;
      background: #080810;
      border-right: 2px solid #334455;
      color: #aabbcc;
      z-index: 10;
    `;

    this.el.innerHTML = `
      <div style="padding:14px 12px 0;font-size:12px;color:${colorHex};">${def.name}</div>
      <div style="padding:2px 12px 4px;font-size:10px;color:#667788;">${def.speciesName} · ${def.className} ${def.level}</div>
      <div class="gui-sep"></div>

      <div class="gui-label">HP</div>
      <div class="gui-hp-track"><div class="gui-hp-fill" data-hp-fill></div></div>
      <div style="padding:2px 12px;font-size:10px;color:#cccccc;" data-hp-text></div>
      <div class="gui-sep"></div>

      <div style="padding:4px 12px;font-size:10px;color:#aabbcc;line-height:1.8;white-space:pre;" data-stats></div>
      <div class="gui-sep"></div>

      <div style="padding:4px 12px;font-size:10px;color:#99aabb;line-height:1.8;white-space:pre;">${abilities}</div>
      <div class="gui-sep"></div>

      <div style="padding:4px 12px;font-size:10px;color:#aabbcc;" data-xp></div>
      <div class="gui-sep" style="margin-top:2px;"></div>
      <div class="gui-label">QUESTS</div>
      <div style="padding:2px 12px;font-size:10px;color:#aabbcc;line-height:1.8;white-space:pre-wrap;" data-quests></div>

      <div class="gui-sep" style="position:absolute;left:8px;right:0;bottom:108px;"></div>
      <div style="position:absolute;left:0;right:0;bottom:108px;display:flex;flex-direction:column-reverse;gap:4px;padding-bottom:4px;" data-actions></div>

      <div style="position:absolute;bottom:0;left:0;right:0;height:108px;display:flex;flex-direction:column-reverse;gap:4px;padding:0 8px 8px;">
        <button class="gui-btn" style="background:#3a1a1a;" data-leave-enc>LEAVE ENCOUNTER</button>
        <button class="gui-btn" style="background:#3a3020;display:none;" data-end-turn>END TURN</button>
        <button class="gui-btn" style="background:#1a2a3a;display:none;" data-search>SEARCH</button>
        <button class="gui-btn" style="background:#0a1a2a;" data-inventory>INVENTORY</button>
      </div>
    `;

    const ref = (attr: string) => this.el.querySelector(`[data-${attr}]`) as HTMLElement;
    this.hpFill    = ref('hp-fill');
    this.hpText    = ref('hp-text');
    this.statsEl   = ref('stats');
    this.xpEl      = ref('xp');
    this.questsEl  = ref('quests');
    this.actionArea = ref('actions');
    this.searchBtn  = ref('search')   as HTMLButtonElement;
    this.endTurnBtn = ref('end-turn') as HTMLButtonElement;

    (ref('inventory') as HTMLButtonElement).onclick = () => callbacks.onOpenInventory();
    (ref('leave-enc') as HTMLButtonElement).onclick = () => callbacks.onLeaveEncounter();
    this.endTurnBtn.onclick = () => callbacks.onEndTurn();
    this.searchBtn.onclick  = () => callbacks.onSearch();

    this.updateCombatStats();

    this.el.appendChild(this.buildResizeHandle());

    document.body.appendChild(this.el);
    const place = () => scale.placePanel(this.el, 0, 0);
    place();
    this.offResize = scale.onChange(place);
  }

  private updateCombatStats(): void {
    const def = this.playerDef;
    const initBonus = Math.floor((def.dex - 10) / 2);
    const sign = initBonus >= 0 ? '+' : '';
    this.statsEl.textContent = [
      `AC     ${def.ac}`,
      `Speed  ${def.speed} ft`,
      `Prof   +${def.proficiencyBonus}`,
      `Init   ${sign}${initBonus}`,
    ].join('\n');
  }

  show(): void {
    this.visible = true;
    this.el.style.display = 'block';
    if (this.lastActionState) this.refreshActions(this.lastActionState);
  }

  hide(): void {
    this.visible = false;
    this.el.style.display = 'none';
    this.pickerOpen = false;
  }

  toggle(): void {
    this.visible ? this.hide() : this.show();
  }

  private buildResizeHandle(): HTMLDivElement {
    const handle = document.createElement('div');
    handle.style.cssText = `
      position:absolute;top:0;right:0;width:8px;height:100%;
      cursor:col-resize;z-index:20;
    `;

    let dragging = false;
    let dragStartX = 0;
    let dragStartW = 0;

    handle.addEventListener('pointerdown', (e) => {
      dragging = true;
      dragStartX = e.clientX;
      dragStartW = parseInt(this.el.style.width) || PLAYER_PANEL_WIDTH;
      handle.setPointerCapture(e.pointerId);
      e.stopPropagation();
    });

    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const newW = Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH,
        dragStartW + (e.clientX - dragStartX) / this.scale.factor,
      ));
      this.el.style.width = `${newW}px`;
    });

    handle.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      localStorage.setItem(PANEL_WIDTH_KEY, String(parseInt(this.el.style.width)));
    });

    return handle;
  }

  refresh(hp: number, maxHp: number, xp: number, quests: QuestDisplay[] = [], showSearch = false): void {
    const pct = maxHp > 0 ? hp / maxHp : 0;
    this.hpFill.style.width = `${Math.floor(pct * 100)}%`;
    this.hpFill.style.background = hpColor(pct);
    this.hpText.textContent = `${hp} / ${maxHp}`;
    this.xpEl.textContent = `XP  ${xp}`;
    this.updateCombatStats();

    this.questsEl.textContent = quests.length === 0
      ? 'None'
      : quests.map(q => q.completed ? `✓ ${q.title}` : `· ${q.title}  ${q.progress}/${q.target}`).join('\n');

    this.searchBtn.style.display = showSearch ? 'block' : 'none';
  }

  setSearchEnabled(enabled: boolean): void {
    this.searchBtn.style.display = enabled ? 'block' : 'none';
  }

  refreshActions(state: PlayerPanelActionState): void {
    this.lastActionState = state;
    this.actionArea.innerHTML = '';
    this.endTurnBtn.style.display = state.mode === 'player_turn' ? 'block' : 'none';
    if (!this.visible) return;

    if (this.pickerOpen) {
      this.renderPicker();
      return;
    }

    const { mode, actionUsed, bonusActionUsed, movesLeft, moveMode, availableActions: aa } = state;
    const btn = (label: string, bg: string, onClick: () => void) => this.makeBtn(label, bg, onClick);

    if (mode === 'exploring') {
      const atkEl = this.makeBtn('ATTACK', '#1a4a1e', aa.canAttack ? this.callbacks.onAttack : () => {});
      atkEl.disabled = !aa.canAttack;
      this.actionArea.prepend(atkEl);

      const throwExEl = this.makeBtn('THROW', '#1a4a1e', state.throwableItems.length > 0 ? () => { this.pickerOpen = true; this.refreshActions(state); } : () => {});
      throwExEl.disabled = state.throwableItems.length === 0;
      this.actionArea.prepend(throwExEl);

      if (aa.canShortRest)
        this.actionArea.prepend(btn('SHORT REST', '#1a2a3a', this.callbacks.onShortRest));

    } else if (mode === 'player_turn') {
      const GREEN = '#1a4a1e';

      const atkEl = this.makeBtn('ATTACK', GREEN, aa.canAttack ? this.callbacks.onAttack : () => {});
      atkEl.disabled = actionUsed;
      this.actionArea.prepend(atkEl);

      const throwEl = this.makeBtn('THROW', GREEN, !actionUsed && state.throwableItems.length > 0 ? () => { this.pickerOpen = true; this.refreshActions(state); } : () => {});
      throwEl.disabled = actionUsed || state.throwableItems.length === 0;
      this.actionArea.prepend(throwEl);

      const disEl = this.makeBtn('DISENGAGE', GREEN, this.callbacks.onDisengage);
      disEl.disabled = actionUsed;
      this.actionArea.prepend(disEl);

      const dodEl = this.makeBtn('DODGE', GREEN, this.callbacks.onDodge);
      dodEl.disabled = actionUsed;
      this.actionArea.prepend(dodEl);

      const dashEl = this.makeBtn('DASH', GREEN, this.callbacks.onDash);
      dashEl.disabled = actionUsed;
      this.actionArea.prepend(dashEl);

      const swEl = this.makeBtn('SECOND WIND', '#1a3a5a', this.callbacks.onSecondWind);
      swEl.disabled = bonusActionUsed || !aa.canSecondWind;
      this.actionArea.prepend(swEl);

      if (aa.canHide) this.actionArea.prepend(btn('HIDE', '#1a3a1a', this.callbacks.onHide));

      const moveEl = this.makeBtn('MOVE', moveMode ? '#5a4800' : '#3a3000', this.callbacks.onToggleMoveMode);
      moveEl.disabled = movesLeft <= 0;
      this.actionArea.appendChild(moveEl);

    } else if (mode === 'death_saves') {
      this.actionArea.prepend(btn('ROLL DEATH SAVE', '#5a1a1a', this.callbacks.onDeathSave));
    }
  }

  private renderPicker(): void {
    const items = this.lastActionState!.throwableItems.slice(0, MAX_PICKER_SLOTS);
    for (const item of [...items].reverse()) {
      this.actionArea.prepend(this.makeBtn(item.name, '#1e2e1e', () => {
        this.pickerOpen = false;
        this.callbacks.onThrow(item.id);
        if (this.lastActionState) this.refreshActions(this.lastActionState);
      }, '10px'));
    }
    this.actionArea.prepend(this.makeBtn('↩ CANCEL', '#2a1a1a', () => {
      this.pickerOpen = false;
      if (this.lastActionState) this.refreshActions(this.lastActionState);
    }));
  }

  private makeBtn(label: string, bg: string, onClick: () => void, fontSize = '11px'): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'gui-btn';
    b.textContent = label;
    b.style.background = bg;
    b.style.fontSize = fontSize;
    b.style.marginBottom = '0';
    b.onclick = onClick;
    return b;
  }

  destroy(): void {
    this.offResize();
    this.el.remove();
  }
}
