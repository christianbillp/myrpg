/**
 * LevelUpOverlay — modal dialogue presenting a `LevelUpPreview` (HP gain,
 * proficiency bonus delta, new features, required choices) and a CONFIRM
 * button. Closing the overlay (× / backdrop) cancels — no server call is
 * made unless CONFIRM is pressed.
 *
 * The overlay renders pure HTML on top of the canvas, mirroring the rest of
 * the chrome migration. Choices the SRD requires at the target level are
 * surfaced as in-overlay pickers (Scholar expertise, Wizard spell selection)
 * — CONFIRM stays disabled until every required choice has been answered.
 */
import { BaseOverlay } from "./BaseOverlay";
import { UIScale } from "./UIScale";
import type { LevelUpPreview, LevelUpChoices, LevelUpChoicePrompt } from "../../../shared/types";

const ACCENT = "#e2b96f";
const PANEL_W = 640;
const PANEL_H = 560;

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface LevelUpOverlayCallbacks {
  onConfirm: (choices: LevelUpChoices) => Promise<void>;
  /** Called when the overlay is dismissed without confirming. */
  onCancel: () => void;
}

export class LevelUpOverlay extends BaseOverlay {
  private readonly choices: LevelUpChoices = {};
  private confirmBtn!: HTMLButtonElement;
  private statusEl!: HTMLDivElement;
  private busy = false;

  constructor(
    scale: UIScale,
    private readonly preview: LevelUpPreview,
    private readonly callbacks: LevelUpOverlayCallbacks,
  ) {
    super(scale, PANEL_W, PANEL_H, ACCENT, () => callbacks.onCancel());
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

    // ── Header ──────────────────────────────────────────────────────────
    const header = document.createElement("div");
    header.style.cssText = "font-size: 22px; color: #ffe9a8; letter-spacing: 1px;";
    header.textContent = `LEVEL UP — ${p.className} ${p.fromLevel} → ${p.toLevel}`;
    body.appendChild(header);

    const rule = document.createElement("div");
    rule.style.cssText = "height: 1px; background: #334455;";
    body.appendChild(rule);

    // ── Summary line: HP / proficiency / slot deltas ───────────────────
    const summary = document.createElement("div");
    summary.style.cssText = "display: flex; flex-direction: column; gap: 6px; font-size: 12px;";
    summary.appendChild(this.statLine("Hit Points", `+${p.hpGain} (max HP)`, "#88cc99"));
    summary.appendChild(this.statLine(
      "Proficiency Bonus",
      p.proficiencyAfter === p.proficiencyBefore
        ? `+${p.proficiencyAfter} (unchanged)`
        : `+${p.proficiencyBefore} → +${p.proficiencyAfter}`,
      p.proficiencyAfter === p.proficiencyBefore ? "#778899" : "#88cc99",
    ));

    if (p.spellSlotDeltas.some((d) => d > 0)) {
      const parts = p.spellSlotDeltas
        .map((d, i) => d > 0 ? `+${d} L${i + 1}` : null)
        .filter((s): s is string => !!s);
      summary.appendChild(this.statLine("Spell Slots", parts.join(" · "), "#88cc99"));
    }
    body.appendChild(summary);

    // ── New features ────────────────────────────────────────────────────
    if (p.newFeatures.length > 0) {
      body.appendChild(this.sectionLabel("New Class Features"));
      const list = document.createElement("div");
      list.style.cssText = "display: flex; flex-direction: column; gap: 10px;";
      for (const f of p.newFeatures) {
        const row = document.createElement("div");
        row.style.cssText = "border-left: 2px solid #2a6655; padding: 4px 12px;";
        const name = document.createElement("div");
        name.textContent = f.name;
        name.style.cssText = "font-size: 13px; color: #e2b96f; font-weight: bold;";
        const desc = document.createElement("div");
        desc.textContent = f.description;
        desc.style.cssText = "margin-top: 4px; font-size: 11px; color: #aabbcc; line-height: 1.55;";
        row.appendChild(name);
        row.appendChild(desc);
        list.appendChild(row);
      }
      body.appendChild(list);
    }

    // ── Choices ─────────────────────────────────────────────────────────
    if (p.choices.length > 0) {
      body.appendChild(this.sectionLabel("Choices Required"));
      for (const prompt of p.choices) {
        body.appendChild(this.renderChoice(prompt));
      }
    } else {
      const note = document.createElement("div");
      note.textContent = "This level requires no player choices.";
      note.style.cssText = "font-size: 11px; color: #667788; font-style: italic;";
      body.appendChild(note);
    }

    // ── Status + confirm row ────────────────────────────────────────────
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
    this.confirmBtn.textContent = "CONFIRM LEVEL UP";
    this.confirmBtn.style.cssText = this.buttonCss("#1a3a2a", "#2a6655", "#ffe9a8");
    this.confirmBtn.addEventListener("click", () => void this.commit());
    actions.appendChild(this.confirmBtn);

    body.appendChild(actions);
    this.panelEl.appendChild(body);
  }

