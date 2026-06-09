/**
 * Spell-gap Bucket 2 — condition+reader spells: Bestow Curse (Cursed →
 * Disadvantage on the target's attacks), Calm Emotions (Calmed → the creature
 * makes no attacks), and Remove Curse (strip Cursed). The save spells apply
 * their `effect.onFail` via the shared resolvers; the readers live in the
 * condition system / enemy target-picker.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { doCastSpell } from './SpellSystem.js';
import { pickEnemyAttackTarget } from './NpcTurnRunners.js';
import { hasAttackDisadvantage } from './ConditionSystem.js';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import { PLAYER_FACTION_ID } from '../../../shared/types.js';
import type { SpellDef, MonsterDef } from './types.js';

const loadSpell = (id: string): SpellDef =>
  JSON.parse(readFileSync(join(__dirname, '../../data/spells', `${id}.json`), 'utf-8')) as SpellDef;

const WEAK: MonsterDef = {
  id: 'weak', name: 'Weakling', type: 'Small Humanoid', tokenAsset: '',
  maxHp: 20, ac: 12, str: 10, dex: 10, con: 10, int: 8, wis: 1, cha: 1,
  proficiencyBonus: 2, savingThrows: {}, initiativeBonus: 0, stealthBonus: 0,
  passivePerception: 9, speed: 30, attacks: [], xp: 50, cr: '1/4', color: 0, immunities: [],
} as MonsterDef;

// DC-19 caster (8 + PB 6 + WIS 5) so a WIS/CHA-1 target always fails its save.
const CASTER = { spellcastingAbility: 'wis' as const, wis: 20, proficiencyBonus: 6 };

function castCtx(npcs = [makeNpc({ id: 'gob', defId: 'weak', disposition: 'enemy', hp: 20, maxHp: 20, tileX: 8, tileY: 5 })]) {
  const r = buildTestContext({
    phase: 'player_turn',
    player: { tileX: 5, tileY: 5, spellSlots: [4, 4, 4, 4], preparedSpellIds: ['bestow-curse', 'calm-emotions', 'remove-curse'] },
    playerDef: CASTER,
    monsters: [WEAK],
    npcs,
  });
  r.ctx.defs.spells.push(loadSpell('bestow-curse'), loadSpell('calm-emotions'), loadSpell('remove-curse'));
  return r;
}

describe('Bestow Curse', () => {
  it('carries the cursed effect and the reader grants attack Disadvantage', () => {
    expect(loadSpell('bestow-curse').effect?.onFail).toBe('cursed');
    expect(hasAttackDisadvantage(['cursed'])).toBe(true);
  });

  it('applies Cursed on a failed save', () => {
    // Touch range — the target must be adjacent to the caster at (5,5).
    const { ctx, state, events } = castCtx([
      makeNpc({ id: 'gob', defId: 'weak', disposition: 'enemy', hp: 20, maxHp: 20, tileX: 6, tileY: 5 }),
    ]);
    doCastSpell(ctx, 'bestow-curse', 3, ['gob'], undefined, false, events);
    expect(state.npcs[0].conditions).toContain('cursed');
    expect(hasAttackDisadvantage(state.npcs[0].conditions)).toBe(true);
  });
});

describe('Calm Emotions', () => {
  it('applies Calmed to a creature that fails the save', () => {
    const { ctx, state, events } = castCtx();
    doCastSpell(ctx, 'calm-emotions', 2, undefined, { x: 8, y: 5 }, false, events);
    expect(state.npcs[0].conditions).toContain('calmed');
  });

  it('a calmed attacker targets no one (the becalmed reader)', () => {
    // Enemy at (5,5); a player-ally adjacent (the closer hostile); player farther.
    // A non-calmed enemy would strike the nearer ally; a calmed one takes no one.
    const { ctx, state } = castCtx([
      makeNpc({ id: 'atk', defId: 'weak', disposition: 'enemy', hp: 20, maxHp: 20, tileX: 5, tileY: 5 }),
      makeNpc({ id: 'friend', defId: 'weak', disposition: 'ally', factionId: PLAYER_FACTION_ID, hp: 20, maxHp: 20, tileX: 5, tileY: 6 }),
    ]);
    ctx.state.player.tileX = 5; ctx.state.player.tileY = 9;  // player far away
    const atk = state.npcs[0];

    expect(pickEnemyAttackTarget(ctx, atk).id).toBe('friend');  // hostile when not calmed

    atk.conditions.push('calmed');
    expect(pickEnemyAttackTarget(ctx, atk).id).toBe('player');  // no real target → synthesised fallback
  });
});

describe('Remove Curse', () => {
  it('strips the Cursed condition from a creature', () => {
    const { ctx, state, events } = castCtx([
      makeNpc({ id: 'gob', defId: 'weak', disposition: 'enemy', hp: 20, maxHp: 20, tileX: 6, tileY: 5, conditions: ['cursed'] }),
    ]);
    doCastSpell(ctx, 'remove-curse', 3, ['gob'], undefined, false, events);
    expect(state.npcs[0].conditions).not.toContain('cursed');
  });
});
