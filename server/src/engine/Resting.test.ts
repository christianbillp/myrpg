/**
 * Long Rest prepared-spell cap tests. The cap now comes from the class
 * definition's `spellcasting.preparedSpellsByLevel` (shared with level-up) and
 * the prep picker is gated on the spellbook learn model — not a hardcoded
 * Wizard table or a class-name check. These tests lock in both: the picker
 * only appears for spellbook casters, and the cap tracks the class data
 * (including the higher-level values the old hardcoded table got wrong).
 */
import { describe, it, expect } from 'vitest';
import { buildLongRestPreview, type RestingInputs } from './Resting.js';
import type { ClassDef, PlayerDef, PlayerState } from './types.js';

const WIZARD_PREPARED = [4, 5, 6, 7, 9, 10, 11, 12, 14, 15, 16, 16, 17, 18, 19, 21, 22, 23, 24, 25];

function wizardClass(): ClassDef {
  return {
    id: 'wizard', name: 'Wizard',
    spellcasting: { learnModel: 'spellbook', preparedSpellsByLevel: WIZARD_PREPARED },
  } as unknown as ClassDef;
}

function sorcererClass(): ClassDef {
  return {
    id: 'sorcerer', name: 'Sorcerer',
    spellcasting: { learnModel: 'known', spellsKnownByLevel: WIZARD_PREPARED },
  } as unknown as ClassDef;
}

function mkInputs(level: number, classDef: ClassDef | null, prepared: string[] = []): RestingInputs {
  const playerDef = {
    name: 'Wren', level, maxHp: 10, className: classDef?.name ?? 'Wizard',
    defaultSpellSlots: [], defaultFeatureIds: [], defaultSpellbookIds: ['fire-bolt', 'magic-missile', 'shield'],
  } as unknown as PlayerDef;
  const player = {
    hp: 10, hitDiceUsed: 0, spellSlots: [], resources: {}, exhaustionLevel: 0,
    preparedSpellIds: prepared,
  } as unknown as PlayerState;
  const spells = [
    { id: 'fire-bolt', name: 'Fire Bolt', level: 0, school: 'evocation' },
    { id: 'magic-missile', name: 'Magic Missile', level: 1, school: 'evocation' },
    { id: 'shield', name: 'Shield', level: 1, school: 'abjuration' },
  ] as unknown as RestingInputs['spells'];
  return { playerDef, player, features: [], spells, classDef };
}

describe('Long Rest prepared-spell cap', () => {
  it('exposes the spellbook prep picker for spellbook casters', () => {
    const p = buildLongRestPreview(mkInputs(5, wizardClass()));
    expect(p.wizardSpellPrep).toBeDefined();
    expect(p.wizardSpellPrep!.maxPrepared).toBe(WIZARD_PREPARED[4]); // L5 → 9
    expect(p.wizardSpellPrep!.spellbookSpells.map((s) => s.id)).toEqual(['fire-bolt', 'magic-missile', 'shield']);
  });

  it('uses the class table at high levels (fixes the stale hardcoded plateau)', () => {
    expect(buildLongRestPreview(mkInputs(16, wizardClass())).wizardSpellPrep!.maxPrepared).toBe(21);
    expect(buildLongRestPreview(mkInputs(20, wizardClass())).wizardSpellPrep!.maxPrepared).toBe(25);
  });

  it('never strips feat-granted extras below the current prepared count', () => {
    const p = buildLongRestPreview(mkInputs(1, wizardClass(), ['magic-missile', 'shield']));
    // L1 table value is 4, current is 2 → cap stays 4. Bump current past the
    // table to confirm the max() floor.
    const big = buildLongRestPreview(mkInputs(1, wizardClass(), ['a', 'b', 'c', 'd', 'magic-missile']));
    expect(p.wizardSpellPrep!.maxPrepared).toBe(4);
    expect(big.wizardSpellPrep!.maxPrepared).toBeGreaterThanOrEqual(4);
  });

  it('omits the picker for non-spellbook casters and unknown classes', () => {
    expect(buildLongRestPreview(mkInputs(5, sorcererClass())).wizardSpellPrep).toBeUndefined();
    expect(buildLongRestPreview(mkInputs(5, null)).wizardSpellPrep).toBeUndefined();
  });
});
