import Phaser from "phaser";
import { PLAYER_PANEL_WIDTH, GRID_COLS, GRID_ROWS, TILE_SIZE, TARGET_PANEL_WIDTH } from "../constants";
import { BaseOverlay } from "./BaseOverlay";
import { PlayerDef, EquipmentSlots } from "../data/player";
import { ItemDef, ArmorDef, WeaponDef, ShieldDef, EquipmentDef } from "../data/items";
import { mod } from "../systems/Dice";
import { attackSummary } from "../systems/EquipmentSystem";

const DPR = window.devicePixelRatio;
const W = PLAYER_PANEL_WIDTH + GRID_COLS * TILE_SIZE + TARGET_PANEL_WIDTH;
const ACCENT = 0x7aadcc;
const DIM = 0x334455;

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
  const statMod = w.finesse
    ? Math.max(mod(playerDef.str), mod(playerDef.dex))
    : mod(playerDef[w.statKey]);
  return attackSummary(
    { name: w.name, statKey: w.statKey, damageDice: w.damageDice, damageSides: w.damageSides, savageAttacker: playerDef.savageAttacker, graze: w.mastery === "graze", vex: w.mastery === "vex" },
    statMod,
  );
}

export class EquipmentOverlay extends BaseOverlay {
  constructor(
    scene: Phaser.Scene,
    playerDef: PlayerDef,
    slots: EquipmentSlots,
    inventory: ItemDef[],
    allItems: ItemDef[],
    onEquip: (slot: "armor" | "weapon" | "shield", itemId: string) => void,
    onUnequip: (slot: "armor" | "weapon" | "shield") => void,
    onClose: () => void,
  ) {
    super(scene, 580, 440, ACCENT, onClose);

    const top = this.top;
    const byId = Object.fromEntries(allItems.map((i) => [i.id, i]));

    const title = scene.add
      .text(0, top + 22, "EQUIPMENT", { fontSize: "15px", color: "#7aadcc", fontFamily: "monospace", resolution: DPR })
      .setOrigin(0.5, 0);

    const sep1 = scene.add.rectangle(0, top + 50, this.panelW - 32, 1, DIM);

    // ── Equipped slots ────────────────────────────────────────────
    const slotsLabel = scene.add
      .text(-this.panelW / 2 + 20, top + 58, "EQUIPPED", { fontSize: "10px", color: "#556677", fontFamily: "monospace", resolution: DPR });

    const slotDefs: { key: "armor" | "weapon" | "shield"; label: string; itemId: string | null }[] = [
      { key: "armor",  label: "ARMOR",   itemId: slots.armorId },
      { key: "weapon", label: "WEAPON",  itemId: slots.weaponId },
      { key: "shield", label: "OFFHAND", itemId: slots.shieldId },
    ];

    const SLOT_W = 166;
    const SLOT_H = 108;
    const SLOT_GAP = 11;
    const totalSlotsW = 3 * SLOT_W + 2 * SLOT_GAP;
    const slotStartX = -totalSlotsW / 2 + SLOT_W / 2;
    const slotCY = top + 58 + 16 + SLOT_H / 2 + 4;

    const elements: Phaser.GameObjects.GameObject[] = [title, sep1, slotsLabel];

    slotDefs.forEach(({ key, label, itemId }, i) => {
      const cx = slotStartX + i * (SLOT_W + SLOT_GAP);
      const ty = slotCY;

      const bg = scene.add.rectangle(cx, ty, SLOT_W, SLOT_H, 0x0a0a18).setStrokeStyle(1, itemId ? ACCENT : DIM);

      const labelTxt = scene.add
        .text(cx, ty - SLOT_H / 2 + 10, label, { fontSize: "10px", color: "#556677", fontFamily: "monospace", resolution: DPR })
        .setOrigin(0.5, 0);

      if (itemId && byId[itemId]) {
        const item = byId[itemId] as EquipmentDef;
        const nameTxt = scene.add
          .text(cx, ty - 14, item.name, { fontSize: "11px", color: "#c8dae8", fontFamily: "monospace", resolution: DPR, wordWrap: { width: SLOT_W - 12 } })
          .setOrigin(0.5, 0.5);
        const statTxt = scene.add
          .text(cx, ty + 10, slotLabel(item, playerDef), { fontSize: "10px", color: "#7aadcc", fontFamily: "monospace", resolution: DPR })
          .setOrigin(0.5, 0.5);

        const btnBg = scene.add
          .rectangle(cx, ty + SLOT_H / 2 - 18, 90, 22, 0x1a1a2e)
          .setStrokeStyle(1, DIM)
          .setInteractive({ useHandCursor: true });
        const btnTxt = scene.add
          .text(cx, ty + SLOT_H / 2 - 18, "UNEQUIP", { fontSize: "10px", color: "#889aaa", fontFamily: "monospace", resolution: DPR })
          .setOrigin(0.5);
        btnBg.on("pointerover", () => { btnBg.setStrokeStyle(1, ACCENT); btnTxt.setColor("#c8dae8"); });
        btnBg.on("pointerout",  () => { btnBg.setStrokeStyle(1, DIM);    btnTxt.setColor("#889aaa"); });
        btnBg.on("pointerdown", () => onUnequip(key));

        elements.push(bg, labelTxt, nameTxt, statTxt, btnBg, btnTxt);
      } else {
        const emptyTxt = scene.add
          .text(cx, ty, "—", { fontSize: "18px", color: "#334455", fontFamily: "monospace", resolution: DPR })
          .setOrigin(0.5);
        elements.push(bg, labelTxt, emptyTxt);
      }
    });

    // ── Carried items ─────────────────────────────────────────────
    const sep2Y = slotCY + SLOT_H / 2 + 10;
    const sep2 = scene.add.rectangle(0, sep2Y, this.panelW - 32, 1, DIM);

    const carriedLabel = scene.add
      .text(-this.panelW / 2 + 20, sep2Y + 8, "CARRIED", { fontSize: "10px", color: "#556677", fontFamily: "monospace", resolution: DPR });

    elements.push(sep2, carriedLabel);

    const equippable = inventory.filter(isEquipmentDef);
    const consumables = inventory.filter((i) => i.type === "consumable");

    let rowY = sep2Y + 26;
    const lx = -this.panelW / 2 + 20;
    const rx = this.panelW / 2 - 20;

    equippable.forEach((item) => {
      const eq = item as EquipmentDef;
      const stat = slotLabel(eq, playerDef);
      const itemTxt = scene.add
        .text(lx, rowY, `${eq.name}  ·  ${stat}`, { fontSize: "11px", color: "#b0c8dc", fontFamily: "monospace", resolution: DPR })
        .setOrigin(0, 0.5);

      const slot: "armor" | "weapon" | "shield" =
        eq.type === "armor" ? "armor" : eq.type === "weapon" ? "weapon" : "shield";

      const equipBg = scene.add
        .rectangle(rx - 36, rowY, 72, 22, 0x0a1520)
        .setStrokeStyle(1, ACCENT)
        .setInteractive({ useHandCursor: true });
      const equipTxt = scene.add
        .text(rx - 36, rowY, "EQUIP", { fontSize: "10px", color: "#7aadcc", fontFamily: "monospace", resolution: DPR })
        .setOrigin(0.5);
      equipBg.on("pointerover", () => { equipBg.setFillStyle(0x1a2a3a); });
      equipBg.on("pointerout",  () => { equipBg.setFillStyle(0x0a1520); });
      equipBg.on("pointerdown", () => onEquip(slot, eq.id));

      elements.push(itemTxt, equipBg, equipTxt);
      rowY += 28;
    });

    if (consumables.length > 0) {
      const counts: Record<string, number> = {};
      consumables.forEach((c) => { counts[c.name] = (counts[c.name] ?? 0) + 1; });
      Object.entries(counts).forEach(([name, count]) => {
        const cTxt = scene.add
          .text(lx, rowY, `${name} ×${count}`, { fontSize: "11px", color: "#668877", fontFamily: "monospace", resolution: DPR })
          .setOrigin(0, 0.5);
        elements.push(cTxt);
        rowY += 26;
      });
    }

    if (equippable.length === 0 && consumables.length === 0) {
      const emptyTxt = scene.add
        .text(0, sep2Y + 36, "No items carried.", { fontSize: "11px", color: "#334455", fontFamily: "monospace", resolution: DPR })
        .setOrigin(0.5, 0);
      elements.push(emptyTxt);
    }

    // ── Stats bar ─────────────────────────────────────────────────
    const statsY = top + this.panelH - 28;
    const sep3 = scene.add.rectangle(0, statsY - 18, this.panelW - 32, 1, DIM);

    const statMod = playerDef.mainAttack.statKey === "str" ? mod(playerDef.str) : mod(playerDef.dex);
    const atkSummary = attackSummary(playerDef.mainAttack, statMod);
    const statsBar = scene.add
      .text(0, statsY, `AC ${playerDef.ac}  ·  ${playerDef.mainAttack.name} ${atkSummary}`, {
        fontSize: "11px", color: "#7aadcc", fontFamily: "monospace", resolution: DPR,
      })
      .setOrigin(0.5);

    elements.push(sep3, statsBar);

    this.container.add(elements);
  }
}
