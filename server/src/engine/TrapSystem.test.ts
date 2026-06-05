/**
 * TrapSystem unit tests — trap triggering, disarming, passive/active detection,
 * and deploying area-denial gear as a zone. Uses a lightweight GameContext stub
 * so we exercise the pure trap logic without standing up a full engine.
 *
 * Determinism: saves are forced by DC. A `saveDC` of 100 always fails; a
 * `disarmDC` of 0 always succeeds. Damage uses `damageSides: 1` so each die
 * rolls exactly 1.
 */
import { describe, it, expect } from 'vitest';
import type { GameContext } from './GameContext.js';
import type { GameState, TrapState, ItemDef } from './types.js';
import {
  springTrapOnPlayer, doDisarmTrap, doDeployGear,
  detectAdjacentTraps, runPassiveTrapDetection,
} from './TrapSystem.js';

function makeTrap(over: Partial<TrapState> = {}): TrapState {
  return {
    id: 'trap_1', name: 'Test Trap', tileX: 3, tileY: 3,
    armed: true, discovered: true, detectDC: 12, disarmDC: 15,
    trigger: {
      saveAbility: 'dex', saveDC: 100, damageDice: 2, damageSides: 1,
      damageBonus: 0, damageType: 'piercing', halfOnSave: true, condition: 'restrained',
    },
    ...over,
  };
}

function makeCtx(opts: { traps?: TrapState[]; equipment?: ItemDef[]; inventory?: string[] } = {}): {
  ctx: GameContext; state: GameState; logs: string[];
} {
  const logs: string[] = [];
  const state = {
    phase: 'exploring',
    player: {
      tileX: 3, tileY: 3, hp: 20, conditions: [] as string[],
      inventoryIds: opts.inventory ?? [], movesLeft: 6, actionUsed: false,
    },
    npcs: [],
    map: {
      cols: 10, rows: 10,
      blocksMovement: Array.from({ length: 10 }, () => new Array(10).fill(false)),
    },
    traps: opts.traps ?? [],
    activeZones: [],
  } as unknown as GameState;

  let uidN = 0;
  const ctx = {
    state,
    playerDef: {
      name: 'Wren', dex: 16, str: 8, con: 14, int: 13, wis: 12, cha: 13,
      proficiencyBonus: 2, savingThrowProficiencies: ['dex', 'int'],
      skills: { sleightOfHand: 7, perception: 3 },
    },
    defs: { equipment: opts.equipment ?? [] },
    addLog: (e: unknown) => { logs.push(typeof e === 'string' ? e : (e as { left: string }).left); },
    addLogs: (es: unknown[]) => { for (const e of es) logs.push(typeof e === 'string' ? e : (e as { left: string }).left); },
    uid: () => `id_${uidN++}`,
    publish: () => {},
    applyDamageToPlayer: (amount: number) => { state.player.hp = Math.max(0, state.player.hp - amount); },
  } as unknown as GameContext;

  return { ctx, state, logs };
}

describe('springTrapOnPlayer', () => {
  it('deals full damage and applies the condition on a failed save, and spends the trap', () => {
    const trap = makeTrap();
    const { ctx, state } = makeCtx({ traps: [trap] });
    springTrapOnPlayer(ctx, trap, []);
    expect(state.player.hp).toBe(18); // 2 sides-1 dice = 2 damage, full (save auto-fails)
    expect(state.player.conditions).toContain('restrained');
    expect(trap.armed).toBe(false);
    expect(trap.discovered).toBe(true);
  });

  it('deals half damage and no condition on a successful save (DC 0)', () => {
    const trap = makeTrap({ trigger: { saveAbility: 'dex', saveDC: 0, damageDice: 4, damageSides: 1, damageBonus: 0, damageType: 'piercing', halfOnSave: true, condition: 'restrained' } });
    const { ctx, state } = makeCtx({ traps: [trap] });
    springTrapOnPlayer(ctx, trap, []);
    expect(state.player.hp).toBe(18); // 4 damage halved = 2
    expect(state.player.conditions).not.toContain('restrained');
  });
});

