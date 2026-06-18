/**
 * SoundLibrary — central lookup from logical sound id (`play_sound` event)
 * to the asset filename served by the server. Lazily preloads each Audio
 * element on first use so back-to-back hits play without re-fetching.
 *
 * Drop new sound files at `server/data/sounds/<filename>` and add a
 * mapping below. The server route accepts `.mp3`, `.ogg`, and `.wav`.
 */
import { effectiveSfxVolume } from '../sfxVolume';

const SOUND_BASE_URL = 'http://localhost:3000';

/** Logical id → filename under `server/data/sounds/`. */
const SOUND_FILES: Record<string, string> = {
  physical_hit:  '843248__qubodup__explosion-2-burning-car-rec-by-nado.wav',
  physical_miss: '855844__sadiquecat__whoosh-long-bamboo-stick-os-st-13.wav',
  spell_cast:    '268556__cydon__explosion_002.mp3',
};

/** Per-id playback volume (0.0–1.0). Defaults to 0.8 when absent. */
const SOUND_VOLUME: Record<string, number> = {
  physical_hit:  0.7,
  physical_miss: 0.6,
  spell_cast:    0.5,
};

/** Reused HTMLAudioElement per sound id so we don't re-fetch on each play. */
const cache = new Map<string, HTMLAudioElement>();

/**
 * Warm the audio cache (Animation Roadmap · M7) — fetch every mapped sound once,
 * on encounter enter, so the first hit/cast plays in sync with its visual instead
 * of lagging behind a cold fetch. Safe to call repeatedly; already-cached ids are
 * skipped. Never throws (missing file / no Audio support is a silent no-op).
 */
export function preloadSounds(): void {
  for (const [id, filename] of Object.entries(SOUND_FILES)) {
    if (cache.has(id)) continue;
    try {
      const el = new Audio(`${SOUND_BASE_URL}/sounds/${filename}`);
      el.preload = 'auto';
      cache.set(id, el);
    } catch {
      /* no Audio support (tests / headless) — playSound stays a no-op */
    }
  }
}

/**
 * Play the sound matching the given logical id. Silent no-op when the id
 * isn't mapped, the file is missing (404), or autoplay is blocked.
 */
export function playSound(id: string): void {
  const filename = SOUND_FILES[id];
  if (!filename) return;
  // Global SFX volume + mute (M6) — applied per play so settings changes take
  // effect immediately. A muted / zero level skips playback entirely.
  const vol = effectiveSfxVolume(SOUND_VOLUME[id] ?? 0.8);
  if (vol <= 0) return;
  let el = cache.get(id);
  if (!el) {
    try {
      el = new Audio(`${SOUND_BASE_URL}/sounds/${filename}`);
      el.preload = 'auto';
      cache.set(id, el);
    } catch {
      return;
    }
  }
  el.volume = vol;
  try {
    el.currentTime = 0;
    void el.play().catch(() => { /* autoplay blocked / file missing — visual still plays */ });
  } catch {
    // Defensive — `currentTime` setter can throw in pathological cases.
  }
}
