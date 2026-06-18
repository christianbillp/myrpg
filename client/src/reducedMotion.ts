/**
 * Reduced-motion gate (Animation Roadmap · M4/M6). Animations consult this to
 * suppress non-essential motion (camera shake, big tweens) while keeping game
 * state correct. Honours the OS `prefers-reduced-motion` setting plus an in-game
 * override toggle (persisted), so players can opt in/out regardless of OS.
 */
const STORAGE_KEY = 'reducedMotion';

/** The in-game override: 'on' forces reduced motion, 'off' forces full motion,
 *  'system' (default) follows the OS setting. */
export type ReducedMotionPref = 'system' | 'on' | 'off';

export function getReducedMotionPref(): ReducedMotionPref {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === 'on' || raw === 'off' ? raw : 'system';
  } catch {
    return 'system';
  }
}

export function setReducedMotionPref(pref: ReducedMotionPref): void {
  try { window.localStorage.setItem(STORAGE_KEY, pref); } catch { /* no storage */ }
}

function systemPrefersReducedMotion(): boolean {
  try { return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false; }
  catch { return false; }
}

/** True when non-essential motion should be suppressed. */
export function prefersReducedMotion(): boolean {
  const pref = getReducedMotionPref();
  if (pref === 'on') return true;
  if (pref === 'off') return false;
  return systemPrefersReducedMotion();
}
