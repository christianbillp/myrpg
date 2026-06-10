/**
 * WebSocket protocol (server → client).
 *
 * Extracted from the original god-file `shared/types.ts` (now a barrel that
 * re-exports every domain module under `shared/types/`).
 */

// Cross-domain imports — keep these explicit so the dependency graph is visible.
import type { GameEvent } from "./animation.js";
import type { GameState } from "./gameState.js";

export type ServerWSMessage =
  | { type: 'state_update'; state: GameState; events: GameEvent[] }
  | { type: 'aigm_reply'; reply: string }
  // Streaming AIGM protocol — emitted during processAIGMChat:
  //   aigm_start: a new AIGM turn has begun; the client opens a fresh
  //     assistant bubble (baseline = 0).
  //   aigm_chunk: text delta appended to the current assistant bubble.
  //   aigm_checkpoint: the chunks since the last checkpoint are canonical —
  //     the client advances its discard baseline to the current text length.
  //   aigm_speculative_discard: the chunks since the last checkpoint were
  //     written before a roll-requesting tool and must be removed from the
  //     visible bubble. Client rolls back to the discard baseline.
  //   aigm_done: the final, persisted reply text + roll-result strings.
  | { type: 'aigm_start' }
  | { type: 'aigm_chunk'; text: string }
  | { type: 'aigm_checkpoint' }
  | { type: 'aigm_speculative_discard' }
  | { type: 'aigm_done'; reply: string; rollResults: string[] }
  | { type: 'error'; message: string };
