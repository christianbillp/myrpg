/**
 * SRD 5.2.1 Mage stat-block fidelity (mage-monster-plan.md, slice 1). The Mage
 * is the first US-117 consumer and doubles as Investigator Aldric Vane in The
 * Long Account ch2–ch3 — these assertions pin the numbers to the SRD so a
 * future edit can't silently drift them. Spellcasting / Misty Step /
 * Protective Magic land in later slices.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { monsterStatBlockBits, monsterSpellsLine } from '../aigm.js';
import { monsterLimitedUses } from './SpawnHelpers.js';

const mage = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'data', 'monsters', 'mage.json'), 'utf8'),
);

describe('Mage stat block vs SRD 5.2.1', () => {
  it('is a Medium or Small Humanoid (Wizard), Neutral', () => {
    expect(mage.type).toBe('Medium or Small Humanoid (Wizard), Neutral');
  });

  it('has the SRD core numbers (AC 15, HP 81/18d8, speed 30, CR 6, XP 2300, PB +3)', () => {
    expect(mage.ac).toBe(15);
    expect(mage.maxHp).toBe(81);
    expect(mage.hpFormula).toBe('18d8');
    expect(mage.speed).toBe(30);
    expect(mage.cr).toBe('6');
    expect(mage.xp).toBe(2300);
    expect(mage.proficiencyBonus).toBe(3);
  });

  it('has the SRD ability scores and saving throws', () => {
    expect([mage.str, mage.dex, mage.con, mage.int, mage.wis, mage.cha]).toEqual([9, 14, 11, 17, 12, 11]);
    expect(mage.savingThrows).toEqual({ str: -1, dex: 2, con: 0, int: 6, wis: 4, cha: 0 });
  });

  it('Multiattack makes THREE Arcane Burst attacks', () => {
    expect(mage.multiattack).toBe(3);
  });

  it('Arcane Burst is +6, reach 5 ft or range 120 ft, 3d8+3 Force, melee or ranged', () => {
    const burst = mage.attacks[0];
    expect(burst.name).toBe('Arcane Burst');
    expect(burst.attackType).toBe('both');
    expect(burst.bonus).toBe(6);
    expect(burst.reach).toBe(5);
    expect(burst.rangeNormal).toBe(120);
    expect(burst.damageDice).toBe(3);
    expect(burst.damageSides).toBe(8);
    expect(burst.damageBonus).toBe(3);
    expect(burst.damageType).toBe('force');
  });

  it('carries the SRD skills, languages and gear (AIGM-facing flavour)', () => {
    expect(mage.skills).toEqual({ arcana: 6, history: 6, perception: 4 });
    expect(mage.passivePerception).toBe(14); // 10 + Perception +4
    expect(mage.languages).toEqual(['Common plus three other languages']);
    expect(mage.gear).toEqual(['wand']);
  });
});

describe('Mage Spellcasting entry vs SRD 5.2.1 (data; resolution lands in later slices)', () => {
  it('casts with Intelligence at save DC 14', () => {
    expect(mage.spellcasting.ability).toBe('int');
    expect(mage.spellcasting.saveDC).toBe(14);
  });

  it('knows the SRD at-will utilities', () => {
    expect(mage.spellcasting.atWill).toEqual(
      ['detect-magic', 'light', 'mage-armor', 'mage-hand', 'prestidigitation'],
    );
  });

  it('has 2/day Fireball (level 4 version) + Invisibility, 1/day Cone of Cold + Fly', () => {
    expect(mage.spellcasting.perDay).toEqual([
      { spellId: 'fireball', uses: 2, castLevel: 4 },
      { spellId: 'invisibility', uses: 2 },
      { spellId: 'cone-of-cold', uses: 1 },
      { spellId: 'fly', uses: 1 },
    ]);
  });

  it('has Misty Step 3/day as a bonus action and Protective Magic 3/day as a reaction', () => {
    expect(mage.spellcasting.bonusAction).toEqual([{ spellId: 'misty-step', uses: 3 }]);
    expect(mage.reactions).toEqual([{ kind: 'protective-magic', usesPerDay: 3 }]);
  });
});

describe('monsterLimitedUses — per-spawn use seeding (US-117 slice 2)', () => {
  it('seeds the Mage spawn with every limited-use pool', () => {
    expect(monsterLimitedUses(mage)).toEqual({
      spellUses: { fireball: 2, invisibility: 2, 'cone-of-cold': 1, fly: 1, 'misty-step': 3 },
      reactionUses: { 'protective-magic': 3 },
    });
  });

  it('is a no-op for non-casters and missing defs', () => {
    expect(monsterLimitedUses(undefined)).toEqual({});
    const bandit = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', '..', 'data', 'monsters', 'bandit.json'), 'utf8'),
    );
    expect(monsterLimitedUses(bandit)).toEqual({});
  });
});

describe('monsterStatBlockBits — AIGM combatant-line flavour', () => {
  it('formats the Mage skills/languages/gear into one line', () => {
    expect(monsterStatBlockBits(mage)).toBe(
      'Skills: arcana +6, history +6, perception +4 · Languages: Common plus three other languages · Gear: wand',
    );
  });

  it('returns an empty string for a def with no flavour fields', () => {
    expect(monsterStatBlockBits({})).toBe('');
  });

  it('monsterSpellsLine reports live remaining uses against the stat-block maxima', () => {
    const line = monsterSpellsLine(mage, {
      spellUses: { fireball: 1, invisibility: 2, 'cone-of-cold': 0, fly: 1, 'misty-step': 2 },
      reactionUses: { 'protective-magic': 2 },
    });
    expect(line).toBe(
      'Spells DC 14: fireball(1/2)@L4, invisibility(2/2), cone-of-cold(0/1), fly(1/1)'
      + ' · misty-step(2/3) (bonus action)'
      + ' · Protective Magic(2/3)'
      + ' · At will: detect-magic, light, mage-armor, mage-hand, prestidigitation',
    );
    expect(monsterSpellsLine({}, {})).toBe('');
  });
});
