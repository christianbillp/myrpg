/**
 * RestPromptOverlay — modal shown between adventure chapters when the
 * adventure's `restEncounterId` is set. Asks the player whether they want to
 * play the rest-stop encounter (an inn, campsite, safehouse) before the next
 * chapter starts.
 *
 * Plain DOM — does NOT extend BaseOverlay because it has to be visible while
 * `ScreenEffects` is parked at full-black (z-index 9000) for the chapter
 * transition. Render at z-index 9100 so it floats above the fade backdrop.
 */
const Z_INDEX = 9100;

export interface RestPromptCallbacks {
  /** Player chose to rest first. */
  onRest: () => void;
  /** Player chose to skip rest and go straight to the next chapter. */
  onSkip: () => void;
}

export class RestPromptOverlay {
  private readonly root: HTMLDivElement;

  constructor(restEncounterTitle: string, callbacks: RestPromptCallbacks) {
    const root = document.createElement('div');
    root.style.cssText = `
      position: fixed; inset: 0;
      z-index: ${Z_INDEX};
      background: rgba(0,0,0,0.4);
      display: flex; align-items: center; justify-content: center;
      font-family: monospace;
    `;

    const panel = document.createElement('div');
    panel.style.cssText = `
      width: 460px; max-width: 90vw;
      background: #141426;
      border: 2px solid #e2b96f;
      padding: 28px 32px;
      color: #c8d8e8;
      box-sizing: border-box;
      text-align: center;
    `;

    panel.insertAdjacentHTML('beforeend', `
      <div style="font-size:12px;color:#e2b96f;letter-spacing:2px;margin-bottom:14px;">REST STOP</div>
      <div style="font-size:16px;color:#e8e8f8;margin-bottom:8px;">${escapeHtml(restEncounterTitle)}</div>
      <div style="font-size:12px;color:#8899aa;line-height:1.55;margin-bottom:22px;">
        You have a chance to drop in before the next chapter — talk to the keeper,
        rest your wounds, swap a few rumours. Would you like to visit now?
      </div>
    `);

    const buttonRow = document.createElement('div');
    buttonRow.style.cssText = 'display:flex;gap:12px;justify-content:center;';

    const restBtn = makeBtn('YES — REST FIRST', '#1a3a2a', '#88ccaa', '#aaeec0');
    restBtn.addEventListener('click', () => { this.destroy(); callbacks.onRest(); });

    const skipBtn = makeBtn('SKIP TO NEXT CHAPTER', '#2a2a3a', '#556677', '#aabbcc');
    skipBtn.addEventListener('click', () => { this.destroy(); callbacks.onSkip(); });

    buttonRow.appendChild(restBtn);
    buttonRow.appendChild(skipBtn);
    panel.appendChild(buttonRow);

    root.appendChild(panel);
    document.body.appendChild(root);
    this.root = root;
  }

  destroy(): void {
    this.root.remove();
  }
}

function makeBtn(label: string, bg: string, border: string, color: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  btn.style.cssText = `
    background: ${bg};
    color: ${color};
    border: 1px solid ${border};
    padding: 10px 18px;
    font-family: monospace; font-size: 12px;
    letter-spacing: 1.5px;
    cursor: pointer;
    min-width: 180px;
  `;
  return btn;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
