import Phaser from "phaser";
import { tilesetTextureKey } from "../../scenes/BootScene";
import type { SavedMapDef } from "../../../../shared/types";
import type { MapPreviewData } from "../EmbeddedMapPreview";
import { decodeTileGid, TILE_VOID_GID } from "../../../../shared/tileGid";

/**
 * Modal overlay listing every saved map in the registry as clickable cards.
 * Used by the `EncounterCreatorScene` LOAD MAP button — selecting a card
 * resolves the overlay via `onSelect` with a `MapPreviewData` ready to seed
 * a new encounter draft.
 *
 * Pure HTML implementation matching `EncounterPickerOverlay`'s pattern:
 * single full-page `<div>` overlay, CSS-grid card layout, per-card
 * `<canvas>` thumbnails drawn from the same Phaser-loaded spritesheet
 * textures the in-scene renderer uses.
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
const COLOR_THUMB_BG      = "#0a0e16";

const CARD_THUMB_MAX_PX   = 6;

interface MapSelectorCallbacks {
  onSelect: (map: MapPreviewData) => void;
  onClose: () => void;
}

export class MapSelectorOverlay {
  private readonly scene: Phaser.Scene;
  private readonly fallbackTilesetKey: string;
  private root: HTMLDivElement | null = null;
  private onKeyDown: ((e: KeyboardEvent) => void) | null = null;

  constructor(
    scene: Phaser.Scene,
    maps: SavedMapDef[],
    callbacks: MapSelectorCallbacks,
  ) {
    this.scene = scene;
    this.fallbackTilesetKey = pickTilesetKey(scene);
    this.buildOverlay(maps, callbacks);
  }

  destroy(): void {
    if (this.onKeyDown) {
      window.removeEventListener("keydown", this.onKeyDown);
      this.onKeyDown = null;
    }
    this.root?.remove();
    this.root = null;
  }

  private buildOverlay(maps: SavedMapDef[], cb: MapSelectorCallbacks): void {
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

    // ── Panel ──────────────────────────────────────────────────────────
    const panel = document.createElement("div");
    panel.style.cssText = `
      width: 100vw; height: 100vh;
      background: ${COLOR_PANEL};
      display: flex; flex-direction: column;
      color: ${COLOR_TEXT};
      overflow: hidden;
      box-sizing: border-box;
    `;
    root.appendChild(panel);

    // ── Header ─────────────────────────────────────────────────────────
    const header = document.createElement("div");
    header.style.cssText = `
      padding: 22px 24px 14px; text-align: center;
      border-bottom: 1px solid ${COLOR_CARD_BORDER};
    `;
    const headerTag = document.createElement("div");
    headerTag.textContent = "LOAD MAP";
    headerTag.style.cssText = `
      font-size: 11px; color: ${COLOR_SUBLABEL};
      letter-spacing: 2px; margin-bottom: 8px;
    `;
    const sub = document.createElement("div");
    sub.textContent = `${maps.length} saved map${maps.length === 1 ? "" : "s"}`;
    sub.style.cssText = `font-size: 13px; color: ${COLOR_TEXT};`;
    header.appendChild(headerTag);
    header.appendChild(sub);
    panel.appendChild(header);

    // ── Body — scrollable card grid ────────────────────────────────────
    const body = document.createElement("div");
    body.style.cssText = `
      flex: 1; overflow-y: auto; padding: 16px 24px;
      scrollbar-width: thin; scrollbar-color: ${COLOR_SUBLABEL} transparent;
    `;
    panel.appendChild(body);

    if (maps.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No saved maps yet. Use the Map Creator to author one.";
      empty.style.cssText = `
        font-size: 13px; color: ${COLOR_TEXT_DIM};
        text-align: center; padding: 80px 0;
      `;
      body.appendChild(empty);
    } else {
      const grid = document.createElement("div");
      grid.style.cssText = `
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
        gap: 16px;
      `;
      for (const m of maps) {
        grid.appendChild(this.buildCard(m, cb.onSelect));
      }
      body.appendChild(grid);
    }

    // ── Footer — CLOSE ────────────────────────────────────────────────
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

  private buildCard(map: SavedMapDef, onSelect: (map: MapPreviewData) => void): HTMLDivElement {
    const card = document.createElement("div");
    card.style.cssText = `
      background: ${COLOR_CARD};
      border: 1px solid ${COLOR_CARD_BORDER};
      display: flex; flex-direction: column;
      cursor: pointer;
      padding: 10px;
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
    card.addEventListener("click", () => onSelect(savedMapToPreview(map)));

    // Thumbnail.
    const thumbWrap = document.createElement("div");
    thumbWrap.style.cssText = `
      width: 100%; height: 132px;
      background: ${COLOR_THUMB_BG};
      border: 1px solid #2a3340;
      display: flex; align-items: center; justify-content: center;
      box-sizing: border-box;
      margin-bottom: 8px;
    `;
    const canvas = document.createElement("canvas");
    this.drawThumbnail(canvas, map);
    canvas.style.cssText = `image-rendering: pixelated;`;
    thumbWrap.appendChild(canvas);
    card.appendChild(thumbWrap);

    // Title.
    const title = document.createElement("div");
    title.textContent = map.name;
    title.style.cssText = `
      font-size: 13px; color: ${COLOR_TITLE};
      margin-bottom: 4px;
      word-wrap: break-word;
    `;
    card.appendChild(title);

    // Subtitle — id + dimensions.
    const subEl = document.createElement("div");
    subEl.textContent = `${map.id}  ·  ${map.cols}×${map.rows}`;
    subEl.style.cssText = `
      font-size: 9px; color: ${COLOR_TEXT_DIM};
      margin-bottom: 6px;
      word-wrap: break-word;
    `;
    card.appendChild(subEl);

    // Description.
    if (map.mapdescription) {
      const desc = document.createElement("div");
      desc.textContent = map.mapdescription;
      desc.style.cssText = `
        font-size: 10px; color: ${COLOR_PROSE};
        font-family: sans-serif;
        line-height: 1.5;
        word-wrap: break-word;
        overflow: hidden;
        display: -webkit-box;
        -webkit-line-clamp: 3;
        -webkit-box-orient: vertical;
      `;
      card.appendChild(desc);
    }

    return card;
  }

  private drawThumbnail(canvas: HTMLCanvasElement, map: SavedMapDef): void {
    const maxW = 220;
    const maxH = 132;
    const tileSize = Math.min(
      Math.floor(maxW / map.cols),
      Math.floor(maxH / map.rows),
      CARD_THUMB_MAX_PX,
    );
    const thumbW = tileSize * map.cols;
    const thumbH = tileSize * map.rows;
    canvas.width = thumbW;
    canvas.height = thumbH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;

    const routing = (map.tilesets ?? [])
      .map((ts) => ({ firstgid: ts.firstgid, key: tilesetTextureKey(ts.imageUrl) }))
      .sort((a, b) => b.firstgid - a.firstgid);
    const owners = routing.length > 0
      ? routing
      : [{ firstgid: 1, key: this.fallbackTilesetKey }];

    for (let r = 0; r < map.rows; r++) {
      for (let c = 0; c < map.cols; c++) {
        const x = c * tileSize;
        const y = r * tileSize;
        const groundGid = map.gidGrid[r]?.[c] ?? 0;
        if (groundGid !== 0) this.drawTileToCanvas(ctx, x, y, tileSize, groundGid, owners);
        const objectGid = map.objectGidGrid?.[r]?.[c] ?? 0;
        if (objectGid !== 0) this.drawTileToCanvas(ctx, x, y, tileSize, objectGid, owners);
      }
    }
  }

  private drawTileToCanvas(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, size: number, rawGid: number,
    owners: Array<{ firstgid: number; key: string }>,
  ): void {
    const dec = decodeTileGid(rawGid);
    if (dec.gid === TILE_VOID_GID) {
      ctx.fillStyle = "#000000";
      ctx.fillRect(x, y, size, size);
      return;
    }
    const owner = owners.find((t) => dec.gid >= t.firstgid);
    if (!owner) return;
    const texture = this.scene.textures.get(owner.key);
    if (!texture || texture.key === "__MISSING") return;
    const source = texture.getSourceImage() as HTMLImageElement | HTMLCanvasElement;
    if (!source) return;

    const frame = dec.gid - owner.firstgid;
    const frameObj = texture.get(frame);
    if (!frameObj) return;
    const sx = frameObj.cutX;
    const sy = frameObj.cutY;
    const sw = frameObj.cutWidth;
    const sh = frameObj.cutHeight;

    const cx = x + size / 2;
    const cy = y + size / 2;
    ctx.save();
    ctx.translate(cx, cy);
    if (dec.angle !== 0) ctx.rotate((dec.angle * Math.PI) / 180);
    const fx = dec.flipX ? -1 : 1;
    const fy = dec.flipY ? -1 : 1;
    if (fx !== 1 || fy !== 1) ctx.scale(fx, fy);
    ctx.drawImage(source, sx, sy, sw, sh, -size / 2, -size / 2, size, size);
    ctx.restore();
  }
}

/** Convert a server-side SavedMapDef into the MapPreviewData shape the
 *  encounter builder consumes. */
