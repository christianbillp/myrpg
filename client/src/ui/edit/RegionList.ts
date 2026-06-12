import type Phaser from "phaser";
import { attachPlacement } from "../sceneInputs";

/**
 * RegionList — the DETERMINISTIC-tab editor for BIG multi-region maps
 * (US-126). The user adds 2-5 regions in travel order; each row configures
 * the region's biome and ambient light, and a size selector at the top picks
 * the overall map dimensions. While 2+ regions are listed, GENERATE MAP
 * composes via the multi-region composer and the single-terrain / feature /
 * structure controls above are ignored (the list says so).
 *
 * Same self-contained raw-DOM list pattern as `StructureList` — adding and
 * removing rows never touches the scene's element buckets.
 */
export interface RegionRowSpec {
  terrain: "grassland" | "forest" | "urban" | "cave" | "dungeon";
  light?: "bright" | "dim" | "dark";
}

export interface BigMapSize { width: number; height: number; }

const MAX_REGIONS = 5;
const TERRAIN_ORDER: RegionRowSpec["terrain"][] = ["grassland", "forest", "urban", "cave", "dungeon"];
const TERRAIN_DISPLAY: Record<RegionRowSpec["terrain"], string> = {
  grassland: "GRASSLAND", forest: "FOREST", urban: "TOWN", cave: "CAVE", dungeon: "DUNGEON",
};
/** AUTO = let the composer decide (dark for cave/dungeon, unlit otherwise). */
const LIGHT_ORDER: Array<RegionRowSpec["light"] | undefined> = [undefined, "bright", "dim", "dark"];
const SIZES: BigMapSize[] = [
  { width: 48, height: 24 },
  { width: 60, height: 28 },
  { width: 72, height: 32 },
  { width: 96, height: 40 },
];

export interface RegionListContext {
  scene: Phaser.Scene;
  sceneWidth: number;
  /** Read the current regions (the scene owns the array). */
  get: () => RegionRowSpec[];
  /** Persist an edited regions array (scene updates state + buttons). */
  set: (next: RegionRowSpec[]) => void;
  getSize: () => BigMapSize;
  setSize: (next: BigMapSize) => void;
}

export interface RegionListHandle {
  setVisible(visible: boolean): void;
  dispose(): void;
}

export class RegionList {
  private container: HTMLDivElement | null = null;
  private placement: { setVisible(v: boolean): void; dispose(): void } | null = null;
  private tabVisible = true;

  constructor(private readonly ctx: RegionListContext) {}

