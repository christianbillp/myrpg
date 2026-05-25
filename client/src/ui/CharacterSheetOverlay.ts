// Character sheet overlay — three tabs: Character (basic info), Inventory
// (slots + carried items), and Spells (caster-only). Replaces the older
// InventoryOverlay; the Inventory tab preserves all its old behaviour and
// keyboard/pointer wiring.
//
// The Spells tab is hidden when the player isn't a caster (no
// `spellcastingAbility` on PlayerDef).

import { BaseOverlay } from "./BaseOverlay";
import { PlayerDef, PlayerAttack } from "../data/player";
import { ItemDef, ArmorDef, WeaponDef, ShieldDef, EquipmentDef } from "../data/equipment";
import { UIScale } from "./UIScale";
import type { PlayerState, SpellDef } from "../net/types";

function mod(score: number): number { return Math.floor((score - 10) / 2); }
function signed(n: number): string { return n >= 0 ? `+${n}` : `${n}`; }

function attackSummary(attack: PlayerAttack, statMod: number): string {
  const sign = statMod >= 0 ? "+" : "";
  const masteries: string[] = [];
  if (attack.graze) masteries.push("Graze");
  if (attack.vex)   masteries.push("Vex");
  const masteryStr = masteries.length ? ` (${masteries.join(", ")})` : "";
  return `${attack.damageDice}d${attack.damageSides}${sign}${statMod}${masteryStr}`;
}

function isEquipmentDef(item: ItemDef): item is EquipmentDef {
  return item.type === "armor" || item.type === "weapon" || item.type === "shield";
}

