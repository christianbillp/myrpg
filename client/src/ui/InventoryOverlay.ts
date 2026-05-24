import { BaseOverlay } from "./BaseOverlay";
import { PlayerDef, EquipmentSlots } from "../data/player";
import { ItemDef, ArmorDef, WeaponDef, ShieldDef, EquipmentDef } from "../data/equipment";
import { PlayerAttack } from "../data/player";
import { UIScale } from "./UIScale";

function mod(score: number): number { return Math.floor((score - 10) / 2); }

function attackSummary(attack: PlayerAttack, statMod: number): string {
  const diceStr = `${attack.damageDice}d${attack.damageSides}`;
  const sign = statMod >= 0 ? "+" : "";
  const masteries: string[] = [];
  if (attack.graze) masteries.push("Graze");
  if (attack.vex) masteries.push("Vex");
  const masteryStr = masteries.length ? ` (${masteries.join(", ")})` : "";
  return `${diceStr}${sign}${statMod}${masteryStr}`;
}

function isEquipmentDef(item: ItemDef): item is EquipmentDef {
  return item.type === "armor" || item.type === "weapon" || item.type === "shield";
}

function slotLabel(item: EquipmentDef, playerDef: PlayerDef): string {
  if (item.type === "armor") {
    const a = item as ArmorDef;
    const dexMod = mod(playerDef.dex);
    const dexBonus = a.addDex ? (a.maxDex !== null ? Math.min(dexMod, a.maxDex) : dexMod) : 0;
    const baseAc = a.baseAc + dexBonus + (playerDef.fightingStyleDefense ? 1 : 0);
    const catLabel = a.category.charAt(0).toUpperCase() + a.category.slice(1);
    return `${catLabel} · AC ${baseAc}`;
  }
  if (item.type === "shield") {
    return `+${(item as ShieldDef).acBonus} AC`;
  }
  const w = item as WeaponDef;
  const attackStatMod = w.finesse
    ? Math.max(mod(playerDef.str), mod(playerDef.dex))
    : mod(playerDef[w.statKey]);
  return attackSummary(
    { name: w.name, statKey: w.statKey, damageDice: w.damageDice, damageSides: w.damageSides, damageType: w.damageType, savageAttacker: playerDef.savageAttacker, graze: w.mastery === "graze", vex: w.mastery === "vex" },
    attackStatMod,
  );
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
    slots: EquipmentSlots,
    equippedSlotLabels: { armor: string | null; weapon: string | null; shield: string | null },
    inventory: ItemDef[],
    allItems: ItemDef[],
    gold: number,
    canUseConsumable: boolean,
    onEquip: (slot: "armor" | "weapon" | "shield", itemId: string) => void,
    onUnequip: (slot: "armor" | "weapon" | "shield") => void,
    onUse: (itemId: string) => void,
    onClose: () => void,
  ) {
    super(scale, 580, 440, ACCENT, onClose);

    const byId = Object.fromEntries(allItems.map((i) => [i.id, i]));

    // ── Equipped slots ─────────────────────────────────────────────────────────
    const slotDefs: { key: "armor" | "weapon" | "shield"; label: string; itemId: string | null }[] = [
      { key: "armor",  label: "ARMOR",   itemId: slots.armorId },
      { key: "weapon", label: "WEAPON",  itemId: slots.weaponId },
      { key: "shield", label: "OFFHAND", itemId: slots.shieldId },
    ];

    const slotCards = slotDefs.map(({ key, label, itemId }) => {
      const item = itemId ? byId[itemId] as EquipmentDef | undefined : undefined;
      const borderColor = item ? ACCENT : DIM;
      let inner: string;
      if (item) {
        const serverLabel = equippedSlotLabels[key] ?? '';
        inner = `
          <div style="font-size:11px;color:#c8dae8;margin-bottom:4px;">${escHtml(item.name)}</div>
          <div style="font-size:10px;color:${ACCENT};margin-bottom:8px;">${escHtml(serverLabel)}</div>
          <button data-unequip="${key}" class="gui-btn-overlay" style="width:90px;height:22px;background:#1a1a2e;
            border:1px solid ${DIM};color:#889aaa;font-size:10px;">
            UNEQUIP
          </button>`;
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
    const equippable = inventory.filter(isEquipmentDef);
    const consumables = inventory.filter((i) => i.type === "consumable");

    const eqGroups: { item: EquipmentDef; count: number }[] = [];
    equippable.forEach((item) => {
      const existing = eqGroups.find((g) => g.item.id === item.id);
      if (existing) { existing.count++; }
      else { eqGroups.push({ item, count: 1 }); }
    });

    const cGroups: Record<string, { id: string; count: number }> = {};
    consumables.forEach((c) => {
      if (!cGroups[c.name]) cGroups[c.name] = { id: c.id, count: 0 };
      cGroups[c.name].count++;
    });

    const eqRows = eqGroups.map(({ item, count }) => {
      const labelText = count > 1
        ? `${escHtml(item.name)} ×${count}  ·  ${escHtml(slotLabel(item, playerDef))}`
        : `${escHtml(item.name)}  ·  ${escHtml(slotLabel(item, playerDef))}`;
      const slot: "armor" | "weapon" | "shield" =
        item.type === "armor" ? "armor" : item.type === "weapon" ? "weapon" : "shield";
      return `
        <div style="display:flex;align-items:center;justify-content:space-between;
          height:28px;padding:0 2px;">
          <span style="font-size:11px;color:#b0c8dc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;margin-right:8px;">
            ${labelText}
          </span>
          <button data-equip="${slot}|${escHtml(item.id)}" class="gui-btn-overlay" style="width:72px;height:22px;background:#0a1520;
            border:1px solid ${ACCENT};color:${ACCENT};font-size:10px;">
            EQUIP
          </button>
        </div>`;
    }).join('');

    const useColor   = canUseConsumable ? "#66aa66" : "#445544";
    const useBorder  = canUseConsumable ? "#4a8a4a" : DIM;
    const useBg      = canUseConsumable ? "#1a3a1a" : "#111111";
    const cRows = Object.entries(cGroups).map(([name, { id, count }]) => `
      <div style="display:flex;align-items:center;justify-content:space-between;
        height:28px;padding:0 2px;">
        <span style="font-size:11px;color:#668877;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;margin-right:8px;">
          ${escHtml(name)} ×${count}
        </span>
        <button ${canUseConsumable ? `data-use="${escHtml(id)}"` : 'disabled'} class="gui-btn-overlay" style="width:72px;height:22px;
          background:${useBg};border:1px solid ${useBorder};color:${useColor};font-size:10px;">
          USE
        </button>
      </div>`).join('');

    const emptyCarried = eqGroups.length === 0 && Object.keys(cGroups).length === 0
      ? `<div style="font-size:11px;color:#334455;padding:8px 2px;">No items carried.</div>`
      : '';

    // ── Stats bar ──────────────────────────────────────────────────────────────
    const mainStatMod = playerDef.mainAttack.statKey === "str" ? mod(playerDef.str) : mod(playerDef.dex);
    const atkSummaryText = attackSummary(playerDef.mainAttack, mainStatMod);

    this.panelEl.insertAdjacentHTML('beforeend', `
      <div style="padding:20px 20px 0;display:flex;flex-direction:column;height:calc(100% - 20px);box-sizing:border-box;">
        <div style="font-size:15px;color:${ACCENT};text-align:center;margin-bottom:12px;">INVENTORY</div>
        <div style="height:1px;background:${DIM};margin-bottom:8px;"></div>

        <div style="font-size:10px;color:#556677;margin-bottom:6px;">EQUIPPED</div>
        <div style="display:flex;gap:8px;margin-bottom:8px;" data-slot-area></div>

        <div style="height:1px;background:${DIM};margin:6px 0;"></div>
        <div style="font-size:10px;color:#556677;margin-bottom:4px;">CARRIED</div>
        <div style="flex:1;overflow-y:auto;scrollbar-width:thin;scrollbar-color:${ACCENT} transparent;
          min-height:0;" data-carry-area>
          ${eqRows}${cRows}${emptyCarried}
        </div>

        <div style="height:1px;background:${DIM};margin:6px 0;"></div>
        <div style="font-size:11px;color:${ACCENT};text-align:center;padding-bottom:4px;">
          AC ${playerDef.ac}  ·  ${gold} GP  ·  ${escHtml(playerDef.mainAttack.name)} ${escHtml(atkSummaryText)}
        </div>
      </div>
    `);

    // Populate slot cards (innerHTML set separately to keep dynamic listeners easier)
    const slotArea = this.panelEl.querySelector("[data-slot-area]") as HTMLElement;
    slotArea.innerHTML = slotCards;

    // Wire equip/unequip/use buttons
    this.panelEl.querySelectorAll<HTMLButtonElement>("[data-unequip]").forEach(btn => {
      const slot = btn.dataset.unequip as "armor" | "weapon" | "shield";
      btn.addEventListener("pointerdown", () => onUnequip(slot));
    });

    this.panelEl.querySelectorAll<HTMLButtonElement>("[data-equip]").forEach(btn => {
      const [slot, itemId] = btn.dataset.equip!.split("|") as ["armor" | "weapon" | "shield", string];
      btn.addEventListener("pointerdown", () => onEquip(slot, itemId));
    });

    this.panelEl.querySelectorAll<HTMLButtonElement>("[data-use]").forEach(btn => {
      const itemId = btn.dataset.use!;
      btn.addEventListener("pointerdown", () => onUse(itemId));
    });
  }
}
