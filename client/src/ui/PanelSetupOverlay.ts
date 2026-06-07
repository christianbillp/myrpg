/**
 * PanelSetupOverlay — configure the Player Panel. Renders as a panel filling the
 * screen to the RIGHT of the (resizable) Player Panel, so the panel stays
 * visible and updates live as settings change. Two sections:
 *
 *   1. **Actions** — one card per Action Button (`ACTION_BUTTON_CATALOG`) with a
 *      short description and a "Visible in panel" toggle.
 *   2. **Configuration** — panel-wide settings cards. Currently one: **Compact
 *      View** (icon-only square buttons).
 *
 * Every change persists immediately (localStorage) and fires `onChange` so the
 * panel re-renders. Standalone HTML (not `BaseOverlay`) — it tracks the Player
 * Panel's right edge via a ResizeObserver.
 */
import {
  ACTION_BUTTON_CATALOG, readHiddenActions, writeHiddenActions, setActionHidden,
  readCompactView, writeCompactView,
} from "./actionPanelPrefs";

const ACCENT = "#7aadcc";

export class PanelSetupOverlay {
  private readonly root: HTMLDivElement;
  private readonly actionsGrid: HTMLDivElement;
  private readonly resizeObserver: ResizeObserver;
  private readonly onKey: (e: KeyboardEvent) => void;

  /** @param panelEl the Player Panel element — the overlay starts at its right edge. */
  constructor(private readonly panelEl: HTMLElement, private readonly onChange: () => void) {
    this.root = document.createElement("div");
    this.root.style.cssText = `
      position: fixed; top: 0; bottom: 0; right: 0;
      background: rgba(8, 8, 16, 0.97);
      z-index: 60; box-sizing: border-box;
      display: flex; flex-direction: column;
      padding: 22px 26px 16px; font-family: monospace; color: #cdd8e8;`;

    const title = document.createElement("div");
    title.textContent = "PLAYER PANEL SETUP";
    title.style.cssText = `font-size: 16px; color: ${ACCENT}; letter-spacing: 1px; flex-shrink: 0;`;
    this.root.appendChild(title);

    const scroll = document.createElement("div");
    scroll.style.cssText = "flex: 1; overflow-y: auto; padding-right: 6px; margin-top: 10px;";

    // ── Section 1: Actions ──────────────────────────────────────────────
    scroll.appendChild(this.sectionHeader("Actions", "Choose which action buttons appear. Buttons stay greyed when you can't use them right now; hiding one removes it entirely. (Roll Death Save can't be hidden.)"));
    this.actionsGrid = this.grid();
    scroll.appendChild(this.actionsGrid);
    this.rebuildActionCards();

    // ── Section 2: Configuration ────────────────────────────────────────
    scroll.appendChild(this.sectionHeader("Configuration", "Panel-wide display settings."));
    const configGrid = this.grid();
    configGrid.appendChild(this.toggleCard(
      "⊞", "Compact View",
      "Show action buttons as small icon-only squares (no text). Hover a button to see its name.",
      readCompactView(),
      (on) => { writeCompactView(on); this.onChange(); },
    ));
    scroll.appendChild(configGrid);

    this.root.appendChild(scroll);

    const footer = document.createElement("div");
    footer.style.cssText = "display: flex; gap: 8px; justify-content: flex-end; padding-top: 12px; flex-shrink: 0;";
    footer.appendChild(this.button("Show all actions", "#1a3a2a", "#2a6655", () => {
      writeHiddenActions(new Set());
      this.onChange();
      this.rebuildActionCards();
    }));
    footer.appendChild(this.button("Done", "#1a2a3a", "#345566", () => this.close()));
    this.root.appendChild(footer);

    document.body.appendChild(this.root);

    // Track the Player Panel's right edge (it's user-resizable) so the overlay
    // always fills exactly the screen minus the panel.
    this.placeLeftEdge();
    this.resizeObserver = new ResizeObserver(() => this.placeLeftEdge());
    this.resizeObserver.observe(this.panelEl);

    this.onKey = (e: KeyboardEvent) => { if (e.key === "Escape") this.close(); };
    document.addEventListener("keydown", this.onKey);
  }

