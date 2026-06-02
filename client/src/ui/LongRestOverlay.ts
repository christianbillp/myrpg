/**
 * LongRestOverlay — modal dialogue surfacing a `LongRestPreview` (HP / hit
 * dice / spell slots / feature resources / exhaustion) and, for Wizards, a
 * spell-preparation picker. CONFIRM applies and closes; × / backdrop /
 * CANCEL closes without committing.
 *
 * SRD reference (Rules Glossary → Long Rest): full HP, all hit dice, full
 * spell slots, refresh class features, exhaustion −1. Wizards rebuild their
 * prepared-spell list during a Long Rest (Wizard.md → "Changing Your
 * Prepared Spells"). Non-Wizard classes have no required choice — the
 * overlay just shows what's being restored.
 */
import { BaseOverlay } from "./BaseOverlay";
import { UIScale } from "./UIScale";
import type { LongRestPreview, LongRestChoices } from "../../../shared/types";

const ACCENT = "#7aaecc";
const PANEL_W = 640;
const PANEL_H = 560;

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface LongRestOverlayCallbacks {
  onConfirm: (choices: LongRestChoices) => Promise<void>;
  onCancel: () => void;
}

export class LongRestOverlay extends BaseOverlay {
  private readonly preparedPicks: Set<string>;
  private confirmBtn!: HTMLButtonElement;
  private statusEl!: HTMLDivElement;
  private busy = false;

  constructor(
    scale: UIScale,
    private readonly preview: LongRestPreview,
    private readonly callbacks: LongRestOverlayCallbacks,
  ) {
    super(scale, PANEL_W, PANEL_H, ACCENT, () => callbacks.onCancel());
    this.preparedPicks = new Set(preview.wizardSpellPrep?.currentlyPrepared ?? []);
    this.buildBody();
    this.refreshConfirmState();
  }

  private buildBody(): void {
    const p = this.preview;
    const body = document.createElement("div");
    body.style.cssText = `
      position: absolute; inset: 0; padding: 28px 28px 16px;
      box-sizing: border-box; display: flex; flex-direction: column;
      font-family: monospace; color: #cdd8e8; gap: 14px; overflow-y: auto;
    `;

    const header = document.createElement("div");
    header.style.cssText = "font-size: 22px; color: #cce4ff; letter-spacing: 1px;";
    header.textContent = "LONG REST — 8 hours of extended downtime";
    body.appendChild(header);

    const rule = document.createElement("div");
    rule.style.cssText = "height: 1px; background: #334455;";
    body.appendChild(rule);

    // ── Restored summary ────────────────────────────────────────────────
    const summary = document.createElement("div");
    summary.style.cssText = "display: flex; flex-direction: column; gap: 6px; font-size: 12px;";

    summary.appendChild(this.statLine(
      "Hit Points",
      p.hpRestored > 0 ? `+${p.hpRestored} (restored to maximum)` : "already at maximum",
      p.hpRestored > 0 ? "#88cc99" : "#778899",
    ));
    summary.appendChild(this.statLine(
      "Hit Dice",
      p.hitDiceRestored > 0 ? `+${p.hitDiceRestored} restored` : "already at maximum",
      p.hitDiceRestored > 0 ? "#88cc99" : "#778899",
    ));

    if (p.spellSlotsRestored.some((d) => d > 0)) {
      const parts = p.spellSlotsRestored
        .map((d, i) => d > 0 ? `+${d} L${i + 1}` : null)
        .filter((s): s is string => !!s);
      summary.appendChild(this.statLine("Spell Slots", parts.join(" · "), "#88cc99"));
    } else if (p.spellSlotsRestored.length > 0) {
      summary.appendChild(this.statLine("Spell Slots", "already at maximum", "#778899"));
    }

    if (p.featuresRestored.length > 0) {
      const parts = p.featuresRestored
        .map((f) => `${f.name} ${f.before}→${f.max}`)
        .join(" · ");
      summary.appendChild(this.statLine("Class Features", parts, "#88cc99"));
    }

    summary.appendChild(this.statLine(
      "Exhaustion",
      p.exhaustionReduced ? "−1 level" : "none to remove",
      p.exhaustionReduced ? "#88cc99" : "#778899",
    ));

    body.appendChild(summary);

    // ── Wizard spell preparation (only Wizards) ─────────────────────────
    if (p.wizardSpellPrep) {
      body.appendChild(this.sectionLabel("Prepare Spells"));
      const help = document.createElement("div");
      help.textContent = `Choose up to ${p.wizardSpellPrep.maxPrepared} spells from your spellbook to have prepared. Cantrips are always available and do not count toward this limit.`;
      help.style.cssText = "font-size: 11px; color: #778899; line-height: 1.55;";
      body.appendChild(help);

      const counter = document.createElement("div");
      counter.style.cssText = "font-size: 11px; color: #88aacc; margin-top: 4px;";
      const updateCounter = () => {
        counter.textContent = `${this.preparedPicks.size} / ${p.wizardSpellPrep!.maxPrepared} prepared`;
      };
      updateCounter();
      body.appendChild(counter);

      const list = document.createElement("div");
      list.style.cssText = "display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px;";
      // Sort: by level, then name.
      const sorted = [...p.wizardSpellPrep.spellbookSpells]
        .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
      for (const opt of sorted) {
        const chip = document.createElement("button");
        chip.textContent = `${opt.name} (L${opt.level} ${titleCase(opt.school)})`;
        chip.style.cssText = this.chipCss(this.preparedPicks.has(opt.id));
        chip.dataset.spellId = opt.id;
        chip.addEventListener("click", () => {
          const max = p.wizardSpellPrep!.maxPrepared;
          if (this.preparedPicks.has(opt.id)) {
            this.preparedPicks.delete(opt.id);
          } else if (this.preparedPicks.size < max) {
            this.preparedPicks.add(opt.id);
          } else {
            // At cap — flash status and skip.
            this.statusEl.textContent = `Already at the prepared-spell cap (${max}). Deselect one to swap.`;
            return;
          }
          this.statusEl.textContent = "";
          for (const c of Array.from(list.children) as HTMLButtonElement[]) {
            const id = c.dataset.spellId!;
            c.style.cssText = this.chipCss(this.preparedPicks.has(id));
          }
          updateCounter();
          this.refreshConfirmState();
        });
        list.appendChild(chip);
      }
      body.appendChild(list);
    }

    // ── Status + actions ────────────────────────────────────────────────
    const spacer = document.createElement("div");
    spacer.style.cssText = "flex: 1;";
    body.appendChild(spacer);

    this.statusEl = document.createElement("div");
    this.statusEl.style.cssText = "font-size: 11px; color: #aa7733; min-height: 14px;";
    body.appendChild(this.statusEl);

    const actions = document.createElement("div");
    actions.style.cssText = "display: flex; justify-content: flex-end; gap: 10px; margin-top: 4px;";

    const cancel = document.createElement("button");
    cancel.textContent = "CANCEL";
    cancel.style.cssText = this.buttonCss("#222233", "#556677", "#aabbcc");
    cancel.addEventListener("click", () => this.cancel());
    actions.appendChild(cancel);

    this.confirmBtn = document.createElement("button");
    this.confirmBtn.textContent = "CONFIRM LONG REST";
    this.confirmBtn.style.cssText = this.buttonCss("#1a2a4a", "#345580", "#cce4ff");
    this.confirmBtn.addEventListener("click", () => void this.commit());
    actions.appendChild(this.confirmBtn);

    body.appendChild(actions);
    this.panelEl.appendChild(body);
  }

