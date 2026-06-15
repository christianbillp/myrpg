/**
 * Encounter engagement #31 — objective primitives.
 *
 * Win/lose conditions beyond "kill everything" are authored from the trigger
 * system. The two new primitives this needs:
 *   • the `combat_round` event (1-based), published at the top of each round —
 *     for "survive N rounds", timed waves, defeat timers.
 *   • the `fail_encounter` action — objective-driven DEFEAT (escort died, timer
 *     ran out), distinct from the player simply dying.
 * (Non-kill victory already works via `completeOnFlagOnly` + a flag-setting
 * trigger; reach/seize/destroy/defeat-target need no new code.)
 */
import { describe, it, expect } from 'vitest';
import { advanceTurn } from './CombatFlow.js';
import { registerTriggers, fireAction } from './TriggerSystem.js';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import type { EngineEvent } from './types.js';

describe('combat round counter + event (#31)', () => {
  it('advanceTurn publishes combat_round and bumps state.combatRound at the top of the order', () => {
    const { ctx, state } = buildTestContext({
      phase: 'enemy_turn',
      npcs: [makeNpc({ id: 'e1', defId: 'goblin', tileX: 9, tileY: 9, disposition: 'enemy', hp: 7, maxHp: 7 })],
    });
    state.turnOrderIds = ['player', 'e1'];
    state.activeNpcIndex = 1;   // last slot just acted; next wraps to index 0 (the player)
    state.combatRound = 0;
    const rounds: number[] = [];
    ctx.bus.subscribeAll((e: EngineEvent) => { if (e.type === 'combat_round') rounds.push(e.round); });

    advanceTurn(ctx, []);       // wraps to the top → new round, then enters the player's turn

    expect(state.combatRound).toBe(1);
    expect(rounds).toEqual([1]);
    expect(state.phase).toBe('player_turn');
  });

  it('regression: starting combat (phase still exploring) enters a turn, not bails', () => {
    // doStartCombat leaves phase 'exploring' until the first turn is entered, and
    // calls advanceTurn with activeNpcIndex -1. The round-counter guard must NOT
    // treat that initial 'exploring' as "a trigger ended the fight".
    const { ctx, state } = buildTestContext({
      phase: 'exploring',
      npcs: [makeNpc({ id: 'e1', defId: 'goblin', tileX: 9, tileY: 9, disposition: 'enemy', hp: 7, maxHp: 7 })],
    });
    state.turnOrderIds = ['player', 'e1'];
    state.activeNpcIndex = -1;   // as doStartCombat leaves it
    state.combatRound = 0;

    advanceTurn(ctx, []);

    expect(state.combatRound).toBe(1);
    expect(state.phase).toBe('player_turn');  // combat actually started
  });
});

describe('combat_round trigger matching (#31)', () => {
  it('an `atLeast` round trigger fires from that round on; `round` matches exactly', () => {
    const { ctx, state } = buildTestContext({});
    state.triggers = [
      { id: 'survive', when: { event: 'combat_round', atLeast: 3 }, then: [{ type: 'set_flag', name: 'survived', value: true }], once: true },
      { id: 'wave2', when: { event: 'combat_round', round: 2 }, then: [{ type: 'set_flag', name: 'wave2', value: true }] },
    ] as unknown as typeof state.triggers;
    registerTriggers(ctx);

    ctx.publish({ type: 'combat_round', round: 1 });
    expect(state.worldFlags['survived']).toBeUndefined();
    expect(state.worldFlags['wave2']).toBeUndefined();

    ctx.publish({ type: 'combat_round', round: 2 });
    expect(state.worldFlags['wave2']).toBe(true);     // exact match
    expect(state.worldFlags['survived']).toBeUndefined();

    ctx.publish({ type: 'combat_round', round: 3 });
    expect(state.worldFlags['survived']).toBe(true);  // atLeast 3
  });
});

describe('fail_encounter action (#31)', () => {
  it('ends the encounter in defeat with the reason', () => {
    const { ctx, state, logs } = buildTestContext({ phase: 'player_turn' });
    fireAction(ctx, { type: 'fail_encounter', reason: 'The prisoner is dead.' });
    expect(state.phase).toBe('defeat');
    expect(logs.some((l) => l.left.includes('prisoner is dead'))).toBe(true);
  });

  it('is idempotent once already defeated', () => {
    const { ctx, state } = buildTestContext({ phase: 'player_turn' });
    state.encounterComplete = true;
    fireAction(ctx, { type: 'fail_encounter' });
    expect(state.phase).not.toBe('defeat');  // already resolved → no-op
  });
});
