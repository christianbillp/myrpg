/**
 * Small factory for absolutely-positioned HTML `<button>` elements scaled to
 * match Phaser scene coordinates. Used by the encounter generator + editor
 * UI so buttons stay crisp at any zoom level instead of going blurry through
 * Phaser's canvas text rendering.
 *
 * Pattern mirrors `GenerateSetupScene.buildTextarea` — the element is parented
 * to `document.body` and a `resize` listener keeps its CSS position in sync
 * with the game canvas's bounding rect.
 */
import Phaser from "phaser";

export type HtmlButtonVariant = "primary" | "secondary" | "danger" | "warn" | "ghost";

export interface HtmlButtonOptions {
  scene: Phaser.Scene;
  /** Scene-space X for the button's top-left corner. */
  x: number;
  /** Scene-space Y for the button's top-left corner. */
  y: number;
  /** Scene-space width. */
  w: number;
  /** Scene-space height. */
  h: number;
  /** Scene's logical width (used to compute the canvas-to-scene scale factor). */
  sceneWidth: number;
  /** Button label text. */
  label: string;
  /** Visual variant — drives bg/border/text colour. Defaults to `secondary`. */
  variant?: HtmlButtonVariant;
  /** Click handler. */
  onClick: () => void;
  /** Font size in scene px. Defaults to 13. */
  fontSize?: number;
  /** Optional tooltip via the `title` attribute. */
  tooltip?: string;
}

/** Pre-computed style block per variant — keeps the call sites tidy. */
const VARIANT_STYLES: Record<HtmlButtonVariant, { bg: string; border: string; color: string; hoverBg: string }> = {
  primary:   { bg: "#1a3a2a", border: "#2a6655", color: "#ffe9a8", hoverBg: "#225a3a" },
  secondary: { bg: "#1a2a3a", border: "#345566", color: "#c8d8e8", hoverBg: "#243a4f" },
  danger:    { bg: "#3a1a1a", border: "#aa3333", color: "#ffd6d6", hoverBg: "#5a2222" },
  warn:      { bg: "#3a2a1a", border: "#aa7733", color: "#ffd699", hoverBg: "#5a4022" },
  ghost:     { bg: "#222233", border: "#556677", color: "#aabbcc", hoverBg: "#2c2f44" },
};

export interface HtmlButtonHandle {
  el: HTMLButtonElement;
  /** Update the label without rebuilding. */
  setLabel(label: string): void;
  /** Re-style the button as `active` (brighter) or restore default. */
  setActive(active: boolean): void;
  /** Disable + grey the button; click handler is suppressed while disabled. */
  setDisabled(disabled: boolean): void;
  /** Replace the click handler. */
  setOnClick(handler: () => void): void;
  /** Move/resize without rebuilding. */
  setBounds(x: number, y: number, w: number, h: number): void;
  /** Show/hide without destroying. */
  setVisible(visible: boolean): void;
  /** Remove from the DOM + detach scale listener. */
  dispose(): void;
}

/**
 * Build a styled HTML button positioned in scene coordinates. Returns a
 * handle the caller uses to mutate / dispose the element. The caller MUST
 * call `dispose()` on scene shutdown to avoid orphaned DOM nodes.
 */
// ── HTML text labels ───────────────────────────────────────────────────────

export interface HtmlTextOptions {
  scene: Phaser.Scene;
  x: number;
  y: number;
  /** Width of the text box in scene px. Used for wrapping + alignment. */
  w: number;
  /** Optional fixed height; defaults to auto-height. */
  h?: number;
  sceneWidth: number;
  text: string;
  /** Font size in scene px. Defaults to 13. */
  fontSize?: number;
  color?: string;
  fontFamily?: string;
  fontWeight?: "normal" | "bold";
  letterSpacing?: number;
  align?: "left" | "center" | "right";
}

export interface HtmlTextHandle {
  el: HTMLDivElement;
  setText(text: string): void;
  setColor(color: string): void;
  setVisible(visible: boolean): void;
  setBounds(x: number, y: number, w: number, h?: number): void;
  dispose(): void;
}

/**
 * Build a styled HTML text element positioned in scene coordinates. Used in
 * place of Phaser `add.text()` for titles, labels, captions, and status
 * lines so text stays crisp at non-integer canvas scale factors instead of
 * going blurry through Phaser's canvas-text rendering.
 */
