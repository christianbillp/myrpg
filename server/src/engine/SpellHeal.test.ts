/**
 * US-120 Slice A — healing spell effect.
 *
 * A spell with a `heal` block restores HP = roll + the caster's spellcasting
 * ability modifier (upcasting adds dice per slot level above base), clamped to
 * the target's max HP. It heals the caster or a chosen ally; reviving a downed
 * ally (0 HP) clears Unconscious/Stable.
 */
import { describe, it, expect } from 'vitest';
import { doCastSpell } from './SpellSystem.js';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import type { SpellDef } from './types.js';

// 1d4 heal so the roll range is tight and bounded for assertions.
const CURE: SpellDef = {
  id: 'cure-wounds', name: 'Cure Wounds', level: 1, school: 'abjuration', classes: ['cleric'],
  castingTime: 'action', range: 'Touch', rangeFeet: 5,
  components: { verbal: true, somatic: true, material: null },
  duration: 'Instantaneous', concentration: false, ritual: false,
  heal: { dice: 1, sides: 4 },
} as SpellDef;

function ctxWith(playerHp: number, allies = false) {
  const npcs = allies
    ? [makeNpc({ id: 'ally_1', defId: 'commoner', tileX: 1, tileY: 0, disposition: 'ally', hp: 1, maxHp: 20 })]
    : [];
  const r = buildTestContext({
    phase: 'player_turn',
    player: { tileX: 0, tileY: 0, hp: playerHp, spellSlots: [3, 3, 3], preparedSpellIds: ['cure-wounds'] },
    playerDef: { spellcastingAbility: 'wis', wis: 16, maxHp: 30 },  // WIS mod +3
    npcs,
  });
  r.ctx.defs.spells.push(CURE);
  return r;
}

describe('Healing spells (US-120)', () => {
  it('heals the caster by roll + ability mod, clamped to max HP', () => {
    const { ctx, state, events } = ctxWith(10);
    doCastSpell(ctx, 'cure-wounds', 1, ['player'], undefined, false, events);
    // 1d4 (1..4) + WIS 3 = 4..7
    expect(state.player.hp).toBeGreaterThanOrEqual(14);
    expect(state.player.hp).toBeLessThanOrEqual(17);
  });

  it('never exceeds max HP', () => {
    const { ctx, state, events } = ctxWith(29);  // max 30
    doCastSpell(ctx, 'cure-wounds', 1, ['player'], undefined, false, events);
    expect(state.player.hp).toBe(30);
  });

  it('upcasting adds a die per slot level above base', () => {
    const { ctx, state, events } = ctxWith(1);
    doCastSpell(ctx, 'cure-wounds', 3, ['player'], undefined, false, events);
    // 3d4 (3..12) + WIS 3 = 6..15, from hp 1 → 7..16
    expect(state.player.hp).toBeGreaterThanOrEqual(7);
    expect(state.player.hp).toBeLessThanOrEqual(16);
    expect(state.player.spellSlots[2]).toBe(2);  // L3 slot spent
  });

  it('heals an ally and revives a downed one (clears Unconscious/Stable)', () => {
    const { ctx, state, events } = ctxWith(30, true);
    state.npcs[0].hp = 0;
    state.npcs[0].conditions = ['unconscious', 'stable'];
    doCastSpell(ctx, 'cure-wounds', 1, ['ally_1'], undefined, false, events);
    expect(state.npcs[0].hp).toBeGreaterThan(0);
    expect(state.npcs[0].conditions).not.toContain('unconscious');
    expect(state.npcs[0].conditions).not.toContain('stable');
  });
});
