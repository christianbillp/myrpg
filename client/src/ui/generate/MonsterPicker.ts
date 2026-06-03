/**
 * MonsterPicker — two stacked panels for assembling an encounter's monster
 * roster:
 *
 *   • CATALOG (top) — scrollable list of every monster def with
 *     `+ ALLY`, `+ NEUTRAL`, and `+ ENEMY` buttons. Clicking appends to the
 *     matching role.
 *   • IN ENCOUNTER (bottom) — scrollable per-slot list. Each row shows the
 *     encounter id (e.g. `E0`, `A1`, `N0`), the monster name, and a REMOVE
 *     button. Removing a row splices it out and shifts higher indices down,
 *     so the next time the user reads the list the labels stay sequential.
 *
 * The host scene wires `onSlotRemoved(role, removedIndex)` BEFORE
 * `onSelectionChanged` so the ZonePainter can re-bind placements whose
 * index needs to shift, instead of the roster prune dropping them.
 */
import Phaser from "phaser";
import type { MonsterDef } from "../../../../shared/types";
import type { NPCDef } from "../../../../shared/types";
import { instanceIdForSlot } from "../../../../shared/spawnInstanceIds";

export type RosterRole = "ally" | "neutral" | "enemy";

export interface MonsterPickerOptions {
  scene: Phaser.Scene;
  parent: Phaser.GameObjects.Container;
  monsters: MonsterDef[];
  /** Optional NPC roster. When supplied, the catalog mixes NPCs (rendered
   *  with their authored display name + persona-source stat block) alongside
   *  the raw monsters. The engine's `SpawnHelpers.spawnNpc` resolves an id
   *  against the NPC roster first, then the monster roster — so any id added
   *  here works seamlessly in `allyIds` / `enemyIds` / `npcIds`. */
  npcs?: NPCDef[];
  x: number;
  y: number;
  width: number;
  /** Total height the picker may consume (catalog + in-encounter panel). */
  height: number;
  /** Scene width in logical pixels — used to scale absolutely-positioned DOM. */
  sceneWidth: number;
  initialAllyIds?: string[];
  initialEnemyIds?: string[];
  initialNeutralIds?: string[];
  /** Fires whenever the roster changes — add, remove-at, clear, or wholesale
   *  replace. Used by the EncounterCreator to push the new roster into the
   *  ZonePainter. */
  onSelectionChanged?: () => void;
  /** Fires immediately BEFORE `onSelectionChanged` whenever a specific slot
   *  is spliced out (REMOVE button). Lets the ZonePainter shift any
   *  placements bound to higher indices down by one so they follow the
   *  slot they were bound to. */
  onSlotRemoved?: (role: RosterRole, removedIndex: number) => void;
}

/** Label prefix used in the in-encounter list (E0, A0, N0, ...). */
const ROLE_PREFIX: Record<RosterRole, string> = {
  ally:    "A",
  neutral: "N",
  enemy:   "E",
};
const ROLE_COLOR: Record<RosterRole, string> = {
  ally:    "#cce4ff",
  neutral: "#ffe9a8",
  enemy:   "#ffcccc",
};

/** Internal catalog entry — a unified surface over NPCs + monsters so the
 *  list can render and look up by id without branching everywhere. NPC
 *  entries carry the resolved monster class for the stat-block hint shown
 *  next to the name. */
interface CatalogEntry {
  /** Id used in `allyIds` / `enemyIds` / `npcIds`. NPC ids are resolved by
   *  the engine's spawn helper before falling back to the monster roster. */
  id: string;
  /** Display name on the catalog row. */
  name: string;
  /** `'npc'` shows a small NPC badge before the name; `'monster'` doesn't. */
  kind: 'npc' | 'monster';
  /** Statblock string fragment (`"Humanoid, 14 HP"`) — pulled from the NPC's
   *  inherited monster def for NPC entries, or the monster's own type/HP for
   *  monster entries. */
  hint: string;
}

