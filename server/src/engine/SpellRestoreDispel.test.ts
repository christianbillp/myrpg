/**
 * Spell-gap Bucket 4 — targeted utility resolvers: Lesser Restoration (end a
 * condition), Spare the Dying (stabilise a downed creature), Dispel Magic
 * (strip a creature's spell-layer effects). Driven through the real cast path
 * (`doCastSpell` → `resolveUtilitySpell`) with the shipped spell JSON.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { doCastSpell } from './SpellSystem.js';
import { applyBuffTo } from './Buffs.js';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import type { SpellDef, MonsterDef, NpcState } from './types.js';

const SPELLS_DIR = join(__dirname, '../../data/spells');
const loadSpell = (id: string): SpellDef =>
  JSON.parse(readFileSync(join(SPELLS_DIR, `${id}.json`), 'utf-8')) as SpellDef;

const GOBLIN: MonsterDef = {
  id: 'goblin', name: 'Goblin', type: 'Small Humanoid', tokenAsset: '',
  maxHp: 20, ac: 12, str: 8, dex: 14, con: 10, int: 8, wis: 8, cha: 8,
  proficiencyBonus: 2, savingThrows: {}, initiativeBonus: 0, stealthBonus: 0,
  passivePerception: 9, speed: 30, attacks: [], xp: 50, cr: '1/4', color: 0, immunities: [],
} as MonsterDef;

function ctxWith(npcs: NpcState[]) {
  const r = buildTestContext({
    phase: 'player_turn',
    player: { tileX: 5, tileY: 5, spellSlots: [4, 4, 4, 4, 4], preparedSpellIds: ['lesser-restoration', 'dispel-magic'] },
    playerDef: { spellcastingAbility: 'wis', wis: 16, defaultCantripIds: ['spare-the-dying'] },
    monsters: [GOBLIN],
    npcs,
  });
  r.ctx.defs.spells.push(loadSpell('lesser-restoration'), loadSpell('spare-the-dying'), loadSpell('dispel-magic'));
  return r;
}

describe('Lesser Restoration', () => {
  it('ends one condition on the caster (priority order), leaving the rest', () => {
    const { ctx, state, events } = ctxWith([]);
    state.player.conditions = ['blinded', 'poisoned'];  // poisoned outranks blinded
    doCastSpell(ctx, 'lesser-restoration', 2, ['player'], undefined, false, events);
    expect(state.player.conditions).not.toContain('poisoned');
    expect(state.player.conditions).toContain('blinded');
  });

  it('ends a condition on a touched ally', () => {
    const { ctx, state, events } = ctxWith([
      makeNpc({ id: 'ally', defId: 'goblin', disposition: 'ally', hp: 20, maxHp: 20, tileX: 6, tileY: 5, conditions: ['paralyzed', 'poisoned'] }),
    ]);
    doCastSpell(ctx, 'lesser-restoration', 2, ['ally'], undefined, false, events);
    expect(state.npcs[0].conditions).not.toContain('paralyzed');  // paralyzed is top priority
    expect(state.npcs[0].conditions).toContain('poisoned');
  });
});

describe('Spare the Dying', () => {
  it('stabilises a creature at 0 HP', () => {
    const { ctx, state, events } = ctxWith([
      makeNpc({ id: 'downed', defId: 'goblin', disposition: 'ally', hp: 0, maxHp: 20, tileX: 6, tileY: 5, conditions: ['unconscious'] }),
    ]);
    doCastSpell(ctx, 'spare-the-dying', 0, ['downed'], undefined, false, events);
    expect(state.npcs[0].conditions).toContain('stable');
  });

  it('does nothing to a creature that is not dying', () => {
    const { ctx, state, events } = ctxWith([
      makeNpc({ id: 'gob', defId: 'goblin', disposition: 'enemy', hp: 20, maxHp: 20, tileX: 6, tileY: 5 }),
    ]);
    doCastSpell(ctx, 'spare-the-dying', 0, ['gob'], undefined, false, events);
    expect(state.npcs[0].conditions).not.toContain('stable');
  });
});

describe('Dispel Magic', () => {
  it('strips spell buffs and spell-condition effects from a creature', () => {
    const { ctx, state, events } = ctxWith([
      makeNpc({ id: 'gob', defId: 'goblin', disposition: 'enemy', hp: 20, maxHp: 20, tileX: 6, tileY: 5, conditions: ['blinded'] }),
    ]);
    const gob = state.npcs[0];
    applyBuffTo(gob, { spellId: 'haste' });
    gob.ongoingEffects = [{ id: 'oe1', kind: 'spell-condition', spellId: 'color-spray', condition: 'blinded', turnsRemaining: 2 }];

    doCastSpell(ctx, 'dispel-magic', 3, ['gob'], undefined, false, events);

    expect((gob.activeBuffs ?? []).some((b) => b.spellId === 'haste')).toBe(false);
    expect(gob.conditions).not.toContain('blinded');
    expect((gob.ongoingEffects ?? []).some((oe) => oe.kind === 'spell-condition')).toBe(false);
  });

  it('reports nothing to dispel on a mundane creature', () => {
    const { ctx, state, events } = ctxWith([
      makeNpc({ id: 'gob', defId: 'goblin', disposition: 'enemy', hp: 20, maxHp: 20, tileX: 6, tileY: 5 }),
    ]);
    doCastSpell(ctx, 'dispel-magic', 3, ['gob'], undefined, false, events);
    // No throw, no buffs invented; the creature is untouched.
    expect(state.npcs[0].activeBuffs ?? []).toHaveLength(0);
  });
});
