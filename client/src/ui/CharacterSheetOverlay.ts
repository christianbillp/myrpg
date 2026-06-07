// Character sheet overlay — four tabs:
//   - Stats     (ability scores, saving throws, skills, conditions/effects)
//   - Story     (background description, origin, species)
//   - Equipment (slots + carried items — same behaviour as the prior Inventory tab)
//   - Spells    (caster-only, hidden when `spellcastingAbility` is absent)
//
// Mirrors the setup-time CharacterDetail panel so the same character info
// reads the same way before and during a session.

import { BaseOverlay } from "./BaseOverlay";
import { PlayerDef, PlayerAttack } from "../../../shared/types";
import { ItemDef, ArmorDef, WeaponDef, ShieldDef, EquipmentDef, itemDisplayName, isItemIdentified } from "../../../shared/types";
import { UIScale } from "./UIScale";
import type { PlayerState, SpellDef, FeatureDef, ClassDef, SubclassDef } from "../../../shared/types";
import { featuresAt as cpFeaturesAt, subclassFeaturesAt, subclassGrantedSpellsAt, subclassGrantedCantripsAt } from "../../../shared/classProgression";
import { buildPlayerStatusChips, STATUS_TONE_COLOR } from "./PlayerStatus";
import { formatCoins } from "../../../shared/currency";
import { readQuickcast, toggleQuickcast } from "./quickcastPrefs";

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

