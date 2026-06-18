/**
 * Spell cast VFX + heal beat emission. Casting a spell with a `vfx` descriptor
 * pushes a `spell_vfx` timeline beat (before any damage/heal beat); a healing
 * spell pushes a `heal` beat. Uses the real, vfx-stamped spell JSON.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { doCastSpell } from './SpellSystem.js';
import { registerPresentationHooks } from './PresentationHooks.js';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import type { SpellDef, MonsterDef } from './types.js';

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

  it('emits a condition_changed beat when a spell applies a condition (Roadmap · M1)', () => {
    const rayOfFrost = loadSpell('ray-of-frost');
    const dummy = {
      id: 'dummy', name: 'Dummy', type: 'Medium Humanoid', maxHp: 80, ac: 10,
      str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10, proficiencyBonus: 2, initiativeBonus: 0,
      stealthBonus: 0, passivePerception: 10, speed: 30, attacks: [], xp: 0, cr: '1', color: 0x888, tokenAsset: 'x.svg', size: 'medium',
    } as unknown as MonsterDef;
    const { ctx, events } = buildTestContext({
      phase: 'player_turn',
      player: { tileX: 0, tileY: 0 },
      // A huge spell-attack bonus vs AC 10 guarantees the hit, so the on-hit
      // `slowed` rider (and its condition beat) always fires.
      playerDef: { spellcastingAbility: 'int', int: 40, proficiencyBonus: 2, defaultCantripIds: ['ray-of-frost'] },
      monsters: [dummy],
      npcs: [makeNpc({ id: 'gob', defId: 'dummy', tileX: 2, tileY: 0, hp: 80, maxHp: 80, disposition: 'enemy' })],
    });
    ctx.defs.spells.push(rayOfFrost);
    ctx.state.selectedTargetId = 'gob';
    doCastSpell(ctx, 'ray-of-frost', 0, ['gob'], undefined, false, events);
    expect(events.find((e) => e.type === 'condition_changed'))
      .toMatchObject({ type: 'condition_changed', entityId: 'gob', condition: 'slowed', change: 'applied' });
  });

  it('groups an AoE\'s damage beats so they animate at once (Roadmap · M3)', () => {
    const fireball = loadSpell('fireball');
    const dummy = {
      id: 'dummy', name: 'Dummy', type: 'Medium Humanoid', maxHp: 80, ac: 10,
      str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10, proficiencyBonus: 2, initiativeBonus: 0,
      stealthBonus: 0, passivePerception: 10, speed: 30, attacks: [], xp: 0, cr: '1', color: 0x888, tokenAsset: 'x.svg', size: 'medium',
    } as unknown as MonsterDef;
    const { ctx, events } = buildTestContext({
      phase: 'player_turn',
      player: { tileX: 0, tileY: 0, spellSlots: [4, 4, 4], preparedSpellIds: ['fireball'] },
      playerDef: { spellcastingAbility: 'int', int: 16, proficiencyBonus: 2 },
      monsters: [dummy],
      npcs: [
        makeNpc({ id: 'gob1', defId: 'dummy', tileX: 6, tileY: 6, hp: 80, maxHp: 80, disposition: 'enemy' }),
        makeNpc({ id: 'gob2', defId: 'dummy', tileX: 7, tileY: 6, hp: 80, maxHp: 80, disposition: 'enemy' }),
      ],
    });
    ctx.defs.spells.push(fireball);
    registerPresentationHooks(ctx); // damage beats route through the bus → this bridge
    doCastSpell(ctx, 'fireball', 3, undefined, { x: 6, y: 6 }, false, events);
    const dmg = events.filter((e) => e.type === 'damage') as Array<{ group?: number }>;
    expect(dmg.length).toBeGreaterThanOrEqual(2);
    expect(dmg.every((d) => d.group !== undefined)).toBe(true);
    expect(new Set(dmg.map((d) => d.group)).size).toBe(1); // one shared group
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
