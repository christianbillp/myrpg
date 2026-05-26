import type { EngineEvent } from './types.js';

/**
 * Synchronous pub/sub bus for engine-emitted events.
 *
 * Design notes:
 *  - Subscribers run inside the publisher's call stack. They may mutate
 *    GameState directly and may publish further events; the bus tracks
 *    publish depth and aborts at MAX_DEPTH to surface malformed loops
 *    (e.g. a trigger that re-emits the same event it just consumed).
 *  - Subscribers are called in priority order (higher first). Default
 *    priority is 0; the TriggerSystem registers at -10 so engine-internal
 *    subscribers always run first.
 *  - `subscribeAll` is the common case for systems like the trigger
 *    evaluator that need to inspect every event; `subscribe(type, …)` is
 *    available when a subscriber only cares about one event shape.
 *
 * The bus owns no game state. State changes flow through subscribers
 * mutating GameState via the GameContext they hold.
 */
type AnyHandler = (event: EngineEvent) => void;
type TypedHandler<T extends EngineEvent['type']> = (event: Extract<EngineEvent, { type: T }>) => void;

interface Subscription {
  handler: AnyHandler;
  priority: number;
  /** When set, only matching event types are forwarded. */
  type?: EngineEvent['type'];
}

const MAX_DEPTH = 16;

export class EventBus {
  private subs: Subscription[] = [];
  private depth = 0;

  subscribeAll(handler: AnyHandler, priority = 0): void {
    this.subs.push({ handler, priority });
    this.subs.sort((a, b) => b.priority - a.priority);
  }

  subscribe<T extends EngineEvent['type']>(type: T, handler: TypedHandler<T>, priority = 0): void {
    this.subs.push({ handler: handler as AnyHandler, priority, type });
    this.subs.sort((a, b) => b.priority - a.priority);
  }

  publish(event: EngineEvent): void {
    if (this.depth >= MAX_DEPTH) {
      console.warn(`[EventBus] Publish depth exceeded ${MAX_DEPTH}; dropping`, event);
      return;
    }
    this.depth++;
    try {
      // Snapshot the subscriber list before dispatch so handlers that add /
      // remove subscriptions can't affect the current publish.
      const snapshot = this.subs.slice();
      for (const sub of snapshot) {
        if (sub.type && sub.type !== event.type) continue;
        sub.handler(event);
      }
    } finally {
      this.depth--;
    }
  }
}