function titleCase(s: string): string {
  return s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const ACCENT = "#7aadcc";
const DIM    = "#334455";

type Ability = "str" | "dex" | "con" | "int" | "wis" | "cha";

/** SRD 5.2.1 skill list with source ability. Keys match `PlayerDef.skills`
 *  Record entries (`request_ability_check` reads the same keys). */
const SKILLS: Array<{ key: string; label: string; ability: Ability }> = [
  { key: "acrobatics",      label: "Acrobatics",       ability: "dex" },
  { key: "animalHandling",  label: "Animal Handling",  ability: "wis" },
  { key: "arcana",          label: "Arcana",           ability: "int" },
  { key: "athletics",       label: "Athletics",        ability: "str" },
  { key: "deception",       label: "Deception",        ability: "cha" },
  { key: "history",         label: "History",          ability: "int" },
  { key: "insight",         label: "Insight",          ability: "wis" },
  { key: "intimidation",    label: "Intimidation",     ability: "cha" },
  { key: "investigation",   label: "Investigation",    ability: "int" },
  { key: "medicine",        label: "Medicine",         ability: "wis" },
  { key: "nature",          label: "Nature",           ability: "int" },
  { key: "perception",      label: "Perception",       ability: "wis" },
  { key: "performance",     label: "Performance",      ability: "cha" },
  { key: "persuasion",      label: "Persuasion",       ability: "cha" },
  { key: "religion",        label: "Religion",         ability: "int" },
  { key: "sleightOfHand",   label: "Sleight of Hand",  ability: "dex" },
  { key: "stealth",         label: "Stealth",          ability: "dex" },
  { key: "survival",        label: "Survival",         ability: "wis" },
];

const ABILITY_LABEL: Record<Ability, string> = {
  str: "Str", dex: "Dex", con: "Con", int: "Int", wis: "Wis", cha: "Cha",
};

type TabId = "stats" | "features" | "story" | "equipment" | "spells";

export interface CharacterSheetCallbacks {
  onEquip: (slot: "armor" | "weapon" | "shield", itemId: string) => void;
  onUnequip: (slot: "armor" | "weapon" | "shield") => void;
  onUse: (itemId: string) => void;
  /** Read a spell scroll (US-124): server casts the scroll's spell and consumes it. */
  onCastScroll: (itemId: string) => void;
  /** Begin a normal cast for the named spell. Caller handles target prompting + closing the sheet. */
  onCastSpell: (spellId: string) => void;
  /** Begin a ritual cast for the named spell (no slot, exploring-only). */
  onRitualCast: (spellId: string) => void;
  /** The player added/removed a spell from the quickcast menu — refresh the panel. */
  onQuickcastChanged: () => void;
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
  /** Spell ids the engine considers currently castable (action-economy + slot ok). */
  castableSpellIds: string[];
  /** Phase — gates ritual casting (exploring-only). */
  isExploring: boolean;
  /** Feature defs (full catalogue). The Features tab cross-references the
   *  character's class progression against this list to render id → name +
   *  description for every feature the character has at their current level. */
  features: FeatureDef[];
  /** Class defs (full catalogue). Used by the Features tab to walk the
   *  class's progression entries 1..currentLevel and list every granted
   *  feature alongside the level it was granted at. */
  classes: ClassDef[];
  /** Subclass defs (full catalogue). When the player picks a subclass
   *  (`playerDef.subclassId`), the Features tab also walks its progression
   *  for the levels the parent class reaches. */
  subclasses: SubclassDef[];
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
    initialTab: TabId = "equipment",
  ) {
    super(scale, 760, 640, ACCENT, callbacks.onClose);
    this.inputs = inputs;
    this.callbacks = callbacks;
    this.currentTab = inputs.playerDef.spellcastingAbility || initialTab !== "spells" ? initialTab : "equipment";

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
      this.currentTab = "equipment";
    }
    this.renderTabs();
    this.renderActiveTab();
  }

  // ── Tab bar ────────────────────────────────────────────────────────────────

  private renderTabs(): void {
    const hasSpells = !!this.inputs.playerDef.spellcastingAbility;
    const tabs: { id: TabId; label: string }[] = [
      { id: "stats",     label: "Stats" },
      { id: "features",  label: "Features" },
      { id: "story",     label: "Story" },
      { id: "equipment", label: "Equipment" },
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
      case "stats":     this.renderStatsTab();     break;
      case "features":  this.renderFeaturesTab();  break;
      case "story":     this.renderStoryTab();     break;
      case "equipment": this.renderInventoryTab(); break;
      case "spells":    this.renderSpellsTab();    break;
    }
  }

  // ── Stats tab ──────────────────────────────────────────────────────────────

  private renderStatsTab(): void {
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

    // Skills — derive proficiency tier from the stored total vs the raw
    // ability mod. Difference of `proficiencyBonus` = proficient; `2× prof`
    // = expertise (Scholar / Rogue Expertise); anything else = untrained,
    // unless the total still differs from the raw mod (race/feat bonus —
    // shown without a badge but with the actual number).
    const prof = playerDef.proficiencyBonus;
    const skillCells = SKILLS.map(({ key, label, ability }) => {
      const abilityMod = mod(playerDef[ability]);
      const total = playerDef.skills?.[key] ?? abilityMod;
      const bonusFromProf = total - abilityMod;
      let badge: string;
      let color: string;
      if (bonusFromProf >= prof * 2)      { badge = "◆"; color = "#e2b96f"; } // expertise
      else if (bonusFromProf >= prof)     { badge = "●"; color = ACCENT;    } // proficient
      else                                { badge = "○"; color = "#778899"; } // untrained
      return `
        <div style="display:flex;justify-content:space-between;padding:2px 0;">
          <span style="font-size:10px;color:${color};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
            ${badge} ${label} <span style="color:#556677;">(${ABILITY_LABEL[ability]})</span>
          </span>
          <span style="font-size:10px;color:#aabbcc;flex-shrink:0;">${signed(total)}</span>
        </div>`;
    }).join("");

    // Active conditions, buffs, debuffs, ongoing effects, and concentration
    // — sourced from the same helper the Player Panel uses, so both views
    // agree on what's affecting the character right now.
    const statusChips = buildPlayerStatusChips(state, concentratingOnName);
    const statusBlock = statusChips.length === 0
      ? `<div style="font-size:11px;color:${DIM};font-style:italic;">No active conditions or effects.</div>`
      : `<div style="display:flex;flex-wrap:wrap;gap:6px;">` + statusChips.map((c) => {
          const palette = STATUS_TONE_COLOR[c.tone];
          const title = c.tooltip ? ` title="${escHtml(c.tooltip)}"` : "";
          return `<span${title} style="background:${palette.bg};color:${palette.text};border:1px solid ${palette.border};padding:3px 8px;font-size:10px;line-height:1.4;font-family:monospace;">${escHtml(c.label)}</span>`;
        }).join("") + `</div>`;

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
            <div style="font-size:9px;color:#556677;letter-spacing:1px;">AC${state.mageArmor ? " (Mage Armor)" : ""}</div>
            <div style="font-size:14px;color:#aabbcc;">${state.ac}</div>
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

        <div style="font-size:10px;color:#556677;letter-spacing:1px;margin-bottom:6px;">CONDITIONS &amp; EFFECTS</div>
        <div style="margin-bottom:12px;">
          ${statusBlock}
        </div>

        <div style="font-size:10px;color:#556677;letter-spacing:1px;margin-bottom:6px;">ABILITY SCORES</div>
        <div style="display:flex;gap:4px;margin-bottom:10px;">${abilityCells}</div>

        <div style="font-size:10px;color:#556677;letter-spacing:1px;margin-bottom:6px;">SAVING THROWS</div>
        <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:0 16px;padding:0 4px;margin-bottom:10px;">
          ${saveCells}
        </div>

        <div style="font-size:10px;color:#556677;letter-spacing:1px;margin-bottom:6px;">SKILLS  <span style="color:#445566;">○ untrained · ● proficient · ◆ expertise</span></div>
        <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:0 16px;padding:0 4px;margin-bottom:10px;">
          ${skillCells}
        </div>

        <div style="font-size:10px;color:#556677;letter-spacing:1px;margin-bottom:6px;">RESOURCES</div>
        <div style="font-size:11px;color:#aabbcc;line-height:1.6;">
          XP: ${state.xp} · Coins: ${escHtml(formatCoins(state.balanceCp))} · Passive Perception: ${passivePerception}
        </div>
      </div>`);
  }

  // ── Features tab ───────────────────────────────────────────────────────────
  //
  // Walks the class JSON's `progression[]` from L1 up through the character's
  // current level, listing every feature granted at each level. If a
  // subclass has been chosen (`playerDef.subclassId`), the subclass's
  // `progression[]` is walked in parallel for the same level range and
  // surfaced under a labelled section. Features that exist as data in
  // `defs.features` render with their full SRD description; ids without a
  // file render with the id as a fallback name and a placeholder description
  // so a content gap is visible rather than silent.

  private renderFeaturesTab(): void {
    const { playerDef, features, classes, subclasses } = this.inputs;
    const className = (playerDef.className ?? "").toLowerCase();
    const classDef = classes.find((c) => c.id.toLowerCase() === className) ?? null;
    const subclassDef = playerDef.subclassId
      ? (subclasses.find((s) => s.id === playerDef.subclassId) ?? null)
      : null;
    const currentLevel = Math.max(1, Math.min(20, playerDef.level));

    type Row = { level: number; featureId: string; source: string };

    const classRows: Row[] = [];
    if (classDef) {
      const seen = new Set<string>();
      for (let lvl = 1; lvl <= currentLevel; lvl++) {
        for (const fid of cpFeaturesAt(classDef, lvl)) {
          if (seen.has(fid)) continue;
          seen.add(fid);
          classRows.push({ level: lvl, featureId: fid, source: `${classDef.name} L${lvl}` });
        }
      }
    }

    const subclassRows: Row[] = [];
    let subclassGrantedSpellIds: string[] = [];
    let subclassGrantedCantripIds: string[] = [];
    if (classDef && subclassDef) {
      const seen = new Set<string>();
      for (let lvl = 1; lvl <= currentLevel; lvl++) {
        for (const fid of subclassFeaturesAt(subclassDef, lvl)) {
          if (seen.has(fid)) continue;
          seen.add(fid);
          subclassRows.push({ level: lvl, featureId: fid, source: `${subclassDef.name} L${lvl}` });
        }
        subclassGrantedSpellIds = subclassGrantedSpellIds.concat(subclassGrantedSpellsAt(subclassDef, lvl));
        subclassGrantedCantripIds = subclassGrantedCantripsAt
          ? subclassGrantedCantripIds.concat(subclassGrantedCantripsAt(subclassDef, lvl))
          : subclassGrantedCantripIds;
      }
    }

    const renderFeatureRow = (row: Row): string => {
      const def = features.find((f) => f.id === row.featureId);
      const name = def?.name ?? titleCase(row.featureId.replace(/-/g, " "));
      const desc = def?.description ?? `(No data authored for "${row.featureId}" — feature granted but its mechanics are not yet implemented.)`;
      return `
        <div style="border-left:2px solid #2a6655;padding:6px 12px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;">
            <div style="font-size:13px;color:${ACCENT};font-weight:bold;">${escHtml(name)}</div>
            <div style="font-size:9px;color:#556677;letter-spacing:1px;flex-shrink:0;">${escHtml(row.source.toUpperCase())}</div>
          </div>
          <div style="margin-top:4px;font-size:11px;color:#aabbcc;line-height:1.55;">${escHtml(desc)}</div>
        </div>`;
    };

    const classBlock = classRows.length === 0
      ? `<div style="font-size:11px;color:${DIM};font-style:italic;">No class features yet.</div>`
      : classRows.map(renderFeatureRow).join("");

    const subclassHeader = subclassDef
      ? `
        <div style="font-size:10px;color:#556677;letter-spacing:2px;margin:18px 0 8px;">${escHtml(subclassDef.name.toUpperCase())} — SUBCLASS</div>
        <div style="font-size:11px;color:#889aaa;line-height:1.55;margin-bottom:10px;">${escHtml(subclassDef.description)}</div>`
      : "";
    const subclassBlock = !subclassDef
      ? ""
      : subclassRows.length === 0
        ? `<div style="font-size:11px;color:${DIM};font-style:italic;">No subclass features unlocked yet at L${currentLevel}.</div>`
        : subclassRows.map(renderFeatureRow).join("");

    const grantedSpellsBlock = (subclassGrantedSpellIds.length === 0 && subclassGrantedCantripIds.length === 0)
      ? ""
      : `
        <div style="font-size:10px;color:#556677;letter-spacing:2px;margin:18px 0 6px;">SUBCLASS-GRANTED SPELLS</div>
        <div style="font-size:11px;color:#aabbcc;line-height:1.5;">
          ${[...subclassGrantedCantripIds, ...subclassGrantedSpellIds].map((id) => escHtml(id)).join(", ")}
        </div>
        <div style="font-size:9px;color:#556677;margin-top:4px;font-style:italic;">Always prepared — does not count against your prep limit.</div>`;

    this.contentEl.insertAdjacentHTML("beforeend", `
      <div style="overflow-y:auto;scrollbar-width:thin;scrollbar-color:${ACCENT} transparent;flex:1;min-height:0;">
        <div style="font-size:10px;color:#556677;letter-spacing:2px;margin-bottom:8px;">${escHtml((classDef?.name ?? playerDef.className).toUpperCase())} — CLASS</div>
        ${classBlock}
        ${subclassHeader}
        ${subclassBlock}
        ${grantedSpellsBlock}
      </div>`);
  }

  // ── Story tab ──────────────────────────────────────────────────────────────

  private renderStoryTab(): void {
    const { playerDef } = this.inputs;
    const origin = titleCase(playerDef.backgroundId);
    const lineageTitle = playerDef.speciesLineage ? titleCase(playerDef.speciesLineage) : "";
    // Skip the lineage suffix when it merely repeats the species name
    // (e.g. "High Elf" / "high-elf").
    const lineage = lineageTitle && lineageTitle.toLowerCase() !== playerDef.speciesName.toLowerCase()
      ? ` · ${lineageTitle}` : "";
    const description = playerDef.description ?? "No background description recorded.";

    this.contentEl.insertAdjacentHTML("beforeend", `
      <div style="overflow-y:auto;scrollbar-width:thin;scrollbar-color:${ACCENT} transparent;flex:1;min-height:0;">
        <div style="font-size:10px;color:#556677;letter-spacing:1px;margin-bottom:6px;">ORIGIN</div>
        <div style="font-size:11px;color:#c8d8e8;margin-bottom:12px;line-height:1.5;">${escHtml(origin)}</div>

        <div style="font-size:10px;color:#556677;letter-spacing:1px;margin-bottom:6px;">SPECIES</div>
        <div style="font-size:11px;color:#c8d8e8;margin-bottom:12px;line-height:1.5;">${escHtml(playerDef.speciesName)}${escHtml(lineage)}</div>

        <div style="font-size:10px;color:#556677;letter-spacing:1px;margin-bottom:6px;">BACKGROUND</div>
        <div style="font-size:11px;color:#aabbcc;line-height:1.6;white-space:pre-wrap;">${escHtml(description)}</div>
      </div>`);
  }

  // ── Equipment tab (preserves prior InventoryOverlay behaviour) ─────────────

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
    const scrolls     = inventory.filter((i) => i.type === "scroll");

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
      // US-124: an unidentified item shows a masked name and hides its
      // mechanical label until identified.
      const identified = isItemIdentified(item, state.identifiedItemIds);
      const dispName = itemDisplayName(item, state.identifiedItemIds);
      const tail = identified ? `  ·  ${escHtml(slotLabel(item, playerDef))}` : `  ·  <span style="color:#7a5aaa;">unidentified</span>`;
      const label = count > 1
        ? `${escHtml(dispName)} ×${count}${tail}`
        : `${escHtml(dispName)}${tail}`;
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

    // Spell scrolls (US-124): each lists a CAST button that reads the scroll
    // (server resolves the spell + targeting; the scroll is consumed).
    const scrollRows = scrolls.map((sc) => `
      <div style="display:flex;align-items:center;justify-content:space-between;height:28px;padding:0 2px;">
        <span style="font-size:11px;color:#b59bd8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;margin-right:8px;">
          ${escHtml(itemDisplayName(sc, state.identifiedItemIds))}
        </span>
        <button data-cast-scroll="${escHtml(sc.id)}" class="gui-btn-overlay"
          style="width:72px;height:22px;background:#1a1030;border:1px solid #7a5aaa;color:#c9b3e8;font-size:10px;">
          CAST
        </button>
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

    const emptyCarried = eqGroups.length === 0 && Object.keys(cGroups).length === 0 && Object.keys(aGroups).length === 0 && Object.keys(gGroups).length === 0 && scrolls.length === 0
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
        ${eqRows}${cRows}${scrollRows}${aRows}${gRows}${emptyCarried}
      </div>

      <div style="height:1px;background:${DIM};margin:6px 0;"></div>
      <div style="font-size:11px;color:${ACCENT};text-align:center;padding-bottom:4px;">
        AC ${state.ac}${state.mageArmor ? " (Mage Armor)" : ""}  ·  ${escHtml(formatCoins(state.balanceCp))}  ·  ${escHtml(playerDef.mainAttack.name)} ${escHtml(atkText)}
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
    this.contentEl.querySelectorAll<HTMLButtonElement>("[data-cast-scroll]").forEach(btn => {
      btn.addEventListener("pointerdown", () => this.callbacks.onCastScroll(btn.dataset.castScroll!));
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

    const castableSet = new Set(this.inputs.castableSpellIds);
    const quickcastSet = new Set(readQuickcast(playerDef.id));
    const isExploring = this.inputs.isExploring;

    // SRD Somatic/Material component gate (US-116): mirror the server's
    // free-hand count so the disabled-CAST tooltip can explain a both-hands-
    // occupied block. A two-handed weapon (or a versatile weapon without a
    // shield) takes both hands; a one-handed weapon and a shield take one each.
    const wpn = this.inputs.equippedItems.weapon;
    const shield = this.inputs.equippedItems.shield;
    let handsUsed = 0;
    if (shield) handsUsed += 1;
    if (wpn && wpn.type === "weapon") {
      handsUsed += wpn.twoHanded ? 2 : 1;  // Versatile counts as one hand for components.
    } else if (wpn) {
      handsUsed += 1;
    }
    const freeHands = Math.max(0, 2 - handsUsed);

    const renderSpellRow = (id: string, opts: { prepared?: boolean; tag?: string } = {}): string => {
      const sp = byId[id];
      if (!sp) return `<div style="font-size:10px;color:#445566;padding:2px 0;">${escHtml(id)} (unknown)</div>`;
      const bits: string[] = [];
      if (sp.damage) {
        const perHit = `${sp.damage.dice}d${sp.damage.sides}${sp.damage.bonus ? "+" + sp.damage.bonus : ""}`;
        // Magic Missile-style spells fire N guaranteed darts; surface the
        // per-cast total so the tip reads "3×(1d4+1) force" rather than
        // hiding the dart count.
        bits.push(sp.darts && sp.darts > 1
          ? `${sp.darts}×(${perHit}) ${sp.damage.type}`
          : `${perHit} ${sp.damage.type}`);
      }
      if (sp.save) bits.push(`${sp.save.ability.toUpperCase()} save DC ${saveDC}`);
      // Always surface range so AOE spells (Minor Illusion, Fog Cloud, …)
      // don't drop their range chip just because they also have an area
      // shape — the area says HOW BIG, the range says HOW FAR.
      if (sp.range === 'self') bits.push("self");
      else if (sp.range === 'touch') bits.push("touch");
      else if (sp.rangeFeet > 0) bits.push(`${sp.rangeFeet} ft`);
      if (sp.area) bits.push(`${sp.area.sizeFeet}-ft ${sp.area.shape}`);
      if (sp.concentration) bits.push("Concentration");
      if (sp.ritual) bits.push("Ritual");
      // Reaction-cast spells (Shield, Feather Fall) are easy to miss in the
      // spellbook — surface the keyword so the player knows the slot is
      // spent as a reaction, not on their turn.
      if (sp.castingTime === 'reaction') bits.push("Reaction");
      else if (sp.castingTime === 'bonus-action') bits.push("Bonus Action");
      const tag = opts.tag ?? (sp.level === 0 ? "cantrip" : `L${sp.level}`);
      const tagColor = opts.prepared ? ACCENT : "#778899";

      // Buttons:
      //   CAST         — enabled iff the engine considers the spell castable now
      //                  (i.e. it's in `castableSpellIds`). Known spells that
      //                  aren't currently castable render the same button
      //                  greyed out with a tooltip explaining the gate, so
      //                  the player doesn't have to guess why the spell
      //                  vanished from the row.
      //   RITUAL CAST  — visible iff the spell has the Ritual tag AND the
      //                  character knows it (cantrip / spellbook); only enabled
      //                  out of combat (exploring phase).
      const castable = castableSet.has(id);
      const enabledCastStyle  = `margin-left:8px;width:54px;height:20px;background:#0a1520;border:1px solid ${ACCENT};color:${ACCENT};font-size:9px;`;
      const disabledCastStyle = `margin-left:8px;width:54px;height:20px;background:#0a0a14;border:1px solid #2a3540;color:#445566;font-size:9px;cursor:not-allowed;`;
      // Resolve the disable reason for the tooltip. Order matters — the
      // first matching gate wins, mirroring the server's `canCastSpell`
      // short-circuits.
      const disableReason = (() => {
        const longCast = sp.castingTime !== 'action' && sp.castingTime !== 'bonus-action' && sp.castingTime !== 'reaction';
        if (longCast && !isExploring) return `Casting time exceeds a combat round (${sp.castingTime}). Castable only out of combat.`;
        if (sp.level > 0 && (state.spellSlots[sp.level - 1] ?? 0) <= 0) return `No L${sp.level} slot remaining.`;
        if ((sp.components?.somatic || !!sp.components?.material) && freeHands < 1) return `No free hand — a Somatic or Material component needs one. Unequip a weapon or shield.`;
        if (sp.castingTime === 'action' && state.actionUsed && !isExploring) return `Action already spent this turn.`;
        if (sp.castingTime === 'bonus-action' && state.bonusActionUsed) return `Bonus Action already spent this turn.`;
        if (sp.castingTime === 'reaction' && !isExploring) return `Reactions auto-fire on their trigger in combat.`;
        return `Not castable right now.`;
      });
      // Only show the disabled-CAST placeholder for cantrips and prepared
      // L1+ spells. Unprepared spellbook entries (bookOnly) intentionally
      // omit CAST altogether — those need to be prepared first.
      const castBtn = castable
        ? `<button data-cast="${escHtml(id)}" class="gui-btn-overlay" style="${enabledCastStyle}">CAST</button>`
        : opts.prepared
          ? `<button disabled title="${escHtml(disableReason())}" class="gui-btn-overlay" style="${disabledCastStyle}">CAST</button>`
          : "";
      const ritualBtn = sp.ritual && isExploring
        ? `<button data-ritual="${escHtml(id)}" class="gui-btn-overlay" style="margin-left:6px;width:78px;height:20px;background:#1a1a2e;border:1px solid #6a5a8e;color:#a89dcc;font-size:9px;">RITUAL CAST</button>`
        : "";
      // Quickcast toggle (✦) — only on prepared/cantrip rows (the castable ones).
      // Filled accent when the spell is in the Player Panel's quickcast menu.
      const inQuick = quickcastSet.has(id);
      const quickBtn = opts.prepared
        ? `<button data-quickcast="${escHtml(id)}" title="${inQuick ? "Remove from quickcast menu" : "Add to quickcast menu (CAST button)"}" class="gui-btn-overlay" style="margin-left:8px;width:22px;height:20px;background:#0a1520;border:1px solid ${inQuick ? ACCENT : "#2a3540"};color:${inQuick ? ACCENT : "#556677"};font-size:11px;">✦</button>`
        : "";

      return `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:3px 4px;border-bottom:1px solid #1a2030;">
          <span title="${escHtml(sp.description)}" style="font-size:11px;color:${opts.prepared ? "#c8dae8" : "#778899"};min-width:120px;cursor:help;">${escHtml(sp.name)}</span>
          <span style="font-size:9px;color:#556677;text-align:right;flex:1;margin-left:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(bits.join(" · "))}</span>
          <span style="font-size:9px;color:${tagColor};margin-left:10px;min-width:42px;text-align:right;">${escHtml(tag)}</span>
          ${quickBtn}
          ${castBtn}
          ${ritualBtn}
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

    this.contentEl.querySelectorAll<HTMLButtonElement>("[data-cast]").forEach((btn) => {
      btn.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        this.callbacks.onCastSpell(btn.dataset.cast!);
      });
    });
    this.contentEl.querySelectorAll<HTMLButtonElement>("[data-ritual]").forEach((btn) => {
      btn.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        this.callbacks.onRitualCast(btn.dataset.ritual!);
      });
    });
    // Quickcast add/remove — client-only pref; re-render the tab to update the ✦.
    this.contentEl.querySelectorAll<HTMLButtonElement>("[data-quickcast]").forEach((btn) => {
      btn.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        toggleQuickcast(playerDef.id, btn.dataset.quickcast!);
        this.callbacks.onQuickcastChanged();
        this.renderActiveTab();
      });
    });
  }
}
