/**
 * Multi-tick + propagation tests for the awareness layer.
 *
 * Verifies:
 *   1. pingFactionAlert raises same-faction NPCs to `alert` within radius.
 *   2. registerAwarenessHooks raises NPCs to `suspicious` on noise events
 *      within audible radius (Sound bus `intensity`).
 *   3. The ladder only RAISES; an already-alert NPC isn't demoted by a
 *      lower-priority ping.
 */
import { describe, it, expect } from 'vitest';
import {
  pingFactionAlert,
  registerAwarenessHooks,
  FACTION_ALERT_RADIUS,
} from './Awareness.js';
import { buildTestContext, makeNpc } from '../../test/buildTestContext.js';

describe('pingFactionAlert', () => {
  it('raises same-faction NPCs within radius to alert', () => {
    const { ctx, state } = buildTestContext({
      npcs: [
        makeNpc({ id: 'a', tileX: 5, tileY: 5, factionId: 'bandits' }),
        makeNpc({ id: 'b', tileX: 10, tileY: 10, factionId: 'bandits' }),
        makeNpc({ id: 'c', tileX: 5, tileY: 5, factionId: 'guards' }),
      ],
    });
    pingFactionAlert(ctx, { x: 5, y: 5 }, 'bandits', { tickId: 1, sourceId: 'player' });
    expect(state.npcs.find((n) => n.id === 'a')!.alertness).toBe('alert');
    expect(state.npcs.find((n) => n.id === 'b')!.alertness).toBe('alert');
    expect(state.npcs.find((n) => n.id === 'c')!.alertness).toBeUndefined();
  });

  it('skips NPCs outside the radius', () => {
    const { ctx, state } = buildTestContext({
      npcs: [
        makeNpc({ id: 'far', tileX: 100, tileY: 100, factionId: 'bandits' }),
      ],
    });
    pingFactionAlert(ctx, { x: 0, y: 0 }, 'bandits', { tickId: 1, radius: FACTION_ALERT_RADIUS });
    expect(state.npcs[0]!.alertness).toBeUndefined();
  });

  it('records lastAlertTile in memory', () => {
    const { ctx, state } = buildTestContext({
      npcs: [makeNpc({ id: 'a', tileX: 5, tileY: 5, factionId: 'bandits' })],
    });
    pingFactionAlert(ctx, { x: 7, y: 8 }, 'bandits', { tickId: 42, sourceId: 'player' });
    const mem = state.npcs[0]!.memory;
    expect(mem?.lastAlertTile).toEqual({ x: 7, y: 8 });
    expect(mem?.lastAlertTick).toBe(42);
    expect(mem?.lastAlertSource).toBe('player');
    expect(mem?.lastAlertKind).toBe('faction');
  });

  it('skips dead NPCs', () => {
    const { ctx, state } = buildTestContext({
      npcs: [makeNpc({ id: 'dead', tileX: 5, tileY: 5, factionId: 'bandits', hp: 0 })],
    });
    pingFactionAlert(ctx, { x: 5, y: 5 }, 'bandits', { tickId: 1 });
    expect(state.npcs[0]!.alertness).toBeUndefined();
  });
});

describe('registerAwarenessHooks (noise → suspicious)', () => {
  it('raises NPCs within noise intensity to suspicious', () => {
    const { ctx, state } = buildTestContext({
      npcs: [
        makeNpc({ id: 'near', tileX: 5, tileY: 5 }),
        makeNpc({ id: 'far', tileX: 50, tileY: 50 }),
      ],
    });
    registerAwarenessHooks(ctx);
    ctx.publish({ type: 'noise', x: 0, y: 0, intensity: 8, sourceId: 'player' });
    expect(state.npcs.find((n) => n.id === 'near')!.alertness).toBe('suspicious');
    expect(state.npcs.find((n) => n.id === 'far')!.alertness).toBeUndefined();
  });

  it('does not demote an already-alert NPC', () => {
    const { ctx, state } = buildTestContext({
      npcs: [makeNpc({ id: 'a', tileX: 5, tileY: 5, alertness: 'alert' })],
    });
    registerAwarenessHooks(ctx);
    ctx.publish({ type: 'noise', x: 5, y: 5, intensity: 8, sourceId: 'player' });
    expect(state.npcs[0]!.alertness).toBe('alert');
  });

  it('skips the noise source itself', () => {
    const { ctx, state } = buildTestContext({
      npcs: [makeNpc({ id: 'noise_maker', tileX: 5, tileY: 5 })],
    });
    registerAwarenessHooks(ctx);
    ctx.publish({ type: 'noise', x: 5, y: 5, intensity: 8, sourceId: 'noise_maker' });
    expect(state.npcs[0]!.alertness).toBeUndefined();
  });

  it('ignores zero-intensity noise', () => {
    const { ctx, state } = buildTestContext({
      npcs: [makeNpc({ id: 'a', tileX: 5, tileY: 5 })],
    });
    registerAwarenessHooks(ctx);
    ctx.publish({ type: 'noise', x: 5, y: 5, intensity: 0, sourceId: 'player' });
    expect(state.npcs[0]!.alertness).toBeUndefined();
  });
});

describe('ladder monotonicity', () => {
  it('faction ping over a suspicious NPC raises them to alert', () => {
    const { ctx, state } = buildTestContext({
      npcs: [makeNpc({ id: 'a', tileX: 5, tileY: 5, factionId: 'bandits', alertness: 'suspicious' })],
    });
    pingFactionAlert(ctx, { x: 5, y: 5 }, 'bandits', { tickId: 1 });
    expect(state.npcs[0]!.alertness).toBe('alert');
  });

  it('noise over an alert NPC keeps them at alert', () => {
    const { ctx, state } = buildTestContext({
      npcs: [makeNpc({ id: 'a', tileX: 5, tileY: 5, alertness: 'alert' })],
    });
    registerAwarenessHooks(ctx);
    ctx.publish({ type: 'noise', x: 5, y: 5, intensity: 8, sourceId: 'player' });
    expect(state.npcs[0]!.alertness).toBe('alert');
  });
});
