import { EquipmentSlots, WeaponDef } from './types.js';
import type { GameContext } from './GameContext.js';
import { applyEquipment, computeEquippedSlotLabels } from './EquipmentSystem.js';
import { canSpendAction } from './ActionGuards.js';
import { isIncapacitated } from './ConditionSystem.js';
import { removeBuffsForSpell } from './Buffs.js';

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
    removeBuffsForSpell(ctx, 'mage-armor');
    ctx.addLog({ left: `Mage Armor ends — armor donned.`, style: 'status' });
  }

  const currentId = s.player.equippedSlots[slotKey];
  if (currentId) s.player.inventoryIds.push(currentId);

  const removeIdx = s.player.inventoryIds.indexOf(itemId);
  if (removeIdx !== -1) s.player.inventoryIds.splice(removeIdx, 1);
  s.player.equippedSlots[slotKey] = itemId;
  applyEquipment(ctx.playerDef, s.player.equippedSlots, ctx.defs.equipment, s.player.mageArmor, s.player.shieldActive, 0, s.player.attunedItemIds ?? []);
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
  applyEquipment(ctx.playerDef, s.player.equippedSlots, ctx.defs.equipment, s.player.mageArmor, s.player.shieldActive, 0, s.player.attunedItemIds ?? []);
  s.player.ac = ctx.playerDef.ac;
  s.player.equippedSlots = { ...s.player.equippedSlots };
  s.player.equippedSlotLabels = computeEquippedSlotLabels(ctx.playerDef, s.player.equippedSlots, ctx.defs.equipment);

  applyEquipmentCost(ctx, gate.costAction);
}

/** Re-derive AC / mainAttack / slot labels after an attunement change so a
 *  newly-attuned (or un-attuned) item's bonus takes effect immediately. */
function refreshEquipment(ctx: GameContext): void {
  const s = ctx.state;
  applyEquipment(ctx.playerDef, s.player.equippedSlots, ctx.defs.equipment, s.player.mageArmor, s.player.shieldActive, 0, s.player.attunedItemIds ?? []);
  s.player.ac = ctx.playerDef.ac;
  s.player.equippedSlotLabels = computeEquippedSlotLabels(ctx.playerDef, s.player.equippedSlots, ctx.defs.equipment);
}

const MAX_ATTUNED = 3;

/** Whether the player has `itemId` to hand (equipped or carried). */
function playerHasItem(ctx: GameContext, itemId: string): boolean {
  const s = ctx.state;
  return s.player.inventoryIds.includes(itemId)
    || Object.values(s.player.equippedSlots).includes(itemId);
}

/**
 * SRD attunement (US-124): bond to a magic item over a Short Rest. Modelled as
 * an exploration-phase action (no combat). Gated to magic items that
 * `requiresAttunement`; the player must have the item; at most 3 attuned at
 * once. Re-derives equipment so the item's bonus applies at once.
 */
export function doAttune(ctx: GameContext, itemId: string): void {
  const s = ctx.state;
  if (s.phase !== 'exploring') {
    ctx.addLog({ left: `Attuning to an item takes a Short Rest — not possible in combat.`, style: 'status' });
    return;
  }
  const item = ctx.defs.equipment.find((i) => i.id === itemId) as { id: string; name: string; magic?: boolean; requiresAttunement?: boolean } | undefined;
  if (!item || !item.magic || !item.requiresAttunement) return;
  if (!playerHasItem(ctx, itemId)) return;
  s.player.attunedItemIds = s.player.attunedItemIds ?? [];
  if (s.player.attunedItemIds.includes(itemId)) return;
  if (s.player.attunedItemIds.length >= MAX_ATTUNED) {
    ctx.addLog({ left: `Already attuned to ${MAX_ATTUNED} items — break attunement with one first.`, style: 'status' });
    return;
  }
  s.player.attunedItemIds.push(itemId);
  refreshEquipment(ctx);
  ctx.addLog({ left: `${ctx.playerDef.name} attunes to ${item.name}.`, style: 'status' });
}

/** End attunement to an item (SRD: free on a rest — modelled as a simple
 *  exploration action). */
export function doUnattune(ctx: GameContext, itemId: string): void {
  const s = ctx.state;
  const list = s.player.attunedItemIds ?? [];
  const idx = list.indexOf(itemId);
  if (idx === -1) return;
  list.splice(idx, 1);
  refreshEquipment(ctx);
  const item = ctx.defs.equipment.find((i) => i.id === itemId);
  ctx.addLog({ left: `${ctx.playerDef.name} ends attunement to ${item?.name ?? itemId}.`, style: 'status' });
}

/**
 * SRD identify (US-124): learn a found item's true name/properties. Modelled as
 * an exploration-phase action (a Short Rest examining the item, or the Identify
 * spell). Identification is informational — the item already functions; this
 * just reveals what it is.
 */
export function doIdentify(ctx: GameContext, itemId: string): void {
  const s = ctx.state;
  if (s.phase !== 'exploring') {
    ctx.addLog({ left: `Identifying an item takes a Short Rest — not possible in combat.`, style: 'status' });
    return;
  }
  if (!playerHasItem(ctx, itemId)) return;
  const item = ctx.defs.equipment.find((i) => i.id === itemId) as { id: string; name: string; startsUnidentified?: boolean } | undefined;
  if (!item || !item.startsUnidentified) return;
  s.player.identifiedItemIds = s.player.identifiedItemIds ?? [];
  if (s.player.identifiedItemIds.includes(itemId)) return;
  s.player.identifiedItemIds.push(itemId);
  // Refresh the equipped-slot labels so a now-identified equipped item shows
  // its true name.
  s.player.equippedSlotLabels = computeEquippedSlotLabels(ctx.playerDef, s.player.equippedSlots, ctx.defs.equipment);
  ctx.addLog({ left: `${ctx.playerDef.name} identifies it as ${item.name}.`, style: 'status' });
}
