/**
 * Global sound-effect volume + mute (Animation Roadmap · M6). The SoundLibrary
 * multiplies each cue's authored per-id volume by this global level so players
 * have one control for all combat SFX. Persisted in localStorage; read lazily so
 * a settings card takes effect immediately.
 */
const VOLUME_KEY = 'sfxVolume';
const MUTE_KEY = 'sfxMuted';

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

export function getSfxVolume(): number {
  try {
    const raw = window.localStorage.getItem(VOLUME_KEY);
    if (raw === null) return 1;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 1;
  } catch {
    return 1;
  }
}

export function setSfxVolume(v: number): void {
  try { window.localStorage.setItem(VOLUME_KEY, String(clamp01(v))); } catch { /* no storage */ }
}

export function isSfxMuted(): boolean {
  try { return window.localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; }
}

export function setSfxMuted(muted: boolean): void {
  try { window.localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch { /* no storage */ }
}

/** The playback level for a cue with authored volume `base`, after the global
 *  level + mute. Returns 0 when muted. */
export function effectiveSfxVolume(base: number): number {
  if (isSfxMuted()) return 0;
  return clamp01(base * getSfxVolume());
}
