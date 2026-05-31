/**
 * TokenPickerOverlay — HTML modal listing every saved token SVG plus a tag
 * on the cards that carry an editable spec (vs. legacy hand-authored ones).
 * Used by the Token Creator's LOAD button.
 *
 * Mirrors the visual language of the other picker overlays
 * (NpcPickerOverlay / AdventurePickerOverlay / EncounterPickerOverlay).
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

interface TokenPickerCallbacks {
  /** Fires with the filename stem (no extension). The Token Creator will
   *  load both the spec (`/token-specs/<id>`) and the SVG (`/tokens/<id>.svg`)
   *  in response. */
  onSelect: (id: string) => void;
  onClose: () => void;
}

export class TokenPickerOverlay {
  private root: HTMLDivElement | null = null;
  private onKeyDown: ((e: KeyboardEvent) => void) | null = null;

  constructor(
    /** Every `.svg` filename under `data/tokens/`. */
    tokenFiles: string[],
    /** Ids for which a saved spec exists — these get the EDITABLE tag and
     *  reload into the slot picker; tokens without a spec are display-only. */
    editableIds: string[],
    callbacks: TokenPickerCallbacks,
  ) {
    this.buildOverlay(tokenFiles, new Set(editableIds), callbacks);
  }

  destroy(): void {
    if (this.onKeyDown) {
      window.removeEventListener("keydown", this.onKeyDown);
      this.onKeyDown = null;
    }
    this.root?.remove();
    this.root = null;
  }

  private buildOverlay(files: string[], editable: Set<string>, cb: TokenPickerCallbacks): void {
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
    headerTag.textContent = "LOAD TOKEN";
    headerTag.style.cssText = `
      font-size: 11px; color: ${COLOR_SUBLABEL};
      letter-spacing: 2px; margin-bottom: 8px;
    `;
    const sub = document.createElement("div");
    const editableCount = files.filter((f) => editable.has(f.replace(/\.svg$/i, ""))).length;
    sub.textContent = `${files.length} token${files.length === 1 ? "" : "s"} (${editableCount} editable)`;
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

    if (files.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No tokens saved yet — build one with the slot picker.";
      empty.style.cssText = `
        font-size: 13px; color: ${COLOR_TEXT_DIM};
        text-align: center; padding: 80px 0;
      `;
      body.appendChild(empty);
    } else {
      const grid = document.createElement("div");
      grid.style.cssText = `
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
        gap: 16px;
      `;
      // Sort: editable specs first (so the author's own work surfaces above
      // legacy hand-authored ones), then alphabetical within each group.
      const sorted = files.slice().sort((a, b) => {
        const aId = a.replace(/\.svg$/i, "");
        const bId = b.replace(/\.svg$/i, "");
        const aE = editable.has(aId), bE = editable.has(bId);
        if (aE !== bE) return aE ? -1 : 1;
        return aId.localeCompare(bId);
      });
      for (const f of sorted) {
        grid.appendChild(this.buildCard(f, editable, cb.onSelect));
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

  private buildCard(filename: string, editable: Set<string>, onSelect: (id: string) => void): HTMLDivElement {
    const id = filename.replace(/\.svg$/i, "");
    const isEditable = editable.has(id);
    const card = document.createElement("div");
    card.style.cssText = `
      background: ${COLOR_CARD};
      border: 1px solid ${COLOR_CARD_BORDER};
      display: flex; flex-direction: column; align-items: center;
      cursor: pointer;
      padding: 12px;
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
    card.addEventListener("click", () => onSelect(id));

    const img = document.createElement("img");
    img.src = `/tokens/${filename}`;
    img.style.cssText = "width: 64px; height: 64px; image-rendering: auto;";
    card.appendChild(img);

    const nameEl = document.createElement("div");
    nameEl.textContent = id;
    nameEl.style.cssText = `
      font-size: 10px; color: ${COLOR_TITLE};
      margin-top: 8px; text-align: center;
      word-wrap: break-word; max-width: 100%;
    `;
    card.appendChild(nameEl);

    if (isEditable) {
      const tag = document.createElement("div");
      tag.textContent = "EDITABLE";
      tag.style.cssText = `
        color: #88ccaa; font-size: 8px; letter-spacing: 1px;
        margin-top: 4px;
      `;
      card.appendChild(tag);
    }
    return card;
  }
}
