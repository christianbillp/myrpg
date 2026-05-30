import type { AdventureDef } from "../../net/types";

/**
 * AdventurePickerOverlay — HTML modal listing every authored adventure.
 * Used by the Adventure Creator's LOAD ADVENTURE button. Same visual
 * pattern as `EncounterPickerOverlay` / `MapSelectorOverlay`.
 */
const COLOR_BG_BACKDROP   = "rgba(0,0,0,0.75)";
const COLOR_PANEL         = "#141426";
const COLOR_PANEL_BORDER  = "#88ccaa";
const COLOR_CARD          = "#1a1a2e";
const COLOR_CARD_HOVER    = "#23233a";
const COLOR_CARD_BORDER   = "#334455";
const COLOR_TITLE         = "#e2b96f";
const COLOR_SUBLABEL      = "#88ccaa";
const COLOR_TEXT          = "#aabbcc";
const COLOR_TEXT_DIM      = "#667788";
const COLOR_PROSE         = "#8899aa";

interface AdventurePickerCallbacks {
  onSelect: (adv: AdventureDef) => void;
  onClose: () => void;
}

export class AdventurePickerOverlay {
  private root: HTMLDivElement | null = null;
  private onKeyDown: ((e: KeyboardEvent) => void) | null = null;

  constructor(adventures: AdventureDef[], callbacks: AdventurePickerCallbacks) {
    this.buildOverlay(adventures, callbacks);
  }

  destroy(): void {
    if (this.onKeyDown) {
      window.removeEventListener("keydown", this.onKeyDown);
      this.onKeyDown = null;
    }
    this.root?.remove();
    this.root = null;
  }

  private buildOverlay(adventures: AdventureDef[], cb: AdventurePickerCallbacks): void {
    const root = document.createElement("div");
    root.style.cssText = `
      position: fixed; inset: 0;
      z-index: 1000;
      background: ${COLOR_BG_BACKDROP};
      display: flex; align-items: center; justify-content: center;
      font-family: monospace;
    `;
    this.root = root;
    root.addEventListener("click", (ev) => {
      if (ev.target === root) ev.stopPropagation();
    });
    this.onKeyDown = (e): void => { if (e.key === "Escape") cb.onClose(); };
    window.addEventListener("keydown", this.onKeyDown);

    const panel = document.createElement("div");
    panel.style.cssText = `
      width: 1100px; max-width: 92vw;
      height: 700px; max-height: 88vh;
      background: ${COLOR_PANEL};
      border: 2px solid ${COLOR_PANEL_BORDER};
      display: flex; flex-direction: column;
      color: ${COLOR_TEXT};
      overflow: hidden;
      box-sizing: border-box;
    `;
    root.appendChild(panel);

    const header = document.createElement("div");
    header.style.cssText = `
      padding: 22px 24px 14px; text-align: center;
      border-bottom: 1px solid ${COLOR_CARD_BORDER};
    `;
    const headerTag = document.createElement("div");
    headerTag.textContent = "LOAD ADVENTURE";
    headerTag.style.cssText = `
      font-size: 11px; color: ${COLOR_SUBLABEL};
      letter-spacing: 2px; margin-bottom: 8px;
    `;
    const sub = document.createElement("div");
    sub.textContent = `${adventures.length} saved adventure${adventures.length === 1 ? "" : "s"}`;
    sub.style.cssText = `font-size: 13px; color: ${COLOR_TEXT};`;
    header.appendChild(headerTag);
    header.appendChild(sub);
    panel.appendChild(header);

    const body = document.createElement("div");
    body.style.cssText = `
      flex: 1; overflow-y: auto; padding: 16px 24px;
      scrollbar-width: thin; scrollbar-color: ${COLOR_SUBLABEL} transparent;
    `;
    panel.appendChild(body);

    if (adventures.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No saved adventures yet.";
      empty.style.cssText = `
        font-size: 13px; color: ${COLOR_TEXT_DIM};
        text-align: center; padding: 80px 0;
      `;
      body.appendChild(empty);
    } else {
      const grid = document.createElement("div");
      grid.style.cssText = `
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
        gap: 16px;
      `;
      for (const adv of adventures) {
        grid.appendChild(this.buildCard(adv, cb.onSelect));
      }
      body.appendChild(grid);
    }

    const footer = document.createElement("div");
    footer.style.cssText = `
      padding: 14px 24px;
      border-top: 1px solid ${COLOR_CARD_BORDER};
      display: flex; justify-content: flex-end;
    `;
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "CLOSE";
    closeBtn.style.cssText = `
      background: #222233; color: ${COLOR_TEXT};
      border: 2px solid #556677;
      font-family: monospace; font-size: 13px;
      letter-spacing: 1.5px;
      padding: 8px 36px;
      cursor: pointer;
      min-width: 220px;
    `;
    closeBtn.addEventListener("click", () => cb.onClose());
    footer.appendChild(closeBtn);
    panel.appendChild(footer);

    document.body.appendChild(root);
  }

  private buildCard(adv: AdventureDef, onSelect: (a: AdventureDef) => void): HTMLDivElement {
    const card = document.createElement("div");
    card.style.cssText = `
      background: ${COLOR_CARD};
      border: 1px solid ${COLOR_CARD_BORDER};
      display: flex; flex-direction: column;
      cursor: pointer;
      padding: 14px;
      transition: border-color 0.1s;
    `;
    card.addEventListener("mouseenter", () => {
      card.style.borderColor = COLOR_PANEL_BORDER;
      card.style.background = COLOR_CARD_HOVER;
    });
    card.addEventListener("mouseleave", () => {
      card.style.borderColor = COLOR_CARD_BORDER;
      card.style.background = COLOR_CARD;
    });
    card.addEventListener("click", () => onSelect(adv));

    const title = document.createElement("div");
    title.textContent = adv.title;
    title.style.cssText = `
      font-size: 14px; color: ${COLOR_TITLE};
      margin-bottom: 4px; word-wrap: break-word;
    `;
    card.appendChild(title);

    const subEl = document.createElement("div");
    subEl.textContent = `${adv.id}  ·  ${adv.chapters.length} chapter${adv.chapters.length === 1 ? "" : "s"}`;
    subEl.style.cssText = `
      font-size: 9px; color: ${COLOR_TEXT_DIM};
      margin-bottom: 8px; word-wrap: break-word;
    `;
    card.appendChild(subEl);

    if (adv.description) {
      const desc = document.createElement("div");
      desc.textContent = adv.description;
      desc.style.cssText = `
        font-size: 11px; color: ${COLOR_PROSE};
        font-family: sans-serif;
        line-height: 1.5; word-wrap: break-word;
        overflow: hidden;
        display: -webkit-box;
        -webkit-line-clamp: 4;
        -webkit-box-orient: vertical;
      `;
      card.appendChild(desc);
    }

    return card;
  }
}
