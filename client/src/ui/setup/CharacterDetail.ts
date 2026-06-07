/**
 * CharacterDetail — the tabbed character sheet panel rendered beneath the
 * CharacterCarousel on EncounterSetupScene and AdventureSetupScene. Mirrors
 * the in-game CharacterSheetOverlay tab structure (Stats / Story / Equipment
 * / Spells) so the same character information is presented consistently in
 * setup and in play.
 *
 * Pure HTML — one root `<div>` positioned via `attachPlace`. `setCharacter`
 * swaps the rendered character; `setSave` swaps the save info layer
 * (refreshes HP/XP/GP + button enable state) without rebuilding the rest.
 */
import Phaser from "phaser";
import type { PlayerDef, ItemDef, ArmorDef, WeaponDef, ShieldDef, EquipmentSlots, SpellDef } from "../../../../shared/types";
import { tokenAssetForPlayer } from "../../data/tokens";
import { fixedHpForClass } from "../../../../shared/xpTable";
import { formatCoins } from "../../../../shared/currency";
import { DevMode } from "../../devMode";

const API_URL = "http://localhost:3000";

export interface CharacterDetailSave {
  hp: number;
  xp: number;
  /** Coin purse balance in Copper Pieces — see `shared/currency.ts`. */
  balanceCp: number;
  inventoryIds: string[];
  equippedSlots?: EquipmentSlots;
  levelUps?: unknown[];
}

export interface CharacterDetailCallbacks {
  onDeleteSave: (def: PlayerDef) => void;
  onStorylog: (def: PlayerDef) => void;
  /** Optional — only wired by AdventureSetupScene. Wipes the character's
   *  adventure save (current chapter index, world flags, prior summaries)
   *  but leaves the character's main save (HP, XP, equipment, level-ups)
   *  intact. Renders as a separate dev button next to DELETE SAVE so the
   *  author can debug chapter transitions without having to re-level. */
  onResetAdventure?: (def: PlayerDef) => void;
}

export interface CharacterDetailOptions {
  scene: Phaser.Scene;
  sceneWidth: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Shared equipment registry — used to resolve `equippedSlots` ids back to
   *  item names for the Equipment tab. */
  equipment: ItemDef[];
  /** Shared spell registry — used to look up cantrip / spellbook detail on
   *  the Spells tab. May be empty if the host hasn't loaded spells yet. */
  spells?: SpellDef[];
  callbacks: CharacterDetailCallbacks;
}

type Ability = "str" | "dex" | "con" | "int" | "wis" | "cha";
const SKILLS: Array<{ key: string; label: string; ability: Ability }> = [
  { key: "acrobatics",     label: "Acrobatics",      ability: "dex" },
  { key: "animalHandling", label: "Animal Handling", ability: "wis" },
  { key: "arcana",         label: "Arcana",          ability: "int" },
  { key: "athletics",      label: "Athletics",       ability: "str" },
  { key: "deception",      label: "Deception",       ability: "cha" },
  { key: "history",        label: "History",         ability: "int" },
  { key: "insight",        label: "Insight",         ability: "wis" },
  { key: "intimidation",   label: "Intimidation",    ability: "cha" },
  { key: "investigation",  label: "Investigation",   ability: "int" },
  { key: "medicine",       label: "Medicine",        ability: "wis" },
  { key: "nature",         label: "Nature",          ability: "int" },
  { key: "perception",     label: "Perception",      ability: "wis" },
  { key: "performance",    label: "Performance",     ability: "cha" },
  { key: "persuasion",     label: "Persuasion",      ability: "cha" },
  { key: "religion",       label: "Religion",        ability: "int" },
  { key: "sleightOfHand",  label: "Sleight of Hand", ability: "dex" },
  { key: "stealth",        label: "Stealth",         ability: "dex" },
  { key: "survival",       label: "Survival",        ability: "wis" },
];
const ABILITY_LABEL: Record<Ability, string> = { str: "Str", dex: "Dex", con: "Con", int: "Int", wis: "Wis", cha: "Cha" };

const ACCENT = "#7aadcc";
const DIM    = "#334455";

type TabId = "stats" | "story" | "equipment" | "spells";

