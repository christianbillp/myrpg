import type Phaser from "phaser";
import type { MapPreviewData, MapZone } from "../EmbeddedMapPreview";
import { createHtmlButton, createHtmlText, type HtmlButtonHandle, type HtmlTextHandle } from "../htmlButtons";
import { attachPlacement as sharedAttachPlacement } from "../sceneInputs";

/**
 * ZonePalette — owns the ZONES tab of `MapEditorScene`. Manages a list of
 * author-time named tile regions (`MapZone`). Each zone has:
 *   • an id (auto-generated, never edited by the user)
 *   • a name (required, used as the on-map label)
 *   • a color (assigned from a fixed palette)
 *   • a set of tile cells the user has clicked into the zone
 *
 * The scene only needs to:
 *   1. `build(x, y, w, h)` once when the ZONES tab is first activated
 *   2. forward preview cell-clicks to `paintCell(col, row)` while the
 *      ZONES tab is active
 *   3. call `setVisible(false)` / `dispose()` when leaving the tab
 *
 * Zone data lives on `MapPreviewData.zones`; this class mutates that array
 * directly so the next SAVE MAP persists the edits.
 */

const ACCENT = "#cc88aa";

/** Pre-shuffled palette assigned round-robin to new zones. Picked to be
 *  visually distinct on the dark map background. */
const ZONE_COLORS = [
  "#ff7766", "#ffaa44", "#ffd966", "#aaff77", "#66dd99",
  "#66ccff", "#8899ff", "#cc99ff", "#ff88cc", "#bbbbbb",
];

export interface ZonePaletteContext {
  scene: Phaser.Scene;
  sceneWidth: number;
  getMap: () => MapPreviewData | null;
  repaintPreview: () => void;
  setStatus: (text: string) => void;
  markMapDirty: () => void;
}

export interface ZonePaletteHandle {
  setVisible(visible: boolean): void;
  dispose(): void;
}

export class ZonePalette {
  /** Id of the zone the user is currently editing. Null when no zone is
   *  selected — clicking a tile is a no-op in that state. */
  private activeZoneId: string | null = null;
  private handles: ZonePaletteHandle[] = [];
  /** DOM div that hosts the zone list. Re-rendered after every mutation. */
  private listEl: HTMLDivElement | null = null;

  constructor(private readonly ctx: ZonePaletteContext) {}

  build(x: number, y: number, w: number, h: number): ZonePaletteHandle[] {
    const { scene, sceneWidth: W } = this.ctx;
    const wrap = (handle: HtmlButtonHandle | HtmlTextHandle): ZonePaletteHandle => ({
      setVisible: (v) => handle.setVisible(v),
      dispose: () => handle.dispose(),
    });
    const push = (h: ZonePaletteHandle): void => { this.handles.push(h); };

    push(wrap(createHtmlText({
      scene, sceneWidth: W,
      x, y, w, h: 14,
      text: "ZONES",
      fontSize: 10, color: "#556677", align: "center", letterSpacing: 2,
    })));

    const hintY = y + 22;
    push(wrap(createHtmlText({
      scene, sceneWidth: W,
      x, y: hintY, w, h: 40,
      text: "Add a zone, then click tiles on the map to paint it. Each zone shows its name centered on the highlighted area.",
      fontSize: 10, color: "#88aacc", fontFamily: "sans-serif", align: "center",
    })));

    const addBtnY = hintY + 50;
    const addBtn = createHtmlButton({
      scene, sceneWidth: W,
      x, y: addBtnY, w, h: 30,
      label: "+ NEW ZONE", variant: "secondary", fontSize: 11,
      onClick: () => this.createZonePrompt(),
    });
    push(wrap(addBtn));

    // Scrollable zone list — same shell as the EDIT palette.
    const listY = addBtnY + 40;
    const listH = Math.max(160, y + h - listY - 4);
    const list = document.createElement("div");
    list.style.cssText = `
      position: absolute;
      background: #0f1320;
      border: 1px solid #334455;
      box-sizing: border-box;
      overflow-y: auto;
      z-index: 9;
      padding: 6px;
      scrollbar-width: thin;
      scrollbar-color: #445566 transparent;
    `;
    document.body.appendChild(list);
    push(sharedAttachPlacement(list, { scene, sceneWidth: W, x, y: listY, w, h: listH }));
    this.listEl = list;
    this.renderList();

    return this.handles;
  }

  setVisible(visible: boolean): void {
    for (const h of this.handles) h.setVisible(visible);
    if (this.listEl) {
      // Re-render the list when the tab is shown again so newly-loaded maps
      // (the user pressed LOAD MAP while on another tab) show their zones.
      if (visible) this.renderList();
    }
  }

  /** Public hook for "the host scene just loaded / generated a new map".
   *  Drops any stale active-zone selection (the new map has different ids)
   *  and re-renders the zone list against the new previewedMap. */
  refresh(): void {
    const data = this.ctx.getMap();
    const zones = data?.zones ?? [];
    if (this.activeZoneId && !zones.some((z) => z.id === this.activeZoneId)) {
      this.activeZoneId = null;
    }
    this.renderList();
  }

  dispose(): void {
    for (const h of this.handles) h.dispose();
    this.handles = [];
    this.listEl = null;
    this.activeZoneId = null;
  }

