import Phaser from "phaser";
import type { EncounterDef, SavedMapDef } from "../../../../shared/types";
import { decodeTileGid } from "../../../../shared/tileGid";

/**
 * Modal overlay listing every encounter in the registry as clickable cards.
 * Used by the `EncounterCreatorScene` OPEN ENCOUNTER button.
 *
 * Pure HTML implementation: a single full-page `<div>` overlay laid out with
 * CSS grid, no Phaser game objects. Tile thumbnails are drawn into per-card
 * `<canvas>` elements using the same Phaser-loaded spritesheet textures
 * (read via `scene.textures.get(...).getSourceImage()`) the in-scene
 * renderer uses, so the tile art matches the editor's preview exactly.
 *
 * Styling follows the project palette used by EncounterSetupScene /
 * AdventureSetupScene / ConfigurationScene: `#0d0d1e` panel background,
 * `#88ccaa` editor accent, `#e2b96f` card titles, `#334455` dividers,
 * monospace by default with `sans-serif` for prose descriptions.
 */
const COLOR_BG_BACKDROP   = "rgba(0,0,0,0.75)";
const COLOR_PANEL         = "#141426";
const COLOR_PANEL_BORDER  = "#88ccaa";
const COLOR_CARD_HOVER    = "#23233a";
const COLOR_CARD_BORDER   = "#334455";
const COLOR_SUBLABEL      = "#88ccaa";
const COLOR_TEXT          = "#aabbcc";
const COLOR_TEXT_DIM      = "#667788";
const COLOR_ERR           = "#883333";

const CARD_THUMB_MAX_PX   = 6;

interface PickerCallbacks {
  onSelect: (encounter: EncounterDef) => void;
  onClose: () => void;
}

export class EncounterPickerOverlay {
  private readonly mapsById: Map<string, SavedMapDef>;
  private root: HTMLDivElement | null = null;
  private onKeyDown: ((e: KeyboardEvent) => void) | null = null;

  constructor(
    _scene: Phaser.Scene,
    encounters: EncounterDef[],
    maps: SavedMapDef[],
    callbacks: PickerCallbacks,
  ) {
    this.mapsById = new Map(maps.map((m) => [m.id, m]));
    this.buildOverlay(encounters, callbacks);
  }

  destroy(): void {
    if (this.onKeyDown) {
      window.removeEventListener("keydown", this.onKeyDown);
      this.onKeyDown = null;
    }
    this.root?.remove();
    this.root = null;
  }

