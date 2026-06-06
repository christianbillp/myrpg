/**
 * Short-rest spell-slot recovery tests. Recovery is now driven by a feature's
 * `slotRecovery` descriptor (Wizard Arcane Recovery, Druid Natural Recovery)
 * and gated on owning that feature — not a class-name check. These tests lock
 * in the data-driven behaviour: a feature with `slotRecovery` recovers slots
 * greedily lowest-first up to its budget, respects `maxSlotLevel`, fires once
 * per long rest, and does nothing for a character without the feature.
 */
import { describe, it, expect } from 'vitest';
import { doShortRest } from './ExplorationActions.js';
import type { GameContext } from './GameContext.js';
import type { FeatureDef, PlayerDef, GameState } from './types.js';

function arcaneRecovery(): FeatureDef {
  return {
    id: 'arcane-recovery', name: 'Arcane Recovery', classId: 'wizard', minLevel: 1,
    description: '', cost: { kind: 'passive' },
    slotRecovery: { budgetDivisor: 2, maxSlotLevel: 5 },
  } as unknown as FeatureDef;
}

function mkCtx(opts: {
  level: number;
  featureIds: string[];
  features: FeatureDef[];
  maxSlots: number[];
  curSlots: number[];
  arcaneRecoveryUsed?: boolean;
}): { ctx: GameContext; state: GameState } {
  const state = {
    phase: 'exploring',
    player: {
      hp: 5, hitDiceUsed: 0, conditions: [],
      spellSlots: [...opts.curSlots], resources: {},
      arcaneRecoveryUsed: opts.arcaneRecoveryUsed ?? false,
    },
    npcs: [],
  } as unknown as GameState;
  const ctx = {
    state,
    playerDef: {
      name: 'Wren', level: opts.level, con: 12, hitDieType: 6, maxHp: 20,
      defaultFeatureIds: opts.featureIds, defaultSpellSlots: opts.maxSlots,
    } as unknown as PlayerDef,
    defs: { features: opts.features },
    addLog: () => {},
    addLogs: () => {},
  } as unknown as GameContext;
  return { ctx, state };
}

describe('short-rest slot recovery', () => {
  it('recovers slots greedily lowest-first up to ⌈level / budgetDivisor⌉', () => {
    // L6 wizard → budget 3. All L1-L3 slots empty; greedy fills L1, L1... then
    // L2 etc. until budget exhausted. budget 3 → two L1 (cost 2) + nothing more
    // affordable? remaining 1 → one more L1. So three L1 if available.
    const { ctx, state } = mkCtx({
      level: 6, featureIds: ['arcane-recovery'], features: [arcaneRecovery()],
      maxSlots: [4, 3, 3, 0, 0], curSlots: [0, 0, 0, 0, 0],
    });
    doShortRest(ctx);
    // budget 3: L1(1)+L1(1)+L1(1) = 3 → three L1 slots back, nothing else.
    expect(state.player.spellSlots[0]).toBe(3);
    expect(state.player.spellSlots[1]).toBe(0);
    expect(state.player.arcaneRecoveryUsed).toBe(true);
  });

  it('never recovers slots above maxSlotLevel', () => {
    // L20 wizard → budget 10, but only an L6 slot is empty. maxSlotLevel 5
    // means L6 is untouchable → nothing recovered.
    const { ctx, state } = mkCtx({
      level: 20, featureIds: ['arcane-recovery'], features: [arcaneRecovery()],
      maxSlots: [0, 0, 0, 0, 0, 1], curSlots: [0, 0, 0, 0, 0, 0],
    });
    doShortRest(ctx);
    expect(state.player.spellSlots[5]).toBe(0);
    expect(state.player.arcaneRecoveryUsed).toBe(false); // nothing recovered → flag untouched
  });

  it('is a no-op once already used this long rest', () => {
    const { ctx, state } = mkCtx({
      level: 6, featureIds: ['arcane-recovery'], features: [arcaneRecovery()],
      maxSlots: [4, 0, 0, 0, 0], curSlots: [0, 0, 0, 0, 0], arcaneRecoveryUsed: true,
    });
    doShortRest(ctx);
    expect(state.player.spellSlots[0]).toBe(0);
  });

  it('does nothing for a character without a slotRecovery feature', () => {
    const plainFeature = { id: 'second-wind', name: 'Second Wind', classId: 'fighter', minLevel: 1, description: '', cost: { kind: 'bonus-action' } } as unknown as FeatureDef;
    const { ctx, state } = mkCtx({
      level: 6, featureIds: ['second-wind'], features: [plainFeature],
      maxSlots: [4, 0, 0, 0, 0], curSlots: [0, 0, 0, 0, 0],
    });
    doShortRest(ctx);
    expect(state.player.spellSlots[0]).toBe(0);
    expect(state.player.arcaneRecoveryUsed).toBe(false);
  });
});