function savedMapToPreview(saved: SavedMapDef): MapPreviewData {
  const terrainData: number[] = [];
  for (const row of saved.gidGrid) terrainData.push(...row);
  const objectData: number[] = [];
  if (saved.objectGidGrid) {
    for (const row of saved.objectGidGrid) objectData.push(...row);
  } else {
    for (let i = 0; i < terrainData.length; i++) objectData.push(0);
  }
  return {
    mapId: saved.id,
    width: saved.cols,
    height: saved.rows,
    terrainData,
    objectData,
    name: saved.name,
    description: saved.mapdescription,
    tilesets: saved.tilesets.map((t) => ({
      firstgid: t.firstgid,
      source: `../tilesets/${(t.imageUrl.split("/").pop() ?? "").replace(/\.png$/i, ".tsj")}`,
    })),
    // Author-time named regions ride along untouched so an editor round-trip
    // (LOAD MAP → tweak → SAVE MAP) preserves them.
    zones: saved.zones ? saved.zones.map((z) => ({ id: z.id, name: z.name, color: z.color, cells: [...z.cells] })) : undefined,
  };
}

function pickTilesetKey(scene: Phaser.Scene): string {
  const maps = (scene.registry.get("maps") as SavedMapDef[] | undefined) ?? [];
  for (const m of maps) {
    const url = m.tilesets?.[0]?.imageUrl;
    if (url) return tilesetTextureKey(url);
  }
  return tilesetTextureKey("/tilesets/scribble.png");
}
