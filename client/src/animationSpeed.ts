/**
 * Combat Speed — the global animation-speed multiplier
 * (docs/design/systems/animation-timeline.md). Scales every combat-timeline duration:
 * move tweens, beat dwells (speech reading pauses, turn-boundary breaths,
 * condition labels). Cinematic story beats (fades, supertitles, focused
 * announcements) keep their authored durations — speeding those up cheapens
 * narrative moments, not combat.
 *
 * Persisted in localStorage so the choice survives sessions; read lazily on
 * every scale call so the PanelSetupOverlay card takes effect immediately.
 */
const STORAGE_KEY = 'combatSpeed';

/** The selectable multipliers, in display order. */
export const COMBAT_SPEEDS = [1, 1.5, 2, 3] as const;

/** Floor for any scaled duration — below this, tweens read as teleports. */
const MIN_DURATION_MS = 40;

export function getCombatSpeed(): number {
  try {
    const raw = Number(window.localStorage.getItem(STORAGE_KEY));
    return (COMBAT_SPEEDS as readonly number[]).includes(raw) ? raw : 1;
  } catch {
    return 1; // no storage (tests / privacy mode) — normal speed
  }
}

export function setCombatSpeed(speed: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(speed));
  } catch {
    /* no storage — setting just doesn't persist */
  }
}

/** Scale a combat-beat duration by the current speed (higher = faster). */
export function scaleDuration(ms: number): number {
  return Math.max(MIN_DURATION_MS, Math.round(ms / getCombatSpeed()));
}