export class MonsterPicker {
  private readonly scene: Phaser.Scene;
  private readonly opts: MonsterPickerOptions;
  private readonly monsters: MonsterDef[];
  private readonly npcs: NPCDef[];
  private readonly catalog: CatalogEntry[];
  /** Ordered slot arrays — index in each array is the encounter id (A0/E0/N0). */
  private allySlots:    string[];
  private enemySlots:   string[];
  private neutralSlots: string[];

  private titleEl!: HTMLDivElement;
  private catalogEl!: HTMLDivElement;
  private rosterHeaderEl!: HTMLDivElement;
  private rosterEl!: HTMLDivElement;
  private clearBtn!: HTMLButtonElement;
  private placeHandlers: Array<() => void> = [];

  constructor(opts: MonsterPickerOptions) {
    this.scene = opts.scene;
    this.opts = opts;
    this.monsters = opts.monsters;
    this.npcs = opts.npcs ?? [];
    this.catalog = buildCatalog(this.npcs, this.monsters);

    this.allySlots    = [...(opts.initialAllyIds    ?? [])];
    this.enemySlots   = [...(opts.initialEnemyIds   ?? [])];
    this.neutralSlots = [...(opts.initialNeutralIds ?? [])];

    const { x, y, width, height } = opts;

    // Vertical layout:
    //   title (16px)
    //   catalog (45% of remaining)
    //   roster header (16px)
    //   roster (50% of remaining) + CLEAR button overlapping its header
    const HEADER_H = 16;
    const ROSTER_HEADER_H = 16;
    const GAP = 6;
    const innerH = height - HEADER_H - ROSTER_HEADER_H - GAP * 3;
    const catalogH = Math.floor(innerH * 0.45);
    const rosterH  = innerH - catalogH;

    // Title
    this.titleEl = document.createElement("div");
    this.titleEl.textContent = "MONSTERS — click +ALLY / +NEUTRAL / +ENEMY to add to the encounter";
    this.titleEl.style.cssText = `
      position: absolute;
      color: #778899;
      font-family: monospace;
      letter-spacing: 1px;
      z-index: 9;
      pointer-events: none;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    `;
    document.body.appendChild(this.titleEl);
    this.attachPlace(this.titleEl, x, y, width, HEADER_H);

    // Catalog list (scrollable add UI).
    const catalogY = y + HEADER_H + GAP;
    this.catalogEl = document.createElement("div");
    this.catalogEl.style.cssText = `
      position: absolute;
      background: #0a0e16;
      border: 1px solid #334455;
      box-sizing: border-box;
      overflow-y: auto;
      overflow-x: hidden;
      z-index: 9;
      padding: 2px;
    `;
    document.body.appendChild(this.catalogEl);
    this.attachPlace(this.catalogEl, x, catalogY, width, catalogH);
    this.renderCatalog();

    // Roster header.
    const rosterHeaderY = catalogY + catalogH + GAP;
    this.rosterHeaderEl = document.createElement("div");
    this.rosterHeaderEl.textContent = "IN ENCOUNTER — slot id · monster";
    this.rosterHeaderEl.style.cssText = `
      position: absolute;
      color: #778899;
      font-family: monospace;
      letter-spacing: 1px;
      z-index: 9;
      pointer-events: none;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    `;
    document.body.appendChild(this.rosterHeaderEl);
    this.attachPlace(this.rosterHeaderEl, x, rosterHeaderY, width - 140, ROSTER_HEADER_H);

    // CLEAR button — sits at the right of the roster header.
    this.clearBtn = document.createElement("button");
    this.clearBtn.type = "button";
    this.clearBtn.textContent = "CLEAR ALL";
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
      this.allySlots = [];
      this.enemySlots = [];
      this.neutralSlots = [];
      this.renderRoster();
      this.opts.onSelectionChanged?.();
    });
    document.body.appendChild(this.clearBtn);
    this.attachPlace(this.clearBtn, x + width - 130, rosterHeaderY - 2, 124, 22);

    // Roster — scrollable per-slot list.
    const rosterY = rosterHeaderY + ROSTER_HEADER_H + GAP;
    this.rosterEl = document.createElement("div");
    this.rosterEl.style.cssText = `
      position: absolute;
      background: #0a0e16;
      border: 1px solid #334455;
      box-sizing: border-box;
      overflow-y: auto;
      overflow-x: hidden;
      z-index: 9;
      padding: 2px;
    `;
    document.body.appendChild(this.rosterEl);
    this.attachPlace(this.rosterEl, x, rosterY, width, rosterH);
    this.renderRoster();
  }

  /** Flat id list — `["bandit","bandit"]` for two bandits as allies. */
  getAllyIds():    string[] { return [...this.allySlots]; }
  getEnemyIds():   string[] { return [...this.enemySlots]; }
  getNeutralIds(): string[] { return [...this.neutralSlots]; }

  /** Replace the role wholesale. Used by the AI accept flow + by load
   *  encounter / start-draft to seed initial state without firing remove
   *  callbacks for each existing slot. */
  setAllyIds(ids: string[]):    void { this.allySlots    = [...ids]; this.renderRoster(); this.opts.onSelectionChanged?.(); }
  setEnemyIds(ids: string[]):   void { this.enemySlots   = [...ids]; this.renderRoster(); this.opts.onSelectionChanged?.(); }
  setNeutralIds(ids: string[]): void { this.neutralSlots = [...ids]; this.renderRoster(); this.opts.onSelectionChanged?.(); }

  destroy(): void {
    this.titleEl.remove();
    this.catalogEl.remove();
    this.rosterHeaderEl.remove();
    this.rosterEl.remove();
    this.clearBtn.remove();
    for (const h of this.placeHandlers) this.scene.scale.off("resize", h);
    this.placeHandlers = [];
  }

  /** Show / hide every owned DOM element (used by the tab toggle). */
  setVisible(visible: boolean): void {
    const d = visible ? "" : "none";
    this.titleEl.style.display        = d;
    this.catalogEl.style.display      = d;
    this.rosterHeaderEl.style.display = d;
    this.rosterEl.style.display       = d;
    this.clearBtn.style.display       = d;
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private renderCatalog(): void {
    this.catalogEl.innerHTML = "";
    this.catalog.forEach((entry, i) => {
      const row = document.createElement("div");
      row.style.cssText = `
        display: flex; align-items: center;
        background: ${i % 2 === 0 ? "#111122" : "#141426"};
        padding: 3px 6px; box-sizing: border-box;
        font-family: monospace; font-size: 11px; color: #aabbcc;
      `;
      // NPC entries get a small "NPC" badge so the author can tell at a
      // glance whether they're picking an authored character (with persona /
      // name / faction) or a bare monster stat-block.
      if (entry.kind === 'npc') {
        const badge = document.createElement("span");
        badge.textContent = "NPC";
        badge.style.cssText = `
          color: #e2b96f; background: #1f1a0e;
          border: 1px solid #4a3a1a;
          font-size: 9px; letter-spacing: 1px;
          padding: 1px 4px; margin-right: 6px; flex-shrink: 0;
        `;
        row.appendChild(badge);
      }
      const label = document.createElement("span");
      label.style.cssText = "flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-right: 8px;";
      label.textContent = `${entry.name}  (${entry.hint})`;
      row.appendChild(label);

      const allyBtn = this.makeAddButton("+ ALLY",    "#1a3a55", "#4477aa", "#cce4ff");
      const neutBtn = this.makeAddButton("+ NEUTRAL", "#3a3a1a", "#9a8a44", "#ffe9a8");
      const enemBtn = this.makeAddButton("+ ENEMY",   "#551a1a", "#aa4444", "#ffcccc");
      allyBtn.addEventListener("click", () => this.addMonster(entry.id, "ally"));
      neutBtn.addEventListener("click", () => this.addMonster(entry.id, "neutral"));
      enemBtn.addEventListener("click", () => this.addMonster(entry.id, "enemy"));
      row.appendChild(allyBtn);
      row.appendChild(neutBtn);
      row.appendChild(enemBtn);

      this.catalogEl.appendChild(row);
    });
  }

  /** Find an id's display name across both rosters — NPCs first (their
   *  display name wins), then monsters. Used by the in-encounter roster
   *  rendering so an NPC slot shows the authored name instead of the inherited
   *  monster's name. Returns the id itself if no entry matches. */
  private resolveDisplayName(id: string): string {
    const npc = this.npcs.find((n) => n.id === id);
    if (npc) return npc.name;
    const mon = this.monsters.find((m) => m.id === id);
    return mon?.name ?? id;
  }

  /** Render the in-encounter per-slot list. One row per slot, with the
   *  encounter id label, the monster name, and a REMOVE button. */
  private renderRoster(): void {
    this.rosterEl.innerHTML = "";
    const empty = this.allySlots.length === 0
              && this.enemySlots.length === 0
              && this.neutralSlots.length === 0;
    if (empty) {
      const hint = document.createElement("div");
      hint.style.cssText = "color: #445566; font-family: monospace; font-size: 11px; padding: 8px; font-style: italic;";
      hint.textContent = "No monsters in this encounter yet. Pick from the catalog above.";
      this.rosterEl.appendChild(hint);
      return;
    }
    // Pass the full id lists into each section so `instanceIdForSlot` can
    // compute the canonical runtime id — a defId that's a singleton WITHIN
    // a role can still be a duplicate ACROSS roles (e.g. ally `commoner` +
    // enemy `commoner` would both surface as `commoner_1` / `commoner_2`
    // at spawn time). Showing those is what makes trigger authoring work.
    const lists = { allyIds: this.allySlots, enemyIds: this.enemySlots, npcIds: this.neutralSlots };
    this.renderRosterSection("ENEMIES",  "enemy",   this.enemySlots,   lists);
    this.renderRosterSection("ALLIES",   "ally",    this.allySlots,    lists);
    this.renderRosterSection("NEUTRALS", "neutral", this.neutralSlots, lists);
  }

  private renderRosterSection(label: string, role: RosterRole, slots: string[], lists: { allyIds: string[]; enemyIds: string[]; npcIds: string[] }): void {
    if (slots.length === 0) return;
    const header = document.createElement("div");
    header.textContent = `${label} (${slots.length})`;
    header.style.cssText = `
      color: ${ROLE_COLOR[role]};
      font-family: monospace; font-size: 10px; letter-spacing: 1px;
      padding: 6px 6px 2px;
    `;
    this.rosterEl.appendChild(header);
    // Per-slot runtime id resolved via `instanceIdForSlot` — the SAME
    // function the spawn helpers and the trigger system use at runtime.
    // Singletons keep the bare defId; duplicates get `${defId}_${ordinal}`.
    // Surfacing this exact id is what lets authors copy-paste it into
    // trigger fields (`set_npc_companion`, `set_disposition_by_def_id`,
    // `set_npc_hidden`, …) and have it match.
    slots.forEach((id, idx) => {
      const runtimeId = instanceIdForSlot(role, idx, lists) ?? id;
      const isDup = runtimeId !== id;
      const dupSuffix = isDup ? runtimeId.slice(id.length) : "";  // e.g. "_2"

      const row = document.createElement("div");
      row.style.cssText = `
        display: flex; align-items: center;
        background: ${idx % 2 === 0 ? "#111122" : "#141426"};
        padding: 3px 6px; box-sizing: border-box;
        font-family: monospace; font-size: 11px; color: #aabbcc;
      `;
      const tag = document.createElement("span");
      tag.textContent = `${ROLE_PREFIX[role]}${idx}`;
      tag.style.cssText = `
        color: ${ROLE_COLOR[role]};
        font-weight: bold;
        width: 32px; flex-shrink: 0;
      `;
      row.appendChild(tag);
      const name = document.createElement("span");
      name.style.cssText = "flex: 1; min-width: 0; overflow: hidden; margin-right: 8px;";
      // Names resolve through both rosters so an NPC slot reads the authored
      // display name instead of the inherited monster's name. The id is
      // surfaced beneath the name in muted text so the author can scan
      // which roster entry each slot resolves to.
      const displayName = this.resolveDisplayName(id);
      const nameEl = document.createElement("div");
      nameEl.textContent = `${displayName}${dupSuffix}`;
      nameEl.style.cssText = "overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
      name.appendChild(nameEl);
      const idEl = document.createElement("div");
      idEl.textContent = runtimeId;
      idEl.style.cssText = "color: #6a7888; font-size: 9px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
      name.appendChild(idEl);
      row.appendChild(name);
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.textContent = "REMOVE";
      removeBtn.style.cssText = `
        background: #2a1a1a; color: #ffaaaa; border: 1px solid #884444;
        padding: 1px 8px; margin-left: 4px;
        font-family: monospace; font-size: 9px; letter-spacing: 1px;
        cursor: pointer; flex-shrink: 0;
      `;
      removeBtn.addEventListener("click", () => this.removeAt(role, idx));
      row.appendChild(removeBtn);
      this.rosterEl.appendChild(row);
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

  private addMonster(id: string, role: RosterRole): void {
    const slots = this.slotsFor(role);
    slots.push(id);
    this.renderRoster();
    this.opts.onSelectionChanged?.();
  }

  /** Splice the slot out, shift indices, and notify in the right order:
   *  `onSlotRemoved` first so the ZonePainter can shift placements before
   *  `onSelectionChanged` triggers the roster prune. */
  private removeAt(role: RosterRole, index: number): void {
    const slots = this.slotsFor(role);
    if (index < 0 || index >= slots.length) return;
    slots.splice(index, 1);
    this.opts.onSlotRemoved?.(role, index);
    this.renderRoster();
    this.opts.onSelectionChanged?.();
  }

  private slotsFor(role: RosterRole): string[] {
    return role === "ally" ? this.allySlots
         : role === "enemy" ? this.enemySlots
         : this.neutralSlots;
  }

  private attachPlace(el: HTMLElement, x: number, y: number, w: number, h: number): void {
    const place = (): void => {
      const rect = this.scene.sys.game.canvas.getBoundingClientRect();
      const s = rect.width / this.opts.sceneWidth;
      el.style.left = `${rect.left + x * s}px`;
      el.style.top  = `${rect.top  + y * s}px`;
      el.style.width  = `${w * s}px`;
      el.style.height = `${h * s}px`;
      if (el === this.titleEl || el === this.rosterHeaderEl) el.style.fontSize = `${10 * s}px`;
    };
    place();
    this.scene.scale.on("resize", place);
    this.placeHandlers.push(place);
  }
}

/** Build the catalog rows the picker renders. NPCs come first (so authored
 *  characters are easy to spot at the top), then monsters. For an NPC, the
 *  "(type, HP)" hint is pulled from the monster it inherits from — that's the
 *  stat block the engine actually uses at spawn time. Within each group
 *  entries are sorted alphabetically by name so larger rosters stay easy to
 *  scan. */
function buildCatalog(npcs: NPCDef[], monsters: MonsterDef[]): CatalogEntry[] {
  const monsterById = new Map(monsters.map((m) => [m.id, m]));
  const npcEntries = npcs
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map<CatalogEntry>((npc) => {
      const base = monsterById.get(npc.monsterClass);
      const hint = base
        ? `${base.type ?? "—"}, ${base.maxHp} HP`
        : `${npc.monsterClass} (unknown stat block)`;
      return { id: npc.id, name: npc.name, kind: 'npc', hint };
    });
  const monsterEntries = monsters
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map<CatalogEntry>((mon) => ({
      id: mon.id,
      name: mon.name,
      kind: 'monster',
      hint: `${mon.type ?? "—"}, ${mon.maxHp} HP`,
    }));
  return [...npcEntries, ...monsterEntries];
}
