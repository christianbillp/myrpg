/**
 * MonsterPicker — scrollable list of monster defs with `+ ALLY`, `+ NEUTRAL`,
 * and `+ ENEMY` buttons per row. Used by the Adjudicator tab of
 * `GenerateSetupScene` and by `EncounterEditorScene` to populate an
 * encounter's `allyIds`, `npcIds`, and `enemyIds`.
 *
 * Rendering is HTML — the scrolling list is a `<div style="overflow:auto">`
 * with native browser scrolling, and per-row buttons are HTML `<button>`s.
 * This keeps text crisp at any zoom level and gives the in-list buttons
 * proper click targets that scroll with the rows (previously the Phaser
 * mask clipped rendering but not click hit-areas).
 */
import Phaser from "phaser";
import type { MonsterDef } from "../../data/monsters";

export interface MonsterPickerOptions {
  scene: Phaser.Scene;
  parent: Phaser.GameObjects.Container;
  monsters: MonsterDef[];
  x: number;
  y: number;
  width: number;
  /** Total height the picker may consume (list + summary). */
  height: number;
  /** Scene width in logical pixels — used to scale absolutely-positioned DOM. */
  sceneWidth: number;
  initialAllyIds?: string[];
  initialEnemyIds?: string[];
  initialNeutralIds?: string[];
}

export class MonsterPicker {
  private readonly scene: Phaser.Scene;
  private readonly opts: MonsterPickerOptions;
  private readonly monsters: MonsterDef[];
  private readonly allySelections = new Map<string, number>();
  private readonly neutralSelections = new Map<string, number>();
  private readonly enemySelections = new Map<string, number>();
  private listEl!: HTMLDivElement;
  private summaryEl!: HTMLDivElement;
  private clearBtn!: HTMLButtonElement;
  private placeHandlers: Array<() => void> = [];

  constructor(opts: MonsterPickerOptions) {
    this.scene = opts.scene;
    this.opts = opts;
    this.monsters = opts.monsters;

    for (const id of opts.initialAllyIds    ?? []) this.allySelections.set(id, (this.allySelections.get(id) ?? 0) + 1);
    for (const id of opts.initialEnemyIds   ?? []) this.enemySelections.set(id, (this.enemySelections.get(id) ?? 0) + 1);
    for (const id of opts.initialNeutralIds ?? []) this.neutralSelections.set(id, (this.neutralSelections.get(id) ?? 0) + 1);

    const { scene, parent, x, y, width, height } = opts;
    const HEADER_H = 16;
    const SUMMARY_H = 76;

    parent.add(scene.add.text(x, y, "MONSTERS — click +ALLY / +NEUTRAL / +ENEMY to add to the encounter", {
      fontSize: "10px", color: "#778899", fontFamily: "monospace", letterSpacing: 1,
    }).setOrigin(0, 0));

    // Scrollable HTML list — fills the available height minus the summary.
    const listY = y + HEADER_H + 4;
    const listH = height - HEADER_H - SUMMARY_H - 12;

    this.listEl = document.createElement("div");
    this.listEl.style.cssText = `
      position: absolute;
      background: #0a0e16;
      border: 1px solid #334455;
      box-sizing: border-box;
      overflow-y: auto;
      overflow-x: hidden;
      z-index: 9;
      padding: 2px;
    `;
    document.body.appendChild(this.listEl);
    this.attachPlace(this.listEl, x, listY, width, listH);
    this.renderRows();

    // Summary section (ALLIES / NEUTRALS / ENEMIES + CLEAR button).
    const summaryY = listY + listH + 6;
    this.summaryEl = document.createElement("div");
    this.summaryEl.style.cssText = `
      position: absolute;
      box-sizing: border-box;
      font-family: monospace;
      font-size: 11px;
      line-height: 1.3;
      z-index: 9;
      padding: 4px 6px;
      background: rgba(10, 14, 22, 0.6);
      border: 1px solid #2a3340;
      overflow: hidden;
    `;
    document.body.appendChild(this.summaryEl);
    this.attachPlace(this.summaryEl, x, summaryY, width - 130, SUMMARY_H);

    this.clearBtn = document.createElement("button");
    this.clearBtn.type = "button";
    this.clearBtn.textContent = "CLEAR MONSTERS";
    this.clearBtn.style.cssText = `
      position: absolute;
      background: #222233; color: #aabbcc;
      border: 1px solid #556677;
      padding: 0 8px;
      font-family: monospace; font-size: 10px; letter-spacing: 1px;
      cursor: pointer; z-index: 10; box-sizing: border-box;
    `;
    this.clearBtn.addEventListener("mouseenter", () => { this.clearBtn.style.background = "#2c2f44"; });
    this.clearBtn.addEventListener("mouseleave", () => { this.clearBtn.style.background = "#222233"; });
    this.clearBtn.addEventListener("click", () => {
      this.allySelections.clear();
      this.neutralSelections.clear();
      this.enemySelections.clear();
      this.refreshSummary();
    });
    document.body.appendChild(this.clearBtn);
    this.attachPlace(this.clearBtn, x + width - 126, summaryY + SUMMARY_H / 2 - 12, 120, 24);

    this.refreshSummary();
  }

