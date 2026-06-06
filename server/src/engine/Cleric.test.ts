/**
 * US-120 Slice B — the shipped Cleric class + playable character integrate.
 *
 * Reads the real data files so a typo in the class def, the character, or a
 * referenced spell id is caught: the Cleric class exists as a WIS full caster
 * with `from-class-list` learning; the playable Cleric's cantrip/prepared ids
 * all resolve to shipped spells; and that character can actually cast a prepared
 * cleric spell through `canCastSpell`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { canCastSpell } from './ActionGuards.js';
import { buildTestContext } from '../test/buildTestContext.js';
import type { PlayerDef } from './types.js';

const DATA_DIR = join(import.meta.dirname, '..', '..', 'data');
const readJson = (p: string) => JSON.parse(readFileSync(join(DATA_DIR, p), 'utf-8'));

function allSpellIds(): Set<string> {
  const dir = join(DATA_DIR, 'spells');
  return new Set(readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(`spells/${f}`).id as string));
}

describe('Cleric class + character (US-120)', () => {
  const cleric = readJson('classes/cleric.json');
  const calder = readJson('settings/default/characters/calder.json');

  it('Cleric is a WIS full caster that prepares from the class list', () => {
    expect(cleric.spellcasting.ability).toBe('wis');
    expect(cleric.spellcasting.slotTableKind).toBe('full');
    expect(cleric.spellcasting.learnModel).toBe('from-class-list');
    expect(cleric.spellcasting.spellSlotsByLevel).toHaveLength(20);
  });

  it('the playable Cleric references only spells that exist', () => {
    const ids = allSpellIds();
    const missing = [...(calder.defaultCantripIds ?? []), ...(calder.defaultPreparedSpellIds ?? [])]
      .filter((id: string) => !ids.has(id));
    expect(missing).toEqual([]);
  });

  it('Cure Wounds heals 2d8 per SRD 5.2.1', () => {
    const cure = readJson('spells/cure-wounds.json');
    expect(cure.heal).toEqual({ dice: 2, sides: 8 });
  });

  it('the Cleric can cast a prepared cleric spell (free hand, slot, prepared)', () => {
    const { ctx } = buildTestContext({
      phase: 'player_turn',
      player: {
        spellSlots: [2],
        preparedSpellIds: ['cure-wounds'],
        // Quarterstaff is versatile → one hand → a free hand remains for components.
        equippedSlots: { armorId: 'scale_mail', weaponId: 'quarterstaff', shieldId: null },
      },
      playerDef: { spellcastingAbility: 'wis', wis: 16 } as Partial<PlayerDef>,
    });
    ctx.defs.spells.push(readJson('spells/cure-wounds.json'));
    ctx.defs.equipment.push(readJson('equipment/quarterstaff.json'), readJson('equipment/scale_mail.json'));
    expect(canCastSpell(ctx, 'cure-wounds')).toBe(true);
  });
});
