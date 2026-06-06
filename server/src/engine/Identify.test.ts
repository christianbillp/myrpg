/**
 * US-124 (Phase 9) Slice 3 — identify.
 *
 * A `startsUnidentified` item reads as "Unidentified <category>" until the
 * player identifies it (an exploration-phase Short Rest / Identify spell);
 * identification is informational (the item already functions).
 */
import { describe, it, expect } from 'vitest';
import { itemDisplayName, isItemIdentified } from '../../../shared/types.js';
import { doIdentify } from './InventoryActions.js';
import { buildTestContext } from '../test/buildTestContext.js';
import type { WeaponDef } from './types.js';

function mysteryBlade(): WeaponDef {
  return {
    id: 'mystery_blade', name: 'Sunblade', type: 'weapon', statKey: 'str',
    damageDice: 1, damageSides: 8, damageType: 'slashing', mastery: null,
    finesse: false, twoHanded: false, thrown: false, throwNormal: 0, throwLong: 0,
    magic: true, rarity: 'rare', bonus: 1, startsUnidentified: true,
  } as WeaponDef;
}

describe('itemDisplayName / isItemIdentified (US-124)', () => {
  const blade = mysteryBlade();
  it('masks an unidentified item', () => {
    expect(isItemIdentified(blade, [])).toBe(false);
    expect(itemDisplayName(blade, [])).toBe('Unidentified Weapon');
  });
  it('reveals the true name once identified', () => {
    expect(isItemIdentified(blade, ['mystery_blade'])).toBe(true);
    expect(itemDisplayName(blade, ['mystery_blade'])).toBe('Sunblade');
  });
  it('a non-unidentified item is always known', () => {
    const plain = { id: 'p', name: 'Plain', type: 'weapon' } as WeaponDef;
    expect(itemDisplayName(plain, [])).toBe('Plain');
  });
});

describe('doIdentify (US-124)', () => {
  function ctxWith() {
    const r = buildTestContext({
      phase: 'exploring',
      player: { inventoryIds: ['mystery_blade'] },
    });
    r.ctx.defs.equipment.push(mysteryBlade());
    return r;
  }

  it('identifies a held unidentified item while exploring', () => {
    const { ctx, state } = ctxWith();
    doIdentify(ctx, 'mystery_blade');
    expect(state.player.identifiedItemIds).toContain('mystery_blade');
  });

  it('refuses to identify in combat', () => {
    const { ctx, state } = ctxWith();
    state.phase = 'player_turn';
    doIdentify(ctx, 'mystery_blade');
    expect(state.player.identifiedItemIds ?? []).not.toContain('mystery_blade');
  });

  it('does nothing for an item the player does not hold', () => {
    const { ctx, state } = ctxWith();
    doIdentify(ctx, 'not_held');
    expect(state.player.identifiedItemIds ?? []).not.toContain('not_held');
  });
});
