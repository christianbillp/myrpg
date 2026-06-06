/**
 * Persistent-zone data-integrity tests. After the zone logic was made
 * data-driven (SpellDef.zone replaces the per-id ZONE_SPELL_IDS / tintByShape /
 * ENTER_SAVE_BY_SPELL tables in SpellSystem), the spell JSON files are the
 * single source of truth for which spells form zones and how. These tests lock
 * in the descriptors so a regression in the data — not just the code — is caught.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SpellDef } from './types.js';

const SPELLS_DIR = join(__dirname, '../../data/spells');

function loadSpell(id: string): SpellDef {
  return JSON.parse(readFileSync(join(SPELLS_DIR, `${id}.json`), 'utf-8')) as SpellDef;
}

describe('spell zone descriptors', () => {
  it('cast-condition zones tag the area with no save (Fog Cloud, Darkness)', () => {
    for (const id of ['fog-cloud', 'darkness']) {
      const z = loadSpell(id).zone;
      expect(z, id).toBeDefined();
      expect(z!.castCondition, id).toBe('heavily-obscured');
      expect(z!.castLabel, id).toBeTruthy();
      expect(z!.castSave, id).toBeUndefined();
      expect(z!.groundPlaceable, id).toBeFalsy();
      expect(z!.tintHex, id).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('Web is a cast-save zone with a DEX restrain + difficult terrain + enter rider', () => {
    const z = loadSpell('web').zone;
    expect(z?.castSave).toEqual({ ability: 'dex', condition: 'restrained', label: 'Restrained (Web)' });
    expect(z?.difficultTerrain).toBe(true);
    expect(z?.enterSave?.ability).toBe('dex');
    expect(z?.groundPlaceable).toBeFalsy();
  });

  it('Grease is a ground-placeable difficult-terrain zone with a prone enter rider', () => {
    const z = loadSpell('grease').zone;
    expect(z?.groundPlaceable).toBe(true);
    expect(z?.difficultTerrain).toBe(true);
    expect(z?.enterSave).toEqual({ ability: 'dex', condition: 'prone' });
    expect(z?.castCondition).toBeUndefined();
    expect(z?.castSave).toBeUndefined();
  });

  it('visual ground zones register without saves or difficult terrain (Silent/Minor Illusion, Gust)', () => {
    for (const id of ['silent-image', 'minor-illusion', 'gust-of-wind']) {
      const z = loadSpell(id).zone;
      expect(z?.groundPlaceable, id).toBe(true);
      expect(z?.enterSave, id).toBeUndefined();
      expect(z?.castCondition, id).toBeUndefined();
      expect(z?.castSave, id).toBeUndefined();
      expect(z?.tintHex, id).toMatch(/^#[0-9a-f]{6}$/i);
    }
    // Only Web and Grease impose difficult terrain.
    expect(loadSpell('gust-of-wind').zone?.difficultTerrain).toBeFalsy();
  });
});
