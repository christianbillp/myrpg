import { DevMode } from '../devMode';

export class ConnectionLostOverlay {
  private readonly el: HTMLDivElement;

  constructor(onReconnectNow: () => void) {
    this.el = document.createElement('div');
    this.el.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,0.88);
      display:flex;align-items:center;justify-content:center;
      z-index:99999;font-family:monospace;
    `;

    const panel = document.createElement('div');
    panel.style.cssText = `
      background:#0d0d1e;border:2px solid #cc4444;
      padding:36px 52px;text-align:center;min-width:320px;
    `;

    const title = document.createElement('div');
    title.textContent = 'CONNECTION LOST';
    title.style.cssText = `font-size:15px;color:#cc4444;letter-spacing:3px;margin-bottom:16px;`;

    const status = document.createElement('div');
    status.textContent = 'Attempting to reconnect…';
    status.style.cssText = `font-size:11px;color:#445566;letter-spacing:1px;`;

    panel.appendChild(title);
    panel.appendChild(status);

    if (DevMode.enabled) {
      const btn = document.createElement('button');
      btn.textContent = 'RECONNECT NOW';
      btn.className = 'gui-btn-ghost';
      btn.style.cssText += 'display:block;margin:20px auto 0;font-size:11px;padding:6px 18px;';
      btn.addEventListener('pointerdown', () => onReconnectNow());
      panel.appendChild(btn);
    }

    this.el.appendChild(panel);
    document.body.appendChild(this.el);
  }

  destroy(): void {
    this.el.remove();
  }
}