export class CharacterDetail {
  private readonly opts: CharacterDetailOptions;
  private readonly root: HTMLDivElement;
  private placeHandler!: () => void;
  private def: PlayerDef | null = null;
  private save: CharacterDetailSave | null = null;
  private currentTab: TabId = "stats";

  constructor(opts: CharacterDetailOptions) {
    this.opts = opts;
    this.root = document.createElement("div");
    this.root.style.cssText = `
      position: absolute;
      background: #111122;
      border: 1px solid #334455;
      box-sizing: border-box;
      overflow: hidden;
      font-family: monospace;
      color: #aabbcc;
      z-index: 9;
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
    `;
    document.body.appendChild(this.root);
    this.renderEmpty();
    this.attachPlace();
  }

  setCharacter(def: PlayerDef): void {
    if (this.def?.id !== def.id) {
      // Reset to Stats tab when switching characters, or clamp away from a
      // spells tab that no longer applies. Within the same character we
      // preserve the user's chosen tab so re-renders don't snap back.
      if (this.currentTab === "spells" && !def.spellcastingAbility) this.currentTab = "stats";
    } else if (this.currentTab === "spells" && !def.spellcastingAbility) {
      this.currentTab = "stats";
    }
    this.def = def;
    this.render();
  }

  setSave(save: CharacterDetailSave | null): void {
    this.save = save;
    if (this.def) this.render();
  }

  /** Drop the displayed character and show the empty placeholder. Used when the
   *  carousel focuses the Create Character card (no character selected). */
  clear(): void {
    this.def = null;
    this.save = null;
    this.renderEmpty();
  }

  destroy(): void {
    this.opts.scene.scale.off("resize", this.placeHandler);
    this.root.remove();
  }

  // ── Rendering ───────────────────────────────────────────────────────────

  private renderEmpty(): void {
    this.root.replaceChildren();
    const empty = document.createElement("div");
    empty.textContent = "No character selected.";
    empty.style.cssText = "font-size: 12px; color: #556677; text-align: center; padding: 40px 0;";
    this.root.appendChild(empty);
  }

