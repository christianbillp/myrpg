import Phaser from "phaser";
import { DevMode } from "../devMode";
import type { DevFlags } from "../../../shared/types";

/**
 * ConfigurationScene — game-wide settings page reached from the main menu.
 *
 * Pure HTML overlay (single root `<div>`, CSS flex/grid layout). Styling
 * follows the project palette used by EncounterSetupScene / AdventureSetupScene
 * / MapEditorScene: `#0d0d1e` background, `#e2b96f` titles, `#556677`
 * subsection labels, monospace by default, `sans-serif` for prose blocks,
 * `#111122` cards, `#334455` dividers. Keeps the look continuous with the
 * other setup scenes so the player doesn't see a stylistic break.
 *
 * Today the page owns two concerns, both persisted in `server_config.json`
 * via a single `GET /server-config` + `PUT /server-config` endpoint pair:
 *
 *   • Active-setting picker — list every loaded setting, click to select.
 *   • Development Mode toggles — four checkboxes (encounter intro screen,
 *     unlimited spell slots, unlock all spells, unlimited actions).
 *
 * Every change stays pending in the UI until CONFIRM is pressed; the
 * commit covers both the setting choice and the dev-flag toggles in one
 * round trip. The server reloads setting-owned rosters when the active
 * setting changes; a dev-flag-only save skips the def reload.
 */
const API_URL = "http://localhost:3000";

// Palette mirrors the other setup scenes — keep in sync if those change.
const COLOR_BG          = "#0d0d1e";
const COLOR_TITLE       = "#e2b96f";
const COLOR_SUBLABEL    = "#556677";
const COLOR_TEXT        = "#aabbcc";
const COLOR_TEXT_BRIGHT = "#bbccdd";
const COLOR_CARD        = "#111122";
const COLOR_CARD_ACTIVE = "#1a1a2e";
const COLOR_CARD_PEND   = "#202038";
const COLOR_DIVIDER     = "#334455";
const COLOR_OK          = "#7fc97f";
const COLOR_ERR         = "#cc4444";

interface SettingSummary {
  id: string;
  name: string;
  version: string;
  ruleset?: string;
  summary: string;
  sections: string[];
}

export class ConfigurationScene extends Phaser.Scene {
  /** Single root container. All UI lives inside; teardown removes this and the rest follows. */
  private root: HTMLDivElement | null = null;
  /** DOM refs for spots we re-render on data changes. */
  private listEl: HTMLDivElement | null = null;
  private summaryEl: HTMLDivElement | null = null;
  private statusEl: HTMLDivElement | null = null;
  private confirmBtn: HTMLButtonElement | null = null;

  private settings: SettingSummary[] = [];
  private activeId: string | null = null;
  /** Selection the user has clicked but not yet confirmed. */
  private pendingId: string | null = null;
  /** Last-saved Development Mode flags fetched from the server. The
   *  "baseline" that pending edits diff against. */
  private savedDevFlags: DevFlags = {};
  /** Working copy of Development Mode flags edited via the toggles. Only
   *  committed to the server (and to localStorage) when CONFIRM is pressed. */
  private pendingDevFlags: DevFlags = {};

  constructor() {
    super({ key: "ConfigurationScene" });
  }

