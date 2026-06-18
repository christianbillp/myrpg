/**
 * Reduced-motion gate (Animation Roadmap · M4/M6). The in-game override wins over
 * the OS setting; 'system' follows the media query. Camera shake / dodge consult
 * this so motion-sensitive players can suppress impact motion.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getReducedMotionPref, setReducedMotionPref, prefersReducedMotion } from './reducedMotion';

function stub(systemReduce: boolean): Record<string, string> {
  const store: Record<string, string> = {};
  vi.stubGlobal('window', {
    localStorage: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } },
    matchMedia: (q: string) => ({ matches: systemReduce && q.includes('reduce') }),
  });
  return store;
}

describe('reduced motion', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('defaults to system and round-trips an override', () => {
    stub(false);
    expect(getReducedMotionPref()).toBe('system');
    setReducedMotionPref('on');
    expect(getReducedMotionPref()).toBe('on');
  });

  it("'on' forces reduced motion, 'off' forces full motion regardless of OS", () => {
    stub(true); // OS asks for reduced motion
    setReducedMotionPref('off');
    expect(prefersReducedMotion()).toBe(false);
    setReducedMotionPref('on');
    expect(prefersReducedMotion()).toBe(true);
  });

  it("'system' follows the OS media query", () => {
    stub(true);
    setReducedMotionPref('system');
    expect(prefersReducedMotion()).toBe(true);
    stub(false);
    expect(prefersReducedMotion()).toBe(false);
  });

  it('falls back to full motion with no window (privacy / tests)', () => {
    vi.stubGlobal('window', undefined);
    expect(prefersReducedMotion()).toBe(false);
    expect(() => setReducedMotionPref('on')).not.toThrow();
  });
});