  private placeLeftEdge(): void {
    this.root.style.left = `${Math.round(this.panelEl.getBoundingClientRect().right)}px`;
  }

  private sectionHeader(title: string, blurb: string): HTMLElement {
    const wrap = document.createElement("div");
    wrap.style.cssText = "margin: 6px 0 8px;";
    const h = document.createElement("div");
    h.textContent = title.toUpperCase();
    h.style.cssText = `font-size: 12px; color: ${ACCENT}; letter-spacing: 1.5px; border-bottom: 1px solid #283443; padding-bottom: 4px;`;
    wrap.appendChild(h);
    const b = document.createElement("div");
    b.textContent = blurb;
    b.style.cssText = "font-size: 11px; color: #8899aa; line-height: 1.5; margin-top: 6px; max-width: 760px;";
    wrap.appendChild(b);
    return wrap;
  }

  private grid(): HTMLDivElement {
    const g = document.createElement("div");
    g.style.cssText = "display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 8px; align-content: start; margin-bottom: 16px;";
    return g;
  }

  private rebuildActionCards(): void {
    this.actionsGrid.replaceChildren();
    const hidden = readHiddenActions();
    for (const e of ACTION_BUTTON_CATALOG) {
      this.actionsGrid.appendChild(this.toggleCard(
        e.glyph, e.label, e.description, !hidden.has(e.id),
        (on) => { setActionHidden(e.id, !on); this.onChange(); },
        { on: "Visible in panel", off: "Hidden" },
      ));
    }
  }

  /** A card with a glyph + name, a description, and a checkbox that reflects/sets
   *  an on/off state. `onToggle(on)` receives the new state; `labels` names the
   *  on/off states (e.g. Visible/Hidden for actions, Enabled/Disabled for config). */
  private toggleCard(
    glyph: string, label: string, description: string, on: boolean,
    onToggle: (on: boolean) => void,
    labels: { on: string; off: string } = { on: "Enabled", off: "Disabled" },
  ): HTMLElement {
    const card = document.createElement("label");
    card.style.cssText = `display: flex; flex-direction: column; gap: 6px; padding: 10px 12px;
      background: #11141c; border: 1px solid ${on ? "#2a4a3a" : "#283443"}; cursor: pointer;`;

    const top = document.createElement("div");
    top.style.cssText = "display: flex; align-items: center; gap: 8px;";
    const name = document.createElement("span");
    name.textContent = `${glyph}  ${label}`;
    name.style.cssText = "flex: 1; font-size: 13px; color: #dfe8f2;";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = on;
    box.style.cssText = "width: 16px; height: 16px; accent-color: #7ec27e; cursor: pointer; flex: none;";
    box.addEventListener("change", () => {
      card.style.borderColor = box.checked ? "#2a4a3a" : "#283443";
      stateLbl.textContent = box.checked ? labels.on : labels.off;
      stateLbl.style.color = box.checked ? "#7ec27e" : "#778899";
      onToggle(box.checked);
    });
    top.appendChild(name);
    top.appendChild(box);
    card.appendChild(top);

    const desc = document.createElement("div");
    desc.textContent = description;
    desc.style.cssText = "font-size: 10px; color: #8da0b3; line-height: 1.45;";
    card.appendChild(desc);

    const stateLbl = document.createElement("div");
    stateLbl.textContent = on ? labels.on : labels.off;
    stateLbl.style.cssText = `font-size: 10px; color: ${on ? "#7ec27e" : "#778899"};`;
    card.appendChild(stateLbl);

    return card;
  }

  private button(label: string, bg: string, border: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.style.cssText = `background:${bg};border:1px solid ${border};color:#c8dae8;font-family:monospace;font-size:12px;padding:7px 18px;cursor:pointer;`;
    b.addEventListener("click", onClick);
    return b;
  }

  close(): void {
    this.resizeObserver.disconnect();
    document.removeEventListener("keydown", this.onKey);
    this.root.remove();
  }
}
