import {
  PLAYER_PANEL_WIDTH, GRID_COLS, GRID_ROWS, TILE_SIZE, TARGET_PANEL_WIDTH, HUD_HEIGHT,
} from '../constants';
import { MonsterDef } from '../data/monsters';
import { NpcState, FactionDef } from '../net/types';
import { UIScale } from './UIScale';
import { DevMode } from '../devMode';

const GRID_H           = GRID_ROWS * TILE_SIZE;
const GRID_X           = PLAYER_PANEL_WIDTH + GRID_COLS * TILE_SIZE;
const TOTAL_H          = GRID_H + HUD_HEIGHT;
const MIN_PANEL_WIDTH  = 120;
const MAX_PANEL_WIDTH  = 480;
const MIN_PANEL_HEIGHT = 100;
const MAX_PANEL_HEIGHT = Math.floor(TOTAL_H / 2);
const DEFAULT_HEIGHT   = 380;
const PANEL_WIDTH_KEY  = 'myrpg_target_panel_width';
const PANEL_HEIGHT_KEY = 'myrpg_target_panel_height';

function hpColor(pct: number): string {
  return pct > 0.5 ? '#27ae60' : pct > 0.25 ? '#f39c12' : '#e74c3c';
}

function statMod(v: number): string {
  const m = Math.floor((v - 10) / 2);
  return (m >= 0 ? '+' : '') + m;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export class TargetPanel {
  private readonly el: HTMLDivElement;
  private readonly nameEl: HTMLElement;
  private readonly aliasEl: HTMLElement;
  private readonly typeEl: HTMLElement;
  private readonly hpFill: HTMLElement;
  private readonly hpText: HTMLElement;
  private readonly statsEl: HTMLElement;
  private readonly abilitiesEl: HTMLElement;
  private readonly conditionsEl: HTMLElement;
  private readonly conditionsLabelEl: HTMLElement;
  private readonly factionEl: HTMLElement;
  private readonly factionSepEl: HTMLElement;
  private readonly offResize: () => void;
  private readonly scale: UIScale;
  private panelHeight: number;
  private currentDef: MonsterDef | null = null;
  private currentNpcState: NpcState | null = null;

  constructor(scale: UIScale) {
    this.scale = scale;

    const savedWidth  = parseInt(localStorage.getItem(PANEL_WIDTH_KEY)  ?? '', 10);
    const savedHeight = parseInt(localStorage.getItem(PANEL_HEIGHT_KEY) ?? '', 10);
    const initWidth   = savedWidth  >= MIN_PANEL_WIDTH  ? savedWidth  : TARGET_PANEL_WIDTH;
    this.panelHeight  = savedHeight >= MIN_PANEL_HEIGHT ? Math.min(savedHeight, MAX_PANEL_HEIGHT) : DEFAULT_HEIGHT;

    this.el = document.createElement('div');
    this.el.className = 'gui-panel';
    this.el.style.cssText += `
      width: ${initWidth}px;
      height: ${this.panelHeight}px;
      background: #080810;
      border-left: 2px solid #334455;
      border-bottom: 2px solid #334455;
      color: #aabbcc;
      z-index: 10;
      display: none;
      overflow: hidden;
    `;

    this.el.innerHTML = `
      <div style="padding:14px 12px 0;font-size:12px;" data-name></div>
      <div style="padding:1px 12px 0;font-size:10px;color:#778899;display:none;" data-alias></div>
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

      <div class="gui-label" data-conditions-label style="display:none;">CONDITIONS</div>
      <div style="padding:4px 12px;font-size:10px;color:#cc8844;line-height:1.6;display:flex;flex-wrap:wrap;gap:4px;" data-conditions></div>
      <div class="gui-sep" style="margin-top:2px;" data-faction-sep></div>
      <div style="padding:4px 12px;font-size:10px;line-height:1.6;" data-faction></div>
    `;

    const ref = (attr: string) => this.el.querySelector(`[data-${attr}]`) as HTMLElement;
    this.nameEl       = ref('name');
    this.aliasEl      = ref('alias');
    this.typeEl       = ref('type');
    this.hpFill       = ref('hp-fill');
    this.hpText       = ref('hp-text');
    this.statsEl      = ref('stats');
    this.abilitiesEl  = ref('abilities');
    this.conditionsEl = ref('conditions');
    this.conditionsLabelEl = ref('conditions-label');
    this.factionEl    = ref('faction');
    this.factionSepEl = ref('faction-sep');

    // Right edge fixed at canvas right; left edge moves with width.
    const rightAnchor = GRID_X + TARGET_PANEL_WIDTH;
    const place = () => {
      const currentW = parseInt(this.el.style.width) || TARGET_PANEL_WIDTH;
      scale.placePanel(this.el, rightAnchor - currentW, 0);
    };

    this.el.appendChild(this.buildWidthHandle(place));
    this.el.appendChild(this.buildHeightHandle());

    if (DevMode.enabled) {
      const btn = document.createElement('button');
      btn.className = 'gui-btn-ghost';
      btn.textContent = '[DEV] LOG';
      btn.style.cssText = 'position:absolute;bottom:18px;left:50%;transform:translateX(-50%);font-size:9px;padding:2px 6px;';
      btn.addEventListener('click', () => console.log('[TargetPanel]', { def: this.currentDef, npcState: this.currentNpcState }));
      this.el.appendChild(btn);
    }

    document.body.appendChild(this.el);
    place();
    this.offResize = scale.onChange(place);
  }

  show(def: MonsterDef, npcState: NpcState, factions: FactionDef[] = [], discoveredFactions: string[] = [], _conditions: string[] = []): void {
    this.currentDef = def;
    this.currentNpcState = npcState;
    const colorHex = '#' + def.color.toString(16).padStart(6, '0');
    this.renderName(def, npcState, colorHex);
    this.typeEl.textContent = `${def.type}  CR ${def.cr}`;
    this.statsEl.textContent = `AC     ${def.ac}\nSpeed  ${def.speed} ft`;

    const abilities: [string, number][] = [
      ['STR', def.str], ['DEX', def.dex], ['CON', def.con],
      ['INT', def.int], ['WIS', def.wis], ['CHA', def.cha],
    ];
    this.abilitiesEl.textContent = abilities
      .map(([n, v]) => `${n}  ${String(v).padStart(2)}  (${statMod(v)})`)
      .join('\n');

    this.refresh(npcState, def.maxHp, factions, discoveredFactions);
    this.el.style.display = 'block';
  }

  /**
   * Render the primary name + optional alias subtitle. When the NPC has
   * spoken their name (via the AIGM `reveal_npc_name` tool), the main name
   * shows the revealed name and the alias row shows the def's generic label
   * in parentheses (e.g. main "Daven" / alias "(Concordat Overseer)"). When
   * no name has been revealed yet, the alias row is hidden.
   */
  private renderName(def: MonsterDef, npcState: NpcState, colorHex: string): void {
    const revealed = npcState.revealedName?.trim();
    if (revealed) {
      this.nameEl.textContent = revealed;
      this.aliasEl.textContent = `(${def.name})`;
      this.aliasEl.style.display = 'block';
    } else {
      this.nameEl.textContent = def.name;
      this.aliasEl.style.display = 'none';
    }
    this.nameEl.style.color = colorHex;
  }

  /**
   * Render the FACTION row based on the selected NPC's factionId.
   *   • Faction-of-one (id not in the global registry — raw monster spawns):
   *     hide the row entirely. Nothing identifiable.
   *   • Faction known to defs.factions, NOT in discoveredFactions: show
   *     `Faction: ???` to signal the group is mysterious until the player
   *     identifies them.
   *   • Faction known + discovered: show the display name in the faction's
   *     own colour.
   */
  private renderFactionRow(factionId: string, factions: FactionDef[], discoveredFactions: string[]): void {
    const def = factions.find((f) => f.id === factionId);
    if (!def) {
      this.factionEl.style.display = 'none';
      this.factionSepEl.style.display = 'none';
      return;
    }
    this.factionEl.style.display = 'block';
    this.factionSepEl.style.display = 'block';
    const known = discoveredFactions.includes(factionId);
    if (known) {
      this.factionEl.innerHTML = `<span style="color:#778899">FACTION</span>  <span style="color:${def.displayColor}">${escapeHtml(def.name)}</span>`;
    } else {
      this.factionEl.innerHTML = `<span style="color:#778899">FACTION</span>  <span style="color:#556677">???</span>`;
    }
  }

  hide(): void {
    this.el.style.display = 'none';
    this.el.style.opacity = '1';
    this.el.style.transition = '';
  }

  /** Fade the panel out over `durationMs`. Used by the focused-announcement
   *  flow so the player sees the UI dissolve before the announcement card
   *  arrives, rather than disappearing in a single frame. */
  fadeOut(durationMs = 250): Promise<void> {
    if (this.el.style.display === 'none') return Promise.resolve();
    this.el.style.transition = `opacity ${durationMs}ms ease-in`;
    this.el.style.opacity = '0';
    return new Promise<void>((resolve) => setTimeout(() => {
      this.el.style.display = 'none';
      resolve();
    }, durationMs));
  }

  /** Mirror of `fadeOut` — opacity 0 → 1 with a starting display:block. */
  fadeIn(durationMs = 250): Promise<void> {
    this.el.style.display = 'block';
    this.el.style.transition = '';
    this.el.style.opacity = '0';
    void this.el.offsetWidth;
    this.el.style.transition = `opacity ${durationMs}ms ease-out`;
    this.el.style.opacity = '1';
    return new Promise<void>((resolve) => setTimeout(resolve, durationMs));
  }

  refresh(npcState: NpcState, maxHp: number, factions: FactionDef[] = [], discoveredFactions: string[] = []): void {
    this.currentNpcState = npcState;
    // Re-render the name on every tick so a mid-encounter `reveal_npc_name`
    // (AIGM tool) flips the panel from the def's generic label to the
    // revealed character name without requiring the player to reselect.
    if (this.currentDef) {
      const colorHex = '#' + this.currentDef.color.toString(16).padStart(6, '0');
      this.renderName(this.currentDef, npcState, colorHex);
    }
    const pct = maxHp > 0 ? npcState.hp / maxHp : 0;
    this.hpFill.style.width = `${Math.floor(pct * 100)}%`;
    this.hpFill.style.background = hpColor(pct);
    this.hpText.textContent = `${npcState.hp} / ${maxHp}`;
    // Render conditions as styled chips when present; hide the whole row
    // (label + chips) when the creature has no conditions so the panel
    // doesn't carry dead vertical space.
    const conds = npcState.conditions;
    this.conditionsEl.innerHTML = '';
    if (conds.length > 0) {
      this.conditionsLabelEl.style.display = '';
      this.conditionsEl.style.display = 'flex';
      for (const c of conds) {
        const chip = document.createElement('span');
        chip.textContent = c.toUpperCase();
        chip.style.cssText = `
          padding: 1px 6px; background: #2a1810; border: 1px solid #5a3220;
          color: #d99966; font-size: 9px; letter-spacing: 1px;
        `;
        this.conditionsEl.appendChild(chip);
      }
    } else {
      this.conditionsLabelEl.style.display = 'none';
      this.conditionsEl.style.display = 'none';
    }
    // Re-render the FACTION row on each tick so a mid-encounter
    // `reveal_faction` (AIGM tool or trigger) immediately flips the chip
    // from `???` to the faction name.
    this.renderFactionRow(npcState.factionId, factions, discoveredFactions);
  }

  private buildWidthHandle(reposition: () => void): HTMLDivElement {
    const handle = document.createElement('div');
    handle.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 8px;
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
      dragStartW = parseInt(this.el.style.width) || TARGET_PANEL_WIDTH;
      handle.setPointerCapture(e.pointerId);
      e.stopPropagation();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const newW = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH,
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

  private buildHeightHandle(): HTMLDivElement {
    const handle = document.createElement('div');
    handle.style.cssText = `
      position: absolute;
      bottom: 0;
      left: 0;
      width: 100%;
      height: 8px;
      cursor: row-resize;
      z-index: 20;
    `;
    handle.title = 'Drag to resize height';

    let dragging = false;
    let dragStartY = 0;
    let dragStartH = 0;

    handle.addEventListener('pointerdown', (e) => {
      dragging = true;
      dragStartY = e.clientY;
      dragStartH = this.panelHeight;
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      // Dragging down → height increases (panel grows downward from top anchor).
      const newH = Math.max(MIN_PANEL_HEIGHT, Math.min(MAX_PANEL_HEIGHT,
        dragStartH + (e.clientY - dragStartY) / this.scale.factor,
      ));
      this.panelHeight = newH;
      this.el.style.height = `${newH}px`;
    });
    handle.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      localStorage.setItem(PANEL_HEIGHT_KEY, String(Math.round(this.panelHeight)));
    });

    return handle;
  }

  destroy(): void {
    this.offResize();
    this.el.remove();
  }
}
