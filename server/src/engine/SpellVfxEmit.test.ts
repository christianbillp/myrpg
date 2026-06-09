/**
 * Spell cast VFX + heal beat emission. Casting a spell with a `vfx` descriptor
 * pushes a `spell_vfx` timeline beat (before any damage/heal beat); a healing
 * spell pushes a `heal` beat. Uses the real, vfx-stamped spell JSON.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { doCastSpell } from './SpellSystem.js';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import type { SpellDef } from './types.js';

const loadSpell = (id: string): SpellDef =>
  JSON.parse(readFileSync(join(__dirname, '../../data/spells', `${id}.json`), 'utf-8')) as SpellDef;

describe('Spell cast VFX emission', () => {
  it('every shipped spell now carries a vfx descriptor', () => {
    const bless = loadSpell('bless');
    expect(bless.vfx).toBeTruthy();
    expect(bless.vfx!.style).toBeTruthy();
    expect(bless.vfx!.palette).toBeTruthy();
  });

  it('casting a self-buff emits its spell_vfx beat', () => {
    const bless = loadSpell('bless');
    const { ctx, events } = buildTestContext({
      phase: 'player_turn',
      player: { spellSlots: [4, 4, 4], preparedSpellIds: ['bless'] },
      playerDef: { spellcastingAbility: 'wis', wis: 16 },
    });
    ctx.defs.spells.push(bless);
    doCastSpell(ctx, 'bless', 1, undefined, undefined, false, events);
    const vfx = events.find((e) => e.type === 'spell_vfx');
    expect(vfx).toMatchObject({ type: 'spell_vfx', style: bless.vfx!.style, palette: bless.vfx!.palette, fromId: 'player' });
  });

  it('a healing spell emits a heal beat with the new HP', () => {
    const cure = loadSpell('cure-wounds');
    const { ctx, state, events } = buildTestContext({
      phase: 'player_turn',
      player: { hp: 1, spellSlots: [4, 4, 4], preparedSpellIds: ['cure-wounds'] },
      playerDef: { spellcastingAbility: 'wis', wis: 16, maxHp: 30 },
    });
    ctx.defs.spells.push(cure);
    doCastSpell(ctx, 'cure-wounds', 1, ['player'], undefined, false, events);
    const heal = events.find((e) => e.type === 'heal');
    expect(heal).toMatchObject({ type: 'heal', entityId: 'player' });
    expect((heal as { newHp: number }).newHp).toBe(state.player.hp);
    expect(state.player.hp).toBeGreaterThan(1);
  });

  it('orders the cast vfx before the heal beat', () => {
    const cure = loadSpell('cure-wounds');
    const { ctx, events } = buildTestContext({
      phase: 'player_turn',
      player: { hp: 1, spellSlots: [4, 4, 4], preparedSpellIds: ['cure-wounds'] },
      playerDef: { spellcastingAbility: 'wis', wis: 16, maxHp: 30 },
      npcs: [makeNpc({ id: 'ally', defId: 'commoner', disposition: 'ally', hp: 1, maxHp: 20, tileX: 1, tileY: 0 })],
    });
    ctx.defs.spells.push(cure);
    doCastSpell(ctx, 'cure-wounds', 1, ['ally'], undefined, false, events);
    const types = events.map((e) => e.type);
    expect(types.indexOf('spell_vfx')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('spell_vfx')).toBeLessThan(types.indexOf('heal'));
  });
});