  private renderChoice(prompt: LevelUpChoicePrompt): HTMLElement {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display: flex; flex-direction: column; gap: 6px; margin-bottom: 6px;";

    const label = document.createElement("div");
    label.textContent = prompt.label;
    label.style.cssText = "font-size: 12px; color: #e2b96f;";
    wrap.appendChild(label);

    const help = document.createElement("div");
    help.textContent = prompt.description;
    help.style.cssText = "font-size: 10px; color: #778899; line-height: 1.5;";
    wrap.appendChild(help);

    if (prompt.kind === "scholar-expertise") {
      const chips = document.createElement("div");
      chips.style.cssText = "display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px;";
      for (const skill of prompt.options) {
        const chip = document.createElement("button");
        chip.textContent = titleCase(skill);
        chip.style.cssText = this.chipCss(false);
        chip.addEventListener("click", () => {
          this.choices.scholarExpertise = skill;
          for (const c of Array.from(chips.children) as HTMLButtonElement[]) {
            c.style.cssText = this.chipCss(c === chip);
          }
          this.refreshConfirmState();
        });
        chips.appendChild(chip);
      }
      wrap.appendChild(chips);
      return wrap;
    }

    if (prompt.kind === "expertise-pick") {
      if (prompt.options.length === 0) {
        const note = document.createElement("div");
        note.textContent = "No proficient skills available — Expertise can't be applied.";
        note.style.cssText = "font-size: 10px; color: #aa7733; font-style: italic; margin-top: 4px;";
        wrap.appendChild(note);
        this.choices.expertisePick = [];
        return wrap;
      }
      const counter = document.createElement("div");
      counter.style.cssText = "font-size: 11px; color: #88aacc; margin-top: 4px;";
      const updateCounter = () => {
        const picked = (this.choices.expertisePick ?? []).length;
        counter.textContent = `${picked} / ${prompt.count} chosen`;
      };
      updateCounter();
      wrap.appendChild(counter);
      const chips = document.createElement("div");
      chips.style.cssText = "display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px;";
      for (const skill of prompt.options) {
        const chip = document.createElement("button");
        chip.textContent = titleCase(skill);
        chip.style.cssText = this.chipCss(false);
        chip.dataset.skillId = skill;
        chip.addEventListener("click", () => {
          const current = this.choices.expertisePick ?? [];
          const idx = current.indexOf(skill);
          if (idx >= 0) current.splice(idx, 1);
          else if (current.length < prompt.count) current.push(skill);
          else { current.shift(); current.push(skill); }
          this.choices.expertisePick = current;
          for (const c of Array.from(chips.children) as HTMLButtonElement[]) {
            c.style.cssText = this.chipCss(current.includes(c.dataset.skillId!));
          }
          updateCounter();
          this.refreshConfirmState();
        });
        chips.appendChild(chip);
      }
      wrap.appendChild(chips);
      return wrap;
    }

    if (prompt.kind === "fighting-style-pick") {
      if (prompt.options.length === 0) {
        const note = document.createElement("div");
        note.textContent = "No fighting styles available.";
        note.style.cssText = "font-size: 10px; color: #aa7733; font-style: italic; margin-top: 4px;";
        wrap.appendChild(note);
        return wrap;
      }
      const cards = document.createElement("div");
      cards.style.cssText = "display: flex; flex-direction: column; gap: 6px; margin-top: 4px;";
      for (const ft of prompt.options) {
        const card = document.createElement("button");
        card.style.cssText = `
          background: #1a1a2a; border: 2px solid #445566; color: #aabbcc;
          font-family: monospace; padding: 8px 10px; cursor: pointer;
          text-align: left; box-sizing: border-box;
        `;
        const name = document.createElement("div");
        name.textContent = ft.name;
        name.style.cssText = "font-size: 12px; color: #e2b96f; font-weight: bold;";
        const desc = document.createElement("div");
        desc.textContent = ft.description;
        desc.style.cssText = "margin-top: 4px; font-size: 10px; color: #889aaa; line-height: 1.5;";
        card.appendChild(name);
        card.appendChild(desc);
        card.dataset.featId = ft.id;
        card.addEventListener("click", () => {
          this.choices.fightingStylePick = ft.id;
          for (const c of Array.from(cards.children) as HTMLButtonElement[]) {
            const picked = c === card;
            c.style.background = picked ? "#3a2a1a" : "#1a1a2a";
            c.style.borderColor = picked ? "#e2b96f" : "#445566";
          }
          this.refreshConfirmState();
        });
        cards.appendChild(card);
      }
      wrap.appendChild(cards);
      return wrap;
    }

    if (prompt.kind === "subclass-choice") {
      if (prompt.options.length === 0) {
        const note = document.createElement("div");
        note.textContent = "No subclasses authored for this class yet.";
        note.style.cssText = "font-size: 10px; color: #aa7733; font-style: italic; margin-top: 4px;";
        wrap.appendChild(note);
        return wrap;
      }
      const cards = document.createElement("div");
      cards.style.cssText = "display: flex; flex-direction: column; gap: 6px; margin-top: 4px;";
      for (const sc of prompt.options) {
        const card = document.createElement("button");
        card.style.cssText = `
          background: #1a1a2a; border: 2px solid #445566; color: #aabbcc;
          font-family: monospace; padding: 8px 10px; cursor: pointer;
          text-align: left; box-sizing: border-box;
        `;
        const name = document.createElement("div");
        name.textContent = sc.name;
        name.style.cssText = "font-size: 12px; color: #e2b96f; font-weight: bold;";
        const desc = document.createElement("div");
        desc.textContent = sc.description;
        desc.style.cssText = "margin-top: 4px; font-size: 10px; color: #889aaa; line-height: 1.5;";
        card.appendChild(name);
        card.appendChild(desc);
        card.dataset.subclassId = sc.id;
        card.addEventListener("click", () => {
          this.choices.subclassChoice = sc.id;
          for (const c of Array.from(cards.children) as HTMLButtonElement[]) {
            const picked = c === card;
            c.style.background = picked ? "#3a2a1a" : "#1a1a2a";
            c.style.borderColor = picked ? "#e2b96f" : "#445566";
          }
          this.refreshConfirmState();
        });
        cards.appendChild(card);
      }
      wrap.appendChild(cards);
      return wrap;
    }

    if (prompt.kind === "asi-or-feat") {
      const modeRow = document.createElement("div");
      modeRow.style.cssText = "display: flex; gap: 6px; margin-top: 4px;";
      const modes: Array<["asi-plus-2" | "asi-plus-1" | "feat", string]> = [
        ["asi-plus-2", "+2 ONE ABILITY"],
        ["asi-plus-1", "+1 TWO ABILITIES"],
        ["feat", "TAKE A FEAT"],
      ];
      const detailHost = document.createElement("div");
      detailHost.style.cssText = "margin-top: 6px;";
      const modeButtons: Record<string, HTMLButtonElement> = {};
      let activeMode: "asi-plus-2" | "asi-plus-1" | "feat" = "asi-plus-2";

      const renderDetail = () => {
        detailHost.replaceChildren();
        if (activeMode === "asi-plus-2") {
          const chips = document.createElement("div");
          chips.style.cssText = "display: flex; flex-wrap: wrap; gap: 6px;";
          for (const ab of prompt.abilityScores) {
            const chip = document.createElement("button");
            chip.textContent = `${ab.key.toUpperCase()} ${ab.current}→${ab.current + 2}`;
            chip.disabled = ab.current + 2 > 20;
            chip.style.cssText = this.chipCss(false);
            if (chip.disabled) chip.style.opacity = "0.4";
            chip.addEventListener("click", () => {
              this.choices.asiOrFeat = { kind: "asi-plus-2", ability: ab.key };
              for (const c of Array.from(chips.children) as HTMLButtonElement[]) {
                c.style.cssText = this.chipCss(c === chip);
                if (c.disabled) c.style.opacity = "0.4";
              }
              this.refreshConfirmState();
            });
            chips.appendChild(chip);
          }
          detailHost.appendChild(chips);
        } else if (activeMode === "asi-plus-1") {
          const picked: string[] = [];
          const chips = document.createElement("div");
          chips.style.cssText = "display: flex; flex-wrap: wrap; gap: 6px;";
          const sync = () => {
            for (const c of Array.from(chips.children) as HTMLButtonElement[]) {
              const k = c.dataset.k!;
              c.style.cssText = this.chipCss(picked.includes(k));
              if (c.disabled) c.style.opacity = "0.4";
            }
          };
          for (const ab of prompt.abilityScores) {
            const chip = document.createElement("button");
            chip.textContent = `${ab.key.toUpperCase()} ${ab.current}→${ab.current + 1}`;
            chip.disabled = ab.current + 1 > 20;
            chip.dataset.k = ab.key;
            chip.style.cssText = this.chipCss(false);
            if (chip.disabled) chip.style.opacity = "0.4";
            chip.addEventListener("click", () => {
              const idx = picked.indexOf(ab.key);
              if (idx >= 0) picked.splice(idx, 1);
              else if (picked.length < 2) picked.push(ab.key);
              else { picked.shift(); picked.push(ab.key); }
              if (picked.length === 2) {
                this.choices.asiOrFeat = { kind: "asi-plus-1", abilities: [picked[0] as "str", picked[1] as "str"] };
              } else {
                this.choices.asiOrFeat = undefined;
              }
              sync();
              this.refreshConfirmState();
            });
            chips.appendChild(chip);
          }
          detailHost.appendChild(chips);
        } else {
          // feat
          if (prompt.featOptions.length === 0) {
            const note = document.createElement("div");
            note.textContent = "No additional feats available.";
            note.style.cssText = "font-size: 10px; color: #aa7733; font-style: italic;";
            detailHost.appendChild(note);
            return;
          }
          const list = document.createElement("div");
          list.style.cssText = "display: flex; flex-direction: column; gap: 6px;";
          for (const ft of prompt.featOptions) {
            const card = document.createElement("button");
            card.style.cssText = `
              background: #1a1a2a; border: 2px solid #445566; color: #aabbcc;
              font-family: monospace; padding: 6px 10px; cursor: pointer;
              text-align: left; box-sizing: border-box;
            `;
            const name = document.createElement("div");
            name.textContent = ft.name;
            name.style.cssText = "font-size: 12px; color: #e2b96f;";
            const desc = document.createElement("div");
            desc.textContent = ft.description;
            desc.style.cssText = "margin-top: 4px; font-size: 10px; color: #889aaa; line-height: 1.5;";
            card.appendChild(name);
            card.appendChild(desc);
            card.dataset.featId = ft.id;
            card.addEventListener("click", () => {
              this.choices.asiOrFeat = { kind: "feat", featId: ft.id };
              for (const c of Array.from(list.children) as HTMLButtonElement[]) {
                const picked = c === card;
                c.style.background = picked ? "#3a2a1a" : "#1a1a2a";
                c.style.borderColor = picked ? "#e2b96f" : "#445566";
              }
              this.refreshConfirmState();
            });
            list.appendChild(card);
          }
          detailHost.appendChild(list);
        }
      };

      for (const [k, label] of modes) {
        const btn = document.createElement("button");
        btn.textContent = label;
        btn.style.cssText = this.chipCss(k === activeMode);
        btn.addEventListener("click", () => {
          activeMode = k;
          this.choices.asiOrFeat = undefined;
          for (const m of modes) {
            modeButtons[m[0]].style.cssText = this.chipCss(m[0] === activeMode);
          }
          renderDetail();
          this.refreshConfirmState();
        });
        modeButtons[k] = btn;
        modeRow.appendChild(btn);
      }
      wrap.appendChild(modeRow);
      wrap.appendChild(detailHost);
      renderDetail();
      return wrap;
    }

    if (prompt.kind === "wizard-spellbook-add") {
      if (prompt.count === 0) {
        const note = document.createElement("div");
        note.textContent = "(no action needed)";
        note.style.cssText = "font-size: 10px; color: #556677; font-style: italic; margin-top: 4px;";
        wrap.appendChild(note);
        this.choices.wizardSpellbookAdd = [];
        return wrap;
      }
      const counter = document.createElement("div");
      counter.style.cssText = "font-size: 11px; color: #88aacc; margin-top: 4px;";
      const updateCounter = () => {
        const picked = (this.choices.wizardSpellbookAdd ?? []).length;
        counter.textContent = `${picked} / ${prompt.count} chosen`;
      };
      updateCounter();
      wrap.appendChild(counter);

      const list = document.createElement("div");
      list.style.cssText = "display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px;";
      for (const opt of prompt.options) {
        const chip = document.createElement("button");
        chip.textContent = `${opt.name} (L${opt.level} ${titleCase(opt.school)})`;
        chip.style.cssText = this.chipCss(false);
        chip.addEventListener("click", () => {
          const current = this.choices.wizardSpellbookAdd ?? [];
          const idx = current.indexOf(opt.id);
          if (idx >= 0) {
            current.splice(idx, 1);
          } else if (current.length < prompt.count) {
            current.push(opt.id);
          } else {
            // At cap — replace the first chosen so the player can keep clicking
            // without having to manually de-select.
            current.shift();
            current.push(opt.id);
          }
          this.choices.wizardSpellbookAdd = current;
          for (const c of Array.from(list.children) as HTMLButtonElement[]) {
            const id = c.dataset.spellId!;
            c.style.cssText = this.chipCss(current.includes(id));
          }
          updateCounter();
          this.refreshConfirmState();
        });
        chip.dataset.spellId = opt.id;
        list.appendChild(chip);
      }
      wrap.appendChild(list);
      return wrap;
    }

    return wrap;
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
      background: ${active ? "#3a2a1a" : "#1a1a2a"};
      border: 2px solid ${active ? "#e2b96f" : "#445566"};
      color: ${active ? "#ffe9a8" : "#aabbcc"};
      font-family: monospace; font-size: 11px; padding: 4px 10px;
      cursor: pointer; box-sizing: border-box;
    `;
  }

  private refreshConfirmState(): void {
    const ok = this.allChoicesAnswered();
    this.confirmBtn.disabled = !ok || this.busy;
    this.confirmBtn.style.opacity = (!ok || this.busy) ? "0.45" : "1";
    this.confirmBtn.style.cursor = (!ok || this.busy) ? "default" : "pointer";
  }

  private allChoicesAnswered(): boolean {
    for (const prompt of this.preview.choices) {
      if (prompt.kind === "scholar-expertise" && !this.choices.scholarExpertise) return false;
      if (prompt.kind === "wizard-spellbook-add") {
        const picked = (this.choices.wizardSpellbookAdd ?? []).length;
        if (picked < prompt.count) return false;
      }
      if (prompt.kind === "subclass-choice" && !this.choices.subclassChoice) {
        // Only require an answer when subclasses are actually authored — a
        // class with no shipped subclasses leaves the option list empty and
        // the player can still proceed (the level-up just skips the grant).
        if (prompt.options.length > 0) return false;
      }
      if (prompt.kind === "asi-or-feat" && !this.choices.asiOrFeat) return false;
      if (prompt.kind === "expertise-pick") {
        const picked = (this.choices.expertisePick ?? []).length;
        if (prompt.options.length > 0 && picked < prompt.count) return false;
      }
      if (prompt.kind === "fighting-style-pick" && !this.choices.fightingStylePick) {
        if (prompt.options.length > 0) return false;
      }
    }
    return true;
  }

  private async commit(): Promise<void> {
    if (this.busy || !this.allChoicesAnswered()) return;
    this.busy = true;
    this.refreshConfirmState();
    this.statusEl.textContent = "Applying…";
    try {
      await this.callbacks.onConfirm(this.choices);
      this.destroy();
    } catch (err) {
      this.statusEl.textContent = `Failed: ${err instanceof Error ? escHtml(err.message) : String(err)}`;
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