  build(x: number, y: number, w: number, h: number): RegionListHandle {
    const div = document.createElement("div");
    div.style.cssText = `
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
    document.body.appendChild(div);
    this.container = div;
    this.placement = attachPlacement(div, { scene: this.ctx.scene, sceneWidth: this.ctx.sceneWidth, x, y, w, h });
    this.render();
    return {
      setVisible: (v) => { this.tabVisible = v; this.updateDisplay(); },
      dispose: () => { this.placement?.dispose(); div.remove(); this.container = null; },
    };
  }

  private updateDisplay(): void {
    if (this.container) this.container.style.display = this.tabVisible ? "" : "none";
  }

  private render(): void {
    const div = this.container;
    if (!div) return;
    div.innerHTML = "";

    const list = this.ctx.get();

    const headerRow = document.createElement("div");
    headerRow.style.cssText = "display:flex; gap:4px; margin-bottom:6px;";
    const add = button("+ ADD REGION", "accent");
    add.style.flex = "1 1 auto";
    add.onclick = () => {
      const next = [...this.ctx.get()];
      if (next.length >= MAX_REGIONS) return;
      // Default each new region to the classic journey: grass → forest → cave.
      const defaults: RegionRowSpec["terrain"][] = ["grassland", "forest", "cave", "dungeon", "urban"];
      next.push({ terrain: defaults[next.length] ?? "grassland" });
      this.commit(next);
    };
    headerRow.appendChild(add);
    const size = this.ctx.getSize();
    const sizeBtn = button(`${size.width}×${size.height}`, "step");
    sizeBtn.title = "Cycle map size";
    sizeBtn.onclick = () => {
      const idx = SIZES.findIndex((s) => s.width === size.width && s.height === size.height);
      this.ctx.setSize(SIZES[(idx + 1) % SIZES.length]);
      this.render();
    };
    headerRow.appendChild(sizeBtn);
    div.appendChild(headerRow);

    if (list.length === 0) {
      div.appendChild(hint("Add 2-5 regions (in travel order) to compose one BIG map whose biomes transition into each other — e.g. grassland → forest → cave. Open biomes blend; cave/dungeon regions are carved into rock, entered through a mouth, and dark inside."));
      return;
    }
    if (list.length === 1) {
      div.appendChild(hint("Add at least one more region — a big map needs 2-5."));
    } else {
      div.appendChild(hint("BIG MAP MODE — terrain / features / structures above are ignored."));
    }
    list.forEach((spec, i) => div.appendChild(this.row(spec, i)));
  }

  private row(spec: RegionRowSpec, i: number): HTMLDivElement {
    const row = document.createElement("div");
    row.style.cssText = "display:flex; gap:4px; align-items:center; margin:4px 0;";

    const order = document.createElement("span");
    order.textContent = `${i + 1}.`;
    order.style.cssText = "color:#667788; font-family:monospace; font-size:10px; min-width:14px;";

    const terrainBtn = button(TERRAIN_DISPLAY[spec.terrain], "terrain");
    terrainBtn.style.flex = "1 1 auto";
    terrainBtn.title = "Cycle biome";
    terrainBtn.onclick = () => {
      const list = [...this.ctx.get()];
      const idx = TERRAIN_ORDER.indexOf(list[i].terrain);
      list[i] = { ...list[i], terrain: TERRAIN_ORDER[(idx + 1) % TERRAIN_ORDER.length] };
      this.commit(list);
    };

    const lightBtn = button(spec.light ? spec.light.toUpperCase() : "AUTO ☀", "step");
    lightBtn.style.minWidth = "58px";
    lightBtn.title = "Region light (AUTO: dark for cave/dungeon, ambient otherwise)";
    lightBtn.onclick = () => {
      const list = [...this.ctx.get()];
      const idx = LIGHT_ORDER.indexOf(list[i].light);
      list[i] = { ...list[i], light: LIGHT_ORDER[(idx + 1) % LIGHT_ORDER.length] };
      this.commit(list);
    };

    const del = button("✕", "danger");
    del.title = "Remove region";
    del.onclick = () => {
      const list = [...this.ctx.get()];
      list.splice(i, 1);
      this.commit(list);
    };

    row.append(order, terrainBtn, lightBtn, del);
    return row;
  }

  private commit(list: RegionRowSpec[]): void {
    this.ctx.set(list);
    this.render();
  }
}

// ── tiny DOM helpers (mirrors StructureList's palette) ──────────────────────

type BtnKind = "accent" | "terrain" | "step" | "danger";

function button(label: string, kind: BtnKind): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  const palette: Record<BtnKind, [string, string, string]> = {
    accent:  ["#0d2a3a", "#7aadcc", "#7aadcc"],
    terrain: ["#1a2a1a", "#9ccc8a", "#557755"],
    step:    ["#1a1a2a", "#aabbcc", "#445566"],
    danger:  ["#2a1416", "#dd8888", "#883333"],
  };
  const [bg, fg, border] = palette[kind];
  b.style.cssText = `
    background:${bg}; color:${fg}; border:1px solid ${border};
    font-family:monospace; font-size:10px; letter-spacing:1px;
    padding:4px 6px; cursor:pointer; border-radius:2px;
  `;
  return b;
}

function hint(text: string): HTMLDivElement {
  const d = document.createElement("div");
  d.textContent = text;
  d.style.cssText = "color:#667788; font-family:sans-serif; font-size:10px; padding:6px 2px; text-align:center;";
  return d;
}
