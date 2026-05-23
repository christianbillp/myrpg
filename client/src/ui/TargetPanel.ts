import {
  PLAYER_PANEL_WIDTH, GRID_COLS, GRID_ROWS, TILE_SIZE, TARGET_PANEL_WIDTH,
} from '../constants';
import { MonsterDef } from '../data/monsters';
import { UIScale } from './UIScale';

const GRID_H = GRID_ROWS * TILE_SIZE;
const GRID_X = PLAYER_PANEL_WIDTH + GRID_COLS * TILE_SIZE;

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

  constructor(scale: UIScale) {
    this.el = document.createElement('div');
    this.el.className = 'gui-panel';
    this.el.style.cssText += `
      width: ${TARGET_PANEL_WIDTH}px;
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

    document.body.appendChild(this.el);

    const place = () => scale.placePanel(this.el, GRID_X, 0);
    place();
    this.offResize = scale.onChange(place);
  }

  show(def: MonsterDef, hp: number, conditions: string[] = []): void {
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

    this.refresh(hp, def.maxHp, conditions);
    this.el.style.display = 'block';
  }

  hide(): void {
    this.el.style.display = 'none';
  }

  refresh(hp: number, maxHp: number, conditions: string[] = []): void {
    const pct = maxHp > 0 ? hp / maxHp : 0;
    this.hpFill.style.width = `${Math.floor(pct * 100)}%`;
    this.hpFill.style.background = hpColor(pct);
    this.hpText.textContent = `${hp} / ${maxHp}`;
    this.conditionsEl.textContent = conditions.length > 0
      ? conditions.map(c => `[${c.toUpperCase()}]`).join('  ')
      : '';
  }

  destroy(): void {
    this.offResize();
    this.el.remove();
  }
}
