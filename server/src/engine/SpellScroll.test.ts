/**
 * US-124 (Phase 9) Slice 3 — spell scrolls.
 *
 * Casting from a scroll bypasses the prepared/known + slot gates, spends NO
 * spell slot (the scroll is the resource), and consumes the scroll. A normal
 * cast of an unknown/unprepared spell still fails.
 */
import { describe, it, expect } from 'vitest';
import { doCastSpell } from './SpellSystem.js';
import { buildTestContext } from '../test/buildTestContext.js';
import type { SpellDef, ScrollDef } from './types.js';

const UTIL_SPELL: SpellDef = {
  id: 'sp1', name: 'Test Utility', level: 1, school: 'evocation', classes: ['wizard'],
  castingTime: '1 action', range: 'Self', rangeFeet: 0, components: {},
  duration: 'Instantaneous', concentration: false, ritual: false,
} as SpellDef;

const SCROLL: ScrollDef = { id: 'scroll_x', name: 'Test Scroll', type: 'scroll', spellId: 'sp1' };

function ctxWithScroll() {
  const r = buildTestContext({
    phase: 'player_turn',
    // No L1 slots and the spell isn't prepared/known — proves the scroll bypasses both.
    player: { inventoryIds: ['scroll_x'], spellSlots: [0], preparedSpellIds: [] },
  });
  r.ctx.defs.spells.push(UTIL_SPELL);
  r.ctx.defs.equipment.push(SCROLL);
  return r;
}

describe('Spell scrolls (US-124)', () => {
  it('casts from a scroll without a slot and consumes the scroll', () => {
    const { ctx, state, events } = ctxWithScroll();
    doCastSpell(ctx, 'sp1', 1, undefined, undefined, false, events, undefined, undefined, undefined, 'scroll_x');
    expect(state.player.inventoryIds).not.toContain('scroll_x');  // scroll consumed
    expect(state.player.spellSlots[0]).toBe(0);                    // no slot spent
  });

  it('a normal cast of an unknown/unprepared spell with no slot does nothing', () => {
    const { ctx, state, events } = ctxWithScroll();
    doCastSpell(ctx, 'sp1', 1, undefined, undefined, false, events);  // no scrollItemId
    expect(state.player.inventoryIds).toContain('scroll_x');  // untouched
  });

  it('rejects a scroll whose spellId does not match', () => {
    const { ctx, state, events } = ctxWithScroll();
    doCastSpell(ctx, 'sp1', 1, undefined, undefined, false, events, undefined, undefined, undefined, 'nonexistent_scroll');
    expect(state.player.inventoryIds).toContain('scroll_x');  // not consumed
  });
});
