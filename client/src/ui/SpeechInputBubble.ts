/**
 * SpeechInputBubble — inline HTML input field rendered as a speech bubble
 * near the player token. Created by the TALK button on the Player Panel so
 * the player can type a line for the currently-selected target without
 * leaving the map for the GM chat box.
 *
 * Submission is identical to the HUD's `sayto`-mode chat send: the caller
 * wraps the text as `[<player> says to <target>]: <text>`, ships it to the
 * AIGM, and the same handler spawns a speech bubble on the player token.
 *
 * The bubble pins itself to the player's screen position every frame (via
 * `getPlayerPos`) so token movement / camera pan / canvas resize don't drift
 * the input.
 */

export interface ScreenPos { x: number; y: number; }

const BUBBLE_OFFSET_Y = 36;
const INPUT_Z = 16;

export class SpeechInputBubble {
  private readonly el: HTMLDivElement;
  private readonly inputEl: HTMLInputElement;
  private readonly getPlayerPos: () => ScreenPos | null;
  private readonly onSubmit: (text: string) => void;
  private readonly onCancel: () => void;
  private animFrame = 0;
  private disposed = false;
  private readonly onDocPointerDown: (e: PointerEvent) => void;

  constructor(opts: {
    targetName: string | null;
    getPlayerPos: () => ScreenPos | null;
    onSubmit: (text: string) => void;
    onCancel: () => void;
  }) {
    this.getPlayerPos = opts.getPlayerPos;
    this.onSubmit = opts.onSubmit;
    this.onCancel = opts.onCancel;

    this.el = document.createElement('div');
    this.el.style.cssText = `
      position: absolute;
      max-width: 280px;
      min-width: 220px;
      background: rgba(20, 24, 36, 0.96);
      color: #e0e8f0;
      border: 1px solid #8aa9c8;
      border-radius: 8px;
      padding: 6px 10px;
      font-family: monospace;
      font-size: 11px;
      line-height: 1.4;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.7);
      transform: translate(-50%, -100%);
      z-index: ${INPUT_Z};
      display: flex;
      flex-direction: column;
      gap: 4px;
    `;

    const promptLabel = document.createElement('div');
    promptLabel.style.cssText = 'color:#88aacc;font-size:10px;letter-spacing:0.5px;';
    promptLabel.textContent = opts.targetName
      ? `Say to ${opts.targetName}…`
      : 'Speak aloud…';
    this.el.appendChild(promptLabel);

    this.inputEl = document.createElement('input');
    this.inputEl.type = 'text';
    this.inputEl.maxLength = 280;
    this.inputEl.autocomplete = 'off';
    this.inputEl.placeholder = '';
    this.inputEl.style.cssText = `
      background: #111122;
      border: 1px solid #445566;
      color: #e0d0a0;
      font-family: monospace;
      font-size: 12px;
      padding: 4px 6px;
      outline: none;
      caret-color: #e2b96f;
      width: 100%;
      box-sizing: border-box;
    `;
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.submit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.cancel();
      }
      e.stopPropagation();  // don't bleed into Phaser keyboard
    });
    this.el.appendChild(this.inputEl);

    // Click anywhere outside the bubble cancels — feels like a Phaser tooltip
    // dismiss. Listener is registered on the next tick so the initial click
    // that opened the bubble doesn't re-close it.
    this.onDocPointerDown = (e: PointerEvent): void => {
      if (this.disposed) return;
      if (e.target instanceof Node && this.el.contains(e.target)) return;
      this.cancel();
    };
    setTimeout(() => document.addEventListener('pointerdown', this.onDocPointerDown), 0);

    document.body.appendChild(this.el);
    this.inputEl.focus();
    this.tick();
  }

  /** Pin the bubble to the player's current screen position every frame
   *  using requestAnimationFrame — keeps it locked when the player moves,
   *  the camera pans, or the canvas resizes. */
  private tick = (): void => {
    if (this.disposed) return;
    const pos = this.getPlayerPos();
    if (pos) {
      this.el.style.left = `${pos.x}px`;
      this.el.style.top = `${pos.y - BUBBLE_OFFSET_Y}px`;
    }
    this.animFrame = requestAnimationFrame(this.tick);
  };

  private submit(): void {
    const text = this.inputEl.value.trim();
    if (!text) { this.cancel(); return; }
    const onSubmit = this.onSubmit;
    this.dispose();
    onSubmit(text);
  }

  private cancel(): void {
    const onCancel = this.onCancel;
    this.dispose();
    onCancel();
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.animFrame);
    document.removeEventListener('pointerdown', this.onDocPointerDown);
    this.el.remove();
  }

  /** External tear-down (called by the scene during shutdown). */
  destroy(): void {
    this.dispose();
  }
}
