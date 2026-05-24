import type { StorylogEntry, EncounterRecord } from '../net/types';

const ACCENT = '#e2b96f';

function renderNarrative(text: string): string {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br>');
}

export class StorylogOverlay {
  private readonly backdropEl: HTMLDivElement;
  private readonly panelEl: HTMLDivElement;
  private readonly bodyEl: HTMLDivElement;
  private generateBtn!: HTMLButtonElement;

  constructor(
    characterName: string,
    encounterLog: EncounterRecord[],
    storylog: StorylogEntry[],
    onGenerate: () => Promise<StorylogEntry[]>,
    onRewrite: () => Promise<StorylogEntry[]>,
    onClose: (updated: StorylogEntry[]) => void,
  ) {
    let currentStorylog = [...storylog];

    this.backdropEl = document.createElement('div');
    this.backdropEl.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,0.75);
      display:flex;align-items:center;justify-content:center;z-index:9999;
    `;
    this.backdropEl.addEventListener('pointerdown', (e) => {
      if (e.target === this.backdropEl) this.close(currentStorylog, onClose);
    });

    this.panelEl = document.createElement('div');
    this.panelEl.style.cssText = `
      width:640px;max-height:80vh;background:#0d0d1e;
      border:2px solid ${ACCENT};border-radius:2px;
      display:flex;flex-direction:column;position:relative;
      font-family:monospace;color:#c8d8e8;
    `;

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = `
      position:absolute;top:10px;right:14px;background:none;border:none;
      color:#556677;font-size:16px;cursor:pointer;font-family:monospace;
    `;
    closeBtn.addEventListener('pointerover', () => { closeBtn.style.color = '#aabbcc'; });
    closeBtn.addEventListener('pointerout',  () => { closeBtn.style.color = '#556677'; });
    closeBtn.addEventListener('pointerdown', () => this.close(currentStorylog, onClose));

    const header = document.createElement('div');
    header.style.cssText = `padding:20px 48px 16px 24px;border-bottom:1px solid #223344;flex-shrink:0;`;
    header.innerHTML = `
      <div style="font-size:10px;color:${ACCENT};letter-spacing:2px;margin-bottom:4px;">STORY LOG</div>
      <div style="font-size:18px;color:#e8e8f8;">${characterName}</div>
    `;

    this.bodyEl = document.createElement('div');
    this.bodyEl.style.cssText = `
      flex:1;overflow-y:auto;padding:20px 24px;
      scrollbar-width:thin;scrollbar-color:${ACCENT} transparent;
    `;

    const footer = document.createElement('div');
    footer.style.cssText = `padding:14px 24px;border-top:1px solid #223344;flex-shrink:0;text-align:center;`;

    this.generateBtn = document.createElement('button');
    this.generateBtn.style.cssText = `
      background:#0d1a10;border:1px solid #44aa66;color:#66cc88;
      font-family:monospace;font-size:12px;padding:8px 20px;cursor:pointer;letter-spacing:1px;
    `;
    this.generateBtn.addEventListener('pointerover', () => {
      if (!this.generateBtn.disabled) this.generateBtn.style.background = '#152215';
    });
    this.generateBtn.addEventListener('pointerout', () => {
      if (!this.generateBtn.disabled) this.generateBtn.style.background = '#0d1a10';
    });
    this.generateBtn.addEventListener('pointerdown', async () => {
      if (this.generateBtn.disabled) return;
      this.setGenerating(true);
      try {
        currentStorylog = await onGenerate();
        this.renderEntries(encounterLog, currentStorylog);
        this.setUpToDate();
      } catch {
        this.generateBtn.textContent = 'ERROR — TRY AGAIN';
        this.generateBtn.disabled = false;
      } finally {
        this.setGenerating(false);
      }
    });

