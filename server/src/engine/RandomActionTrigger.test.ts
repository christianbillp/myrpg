/**
 * Encounter engagement #39 — mid-fight complications (Director twist).
 *
 * `random_action` picks ONE of its `choices` action-sets at random and runs it,
 * so the same encounter throws a different wrench each playthrough. Each choice
 * is a list of actions, run in order through the canonical `fireAction` path.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireAction } from './TriggerSystem.js';
import { buildTestContext } from '../test/buildTestContext.js';

afterEach(() => vi.restoreAllMocks());

describe('random_action trigger (#39)', () => {
  it('runs exactly the chosen branch and all of its actions, in order', () => {
    const { ctx, state } = buildTestContext({});
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // 0.5 * 3 = 1.5 → index 1

    fireAction(ctx, {
      type: 'random_action',
      choices: [
        [{ type: 'set_flag', name: 'twist_a', value: true }],
        [
          { type: 'set_flag', name: 'twist_b', value: true },
          { type: 'set_flag', name: 'twist_b_step2', value: 1 },
        ],
        [{ type: 'set_flag', name: 'twist_c', value: true }],
      ],
    });

    expect(state.worldFlags['twist_a']).toBeUndefined();
    expect(state.worldFlags['twist_c']).toBeUndefined();
    expect(state.worldFlags['twist_b']).toBe(true);
    expect(state.worldFlags['twist_b_step2']).toBe(1);
  });

  it('selects the first branch at the low end of the random range', () => {
    const { ctx, state } = buildTestContext({});
    vi.spyOn(Math, 'random').mockReturnValue(0); // index 0

    fireAction(ctx, {
      type: 'random_action',
      choices: [
        [{ type: 'set_flag', name: 'first', value: true }],
        [{ type: 'set_flag', name: 'second', value: true }],
      ],
    });

    expect(state.worldFlags['first']).toBe(true);
    expect(state.worldFlags['second']).toBeUndefined();
  });

  it('no-ops on an empty choices list', () => {
    const { ctx, state } = buildTestContext({});
    fireAction(ctx, { type: 'random_action', choices: [] });
    expect(Object.keys(state.worldFlags).length).toBe(0);
  });
});
