/**
 * SpeechBubbles — lightweight per-token speech indicator. When the server
 * pushes a `npc_speech` event the manager renders an absolutely-positioned
 * HTML bubble above the named entity's token for a few seconds, then fades
 * it out. Bubbles for the same entity stack vertically so several lines in
 * quick succession don't overwrite each other.
 *
 * The manager owns no Phaser state of its own — it just gets pixel-screen
 * coordinates of the speaker from the caller (`getEntityScreenPos`) every
 * frame so resize / camera moves keep the bubble glued to the token.
 */
const BUBBLE_LIFETIME_MS = 6000;
const FADE_MS = 600;
const MAX_BUBBLE_WIDTH = 220;
const BUBBLE_STACK_GAP = 6;
const TOKEN_OFFSET_Y = 32;  // bubble base sits this many px above token centre
/** Rough half-token-size in page pixels used for the overlap-with-target
 *  check. A token is roughly TILE_SIZE (~32px) wide on screen before any
 *  zoom — we pad a touch so a bubble brushing the edge still flips below. */
const TARGET_HALF_BOX = 26;

interface Bubble {
  el: HTMLDivElement;
  entityId: string;
  /** When set, refresh() repositions the bubble *below* the speaker if its
   *  above-the-token rect would overlap this entity's token. Used so the
   *  player-said-to-target bubble never covers the target. */
  avoidEntityId?: string;
  bornAt: number;
}

export interface ScreenPos { x: number; y: number; }

export class SpeechBubbles {
  private readonly bubbles: Bubble[] = [];
  /** Bubbles that should not age out via the BUBBLE_LIFETIME timer (typing
   *  indicators). Cleared explicitly by the caller via the returned function
   *  from `spawnTypingIndicator`. */
  private readonly persistentBubbles: Set<Bubble> = new Set();
  private readonly container: HTMLDivElement;
  private getPos: (entityId: string) => ScreenPos | null = () => null;

  constructor() {
    this.container = document.createElement('div');
    this.container.style.cssText = `
      position: absolute; inset: 0;
      pointer-events: none;
      z-index: 15;
    `;
    document.body.appendChild(this.container);
  }

  /** Inject the entity-to-screen-position resolver. The GameScene wires this
   *  to its `Player` + `NpcToken` registries. Bubbles whose entity no longer
   *  resolves (token despawned) drop on the next refresh. */
  setEntityResolver(fn: (entityId: string) => ScreenPos | null): void {
    this.getPos = fn;
  }

  /** Push a new speech bubble for `entityId` showing `text`. When
   *  `opts.avoidEntityId` is set, the bubble will render below the speaker
   *  any frame that its default above-token position would overlap that
   *  other entity's token (used so the player-says-to-target bubble never
   *  covers the target's face). */
  spawn(entityId: string, text: string, opts?: { avoidEntityId?: string }): void {
    const trimmed = text.trim();
    if (!trimmed) return;

    const el = document.createElement('div');
    el.style.cssText = `
      position: absolute;
      max-width: ${MAX_BUBBLE_WIDTH}px;
      background: rgba(20, 24, 36, 0.95);
      color: #e0e8f0;
      border: 1px solid #5588aa;
      border-radius: 8px;
      padding: 6px 10px;
      font-family: monospace;
      font-size: 11px;
      line-height: 1.55;
      white-space: pre-wrap;
      word-wrap: break-word;
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.6);
      transform: translate(-50%, -100%);
      transition: opacity ${FADE_MS}ms ease-out;
    `;
    el.textContent = trimmed;
    this.container.appendChild(el);

    this.bubbles.push({ el, entityId, avoidEntityId: opts?.avoidEntityId, bornAt: performance.now() });
  }

