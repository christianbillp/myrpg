import {
  PLAYER_PANEL_WIDTH, GRID_COLS, GRID_ROWS, TILE_SIZE, TARGET_PANEL_WIDTH,
} from '../constants';
import { MonsterDef } from '../data/monsters';
import { NpcState } from '../net/types';
import { UIScale } from './UIScale';
import { DevMode } from '../devMode';

const GRID_H = GRID_ROWS * TILE_SIZE;
const GRID_X = PLAYER_PANEL_WIDTH + GRID_COLS * TILE_SIZE;
const PANEL_MIN_WIDTH = 120;
const PANEL_MAX_WIDTH = 480;
const PANEL_WIDTH_KEY = 'myrpg_target_panel_width';

function hpColor(pct: number): string {
  return pct > 0.5 ? '#27ae60' : pct > 0.25 ? '#f39c12' : '#e74c3c';
}

function statMod(v: number): string {
  const m = Math.floor((v - 10) / 2);
  return (m >= 0 ? '+' : '') + m;
}

export class TargetPanel {
  private readonly el: HTMLDivElement;
  private readonly nameEl: HTMLElement;
  private readonly typeEl: HTMLElement;
  private readonly hpFill: HTMLElement;
  private readonly hpText: HTMLElement;
  private readonly statsEl: HTMLElement;
  private readonly abilitiesEl: HTMLElement;
  private readonly conditionsEl: HTMLElement;
  private readonly offResize: () => void;
  private readonly scale: UIScale;
  private currentDef: MonsterDef | null = null;
  private currentNpcState: NpcState | null = null;

  constructor(scale: UIScale) {
    this.scale = scale;
    const savedWidth = parseInt(localStorage.getItem(PANEL_WIDTH_KEY) ?? '', 10);
    const initWidth = savedWidth >= PANEL_MIN_WIDTH ? savedWidth : TARGET_PANEL_WIDTH;

    this.el = document.createElement('div');
    this.el.className = 'gui-panel';
    this.el.style.cssText += `
      width: ${initWidth}px;
      height: ${GRID_H}px;
      background: #080810;
      border-left: 2px solid #334455;
      color: #aabbcc;
      z-index: 10;
      display: none;
    `;

    this.el.innerHTML = `
      <div style="padding:14px 12px 0;font-size:12px;" data-name></div>
      <div style="padding:2px 12px 4px;font-size:10px;color:#667788;" data-type></div>
      <div class="gui-sep"></div>

      <div class="gui-label">HP</div>
      <div class="gui-hp-track"><div class="gui-hp-fill" data-hp-fill></div></div>
      <div style="padding:2px 12px;font-size:10px;color:#cccccc;" data-hp-text></div>
      <div class="gui-sep"></div>

      <div style="padding:4px 12px;font-size:10px;color:#aabbcc;line-height:1.8;white-space:pre;" data-stats></div>
      <div class="gui-sep"></div>

      <div style="padding:4px 12px;font-size:10px;color:#99aabb;line-height:1.8;white-space:pre;" data-abilities></div>
      <div class="gui-sep" style="margin-top:2px;"></div>

      <div style="padding:4px 12px;font-size:10px;color:#cc8844;line-height:1.8;word-wrap:break-word;" data-conditions></div>
    `;

    const ref = (attr: string) => this.el.querySelector(`[data-${attr}]`) as HTMLElement;
    this.nameEl       = ref('name');
    this.typeEl       = ref('type');
    this.hpFill       = ref('hp-fill');
    this.hpText       = ref('hp-text');
    this.statsEl      = ref('stats');
    this.abilitiesEl  = ref('abilities');
    this.conditionsEl = ref('conditions');

    // Right edge is fixed at the canvas boundary; left edge moves with width.
    const rightAnchor = GRID_X + TARGET_PANEL_WIDTH;
    const place = () => {
      const currentW = parseInt(this.el.style.width) || TARGET_PANEL_WIDTH;
      scale.placePanel(this.el, rightAnchor - currentW, 0);
    };

    this.el.appendChild(this.buildResizeHandle(place));

    if (DevMode.enabled) {
      const btn = document.createElement('button');
      btn.className = 'gui-btn-ghost';
      btn.textContent = '[DEV] LOG';
      btn.style.cssText = 'position:absolute;bottom:10px;right:10px;font-size:9px;padding:2px 6px;';
      btn.addEventListener('click', () => console.log('[TargetPanel]', { def: this.currentDef, npcState: this.currentNpcState }));
      this.el.appendChild(btn);
    }

    document.body.appendChild(this.el);
    place();
    this.offResize = scale.onChange(place);
  }

  show(def: MonsterDef, npcState: NpcState, conditions: string[] = []): void {
    this.currentDef = def;
    this.currentNpcState = npcState;
    const colorHex = '#' + def.color.toString(16).padStart(6, '0');
    this.nameEl.textContent = def.name;
    this.nameEl.style.color = colorHex;
    this.typeEl.textContent = `${def.type}  CR ${def.cr}`;
    this.statsEl.textContent = `AC     ${def.ac}\nSpeed  ${def.speed} ft`;

    const abilities: [string, number][] = [
      ['STR', def.str], ['DEX', def.dex], ['CON', def.con],
      ['INT', def.int], ['WIS', def.wis], ['CHA', def.cha],
    ];
    this.abilitiesEl.textContent = abilities
      .map(([n, v]) => `${n}  ${String(v).padStart(2)}  (${statMod(v)})`)
      .join('\n');

    this.refresh(npcState, def.maxHp);
    this.el.style.display = 'block';
  }

  hide(): void {
    this.el.style.display = 'none';
  }

  refresh(npcState: NpcState, maxHp: number): void {
    this.currentNpcState = npcState;
    const pct = maxHp > 0 ? npcState.hp / maxHp : 0;
    this.hpFill.style.width = `${Math.floor(pct * 100)}%`;
    this.hpFill.style.background = hpColor(pct);
    this.hpText.textContent = `${npcState.hp} / ${maxHp}`;
    this.conditionsEl.textContent = npcState.conditions.length > 0
      ? npcState.conditions.map(c => `[${c.toUpperCase()}]`).join('  ')
      : '';
  }

  private buildResizeHandle(reposition: () => void): HTMLDivElement {
    const handle = document.createElement('div');
    handle.style.cssText = `
      position:absolute;top:0;left:0;width:8px;height:100%;
      cursor:col-resize;z-index:20;
    `;

    let dragging = false;
    let dragStartX = 0;
    let dragStartW = 0;

    handle.addEventListener('pointerdown', (e) => {
      dragging = true;
      dragStartX = e.clientX;
      dragStartW = parseInt(this.el.style.width) || TARGET_PANEL_WIDTH;
      handle.setPointerCapture(e.pointerId);
      e.stopPropagation();
    });

    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      // Dragging left (toward center) increases width; right decreases it.
      const newW = Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH,
        dragStartW + (dragStartX - e.clientX) / this.scale.factor,
      ));
      this.el.style.width = `${newW}px`;
      reposition();
    });

    handle.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      localStorage.setItem(PANEL_WIDTH_KEY, String(parseInt(this.el.style.width)));
    });

    return handle;
  }

  destroy(): void {
    this.offResize();
    this.el.remove();
  }
}
