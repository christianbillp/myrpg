import type Phaser from "phaser";

/**
 * Shared DOM input helpers used by author scenes (NpcCreator, TokenCreator,
 * AdventureCreator, MapEditor, EncounterCreator).
 *
 * Each scene previously rolled its own `buildLineInput` / `buildTextarea` /
 * `attachPlacement` — bodies were near-identical, styling was duplicated, and
 * resize listeners leaked because most scenes only removed the element on
 * teardown without detaching the resize callback. Consolidating here gives a
 * single source of truth for the form-input look, and `dispose()` now
 * detaches the resize listener too.
 *
 * Every helper returns a `DomInputHandle<T>`:
 *   • `el`         — the underlying HTMLElement (typed)
 *   • `setVisible` — toggles display:none, matching the `ChromeHandle` shape
 *     each author scene uses to bulk-hide/show its UI between view modes.
 *   • `dispose`    — removes the element AND detaches the resize listener.
 *
 * The form variant (default) renders at 12–13px on a #141426 / #445566
 * background with monospace font — the same look the scenes already shipped.
 * `scaleFont: true` makes the font-size track canvas scale (used by
 * MapEditor + EncounterCreator where text needs to stay crisp at high zoom).
 */

export interface DomInputHandle<T extends HTMLElement> {
  el: T;
  setVisible: (visible: boolean) => void;
  dispose: () => void;
}

interface PlacementBase {
  scene: Phaser.Scene;
  sceneWidth: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LineInputOptions extends PlacementBase {
  placeholder?: string;
  initialValue?: string;
  fontSize?: number;
  scaleFont?: boolean;
  onInput?: (value: string) => void;
}

export interface TextareaOptions extends PlacementBase {
  placeholder?: string;
  initialValue?: string;
  fontSize?: number;
  lineHeight?: number;
  scaleFont?: boolean;
  onInput?: (value: string) => void;
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectOptions extends PlacementBase {
  options: SelectOption[];
  initialValue?: string;
  fontSize?: number;
  scaleFont?: boolean;
  onChange?: (value: string) => void;
}

const FORM_BG = "#141426";
const FORM_FG = "#e0e8f0";
const FORM_BORDER = "#445566";

export function buildLineInput(opts: LineInputOptions): DomInputHandle<HTMLInputElement> {
  const fontSize = opts.fontSize ?? 12;
  const el = document.createElement("input");
  el.type = "text";
  if (opts.placeholder) el.placeholder = opts.placeholder;
  if (opts.initialValue) el.value = opts.initialValue;
  el.style.cssText = `
    position: absolute;
    background: ${FORM_BG}; color: ${FORM_FG};
    border: 1px solid ${FORM_BORDER};
    padding: 0 10px;
    font-family: monospace; font-size: ${fontSize}px;
    z-index: 10; box-sizing: border-box;
  `;
  document.body.appendChild(el);
  if (opts.onInput) {
    const cb = opts.onInput;
    el.oninput = () => cb(el.value);
  }
  return attachPlacement(el, opts, fontSize);
}

export function buildTextarea(opts: TextareaOptions): DomInputHandle<HTMLTextAreaElement> {
  const fontSize = opts.fontSize ?? 12;
  const lineHeight = opts.lineHeight ?? 1.45;
  const el = document.createElement("textarea");
  if (opts.placeholder) el.placeholder = opts.placeholder;
  if (opts.initialValue) el.value = opts.initialValue;
  el.style.cssText = `
    position: absolute;
    background: ${FORM_BG}; color: ${FORM_FG};
    border: 1px solid ${FORM_BORDER};
    padding: 8px 10px;
    font-family: monospace; font-size: ${fontSize}px; line-height: ${lineHeight};
    resize: none; z-index: 10; box-sizing: border-box;
  `;
  document.body.appendChild(el);
  if (opts.onInput) {
    const cb = opts.onInput;
    el.oninput = () => cb(el.value);
  }
  return attachPlacement(el, opts, fontSize);
}

export function buildSelect(opts: SelectOptions): DomInputHandle<HTMLSelectElement> {
  const fontSize = opts.fontSize ?? 12;
  const el = document.createElement("select");
  el.style.cssText = `
    position: absolute;
    background: ${FORM_BG}; color: ${FORM_FG};
    border: 1px solid ${FORM_BORDER};
    padding: 0 10px;
    font-family: monospace; font-size: ${fontSize}px;
    z-index: 10; box-sizing: border-box;
    cursor: pointer;
  `;
  for (const o of opts.options) {
    const optEl = document.createElement("option");
    optEl.value = o.value;
    optEl.textContent = o.label;
    el.appendChild(optEl);
  }
  if (opts.initialValue !== undefined) el.value = opts.initialValue;
  document.body.appendChild(el);
  if (opts.onChange) {
    const cb = opts.onChange;
    el.onchange = () => cb(el.value);
  }
  return attachPlacement(el, opts, fontSize);
}

/** Bare placement helper — for elements created elsewhere (e.g. a custom div
 *  holding a chapter list) that still need canvas-tracked positioning. */
export function attachPlacement<T extends HTMLElement>(
  el: T,
  opts: PlacementBase & { scaleFont?: boolean },
  baseFontPx?: number,
): DomInputHandle<T> {
  const { scene, sceneWidth, x, y, w, h } = opts;
  const canvas = scene.sys.game.canvas;
  const place = (): void => {
    const rect = canvas.getBoundingClientRect();
    const s = rect.width / sceneWidth;
    el.style.left = `${rect.left + x * s}px`;
    el.style.top = `${rect.top + y * s}px`;
    el.style.width = `${w * s}px`;
    el.style.height = `${h * s}px`;
    if (opts.scaleFont && baseFontPx !== undefined) {
      el.style.fontSize = `${baseFontPx * s}px`;
    }
  };
  place();
  scene.scale.on("resize", place);
  return {
    el,
    setVisible: (v) => { el.style.display = v ? "" : "none"; },
    dispose: () => {
      scene.scale.off("resize", place);
      el.remove();
    },
  };
}