  private render(): void {
    if (!this.def) { this.renderEmpty(); return; }
    const def = this.def;
    const save = this.save;
    const colorHex = "#" + def.color.toString(16).padStart(6, "0");
    const maxHp = effectiveMaxHp(def, save);
    const effectiveLevel = def.level + (save?.levelUps?.length ?? 0);
    const dexMod = mod(def.dex);

    this.root.replaceChildren();

    // Header — identity row + top stat strip. Always visible.
    const headerWrap = document.createElement("div");
    headerWrap.style.cssText = "flex-shrink:0;";
    headerWrap.insertAdjacentHTML("beforeend", `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
        <img src="${API_URL}${tokenAssetForPlayer(def)}" alt="${escHtml(def.name)}" style="width:42px;height:42px;flex-shrink:0;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:15px;color:#e8e8f8;">${escHtml(def.name)}</div>
          <div style="font-size:10px;color:#8899aa;margin-top:2px;">${escHtml(def.speciesName)} · ${escHtml(def.className)} ${effectiveLevel}</div>
        </div>
        <div style="width:14px;height:42px;background:${colorHex};flex-shrink:0;" title="Identity colour"></div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-bottom:10px;">
        ${statCell("HP",    `${save ? save.hp : maxHp} / ${maxHp}`)}
        ${statCell("AC",    String(def.ac))}
        ${statCell("SPEED", `${def.speed} ft`)}
        ${statCell("INIT",  signed(dexMod))}
        ${statCell("PROF",  `+${def.proficiencyBonus}`)}
      </div>
    `);
    this.root.appendChild(headerWrap);

    // Tab bar.
    const tabBar = document.createElement("div");
    tabBar.style.cssText = `display:flex;gap:0;border-bottom:1px solid ${DIM};margin-bottom:10px;flex-shrink:0;`;
    const tabs: { id: TabId; label: string }[] = [
      { id: "stats", label: "Stats" },
      { id: "story", label: "Story" },
      { id: "equipment", label: "Equipment" },
    ];
    if (def.spellcastingAbility) tabs.push({ id: "spells", label: "Spells" });
    for (const t of tabs) {
      const isActive = t.id === this.currentTab;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = t.label.toUpperCase();
      btn.style.cssText = `
        flex:1;height:28px;background:${isActive ? "#0d2a3a" : "transparent"};
        border:none;border-bottom:2px solid ${isActive ? ACCENT : "transparent"};
        color:${isActive ? ACCENT : "#778899"};font-size:10px;font-family:monospace;
        letter-spacing:1px;cursor:pointer;
      `;
      btn.addEventListener("click", () => {
        if (this.currentTab === t.id) return;
        this.currentTab = t.id;
        this.render();
      });
      tabBar.appendChild(btn);
    }
    this.root.appendChild(tabBar);

    // Tab content — scrollable.
    const content = document.createElement("div");
    content.style.cssText = `
      flex:1;min-height:0;overflow-y:auto;
      scrollbar-width: thin; scrollbar-color: #445566 transparent;
    `;
    switch (this.currentTab) {
      case "stats":     this.renderStatsTab(content, def); break;
      case "story":     this.renderStoryTab(content, def, save); break;
      case "equipment": this.renderEquipmentTab(content, def, save); break;
      case "spells":    this.renderSpellsTab(content, def, save); break;
    }
    this.root.appendChild(content);

    // Bottom action row — only when the dev flag is on. DELETE SAVE wipes
    // everything for the character; RESET ADVENTURE (Adventure Setup only)
    // wipes just the adventure save so chapter transitions can be replayed
    // without re-leveling.
    if (DevMode.showDeleteSaveButton) {
      const actionRow = document.createElement("div");
      actionRow.style.cssText = "display:flex;gap:8px;padding-top:8px;flex-shrink:0;";
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.textContent = "DELETE SAVE [DEV]";
      deleteBtn.style.cssText = `
        flex: 1;
        background: ${save ? "#3a1a1a" : "#1a1010"};
        color: ${save ? "#ffd6d6" : "#664444"};
        border: 1px solid ${save ? "#aa3333" : "#332020"};
        font-family: monospace; font-size: 10px;
        letter-spacing: 1px; padding: 6px 8px;
        cursor: ${save ? "pointer" : "not-allowed"};
      `;
      deleteBtn.disabled = !save;
      deleteBtn.addEventListener("click", () => save && this.opts.callbacks.onDeleteSave(def));
      actionRow.appendChild(deleteBtn);
      if (this.opts.callbacks.onResetAdventure) {
        const resetBtn = document.createElement("button");
        resetBtn.type = "button";
        resetBtn.textContent = "RESET ADVENTURE [DEV]";
        resetBtn.style.cssText = `
          flex: 1;
          background: #2a1a3a;
          color: #d6c6ff;
          border: 1px solid #6644aa;
          font-family: monospace; font-size: 10px;
          letter-spacing: 1px; padding: 6px 8px;
          cursor: pointer;
        `;
        resetBtn.addEventListener("click", () => this.opts.callbacks.onResetAdventure!(def));
        actionRow.appendChild(resetBtn);
      }
      this.root.appendChild(actionRow);
    }
  }

  // ── Tabs ────────────────────────────────────────────────────────────────

