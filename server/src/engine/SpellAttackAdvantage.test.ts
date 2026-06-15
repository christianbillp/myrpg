/**
 * Spell attack rolls honor target-condition Advantage — parity with weapon
 * attacks. The SRD Help action's `helped` marker (and blinded / restrained /
 * prone-at-melee, via `grantsAdvantageAgainst`) grant Advantage on the next
 * attack, including a spell attack (Fire Bolt etc.), and the single-use `helped`
 * marker is consumed by making the attack. (Regression: previously only weapon
 * attacks read these; a GMPC's Fire Bolt ignored an ally's Help.)
 */
import { describe, it, expect } from 'vitest';
import { doCastSpell } from './SpellSystem.js';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import type { MonsterDef, SpellDef } from './types.js';

const FIRE_BOLT: SpellDef = {
  id: 'fire-bolt', name: 'Fire Bolt', level: 0, school: 'evocation', classes: ['wizard'],
  castingTime: 'action', range: '120 feet', rangeFeet: 120,
  components: { verbal: true, somatic: true, material: null },
  duration: 'Instantaneous', concentration: false, ritual: false,
  attack: 'ranged-spell', damage: { dice: 1, sides: 10, bonus: 0, type: 'fire' },
} as SpellDef;

function dummy(): MonsterDef {
  return {
    id: 'dummy', name: 'Dummy', type: 'Medium Humanoid', maxHp: 80, ac: 10,
    str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10, proficiencyBonus: 2, initiativeBonus: 0,
    stealthBonus: 0, passivePerception: 10, speed: 30, attacks: [], xp: 0, cr: '1', color: 0x888, tokenAsset: 'x.svg', size: 'medium',
  } as MonsterDef;
}

describe('spell attack Advantage from target conditions', () => {
  function setup(targetConditions: string[]) {
    const r = buildTestContext({
      phase: 'player_turn',
      player: { tileX: 0, tileY: 0, preparedSpellIds: [] },
      playerDef: { spellcastingAbility: 'int', defaultCantripIds: ['fire-bolt'], int: 16, proficiencyBonus: 2 },
      monsters: [dummy()],
      npcs: [makeNpc({ id: 'enemy_x', defId: 'dummy', tileX: 2, tileY: 0, disposition: 'enemy', hp: 80, maxHp: 80, conditions: targetConditions })],
    });
    r.ctx.defs.spells.push(FIRE_BOLT);
    r.state.selectedTargetId = 'enemy_x';
    return r;
  }

  it('a `helped` target grants the spell attack Advantage and consumes the marker', () => {
    const { ctx, state, events, logs } = setup(['helped']);
    doCastSpell(ctx, 'fire-bolt', 0, ['enemy_x'], undefined, false, events);
    // The cast's attack-roll log notes Advantage…
    expect(logs.some((l) => /advantage/i.test(l.left + (l.right ?? '')))).toBe(true);
    // …and `helped` is single-use — consumed by making the attack.
    expect(state.npcs[0].conditions).not.toContain('helped');
  });

  it('a plain target gets no Advantage note', () => {
    const { ctx, state, events, logs } = setup([]);
    doCastSpell(ctx, 'fire-bolt', 0, ['enemy_x'], undefined, false, events);
    expect(logs.some((l) => /advantage/i.test(l.left + (l.right ?? '')))).toBe(false);
    expect(state.npcs[0].conditions).toEqual([]);
  });
});
