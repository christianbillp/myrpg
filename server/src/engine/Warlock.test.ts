/**
 * Warlock class (levels 1–4) — data integrity + Pact Magic casting.
 *
 * Reads the real data so a typo in the class, subclass, character, or a
 * referenced spell id is caught, and exercises the new Pact Magic gate: a
 * Warlock casts from a single short-rest pool, all slots at the pact level,
 * and can't cast a spell above that level.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { canCastSpell } from './ActionGuards.js';
import { buildTestContext } from '../test/buildTestContext.js';
import { pactMagicAt } from '../../../shared/classProgression.js';
import { hasModifierFlag } from './Modifiers.js';
import type { PlayerDef } from './types.js';
import type { ClassDef } from '../../../shared/types.js';

const DATA_DIR = join(import.meta.dirname, '..', '..', 'data');
const readJson = (p: string) => JSON.parse(readFileSync(join(DATA_DIR, p), 'utf-8'));
const spellIds = (): Set<string> =>
  new Set(readdirSync(join(DATA_DIR, 'spells')).filter((f) => f.endsWith('.json')).map((f) => readJson(`spells/${f}`).id as string));

describe('Warlock class + character', () => {
  const warlock = readJson('classes/warlock.json') as ClassDef;
  const fiend = readJson('subclasses/fiend-patron.json');
  const caelen = readJson('settings/the_sundered_reach/characters/caelen_vyr.json');

  it('is a CHA pact-magic caster with the known learn model and short-rest recovery', () => {
    expect(warlock.spellcasting!.ability).toBe('cha');
    expect(warlock.spellcasting!.slotTableKind).toBe('pact-magic');
    expect(warlock.spellcasting!.learnModel).toBe('known');
    expect(warlock.spellcasting!.recovery).toBe('short-rest');
    expect(warlock.savingThrows).toEqual(['wis', 'cha']);
    expect(warlock.hitDie).toBe(8);
  });

  it('the Pact Magic table matches the SRD for levels 1–4', () => {
    expect(pactMagicAt(warlock, 1)).toEqual({ slots: 1, slotLevel: 1 });
    expect(pactMagicAt(warlock, 2)).toEqual({ slots: 2, slotLevel: 1 });
    expect(pactMagicAt(warlock, 3)).toEqual({ slots: 2, slotLevel: 2 });
    expect(pactMagicAt(warlock, 4)).toEqual({ slots: 2, slotLevel: 2 });
  });

  it('Fiend Patron grants always-prepared spells at L3', () => {
    const l3 = fiend.progression.find((p: { level: number }) => p.level === 3);
    expect(l3.grantedSpells).toContain('burning-hands');
    expect(l3.features).toContain('dark-ones-blessing');
  });

  it('Agonizing Blast carries the flag modifier the resolver reads', () => {
    const agon = readJson('features/agonizing-blast.json');
    expect(agon.modifiers).toContainEqual({ type: 'flag', name: 'agonizing-blast' });
  });

  it('the playable elf Warlock references only spells that exist and uses Pact Magic, not Vancian slots', () => {
    const ids = spellIds();
    const missing = [...(caelen.defaultCantripIds ?? []), ...(caelen.defaultPreparedSpellIds ?? [])]
      .filter((id: string) => !ids.has(id));
    expect(missing).toEqual([]);
    expect(caelen.defaultSpellSlots).toBeUndefined();
    expect(caelen.defaultPactMagic).toEqual({ max: 2, level: 2 });
    expect(caelen.defaultCantripIds).toContain('eldritch-blast');
  });

  it('Pact Magic gates casting: pool + level cap, no overlevel, blocked at empty', () => {
    const { ctx, state } = buildTestContext({
      phase: 'player_turn',
      player: {
        spellSlots: [],
        pactMagic: { remaining: 2, max: 2, level: 2 },
        preparedSpellIds: ['charm-person', 'hold-person', 'fireball'],
        equippedSlots: { armorId: null, weaponId: null, shieldId: null },
      },
      playerDef: { spellcastingAbility: 'cha', cha: 16 } as Partial<PlayerDef>,
    });
    ctx.defs.spells.push(readJson('spells/charm-person.json'), readJson('spells/hold-person.json'), readJson('spells/fireball.json'));

    expect(canCastSpell(ctx, 'charm-person')).toBe(true);   // L1 ≤ pact level 2
    expect(canCastSpell(ctx, 'hold-person')).toBe(true);    // L2 ≤ pact level 2
    expect(canCastSpell(ctx, 'fireball')).toBe(false);      // L3 > pact level 2

    state.player.pactMagic!.remaining = 0;
    expect(canCastSpell(ctx, 'charm-person')).toBe(false);  // pool empty
  });
});

describe('Eldritch Blast + Hex + Hellish Rebuke spells', () => {
  it('Eldritch Blast is a Warlock force cantrip cast with an attack roll', () => {
    const eb = readJson('spells/eldritch-blast.json');
    expect(eb.level).toBe(0);
    expect(eb.attack).toBe('ranged-spell');
    expect(eb.damage).toEqual({ dice: 1, sides: 10, type: 'force' });
    expect(eb.classes).toContain('warlock');
  });

  it('Hellish Rebuke is a L1 reaction, 2d10 fire, DEX save for half', () => {
    const hr = readJson('spells/hellish-rebuke.json');
    expect(hr.level).toBe(1);
    expect(hr.castingTime).toBe('reaction');
    expect(hr.save).toEqual({ ability: 'dex', halfOnSuccess: true });
    expect(hr.damage).toEqual({ dice: 2, sides: 10, type: 'fire' });
  });
});
