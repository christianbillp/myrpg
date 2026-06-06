/**
 * Offensive effect-descriptor data-integrity tests. The cantrip "riders"
 * (Ray of Frost / Chill Touch / Shocking Grasp) and Ray of Enfeeblement's
 * on-save condition are now driven by `effect.onHit` / `effect.onSuccess`
 * instead of `spell.id` branches in `SpellSystem`. These tests lock in the
 * data so a regression in the spell files — the new source of truth — is caught.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SpellDef } from './types.js';

const SPELLS_DIR = join(__dirname, '../../data/spells');
const loadSpell = (id: string): SpellDef =>
  JSON.parse(readFileSync(join(SPELLS_DIR, `${id}.json`), 'utf-8')) as SpellDef;

describe('offensive effect descriptors', () => {
  it('attack cantrips carry their on-hit condition rider', () => {
    expect(loadSpell('ray-of-frost').effect?.onHit).toBe('slowed');
    expect(loadSpell('chill-touch').effect?.onHit).toBe('no-healing');
    expect(loadSpell('shocking-grasp').effect?.onHit).toBe('no-reactions');
    // The rider is on a hit, so these are attack-roll spells with no save.
    for (const id of ['ray-of-frost', 'chill-touch', 'shocking-grasp']) {
      expect(loadSpell(id).attack, id).toBeTruthy();
      expect(loadSpell(id).save, id).toBeUndefined();
    }
  });

  it('Ray of Enfeeblement applies enfeebled on fail and vexed on a save', () => {
    const e = loadSpell('ray-of-enfeeblement').effect;
    expect(e?.onFail).toBe('enfeebled');
    expect(e?.onSuccess).toBe('vexed');
  });
});
