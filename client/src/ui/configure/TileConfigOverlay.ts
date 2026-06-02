/**
 * TileConfigOverlay — full-screen sub-page of the Configuration scene that
 * lets the user enable / disable individual tiles in the system. Disabled
 * tiles are persisted to `server_config.json` under `disabledTiles`. The
 * Map Editor palette, the deterministic Composer, and the AI map generator
 * all consult the same disabled list at use time, so toggling here flips
 * what the rest of the engine can reach for.
 *
 * Layout: header + scrollable per-tileset grid + footer (BACK / CANCEL /
 * CONFIRM). Each tile thumbnail is a 56×56 cell with a 2px border —
 * enabled tiles render with the page's default border color, disabled
 * tiles get a 2px red border. Click a tile to flip; the state is
 * pending until CONFIRM is pressed (CANCEL discards).
 */
import type Phaser from "phaser";

const API_URL = "http://localhost:3000";

const COLOR_BG          = "#0a0e16";
const COLOR_PANEL       = "#0f1320";
const COLOR_DIVIDER     = "#334455";
const COLOR_TEXT        = "#aabbcc";
const COLOR_TEXT_BRIGHT = "#e2b96f";
const COLOR_HEADER      = "#cce4ff";
const COLOR_BORDER_OK   = "#1a1a2a";
const COLOR_BORDER_OFF  = "#cc4444";
const COLOR_BORDER_HOVR = "#7aadcc";

/** Per-tileset legend payload (mirrors the server's `/tilesets/legends`). */
interface PerTilesetLegend {
  tileset: string;
  image: string;
  notes: string;
  tiles: Record<string, { name: string; passable: boolean; layer: 'ground' | 'object'; description: string; tags: string[] }>;
}
interface TileLegendPayload {
  tilesets: PerTilesetLegend[];
}
/** Tileset descriptor returned by `GET /tilesets` (image + slicing meta). */
interface TilesetDescriptor {
  imageUrl: string;
  tilewidth: number;
  tileheight: number;
  margin: number;
  spacing: number;
  columns: number;
}

export interface TileConfigOverlayOptions {
  onClose?: () => void;
}

export class TileConfigOverlay {
  private readonly rootEl: HTMLDivElement;
  /** Pending disabled-tile state — mutated as the user clicks; persisted on
   *  CONFIRM. Keyed by tileset name; values are the set of disabled local
   *  ids. Each set is mutated in place to flip a tile's state. */
  private pending: Map<string, Set<number>> = new Map();
  /** Snapshot of the persisted state at overlay-open time, used to compute
   *  the diff for the status line + dirty-state on CONFIRM. */
  private initial: Map<string, Set<number>> = new Map();
  private statusEl: HTMLDivElement | null = null;
  private confirmBtn: HTMLButtonElement | null = null;
  /** Per-cell elements keyed by `${tileset}:${localId}` so we can repaint
   *  the border without rebuilding the grid. */
  private cellEls: Map<string, HTMLDivElement> = new Map();

  constructor(private readonly hostScene: Phaser.Scene, private readonly opts: TileConfigOverlayOptions = {}) {
    this.rootEl = document.createElement("div");
    this.rootEl.style.cssText = `
      position: fixed; inset: 0;
      background: ${COLOR_BG};
      color: ${COLOR_TEXT};
      font-family: monospace; font-size: 11px;
      z-index: 100;
      display: flex; flex-direction: column;
      padding: 22px 48px;
      box-sizing: border-box;
      overflow: hidden;
    `;
    document.body.appendChild(this.rootEl);
    this.build();
    void this.load();
  }

