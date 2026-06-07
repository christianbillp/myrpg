/**
 * SRD Magic Initiate — the background-granted feat (Acolyte → cleric, Sage →
 * wizard) adds two cantrips + one always-prepared level-1 spell castable once
 * per Long Rest without a slot. Covers the builder application, the free-cast
 * resource pool, and the cast gate (canCastSpell) with and without the free cast.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { buildPlayerDef, type CharacterBuilderDefs, type CharacterCreationChoices } from './CharacterBuilder.js';
import { magicInitiateResources, magicInitiateResourceId } from './MagicInitiate.js';
import { canCastSpell } from './ActionGuards.js';
import { buildTestContext } from '../test/buildTestContext.js';
import type { SpellDef } from './types.js';

const DATA_DIR = join(import.meta.dirname, '..', '..', 'data');
const readDir = <T>(sub: string): T[] =>
  readdirSync(join(DATA_DIR, sub)).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(DATA_DIR, sub, f), 'utf-8')) as T);

function realDefs(): CharacterBuilderDefs {
  return {
    classes: readDir('classes'), backgrounds: readDir('backgrounds'), species: readDir('species'),
    feats: readDir('feats'), features: readDir('features'), equipment: readDir('equipment'), spells: readDir('spells'),
  };
}

describe('Magic Initiate (SRD origin feat)', () => {
  const defs = realDefs();

  it('a non-caster Fighter with the Acolyte feat gains the cantrips, an always-prepared spell, and a casting ability', () => {
    const choices: CharacterCreationChoices = {
      name: 'Faithful Blade', speciesId: 'human', backgroundId: 'acolyte', classId: 'fighter',
      abilityMethod: 'standard-array', baseAbilityScores: { str: 15, dex: 13, con: 14, int: 8, wis: 12, cha: 10 },
      backgroundAbility: { kind: 'two-one', plusTwo: 'wis', plusOne: 'int' },  // acolyte = int/wis/cha
      skillProficiencies: ['athletics', 'intimidation'],
      speciesSkills: ['perception'], speciesFeat: 'alert',  // Human grants
      magicInitiate: [{ featId: 'magic-initiate', cantripIds: ['guidance', 'resistance'], spellId: 'bless', ability: 'wis' }],
    };
    const r = buildPlayerDef(choices, defs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const pd = r.playerDef;
    // Fighter is a non-caster, so the only known cantrips come from the feat.
    expect(pd.defaultCantripIds).toEqual(expect.arrayContaining(['guidance', 'resistance']));
    expect(pd.magicInitiateSpellIds).toEqual(['bless']);
    expect(pd.spellcastingAbility).toBe('wis');           // gained from the feat (non-caster)
    expect(pd.defaultPreparedSpellIds).toBeUndefined();   // MI spell is tracked separately, not in the class list
  });

  it('respects the pinned background spell list (Acolyte = cleric)', () => {
    const base: CharacterCreationChoices = {
      name: 'X', speciesId: 'human', backgroundId: 'acolyte', classId: 'fighter',
      abilityMethod: 'standard-array', baseAbilityScores: { str: 15, dex: 13, con: 14, int: 8, wis: 12, cha: 10 },
      backgroundAbility: { kind: 'two-one', plusTwo: 'wis', plusOne: 'int' },
      skillProficiencies: ['athletics', 'intimidation'], speciesSkills: ['perception'], speciesFeat: 'alert',
    };
    // A wizard spell isn't on the pinned cleric list → rejected.
    expect(buildPlayerDef({ ...base, magicInitiate: [{ featId: 'magic-initiate', cantripIds: ['guidance', 'resistance'], spellId: 'mage-armor', ability: 'wis' }] }, defs).ok).toBe(false);
    // Missing picks → rejected (the feat grants real choices the player must make).
    expect(buildPlayerDef(base, defs).ok).toBe(false);
  });

  it('seeds one free cast per Magic Initiate spell', () => {
    const pd = { magicInitiateSpellIds: ['bless', 'guiding-bolt'] } as Parameters<typeof magicInitiateResources>[0];
    expect(magicInitiateResources(pd)).toEqual({ 'magic-initiate:bless': 1, 'magic-initiate:guiding-bolt': 1 });
    expect(magicInitiateResources({} as typeof pd)).toEqual({});
  });

  it('canCastSpell allows the MI spell with no slot when the free cast is available, and blocks it when spent', () => {
    const spellId = 'mi-test-spell';
    const spell = {
      id: spellId, level: 1, castingTime: 'action',
      components: { verbal: true, somatic: false, material: null },
    } as unknown as SpellDef;

    const { ctx, state } = buildTestContext({
      playerDef: { spellcastingAbility: 'wis', magicInitiateSpellIds: [spellId] },
      player: { spellSlots: [], resources: { [magicInitiateResourceId(spellId)]: 1 } },
    });
    ctx.defs.spells = [spell];

    // No slot, but a free cast is available → castable.
    expect(canCastSpell(ctx, spellId)).toBe(true);

    // Spend the free cast → no longer castable (no slot, no free cast).
    state.player.resources[magicInitiateResourceId(spellId)] = 0;
    expect(canCastSpell(ctx, spellId)).toBe(false);

    // A normal slot makes it castable again regardless of the free cast.
    state.player.spellSlots = [1];
    expect(canCastSpell(ctx, spellId)).toBe(true);
  });
});
