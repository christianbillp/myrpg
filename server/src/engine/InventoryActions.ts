import { EquipmentSlots, WeaponDef } from './types.js';
import type { GameContext } from './GameContext.js';
import { applyEquipment, computeEquippedSlotLabels } from './EquipmentSystem.js';

export function doEquip(ctx: GameContext, slot: 'armor' | 'weapon' | 'shield', itemId: string): void {
  const s = ctx.state;
  const slotKey = `${slot}Id` as keyof EquipmentSlots;
  if (!s.player.inventoryIds.includes(itemId)) return;

  if (slot === 'shield') {
    const weapon = ctx.defs.equipment.find((i) => i.id === s.player.equippedSlots.weaponId) as WeaponDef | undefined;
    if (weapon?.twoHanded) return;
  }
  if (slot === 'weapon') {
    const incoming = ctx.defs.equipment.find((i) => i.id === itemId) as WeaponDef | undefined;
    if (incoming?.twoHanded && s.player.equippedSlots.shieldId) {
      s.player.inventoryIds.push(s.player.equippedSlots.shieldId);
      s.player.equippedSlots.shieldId = null;
    }
  }

  const currentId = s.player.equippedSlots[slotKey];
  if (currentId) s.player.inventoryIds.push(currentId);

  const removeIdx = s.player.inventoryIds.indexOf(itemId);
  if (removeIdx !== -1) s.player.inventoryIds.splice(removeIdx, 1);
  s.player.equippedSlots[slotKey] = itemId;
  applyEquipment(ctx.playerDef, s.player.equippedSlots, ctx.defs.equipment);
  s.player.equippedSlots = { ...s.player.equippedSlots };
  s.player.equippedSlotLabels = computeEquippedSlotLabels(ctx.playerDef, s.player.equippedSlots, ctx.defs.equipment);
}

export function doUnequip(ctx: GameContext, slot: 'armor' | 'weapon' | 'shield'): void {
  const s = ctx.state;
  const slotKey = `${slot}Id` as keyof EquipmentSlots;
  const currentId = s.player.equippedSlots[slotKey];
  if (!currentId) return;
  s.player.inventoryIds.push(currentId);
  s.player.equippedSlots[slotKey] = null;
  applyEquipment(ctx.playerDef, s.player.equippedSlots, ctx.defs.equipment);
  s.player.equippedSlots = { ...s.player.equippedSlots };
  s.player.equippedSlotLabels = computeEquippedSlotLabels(ctx.playerDef, s.player.equippedSlots, ctx.defs.equipment);
}
