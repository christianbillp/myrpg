import { PLAYER_PANEL_WIDTH, GRID_ROWS, TILE_SIZE } from '../constants';
import { PlayerDef } from '../data/player';
import { CombatMode } from '../net/types';
import { UIScale } from './UIScale';

const GRID_H = GRID_ROWS * TILE_SIZE;
const MAX_PICKER_SLOTS = 6;

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
  playerHp: number;
  secondWindUses: number;
  playerHidden: boolean;
  playerDef: PlayerDef;
  enemies: Array<{ tileX: number; tileY: number; dead: boolean }>;
  playerTileX: number;
  playerTileY: number;
  hitDiceRemaining: number;
  throwableItems: Array<{ id: string; name: string }>;
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
  onEndTurn: () => void;
  onDeathSave: () => void;
  onShortRest: () => void;
}

function chebyshev(x1: number, y1: number, x2: number, y2: number): number {
  return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2));
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
  private readonly offResize: () => void;

  private visible = false;
  private pickerOpen = false;
  private lastActionState: PlayerPanelActionState | null = null;
  private currentPickerItems: Array<{ id: string; name: string }> = [];
  private readonly callbacks: PlayerPanelCallbacks;
  private readonly playerDef: PlayerDef;

  constructor(scale: UIScale, def: PlayerDef, callbacks: PlayerPanelCallbacks) {
    this.playerDef = def;
    this.callbacks = callbacks;

    const colorHex = '#' + def.color.toString(16).padStart(6, '0');
    const abilities = (['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'] as const)
      .map((n, i) => {
        const val = [def.str, def.dex, def.con, def.int, def.wis, def.cha][i];
        return `${n}  ${String(val).padStart(2)}  (${statMod(val)})`;
      })
      .join('\n');

    this.el = document.createElement('div');
    this.el.className = 'gui-panel';
    this.el.style.cssText += `
      width: ${PLAYER_PANEL_WIDTH}px;
      height: ${GRID_H}px;
      background: #080810;
      border-right: 2px solid #334455;
      color: #aabbcc;
      z-index: 10;
      display: none;
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

      <div class="gui-sep" style="position:absolute;left:8px;right:0;bottom:89px;"></div>
      <div style="position:absolute;left:0;right:0;bottom:89px;display:flex;flex-direction:column-reverse;gap:4px;padding-bottom:4px;" data-actions></div>

      <div class="gui-sep" style="position:absolute;bottom:89px;left:8px;right:0;"></div>
      <div style="position:absolute;bottom:0;left:0;right:0;height:89px;display:flex;flex-direction:column-reverse;gap:4px;padding:0 0 8px;">
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
    this.searchBtn = ref('search') as HTMLButtonElement;

    (ref('inventory') as HTMLButtonElement).onclick = () => callbacks.onOpenInventory();
    this.searchBtn.onclick = () => callbacks.onSearch();

    this.updateCombatStats();

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
    if (!this.visible) return;

    if (this.pickerOpen) {
      this.renderPicker();
      return;
    }

    const { mode, actionUsed, bonusActionUsed, playerDef, playerHp, secondWindUses } = state;
    const btn = (label: string, bg: string, onClick: () => void) => this.makeBtn(label, bg, onClick);

    if (mode === 'exploring') {
      if (playerHp < playerDef.maxHp && state.hitDiceRemaining > 0) {
        this.actionArea.prepend(btn('SHORT REST', '#1a2a3a', this.callbacks.onShortRest));
      }

    } else if (mode === 'player_turn') {
      this.actionArea.prepend(btn('END TURN', '#3a3020', this.callbacks.onEndTurn));

      if (!actionUsed) {
        const hasAdjacent = state.enemies.some(
          e => !e.dead && chebyshev(state.playerTileX, state.playerTileY, e.tileX, e.tileY) <= 1,
        );
        const hasAnyLiving = state.enemies.some(e => !e.dead);
        if (hasAdjacent) this.actionArea.prepend(btn('ATTACK', '#1a4a1e', this.callbacks.onAttack));
        if (!hasAdjacent && state.throwableItems.length > 0)
          this.actionArea.prepend(btn('THROW…', '#2a3a1e', () => { this.pickerOpen = true; this.refreshActions(state); }));
        this.actionArea.prepend(btn('DISENGAGE', '#1a3a4a', this.callbacks.onDisengage));
        if (!hasAdjacent && !hasAnyLiving) (this.actionArea.firstChild as HTMLElement)?.remove();
        this.actionArea.prepend(btn('DODGE', '#1a3a4a', this.callbacks.onDodge));
        this.actionArea.prepend(btn('DASH', '#1a3a4a', this.callbacks.onDash));
      }

      if (!bonusActionUsed) {
        if (playerDef.secondWindMaxUses > 0 && secondWindUses > 0 && playerHp < playerDef.maxHp)
          this.actionArea.prepend(btn('SECOND WIND', '#1a3a5a', this.callbacks.onSecondWind));
        if (playerDef.sneakAttackDice > 0 && !state.playerHidden && state.enemies.some(e => !e.dead))
          this.actionArea.prepend(btn('HIDE', '#1a3a1a', this.callbacks.onHide));
      }

    } else if (mode === 'death_saves') {
      this.actionArea.prepend(btn('ROLL DEATH SAVE', '#5a1a1a', this.callbacks.onDeathSave));
    }
  }

  private renderPicker(): void {
    const items = this.lastActionState!.throwableItems.slice(0, MAX_PICKER_SLOTS);
    this.currentPickerItems = items;
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