  private renderStatsTab(host: HTMLElement, def: PlayerDef): void {
    const passivePerception = 10 + (def.skills?.perception ?? 0);
    host.insertAdjacentHTML("beforeend", `
      <div style="font-size:10px;color:#556677;letter-spacing:1px;margin-bottom:6px;">ABILITY SCORES</div>
      <div style="display:flex;gap:4px;margin-bottom:10px;">
        ${(["STR","DEX","CON","INT","WIS","CHA"] as const).map((name, i) => {
          const val = [def.str, def.dex, def.con, def.int, def.wis, def.cha][i];
          return `<div style="flex:1;text-align:center;padding:5px 2px;border:1px solid ${DIM};background:#0a0a18;">
            <div style="font-size:9px;color:#556677;letter-spacing:1px;">${name}</div>
            <div style="font-size:14px;color:#e8e8f8;margin-top:1px;">${val}</div>
            <div style="font-size:9px;color:${ACCENT};">${signed(mod(val))}</div>
          </div>`;
        }).join("")}
      </div>

      <div style="font-size:10px;color:#556677;letter-spacing:1px;margin-bottom:6px;">SAVING THROWS</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:0 12px;padding:0 4px;margin-bottom:10px;">
        ${(["STR","DEX","CON","INT","WIS","CHA"] as const).map((name, i) => {
          const val = [def.str, def.dex, def.con, def.int, def.wis, def.cha][i];
          const prof = def.savingThrowProficiencies?.includes(name.toLowerCase()) ?? false;
          const total = mod(val) + (prof ? def.proficiencyBonus : 0);
          return `<div style="display:flex;justify-content:space-between;padding:2px 0;font-size:10px;">
            <span style="color:${prof ? ACCENT : "#778899"};">${prof ? "●" : "○"} ${name}</span>
            <span style="color:#aabbcc;">${signed(total)}</span>
          </div>`;
        }).join("")}
      </div>

      <div style="font-size:10px;color:#556677;letter-spacing:1px;margin-bottom:6px;">SKILLS <span style="color:#445566;">○ untrained · ● proficient · ◆ expertise</span></div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:0 12px;padding:0 4px;margin-bottom:10px;">
        ${SKILLS.map((sk) => {
          const abilityMod = mod(def[sk.ability]);
          const total = def.skills?.[sk.key] ?? abilityMod;
          const bonusFromProf = total - abilityMod;
          const prof = def.proficiencyBonus;
          let badge: string; let color: string;
          if      (bonusFromProf >= prof * 2) { badge = "◆"; color = "#e2b96f"; }
          else if (bonusFromProf >= prof)     { badge = "●"; color = ACCENT;    }
          else                                { badge = "○"; color = "#778899"; }
          return `<div style="display:flex;justify-content:space-between;padding:2px 0;font-size:10px;">
            <span style="color:${color};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
              ${badge} ${escHtml(sk.label)} <span style="color:#556677;">(${ABILITY_LABEL[sk.ability]})</span>
            </span>
            <span style="color:#aabbcc;flex-shrink:0;">${signed(total)}</span>
          </div>`;
        }).join("")}
      </div>

      <div style="font-size:10px;color:#556677;letter-spacing:1px;margin-bottom:6px;">PASSIVE PERCEPTION</div>
      <div style="font-size:11px;color:#aabbcc;line-height:1.6;">${passivePerception}</div>
    `);
  }

  private renderStoryTab(host: HTMLElement, def: PlayerDef, save: CharacterDetailSave | null): void {
    const origin = titleCase(def.backgroundId);
    const lineageTitle = def.speciesLineage ? titleCase(def.speciesLineage) : "";
    // Many species name themselves after their lineage ("High Elf" / "high-elf"),
    // in which case showing both is redundant noise.
    const lineage = lineageTitle && lineageTitle.toLowerCase() !== def.speciesName.toLowerCase()
      ? ` · ${lineageTitle}` : "";

    // STORY LOG button — first, so the player can pop straight to the log.
    const btnWrap = document.createElement("div");
    btnWrap.style.cssText = "margin-bottom:14px;";
    const storylogBtn = document.createElement("button");
    storylogBtn.type = "button";
    storylogBtn.textContent = "OPEN STORY LOG";
    storylogBtn.style.cssText = `
      width:100%;
      background: ${save ? "#1a3a2a" : "#101a14"};
      color: ${save ? "#ffe9a8" : "#445544"};
      border: 1px solid ${save ? "#2a6655" : "#1a3025"};
      font-family: monospace; font-size: 11px;
      letter-spacing: 1px; padding: 8px;
      cursor: ${save ? "pointer" : "not-allowed"};
    `;
    storylogBtn.disabled = !save;
    storylogBtn.addEventListener("click", () => save && this.opts.callbacks.onStorylog(def));
    btnWrap.appendChild(storylogBtn);
    if (!save) {
      const hint = document.createElement("div");
      hint.textContent = "Story log unlocks after the first session.";
      hint.style.cssText = "font-size:10px;color:#556677;margin-top:6px;font-style:italic;text-align:center;";
      btnWrap.appendChild(hint);
    }
    host.appendChild(btnWrap);

    const description = def.description ?? "No background description recorded.";
    host.insertAdjacentHTML("beforeend", `
      <div style="font-size:10px;color:#556677;letter-spacing:1px;margin-bottom:6px;">ORIGIN</div>
      <div style="font-size:11px;color:#c8d8e8;margin-bottom:10px;line-height:1.5;">${escHtml(origin)}</div>

      <div style="font-size:10px;color:#556677;letter-spacing:1px;margin-bottom:6px;">SPECIES</div>
      <div style="font-size:11px;color:#c8d8e8;margin-bottom:10px;line-height:1.5;">${escHtml(def.speciesName)}${escHtml(lineage)}</div>

      <div style="font-size:10px;color:#556677;letter-spacing:1px;margin-bottom:6px;">BACKGROUND</div>
      <div style="font-size:11px;color:#aabbcc;line-height:1.6;white-space:pre-wrap;margin-bottom:10px;">${escHtml(description)}</div>

      <div style="font-size:10px;color:#556677;letter-spacing:1px;margin-bottom:6px;">LANGUAGES</div>
      <div style="font-size:11px;color:#c8d8e8;line-height:1.5;">${escHtml((def.languages && def.languages.length ? def.languages : ["Common"]).join(", "))}</div>
    `);
  }

