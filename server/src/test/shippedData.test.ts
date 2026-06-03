/**
 * Tests that read the shipped JSON content and assert invariants.
 *
 * Why these matter: the Piercing/piercing case-mismatch bug (02de547)
 * silently disabled every resistance and vulnerability check in the
 * game until a player noticed. The bug was undetectable from synthetic
 * test fixtures — it only existed in the real shipped JSON. These
 * tests catch the same class of bug: invariants violated by data, not
 * by code.
 *
 * Naming: `shippedData` rather than `dataIntegrity` because the
 * specific goal is "the data ACTUALLY SHIPPED in the repo conforms to
 * the conventions the engine assumes."
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(import.meta.dirname, '..', '..', 'data');

function readAllJson<T>(dir: string): Array<{ file: string; data: T }> {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({
      file: f,
      data: JSON.parse(readFileSync(join(dir, f), 'utf-8')) as T,
    }));
}

const DAMAGE_TYPES = [
  'bludgeoning', 'piercing', 'slashing',
  'acid', 'cold', 'fire', 'force', 'lightning', 'necrotic',
  'poison', 'psychic', 'radiant', 'thunder',
];

describe('damage type casing (regression for 02de547)', () => {
  const weapons = readAllJson<{ id: string; type: string; damageType?: string }>(
    join(DATA_DIR, 'equipment'),
  ).filter((w) => w.data.type === 'weapon');

  it('every shipped weapon has lowercase damageType', () => {
    const offenders: string[] = [];
    for (const { file, data } of weapons) {
      if (!data.damageType) continue;
      if (data.damageType !== data.damageType.toLowerCase()) {
        offenders.push(`${file}: damageType="${data.damageType}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every shipped weapon damageType is a known SRD type', () => {
    const offenders: string[] = [];
    for (const { file, data } of weapons) {
      if (!data.damageType) continue;
      if (!DAMAGE_TYPES.includes(data.damageType)) {
        offenders.push(`${file}: damageType="${data.damageType}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every monster resistance / vulnerability / immunity entry is lowercase and a known SRD type', () => {
    const monsters = readAllJson<{
      id: string;
      resistances?: string[];
      vulnerabilities?: string[];
      immunities?: string[];
    }>(join(DATA_DIR, 'monsters'));

    const offenders: string[] = [];
    for (const { file, data } of monsters) {
      for (const field of ['resistances', 'vulnerabilities', 'immunities'] as const) {
        const arr = data[field];
        if (!arr) continue;
        for (const t of arr) {
          if (t !== t.toLowerCase() || !DAMAGE_TYPES.includes(t)) {
            offenders.push(`${file}: ${field}="${t}"`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