  private build(): void {
    // Header.
    const title = document.createElement("div");
    title.textContent = "CONFIGURE TILES";
    title.style.cssText = `
      font-family: monospace; font-size: 22px;
      color: ${COLOR_TEXT_BRIGHT}; letter-spacing: 1px; text-align: center;
    `;
    this.rootEl.appendChild(title);

    const headerDiv = document.createElement("div");
    headerDiv.style.cssText = `width: 100%; height: 1px; background: ${COLOR_DIVIDER}; margin: 14px 0 18px;`;
    this.rootEl.appendChild(headerDiv);

    const subtitle = document.createElement("div");
    subtitle.textContent = "Click a tile to disable it. Disabled tiles get a RED border. They are hidden from the Map Editor palette and skipped by both the deterministic Composer and the AI map generator.";
    subtitle.style.cssText = `
      font-family: sans-serif; font-size: 12px; color: ${COLOR_TEXT};
      max-width: 820px; margin: 0 auto 18px; text-align: center; line-height: 1.5;
    `;
    this.rootEl.appendChild(subtitle);

    // Scrollable per-tileset grid container.
    const body = document.createElement("div");
    body.style.cssText = `
      flex: 1; overflow-y: auto;
      background: ${COLOR_PANEL};
      border: 1px solid ${COLOR_DIVIDER};
      padding: 18px;
      min-height: 0;
      scrollbar-width: thin; scrollbar-color: #445566 transparent;
    `;
    this.rootEl.appendChild(body);
    this.bodyEl = body;

    const loading = document.createElement("div");
    loading.textContent = "Loading tile palette…";
    loading.style.cssText = `color: ${COLOR_TEXT}; text-align: center; padding: 32px;`;
    body.appendChild(loading);
    this.loadingEl = loading;

    // Footer.
    const footerDiv = document.createElement("div");
    footerDiv.style.cssText = `width: 100%; height: 1px; background: ${COLOR_DIVIDER}; margin: 18px 0 14px;`;
    this.rootEl.appendChild(footerDiv);

    const footer = document.createElement("div");
    footer.style.cssText = `display: flex; align-items: center; justify-content: space-between; gap: 16px;`;

    const backBtn = this.makeFooterBtn("BACK", false);
    backBtn.addEventListener("click", () => this.close());

    const cancelBtn = this.makeFooterBtn("CANCEL", false);
    cancelBtn.addEventListener("click", () => this.close());

    const status = document.createElement("div");
    status.style.cssText = `flex: 1; text-align: center; color: ${COLOR_TEXT}; letter-spacing: 1px;`;
    this.statusEl = status;

    const confirmBtn = this.makeFooterBtn("CONFIRM", true);
    confirmBtn.addEventListener("click", () => void this.confirm());
    this.confirmBtn = confirmBtn;

    footer.appendChild(backBtn);
    footer.appendChild(cancelBtn);
    footer.appendChild(status);
    footer.appendChild(confirmBtn);
    this.rootEl.appendChild(footer);
  }

  private bodyEl: HTMLDivElement | null = null;
  private loadingEl: HTMLDivElement | null = null;

