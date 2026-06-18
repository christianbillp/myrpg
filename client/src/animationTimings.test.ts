/**
 * Central beat timings (Animation Roadmap · M2). Every combat-beat duration lives
 * in one module and scales with Combat Speed — so VFX, flashes, and numbers no
 * longer desync from movement at 2×/3×.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TIMING, scaleDuration } from './animationTimings';
import { setCombatSpeed } from './animationSpeed';

function stubStorage(): void {
  const store: Record<string, string> = {};
  vi.stubGlobal('window', { localStorage: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } } });
}

describe('animation timings', () => {
  beforeEach(() => { vi.unstubAllGlobals(); stubStorage(); });

  it('exposes every beat duration as a positive number', () => {
    for (const [k, v] of Object.entries(TIMING)) {
      expect(typeof v, k).toBe('number');
      expect(v, k).toBeGreaterThan(0);
    }
  });

  it('re-exports scaleDuration so a VFX duration scales with Combat Speed', () => {
    setCombatSpeed(1);
    expect(scaleDuration(TIMING.floatNumberMs)).toBe(TIMING.floatNumberMs);
    setCombatSpeed(2);
    expect(scaleDuration(TIMING.floatNumberMs)).toBe(Math.round(TIMING.floatNumberMs / 2));
    // The projectile (formerly fixed at 200ms, unscaled) now halves at 2×.
    expect(scaleDuration(TIMING.projectileMs)).toBe(Math.round(TIMING.projectileMs / 2));
  });
});
