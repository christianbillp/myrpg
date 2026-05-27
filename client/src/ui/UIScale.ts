const STYLE_ID = 'game-ui-css';

export function injectGameUIStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = `
    .gui-panel {
      position: fixed;
      transform-origin: top left;
      font-family: monospace;
      box-sizing: border-box;
      overflow: hidden;
      user-select: none;
    }
    .gui-sep {
      height: 1px;
      background: #334455;
      margin: 0 12px;
      flex-shrink: 0;
    }
    .gui-label {
      font-size: 10px;
      color: #889aaa;
      padding: 4px 12px 2px;
      flex-shrink: 0;
    }
    .gui-hp-track {
      height: 11px;
      margin: 4px 12px;
      background: #222233;
      overflow: hidden;
      flex-shrink: 0;
    }
    .gui-hp-fill { height: 100%; }
    .gui-btn {
      display: block;
      width: calc(100% - 24px);
      margin: 0 12px;
      height: 28px;
      font-family: monospace;
      font-size: 11px;
      color: #ffffff;
      border: 1px solid #556677;
      cursor: pointer;
      text-align: center;
      white-space: nowrap;
      overflow: hidden;
      padding: 0;
    }
    .gui-btn:hover:not(:disabled) { opacity: 0.75; }
    .gui-btn:disabled { opacity: 0.4; cursor: default; }
    .gui-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.75);
      z-index: 100;
    }
    .gui-modal {
      position: absolute;
      background: #0d0d1e;
      box-sizing: border-box;
      font-family: monospace;
      font-size: 11px;
      color: #aabbcc;
      overflow: hidden;
      transform-origin: top left;
    }
    .gui-close-btn {
      position: absolute;
      top: 8px;
      right: 8px;
      width: 26px;
      height: 26px;
      background: none;
      border: none;
      color: #556677;
      font-size: 14px;
      cursor: pointer;
      font-family: monospace;
      z-index: 1;
      padding: 0;
    }
    .gui-close-btn:hover { color: #aabbcc; }

    /* Overlay action buttons — set background, border, color, padding, font-size inline */
    .gui-btn-overlay {
      font-family: monospace;
      cursor: pointer;
    }
    .gui-btn-overlay:hover:not(:disabled) { opacity: 0.8; }
    .gui-btn-overlay:disabled { opacity: 0.4; cursor: default; }

    /* Ghost / dev buttons — dim, unobtrusive */
    .gui-btn-ghost {
      font-family: monospace;
      cursor: pointer;
      background: none;
      border: 1px solid #2a2a3a;
      color: #3a3a55;
      letter-spacing: 1px;
    }
    .gui-btn-ghost:hover { border-color: #445566; color: #556677; }

    /* Allow text selection in log/chat areas */
    .gui-selectable { user-select: text; }

    /* HUD navigation buttons (NEW ENCOUNTER, GAME MASTER) */
    .gui-btn-hud {
      height: 26px;
      padding: 0 10px;
      font-family: monospace;
      font-size: 11px;
      color: #aabbcc;
      border: 1px solid #556677;
      cursor: pointer;
    }
    .gui-btn-hud:hover { opacity: 0.75; }
  `;
  document.head.appendChild(el);
}

export class UIScale {
  readonly canvas: HTMLCanvasElement;
  readonly gameW: number;
  readonly gameH: number;
  private readonly handlers = new Set<() => void>();
  private readonly observer: ResizeObserver;

  constructor(canvas: HTMLCanvasElement, gameW: number, gameH: number) {
    this.canvas = canvas;
    this.gameW = gameW;
    this.gameH = gameH;
    injectGameUIStyles();
    this.observer = new ResizeObserver(() => this.handlers.forEach(h => h()));
    this.observer.observe(canvas);
  }

  get factor(): number {
    return this.canvas.getBoundingClientRect().width / this.gameW;
  }

  get canvasRect(): DOMRect {
    return this.canvas.getBoundingClientRect();
  }

  placePanel(el: HTMLElement, gameX: number, gameY: number): void {
    const rect = this.canvasRect;
    const s = this.factor;
    el.style.left = `${rect.left + gameX * s}px`;
    el.style.top  = `${rect.top  + gameY * s}px`;
    el.style.transform = `scale(${s})`;
  }

  placeModal(el: HTMLElement, panelW: number, panelH: number, gridH: number): void {
    const rect = this.canvasRect;
    const s = this.factor;
    const cx = rect.left + (this.gameW / 2) * s;
    const cy = rect.top  + (gridH / 2) * s;
    el.style.left      = `${cx - (panelW * s) / 2}px`;
    el.style.top       = `${cy - (panelH * s) / 2}px`;
    el.style.transform = `scale(${s})`;
  }

  onChange(handler: () => void): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  destroy(): void {
    this.observer.disconnect();
  }
}