  private statLine(label: string, value: string, valueColor: string): HTMLElement {
    const row = document.createElement("div");
    row.style.cssText = "display: flex; gap: 12px;";
    const l = document.createElement("div");
    l.textContent = label;
    l.style.cssText = "min-width: 160px; color: #778899; font-size: 12px;";
    const v = document.createElement("div");
    v.textContent = value;
    v.style.cssText = `color: ${valueColor}; font-size: 12px;`;
    row.appendChild(l);
    row.appendChild(v);
    return row;
  }

  private sectionLabel(text: string): HTMLElement {
    const el = document.createElement("div");
    el.textContent = text.toUpperCase();
    el.style.cssText = "font-size: 11px; color: #556677; letter-spacing: 2px; margin-top: 6px;";
    return el;
  }

  private buttonCss(bg: string, border: string, color: string): string {
    return `
      background: ${bg}; border: 2px solid ${border}; color: ${color};
      font-family: monospace; font-size: 12px; letter-spacing: 1px;
      padding: 8px 18px; cursor: pointer; box-sizing: border-box;
    `;
  }

  private chipCss(active: boolean): string {
    return `
      background: ${active ? "#1a3a5a" : "#1a1a2a"};
      border: 2px solid ${active ? "#7aaecc" : "#445566"};
      color: ${active ? "#cce4ff" : "#aabbcc"};
      font-family: monospace; font-size: 11px; padding: 4px 10px;
      cursor: pointer; box-sizing: border-box;
    `;
  }

  private refreshConfirmState(): void {
    // Long Rest is always confirmable — the picker has a sensible default
    // (the current prepared list) so an empty pick set is also legal (the
    // player can choose to prepare nothing). Only disable while a commit is
    // in flight.
    this.confirmBtn.disabled = this.busy;
    this.confirmBtn.style.opacity = this.busy ? "0.45" : "1";
    this.confirmBtn.style.cursor = this.busy ? "default" : "pointer";
  }

  private async commit(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.refreshConfirmState();
    this.statusEl.textContent = "Resting…";
    const choices: LongRestChoices = this.preview.wizardSpellPrep
      ? { wizardPreparedSpellIds: Array.from(this.preparedPicks) }
      : {};
    try {
      await this.callbacks.onConfirm(choices);
      this.destroy();
    } catch (err) {
      this.statusEl.textContent = `Failed: ${err instanceof Error ? err.message : String(err)}`;
      this.busy = false;
      this.refreshConfirmState();
    }
  }

  private cancel(): void {
    if (this.busy) return;
    this.callbacks.onCancel();
    this.destroy();
  }
}
