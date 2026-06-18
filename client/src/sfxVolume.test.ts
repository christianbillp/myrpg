/**
 * Global SFX volume + mute (Animation Roadmap · M6). One control scales every
 * combat cue; mute silences them outright.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getSfxVolume, setSfxVolume, isSfxMuted, setSfxMuted, effectiveSfxVolume } from './sfxVolume';

function stub(): void {
  const store: Record<string, string> = {};
  vi.stubGlobal('window', { localStorage: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } } });
}

describe('sfx volume', () => {
  beforeEach(() => { vi.unstubAllGlobals(); stub(); });

  it('defaults to full volume, unmuted, and round-trips both', () => {
    expect(getSfxVolume()).toBe(1);
    expect(isSfxMuted()).toBe(false);
    setSfxVolume(0.4);
    setSfxMuted(true);
    expect(getSfxVolume()).toBeCloseTo(0.4);
    expect(isSfxMuted()).toBe(true);
  });

  it('scales a cue by the global level and clamps to [0,1]', () => {
    setSfxVolume(0.5);
    expect(effectiveSfxVolume(0.8)).toBeCloseTo(0.4);
    setSfxVolume(5); // clamped on the way in
    expect(getSfxVolume()).toBe(1);
  });

  it('mute silences every cue', () => {
    setSfxVolume(1);
    setSfxMuted(true);
    expect(effectiveSfxVolume(0.9)).toBe(0);
  });

  it('falls back to full volume with no storage', () => {
    vi.stubGlobal('window', undefined);
    expect(getSfxVolume()).toBe(1);
    expect(effectiveSfxVolume(0.7)).toBeCloseTo(0.7);
  });
});