  private async load(): Promise<void> {
    try {
      // Three round trips, fired in parallel: legends (which tiles exist),
      // tilesets (image + slicing meta for thumbnails), server-config
      // (current disabled list). Each is cheap and the page is dead
      // until they all land.
      const [legendsRes, tilesetsRes, configRes] = await Promise.all([
        fetch(`${API_URL}/tilesets/legends`),
        fetch(`${API_URL}/tilesets`),
        fetch(`${API_URL}/server-config`),
      ]);
      const legends = (await legendsRes.json()) as TileLegendPayload;
      const tilesets = (await tilesetsRes.json()) as TilesetDescriptor[];
      const config = (await configRes.json()) as { disabledTiles?: Record<string, number[]> };
      this.populateGrid(legends, tilesets, config.disabledTiles ?? {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.loadingEl) this.loadingEl.textContent = `Failed to load tile palette: ${msg}`;
    }
  }

  private populateGrid(legends: TileLegendPayload, tilesetMeta: TilesetDescriptor[], persisted: Record<string, number[]>): void {
    if (!this.bodyEl) return;
    this.loadingEl?.remove();
    this.loadingEl = null;
    this.bodyEl.replaceChildren();

    // Seed pending + initial maps from the persisted disabled list. We work
    // off copies so CANCEL is a no-op.
    for (const [tileset, ids] of Object.entries(persisted)) {
      this.pending.set(tileset, new Set(ids));
      this.initial.set(tileset, new Set(ids));
    }

    const metaByUrl = new Map(tilesetMeta.map((m) => [m.imageUrl, m]));

    for (const ts of legends.tilesets) {
      const meta = metaByUrl.get(ts.image);
      if (!meta) continue;

      const header = document.createElement("div");
      header.textContent = ts.tileset.toUpperCase();
      header.style.cssText = `
        color: ${COLOR_TEXT_BRIGHT}; font-family: monospace; font-size: 13px;
        letter-spacing: 2px; padding: 8px 0 6px; margin-top: 12px;
        border-bottom: 1px solid ${COLOR_DIVIDER};
      `;
      this.bodyEl.appendChild(header);

      // Split by layer so the user can scan ground vs object tiles.
      const groundIds: number[] = [];
      const objectIds: number[] = [];
      for (const k of Object.keys(ts.tiles)) {
        const id = parseInt(k, 10);
        if (!Number.isFinite(id) || id <= 0) continue;
        (ts.tiles[k].layer === 'object' ? objectIds : groundIds).push(id);
      }
      groundIds.sort((a, b) => a - b);
      objectIds.sort((a, b) => a - b);

      const subSection = (subtitle: string, ids: number[]): void => {
        if (ids.length === 0) return;
        const sub = document.createElement("div");
        sub.textContent = subtitle;
        sub.style.cssText = `
          color: #88ccaa; font-family: monospace; font-size: 10px;
          letter-spacing: 1px; padding: 8px 0 4px; opacity: 0.85;
        `;
        this.bodyEl!.appendChild(sub);

        const grid = document.createElement("div");
        grid.style.cssText = `
          display: grid; grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
          gap: 6px; padding: 4px 0 12px;
        `;
        for (const id of ids) grid.appendChild(this.makeTileCell(ts, meta, id));
        this.bodyEl!.appendChild(grid);
      };
      subSection("GROUND", groundIds);
      subSection("OBJECT", objectIds);
    }

    this.refreshStatus();
  }

  private makeTileCell(ts: PerTilesetLegend, meta: TilesetDescriptor, localId: number): HTMLDivElement {
    const entry = ts.tiles[String(localId)];
    const cellKey = `${ts.tileset}:${localId}`;
    const cell = document.createElement("div");
    const disabledNow = this.pending.get(ts.tileset)?.has(localId) ?? false;
    cell.style.cssText = `
      width: 100%; aspect-ratio: 1 / 1; box-sizing: border-box;
      border: 2px solid ${disabledNow ? COLOR_BORDER_OFF : COLOR_BORDER_OK};
      background: ${COLOR_BG};
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; position: relative; overflow: hidden;
    `;
    cell.title = `${ts.tileset} #${localId} — ${entry?.name ?? '(unnamed)'}`;
    cell.addEventListener("mouseenter", () => {
      const off = this.pending.get(ts.tileset)?.has(localId) ?? false;
      if (!off) cell.style.borderColor = COLOR_BORDER_HOVR;
    });
    cell.addEventListener("mouseleave", () => {
      const off = this.pending.get(ts.tileset)?.has(localId) ?? false;
      cell.style.borderColor = off ? COLOR_BORDER_OFF : COLOR_BORDER_OK;
    });
    cell.addEventListener("click", () => this.toggleTile(ts.tileset, localId));

    // Thumbnail — render the source tile onto a 56-square canvas via a
    // direct image load. We don't have access to Phaser's cached texture
    // here (this overlay is layered above the canvas, not inside a scene)
    // so we load the spritesheet PNG straight from `/tilesets/*.png`.
    const canvas = document.createElement("canvas");
    canvas.width = 56; canvas.height = 56;
    canvas.style.cssText = "width: 100%; height: 100%; display: block; image-rendering: pixelated;";
    cell.appendChild(canvas);
    const img = new Image();
    img.src = `${API_URL}${meta.imageUrl}`;
    img.addEventListener("load", () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const frame = localId - 1;
      const sx = meta.margin + (frame % meta.columns) * (meta.tilewidth + meta.spacing);
      const sy = meta.margin + Math.floor(frame / meta.columns) * (meta.tileheight + meta.spacing);
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, sx, sy, meta.tilewidth, meta.tileheight, 0, 0, canvas.width, canvas.height);
    });