  /** Cell click forwarded from the preview while the ZONES tab is active.
   *  Toggles the clicked cell in/out of the currently-selected zone. */
  paintCell(col: number, row: number): void {
    const data = this.ctx.getMap();
    if (!data) {
      this.ctx.setStatus("Load or generate a map before drawing zones.");
      return;
    }
    if (!this.activeZoneId) {
      this.ctx.setStatus("Select a zone (or press + NEW ZONE) before clicking cells.");
      return;
    }
    const zones = (data.zones ?? (data.zones = []));
    const z = zones.find((zz) => zz.id === this.activeZoneId);
    if (!z) {
      this.ctx.setStatus("Active zone was removed — pick another one.");
      this.activeZoneId = null;
      this.renderList();
      return;
    }
    const key = `${col},${row}`;
    const idx = z.cells.indexOf(key);
    if (idx >= 0) {
      z.cells.splice(idx, 1);
      this.ctx.setStatus(`Removed (${col},${row}) from "${z.name}". ${z.cells.length} cell(s) left.`);
    } else {
      z.cells.push(key);
      this.ctx.setStatus(`Added (${col},${row}) to "${z.name}". ${z.cells.length} cell(s) total.`);
    }
    this.ctx.markMapDirty();
    this.ctx.repaintPreview();
    this.renderList();
  }

  private createZonePrompt(): void {
    const data = this.ctx.getMap();
    if (!data) {
      this.ctx.setStatus("Load or generate a map before adding zones.");
      return;
    }
    // Browser prompt — minimal, but matches the editor's other "quick name"
    // flows (e.g. saving an encounter). Cancel returns null and skips.
    const raw = window.prompt("Zone name (e.g. guardtower, altar, road):", "");
    if (raw === null) return;
    const name = raw.trim();
    if (name.length === 0) {
      this.ctx.setStatus("Zone name can't be empty.");
      return;
    }
    const zones = (data.zones ?? (data.zones = []));
    const color = ZONE_COLORS[zones.length % ZONE_COLORS.length];
    const zone: MapZone = {
      id: `zone_${Date.now().toString(36)}_${Math.floor(Math.random() * 36 ** 4).toString(36)}`,
      name,
      color,
      cells: [],
    };
    zones.push(zone);
    this.activeZoneId = zone.id;
    this.ctx.markMapDirty();
    this.ctx.repaintPreview();
    this.renderList();
    this.ctx.setStatus(`Zone "${name}" created. Click tiles on the map to add them.`);
  }

  private renderList(): void {
    if (!this.listEl) return;
    this.listEl.replaceChildren();
    const data = this.ctx.getMap();
    const zones = data?.zones ?? [];
    if (zones.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No zones yet.";
      empty.style.cssText = "color:#556677; font-family:monospace; font-size:11px; padding:6px; font-style:italic;";
      this.listEl.appendChild(empty);
      return;
    }

    for (const z of zones) {
      const card = document.createElement("div");
      const active = z.id === this.activeZoneId;
      card.style.cssText = `
        display: flex; flex-direction: column; gap: 4px;
        padding: 6px 8px; margin-bottom: 6px;
        background: #1a1a26;
        border: 1px solid ${active ? ACCENT : '#334455'};
        cursor: pointer;
      `;
      card.addEventListener("click", (e) => {
        // Click anywhere on the card EXCEPT a button picks the zone.
        if ((e.target as HTMLElement).tagName === 'BUTTON') return;
        this.activeZoneId = z.id;
        this.renderList();
        this.ctx.setStatus(`Editing "${z.name}". Click tiles on the map to toggle them.`);
      });

      const headerRow = document.createElement("div");
      headerRow.style.cssText = "display:flex; align-items:center; gap:8px;";

      const swatch = document.createElement("span");
      swatch.style.cssText = `
        display:inline-block; width:14px; height:14px;
        background:${z.color}; border:1px solid #00000088;
      `;
      headerRow.appendChild(swatch);

      const nameEl = document.createElement("span");
      nameEl.textContent = z.name;
      nameEl.style.cssText = `flex:1; color:${active ? ACCENT : '#cce4ff'}; font-family:monospace; font-size:12px;`;
      headerRow.appendChild(nameEl);

      const renameBtn = document.createElement("button");
      renameBtn.textContent = "rename";
      renameBtn.style.cssText = "background:transparent; border:1px solid #334455; color:#88aacc; font-family:monospace; font-size:10px; padding:2px 6px; cursor:pointer;";
      renameBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const next = window.prompt("Rename zone:", z.name);
        if (next === null) return;
        const trimmed = next.trim();
        if (trimmed.length === 0) {
          this.ctx.setStatus("Zone name can't be empty.");
          return;
        }
        z.name = trimmed;
        this.ctx.markMapDirty();
        this.ctx.repaintPreview();
        this.renderList();
      });
      headerRow.appendChild(renameBtn);

      const delBtn = document.createElement("button");
      delBtn.textContent = "✕";
      delBtn.style.cssText = "background:transparent; border:1px solid #5a3333; color:#cc7777; font-family:monospace; font-size:11px; padding:2px 6px; cursor:pointer;";
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!window.confirm(`Delete zone "${z.name}"?`)) return;
        const data = this.ctx.getMap();
        if (!data || !data.zones) return;
        data.zones = data.zones.filter((zz) => zz.id !== z.id);
        if (this.activeZoneId === z.id) this.activeZoneId = null;
        this.ctx.markMapDirty();
        this.ctx.repaintPreview();
        this.renderList();
        this.ctx.setStatus(`Zone "${z.name}" deleted.`);
      });
      headerRow.appendChild(delBtn);

      card.appendChild(headerRow);

      const meta = document.createElement("div");
      meta.textContent = `${z.cells.length} tile${z.cells.length === 1 ? '' : 's'} · id ${z.id}`;
      meta.style.cssText = "color:#556677; font-family:monospace; font-size:9px;";
      card.appendChild(meta);

      this.listEl.appendChild(card);
    }
  }
}
