import type Phaser from "phaser";
import { attachPlacement } from "../sceneInputs";

/**
 * StructureList — the DETERMINISTIC-tab editor for outdoor STRUCTURES. The user
 * adds structures and configures each one's type (building / ruin / tavern, plus
 * the fixed-size set-pieces) and, for the room-based kinds, the number of
 * connected rooms (1..5). Replaces the old fixed SMALL BUILDINGS / SMALL RUINS
 * counter chips.
 *
 * Self-contained raw-DOM list inside one canvas-tracked container (mirrors the
 * scrollable HTML lists used by the trigger / monster editors), so adding and
 * removing rows never touches the scene's element buckets.
 */
/** Any placeable structure id (the merged structures + set-pieces catalog). */
export type PlaceableType = "building" | "ruin" | "watchtower" | "cemetery" | "town_square" | "tavern" | "shrine" | "farmstead" | "mine" | "bandit_hideout" | "bridge";

export interface StructureSpec {
  type: PlaceableType;
  rooms: number;
  /** Big-map only: index into the region list the structure must be placed in. */
  region?: number;
}

/** Catalog order + display labels. `building` / `ruin` / `tavern` take a room count. */
const PLACEABLE_TYPES: PlaceableType[] = ["building", "ruin", "tavern", "watchtower", "cemetery", "town_square", "shrine", "farmstead", "mine", "bandit_hideout", "bridge"];
const PLACEABLE_LABEL: Record<PlaceableType, string> = {
  building: "BUILDING", ruin: "RUIN", tavern: "TAVERN",
  watchtower: "WATCHTOWER", cemetery: "CEMETERY", town_square: "TOWN SQUARE",
  shrine: "SHRINE", farmstead: "FARMSTEAD", mine: "MINE", bandit_hideout: "BANDIT HIDEOUT", bridge: "BRIDGE",
};
/** Which placeable kinds carry a configurable room count (1..5). */
export const TAKES_ROOMS = (t: PlaceableType): boolean => t === "building" || t === "ruin" || t === "tavern";

const MAX_ROOMS = 5;
const MAX_STRUCTURES = 8;

export interface StructureListContext {
  scene: Phaser.Scene;
  sceneWidth: number;
  /** Read the current structures (the scene owns the array). */
  get: () => StructureSpec[];
  /** Persist an edited structures array (scene updates state + buttons). */
  set: (next: StructureSpec[]) => void;
  /** Region band names for the current BIG MAP (≥2 → a per-structure region
   *  selector appears). Empty / <2 = no region targeting. */
  getRegions?: () => string[];
}

export interface StructureListHandle {
  setVisible(visible: boolean): void;
  dispose(): void;
}

export class StructureList {
  private container: HTMLDivElement | null = null;
  private placement: { setVisible(v: boolean): void; dispose(): void } | null = null;
  private tabVisible = true;
  /** Whether structures apply to the current terrain (outdoor only). */
  private applicable = true;

  constructor(private readonly ctx: StructureListContext) {}