  /**
   * Reposition + fade-out every active bubble. Call once per frame from the
   * scene's update loop after token positions have been finalised. Returns
   * silently when no bubbles are active so the cost is one bound-check.
   */
  refresh(): void {
    if (this.bubbles.length === 0) return;
    const now = performance.now();
    // Group bubbles by entity so multi-line stacks can lay out vertically.
    const grouped = new Map<string, Bubble[]>();
    for (const b of this.bubbles) {
      const list = grouped.get(b.entityId) ?? [];
      list.push(b);
      grouped.set(b.entityId, list);
    }

    for (const [entityId, list] of grouped) {
      const pos = this.getPos(entityId);
      if (!pos) {
        // Token despawned — drop every bubble for this entity.
        for (const b of list) {
          b.el.remove();
          const idx = this.bubbles.indexOf(b);
          if (idx !== -1) this.bubbles.splice(idx, 1);
        }
        continue;
      }
      // Decide once per entity-group whether to render the stack ABOVE the
      // speaker (default) or BELOW. The flip kicks in only when at least one
      // bubble in the group declares an `avoidEntityId` AND that entity's
      // above-the-speaker rect would land on top of the avoid target.
      let placeBelow = false;
      for (const b of list) {
        if (!b.avoidEntityId) continue;
        const targetPos = this.getPos(b.avoidEntityId);
        if (!targetPos) continue;
        if (this.bubbleOverlapsTarget(b.el, pos, targetPos)) { placeBelow = true; break; }
      }
      // Stack: oldest at the top of the stack, newest closest to the token.
      // When placing below the order reverses so the newest still sits next
      // to the token (just on the opposite side).
      let stackOffset = 0;
      for (let i = list.length - 1; i >= 0; i--) {
        const b = list[i];
        b.el.style.left = `${pos.x}px`;
        if (placeBelow) {
          // translate(-50%, 0) — anchor top of bubble to (left, top).
          b.el.style.transform = 'translate(-50%, 0)';
          b.el.style.top = `${pos.y + TOKEN_OFFSET_Y + stackOffset}px`;
        } else {
          // translate(-50%, -100%) — anchor bottom of bubble to (left, top).
          b.el.style.transform = 'translate(-50%, -100%)';
          b.el.style.top = `${pos.y - TOKEN_OFFSET_Y - stackOffset}px`;
        }
        stackOffset += b.el.offsetHeight + BUBBLE_STACK_GAP;

        if (this.persistentBubbles.has(b)) continue;
        const age = now - b.bornAt;
        if (age >= BUBBLE_LIFETIME_MS + FADE_MS) {
          // Expired — drop it.
          b.el.remove();
          const idx = this.bubbles.indexOf(b);
          if (idx !== -1) this.bubbles.splice(idx, 1);
        } else if (age >= BUBBLE_LIFETIME_MS) {
          b.el.style.opacity = '0';
        }
      }
    }
  }

  /** AABB intersection between the bubble's above-token rect and the target's
   *  token bounding box (padded to TARGET_HALF_BOX on each side). Width is
   *  read off `offsetWidth` so multi-line wrapping is honoured; falls back to
   *  the max bubble width before the element has had a layout pass. */
  private bubbleOverlapsTarget(el: HTMLDivElement, pos: ScreenPos, targetPos: ScreenPos): boolean {
    const w = el.offsetWidth || MAX_BUBBLE_WIDTH;
    const h = el.offsetHeight || 32;
    const bubbleLeft   = pos.x - w / 2;
    const bubbleRight  = pos.x + w / 2;
    const bubbleBottom = pos.y - TOKEN_OFFSET_Y;
    const bubbleTop    = bubbleBottom - h;
    const tLeft   = targetPos.x - TARGET_HALF_BOX;
    const tRight  = targetPos.x + TARGET_HALF_BOX;
    const tTop    = targetPos.y - TARGET_HALF_BOX;
    const tBottom = targetPos.y + TARGET_HALF_BOX;
    return bubbleLeft < tRight && bubbleRight > tLeft && bubbleTop < tBottom && bubbleBottom > tTop;
  }

  /**
   * Spawn a persistent typing-indicator bubble (animated dots) above the
   * named entity. Returns a `clear` function the caller must invoke when
   * the underlying action (typically an AIGM round) completes. The
   * indicator has no lifetime — `refresh()` won't expire it — and it gets
   * cleared on `destroy()` too.
   *
   * Used by the player-says path so the targeted NPC visibly "thinks"
   * while the GM is generating its reply.
   */
  spawnTypingIndicator(entityId: string): () => void {
    const el = document.createElement('div');
    el.style.cssText = `
      position: absolute;
      background: rgba(20, 24, 36, 0.95);
      color: #e0e8f0;
      border: 1px solid #5588aa;
      border-radius: 8px;
      padding: 4px 10px;
      font-family: monospace;
      font-size: 14px;
      letter-spacing: 2px;
      line-height: 1;
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.6);
      transform: translate(-50%, -100%);
      transition: opacity ${FADE_MS}ms ease-out;
      min-width: 24px;
      text-align: center;
    `;
    el.textContent = '...';
    this.container.appendChild(el);

    // Animated dots — cycle ".", "..", "..." every 400ms while the bubble
    // is alive. `setInterval` is cheap enough that we don't bother batching
    // through `refresh()`.
    let step = 0;
    const tick = setInterval(() => {
      step = (step + 1) % 3;
      el.textContent = '.'.repeat(step + 1);
    }, 400);

    const bubble: Bubble = { el, entityId, bornAt: performance.now() };
    // Sentinel lifetime so refresh() never expires this bubble — it lives
    // until the caller invokes `clear()`. We use Number.POSITIVE_INFINITY
    // so the existing `age >= BUBBLE_LIFETIME_MS` checks evaluate false.
    bubble.bornAt = performance.now();
    this.bubbles.push(bubble);
    this.persistentBubbles.add(bubble);

    return () => {
      clearInterval(tick);
      this.persistentBubbles.delete(bubble);
      el.remove();
      const idx = this.bubbles.indexOf(bubble);
      if (idx !== -1) this.bubbles.splice(idx, 1);
    };
  }

  /** Tear down on scene shutdown. */
  destroy(): void {
    for (const b of this.bubbles) b.el.remove();
    this.bubbles.length = 0;
    this.persistentBubbles.clear();
    this.container.remove();
  }
}