  private renderEquipmentTab(host: HTMLElement, def: PlayerDef, save: CharacterDetailSave | null): void {
    const byId = Object.fromEntries(this.opts.equipment.map((i) => [i.id, i]));
    const slots = save?.equippedSlots ?? null;
    const inventoryIds = save?.inventoryIds ?? def.defaultInventoryIds;

    const slotCard = (label: string, item: ItemDef | null): string => {
      const borderColor = item ? ACCENT : DIM;
      const body = item
        ? `<div style="font-size:11px;color:#c8dae8;text-align:center;">${escHtml(item.name)}</div>
           <div style="font-size:9px;color:${ACCENT};margin-top:4px;text-align:center;">${escHtml(slotDetail(item, def))}</div>`
        : `<div style="font-size:14px;color:#334455;text-align:center;">—</div>`;
      return `<div style="flex:1;border:1px solid ${borderColor};background:#0a0a18;padding:8px 6px;">
        <div style="font-size:9px;color:#556677;letter-spacing:1px;text-align:center;margin-bottom:4px;">${label}</div>
        ${body}
      </div>`;
    };

    const armor  = slots?.armorId  ? byId[slots.armorId]  ?? null : null;
    const weapon = slots?.weaponId ? byId[slots.weaponId] ?? null : null;
    const shield = slots?.shieldId ? byId[slots.shieldId] ?? null : null;

    // Aggregate carried items by id with a count. Equipped slot items live in
    // their own row above, so don't duplicate them in the carried list.
    const equippedIds = new Set<string>();
    if (slots?.armorId)  equippedIds.add(slots.armorId);
    if (slots?.weaponId) equippedIds.add(slots.weaponId);
    if (slots?.shieldId) equippedIds.add(slots.shieldId);
    const carried: Record<string, { name: string; type: string; count: number }> = {};
    for (const id of inventoryIds) {
      if (equippedIds.has(id)) {
        // Strip a single instance — additional copies of the same id stay in
        // the carried list.
        equippedIds.delete(id);
        continue;
      }
      const item = byId[id];
      const name = item?.name ?? id;
      const type = item?.type ?? "gear";
      if (!carried[id]) carried[id] = { name, type, count: 0 };
      carried[id].count++;
    }
    const carriedRows = Object.values(carried).map(({ name, type, count }) => `
      <div style="display:flex;justify-content:space-between;padding:2px 0;font-size:10px;">
        <span style="color:#b0c8dc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">
          ${escHtml(name)}${count > 1 ? ` ×${count}` : ""}
        </span>
        <span style="color:#556677;flex-shrink:0;margin-left:8px;">${escHtml(type.toUpperCase())}</span>
      </div>`).join("");

    const balanceCp = save?.balanceCp ?? def.defaultCp ?? 0;
    const coinsLine = formatCoins(balanceCp);

    host.insertAdjacentHTML("beforeend", `
      <div style="font-size:10px;color:#556677;letter-spacing:1px;margin-bottom:6px;">EQUIPPED</div>
      <div style="display:flex;gap:8px;margin-bottom:12px;">
        ${slotCard("ARMOR",   armor)}
        ${slotCard("WEAPON",  weapon)}
        ${slotCard("OFFHAND", shield)}
      </div>

      <div style="font-size:10px;color:#556677;letter-spacing:1px;margin-bottom:6px;">CARRIED</div>
      <div style="padding:0 4px;margin-bottom:12px;">
        ${carriedRows || `<div style="font-size:10px;color:#445566;font-style:italic;">No items carried.</div>`}
      </div>

      <div style="font-size:10px;color:#556677;letter-spacing:1px;margin-bottom:6px;">COINS</div>
      <div style="font-size:11px;color:#e2b96f;line-height:1.6;">${escHtml(coinsLine)}</div>
    `);
  }

