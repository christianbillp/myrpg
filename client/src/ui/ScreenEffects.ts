/**
 * ScreenEffects — full-screen, document-z-index UI layer covering the canvas
 * AND every other UI panel. Owns three independent visual elements:
 *
 *   - Fade overlay: a black div whose opacity is tweened between 0 and 1 to
 *     fade the game in / out. Supports a third mode `dim` that holds the
 *     overlay at 50% black so the world is still visible underneath. Used by
 *     long rest, chapter advance, and the AIGM / trigger `fade_screen` action.
 *   - Supertitle:   movie-style location title — huge bold white text filling
 *     ~95vw, centred, wrapping onto two lines for longer titles. Auto-fades.
 *   - Announcement: large centred translucent-card text. Auto-fades.
 *
 * Every method returns a Promise that resolves when the visible animation is
 * done, so callers can `await` a sequence (fade-out → supertitle → fade-in).
 * The fade overlay is *sticky*: a `fadeOut` leaves the screen black until a
 * matching `fadeIn` (or `clearFade`) is issued.
 *
 * z-index strategy — pushed well above every gui-panel + gui-overlay z-index
 * (those top out around 100) so the fade unambiguously covers the Player
 * Panel, HUD, Target Panel, Event Log, and any open modal:
 *   9000 — fade backdrop
 *   9001 — supertitle / announcement (read against the fade backdrop)
 */

const FADE_Z = 9000;
const TEXT_Z = 9001;

const SUPERTITLE_FADE_MS = 600;
const SUPERTITLE_DEFAULT_HOLD_MS = 3000;
const ANNOUNCEMENT_FADE_MS = 500;
const ANNOUNCEMENT_DEFAULT_HOLD_MS = 3500;

/** Mapping from public `fade_screen` mode to overlay opacity target. */
const FADE_TARGET_OPACITY: Record<'in' | 'out' | 'dim', number> = {
  in: 0,
  out: 1,
  dim: 0.5,
};
export type FadeMode = keyof typeof FADE_TARGET_OPACITY;

export class ScreenEffects {
  private readonly fadeEl: HTMLDivElement;
  private fadeOpacity = 0;

  constructor() {
    this.fadeEl = document.createElement('div');
    this.fadeEl.style.cssText = `
      position: fixed; inset: 0;
      background: #000;
      opacity: 0;
      pointer-events: none;
      z-index: ${FADE_Z};
      transition: opacity 0ms linear;
    `;
    document.body.appendChild(this.fadeEl);
  }

  /** Fade the screen to fully black over `durationMs`. */
  fadeOut(durationMs: number): Promise<void> {
    return this.tweenFade(FADE_TARGET_OPACITY.out, Math.max(0, durationMs));
  }

  /** Fade from black back to the game over `durationMs`. */
  fadeIn(durationMs: number): Promise<void> {
    return this.tweenFade(FADE_TARGET_OPACITY.in, Math.max(0, durationMs));
  }

  /** Fade to (or from) a 50% black overlay over `durationMs`. The world remains
   *  visible underneath but darkened — useful for atmospheric beats. */
  fadeDim(durationMs: number): Promise<void> {
    return this.tweenFade(FADE_TARGET_OPACITY.dim, Math.max(0, durationMs));
  }

  /** Run a `fade_screen` GameEvent. Public mode -> opacity is centralized so
   *  the server-side action mirrors the same vocabulary. */
  applyFadeMode(mode: FadeMode, durationMs: number): Promise<void> {
    return this.tweenFade(FADE_TARGET_OPACITY[mode], Math.max(0, durationMs));
  }

  /** Reset the fade to 0 immediately — emergency clear (scene shutdown, etc). */
  clearFade(): void {
    this.fadeOpacity = 0;
    this.fadeEl.style.transition = 'opacity 0ms linear';
    this.fadeEl.style.opacity = '0';
    this.fadeEl.style.pointerEvents = 'none';
  }

  /**
   * Movie-style supertitle: huge bold centred white text. Total elapsed time
   * is `fadeIn + holdMs + fadeOut`. Resolves once the element is removed.
   */
  showSupertitle(text: string, holdMs = SUPERTITLE_DEFAULT_HOLD_MS): Promise<void> {
    const el = document.createElement('div');
    el.style.cssText = `
      position: fixed;
      left: 50%; top: 50%;
      transform: translate(-50%, -50%);
      width: 95vw;
      max-height: 90vh;
      text-align: center;
      font-family: 'Georgia', 'Times New Roman', serif;
      font-weight: 700;
      font-size: clamp(72px, 18vw, 280px);
      line-height: 1.05;
      color: #ffffff;
      letter-spacing: 0.05em;
      text-shadow: 0 4px 24px rgba(0, 0, 0, 0.85);
      word-wrap: break-word;
      overflow-wrap: break-word;
      opacity: 0;
      pointer-events: none;
      z-index: ${TEXT_Z};
      transition: opacity ${SUPERTITLE_FADE_MS}ms ease-out;
    `;
    el.textContent = text;
    document.body.appendChild(el);
    return this.fadeTextElement(el, holdMs, SUPERTITLE_FADE_MS);
  }