  build(x: number, y: number, w: number, h: number): StructureListHandle {
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

  /** Toggle whether the editor applies to the selected terrain (outdoor only).
   *  When not applicable it greys out with a hint instead of vanishing. */
  setApplicable(applicable: boolean): void {
    if (this.applicable === applicable) return;
    this.applicable = applicable;
    this.render();
  }

  private updateDisplay(): void {
    if (this.container) this.container.style.display = this.tabVisible ? "" : "none";
  }

  private render(): void {
    const div = this.container;
    if (!div) return;
    div.innerHTML = "";

    if (!this.applicable) {
      div.appendChild(hint("Structures apply to Grassland / Forest / Town terrain or a big map."));
      return;
    }

    const add = button("+ ADD STRUCTURE", "accent");
    add.style.width = "100%";
    add.style.marginBottom = "6px";
    add.onclick = () => {
      const list = [...this.ctx.get()];
      if (list.length >= MAX_STRUCTURES) return;
      list.push({ type: "building", rooms: 1 });
      this.commit(list);
    };
    div.appendChild(add);

    const list = this.ctx.get();
    if (list.length === 0) {
      div.appendChild(hint("No structures yet."));
      return;
    }
    list.forEach((spec, i) => div.appendChild(this.row(spec, i)));
  }

  private row(spec: StructureSpec, i: number): HTMLDivElement {
    const row = document.createElement("div");
    row.style.cssText = "display:flex; gap:4px; align-items:center; margin:4px 0;";

    // Type cycles through the whole placeable catalog (buildings + set-pieces).
    const typeBtn = button(PLACEABLE_LABEL[spec.type], spec.type === "ruin" ? "ruin" : "building");
    typeBtn.style.flex = "1 1 auto";
    typeBtn.title = "Cycle structure type";
    typeBtn.onclick = () => {
      const list = [...this.ctx.get()];
      const next = PLACEABLE_TYPES[(PLACEABLE_TYPES.indexOf(list[i].type) + 1) % PLACEABLE_TYPES.length];
      list[i] = { ...list[i], type: next };
      this.commit(list);
    };

    const del = button("✕", "danger");
    del.title = "Remove structure";
    del.onclick = () => {
      const list = [...this.ctx.get()];
      list.splice(i, 1);
      this.commit(list);
    };

    // Room stepper only for building / ruin; set-pieces are fixed-size.
    if (TAKES_ROOMS(spec.type)) {
      const minus = button("−", "step");
      minus.onclick = () => this.bumpRooms(i, -1);
      const count = document.createElement("span");
      count.textContent = `${spec.rooms} ${spec.rooms === 1 ? "room" : "rooms"}`;
      count.style.cssText = "color:#ccd6e0; font-family:monospace; font-size:10px; min-width:48px; text-align:center;";
      const plus = button("+", "step");
      plus.onclick = () => this.bumpRooms(i, +1);
      row.append(typeBtn, minus, count, plus, del);
    } else {
      row.append(typeBtn, del);
    }

    // Big-map region targeting: a per-structure region dropdown ("Any" + bands).
    const regions = this.ctx.getRegions?.() ?? [];
    if (regions.length >= 2) {
      const sel = document.createElement("select");
      sel.style.cssText = "background:#1a1a2a; color:#aabbcc; border:1px solid #445566; border-radius:3px; font-size:10px; padding:2px;";
      sel.title = "Place this structure in a specific region";
      const any = document.createElement("option"); any.value = "-1"; any.textContent = "Any region"; sel.append(any);
      regions.forEach((name, ri) => { const o = document.createElement("option"); o.value = String(ri); o.textContent = name; sel.append(o); });
      sel.value = String(spec.region ?? -1);
      sel.onchange = () => {
        const list = [...this.ctx.get()];
        const v = parseInt(sel.value, 10);
        list[i] = { ...list[i], region: v < 0 ? undefined : v };
        this.commit(list);
      };
      const regionRow = document.createElement("div");
      regionRow.style.cssText = "display:flex; gap:4px; align-items:center; margin:0 0 6px 0;";
      const lbl = document.createElement("span");
      lbl.textContent = "in:"; lbl.style.cssText = "color:#778899; font-size:10px;";
      regionRow.append(lbl, sel);
      const wrap = document.createElement("div");
      wrap.append(row, regionRow);
      return wrap as HTMLDivElement;
    }
    return row;
  }

  private bumpRooms(i: number, delta: number): void {
    const list = [...this.ctx.get()];
    list[i] = { ...list[i], rooms: Math.max(1, Math.min(MAX_ROOMS, list[i].rooms + delta)) };
    this.commit(list);
  }

  private commit(list: StructureSpec[]): void {
    this.ctx.set(list);
    this.render();
  }
}

// ── tiny DOM helpers ──────────────────────────────────────────────────────────

type BtnKind = "accent" | "building" | "ruin" | "step" | "danger";

function button(label: string, kind: BtnKind): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  const palette: Record<BtnKind, [string, string, string]> = {
    accent:   ["#0d2a3a", "#7aadcc", "#7aadcc"],
    building: ["#241f33", "#b59cff", "#8866cc"],
    ruin:     ["#241f1a", "#cbb08a", "#776655"],
    step:     ["#1a1a2a", "#aabbcc", "#445566"],
    danger:   ["#2a1416", "#dd8888", "#883333"],
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
  d.style.cssText = "color:#667788; font-family:sans-serif; font-size:10px; padding:8px 2px; text-align:center;";
  return d;
}