  async create(): Promise<void> {
    // Single GET fetches everything: setting list, active id, persisted dev
    // flags. We need it BEFORE buildLayout because each dev-mode toggle's
    // initial checkbox state reads `pendingDevFlags` synchronously.
    await this.loadConfigFromServer();
    this.buildLayout();
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.teardown());
    this.events.once(Phaser.Scenes.Events.DESTROY, () => this.teardown());
    this.refreshAfterLoad();
  }

  /** Build the full page DOM tree once. Subsequent renders mutate child nodes. */
  private buildLayout(): void {
    const root = document.createElement("div");
    root.style.cssText = `
      position: fixed; inset: 0;
      background: ${COLOR_BG};
      color: ${COLOR_TEXT};
      font-family: monospace;
      font-size: 11px;
      z-index: 50;
      display: flex; flex-direction: column;
      padding: 22px 48px;
      box-sizing: border-box;
      overflow: hidden;
    `;
    this.root = root;

    // ── Header ──────────────────────────────────────────────────────────
    const title = document.createElement("div");
    title.textContent = "CONFIGURATION";
    title.style.cssText = `
      font-family: monospace; font-size: 22px;
      color: ${COLOR_TITLE}; letter-spacing: 1px;
      text-align: center;
    `;
    root.appendChild(title);

    const headerDivider = document.createElement("div");
    headerDivider.style.cssText = `
      width: 100%; height: 1px; background: ${COLOR_DIVIDER};
      margin: 14px 0 18px;
    `;
    root.appendChild(headerDivider);

    const subtitle = document.createElement("div");
    subtitle.textContent = "Choose the active setting. Setting choice scopes adventures, encounters, generated content, and which encounters the editor sees.";
    subtitle.style.cssText = `
      font-family: sans-serif; font-size: 12px;
      color: ${COLOR_TEXT}; max-width: 820px;
      margin: 0 auto 22px; text-align: center; line-height: 1.5;
    `;
    root.appendChild(subtitle);

    // ── Body: two-column split ──────────────────────────────────────────
    const body = document.createElement("div");
    body.style.cssText = `
      display: grid; grid-template-columns: 360px 1fr; gap: 28px;
      flex: 1; min-height: 0;
    `;

    // Left column — list of settings.
    const left = document.createElement("div");
    left.style.cssText = `display: flex; flex-direction: column; min-height: 0;`;
    const leftLabel = document.createElement("div");
    leftLabel.textContent = "AVAILABLE SETTINGS";
    leftLabel.style.cssText = `
      font-family: monospace; font-size: 11px;
      color: ${COLOR_SUBLABEL}; letter-spacing: 2px;
      text-align: center; margin-bottom: 12px;
    `;
    const list = document.createElement("div");
    list.style.cssText = `
      flex: 1; overflow-y: auto;
      display: flex; flex-direction: column; gap: 8px;
      padding: 2px 4px 2px 0;
    `;
    this.listEl = list;
    left.appendChild(leftLabel);
    left.appendChild(list);

    // Right column — summary panel.
    const right = document.createElement("div");
    right.style.cssText = `display: flex; flex-direction: column; min-height: 0;`;
    const rightLabel = document.createElement("div");
    rightLabel.textContent = "SUMMARY";
    rightLabel.style.cssText = `
      font-family: monospace; font-size: 11px;
      color: ${COLOR_SUBLABEL}; letter-spacing: 2px;
      text-align: center; margin-bottom: 12px;
    `;
    const summary = document.createElement("div");
    summary.style.cssText = `
      flex: 1; overflow-y: auto;
      background: ${COLOR_CARD};
      padding: 20px 24px;
      font-family: sans-serif; font-size: 13px;
      color: ${COLOR_TEXT_BRIGHT}; line-height: 1.55;
      white-space: pre-wrap; word-wrap: break-word;
    `;
    summary.textContent = "Select a setting on the left to see its summary.";
    this.summaryEl = summary;
    right.appendChild(rightLabel);
    right.appendChild(summary);

    body.appendChild(left);
    body.appendChild(right);
    root.appendChild(body);

    // ── Development Mode section ─────────────────────────────────────────
    root.appendChild(this.buildDevModeSection());

    // ── Footer: divider, status, BACK + CONFIRM ─────────────────────────
    const footerDivider = document.createElement("div");
    footerDivider.style.cssText = `
      width: 100%; height: 1px; background: ${COLOR_DIVIDER};
      margin: 18px 0 14px;
    `;
    root.appendChild(footerDivider);

    const footer = document.createElement("div");
    footer.style.cssText = `
      display: flex; align-items: center; justify-content: space-between;
      gap: 16px;
    `;

    const backBtn = this.makeFooterButton("BACK", false);
    backBtn.addEventListener("click", () => this.scene.start("MainMenuScene"));

    const status = document.createElement("div");
    status.textContent = "Loading settings…";
    status.style.cssText = `
      flex: 1; text-align: center;
      font-family: monospace; font-size: 11px;
      color: ${COLOR_TEXT}; letter-spacing: 1px;
    `;
    this.statusEl = status;

    const confirmBtn = this.makeFooterButton("CONFIRM", true);
    confirmBtn.disabled = true;
    confirmBtn.style.opacity = "0.4";
    confirmBtn.addEventListener("click", () => void this.confirmSelection());
    this.confirmBtn = confirmBtn;

    footer.appendChild(backBtn);
    footer.appendChild(status);
    footer.appendChild(confirmBtn);
    root.appendChild(footer);

    document.body.appendChild(root);
  }

  /**
   * Build the Development Mode section — a row of four toggle switches that
   * persist to localStorage and apply to the NEXT encounter the player starts
   * (they're snapshotted into the `CreateSessionRequest`'s `devFlags` block).
   * Toggles take effect immediately on the next session creation; no restart
   * or CONFIRM needed.
   */
  private buildDevModeSection(): HTMLDivElement {
    const section = document.createElement("div");
    section.style.cssText = `
      margin-top: 22px;
      padding-top: 18px;
      border-top: 1px solid ${COLOR_DIVIDER};
      display: flex; flex-direction: column; gap: 12px;
    `;

    const label = document.createElement("div");
    label.textContent = "DEVELOPMENT MODE";
    label.style.cssText = `
      font-family: monospace; font-size: 11px;
      color: ${COLOR_SUBLABEL}; letter-spacing: 2px;
      text-align: center;
    `;
    section.appendChild(label);

    const hint = document.createElement("div");
    hint.textContent = "Test-only overrides. Persisted server-side (in server_config.json) so they survive both server and browser restarts, and apply to the next encounter you start.";
    hint.style.cssText = `
      font-family: sans-serif; font-size: 11px;
      color: ${COLOR_TEXT}; text-align: center;
      max-width: 820px; margin: 0 auto; line-height: 1.5;
    `;
    section.appendChild(hint);

    const grid = document.createElement("div");
    grid.style.cssText = `
      display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px;
      max-width: 1100px; width: 100%; margin: 4px auto 0;
    `;

    // Each toggle reads + writes `this.pendingDevFlags` ONLY. The values
    // are persisted (and mirrored to localStorage) when CONFIRM is pressed.
    // Until then the toggle's visual state is allowed to drift from the
    // saved baseline — that's how the user previews their changes.
    const toggles: Array<{ label: string; description: string; flag: keyof DevFlags; invert?: boolean }> = [
      {
        label: "Encounter intro screen",
        description: "When OFF, skip the title supertitle at encounter start. The intro text still appears in the GM chat.",
        flag: "disableSupertitle",
        invert: true,
      },
      {
        label: "Unlimited spell slots",
        description: "Spell slots refill on every server tick — casting never decrements the visible slot counter.",
        flag: "unlimitedSpellSlots",
      },
      {
        label: "Unlock all spells",
        description: "Seed every spell in the game as known + prepared at session start so any spell is castable.",
        flag: "unlockAllSpells",
      },
      {
        label: "Unlimited actions",
        description: "Action + Bonus Action reset every server tick so you can keep attacking/casting in combat.",
        flag: "unlimitedActions",
      },
      {
        label: "Show DELETE SAVE button",
        description: "Reveal the destructive Delete Save button on the character setup screen. Off by default to protect save data.",
        flag: "showDeleteSaveButton",
      },
    ];

    for (const t of toggles) {
      grid.appendChild(this.buildDevToggle(
        t.label,
        t.description,
        () => t.invert ? !this.pendingDevFlags[t.flag] : !!this.pendingDevFlags[t.flag],
        (checked) => {
          const next = t.invert ? !checked : checked;
          if (next) this.pendingDevFlags[t.flag] = true;
          else      delete this.pendingDevFlags[t.flag];
          this.refreshConfirmButton();
          this.setStatus(
            this.hasPendingChanges()
              ? "Pending changes — press CONFIRM to apply."
              : "No pending change.",
            COLOR_TEXT,
          );
        },
      ));
    }
    section.appendChild(grid);
    return section;
  }

  /** One toggle card: bold title row with a styled checkbox + small caption. */
  private buildDevToggle(
    title: string,
    description: string,
    get: () => boolean,
    set: (v: boolean) => void,
  ): HTMLDivElement {
    const card = document.createElement("div");
    card.style.cssText = `
      background: ${COLOR_CARD};
      border: 1px solid ${COLOR_DIVIDER};
      padding: 10px 12px;
      display: flex; flex-direction: column; gap: 6px;
    `;

    const headerRow = document.createElement("label");
    headerRow.style.cssText = `
      display: flex; align-items: center; gap: 10px;
      cursor: pointer;
      font-family: monospace; font-size: 12px;
      color: ${COLOR_TEXT_BRIGHT};
    `;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = get();
    checkbox.style.cssText = `width: 16px; height: 16px; flex-shrink: 0; cursor: pointer; accent-color: ${COLOR_TITLE};`;
    const repaint = (): void => {
      card.style.borderColor = checkbox.checked ? COLOR_TITLE : COLOR_DIVIDER;
      card.style.background = checkbox.checked ? COLOR_CARD_ACTIVE : COLOR_CARD;
    };
    repaint();
    checkbox.addEventListener("change", () => {
      set(checkbox.checked);
      repaint();
    });

    const titleEl = document.createElement("span");
    titleEl.textContent = title;
    titleEl.style.flex = "1";

    headerRow.appendChild(checkbox);
    headerRow.appendChild(titleEl);
    card.appendChild(headerRow);

    const desc = document.createElement("div");
    desc.textContent = description;
    desc.style.cssText = `
      font-family: sans-serif; font-size: 10.5px;
      color: ${COLOR_TEXT}; line-height: 1.4;
    `;
    card.appendChild(desc);
    return card;
  }

  /** Footer button styled like the other scenes' overlay buttons. */
  private makeFooterButton(label: string, primary: boolean): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.className = "gui-btn-overlay";
    btn.style.cssText = `
      background: ${primary ? "#243250" : "transparent"};
      color: ${primary ? COLOR_TITLE : COLOR_TEXT};
      border: 1px solid ${primary ? COLOR_TITLE : COLOR_SUBLABEL};
      font-family: monospace; font-size: 11px;
      letter-spacing: 2px;
      padding: 8px 24px;
      min-width: 140px;
    `;
    return btn;
  }

  /**
   * Fetch the full server-side configuration in one round trip — the
   * settings list, the active setting id, and the persisted Development Mode
   * flags. Populates `savedDevFlags` + `pendingDevFlags` so the toggle UI
   * starts from the persisted truth. localStorage is also mirrored so any
   * runtime `DevMode.x` reads (e.g. `OverlayManager.disableSupertitle`)
   * agree with what the server is enforcing.
   */
  private async loadConfigFromServer(): Promise<void> {
    try {
      const res = await fetch(`${API_URL}/server-config`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const body = await res.json() as {
        settings: SettingSummary[];
        activeSettingId: string | null;
        devFlags: DevFlags;
      };
      this.settings = body.settings;
      this.activeId = body.activeSettingId;
      this.pendingId = this.activeId;
      this.savedDevFlags = body.devFlags ?? {};
      this.pendingDevFlags = { ...this.savedDevFlags };
      this.syncDevFlagsToLocalStorage(this.savedDevFlags);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[ConfigurationScene] failed to fetch /server-config:", msg);
    }
  }

  /** Final render pass after `loadConfigFromServer` + `buildLayout` — paints
   *  the settings list, renders the active setting's summary, and reports
   *  any load-time problem in the status line. */
  private refreshAfterLoad(): void {
    if (this.settings.length === 0) {
      this.setStatus("No settings found on the server.", COLOR_TEXT);
    } else {
      this.setStatus(`${this.settings.length} setting${this.settings.length === 1 ? "" : "s"} loaded.`, COLOR_TEXT);
    }
    this.renderList();
    if (this.activeId) this.renderSummary(this.activeId);
    this.refreshConfirmButton();
  }

  /** Mirror the saved dev flags into localStorage so runtime DevMode reads
   *  (made by OverlayManager etc, all synchronous) match the server-side
   *  source of truth. Only called when the server is the authority — i.e.
   *  on initial GET, and after a successful PUT. */
  private syncDevFlagsToLocalStorage(flags: DevFlags): void {
    DevMode.disableSupertitle    = !!flags.disableSupertitle;
    DevMode.unlimitedSpellSlots  = !!flags.unlimitedSpellSlots;
    DevMode.unlockAllSpells      = !!flags.unlockAllSpells;
    DevMode.unlimitedActions     = !!flags.unlimitedActions;
    DevMode.showDeleteSaveButton = !!flags.showDeleteSaveButton;
  }

  /** True when there is a pending change waiting on CONFIRM — either a
   *  different setting id, or any dev-flag toggle that differs from saved. */
  private hasPendingChanges(): boolean {
    if (this.pendingId !== this.activeId) return true;
    const fields: (keyof DevFlags)[] = ['disableSupertitle', 'unlimitedSpellSlots', 'unlockAllSpells', 'unlimitedActions', 'showDeleteSaveButton'];
    return fields.some((k) => !!this.pendingDevFlags[k] !== !!this.savedDevFlags[k]);
  }

  /** Update the CONFIRM button's enabled state + opacity to match
   *  `hasPendingChanges`. Called after every UI interaction that mutates
   *  pending state (setting click, dev-flag toggle). */
  private refreshConfirmButton(): void {
    if (!this.confirmBtn) return;
    const pending = this.hasPendingChanges();
    this.confirmBtn.disabled = !pending;
    this.confirmBtn.style.opacity = pending ? "1" : "0.4";
  }

  private renderList(): void {
    if (!this.listEl) return;
    this.listEl.replaceChildren();
    for (const s of this.settings) {
      const isActive = s.id === this.activeId;
      const isPending = s.id === this.pendingId && s.id !== this.activeId;
      const baseBg = isPending ? COLOR_CARD_PEND : isActive ? COLOR_CARD_ACTIVE : COLOR_CARD;
      const baseBorder = isPending ? COLOR_TITLE : isActive ? COLOR_DIVIDER : "transparent";

      const row = document.createElement("button");
      row.type = "button";
      row.style.cssText = `
        background: ${baseBg};
        color: ${COLOR_TEXT};
        border: 1px solid ${baseBorder};
        padding: 12px 16px;
        text-align: left;
        cursor: pointer;
        font-family: monospace;
        display: flex; flex-direction: column;
        align-items: flex-start; gap: 4px;
      `;
      row.addEventListener("mouseenter", () => {
        if (!isPending && !isActive) row.style.background = "#161628";
      });
      row.addEventListener("mouseleave", () => { row.style.background = baseBg; });
      row.addEventListener("click", () => this.selectSetting(s.id));

      const name = document.createElement("span");
      name.textContent = s.name + (isActive ? "  · ACTIVE" : "");
      name.style.cssText = `
        font-family: monospace; font-size: 13px;
        color: ${COLOR_TITLE}; letter-spacing: 0.5px;
      `;
      const meta = document.createElement("span");
      meta.textContent = `${s.id}  ·  v${s.version}${s.ruleset ? `  ·  ${s.ruleset}` : ""}`;
      meta.style.cssText = `
        font-family: monospace; font-size: 10px;
        color: ${COLOR_SUBLABEL}; letter-spacing: 1px;
      `;
      row.appendChild(name);
      row.appendChild(meta);
      this.listEl.appendChild(row);
    }
  }

  private renderSummary(id: string): void {
    if (!this.summaryEl) return;
    const s = this.settings.find((x) => x.id === id);
    if (!s) { this.summaryEl.textContent = ""; return; }
    this.summaryEl.replaceChildren();

    const heading = document.createElement("div");
    heading.textContent = s.name;
    heading.style.cssText = `
      font-family: monospace; font-size: 15px;
      color: ${COLOR_TITLE}; letter-spacing: 1px;
      margin-bottom: 14px;
    `;
    this.summaryEl.appendChild(heading);

    const body = document.createElement("div");
    body.textContent = s.summary;
    body.style.cssText = `font-family: sans-serif; font-size: 13px; line-height: 1.55; color: ${COLOR_TEXT_BRIGHT};`;
    this.summaryEl.appendChild(body);

    if (s.sections.length > 0) {
      const sectionsLabel = document.createElement("div");
      sectionsLabel.textContent = "SECTIONS";
      sectionsLabel.style.cssText = `
        font-family: monospace; font-size: 10px;
        color: ${COLOR_SUBLABEL}; letter-spacing: 2px;
        margin-top: 18px; margin-bottom: 6px;
      `;
      this.summaryEl.appendChild(sectionsLabel);

      const sectionsBody = document.createElement("div");
      sectionsBody.textContent = s.sections.join(", ");
      sectionsBody.style.cssText = `font-family: monospace; font-size: 11px; color: ${COLOR_TEXT}; line-height: 1.45;`;
      this.summaryEl.appendChild(sectionsBody);
    }
  }

  private selectSetting(id: string): void {
    this.pendingId = id;
    this.renderSummary(id);
    this.renderList();
    this.refreshConfirmButton();
    this.setStatus(
      this.hasPendingChanges()
        ? `Pending changes — press CONFIRM to apply.`
        : "No pending change.",
      COLOR_TEXT,
    );
  }

  /**
   * Commit every pending change — a different active setting AND any flipped
   * Development Mode toggles — to the server in one PUT. The server file
   * (`server_config.json`) is the source of truth; on success we mirror the
   * new state into localStorage so runtime `DevMode.x` reads see the same
   * values that the server is enforcing.
   */
  private async confirmSelection(): Promise<void> {
    if (!this.hasPendingChanges()) return;
    this.setStatus("Saving configuration…", COLOR_TEXT);
    if (this.confirmBtn) this.confirmBtn.disabled = true;
    const settingChanged = this.pendingId !== this.activeId;
    try {
      const res = await fetch(`${API_URL}/server-config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          activeSettingId: this.pendingId,
          devFlags: this.pendingDevFlags,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? `${res.status} ${res.statusText}`);
      }
      const body = await res.json() as {
        activeSettingId: string | null;
        devFlags: DevFlags;
        settings: SettingSummary[];
      };
      this.activeId = body.activeSettingId;
      this.settings = body.settings;
      this.pendingId = this.activeId;
      this.savedDevFlags = body.devFlags ?? {};
      this.pendingDevFlags = { ...this.savedDevFlags };
      this.syncDevFlagsToLocalStorage(this.savedDevFlags);
      this.renderList();
      if (this.activeId) this.renderSummary(this.activeId);
      this.refreshConfirmButton();
      this.setStatus(
        settingChanged
          ? `Saved. Active setting is now "${this.activeId ?? "none"}" — content reloaded.`
          : `Saved Development Mode settings.`,
        COLOR_OK,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus(`Save failed: ${msg}`, COLOR_ERR);
      this.refreshConfirmButton();
    }
  }

  private setStatus(text: string, color: string): void {
    if (!this.statusEl) return;
    this.statusEl.textContent = text;
    this.statusEl.style.color = color;
  }

  private teardown(): void {
    this.root?.remove();
    this.root = null;
    this.listEl = null;
    this.summaryEl = null;
    this.statusEl = null;
    this.confirmBtn = null;
  }
}