  /**
   * Centre-screen announcement. Two style variants:
   *   - `focused`   — orange-bordered card. Pairs with input/UI locking on
   *                   the GameScene side (Player Panel, Target Panel, HUD all
   *                   hidden; world tick paused; movement / actions locked).
   *   - `unfocused` — borderless card with a soft radial edge-fade so the
   *                   text reads against the world without a hard frame.
   *                   The scene leaves the UI alone and the world keeps
   *                   running.
   * The server is expected to also write the same text to the event log so
   * the message persists after the visual fades.
   */
  showAnnouncement(
    text: string,
    holdMs = ANNOUNCEMENT_DEFAULT_HOLD_MS,
    mode: 'focused' | 'unfocused' = 'focused',
  ): Promise<void> {
    const el = document.createElement('div');
    const sharedCss = `
      position: fixed;
      left: 50%; top: 50%;
      transform: translate(-50%, -50%);
      max-width: 70vw;
      text-align: center;
      font-family: 'Georgia', 'Times New Roman', serif;
      font-size: clamp(28px, 4.5vw, 56px);
      color: #f4e6c1;
      padding: 28px 48px;
      text-shadow: 0 2px 8px rgba(0, 0, 0, 0.9);
      opacity: 0;
      pointer-events: none;
      z-index: ${TEXT_Z};
      transition: opacity ${ANNOUNCEMENT_FADE_MS}ms ease-out;
    `;
    if (mode === 'focused') {
      el.style.cssText = sharedCss + `
        background: rgba(8, 10, 18, 0.82);
        border: 2px solid #e08a3a;
        border-radius: 6px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.7), 0 0 24px rgba(224, 138, 58, 0.35);
      `;
    } else {
      // No hard frame — let the text feather into the world via a radial
      // mask so the player still has full peripheral context.
      el.style.cssText = sharedCss + `
        background: radial-gradient(ellipse at center, rgba(8, 10, 18, 0.78) 30%, rgba(8, 10, 18, 0) 75%);
        border: none;
        border-radius: 0;
        -webkit-mask-image: radial-gradient(ellipse at center, #000 55%, transparent 90%);
                mask-image: radial-gradient(ellipse at center, #000 55%, transparent 90%);
      `;
    }
    el.textContent = text;
    document.body.appendChild(el);
    return this.fadeTextElement(el, holdMs, ANNOUNCEMENT_FADE_MS);
  }

  /** Tear down on scene shutdown. Cancels in-flight tweens, clears the DOM. */
  destroy(): void {
    this.fadeEl.remove();
    // Supertitle / announcement elements live independently; they'll fade
    // themselves out shortly. Force-remove any that are still in the DOM
    // to avoid leaking across scene transitions.
    for (const el of Array.from(document.querySelectorAll<HTMLDivElement>(`div[data-screen-effect]`))) {
      el.remove();
    }
  }

  private tweenFade(targetOpacity: number, durationMs: number): Promise<void> {
    this.fadeOpacity = targetOpacity;
    this.fadeEl.style.transition = `opacity ${durationMs}ms ease-in-out`;
    // Block pointer input only when the screen is fully (or nearly) black —
    // partial / dim overlays leave clicks passing through to the world below.
    this.fadeEl.style.pointerEvents = targetOpacity >= 0.95 ? 'auto' : 'none';
    // Force a reflow so the new transition is picked up before opacity flips.
    void this.fadeEl.offsetWidth;
    this.fadeEl.style.opacity = String(targetOpacity);
    return new Promise((resolve) => {
      if (durationMs <= 0) { resolve(); return; }
      setTimeout(resolve, durationMs);
    });
  }

  private fadeTextElement(el: HTMLDivElement, holdMs: number, fadeMs: number): Promise<void> {
    el.setAttribute('data-screen-effect', '1');
    // Force a reflow before flipping opacity so the transition runs.
    void el.offsetWidth;
    el.style.opacity = '1';
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        el.style.opacity = '0';
        setTimeout(() => { el.remove(); resolve(); }, fadeMs);
      }, fadeMs + Math.max(0, holdMs));
    });
  }
}
