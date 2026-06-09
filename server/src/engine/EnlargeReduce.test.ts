/**
 * Spell-gap Bucket 2 — Enlarge/Reduce. Dual-mode: self/ally → Enlarge (size up,
 * STR check/save Advantage, +1d4 weapon damage); enemy → Reduce (CON save, then
 * `reduced` → −1d4 to its weapon hits). Tests the derived buff plumbing, the
 * ±1d4 damage riders on both attack resolvers, and the enemy debuff path.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { doCastSpell } from './SpellSystem.js';
import { endConcentration } from './ConcentrationSystem.js';
import { playerThrowAttack, enemyAttack, npcReducedPenalty } from './CombatSystem.js';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import type { SpellDef, MonsterDef, PlayerAttack, MonsterAttack, NpcState } from './types.js';

const loadSpell = (id: string): SpellDef =>
  JSON.parse(readFileSync(join(__dirname, '../../data/spells', `${id}.json`), 'utf-8')) as SpellDef;

const WEAK: MonsterDef = {
  id: 'weak', name: 'Weakling', type: 'Small Humanoid', tokenAsset: '',
  maxHp: 30, ac: 10, str: 10, dex: 10, con: 1, int: 8, wis: 8, cha: 8,
  proficiencyBonus: 2, savingThrows: {}, initiativeBonus: 0, stealthBonus: 0,
  passivePerception: 9, speed: 30, attacks: [], xp: 50, cr: '1/4', color: 0, immunities: [],
} as MonsterDef;

const CASTER = { spellcastingAbility: 'wis' as const, wis: 20, proficiencyBonus: 6 };  // DC 19

afterEach(() => vi.restoreAllMocks());

function ctxWith(npcs: NpcState[] = []) {
  const r = buildTestContext({
    phase: 'player_turn',
    player: { tileX: 5, tileY: 5, spellSlots: [4, 4, 4], preparedSpellIds: ['enlarge-reduce'] },
    playerDef: CASTER,
    monsters: [WEAK],
    npcs,
  });
  r.ctx.defs.spells.push(loadSpell('enlarge-reduce'));
  return r;
}

describe('Enlarge (self)', () => {
  it('derives the size, STR advantage and +1d4 weapon-damage buff', () => {
    const { ctx, state, events } = ctxWith();
    doCastSpell(ctx, 'enlarge-reduce', 2, ['player'], undefined, false, events);
    expect(state.player.weaponDamageDice).toEqual({ count: 1, sides: 4 });
    expect(ctx.playerDef.mainAttack.damageDiceBonus).toEqual({ count: 1, sides: 4 });
    expect(state.player.buffSize).toBe('large');
    expect(state.player.enhancedAbility).toBe('str');           // STR check advantage
    expect(state.player.buffSaveAdvantage).toContain('str');    // STR save advantage
    expect(state.player.concentratingOn).toBe('enlarge-reduce');
  });

  it('clears the buff when concentration ends', () => {
    const { ctx, state, events } = ctxWith();
    doCastSpell(ctx, 'enlarge-reduce', 2, ['player'], undefined, false, events);
    endConcentration(ctx, 'test');
    expect(state.player.weaponDamageDice).toBeUndefined();
    expect(ctx.playerDef.mainAttack.damageDiceBonus).toBeUndefined();
    expect(state.player.buffSize).toBeUndefined();
  });
});

describe('+1d4 weapon-damage rider in resolvePlayerAttack', () => {
  it('adds the enlarge dice to a hit', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);  // deterministic rolls
    const { ctx } = ctxWith();
    const base: PlayerAttack = { name: 'Club', statKey: 'str', damageDice: 1, damageSides: 6, damageType: 'bludgeoning', savageAttacker: false, finesse: false, graze: false, vex: false, sap: false, slow: false, push: false, topple: false } as PlayerAttack;
    const plain = playerThrowAttack(ctx.playerDef, base, WEAK, false, false, 2);
    const enlarged = playerThrowAttack(ctx.playerDef, { ...base, damageDiceBonus: { count: 1, sides: 4 } }, WEAK, false, false, 2);
    expect(plain.isHit).toBe(true);
    // Same mock → identical base roll; the only delta is the enlarge 1d4 (d(4) at 0.5 = 3).
    expect(enlarged.damage - plain.damage).toBe(3);
  });
});

describe('Reduce (enemy)', () => {
  it('applies the reduced condition on a failed CON save', () => {
    const { ctx, state, events } = ctxWith([
      makeNpc({ id: 'gob', defId: 'weak', disposition: 'enemy', hp: 30, maxHp: 30, tileX: 6, tileY: 5 }),
    ]);
    doCastSpell(ctx, 'enlarge-reduce', 2, ['gob'], undefined, false, events);
    expect(state.npcs[0].conditions).toContain('reduced');
    expect(state.player.concentratingOn).toBe('enlarge-reduce');
  });

  it('npcReducedPenalty shaves 1d4 off the reduced creature’s hit (min 1)', () => {
    const reduced = makeNpc({ id: 'r', defId: 'weak', tileX: 0, tileY: 0, conditions: ['reduced'] });
    const normal = makeNpc({ id: 'n', defId: 'weak', tileX: 0, tileY: 0 });
    expect(npcReducedPenalty(normal)).toBe(0);
    expect(npcReducedPenalty(reduced)).toBeGreaterThanOrEqual(1);

    vi.spyOn(Math, 'random').mockReturnValue(0.5);  // d20→11 (hit vs AC 10)
    const atk: MonsterAttack = { name: 'Bite', bonus: 4, damageDice: 1, damageSides: 6, damageBonus: 2, damageType: 'piercing' } as MonsterAttack;
    const full = enemyAttack(atk, 10, false, false, 0, 0, 0);
    const shaved = enemyAttack(atk, 10, false, false, 0, 0, 3);
    expect(full.isHit).toBe(true);
    expect(shaved.damage).toBe(Math.max(1, full.damage - 3));
  });
});