export function createHtmlText(opts: HtmlTextOptions): HtmlTextHandle {
  const { scene, sceneWidth } = opts;
  let { x, y, w } = opts;
  let h = opts.h;
  const fontSize = opts.fontSize ?? 13;
  const fontFamily = opts.fontFamily ?? "monospace";

  const el = document.createElement("div");
  el.textContent = opts.text;
  el.style.cssText = `
    position: absolute;
    color: ${opts.color ?? "#aabbcc"};
    font-family: ${fontFamily};
    font-size: ${fontSize}px;
    font-weight: ${opts.fontWeight ?? "normal"};
    letter-spacing: ${opts.letterSpacing ?? 0}px;
    text-align: ${opts.align ?? "left"};
    line-height: 1.25;
    z-index: 9;
    pointer-events: none;
    user-select: none;
    box-sizing: border-box;
    white-space: pre-wrap;
    word-wrap: break-word;
  `;
  document.body.appendChild(el);

  const place = (): void => {
    const rect = scene.sys.game.canvas.getBoundingClientRect();
    const s = rect.width / sceneWidth;
    el.style.left = `${rect.left + x * s}px`;
    el.style.top  = `${rect.top  + y * s}px`;
    el.style.width  = `${w * s}px`;
    if (h !== undefined) el.style.height = `${h * s}px`;
    el.style.fontSize = `${fontSize * s}px`;
    el.style.letterSpacing = `${(opts.letterSpacing ?? 0) * s}px`;
  };
  place();
  scene.scale.on("resize", place);

  return {
    el,
    setText(text) { el.textContent = text; },
    setColor(color) { el.style.color = color; },
    setVisible(visible) { el.style.display = visible ? "" : "none"; },
    setBounds(nx, ny, nw, nh) { x = nx; y = ny; w = nw; if (nh !== undefined) h = nh; place(); },
    dispose() {
      scene.scale.off("resize", place);
      el.remove();
    },
  };
}

export function createHtmlButton(opts: HtmlButtonOptions): HtmlButtonHandle {
  const { scene, sceneWidth, onClick: initialClick } = opts;
  let { x, y, w, h } = opts;
  const variant = opts.variant ?? "secondary";
  const fontSize = opts.fontSize ?? 13;

  const el = document.createElement("button");
  el.type = "button";
  el.textContent = opts.label;
  if (opts.tooltip) el.title = opts.tooltip;
  const variantStyle = VARIANT_STYLES[variant];
  el.style.cssText = `
    position: absolute;
    background: ${variantStyle.bg};
    color: ${variantStyle.color};
    border: 2px solid ${variantStyle.border};
    padding: 0 10px;
    font-family: monospace;
    font-size: ${fontSize}px;
    letter-spacing: 1px;
    cursor: pointer;
    z-index: 10;
    box-sizing: border-box;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    user-select: none;
    transition: background 0.08s ease-out;
  `;
  document.body.appendChild(el);

  let active = false;
  let disabled = false;
  let visible = true;
  let click = initialClick;

  const applyVariantStyle = (): void => {
    if (disabled) {
      el.style.background = "#1a2222";
      el.style.borderColor = "#334455";
      el.style.color = "#556677";
      el.style.cursor = "not-allowed";
      return;
    }
    const s = VARIANT_STYLES[variant];
    el.style.background = active ? s.hoverBg : s.bg;
    el.style.borderColor = s.border;
    el.style.color = s.color;
    el.style.cursor = "pointer";
  };

  el.addEventListener("mouseenter", () => {
    if (disabled || active) return;
    el.style.background = VARIANT_STYLES[variant].hoverBg;
  });
  el.addEventListener("mouseleave", () => {
    if (disabled || active) return;
    el.style.background = VARIANT_STYLES[variant].bg;
  });
  el.addEventListener("click", () => {
    if (disabled) return;
    click();
  });

  const place = (): void => {
    const rect = scene.sys.game.canvas.getBoundingClientRect();
    const s = rect.width / sceneWidth;
    el.style.left = `${rect.left + x * s}px`;
    el.style.top  = `${rect.top  + y * s}px`;
    el.style.width  = `${w * s}px`;
    el.style.height = `${h * s}px`;
    el.style.fontSize = `${fontSize * s}px`;
  };
  place();
  scene.scale.on("resize", place);

  return {
    el,
    setLabel(label) { el.textContent = label; },
    setActive(a) { active = a; applyVariantStyle(); },
    setDisabled(d) { disabled = d; applyVariantStyle(); },
    setOnClick(handler) { click = handler; },
    setBounds(nx, ny, nw, nh) { x = nx; y = ny; w = nw; h = nh; place(); },
    setVisible(v) {
      visible = v;
      el.style.display = visible ? "" : "none";
    },
    dispose() {
      scene.scale.off("resize", place);
      el.remove();
    },
  };
}
