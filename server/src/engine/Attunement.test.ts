/**
 * US-124 (Phase 9) Slice 2 — attunement.
 *
 * A `requiresAttunement` magic item's bonus applies only while the player is
 * attuned to it; at most 3 items attuned; attuning is an exploration-phase
 * (Short Rest) action.
 */
import { describe, it, expect } from 'vitest';
import { effectiveItemBonus } from './EquipmentSystem.js';
import { doAttune, doUnattune } from './InventoryActions.js';
import { buildTestContext } from '../test/buildTestContext.js';
import type { WeaponDef } from './types.js';

describe('effectiveItemBonus gating (US-124)', () => {
  const attItem = { id: 'blade', bonus: 1, requiresAttunement: true };
  it('is 0 for a requires-attunement item when not attuned', () => {
    expect(effectiveItemBonus(attItem, [])).toBe(0);
  });
  it('applies once attuned', () => {
    expect(effectiveItemBonus(attItem, ['blade'])).toBe(1);
  });
  it('applies unconditionally when attunement is not required', () => {
    expect(effectiveItemBonus({ id: 'b', bonus: 2 }, [])).toBe(2);
  });
});

function attunableSword(): WeaponDef {
  return {
    id: 'oathblade', name: 'Oathblade', type: 'weapon', statKey: 'str',
    damageDice: 1, damageSides: 8, damageType: 'slashing', mastery: null,
    finesse: false, twoHanded: false, thrown: false, throwNormal: 0, throwLong: 0,
    magic: true, rarity: 'rare', bonus: 1, requiresAttunement: true,
  } as WeaponDef;
}

function ctxWithSword(extra: Record<string, unknown> = {}) {
  const r = buildTestContext({
    phase: 'exploring',
    player: { equippedSlots: { armorId: null, weaponId: 'oathblade', shieldId: null }, inventoryIds: [], ...extra },
    playerDef: { mainAttack: { name: 'Oathblade', statKey: 'str', damageDice: 1, damageSides: 8, damageType: 'slashing', savageAttacker: false, finesse: false, graze: false, vex: false, sap: false, slow: false, push: false, topple: false } as never },
  });
  r.ctx.defs.equipment.push(attunableSword());
  return r;
}

describe('doAttune / doUnattune (US-124)', () => {
  it('attunes an equipped requires-attunement item and applies its bonus', () => {
    const { ctx, state } = ctxWithSword();
    doAttune(ctx, 'oathblade');
    expect(state.player.attunedItemIds).toContain('oathblade');
    expect(ctx.playerDef.mainAttack.magicWeaponBonus).toBe(1);  // bonus now live
  });

  it('un-attuning removes the bonus again', () => {
    const { ctx, state } = ctxWithSword();
    doAttune(ctx, 'oathblade');
    doUnattune(ctx, 'oathblade');
    expect(state.player.attunedItemIds).not.toContain('oathblade');
    expect(ctx.playerDef.mainAttack.magicWeaponBonus).toBeUndefined();
  });

  it('refuses to attune in combat', () => {
    const { ctx, state } = ctxWithSword();
    state.phase = 'player_turn';
    doAttune(ctx, 'oathblade');
    expect(state.player.attunedItemIds ?? []).not.toContain('oathblade');
  });

  it('caps attunement at 3 items', () => {
    const { ctx, state } = ctxWithSword({ attunedItemIds: ['a', 'b', 'c'], inventoryIds: ['oathblade'] });
    doAttune(ctx, 'oathblade');
    expect(state.player.attunedItemIds).not.toContain('oathblade');
    expect(state.player.attunedItemIds!.length).toBe(3);
  });
});
