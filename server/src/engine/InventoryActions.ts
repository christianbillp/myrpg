import { EquipmentSlots, WeaponDef } from './types.js';
import type { GameContext } from './GameContext.js';
import { applyEquipment, computeEquippedSlotLabels } from './EquipmentSystem.js';
import { canSpendAction } from './ActionGuards.js';
import { isIncapacitated } from './ConditionSystem.js';

/**
 * SRD-faithful gate for equip/unequip:
 *  - Armor: only allowed when phase === 'exploring' (don/doff take 1–10 min).
 *  - Weapons & shields:
 *      • exploring → always allowed (no action economy).
 *      • player_turn → first swap uses the one free object interaction per turn;
 *        a second swap requires the Utilize action and consumes actionUsed.
 *      • any other phase → blocked.
 *
 * Returns:
 *   { ok: true, costAction: boolean }      — proceed; if costAction, set actionUsed
 *   { ok: false, reason: string }          — refuse; reason is logged
 */
function gateEquipmentChange(
  ctx: GameContext,
  slot: 'armor' | 'weapon' | 'shield',
): { ok: true; costAction: boolean } | { ok: false; reason: string } {
  const s = ctx.state;

  if (s.phase === 'death_saves' || s.phase === 'defeat') {
    return { ok: false, reason: `Cannot change ${slot} — ${ctx.playerDef.name} is unconscious.` };
  }
  if (s.phase === 'enemy_turn') {
    return { ok: false, reason: `Cannot change ${slot} — it is not your turn.` };
  }

  if (slot === 'armor') {
    if (s.phase === 'exploring') return { ok: true, costAction: false };
    // SRD: donning/doffing armor takes minutes — impossible mid-combat.
    return { ok: false, reason: `Armor takes too long to swap in combat (1–10 minutes per SRD). Do it before or after the fight.` };
  }

  // Weapons & shields:
  if (s.phase === 'exploring') return { ok: true, costAction: false };

  // player_turn
  if (isIncapacitated(s.player.conditions)) {
    return { ok: false, reason: `Cannot manipulate equipment while incapacitated.` };
  }
  if (!s.player.freeObjectInteractionUsed) {
    // Free interaction available — use it.
    return { ok: true, costAction: false };
  }
  // Second interaction this turn — costs the Utilize action.
  if (!canSpendAction(ctx)) {
    return { ok: false, reason: `Already used your free object interaction this turn, and your Action is spent. End your turn first.` };
  }
  return { ok: true, costAction: true };
}

function applyEquipmentCost(ctx: GameContext, costAction: boolean): void {
  const s = ctx.state;
  if (s.phase === 'player_turn') {
    if (costAction) {
      s.player.actionUsed = true;
    } else {
      s.player.freeObjectInteractionUsed = true;
    }
  }
}

export function doEquip(ctx: GameContext, slot: 'armor' | 'weapon' | 'shield', itemId: string): void {
  const s = ctx.state;
  const slotKey = `${slot}Id` as keyof EquipmentSlots;
  if (!s.player.inventoryIds.includes(itemId)) return;

  const gate = gateEquipmentChange(ctx, slot);
  if (!gate.ok) {
    ctx.addLog({ left: gate.reason, style: 'status' });
    return;
  }

  if (slot === 'shield') {
    const weapon = ctx.defs.equipment.find((i) => i.id === s.player.equippedSlots.weaponId) as WeaponDef | undefined;
    if (weapon?.twoHanded) {
      ctx.addLog({ left: `Cannot equip a shield while wielding a two-handed weapon.`, style: 'status' });
      return;
    }
  }
  if (slot === 'weapon') {
    const incoming = ctx.defs.equipment.find((i) => i.id === itemId) as WeaponDef | undefined;
    if (incoming?.twoHanded && s.player.equippedSlots.shieldId) {
      s.player.inventoryIds.push(s.player.equippedSlots.shieldId);
      s.player.equippedSlots.shieldId = null;
    }
  }
  if (slot === 'armor' && s.player.mageArmor) {
    s.player.mageArmor = false;
    ctx.addLog({ left: `Mage Armor ends — armor donned.`, style: 'status' });
  }

  const currentId = s.player.equippedSlots[slotKey];
  if (currentId) s.player.inventoryIds.push(currentId);

  const removeIdx = s.player.inventoryIds.indexOf(itemId);
  if (removeIdx !== -1) s.player.inventoryIds.splice(removeIdx, 1);
  s.player.equippedSlots[slotKey] = itemId;
  applyEquipment(ctx.playerDef, s.player.equippedSlots, ctx.defs.equipment, s.player.mageArmor);
  s.player.ac = ctx.playerDef.ac;
  s.player.equippedSlots = { ...s.player.equippedSlots };
  s.player.equippedSlotLabels = computeEquippedSlotLabels(ctx.playerDef, s.player.equippedSlots, ctx.defs.equipment);

  applyEquipmentCost(ctx, gate.costAction);
}

export function doUnequip(ctx: GameContext, slot: 'armor' | 'weapon' | 'shield'): void {
  const s = ctx.state;
  const slotKey = `${slot}Id` as keyof EquipmentSlots;
  const currentId = s.player.equippedSlots[slotKey];
  if (!currentId) return;

  const gate = gateEquipmentChange(ctx, slot);
  if (!gate.ok) {
    ctx.addLog({ left: gate.reason, style: 'status' });
    return;
  }

  s.player.inventoryIds.push(currentId);
  s.player.equippedSlots[slotKey] = null;
  applyEquipment(ctx.playerDef, s.player.equippedSlots, ctx.defs.equipment, s.player.mageArmor);
  s.player.ac = ctx.playerDef.ac;
  s.player.equippedSlots = { ...s.player.equippedSlots };
  s.player.equippedSlotLabels = computeEquippedSlotLabels(ctx.playerDef, s.player.equippedSlots, ctx.defs.equipment);

  applyEquipmentCost(ctx, gate.costAction);
}