  private buildOverlay(encounters: EncounterDef[], cb: PickerCallbacks): void {
    const root = document.createElement("div");
    root.style.cssText = `
      position: fixed; inset: 0;
      z-index: 1000;
      background: ${COLOR_BG_BACKDROP};
      display: flex; align-items: center; justify-content: center;
      font-family: monospace;
    `;
    this.root = root;

    // Swallow clicks on the backdrop so they don't reach the Phaser canvas
    // underneath; explicit CLOSE button handles dismissal.
    root.addEventListener("click", (ev) => {
      if (ev.target === root) ev.stopPropagation();
    });

    // Escape closes the picker — matches the keyboard convention other
    // overlays in the project use.
    this.onKeyDown = (e) => { if (e.key === "Escape") cb.onClose(); };
    window.addEventListener("keydown", this.onKeyDown);

    // ── Panel — full screen ────────────────────────────────────────────
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
    headerTag.textContent = "OPEN ENCOUNTER";
    headerTag.style.cssText = `
      font-size: 11px; color: ${COLOR_SUBLABEL};
      letter-spacing: 2px; margin-bottom: 8px;
    `;
    const sub = document.createElement("div");
    sub.textContent = `${encounters.length} saved encounter${encounters.length === 1 ? "" : "s"}`;
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

    if (encounters.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No saved encounters yet.";
      empty.style.cssText = `
        font-size: 13px; color: ${COLOR_TEXT_DIM};
        text-align: center; padding: 80px 0;
      `;
      body.appendChild(empty);
    } else {
      const grid = document.createElement("div");
      grid.style.cssText = `
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(336px, 1fr));
        gap: 12px;
      `;
      for (const enc of encounters) {
        grid.appendChild(this.buildCard(enc, cb.onSelect));
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

  /**
   * Card laid out to match the Encounter Setup selector: a small gid-coloured
   * minimap silhouette on the left, then a column of title, map tag, a chip
   * row (enemies / environment), and a 2-line description.
   */
  private buildCard(encounter: EncounterDef, onSelect: (encounter: EncounterDef) => void): HTMLDivElement {
    const card = document.createElement("div");
    card.style.cssText = `
      background: #111122;
      border: 1px solid ${COLOR_CARD_BORDER};
      position: relative; display: flex; gap: 8px;
      box-sizing: border-box; padding: 8px 10px;
      min-height: 116px;
      cursor: pointer;
      transition: border-color 0.1s, background 0.1s;
      font-family: monospace; color: ${COLOR_TEXT};
    `;
    card.addEventListener("mouseenter", () => {
      card.style.borderColor = COLOR_PANEL_BORDER;
      card.style.background = COLOR_CARD_HOVER;
    });
    card.addEventListener("mouseleave", () => {
      card.style.borderColor = COLOR_CARD_BORDER;
      card.style.background = "#111122";
    });
    card.addEventListener("click", () => onSelect(encounter));

    // Minimap thumbnail (left) — a cheap gid-coloured silhouette of the map.
    const mini = this.buildMinimap(encounter.mapId, 60, 60);
    if (mini) {
      card.appendChild(mini);
    } else {
      const stub = document.createElement("div");
      stub.textContent = "(map?)";
      stub.style.cssText = `width:60px;height:60px;flex-shrink:0;display:flex;align-items:center;justify-content:center;border:1px solid #2a3a4a;background:#0a0a14;font-size:8px;color:${COLOR_ERR};`;
      card.appendChild(stub);
    }

    const col = document.createElement("div");
    col.style.cssText = "flex: 1; display: flex; flex-direction: column; min-width: 0;";
    card.appendChild(col);

    const title = document.createElement("div");
    title.textContent = encounter.encounterTitle;
    title.style.cssText = "font-size: 13px; color: #e8e8f8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;";
    col.appendChild(title);

    const mapTag = document.createElement("div");
    mapTag.textContent = encounter.mapId.toUpperCase();
    mapTag.style.cssText = "font-size: 8px; color: #445566; letter-spacing: 1px;";
    col.appendChild(mapTag);

    // Chip row: enemies + environment (character-independent — the creator
    // context has no selected player, so no difficulty / outcome chips).
    const chipRow = document.createElement("div");
    chipRow.style.cssText = "display: flex; flex-wrap: wrap; gap: 3px; margin-top: 5px;";
    for (const c of encounterChips(encounter)) {
      const chip = document.createElement("span");
      chip.textContent = c.label;
      if (c.title) chip.title = c.title;
      chip.style.cssText = `background:${c.bg};color:${c.color};border:1px solid ${c.border};padding:0 5px;font-size:8.5px;line-height:1.55;white-space:nowrap;`;
      chipRow.appendChild(chip);
    }
    col.appendChild(chipRow);

    if (encounter.description) {
      const desc = document.createElement("div");
      desc.textContent = encounter.description;
      desc.style.cssText = "margin-top: 5px; font-size: 9.5px; color: #8899aa; line-height: 1.45; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;";
      col.appendChild(desc);
    }

    if (encounter.generated) {
      const tag = document.createElement("div");
      tag.textContent = "✦";
      tag.title = "AI-generated encounter";
      tag.style.cssText = `position: absolute; right: 8px; top: 6px; font-size: 12px; color: ${COLOR_SUBLABEL};`;
      card.appendChild(tag);
    }

    return card;
  }

  /** A cheap gid-coloured minimap: one pixel per tile, scaled up with nearest-
   *  neighbour. Mirrors `EncounterSetupScene.buildMinimap` so the picker and the
   *  setup selector render identical silhouettes. Returns null when the map
   *  isn't loaded. */
  private buildMinimap(mapId: string, w: number, h: number): HTMLCanvasElement | null {
    const map = this.mapsById.get(mapId);
    if (!map || !map.gidGrid?.length) return null;
    const canvas = document.createElement("canvas");
    canvas.width = map.cols;
    canvas.height = map.rows;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const paint = (grid: number[][] | undefined): void => {
      if (!grid) return;
      for (let y = 0; y < grid.length; y++) {
        const row = grid[y];
        for (let x = 0; x < row.length; x++) {
          const gid = decodeTileGid(row[x] ?? 0).gid;
          if (!gid) continue;
          ctx.fillStyle = `hsl(${(gid * 47) % 360},28%,${28 + (gid % 5) * 6}%)`;
          ctx.fillRect(x, y, 1, 1);
        }
      }
    };
    paint(map.gidGrid);
    paint(map.objectGidGrid);
    canvas.style.cssText = `width:${w}px;height:${h}px;flex-shrink:0;image-rendering:pixelated;border:1px solid #2a3a4a;background:#0a0a14;`;
    return canvas;
  }
}

/** Character-independent encounter chips (enemy count + environment), matching
 *  the style of `EncounterSetupScene.encounterChips`. The creator has no
 *  selected character or monster roster, so difficulty / outcome / named-enemy
 *  chips are omitted. */
function encounterChips(def: EncounterDef): Array<{ label: string; color: string; bg: string; border: string; title?: string }> {
  const out: Array<{ label: string; color: string; bg: string; border: string; title?: string }> = [];
  const enemies = def.enemyIds ?? [];
  if (enemies.length > 0) {
    out.push({ label: `⚔ ${enemies.length} ${enemies.length > 1 ? "enemies" : "enemy"}`, color: "#d8a0a0", bg: "#2a1818", border: "#4a2a2a" });
  }
  const env = (def.environment ?? {}) as Record<string, unknown>;
  if (env.sunlit) out.push({ label: "☀ sunlit", color: "#d8c88a", bg: "#26240f", border: "#4a4520" });
  return out;
}
