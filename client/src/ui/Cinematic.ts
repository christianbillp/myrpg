import { WorldPause } from "../net/WorldPause";
import type { ScreenEffects } from "./ScreenEffects";

/**
 * Cinematic — owns the supertitle / announcement / screen-fade visual
 * choreography. Extracted from GameScene so the scene's event loop only has
 * to dispatch "run this cinematic" calls; the player-control-loss principle
 * (UI fades out FIRST, returns LAST) lives in one place instead of being
 * inlined into the event-handler switch.
 *
 * Each method returns a Promise that resolves when the visual has finished
 * playing — the caller is responsible for resuming its own event loop.
 *
 * The constructor takes a context object instead of the scene itself so the
 * coupling to GameScene is narrow + reviewable. The class touches nothing
 * outside what's in the context.
 */

export interface CinematicContext {
  screenEffects: ScreenEffects;
  /** Fade the Player Panel out / in over the given duration. */
  playerPanelFadeOut: (durationMs: number) => Promise<void>;
  playerPanelFadeIn: (durationMs: number) => Promise<void>;
  /** Fade the Target Panel out / in over the given duration. Called only
   *  when something was selected at announcement-start (`hasTargetSelected`
   *  is true at that moment). */
  targetPanelFadeOut: (durationMs: number) => Promise<void>;
  targetPanelFadeIn: (durationMs: number) => Promise<void>;
  /** Fade the HUD out / in over the given duration. */
  hudFadeOut: (durationMs: number) => Promise<void>;
  hudFadeIn: (durationMs: number) => Promise<void>;
  /** True at announcement-start when an entity is selected — drives whether
   *  the Target Panel fade-out / fade-in pair runs. */
  hasTargetSelected: () => boolean;
  /** Called between announcement-end and target-panel fade-in so the panel
   *  has fresh data to render against — selection state survives behind the
   *  curtain but the DOM was display:none'd, so we re-render before showing
   *  it again. Caller decides what "re-render" means. */
  restoreTargetPanel: () => void;
  /** Called after the panel fades come back in, so HUD-side state (turn
   *  order, action buttons) is sync'd with whatever happened during the
   *  cinematic. */
  refreshHud: () => void;
}

const UI_FADE_MS = 220;

export class Cinematic {
  private focusedAnnouncementActive = false;

  constructor(private readonly ctx: CinematicContext) {}

  /** Play a screen-fade GameEvent — opacity tween only, no UI choreography.
   *  `mode: "out"` → full black, `"dim"` → 50% black, `"in"` → clear. */
  runFade(mode: "in" | "out" | "dim", durationMs: number): Promise<void> {
    return this.ctx.screenEffects.applyFadeMode(mode, durationMs);
  }

  /** Play a supertitle GameEvent — huge centred white serif text held for
   *  `durationMs`. Pauses the off-camera world tick for the duration so
   *  triggers don't advance behind the card. */
  async runSupertitle(text: string, durationMs?: number): Promise<void> {
    WorldPause.acquire('overlay:supertitle');
    try {
      await this.ctx.screenEffects.showSupertitle(text, durationMs);
    } finally {
      WorldPause.release('overlay:supertitle');
    }
  }

  /** Play an unfocused announcement — fire-and-forget, no UI choreography,
   *  no world pause. The caller can ignore the returned promise; it resolves
   *  when the card finishes fading out. */
  runUnfocusedAnnouncement(text: string, durationMs?: number): Promise<void> {
    return this.ctx.screenEffects.showAnnouncement(text, durationMs, 'unfocused');
  }

  /**
   * Play a focused announcement end-to-end. Sequence:
   *   1. lock input + pause world (player control is gone)
   *   2. fade Player Panel + Target Panel + HUD out (UI leaves first)
   *   3. show announcement card and wait for it to finish
   *   4. fade UI panels back in (UI returns last)
   *   5. unlock + unpause
   * This is the general principle for any player-control-loss visual.
   */
  async runFocusedAnnouncement(text: string, durationMs?: number): Promise<void> {
    if (this.focusedAnnouncementActive) {
      // Defensive — should never re-enter while a focused announcement is
      // already running, but if it does, fall back to a non-fading flow.
      await this.ctx.screenEffects.showAnnouncement(text, durationMs, 'focused');
      return;
    }
    this.focusedAnnouncementActive = true;
    WorldPause.acquire('announcement:focused');

    const hadTargetSelected = this.ctx.hasTargetSelected();

    await Promise.all([
      this.ctx.playerPanelFadeOut(UI_FADE_MS),
      hadTargetSelected ? this.ctx.targetPanelFadeOut(UI_FADE_MS) : Promise.resolve(),
      this.ctx.hudFadeOut(UI_FADE_MS),
    ]);

    await this.ctx.screenEffects.showAnnouncement(text, durationMs, 'focused');

    if (hadTargetSelected) this.ctx.restoreTargetPanel();
    await Promise.all([
      this.ctx.playerPanelFadeIn(UI_FADE_MS),
      hadTargetSelected ? this.ctx.targetPanelFadeIn(UI_FADE_MS) : Promise.resolve(),
      this.ctx.hudFadeIn(UI_FADE_MS),
    ]);
    this.ctx.refreshHud();

    this.focusedAnnouncementActive = false;
    WorldPause.release('announcement:focused');
  }

  isFocusedAnnouncementActive(): boolean {
    return this.focusedAnnouncementActive;
  }
}
