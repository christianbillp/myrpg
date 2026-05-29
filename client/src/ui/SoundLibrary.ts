/**
 * SoundLibrary — central lookup from logical sound id (`play_sound` event)
 * to the asset filename served by the server. Lazily preloads each Audio
 * element on first use so back-to-back hits play without re-fetching.
 *
 * Drop new sound files at `server/data/sounds/<filename>` and add a
 * mapping below. The server route accepts `.mp3`, `.ogg`, and `.wav`.
 */

const SOUND_BASE_URL = 'http://localhost:3000';

/** Logical id → filename under `server/data/sounds/`. */
const SOUND_FILES: Record<string, string> = {
  physical_hit:  '843248__qubodup__explosion-2-burning-car-rec-by-nado.wav',
  physical_miss: '855844__sadiquecat__whoosh-long-bamboo-stick-os-st-13.wav',
};

/** Per-id playback volume (0.0–1.0). Defaults to 0.8 when absent. */
const SOUND_VOLUME: Record<string, number> = {
  physical_hit:  0.7,
  physical_miss: 0.6,
};

/** Reused HTMLAudioElement per sound id so we don't re-fetch on each play. */
const cache = new Map<string, HTMLAudioElement>();

/**
 * Play the sound matching the given logical id. Silent no-op when the id
 * isn't mapped, the file is missing (404), or autoplay is blocked.
 */
export function playSound(id: string): void {
  const filename = SOUND_FILES[id];
  if (!filename) return;
  let el = cache.get(id);
  if (!el) {
    try {
      el = new Audio(`${SOUND_BASE_URL}/sounds/${filename}`);
      el.preload = 'auto';
      el.volume = SOUND_VOLUME[id] ?? 0.8;
      cache.set(id, el);
    } catch {
      return;
    }
  }
  try {
    el.currentTime = 0;
    void el.play().catch(() => { /* autoplay blocked / file missing — visual still plays */ });
  } catch {
    // Defensive — `currentTime` setter can throw in pathological cases.
  }
}