describe('detection', () => {
  it('passive detection reveals a concealed trap within range when PP ≥ detectDC', () => {
    const trap = makeTrap({ discovered: false, detectDC: 12, tileX: 4, tileY: 3 });
    const { ctx } = makeCtx({ traps: [trap] }); // passive PP = 10 + 3 = 13 ≥ 12
    runPassiveTrapDetection(ctx);
    expect(trap.discovered).toBe(true);
  });

  it('passive detection does NOT reveal a trap whose detectDC exceeds passive PP', () => {
    const trap = makeTrap({ discovered: false, detectDC: 20, tileX: 4, tileY: 3 });
    const { ctx } = makeCtx({ traps: [trap] });
    runPassiveTrapDetection(ctx);
    expect(trap.discovered).toBe(false);
  });

  it('active Search reveals an adjacent concealed trap when the roll beats detectDC', () => {
    const trap = makeTrap({ discovered: false, detectDC: 15, tileX: 4, tileY: 3 });
    const { ctx } = makeCtx({ traps: [trap] });
    const logs = detectAdjacentTraps(ctx, 18);
    expect(trap.discovered).toBe(true);
    expect(logs.length).toBe(1);
  });
});

describe('doDisarmTrap', () => {
  it('disarms a discovered armed adjacent trap on success (DC 0)', () => {
    const trap = makeTrap({ disarmDC: 0, tileX: 4, tileY: 3 });
    const { ctx } = makeCtx({ traps: [trap] });
    doDisarmTrap(ctx, 4, 3, []);
    expect(trap.armed).toBe(false);
  });

  it('springs the trap on a botch (impossible DC)', () => {
    const trap = makeTrap({ disarmDC: 100, tileX: 4, tileY: 3 });
    const { ctx, state } = makeCtx({ traps: [trap] });
    doDisarmTrap(ctx, 4, 3, []);
    expect(trap.armed).toBe(false); // sprung
    expect(state.player.hp).toBeLessThan(20);
  });

  it('ignores a trap that is out of reach', () => {
    const trap = makeTrap({ disarmDC: 0, tileX: 8, tileY: 8 });
    const { ctx } = makeCtx({ traps: [trap] });
    doDisarmTrap(ctx, 8, 8, []);
    expect(trap.armed).toBe(true);
  });
});

describe('doDeployGear', () => {
  const caltrops: ItemDef = {
    id: 'caltrops', name: 'Caltrops', type: 'gear',
    areaDenial: {
      zoneName: 'Caltrops', sizeFeet: 5, rangeFeet: 5,
      enterSave: { ability: 'dex', dc: 15 }, condition: 'hobbled',
      enterDamage: { amount: 1, type: 'piercing' }, durationRounds: 100,
    },
  } as ItemDef;

  it('creates an ActiveZone, consumes the item, and covers the target tile', () => {
    const { ctx, state } = makeCtx({ equipment: [caltrops], inventory: ['caltrops'] });
    doDeployGear(ctx, 'caltrops', 4, 3, []);
    expect(state.activeZones.length).toBe(1);
    const z = state.activeZones[0];
    expect(z.name).toBe('Caltrops');
    expect(z.enterSave).toEqual({ ability: 'dex', dc: 15 });
    expect(z.tiles.some(([x, y]) => x === 4 && y === 3)).toBe(true);
    expect(state.player.inventoryIds).not.toContain('caltrops');
  });

  it('does nothing when the target is out of range', () => {
    const { ctx, state } = makeCtx({ equipment: [caltrops], inventory: ['caltrops'] });
    doDeployGear(ctx, 'caltrops', 9, 9, []);
    expect(state.activeZones.length).toBe(0);
    expect(state.player.inventoryIds).toContain('caltrops');
  });
});