function slotLabel(item: EquipmentDef, playerDef: PlayerDef): string {
  if (item.type === "armor") {
    const a = item as ArmorDef;
    const dexMod = mod(playerDef.dex);
    const dexBonus = a.addDex ? (a.maxDex !== null ? Math.min(dexMod, a.maxDex) : dexMod) : 0;
    const ac = a.baseAc + dexBonus + (playerDef.fightingStyleDefense ? 1 : 0);
    const cat = a.category.charAt(0).toUpperCase() + a.category.slice(1);
    return `${cat} · AC ${ac}`;
  }
  if (item.type === "shield") {
    return `+${(item as ShieldDef).acBonus} AC`;
  }
  const w = item as WeaponDef;
  const statMod = w.finesse
    ? Math.max(mod(playerDef.str), mod(playerDef.dex))
    : mod(playerDef[w.statKey]);
  const sign = statMod >= 0 ? "+" : "";
  const mastery = w.mastery
    ? ` (${w.mastery.charAt(0).toUpperCase() + w.mastery.slice(1)})`
    : "";
  return `${w.damageDice}d${w.damageSides}${sign}${statMod}${mastery}`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const ACCENT = "#7aadcc";
const DIM    = "#334455";

type TabId = "character" | "inventory" | "spells";

export interface CharacterSheetCallbacks {
  onEquip: (slot: "armor" | "weapon" | "shield", itemId: string) => void;
  onUnequip: (slot: "armor" | "weapon" | "shield") => void;
  onUse: (itemId: string) => void;
  onClose: () => void;
}

export interface CharacterSheetInputs {
  playerDef: PlayerDef;
  state: PlayerState;
  equippedItems: Partial<Record<"armor" | "weapon" | "shield", EquipmentDef>>;
  inventory: ItemDef[];
  /** Whether consumables (potions) can be used right now — disables the USE button when false. */
  canUseConsumable: boolean;
  /** All spell defs (used by the Spells tab to look up cantrip/spellbook details). */
  allSpells: SpellDef[];
  /** Concentration display name (resolved by caller from concentratingOn). */
  concentratingOnName: string | null;
}

export class CharacterSheetOverlay extends BaseOverlay {
  private readonly inputs: CharacterSheetInputs;
  private readonly callbacks: CharacterSheetCallbacks;
  private currentTab: TabId;
  private readonly contentEl: HTMLDivElement;
  private readonly tabBar: HTMLDivElement;

  constructor(
    scale: UIScale,
    inputs: CharacterSheetInputs,
    callbacks: CharacterSheetCallbacks,
    initialTab: TabId = "inventory",
  ) {
    super(scale, 580, 480, ACCENT, callbacks.onClose);
    this.inputs = inputs;
    this.callbacks = callbacks;
    this.currentTab = inputs.playerDef.spellcastingAbility || initialTab !== "spells" ? initialTab : "inventory";

    const layout = document.createElement("div");
    layout.style.cssText = `padding:20px 20px 0;display:flex;flex-direction:column;height:calc(100% - 20px);box-sizing:border-box;`;

    const header = document.createElement("div");
    header.style.cssText = `font-size:15px;color:${ACCENT};text-align:center;margin-bottom:12px;`;
    header.textContent = "CHARACTER SHEET";
    layout.appendChild(header);

    this.tabBar = document.createElement("div");
    this.tabBar.style.cssText = `display:flex;gap:0;border-bottom:1px solid ${DIM};margin-bottom:12px;`;
    layout.appendChild(this.tabBar);

    this.contentEl = document.createElement("div");
    this.contentEl.style.cssText = `flex:1;display:flex;flex-direction:column;min-height:0;`;
    layout.appendChild(this.contentEl);

    this.panelEl.appendChild(layout);

    this.renderTabs();
    this.renderActiveTab();
  }

  /** Hook for OverlayManager — rebuild contents (e.g. after a state update). */
  rebuild(inputs: CharacterSheetInputs): void {
    Object.assign(this.inputs, inputs);
    // If the active tab is now invalid (e.g. spells tab open for a non-caster), fall back.
    if (this.currentTab === "spells" && !this.inputs.playerDef.spellcastingAbility) {
      this.currentTab = "inventory";
    }
    this.renderTabs();
    this.renderActiveTab();
  }

  // ── Tab bar ────────────────────────────────────────────────────────────────

  private renderTabs(): void {
    const hasSpells = !!this.inputs.playerDef.spellcastingAbility;
    const tabs: { id: TabId; label: string }[] = [
      { id: "character", label: "Character" },
      { id: "inventory", label: "Inventory" },
    ];
    if (hasSpells) tabs.push({ id: "spells", label: "Spells" });

    this.tabBar.innerHTML = "";
    for (const t of tabs) {
      const isActive = t.id === this.currentTab;
      const btn = document.createElement("button");
      btn.className = "gui-btn-overlay";
      btn.style.cssText = `
        flex:1;height:30px;background:${isActive ? "#0d2a3a" : "transparent"};
        border:none;border-bottom:2px solid ${isActive ? ACCENT : "transparent"};
        color:${isActive ? ACCENT : "#778899"};font-size:11px;font-family:monospace;
        letter-spacing:1px;cursor:pointer;`;
      btn.textContent = t.label.toUpperCase();
      btn.addEventListener("pointerdown", () => {
        if (this.currentTab === t.id) return;
        this.currentTab = t.id;
        this.renderTabs();
        this.renderActiveTab();
      });
      this.tabBar.appendChild(btn);
    }
  }

  private renderActiveTab(): void {
    this.contentEl.innerHTML = "";
    switch (this.currentTab) {
      case "character": this.renderCharacterTab(); break;
      case "inventory": this.renderInventoryTab(); break;
      case "spells":    this.renderSpellsTab();    break;
    }
  }

  // ── Character tab ──────────────────────────────────────────────────────────

  private renderCharacterTab(): void {
    const { playerDef, state, concentratingOnName } = this.inputs;
    const colorHex = "#" + playerDef.color.toString(16).padStart(6, "0");
    const dexMod = mod(playerDef.dex);
    const passivePerception = 10 + (playerDef.skills["perception"] ?? 0);
    const abilities: [string, number][] = [
      ["STR", playerDef.str], ["DEX", playerDef.dex], ["CON", playerDef.con],
      ["INT", playerDef.int], ["WIS", playerDef.wis], ["CHA", playerDef.cha],
    ];

    const abilityCells = abilities.map(([name, val]) => `
      <div style="flex:1;text-align:center;padding:6px 4px;border:1px solid ${DIM};background:#0a0a18;">
        <div style="font-size:9px;color:#556677;letter-spacing:1px;">${name}</div>
        <div style="font-size:16px;color:#e8e8f8;margin-top:2px;">${val}</div>
        <div style="font-size:10px;color:${ACCENT};">${signed(mod(val))}</div>
      </div>`).join("");

    const saveCells = abilities.map(([name, val]) => {
      const prof = playerDef.savingThrowProficiencies.includes(name.toLowerCase());
      const total = mod(val) + (prof ? playerDef.proficiencyBonus : 0);
      return `
        <div style="display:flex;justify-content:space-between;padding:2px 0;">
          <span style="font-size:10px;color:${prof ? ACCENT : "#778899"};">
            ${prof ? "●" : "○"} ${name}
          </span>
          <span style="font-size:10px;color:#aabbcc;">${signed(total)}</span>
        </div>`;
    }).join("");

    const concLine = state.concentratingOn && concentratingOnName
      ? `<div style="font-size:10px;color:#b8a8e8;margin-top:6px;">🌀 Concentrating: ${escHtml(concentratingOnName)}</div>`
      : "";

    this.contentEl.insertAdjacentHTML("beforeend", `
      <div style="overflow-y:auto;scrollbar-width:thin;scrollbar-color:${ACCENT} transparent;flex:1;min-height:0;">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
          <div style="width:36px;height:36px;background:${colorHex};flex-shrink:0;"></div>
          <div>
            <div style="font-size:14px;color:#e8e8f8;">${escHtml(playerDef.name)}</div>
            <div style="font-size:10px;color:#8899aa;">${escHtml(playerDef.speciesName)} · ${escHtml(playerDef.className)} ${playerDef.level}</div>
          </div>
        </div>

        <div style="display:flex;gap:8px;margin-bottom:10px;">
          <div style="flex:1;padding:6px 8px;border:1px solid ${DIM};background:#0a0a18;">
            <div style="font-size:9px;color:#556677;letter-spacing:1px;">HP</div>
            <div style="font-size:14px;color:#aabbcc;">${state.hp} / ${playerDef.maxHp}</div>
          </div>
          <div style="flex:1;padding:6px 8px;border:1px solid ${DIM};background:#0a0a18;">
            <div style="font-size:9px;color:#556677;letter-spacing:1px;">AC</div>
            <div style="font-size:14px;color:#aabbcc;">${playerDef.ac}</div>
          </div>
          <div style="flex:1;padding:6px 8px;border:1px solid ${DIM};background:#0a0a18;">
            <div style="font-size:9px;color:#556677;letter-spacing:1px;">SPEED</div>
            <div style="font-size:14px;color:#aabbcc;">${playerDef.speed} ft</div>
          </div>
          <div style="flex:1;padding:6px 8px;border:1px solid ${DIM};background:#0a0a18;">
            <div style="font-size:9px;color:#556677;letter-spacing:1px;">INIT</div>
            <div style="font-size:14px;color:#aabbcc;">${signed(dexMod)}</div>
          </div>
          <div style="flex:1;padding:6px 8px;border:1px solid ${DIM};background:#0a0a18;">
            <div style="font-size:9px;color:#556677;letter-spacing:1px;">PROF</div>
            <div style="font-size:14px;color:#aabbcc;">+${playerDef.proficiencyBonus}</div>
          </div>
        </div>

        <div style="font-size:10px;color:#556677;letter-spacing:1px;margin-bottom:6px;">ABILITY SCORES</div>
        <div style="display:flex;gap:4px;margin-bottom:10px;">${abilityCells}</div>

        <div style="font-size:10px;color:#556677;letter-spacing:1px;margin-bottom:6px;">SAVING THROWS</div>
        <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:0 16px;padding:0 4px;margin-bottom:10px;">
          ${saveCells}
        </div>

        <div style="font-size:10px;color:#556677;letter-spacing:1px;margin-bottom:6px;">RESOURCES</div>
        <div style="font-size:11px;color:#aabbcc;line-height:1.6;">
          XP: ${state.xp} · Gold: ${state.gold} GP · Passive Perception: ${passivePerception}
          ${concLine}
        </div>
      </div>`);
  }

  // ── Inventory tab (preserves prior InventoryOverlay behaviour) ─────────────

  private renderInventoryTab(): void {
    const { playerDef, state, equippedItems, inventory, canUseConsumable } = this.inputs;
    const slotDefs: { key: "armor" | "weapon" | "shield"; label: string }[] = [
      { key: "armor",  label: "ARMOR"   },
      { key: "weapon", label: "WEAPON"  },
      { key: "shield", label: "OFFHAND" },
    ];

    const slotCards = slotDefs.map(({ key, label }) => {
      const item = equippedItems[key];
      const borderColor = item ? ACCENT : DIM;
      let inner: string;
      if (item) {
        const serverLabel = state.equippedSlotLabels[key] ?? "";
        inner = `
          <div style="font-size:11px;color:#c8dae8;margin-bottom:4px;">${escHtml(item.name)}</div>
          <div style="font-size:10px;color:${ACCENT};margin-bottom:8px;">${escHtml(serverLabel)}</div>
          <button data-unequip="${key}" class="gui-btn-overlay" style="width:90px;height:22px;background:#1a1a2e;
            border:1px solid ${DIM};color:#889aaa;font-size:10px;">UNEQUIP</button>`;
      } else {
        inner = `<div style="font-size:18px;color:#334455;">—</div>`;
      }
      return `
        <div style="flex:1;border:1px solid ${borderColor};background:#0a0a18;
          padding:8px 6px;display:flex;flex-direction:column;align-items:center;text-align:center;">
          <div style="font-size:10px;color:#556677;margin-bottom:6px;">${label}</div>
          ${inner}
        </div>`;
    }).join("");

    const equippable  = inventory.filter(isEquipmentDef);
    const consumables = inventory.filter((i) => i.type === "consumable");
    const ammunition  = inventory.filter((i) => i.type === "ammunition");
    const gear        = inventory.filter((i) => i.type === "gear");

    const eqGroups: { item: EquipmentDef; count: number }[] = [];
    equippable.forEach((item) => {
      const existing = eqGroups.find((g) => g.item.id === item.id);
      if (existing) existing.count++;
      else eqGroups.push({ item, count: 1 });
    });

    const cGroups: Record<string, { name: string; count: number }> = {};
    consumables.forEach((c) => {
      if (!cGroups[c.id]) cGroups[c.id] = { name: c.name, count: 0 };
      cGroups[c.id].count++;
    });

    const eqRows = eqGroups.map(({ item, count }) => {
      const label = count > 1
        ? `${escHtml(item.name)} ×${count}  ·  ${escHtml(slotLabel(item, playerDef))}`
        : `${escHtml(item.name)}  ·  ${escHtml(slotLabel(item, playerDef))}`;
      const slot: "armor" | "weapon" | "shield" =
        item.type === "armor" ? "armor" : item.type === "weapon" ? "weapon" : "shield";
      return `
        <div style="display:flex;align-items:center;justify-content:space-between;height:28px;padding:0 2px;">
          <span style="font-size:11px;color:#b0c8dc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;margin-right:8px;">
            ${label}
          </span>
          <button data-equip="${slot}|${escHtml(item.id)}" class="gui-btn-overlay"
            style="width:72px;height:22px;background:#0a1520;border:1px solid ${ACCENT};color:${ACCENT};font-size:10px;">
            EQUIP
          </button>
        </div>`;
    }).join("");

    const useColor  = canUseConsumable ? "#66aa66" : "#445544";
    const useBorder = canUseConsumable ? "#4a8a4a" : DIM;
    const useBg     = canUseConsumable ? "#1a3a1a" : "#111111";
    const cRows = Object.entries(cGroups).map(([id, { name, count }]) => `
      <div style="display:flex;align-items:center;justify-content:space-between;height:28px;padding:0 2px;">
        <span style="font-size:11px;color:#668877;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;margin-right:8px;">
          ${escHtml(name)} ×${count}
        </span>
        <button ${canUseConsumable ? `data-use="${escHtml(id)}"` : "disabled"} class="gui-btn-overlay"
          style="width:72px;height:22px;background:${useBg};border:1px solid ${useBorder};color:${useColor};font-size:10px;">
          USE
        </button>
      </div>`).join("");

    const aGroups: Record<string, { name: string; count: number }> = {};
    ammunition.forEach((a) => {
      if (!aGroups[a.id]) aGroups[a.id] = { name: a.name, count: 0 };
      aGroups[a.id].count++;
    });
    const aRows = Object.entries(aGroups).map(([_id, { name, count }]) => `
      <div style="display:flex;align-items:center;justify-content:space-between;height:24px;padding:0 2px;">
        <span style="font-size:11px;color:#778899;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;margin-right:8px;">
          ${escHtml(name)} ×${count}
        </span>
        <span style="font-size:9px;color:#445566;width:72px;text-align:center;">AMMO</span>
      </div>`).join("");

    const gGroups: Record<string, { name: string; count: number }> = {};
    gear.forEach((g) => {
      if (!gGroups[g.id]) gGroups[g.id] = { name: g.name, count: 0 };
      gGroups[g.id].count++;
    });
    const gRows = Object.entries(gGroups).map(([_id, { name, count }]) => `
      <div style="display:flex;align-items:center;justify-content:space-between;height:24px;padding:0 2px;">
        <span style="font-size:11px;color:#778899;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;margin-right:8px;">
          ${escHtml(name)}${count > 1 ? " ×" + count : ""}
        </span>
        <span style="font-size:9px;color:#445566;width:72px;text-align:center;">GEAR</span>
      </div>`).join("");

    const emptyCarried = eqGroups.length === 0 && Object.keys(cGroups).length === 0 && Object.keys(aGroups).length === 0 && Object.keys(gGroups).length === 0
      ? `<div style="font-size:11px;color:#334455;padding:8px 2px;">No items carried.</div>`
      : "";

    const mainStatMod = playerDef.mainAttack.statKey === "str" ? mod(playerDef.str) : mod(playerDef.dex);
    const atkText = attackSummary(playerDef.mainAttack, mainStatMod);

    this.contentEl.insertAdjacentHTML("beforeend", `
      <div style="font-size:10px;color:#556677;margin-bottom:6px;">EQUIPPED</div>
      <div style="display:flex;gap:8px;margin-bottom:8px;" data-slot-area></div>

      <div style="height:1px;background:${DIM};margin:6px 0;"></div>
      <div style="font-size:10px;color:#556677;margin-bottom:4px;">CARRIED</div>
      <div style="flex:1;overflow-y:auto;scrollbar-width:thin;scrollbar-color:${ACCENT} transparent;min-height:0;" data-carry-area>
        ${eqRows}${cRows}${aRows}${gRows}${emptyCarried}
      </div>

      <div style="height:1px;background:${DIM};margin:6px 0;"></div>
      <div style="font-size:11px;color:${ACCENT};text-align:center;padding-bottom:4px;">
        AC ${playerDef.ac}  ·  ${state.gold} GP  ·  ${escHtml(playerDef.mainAttack.name)} ${escHtml(atkText)}
      </div>
    `);

    const slotArea = this.contentEl.querySelector("[data-slot-area]") as HTMLElement;
    slotArea.innerHTML = slotCards;

    this.contentEl.querySelectorAll<HTMLButtonElement>("[data-unequip]").forEach(btn => {
      const slot = btn.dataset.unequip as "armor" | "weapon" | "shield";
      btn.addEventListener("pointerdown", () => this.callbacks.onUnequip(slot));
    });
    this.contentEl.querySelectorAll<HTMLButtonElement>("[data-equip]").forEach(btn => {
      const [slot, itemId] = btn.dataset.equip!.split("|") as ["armor" | "weapon" | "shield", string];
      btn.addEventListener("pointerdown", () => this.callbacks.onEquip(slot, itemId));
    });
    this.contentEl.querySelectorAll<HTMLButtonElement>("[data-use]").forEach(btn => {
      btn.addEventListener("pointerdown", () => this.callbacks.onUse(btn.dataset.use!));
    });
  }

  // ── Spells tab ─────────────────────────────────────────────────────────────

  private renderSpellsTab(): void {
    const { playerDef, state, allSpells } = this.inputs;
    const ability = playerDef.spellcastingAbility;
    if (!ability) {
      this.contentEl.insertAdjacentHTML("beforeend", `<div style="font-size:11px;color:#334455;">This character has no spellcasting ability.</div>`);
      return;
    }
    const abilityMod = mod(playerDef[ability]);
    const saveDC     = 8 + playerDef.proficiencyBonus + abilityMod;
    const atkBonus   = playerDef.proficiencyBonus + abilityMod;
    const byId = Object.fromEntries(allSpells.map((s) => [s.id, s]));

    const cantripIds = playerDef.defaultCantripIds ?? [];
    const bookIds    = playerDef.defaultSpellbookIds ?? [];
    const preparedSet = new Set(state.preparedSpellIds);

    const renderSpellRow = (id: string, opts: { prepared?: boolean; tag?: string } = {}): string => {
      const sp = byId[id];
      if (!sp) return `<div style="font-size:10px;color:#445566;padding:2px 0;">${escHtml(id)} (unknown)</div>`;
      const bits: string[] = [];
      if (sp.damage) bits.push(`${sp.damage.dice}d${sp.damage.sides}${sp.damage.bonus ? "+" + sp.damage.bonus : ""} ${sp.damage.type}`);
      if (sp.save) bits.push(`${sp.save.ability.toUpperCase()} save DC ${saveDC}`);
      if (sp.area) bits.push(`${sp.area.sizeFeet}-ft ${sp.area.shape}`);
      else if (sp.rangeFeet > 0) bits.push(`${sp.rangeFeet} ft`);
      if (sp.concentration) bits.push("Concentration");
      const tag = opts.tag ?? (sp.level === 0 ? "cantrip" : `L${sp.level}`);
      const tagColor = opts.prepared ? ACCENT : "#778899";
      return `
        <div style="display:flex;align-items:baseline;justify-content:space-between;padding:3px 4px;border-bottom:1px solid #1a2030;">
          <span style="font-size:11px;color:${opts.prepared ? "#c8dae8" : "#778899"};">${escHtml(sp.name)}</span>
          <span style="font-size:9px;color:#556677;text-align:right;flex:1;margin-left:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(bits.join(" · "))}</span>
          <span style="font-size:9px;color:${tagColor};margin-left:10px;min-width:42px;text-align:right;">${escHtml(tag)}</span>
        </div>`;
    };

    const slotsLine = state.spellSlots.length > 0
      ? state.spellSlots
          .map((n, i) => (n > 0 || (playerDef.defaultSpellSlots?.[i] ?? 0) > 0
            ? `L${i + 1} ${n}/${playerDef.defaultSpellSlots?.[i] ?? n}`
            : ""))
          .filter(Boolean)
          .join("  ·  ")
      : "—";

    const cantripRows  = cantripIds.map((id) => renderSpellRow(id, { prepared: true })).join("") || `<div style="font-size:10px;color:#445566;padding:4px 4px;">No cantrips known.</div>`;
    const preparedRows = state.preparedSpellIds.map((id) => renderSpellRow(id, { prepared: true })).join("") || `<div style="font-size:10px;color:#445566;padding:4px 4px;">No spells prepared.</div>`;
    const bookOnly     = bookIds.filter((id) => !preparedSet.has(id));
    const bookRows     = bookOnly.length > 0
      ? bookOnly.map((id) => renderSpellRow(id, { prepared: false })).join("")
      : "";

    this.contentEl.insertAdjacentHTML("beforeend", `
      <div style="overflow-y:auto;scrollbar-width:thin;scrollbar-color:${ACCENT} transparent;flex:1;min-height:0;">
        <div style="display:flex;gap:8px;margin-bottom:10px;">
          <div style="flex:1;padding:6px 8px;border:1px solid ${DIM};background:#0a0a18;">
            <div style="font-size:9px;color:#556677;letter-spacing:1px;">SAVE DC</div>
            <div style="font-size:14px;color:#aabbcc;">${saveDC}</div>
          </div>
          <div style="flex:1;padding:6px 8px;border:1px solid ${DIM};background:#0a0a18;">
            <div style="font-size:9px;color:#556677;letter-spacing:1px;">SPELL ATK</div>
            <div style="font-size:14px;color:#aabbcc;">${signed(atkBonus)}</div>
          </div>
          <div style="flex:2;padding:6px 8px;border:1px solid ${DIM};background:#0a0a18;">
            <div style="font-size:9px;color:#556677;letter-spacing:1px;">SLOTS</div>
            <div style="font-size:12px;color:#aabbcc;">${escHtml(slotsLine)}</div>
          </div>
        </div>

        <div style="font-size:10px;color:#556677;letter-spacing:1px;margin-bottom:4px;">CANTRIPS (${cantripIds.length})</div>
        ${cantripRows}

        <div style="height:8px;"></div>
        <div style="font-size:10px;color:#556677;letter-spacing:1px;margin-bottom:4px;">PREPARED (${state.preparedSpellIds.length})</div>
        ${preparedRows}

        ${bookRows ? `
          <div style="height:8px;"></div>
          <div style="font-size:10px;color:#556677;letter-spacing:1px;margin-bottom:4px;">SPELLBOOK · UNPREPARED (${bookOnly.length})</div>
          ${bookRows}
        ` : ""}
      </div>
    `);
  }
}