  private renderSpellsTab(host: HTMLElement, def: PlayerDef, save: CharacterDetailSave | null): void {
    const ability = def.spellcastingAbility;
    if (!ability) {
      host.insertAdjacentHTML("beforeend", `<div style="font-size:11px;color:#445566;">This character has no spellcasting ability.</div>`);
      return;
    }

    const abilityMod = mod(def[ability]);
    const saveDC   = 8 + def.proficiencyBonus + abilityMod;
    const atkBonus = def.proficiencyBonus + abilityMod;

    const cantripIds  = def.defaultCantripIds  ?? [];
    const preparedIds = def.defaultPreparedSpellIds ?? [];
    const bookIds     = def.defaultSpellbookIds ?? [];
    const slots       = def.defaultSpellSlots ?? [];
    void save;

    const allSpells = this.opts.spells ?? [];
    const byId = Object.fromEntries(allSpells.map((s) => [s.id, s]));

    const spellRow = (id: string, prepared: boolean): string => {
      const sp = byId[id];
      if (!sp) return `<div style="font-size:10px;color:#445566;padding:2px 4px;">${escHtml(id)}</div>`;
      const bits: string[] = [];
      if (sp.damage) bits.push(`${sp.damage.dice}d${sp.damage.sides}${sp.damage.bonus ? "+" + sp.damage.bonus : ""} ${sp.damage.type}`);
      if (sp.save) bits.push(`${sp.save.ability.toUpperCase()} save DC ${saveDC}`);
      if (sp.area) bits.push(`${sp.area.sizeFeet}-ft ${sp.area.shape}`);
      else if (sp.rangeFeet > 0) bits.push(`${sp.rangeFeet} ft`);
      if (sp.concentration) bits.push("Concentration");
      if (sp.ritual) bits.push("Ritual");
      const tag = sp.level === 0 ? "cantrip" : `L${sp.level}`;
      return `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:3px 4px;border-bottom:1px solid #1a2030;">
          <span style="font-size:10px;color:${prepared ? "#c8dae8" : "#778899"};min-width:100px;">${escHtml(sp.name)}</span>
          <span style="font-size:9px;color:#556677;text-align:right;flex:1;margin-left:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(bits.join(" · "))}</span>
          <span style="font-size:9px;color:${prepared ? ACCENT : "#778899"};margin-left:8px;min-width:42px;text-align:right;">${escHtml(tag)}</span>
        </div>`;
    };

    const slotsLine = slots.length > 0
      ? slots.map((n, i) => (n > 0 ? `L${i + 1} ${n}/${n}` : "")).filter(Boolean).join("  ·  ")
      : "—";

    const cantripRows  = cantripIds.length > 0
      ? cantripIds.map((id) => spellRow(id, true)).join("")
      : `<div style="font-size:10px;color:#445566;padding:4px;font-style:italic;">None.</div>`;
    const preparedRows = preparedIds.length > 0
      ? preparedIds.map((id) => spellRow(id, true)).join("")
      : `<div style="font-size:10px;color:#445566;padding:4px;font-style:italic;">None prepared.</div>`;
    const preparedSet  = new Set(preparedIds);
    const bookOnly     = bookIds.filter((id) => !preparedSet.has(id));
    const bookRows     = bookOnly.length > 0
      ? bookOnly.map((id) => spellRow(id, false)).join("")
      : "";

    host.insertAdjacentHTML("beforeend", `
      <div style="display:flex;gap:6px;margin-bottom:10px;">
        <div style="flex:1;padding:5px 6px;border:1px solid ${DIM};background:#0a0a18;text-align:center;">
          <div style="font-size:9px;color:#556677;letter-spacing:1px;">SAVE DC</div>
          <div style="font-size:13px;color:#aabbcc;">${saveDC}</div>
        </div>
        <div style="flex:1;padding:5px 6px;border:1px solid ${DIM};background:#0a0a18;text-align:center;">
          <div style="font-size:9px;color:#556677;letter-spacing:1px;">SPELL ATK</div>
          <div style="font-size:13px;color:#aabbcc;">${signed(atkBonus)}</div>
        </div>
        <div style="flex:2;padding:5px 6px;border:1px solid ${DIM};background:#0a0a18;text-align:center;">
          <div style="font-size:9px;color:#556677;letter-spacing:1px;">SLOTS</div>
          <div style="font-size:11px;color:#aabbcc;">${escHtml(slotsLine)}</div>
        </div>
      </div>

      <div style="font-size:10px;color:#556677;letter-spacing:1px;margin-bottom:4px;">CANTRIPS (${cantripIds.length})</div>
      ${cantripRows}

      <div style="height:8px;"></div>
      <div style="font-size:10px;color:#556677;letter-spacing:1px;margin-bottom:4px;">PREPARED (${preparedIds.length})</div>
      ${preparedRows}

      ${bookRows ? `
        <div style="height:8px;"></div>
        <div style="font-size:10px;color:#556677;letter-spacing:1px;margin-bottom:4px;">SPELLBOOK · UNPREPARED (${bookOnly.length})</div>
        ${bookRows}
      ` : ""}
    `);
  }