    const rewriteBtn = document.createElement('button');
    rewriteBtn.textContent = 'REWRITE ALL';
    rewriteBtn.title = 'Debug: regenerate all entries from scratch';
    rewriteBtn.style.cssText = `
      background:none;border:1px solid #334455;color:#445566;
      font-family:monospace;font-size:10px;padding:4px 10px;cursor:pointer;letter-spacing:1px;
      margin-left:12px;
    `;
    rewriteBtn.addEventListener('pointerover', () => { rewriteBtn.style.color = '#8899aa'; rewriteBtn.style.borderColor = '#556677'; });
    rewriteBtn.addEventListener('pointerout',  () => { rewriteBtn.style.color = '#445566'; rewriteBtn.style.borderColor = '#334455'; });
    rewriteBtn.addEventListener('pointerdown', async () => {
      if (rewriteBtn.disabled) return;
      rewriteBtn.disabled = true;
      rewriteBtn.style.opacity = '0.4';
      this.generateBtn.disabled = true;
      this.generateBtn.textContent = 'REWRITING…';
      this.generateBtn.style.opacity = '0.6';
      try {
        currentStorylog = await onRewrite();
        this.renderEntries(encounterLog, currentStorylog);
        this.setUpToDate();
      } catch {
        this.generateBtn.textContent = 'ERROR';
        this.generateBtn.disabled = false;
        this.generateBtn.style.opacity = '1';
      } finally {
        rewriteBtn.disabled = false;
        rewriteBtn.style.opacity = '1';
        this.setGenerating(false);
      }
    });

    footer.appendChild(this.generateBtn);
    footer.appendChild(rewriteBtn);
    this.panelEl.appendChild(closeBtn);
    this.panelEl.appendChild(header);
    this.panelEl.appendChild(this.bodyEl);
    this.panelEl.appendChild(footer);
    this.backdropEl.appendChild(this.panelEl);
    document.body.appendChild(this.backdropEl);

    this.renderEntries(encounterLog, currentStorylog);
    this.updateGenerateButton(encounterLog, currentStorylog);
  }

  private renderEntries(encounterLog: EncounterRecord[], storylog: StorylogEntry[]): void {
    const byId = new Map(storylog.map((e) => [e.encounterId, e]));
    const ordered = [...encounterLog].reverse();

    if (ordered.length === 0) {
      this.bodyEl.innerHTML = `<div style="color:#445566;font-size:12px;text-align:center;padding:40px 0;">No encounters recorded yet.</div>`;
      return;
    }

    const parts: string[] = [];
    for (const record of ordered) {
      const entry = byId.get(record.id);
      const date = new Date(record.timestamp).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
      const types = record.encounterTypes.map((t) => t.replace(/_/g, ' ')).join(' · ');

      parts.push(`
        <div style="margin-bottom:32px;padding-bottom:32px;border-bottom:1px solid #1a2233;">
          <div style="font-size:9px;color:#445566;letter-spacing:1px;margin-bottom:12px;">${date.toUpperCase()}  ·  ${types.toUpperCase()}</div>
          ${entry
            ? `<div style="font-size:13px;color:#c8d8e8;line-height:1.8;">${renderNarrative(entry.narrative)}</div>`
            : `<div style="font-size:12px;color:#334455;font-style:italic;">Not yet written.</div>`
          }
        </div>
      `);
    }
    this.bodyEl.innerHTML = parts.join('');
  }

  private updateGenerateButton(encounterLog: EncounterRecord[], storylog: StorylogEntry[]): void {
    const doneIds = new Set(storylog.map((e) => e.encounterId));
    const missing = encounterLog.filter((r) => !doneIds.has(r.id)).length;
    if (missing === 0) {
      this.setUpToDate();
    } else {
      this.generateBtn.textContent = `GENERATE ${missing} ENTR${missing === 1 ? 'Y' : 'IES'}`;
      this.generateBtn.disabled = false;
      this.generateBtn.style.opacity = '1';
    }
  }

  private setUpToDate(): void {
    this.generateBtn.textContent = 'UP TO DATE';
    this.generateBtn.disabled = true;
    this.generateBtn.style.opacity = '0.35';
    this.generateBtn.style.cursor = 'default';
  }

  private setGenerating(on: boolean): void {
    if (on) {
      this.generateBtn.textContent = 'GENERATING…';
      this.generateBtn.disabled = true;
      this.generateBtn.style.opacity = '0.6';
    }
  }

  private close(current: StorylogEntry[], onClose: (updated: StorylogEntry[]) => void): void {
    onClose(current);
    this.backdropEl.remove();
  }
}
