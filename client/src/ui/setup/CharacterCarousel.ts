/**
 * CharacterCarousel — three-card horizontal selector. The middle card is the
 * currently-selected character and renders larger; the previous + next cards
 * are dimmed on either side. Left / right arrow buttons rotate the carousel
 * with wrap-around semantics; clicking a side card snaps to it.
 *
 * Used by EncounterSetupScene and AdventureSetupScene as the top half of the
 * character column. Pure HTML — single root `<div>` positioned in scene
 * coordinates and zoomed via `transform: scale()` so the child DOM stays in
 * natural pixel sizes regardless of the canvas scale factor.
 */
import Phaser from "phaser";
import type { PlayerDef } from "../../../../shared/types";
import { tokenAssetForPlayer } from "../../data/tokens";

const API_URL = "http://localhost:3000";

const SIDE_CARD_W = 140;
const SIDE_CARD_H = 170;
const CENTER_CARD_W = 200;
const CENTER_CARD_H = 230;
const CARD_GAP = 14;
const ARROW_W = 36;
const ARROW_H = 80;

export interface CharacterCarouselOptions {
  scene: Phaser.Scene;
  sceneWidth: number;
  /** Scene-space rect for the carousel root. The content is fit to the rect
   *  by a uniform `transform: scale()` so children stay at natural sizes. */
  x: number;
  y: number;
  width: number;
  height: number;
  characters: PlayerDef[];
  /** Per-character effective level (source level + accumulated level-ups).
   *  When absent the carousel falls back to `def.level`, which matches the
   *  pre-level-up source JSON and is incorrect for any leveled character. */
  effectiveLevels?: Map<string, number>;
  /** Starting index (clamped to the valid range). Defaults to 0. */
  initialIndex?: number;
  /** Fires every time the selection moves, including the initial microtask
   *  fire so the host can synchronise the detail panel without an extra
   *  `getCurrent` call after construction. */
  onChange: (def: PlayerDef, index: number) => void;
}

export class CharacterCarousel {
  private readonly opts: CharacterCarouselOptions;
  private readonly characters: PlayerDef[];
  private readonly root: HTMLDivElement;
  private readonly cardRow: HTMLDivElement;
  private currentIndex: number;
  private placeHandler!: () => void;

  constructor(opts: CharacterCarouselOptions) {
    this.opts = opts;
    this.characters = opts.characters;
    this.currentIndex = Math.max(0, Math.min(opts.initialIndex ?? 0, Math.max(0, this.characters.length - 1)));

    this.root = document.createElement("div");
    this.root.style.cssText = `
      position: absolute;
      display: flex; align-items: center; justify-content: center;
      gap: ${CARD_GAP}px;
      box-sizing: border-box;
      font-family: monospace;
      z-index: 9;
      transform-origin: 0 0;
    `;
    document.body.appendChild(this.root);

    this.root.appendChild(this.buildArrow("◀", () => this.step(-1)));
    this.cardRow = document.createElement("div");
    this.cardRow.style.cssText = `
      display: flex; align-items: center; justify-content: center;
      gap: ${CARD_GAP}px;
    `;
    this.root.appendChild(this.cardRow);
    this.root.appendChild(this.buildArrow("▶", () => this.step(+1)));

    this.renderCards();
    this.attachPlace();
    // Fire the initial selection on a microtask so the host can wire its
    // callback synchronously in the constructor.
    queueMicrotask(() => {
      if (this.characters.length > 0) opts.onChange(this.characters[this.currentIndex], this.currentIndex);
    });
  }

  /** Move the carousel by a signed delta. Wraps so a single press at either
   *  end brings the user to the opposite side. */
  step(delta: number): void {
    if (this.characters.length === 0) return;
    const n = this.characters.length;
    this.currentIndex = ((this.currentIndex + delta) % n + n) % n;
    this.renderCards();
    this.opts.onChange(this.characters[this.currentIndex], this.currentIndex);
  }