  private attachPlace(): void {
    const { x, y, width, height, sceneWidth, scene } = this.opts;
    this.placeHandler = () => {
      const rect = scene.sys.game.canvas.getBoundingClientRect();
      const s = rect.width / sceneWidth;
      this.root.style.left = `${rect.left + x * s}px`;
      this.root.style.top  = `${rect.top  + y * s}px`;
      this.root.style.width  = `${width  * s}px`;
      this.root.style.height = `${height * s}px`;
      this.root.style.fontSize = `${11 * s}px`;
    };
    this.placeHandler();
    scene.scale.on("resize", this.placeHandler);
  }
}

// ── module helpers ──────────────────────────────────────────────────────────

function mod(score: number): number { return Math.floor((score - 10) / 2); }
function signed(n: number): string { return n >= 0 ? `+${n}` : `${n}`; }
function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function statCell(label: string, value: string): string {
  return `<div style="padding:5px 6px;border:1px solid #334455;background:#0a0a18;text-align:center;">
    <div style="font-size:9px;color:#556677;letter-spacing:1px;">${label}</div>
    <div style="font-size:13px;color:#aabbcc;margin-top:1px;">${value}</div>
  </div>`;
}
function effectiveMaxHp(def: PlayerDef, save: CharacterDetailSave | null): number {
  const levelsGained = save?.levelUps?.length ?? 0;
  if (levelsGained === 0) return def.maxHp;
  const conMod = Math.floor((def.con - 10) / 2);
  const perLevel = Math.max(1, fixedHpForClass(def.className) + conMod);
  return def.maxHp + levelsGained * perLevel;
}
function titleCase(s: string): string {
  return s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function slotDetail(item: ItemDef, def: PlayerDef): string {
  if (item.type === "armor") {
    const a = item as ArmorDef;
    const dexMod = mod(def.dex);
    const dexBonus = a.addDex ? (a.maxDex !== null ? Math.min(dexMod, a.maxDex) : dexMod) : 0;
    const ac = a.baseAc + dexBonus + (def.fightingStyleDefense ? 1 : 0);
    const cat = a.category.charAt(0).toUpperCase() + a.category.slice(1);
    return `${cat} · AC ${ac}`;
  }
  if (item.type === "shield") return `+${(item as ShieldDef).acBonus} AC`;
  if (item.type === "weapon") {
    const w = item as WeaponDef;
    const statMod = w.finesse ? Math.max(mod(def.str), mod(def.dex)) : mod(def[w.statKey]);
    const sign = statMod >= 0 ? "+" : "";
    return `${w.damageDice}d${w.damageSides}${sign}${statMod}`;
  }
  return "";
}