  /** Flat id list — `["bandit","bandit"]` for two bandits as allies. */
  getAllyIds(): string[] { return this.expand(this.allySelections); }
  getEnemyIds(): string[] { return this.expand(this.enemySelections); }
  getNeutralIds(): string[] { return this.expand(this.neutralSelections); }

  destroy(): void {
    this.listEl.remove();
    this.summaryEl.remove();
    this.clearBtn.remove();
    for (const h of this.placeHandlers) this.scene.scale.off("resize", h);
    this.placeHandlers = [];
  }

  /** Show / hide every owned DOM element (used by the tab toggle). */
  setVisible(visible: boolean): void {
    this.listEl.style.display = visible ? "" : "none";
    this.summaryEl.style.display = visible ? "" : "none";
    this.clearBtn.style.display = visible ? "" : "none";
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private renderRows(): void {
    this.listEl.innerHTML = "";
    this.monsters.forEach((mon, i) => {
      const row = document.createElement("div");
      row.style.cssText = `
        display: flex; align-items: center;
        background: ${i % 2 === 0 ? "#111122" : "#141426"};
        padding: 3px 6px; box-sizing: border-box;
        font-family: monospace; font-size: 11px; color: #aabbcc;
      `;
      const label = document.createElement("span");
      label.style.cssText = "flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-right: 8px;";
      label.textContent = `${mon.name}  (${mon.type ?? "—"}, ${mon.maxHp} HP)`;
      row.appendChild(label);

      const allyBtn = this.makeAddButton("+ ALLY",    "#1a3a55", "#4477aa", "#cce4ff");
      const neutBtn = this.makeAddButton("+ NEUTRAL", "#3a3a1a", "#9a8a44", "#ffe9a8");
      const enemBtn = this.makeAddButton("+ ENEMY",   "#551a1a", "#aa4444", "#ffcccc");
      allyBtn.addEventListener("click", () => this.addMonster(mon.id, "ally"));
      neutBtn.addEventListener("click", () => this.addMonster(mon.id, "neutral"));
      enemBtn.addEventListener("click", () => this.addMonster(mon.id, "enemy"));
      row.appendChild(allyBtn);
      row.appendChild(neutBtn);
      row.appendChild(enemBtn);

      this.listEl.appendChild(row);
    });
  }

  private makeAddButton(text: string, bg: string, border: string, color: string): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = text;
    btn.style.cssText = `
      background: ${bg}; color: ${color}; border: 1px solid ${border};
      padding: 1px 6px; margin-left: 4px;
      font-family: monospace; font-size: 9px; letter-spacing: 1px;
      cursor: pointer; flex-shrink: 0;
    `;
    return btn;
  }

  private addMonster(id: string, side: "ally" | "neutral" | "enemy"): void {
    const target = side === "ally" ? this.allySelections
                 : side === "enemy" ? this.enemySelections
                 : this.neutralSelections;
    target.set(id, (target.get(id) ?? 0) + 1);
    this.refreshSummary();
  }

  private refreshSummary(): void {
    const allyLine = this.formatSelected(this.allySelections, "ALLIES",   "#cce4ff");
    const neutLine = this.formatSelected(this.neutralSelections, "NEUTRALS", "#ffe9a8");
    const enemLine = this.formatSelected(this.enemySelections, "ENEMIES",  "#ffcccc");
    this.summaryEl.innerHTML = `${allyLine}<br>${neutLine}<br>${enemLine}`;
  }

  private formatSelected(sel: Map<string, number>, label: string, color: string): string {
    if (sel.size === 0) return `<span style="color: ${color}">${label}: (none)</span>`;
    const parts = Array.from(sel.entries()).map(([id, n]) => {
      const mon = this.monsters.find((m) => m.id === id);
      const safe = (mon?.name ?? id).replace(/</g, "&lt;");
      return `${safe}${n > 1 ? ` ×${n}` : ""}`;
    });
    return `<span style="color: ${color}">${label}: ${parts.join(", ")}</span>`;
  }

  private expand(sel: Map<string, number>): string[] {
    const out: string[] = [];
    for (const [id, n] of sel) for (let i = 0; i < n; i++) out.push(id);
    return out;
  }

  private attachPlace(el: HTMLElement, x: number, y: number, w: number, h: number): void {
    const place = (): void => {
      const rect = this.scene.sys.game.canvas.getBoundingClientRect();
      const s = rect.width / this.opts.sceneWidth;
      el.style.left = `${rect.left + x * s}px`;
      el.style.top  = `${rect.top  + y * s}px`;
      el.style.width  = `${w * s}px`;
      el.style.height = `${h * s}px`;
    };
    place();
    this.scene.scale.on("resize", place);
    this.placeHandlers.push(place);
  }
}