  /** Snap directly to a character by id. No-op when the id is unknown.
   *  Used by host scenes to honour the last-character localStorage hint. */
  setSelectedId(id: string): void {
    const idx = this.characters.findIndex((c) => c.id === id);
    if (idx < 0 || idx === this.currentIndex) return;
    this.currentIndex = idx;
    this.renderCards();
    this.opts.onChange(this.characters[this.currentIndex], this.currentIndex);
  }

  getCurrent(): PlayerDef | null { return this.characters[this.currentIndex] ?? null; }
  getIndex(): number { return this.currentIndex; }

  /** Update one character's effective level and re-render the cards. The
   *  host scene calls this once a per-character server save arrives, so the
   *  carousel's subtitle stays in sync with the detail panel without
   *  rebuilding the carousel. */
  setEffectiveLevel(id: string, level: number): void {
    if (!this.opts.effectiveLevels) this.opts.effectiveLevels = new Map();
    this.opts.effectiveLevels.set(id, level);
    this.renderCards();
  }

  destroy(): void {
    this.opts.scene.scale.off("resize", this.placeHandler);
    this.root.remove();
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private buildArrow(label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.style.cssText = `
      width: ${ARROW_W}px; height: ${ARROW_H}px;
      background: #1a2a3a; color: #c8d8e8;
      border: 2px solid #445566;
      font-family: monospace; font-size: 20px;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: filter 0.08s ease-out;
      box-sizing: border-box;
      flex-shrink: 0;
    `;
    btn.addEventListener("mouseenter", () => { btn.style.filter = "brightness(1.3)"; });
    btn.addEventListener("mouseleave", () => { btn.style.filter = ""; });
    btn.addEventListener("click", onClick);
    return btn;
  }

  /** Render the three visible cards — prev / current / next — with
   *  wrap-around semantics matching the arrow `step` logic. Edge cases:
   *  zero characters → empty; one character → just the centre card;
   *  two characters → prev and next reference the same other character. */
  private renderCards(): void {
    this.cardRow.replaceChildren();
    const n = this.characters.length;
    if (n === 0) return;
    const prev = (this.currentIndex - 1 + n) % n;
    const next = (this.currentIndex + 1) % n;
    if (n === 1) {
      this.cardRow.appendChild(this.buildCard(this.characters[this.currentIndex], "center"));
      return;
    }
    this.cardRow.appendChild(this.buildCard(this.characters[prev], "side-prev"));
    this.cardRow.appendChild(this.buildCard(this.characters[this.currentIndex], "center"));
    this.cardRow.appendChild(this.buildCard(this.characters[next], "side-next"));
  }

  private buildCard(def: PlayerDef, kind: "side-prev" | "center" | "side-next"): HTMLElement {
    const isCenter = kind === "center";
    const w = isCenter ? CENTER_CARD_W : SIDE_CARD_W;
    const h = isCenter ? CENTER_CARD_H : SIDE_CARD_H;
    const colorHex = "#" + def.color.toString(16).padStart(6, "0");

    const card = document.createElement(isCenter ? "div" : "button");
    if (!isCenter) {
      (card as HTMLButtonElement).type = "button";
      // Side cards click to step in the matching direction.
      const direction = kind === "side-prev" ? -1 : +1;
      card.addEventListener("click", () => this.step(direction));
    }
    card.style.cssText = `
      width: ${w}px; height: ${h}px;
      background: ${isCenter ? "#1a1a2e" : "#0e0e1c"};
      border: 2px solid ${isCenter ? colorHex : "#334455"};
      opacity: ${isCenter ? 1 : 0.65};
      display: flex; flex-direction: column;
      align-items: center; justify-content: flex-start;
      padding: 12px 8px 10px;
      box-sizing: border-box;
      cursor: ${isCenter ? "default" : "pointer"};
      flex-shrink: 0;
      transition: opacity 0.1s ease-out;
      color: #aabbcc;
      font-family: monospace;
    `;
    if (!isCenter) {
      card.addEventListener("mouseenter", () => { card.style.opacity = "0.85"; });
      card.addEventListener("mouseleave", () => { card.style.opacity = "0.65"; });
    }

    const avatar = document.createElement("img");
    avatar.src = `${API_URL}${tokenAssetForPlayer(def)}`;
    avatar.alt = def.name;
    const aSize = isCenter ? 60 : 48;
    avatar.style.cssText = `display: block; width: ${aSize}px; height: ${aSize}px;`;
    card.appendChild(avatar);

    const name = document.createElement("div");
    name.textContent = def.name;
    name.style.cssText = `
      margin-top: 8px;
      font-size: ${isCenter ? 14 : 11}px;
      color: ${isCenter ? "#ffffff" : "#c8d8e8"};
      text-align: center;
      line-height: 1.2;
      word-break: break-word;
    `;
    card.appendChild(name);

    const sub = document.createElement("div");
    // Effective level = source JSON level + recorded level-ups. The source
    // JSON sits at L1 for every character; the leveled total comes from the
    // server save (passed in by the host scene). Without this, a L4 wizard
    // shows as "Wizard 1" in the carousel even though the Character Sheet
    // shows L4.
    const effLevel = this.opts.effectiveLevels?.get(def.id) ?? def.level;
    sub.textContent = `${def.speciesName} · ${def.className} ${effLevel}`;
    sub.style.cssText = `
      margin-top: 4px;
      font-size: ${isCenter ? 10 : 9}px;
      color: #8899aa;
      text-align: center;
      line-height: 1.3;
    `;
    card.appendChild(sub);

    if (isCenter && def.shortDescription) {
      const tagline = document.createElement("div");
      tagline.textContent = def.shortDescription;
      tagline.style.cssText = `
        margin-top: 8px;
        font-size: 10px;
        color: #b8c8d8;
        text-align: center;
        line-height: 1.35;
        font-style: italic;
        padding: 0 4px;
      `;
      card.appendChild(tagline);
    }

    if (isCenter) {
      const footer = document.createElement("div");
      footer.textContent = "SELECTED";
      footer.style.cssText = `
        margin-top: auto;
        font-size: 9px;
        color: ${colorHex};
        letter-spacing: 2px;
        text-align: center;
      `;
      card.appendChild(footer);
    }

    return card;
  }

  /** Position + size the root via `transform: scale()`. Children stay at
   *  their natural pixel sizes so we don't have to walk and rescale them on
   *  every resize. */
  private attachPlace(): void {
    const { x, y, width, height, sceneWidth } = this.opts;
    // Natural content size (no scaling). Centered horizontally and vertically
    // inside the scene-space rect via flex on the root.
    const contentW = ARROW_W + CARD_GAP + SIDE_CARD_W + CARD_GAP + CENTER_CARD_W + CARD_GAP + SIDE_CARD_W + CARD_GAP + ARROW_W;
    const contentH = Math.max(CENTER_CARD_H, ARROW_H);
    this.root.style.width  = `${contentW}px`;
    this.root.style.height = `${contentH}px`;

    this.placeHandler = () => {
      const rect = this.opts.scene.sys.game.canvas.getBoundingClientRect();
      const s = rect.width / sceneWidth;
      // Fit the natural-size content into the scene-space rect with a
      // uniform scale that keeps both dimensions inside the rect.
      const scaleX = (width * s) / contentW;
      const scaleY = (height * s) / contentH;
      const k = Math.min(scaleX, scaleY);
      // Center inside the rect.
      const fitW = contentW * k;
      const fitH = contentH * k;
      const left = rect.left + x * s + (width  * s - fitW) / 2;
      const top  = rect.top  + y * s + (height * s - fitH) / 2;
      this.root.style.left = `${left}px`;
      this.root.style.top  = `${top}px`;
      this.root.style.transform = `scale(${k})`;
    };
    this.placeHandler();
    this.opts.scene.scale.on("resize", this.placeHandler);
  }
}
