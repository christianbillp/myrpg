import Phaser from "phaser";
import { PLAYER_PANEL_WIDTH, GRID_COLS, GRID_ROWS, TILE_SIZE, TARGET_PANEL_WIDTH } from "../constants";
import { BaseOverlay } from "./BaseOverlay";
import { PlayerDef, EquipmentSlots } from "../data/player";
import { ItemDef, ArmorDef, WeaponDef, ShieldDef, EquipmentDef } from "../data/items";
import { mod } from "../systems/Dice";
import { attackSummary } from "../systems/EquipmentSystem";

const DPR = window.devicePixelRatio;
const W = PLAYER_PANEL_WIDTH + GRID_COLS * TILE_SIZE + TARGET_PANEL_WIDTH;
const GRID_H = GRID_ROWS * TILE_SIZE;
const ACCENT = 0x7aadcc;
const DIM = 0x334455;
const ROW_H = 28;

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

export class InventoryOverlay extends BaseOverlay {
  private wheelHandler: ((e: WheelEvent) => void) | null = null;
  private maskGraphics: Phaser.GameObjects.Graphics | null = null;

  constructor(
    scene: Phaser.Scene,
    playerDef: PlayerDef,
    slots: EquipmentSlots,
    inventory: ItemDef[],
    allItems: ItemDef[],
    canUseConsumable: boolean,
    onEquip: (slot: "armor" | "weapon" | "shield", itemId: string) => void,
    onUnequip: (slot: "armor" | "weapon" | "shield") => void,
    onUse: (itemId: string) => void,
    onClose: () => void,
  ) {
    super(scene, 580, 440, ACCENT, () => {
      if (this.wheelHandler) {
        window.removeEventListener("wheel", this.wheelHandler);
        this.wheelHandler = null;
      }
      if (this.maskGraphics?.active) this.maskGraphics.destroy();
      onClose();
    });

    const top = this.top;
    const byId = Object.fromEntries(allItems.map((i) => [i.id, i]));

    const title = scene.add
      .text(0, top + 22, "INVENTORY", { fontSize: "15px", color: "#7aadcc", fontFamily: "monospace", resolution: DPR })
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

    // ── Carried items (scrollable) ────────────────────────────────
    const sep2Y = slotCY + SLOT_H / 2 + 10;
    const sep2 = scene.add.rectangle(0, sep2Y, this.panelW - 32, 1, DIM);
    const carriedLabel = scene.add
      .text(-this.panelW / 2 + 20, sep2Y + 8, "CARRIED", { fontSize: "10px", color: "#556677", fontFamily: "monospace", resolution: DPR });
    elements.push(sep2, carriedLabel);

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

    const carryTopY  = sep2Y + 26;
    const carryBotY  = statsY - 22;
    const visibleH   = carryBotY - carryTopY;
    const lx = -this.panelW / 2 + 20;
    const rx = this.panelW / 2 - 20;

    // Group equippable items by id
    const equippable = inventory.filter(isEquipmentDef);
    const consumables = inventory.filter((i) => i.type === "consumable");
    const eqGroups: { item: EquipmentDef; count: number }[] = [];
    equippable.forEach((item) => {
      const eq = item as EquipmentDef;
      const existing = eqGroups.find((g) => g.item.id === eq.id);
      if (existing) { existing.count++; }
      else { eqGroups.push({ item: eq, count: 1 }); }
    });
    const cGroups: Record<string, { id: string; count: number }> = {};
    consumables.forEach((c) => {
      if (!cGroups[c.name]) cGroups[c.name] = { id: c.id, count: 0 };
      cGroups[c.name].count++;
    });

    // Build scrollable container
    const carryContainer = scene.add.container(0, carryTopY);
    let itemY = ROW_H / 2;

    if (eqGroups.length === 0 && Object.keys(cGroups).length === 0) {
      const emptyTxt = scene.add
        .text(0, itemY, "No items carried.", { fontSize: "11px", color: "#334455", fontFamily: "monospace", resolution: DPR })
        .setOrigin(0.5, 0.5);
      carryContainer.add(emptyTxt);
      itemY += ROW_H;
    }

    eqGroups.forEach(({ item, count }) => {
      const label = count > 1 ? `${item.name} ×${count}  ·  ${slotLabel(item, playerDef)}` : `${item.name}  ·  ${slotLabel(item, playerDef)}`;
      const itemTxt = scene.add
        .text(lx, itemY, label, { fontSize: "11px", color: "#b0c8dc", fontFamily: "monospace", resolution: DPR })
        .setOrigin(0, 0.5);
      const slot: "armor" | "weapon" | "shield" =
        item.type === "armor" ? "armor" : item.type === "weapon" ? "weapon" : "shield";
      const equipBg = scene.add
        .rectangle(rx - 36, itemY, 72, 22, 0x0a1520)
        .setStrokeStyle(1, ACCENT)
        .setInteractive({ useHandCursor: true });
      const equipTxt = scene.add
        .text(rx - 36, itemY, "EQUIP", { fontSize: "10px", color: "#7aadcc", fontFamily: "monospace", resolution: DPR })
        .setOrigin(0.5);
      equipBg.on("pointerover", () => equipBg.setFillStyle(0x1a2a3a));
      equipBg.on("pointerout",  () => equipBg.setFillStyle(0x0a1520));
      equipBg.on("pointerdown", () => onEquip(slot, item.id));
      carryContainer.add([itemTxt, equipBg, equipTxt]);
      itemY += ROW_H;
    });

    Object.entries(cGroups).forEach(([name, { id, count }]) => {
      const cTxt = scene.add
        .text(lx, itemY, `${name} ×${count}`, { fontSize: "11px", color: "#668877", fontFamily: "monospace", resolution: DPR })
        .setOrigin(0, 0.5);
      const btnColor = canUseConsumable ? 0x1a3a1a : 0x111111;
      const btnTextColor = canUseConsumable ? "#66aa66" : "#445544";
      const useBg = scene.add
        .rectangle(rx - 36, itemY, 72, 22, btnColor)
        .setStrokeStyle(1, canUseConsumable ? 0x4a8a4a : DIM)
        .setInteractive({ useHandCursor: canUseConsumable });
      const useTxt = scene.add
        .text(rx - 36, itemY, "USE", { fontSize: "10px", color: btnTextColor, fontFamily: "monospace", resolution: DPR })
        .setOrigin(0.5);
      if (canUseConsumable) {
        useBg.on("pointerover", () => useBg.setFillStyle(0x2a4a2a));
        useBg.on("pointerout",  () => useBg.setFillStyle(btnColor));
        useBg.on("pointerdown", () => onUse(id));
      }
      carryContainer.add([cTxt, useBg, useTxt]);
      itemY += ROW_H;
    });

    const totalContentH = itemY;
    const maxScroll = Math.max(0, totalContentH - visibleH);

    // Mask for clipping
    const maskGraphics = scene.add.graphics();
    maskGraphics.fillStyle(0xffffff);
    maskGraphics.fillRect(
      W / 2 - (this.panelW - 32) / 2,
      GRID_H / 2 + carryTopY,
      this.panelW - 32,
      visibleH,
    );
    maskGraphics.setVisible(false);
    carryContainer.setMask(maskGraphics.createGeometryMask());
    this.maskGraphics = maskGraphics;

    // Scrollbar
    const sbX = this.panelW / 2 - 14;
    const scrollTrack = scene.add.rectangle(sbX, (carryTopY + carryBotY) / 2, 4, visibleH, 0x1a1a2e).setAlpha(0.8);
    const scrollThumb = scene.add
      .rectangle(sbX, carryTopY + 10, 4, 20, ACCENT)
      .setAlpha(maxScroll > 0 ? 0.7 : 0)
      .setVisible(maxScroll > 0);
    elements.push(scrollTrack, scrollThumb);

    this.container.add([...elements, carryContainer]);

    if (maxScroll > 0) {
      let scrollOffset = 0;

      const updateThumb = () => {
        const thumbH = Math.max(20, (visibleH * visibleH) / totalContentH);
        const thumbRange = visibleH - thumbH;
        const thumbCY = carryTopY + (scrollOffset / maxScroll) * thumbRange + thumbH / 2;
        scrollThumb.setSize(4, thumbH).setY(thumbCY);
      };
      updateThumb();

      this.wheelHandler = (e: WheelEvent) => {
        scrollOffset = Phaser.Math.Clamp(scrollOffset + (e.deltaY > 0 ? ROW_H : -ROW_H), 0, maxScroll);
        carryContainer.setY(carryTopY - scrollOffset);
        updateThumb();
        e.preventDefault();
      };
      window.addEventListener("wheel", this.wheelHandler, { passive: false });
    }
  }

  override destroy(): void {
    if (this.wheelHandler) {
      window.removeEventListener("wheel", this.wheelHandler);
      this.wheelHandler = null;
    }
    if (this.maskGraphics?.active) this.maskGraphics.destroy();
    super.destroy();
  }
}
