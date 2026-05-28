/**
 * WorldPauseManager — coordinates client-side pause holds for the off-camera
 * world tick (Pass 3c).
 *
 * Multiple things can "hold" the pause independently (the GM chat input is
 * focused, the Character Sheet overlay is open, etc). We refcount the holds
 * and post to the server every time the count crosses zero. The server's
 * tick loop respects the flag, so as long as anything holds the pause the
 * world clock stops.
 *
 * Two ways to register a hold:
 *   • `WorldPause.acquire(reason)` / `WorldPause.release(reason)` — call
 *     from overlays or any component with an explicit lifecycle.
 *   • The module installs document-level `focusin` / `focusout` listeners on
 *     every `<input>` and `<textarea>`, so typing into any text field
 *     automatically pauses without per-component wiring.
 */
import { gameClient } from './GameClient';

class WorldPauseManager {
  private holders = new Set<string>();
  private sessionId: string | null = null;
  private installed = false;

  /** Bind the manager to the active session. Called from GameScene on session start. */
  setSession(sessionId: string | null): void {
    if (this.sessionId === sessionId) return;
    this.sessionId = sessionId;
    // A new session starts unpaused — drop any stale holders from a previous
    // session so the new world clock starts ticking immediately.
    this.holders.clear();
    if (sessionId) {
      void gameClient.setWorldPaused(sessionId, false);
      this.installInputListeners();
    }
  }

  /** Register a named hold. Idempotent — re-acquiring the same name is a no-op. */
  acquire(reason: string): void {
    if (this.holders.has(reason)) return;
    const wasZero = this.holders.size === 0;
    this.holders.add(reason);
    if (wasZero) this.flush();
  }

  /** Drop a previously acquired hold. Idempotent — releasing an unknown reason is a no-op. */
  release(reason: string): void {
    if (!this.holders.has(reason)) return;
    this.holders.delete(reason);
    if (this.holders.size === 0) this.flush();
  }

  /** Test helper — true while any holder is active. */
  isPaused(): boolean { return this.holders.size > 0; }

  private flush(): void {
    if (!this.sessionId) return;
    void gameClient.setWorldPaused(this.sessionId, this.holders.size > 0);
  }

  /**
   * Install global focusin / focusout listeners so typing into any text input
   * (the GM chat box, the encounter editor's title field, the trigger editor's
   * region inputs, etc.) automatically pauses the world. Idempotent across
   * scene starts.
   */
  private installInputListeners(): void {
    if (this.installed) return;
    this.installed = true;
    document.addEventListener('focusin', (e) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || (t as HTMLElement).isContentEditable) {
        this.acquire('typing');
      }
    });
    document.addEventListener('focusout', (e) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || (t as HTMLElement).isContentEditable) {
        this.release('typing');
      }
    });
  }
}

export const WorldPause = new WorldPauseManager();
