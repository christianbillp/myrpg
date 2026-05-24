import { BaseOverlay } from "./BaseOverlay";
import { PlayerDef, PlayerAttack } from "../data/player";
import { ItemDef, ArmorDef, WeaponDef, ShieldDef, EquipmentDef } from "../data/equipment";
import { UIScale } from "./UIScale";

function mod(score: number): number { return Math.floor((score - 10) / 2); }

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

export class InventoryOverlay extends BaseOverlay {
  constructor(
    scale: UIScale,
    playerDef: PlayerDef,
    equippedItems: Partial<Record<"armor" | "weapon" | "shield", EquipmentDef>>,
    equippedSlotLabels: { armor: string | null; weapon: string | null; shield: string | null },
    inventory: ItemDef[],
    gold: number,
    canUseConsumable: boolean,
    onEquip: (slot: "armor" | "weapon" | "shield", itemId: string) => void,
    onUnequip: (slot: "armor" | "weapon" | "shield") => void,
    onUse: (itemId: string) => void,
    onClose: () => void,
  ) {
    super(scale, 580, 440, ACCENT, onClose);

    // ── Equipped slots ─────────────────────────────────────────────────────────
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
        const serverLabel = equippedSlotLabels[key] ?? '';
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
    }).join('');

    // ── Carried items ──────────────────────────────────────────────────────────
    const equippable  = inventory.filter(isEquipmentDef);
    const consumables = inventory.filter((i) => i.type === "consumable");

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
    }).join('');

    const useColor  = canUseConsumable ? "#66aa66" : "#445544";
    const useBorder = canUseConsumable ? "#4a8a4a" : DIM;
    const useBg     = canUseConsumable ? "#1a3a1a" : "#111111";
    const cRows = Object.entries(cGroups).map(([id, { name, count }]) => `
      <div style="display:flex;align-items:center;justify-content:space-between;height:28px;padding:0 2px;">
        <span style="font-size:11px;color:#668877;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;margin-right:8px;">
          ${escHtml(name)} ×${count}
        </span>
        <button ${canUseConsumable ? `data-use="${escHtml(id)}"` : 'disabled'} class="gui-btn-overlay"
          style="width:72px;height:22px;background:${useBg};border:1px solid ${useBorder};color:${useColor};font-size:10px;">
          USE
        </button>
      </div>`).join('');

    const emptyCarried = eqGroups.length === 0 && Object.keys(cGroups).length === 0
      ? `<div style="font-size:11px;color:#334455;padding:8px 2px;">No items carried.</div>`
      : '';

    // ── Stats bar ──────────────────────────────────────────────────────────────
    const mainStatMod = playerDef.mainAttack.statKey === "str" ? mod(playerDef.str) : mod(playerDef.dex);
    const atkText = attackSummary(playerDef.mainAttack, mainStatMod);

    this.panelEl.insertAdjacentHTML('beforeend', `
      <div style="padding:20px 20px 0;display:flex;flex-direction:column;height:calc(100% - 20px);box-sizing:border-box;">
        <div style="font-size:15px;color:${ACCENT};text-align:center;margin-bottom:12px;">INVENTORY</div>
        <div style="height:1px;background:${DIM};margin-bottom:8px;"></div>

        <div style="font-size:10px;color:#556677;margin-bottom:6px;">EQUIPPED</div>
        <div style="display:flex;gap:8px;margin-bottom:8px;" data-slot-area></div>

        <div style="height:1px;background:${DIM};margin:6px 0;"></div>
        <div style="font-size:10px;color:#556677;margin-bottom:4px;">CARRIED</div>
        <div style="flex:1;overflow-y:auto;scrollbar-width:thin;scrollbar-color:${ACCENT} transparent;min-height:0;" data-carry-area>
          ${eqRows}${cRows}${emptyCarried}
        </div>

        <div style="height:1px;background:${DIM};margin:6px 0;"></div>
        <div style="font-size:11px;color:${ACCENT};text-align:center;padding-bottom:4px;">
          AC ${playerDef.ac}  ·  ${gold} GP  ·  ${escHtml(playerDef.mainAttack.name)} ${escHtml(atkText)}
        </div>
      </div>
    `);

    const slotArea = this.panelEl.querySelector("[data-slot-area]") as HTMLElement;
    slotArea.innerHTML = slotCards;

    this.panelEl.querySelectorAll<HTMLButtonElement>("[data-unequip]").forEach(btn => {
      const slot = btn.dataset.unequip as "armor" | "weapon" | "shield";
      btn.addEventListener("pointerdown", () => onUnequip(slot));
    });
    this.panelEl.querySelectorAll<HTMLButtonElement>("[data-equip]").forEach(btn => {
      const [slot, itemId] = btn.dataset.equip!.split("|") as ["armor" | "weapon" | "shield", string];
      btn.addEventListener("pointerdown", () => onEquip(slot, itemId));
    });
    this.panelEl.querySelectorAll<HTMLButtonElement>("[data-use]").forEach(btn => {
      btn.addEventListener("pointerdown", () => onUse(btn.dataset.use!));
    });
  }
}
