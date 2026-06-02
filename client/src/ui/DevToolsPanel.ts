/**
 * DevToolsPanel — a small bottom-anchored panel sitting immediately to the
 * right of the Player Panel. Hosts dev-only buttons so they don't clutter
 * the player-facing UI. Visibility is gated by `DevMode.showDevToolsPanel`
 * (toggled from the Configuration scene). When hidden, the panel is not
 * instantiated at all — there's no perf cost.
 *
 * Layout: anchored at game-coords (PLAYER_PANEL_WIDTH, GAME_H − panel_h),
 * so its right edge floats over the leftmost tile column. The panel
 * deliberately does NOT overlap the Player Panel — its `gameX` starts
 * exactly at the Player Panel's right edge.
 *
 * Buttons are added one per row (column-reverse) so the bottom-most button
 * is always anchored to the panel's bottom edge — matches the Player Panel
 * convention.
 */
import type { UIScale } from "./UIScale";
import { PLAYER_PANEL_WIDTH, GRID_ROWS, TILE_SIZE, HUD_HEIGHT } from "../constants";

const PANEL_W = 200;
const PANEL_H = 130;
const GAME_H = GRID_ROWS * TILE_SIZE + HUD_HEIGHT;

export interface DevToolsCallbacks {
  onReloadEncounter: () => void;
  onCompleteObjective: () => void;
}

export class DevToolsPanel {
  private readonly el: HTMLDivElement;
  private readonly completeBtn: HTMLButtonElement;
  private readonly offResize: () => void;

  constructor(scale: UIScale, callbacks: DevToolsCallbacks, opts: { showCompleteObjective: boolean }) {
    this.el = document.createElement("div");
    this.el.className = "gui-panel";
    // Distinct accent border so the panel is visually obvious as dev-only
    // tooling — magenta border + slightly tinted background.
    this.el.style.cssText += `
      width: ${PANEL_W}px;
      height: ${PANEL_H}px;
      background: #14101a;
      border: 1px solid #663366;
      border-left: 2px solid #884488;
      color: #d8a8d8;
      z-index: 10;
    `;
    this.el.innerHTML = `
      <div style="padding:6px 10px 2px;font-size:10px;color:#aa66aa;letter-spacing:1px;">DEV TOOLS</div>
      <div class="gui-sep" style="margin-bottom:4px;"></div>
      <div style="display:flex;flex-direction:column-reverse;gap:4px;padding:0 8px 8px;height:${PANEL_H - 30}px;">
        <button class="gui-btn" style="background:#1a3a1a;color:#bbeeaa;display:none;" data-dev-complete>★ COMPLETE OBJECTIVE</button>
        <button class="gui-btn" style="background:#2a1a3a;color:#ddaaff;" data-dev-reload>↻ RELOAD ENCOUNTER</button>
      </div>
    `;

    const ref = (attr: string) => this.el.querySelector(`[data-${attr}]`) as HTMLElement;
    const reloadBtn = ref("dev-reload") as HTMLButtonElement;
    this.completeBtn = ref("dev-complete") as HTMLButtonElement;

    reloadBtn.onclick = () => callbacks.onReloadEncounter();
    this.completeBtn.onclick = () => callbacks.onCompleteObjective();
    if (opts.showCompleteObjective) this.completeBtn.style.display = "block";

    document.body.appendChild(this.el);
    const place = () => scale.placePanel(this.el, PLAYER_PANEL_WIDTH, GAME_H - PANEL_H);
    place();
    this.offResize = scale.onChange(place);
  }

  setCompleteObjectiveVisible(visible: boolean): void {
    this.completeBtn.style.display = visible ? "block" : "none";
  }

  destroy(): void {
    this.offResize();
    this.el.remove();
  }
}