    this.cellEls.set(cellKey, cell);
    return cell;
  }

  private toggleTile(tileset: string, localId: number): void {
    let set = this.pending.get(tileset);
    if (!set) {
      set = new Set();
      this.pending.set(tileset, set);
    }
    if (set.has(localId)) set.delete(localId);
    else set.add(localId);
    // Repaint just this cell instead of rebuilding the grid.
    const cellKey = `${tileset}:${localId}`;
    const cell = this.cellEls.get(cellKey);
    if (cell) {
      const off = set.has(localId);
      cell.style.borderColor = off ? COLOR_BORDER_OFF : COLOR_BORDER_OK;
    }
    this.refreshStatus();
  }

  private refreshStatus(): void {
    if (!this.statusEl || !this.confirmBtn) return;
    let pendingCount = 0;
    let diff = 0;
    for (const [tileset, set] of this.pending.entries()) {
      pendingCount += set.size;
      const prior = this.initial.get(tileset) ?? new Set<number>();
      // Symmetric diff between prior + pending.
      for (const v of set) if (!prior.has(v)) diff++;
      for (const v of prior) if (!set.has(v)) diff++;
    }
    // Count any tilesets that had prior disables but now have an empty
    // pending set — those still contribute to the diff via the loop above.
    for (const [tileset, prior] of this.initial.entries()) {
      if (this.pending.has(tileset)) continue;
      diff += prior.size;
    }
    const dirty = diff > 0;
    this.statusEl.textContent = `${pendingCount} tile(s) disabled${dirty ? ` · ${diff} pending change(s)` : ''}`;
    this.confirmBtn.disabled = !dirty;
    this.confirmBtn.style.opacity = dirty ? "1" : "0.4";
    this.confirmBtn.style.cursor = dirty ? "pointer" : "not-allowed";
  }

  private async confirm(): Promise<void> {
    if (!this.confirmBtn || this.confirmBtn.disabled) return;
    const disabledTiles: Record<string, number[]> = {};
    for (const [tileset, set] of this.pending.entries()) {
      if (set.size === 0) continue;
      disabledTiles[tileset] = [...set].sort((a, b) => a - b);
    }
    try {
      const res = await fetch(`${API_URL}/server-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disabledTiles }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (this.statusEl) this.statusEl.textContent = "Saved.";
      // Cache the new persisted state on the registry so other scenes don't
      // need a round trip — keys mirror the server response shape.
      this.hostScene.registry.set("disabledTiles", disabledTiles);
      this.close();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.statusEl) {
        this.statusEl.textContent = `Save failed: ${msg}`;
        this.statusEl.style.color = "#cc7777";
      }
    }
  }

  private close(): void {
    this.rootEl.remove();
    this.opts.onClose?.();
  }

  private makeFooterBtn(label: string, primary: boolean): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.style.cssText = `
      background: ${primary ? "#243250" : "transparent"};
      color: ${primary ? COLOR_HEADER : COLOR_TEXT};
      border: 1px solid ${primary ? COLOR_HEADER : COLOR_TEXT};
      font-family: monospace; font-size: 11px; letter-spacing: 2px;
      padding: 8px 24px; min-width: 140px; cursor: pointer;
    `;
    return btn;
  }
}
