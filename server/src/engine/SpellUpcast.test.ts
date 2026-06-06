/**
 * US-116 (Phase 4) — upcasting spends the chosen slot, not the base-level one.
 *
 * Regression for the long-standing bug where `consumeCastingResources` scaled
 * damage / darts / rays by the requested `slotLevel` but always decremented the
 * spell's *base-level* slot. A Magic Missile (L1) upcast with a L2 slot must
 * spend the L2 slot AND throw the extra dart; a request with no slot at the
 * chosen level must fizzle before spending anything.
 */
import { describe, it, expect } from 'vitest';
import { doCastSpell } from './SpellSystem.js';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import type { SpellDef, MonsterDef } from './types.js';

const MAGIC_MISSILE: SpellDef = {
  id: 'magic-missile', name: 'Magic Missile', level: 1, school: 'evocation', classes: ['wizard'],
  castingTime: 'action', range: '120 feet', rangeFeet: 120,
  components: { verbal: true, somatic: true, material: null },
  duration: 'Instantaneous', concentration: false, ritual: false,
  attack: 'auto-hit', damage: { dice: 1, sides: 4, bonus: 1, type: 'force' }, darts: 3,
} as SpellDef;

function dummy(): MonsterDef {
  return {
    id: 'dummy', name: 'Dummy', type: 'Medium Humanoid', maxHp: 50, ac: 1,
    str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10,
    proficiencyBonus: 2, initiativeBonus: 0, stealthBonus: 0, passivePerception: 10,
    speed: 30, attacks: [], xp: 0, cr: '0', color: 0x888888, tokenAsset: 'x.svg', size: 'medium',
  } as MonsterDef;
}

function ctxWith(spellSlots: number[]) {
  const r = buildTestContext({
    phase: 'player_turn',
    player: {
      tileX: 0, tileY: 0,
      spellSlots,
      preparedSpellIds: ['magic-missile'],
    },
    playerDef: { spellcastingAbility: 'int' },
    monsters: [dummy()],
    npcs: [makeNpc({ id: 'enemy_x', defId: 'dummy', tileX: 1, tileY: 0, disposition: 'enemy', hp: 50, maxHp: 50 })],
  });
  r.ctx.defs.spells.push(MAGIC_MISSILE);
  r.state.selectedTargetId = 'enemy_x';
  return r;
}

describe('Upcasting spends the chosen slot (US-116)', () => {
  it('casting at base level spends the L1 slot and deals base damage (3 darts)', () => {
    const { ctx, state, events } = ctxWith([2, 2]);
    const hpBefore = state.npcs[0].hp;
    doCastSpell(ctx, 'magic-missile', 1, ['enemy_x'], undefined, false, events);
    expect(state.player.spellSlots[0]).toBe(1);  // L1 spent
    expect(state.player.spellSlots[1]).toBe(2);  // L2 untouched
    // 3 darts × (1d4 + 1) → 6..15 force damage.
    const dealt = hpBefore - state.npcs[0].hp;
    expect(dealt).toBeGreaterThanOrEqual(6);
    expect(dealt).toBeLessThanOrEqual(15);
  });

  it('upcasting at L2 spends the L2 slot (not L1) and throws an extra dart', () => {
    const { ctx, state, events } = ctxWith([2, 2]);
    const hpBefore = state.npcs[0].hp;
    doCastSpell(ctx, 'magic-missile', 2, ['enemy_x'], undefined, false, events);
    expect(state.player.spellSlots[0]).toBe(2);  // L1 untouched — the BUG
    expect(state.player.spellSlots[1]).toBe(1);  // L2 spent
    // 4 darts × (1d4 + 1) → 8..20 force damage.
    const dealt = hpBefore - state.npcs[0].hp;
    expect(dealt).toBeGreaterThanOrEqual(8);
    expect(dealt).toBeLessThanOrEqual(20);
  });

  it('fizzles without spending anything when no slot exists at the chosen level', () => {
    const { ctx, state, events } = ctxWith([2, 0]);  // no L2 slots
    const hpBefore = state.npcs[0].hp;
    doCastSpell(ctx, 'magic-missile', 2, ['enemy_x'], undefined, false, events);
    expect(state.player.spellSlots[0]).toBe(2);  // L1 untouched
    expect(state.player.spellSlots[1]).toBe(0);  // L2 still empty
    expect(state.player.actionUsed).toBe(false); // no action spent
    expect(state.npcs[0].hp).toBe(hpBefore);     // no damage
  });

  it('clamps a downcast request to the base level (no L0 slot index underflow)', () => {
    const { ctx, state, events } = ctxWith([2, 2]);
    doCastSpell(ctx, 'magic-missile', 0, ['enemy_x'], undefined, false, events);
    expect(state.player.spellSlots[0]).toBe(1);  // resolved to base L1
    expect(state.player.spellSlots[1]).toBe(2);
  });
});
