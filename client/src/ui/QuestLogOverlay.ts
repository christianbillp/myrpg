/**
 * QuestLogOverlay — the player-facing quest journal. Lists active quests with a
 * step checklist (✓ done, ▸ current), then completed/failed ones dimmed, then an
 * optional "Journal" of prior-chapter summaries (adventure mode). Read-only —
 * quests advance through the engine / AIGM, not from here.
 *
 * The host (GameScene) resolves the view-model from `GameState.quests` +
 * authored/runtime quest defs, so this overlay just renders.
 */
import { BaseOverlay } from "./BaseOverlay";
import { UIScale } from "./UIScale";

const ACCENT = "#e2b96f";
const PANEL_W = 520;
const PANEL_H = 540;

export interface QuestLogStep { id: string; text: string; done: boolean; current: boolean; }
export interface QuestLogEntry {
  id: string;
  title: string;
  description: string;
  status: 'active' | 'completed' | 'failed';
  steps: QuestLogStep[];
}
export interface QuestLogJournalEntry { chapterTitle: string; summary: string; }

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export class QuestLogOverlay extends BaseOverlay {
  constructor(
    scale: UIScale,
    private readonly quests: QuestLogEntry[],
    private readonly journal: QuestLogJournalEntry[],
    onClose: () => void,
  ) {
    super(scale, PANEL_W, PANEL_H, ACCENT, onClose);
    this.build();
  }

  private build(): void {
    const body = document.createElement("div");
    body.style.cssText = `position:absolute;inset:0;padding:24px 26px 16px;box-sizing:border-box;
      display:flex;flex-direction:column;font-family:monospace;color:#cdd8e8;gap:12px;`;

    const title = document.createElement("div");
    title.textContent = "QUEST LOG";
    title.style.cssText = `font-size:16px;color:${ACCENT};letter-spacing:1px;flex-shrink:0;`;
    body.appendChild(title);

    const scroll = document.createElement("div");
    scroll.style.cssText = "flex:1;overflow-y:auto;padding-right:6px;display:flex;flex-direction:column;gap:10px;";

    const active = this.quests.filter((q) => q.status === 'active');
    const done = this.quests.filter((q) => q.status !== 'active');

    if (this.quests.length === 0) {
      scroll.appendChild(this.note("No quests yet. The world will give you something to do."));
    }
    for (const q of active) scroll.appendChild(this.questCard(q));
    if (done.length > 0) {
      scroll.appendChild(this.sectionLabel("COMPLETED / FAILED"));
      for (const q of done) scroll.appendChild(this.questCard(q));
    }
    if (this.journal.length > 0) {
      scroll.appendChild(this.sectionLabel("JOURNAL"));
      for (const j of this.journal) {
        const e = document.createElement("div");
        e.style.cssText = "background:#11141c;border:1px solid #283443;padding:8px 10px;";
        e.innerHTML = `<div style="font-size:11px;color:${ACCENT};margin-bottom:3px;">${esc(j.chapterTitle)}</div>`
          + `<div style="font-size:10px;color:#9aabbc;line-height:1.5;">${esc(j.summary)}</div>`;
        scroll.appendChild(e);
      }
    }
    body.appendChild(scroll);
    this.panelEl.appendChild(body);
  }

  private questCard(q: QuestLogEntry): HTMLElement {
    const dim = q.status !== 'active';
    const statusColor = q.status === 'completed' ? '#7ec27e' : q.status === 'failed' ? '#cc7a7a' : ACCENT;
    const card = document.createElement("div");
    card.style.cssText = `background:#11141c;border:1px solid ${dim ? '#283443' : '#3a4a3a'};padding:10px 12px;opacity:${dim ? 0.7 : 1};`;

    const head = document.createElement("div");
    head.style.cssText = "display:flex;align-items:baseline;justify-content:space-between;gap:8px;";
    head.innerHTML = `<span style="font-size:13px;color:#dfe8f2;">${esc(q.title)}</span>`
      + `<span style="font-size:9px;letter-spacing:1px;color:${statusColor};">${q.status.toUpperCase()}</span>`;
    card.appendChild(head);

    if (q.description) {
      const d = document.createElement("div");
      d.textContent = q.description;
      d.style.cssText = "font-size:10px;color:#8da0b3;line-height:1.45;margin:4px 0 6px;";
      card.appendChild(d);
    }

    for (const s of q.steps) {
      const row = document.createElement("div");
      const glyph = s.done ? '✓' : s.current ? '▸' : '·';
      const color = s.done ? '#7ec27e' : s.current ? ACCENT : '#667788';
      row.style.cssText = `font-size:11px;color:${s.current ? '#dfe8f2' : color};line-height:1.6;`;
      row.innerHTML = `<span style="color:${color};display:inline-block;width:14px;">${glyph}</span>${esc(s.text)}`;
      card.appendChild(row);
    }
    return card;
  }

  private sectionLabel(text: string): HTMLElement {
    const el = document.createElement("div");
    el.textContent = text;
    el.style.cssText = "font-size:10px;letter-spacing:1.5px;color:#556677;border-bottom:1px solid #283443;padding-bottom:3px;margin-top:6px;";
    return el;
  }
  private note(text: string): HTMLElement {
    const el = document.createElement("div");
    el.textContent = text;
    el.style.cssText = "font-size:11px;color:#778899;text-align:center;padding:30px 0;";
    return el;
  }
}
