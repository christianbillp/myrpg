import { GRID_ROWS, TILE_SIZE, HUD_HEIGHT } from '../constants';
import { UIScale } from './UIScale';

const GRID_H = GRID_ROWS * TILE_SIZE;

export abstract class BaseOverlay {
  protected readonly panelEl: HTMLDivElement;
  protected readonly panelW: number;
  protected readonly panelH: number;
  private readonly backdropEl: HTMLDivElement;
  private readonly offResize: () => void;

  constructor(
    scale: UIScale,
    panelW: number,
    panelH: number,
    accentColor: string,
    onClose: () => void,
  ) {
    this.panelW = panelW;
    this.panelH = panelH;

    this.backdropEl = document.createElement('div');
    this.backdropEl.className = 'gui-overlay';
    this.backdropEl.addEventListener('pointerdown', (e) => {
      if (e.target === this.backdropEl) this.close();
    });

    this.panelEl = document.createElement('div');
    this.panelEl.className = 'gui-modal';
    this.panelEl.style.cssText += `width:${panelW}px;height:${panelH}px;border:2px solid ${accentColor};`;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'gui-close-btn';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('pointerover', () => closeBtn.style.color = '#aabbcc');
    closeBtn.addEventListener('pointerout',  () => closeBtn.style.color = '#556677');
    closeBtn.addEventListener('pointerdown', () => this.close());

    this.panelEl.appendChild(closeBtn);
    this.backdropEl.appendChild(this.panelEl);
    document.body.appendChild(this.backdropEl);

    const place = () => scale.placeModal(this.panelEl, panelW, panelH, GRID_H);
    place();
    this.offResize = scale.onChange(place);

    this._onClose = onClose;
  }

  private _onClose: () => void;

  protected close(): void {
    this._onClose();
    this.destroy();
  }

  destroy(): void {
    this.offResize();
    this.backdropEl.remove();
  }
}
