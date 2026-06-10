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
import { splitGameplayTips, TIP_COLOR, TIP_GLYPH } from "./gameplayTips";

const ACCENT = "#e2b96f";
const PANEL_W = 520;
const PANEL_H = 540;

export interface QuestLogStep { id: string; text: string; done: boolean; current: boolean; optional?: boolean; }
export interface QuestLogEntry {
  id: string;
  title: string;
  description: string;
  status: 'active' | 'completed' | 'failed';
  steps: QuestLogStep[];
}
export interface QuestLogJournalEntry { chapterTitle: string; summary: string; }
/** The live `GameState.objective` plus a heading (chapter/encounter title). Shown
 *  at the top of the log so trigger-driven encounters — which track progress via
 *  the objective string + flags rather than a structured quest — still surface
 *  "what am I doing right now". */
export interface QuestLogObjective { title: string; text: string; }

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export class QuestLogOverlay extends BaseOverlay {
  constructor(
    scale: UIScale,
    private readonly quests: QuestLogEntry[],
    private readonly journal: QuestLogJournalEntry[],
    onClose: () => void,
    private readonly objective?: QuestLogObjective,
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

    if (this.objective?.text) {
      scroll.appendChild(this.sectionLabel("CURRENT OBJECTIVE"));
      scroll.appendChild(this.objectiveCard(this.objective));
    }
    if (this.quests.length === 0 && !this.objective?.text) {
      scroll.appendChild(this.note("No quests yet. The world will give you something to do."));
    }
    if (active.length > 0 && this.objective?.text) scroll.appendChild(this.sectionLabel("QUESTS"));
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
      const { body, tips } = splitGameplayTips(s.text);
      const row = document.createElement("div");
      const glyph = s.done ? '✓' : s.optional ? '◇' : s.current ? '▸' : '·';
      const color = s.done ? '#7ec27e' : s.current ? ACCENT : '#667788';
      row.style.cssText = `font-size:11px;color:${s.current ? '#dfe8f2' : color};line-height:1.6;`;
      const tag = s.optional ? ` <span style="font-size:9px;letter-spacing:1px;color:#667788;">OPTIONAL</span>` : '';
      row.innerHTML = `<span style="color:${color};display:inline-block;width:14px;">${glyph}</span>${esc(body)}${tag}`;
      card.appendChild(row);
      // Surface a step's gameplay tip only while it's the active step — a hint
      // for "what do I do here", not clutter on every completed line.
      if (s.current) for (const tip of tips) card.appendChild(this.tipBlock(tip));
    }
    return card;
  }

  private objectiveCard(o: QuestLogObjective): HTMLElement {
    const card = document.createElement("div");
    card.style.cssText = `background:#11141c;border:1px solid #3a4a3a;padding:10px 12px;`;
    if (o.title) {
      const head = document.createElement("div");
      head.textContent = o.title;
      head.style.cssText = "font-size:13px;color:#dfe8f2;margin-bottom:5px;";
      card.appendChild(head);
    }
    // Immersive-first: the in-character objective, then any out-of-character
    // gameplay tips as clearly-labelled blocks beneath.
    const { body, tips } = splitGameplayTips(o.text);
    if (body) {
      const row = document.createElement("div");
      row.style.cssText = `font-size:11px;color:#dfe8f2;line-height:1.6;`;
      row.innerHTML = `<span style="color:${ACCENT};display:inline-block;width:14px;">▸</span>${esc(body)}`;
      card.appendChild(row);
    }
    for (const tip of tips) card.appendChild(this.tipBlock(tip));
    return card;
  }

  /** An out-of-character gameplay tip — visually distinct from the in-character
   *  quest fiction (cool accent, italic, labelled) so the player can always tell
   *  mechanics guidance apart from story. */
  private tipBlock(text: string): HTMLElement {
    const el = document.createElement("div");
    el.style.cssText = `margin:6px 0 1px;padding:5px 8px;background:#0e1a22;border-left:2px solid ${TIP_COLOR};`
      + `color:${TIP_COLOR};font-size:10px;font-style:italic;line-height:1.5;`;
    el.innerHTML = `<span style="font-style:normal;letter-spacing:1px;opacity:0.85;">${TIP_GLYPH} GAMEPLAY TIP</span>`
      + `<br>${esc(text)}`;
    return el;
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
