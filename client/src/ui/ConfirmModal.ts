/**
 * ConfirmModal — a minimal, self-contained yes/no confirmation dialog. Unlike
 * `BaseOverlay` (which is tied to the in-game HUD's `UIScale`), this is a plain
 * `position: fixed` backdrop + panel sized in natural pixels, so it works in the
 * full-window setup scenes (character selector, etc.).
 *
 * Dismisses on Cancel, backdrop click, or Escape; `onConfirm` fires only on the
 * confirm button. One dialog at a time is assumed — the caller opens it in
 * response to a discrete user action.
 */
export interface ConfirmModalOptions {
  title: string;
  message: string;
  /** Confirm button label. Defaults to "Confirm". */
  confirmLabel?: string;
  /** Cancel button label. Defaults to "Cancel". */
  cancelLabel?: string;
  /** Style the confirm button as a destructive (red) action. */
  danger?: boolean;
  onConfirm: () => void;
}

export function showConfirmModal(opts: ConfirmModalOptions): void {
  const accent = opts.danger ? "#aa3333" : "#2a6655";

  const backdrop = document.createElement("div");
  backdrop.style.cssText = `
    position: fixed; inset: 0; z-index: 200;
    background: rgba(0, 0, 0, 0.62);
    display: flex; align-items: center; justify-content: center;
    font-family: monospace;`;

  const panel = document.createElement("div");
  panel.style.cssText = `
    width: 360px; max-width: 86vw;
    background: #14141f; border: 2px solid ${accent};
    padding: 20px 22px; box-sizing: border-box;
    color: #c8dae8;`;

  const title = document.createElement("div");
  title.textContent = opts.title;
  title.style.cssText = `font-size: 15px; color: ${opts.danger ? "#ffb3b3" : "#ffe9a8"}; letter-spacing: 1px; margin-bottom: 10px;`;
  panel.appendChild(title);

  const body = document.createElement("div");
  body.textContent = opts.message;
  body.style.cssText = "font-size: 12px; color: #a8b8c8; line-height: 1.5; margin-bottom: 18px;";
  panel.appendChild(body);

  const row = document.createElement("div");
  row.style.cssText = "display: flex; gap: 10px; justify-content: flex-end;";

  const close = () => { document.removeEventListener("keydown", onKey); backdrop.remove(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };

  const mkBtn = (label: string, bg: string, border: string, color: string, onClick: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.style.cssText = `background:${bg};border:1px solid ${border};color:${color};font-family:monospace;font-size:12px;padding:7px 16px;cursor:pointer;`;
    b.addEventListener("click", onClick);
    return b;
  };

  row.appendChild(mkBtn(opts.cancelLabel ?? "Cancel", "#1a2a3a", "#345566", "#c8d8e8", close));
  row.appendChild(mkBtn(
    opts.confirmLabel ?? "Confirm",
    opts.danger ? "#3a1a1a" : "#1a3a2a",
    accent,
    opts.danger ? "#ffd6d6" : "#ffe9a8",
    () => { close(); opts.onConfirm(); },
  ));
  panel.appendChild(row);

  backdrop.addEventListener("pointerdown", (e) => { if (e.target === backdrop) close(); });
  document.addEventListener("keydown", onKey);
  backdrop.appendChild(panel);
  document.body.appendChild(backdrop);
}
