/**
 * Combat Speed multiplier (docs/design/systems/animation-timeline.md): persisted choice,
 * scaled durations with a readability floor, and graceful no-storage fallback.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { COMBAT_SPEEDS, getCombatSpeed, setCombatSpeed, scaleDuration } from './animationSpeed';

function stubStorage(): Record<string, string> {
  const store: Record<string, string> = {};
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
    },
  });
  return store;
}

describe('combat speed', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it('defaults to 1× and round-trips a chosen speed', () => {
    stubStorage();
    expect(getCombatSpeed()).toBe(1);
    setCombatSpeed(2);
    expect(getCombatSpeed()).toBe(2);
  });

  it('rejects values outside the selectable set', () => {
    const store = stubStorage();
    store['combatSpeed'] = '17';
    expect(getCombatSpeed()).toBe(1);
  });

  it('scales durations down with the multiplier, clamped at the readability floor', () => {
    stubStorage();
    setCombatSpeed(2);
    expect(scaleDuration(280)).toBe(140);
    expect(scaleDuration(60)).toBe(40); // floor — never reads as a teleport
    setCombatSpeed(1);
    expect(scaleDuration(280)).toBe(280);
  });

  it('falls back to 1× with no window/localStorage (privacy contexts)', () => {
    vi.stubGlobal('window', undefined);
    expect(getCombatSpeed()).toBe(1);
    expect(() => setCombatSpeed(3)).not.toThrow();
    expect(scaleDuration(300)).toBe(300);
  });

  it('exposes the selectable speeds for the settings card', () => {
    expect(COMBAT_SPEEDS).toEqual([1, 1.5, 2, 3]);
  });
});
