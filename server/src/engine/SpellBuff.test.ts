/**
 * Self-buff primitive layer (US-065 buff spells). `recomputeBuffs` derives the
 * AC bonus, per-category d20 dice bonuses, save advantages, and damage
 * resistances from active buffs; `computeAC` adds the AC bonus; `rollDiceBonus`
 * rolls the Bless/Guidance die.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { applySelfBuff, recomputeBuffs } from './Buffs.js';
import { computeAC } from './EquipmentSystem.js';
import { npcBanePenalty } from './CombatSystem.js';
import { npcSaveMod } from './SpellSystem.js';
import { applyLongRest, buildLongRestPreview, type RestingInputs } from './Resting.js';
import { rollDiceBonus, mod } from './Dice.js';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import type { PlayerDef, PlayerState, MonsterDef } from './types.js';

afterEach(() => vi.restoreAllMocks());

describe('recomputeBuffs — buff layer derivation', () => {
  it('derives AC / dice / save-advantage / resistance from active buffs', () => {
    const { ctx, state } = buildTestContext({});
    applySelfBuff(ctx, { spellId: 'shield-of-faith', modifiers: [{ type: 'ac-bonus', value: 2 }] });
    applySelfBuff(ctx, { spellId: 'bless', modifiers: [{ type: 'dice-bonus', on: 'attack', count: 1, sides: 4 }, { type: 'dice-bonus', on: 'save', count: 1, sides: 4 }] });
    applySelfBuff(ctx, { spellId: 'guidance', modifiers: [{ type: 'dice-bonus', on: 'check', count: 1, sides: 4 }] });
    applySelfBuff(ctx, { spellId: 'haste', modifiers: [{ type: 'ac-bonus', value: 2 }, { type: 'advantage', on: 'save', key: 'dex' }] });
    applySelfBuff(ctx, { spellId: 'protection-from-energy', modifiers: [{ type: 'resistance', damageType: 'fire' }] });
    applySelfBuff(ctx, { spellId: 'resistance', modifiers: [{ type: 'damage-reduction', damageType: 'cold', count: 1, sides: 4 }] });

    expect(state.player.buffDamageReduction).toEqual({ damageType: 'cold', count: 1, sides: 4 });
    expect(state.player.acBonus).toBe(4);                                // Shield of Faith + Haste stack
    expect(state.player.attackDiceBonus).toEqual({ count: 1, sides: 4 });
    expect(state.player.saveDiceBonus).toEqual({ count: 1, sides: 4 });
    expect(state.player.checkDiceBonus).toEqual({ count: 1, sides: 4 });
    expect(state.player.buffSaveAdvantage).toContain('dex');
    expect(state.player.buffResistances).toContain('fire');
    // AC reflects the +4: base 10 + DEX mod + buff bonus.
    expect(state.player.ac).toBe(10 + mod(ctx.playerDef.dex) + 4);
  });

  it('clears derived fields when the buffs are removed', () => {
    const { ctx, state } = buildTestContext({});
    applySelfBuff(ctx, { spellId: 'bless', modifiers: [{ type: 'dice-bonus', on: 'save', count: 1, sides: 4 }, { type: 'ac-bonus', value: 2 }] });
    expect(state.player.acBonus).toBe(2);
    expect(state.player.saveDiceBonus).toEqual({ count: 1, sides: 4 });
    state.player.activeBuffs = [];
    recomputeBuffs(ctx);
    expect(state.player.acBonus).toBe(0);
    expect(state.player.saveDiceBonus).toBeUndefined();
    expect(state.player.buffSaveAdvantage).toBeUndefined();
  });

  it('keeps the largest die per category (no stacking)', () => {
    const { ctx, state } = buildTestContext({});
    applySelfBuff(ctx, { spellId: 'a', modifiers: [{ type: 'dice-bonus', on: 'attack', count: 1, sides: 4 }] });
    applySelfBuff(ctx, { spellId: 'b', modifiers: [{ type: 'dice-bonus', on: 'attack', count: 1, sides: 6 }] });
    expect(state.player.attackDiceBonus).toEqual({ count: 1, sides: 6 });
  });
});

describe('computeAC + rollDiceBonus', () => {
  it('computeAC adds the flat buff AC bonus', () => {
    const pd = { dex: 14, fightingStyleDefense: false } as unknown as PlayerDef;
    expect(computeAC(pd, null, null, false, false, [], 2)).toBe(10 + mod(14) + 2);
  });

  it('rollDiceBonus rolls the die (and is 0 when absent)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);   // d4 → floor(0.5*4)+1 = 3
    expect(rollDiceBonus({ count: 1, sides: 4 })).toBe(3);
    expect(rollDiceBonus(undefined)).toBe(0);
  });
});

describe('Bane (enemy debuff)', () => {
  const def = { dex: 14, savingThrows: { dex: 2 } } as unknown as MonsterDef;

  it('npcBanePenalty rolls 1d4 for a baned creature, 0 otherwise', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);   // d4 → 3
    const baned = makeNpc({ id: 'e1', activeBuffs: [{ spellId: 'bane' }] } as never);
    const plain = makeNpc({ id: 'e2' });
    expect(npcBanePenalty(baned)).toBe(3);
    expect(npcBanePenalty(plain)).toBe(0);
  });

  it('npcSaveMod subtracts the Bane penalty from the save bonus', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);   // d4 → 3
    const baned = makeNpc({ id: 'e1', activeBuffs: [{ spellId: 'bane' }] } as never);
    expect(npcSaveMod(baned, def, 'dex')).toBe(2 - 3);   // savingThrows.dex 2, minus 1d4(3)
  });
});

describe('Aid (HP-maximum buff)', () => {
  it('reverses the +HP-maximum bonus on a Long Rest and refills to the base max', () => {
    const playerDef = { name: 'C', level: 1, maxHp: 15, className: 'Cleric', defaultSpellSlots: [], defaultFeatureIds: [] } as unknown as PlayerDef;
    const player = {
      hp: 12, hitDiceUsed: 0, spellSlots: [], resources: {}, exhaustionLevel: 0, tempHp: 0, preparedSpellIds: [],
      activeBuffs: [{ spellId: 'aid', modifiers: [{ type: 'max-hp', value: 5 }] }],
    } as unknown as PlayerState;
    const inputs: RestingInputs = { playerDef, player, features: [], spells: [], classDef: null };
    applyLongRest(inputs, {}, buildLongRestPreview(inputs));
    expect(playerDef.maxHp).toBe(10);     // 15 − 5 reversed
    expect(player.hp).toBe(10);           // refilled to the base maximum
    expect(player.activeBuffs).toEqual([]);
  });
});
