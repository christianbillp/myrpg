/**
 * Animation beat timings — the single source of truth for every combat-beat
 * duration (Animation Roadmap · M2). Previously these were magic numbers spread
 * across `entities/`, `ui/SpellVfx.ts`, and `GameScene`, and most ignored Combat
 * Speed; now they live here and combat beats are scaled at the call site via
 * `scaleDuration`. Cinematic timings (fades, supertitles) stay authored and are
 * NOT listed here.
 *
 * All values are the authored 1× durations in milliseconds. Wrap a combat beat
 * in `scaleDuration(TIMING.x)` at the use site so it honours Combat Speed.
 */
export { scaleDuration } from './animationSpeed';

export const TIMING = {
  // ── Movement ──
  movePlayerMs: 150,
  moveNpcMs: 130,
  glidePerTileMs: 90,
  glideMaxMs: 420,
  // ── Melee / impact ──
  lungeMs: 90,
  flashMs: 90,
  deathFadeMs: 280,
  floatNumberMs: 650,
  // ── Beat dwells ──
  turnBeatPauseMs: 280,
  conditionBeatMs: 260,
  healDwellMs: 180,
  // ── Spell VFX ──
  projectileMs: 200,
  projectileDartDelayMs: 70,
  sparkleMs: 160,
  beamMs: 200,
  burstTouchMs: 170,
  burstTargetMs: 190,
  burstAreaMs: 300,
  burstZoneMs: 320,
  glowSummonMs: 300,
  glowTargetMs: 220,
  glowSelfMs: 220,
  glowVanishMs: 240,
  glowAmbientMs: 130,
} as const;
