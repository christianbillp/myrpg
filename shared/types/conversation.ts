/**
 * Conversation system — graph nodes, choices, outcomes, runtime exchanges.
 *
 * Extracted from the original god-file `shared/types.ts` (now a barrel that
 * re-exports every domain module under `shared/types/`).
 */

// Cross-domain imports — keep these explicit so the dependency graph is visible.
import type { GameState } from "./gameState.js";
import type { NpcSave } from "./npcSave.js";
import type { TriggerAction, TriggerGuard } from "./triggers.js";

//
// Deterministic dialogue graphs that let an encounter play through scripted
// social beats without invoking the AIGM. Designed participant-agnostic from
// day one so simulation-mode NPC-vs-NPC conversations (future scope) reuse
// the same runtime: `participants` is an array (`["player", "npc_bram"]`
// today; `["npc_bram", "npc_overseer"]` once the sim runs), choices carry
// an optional `actor` ref, and effects can target any entity. Today the UI
// only renders when the player is a participant, but the data model and the
// engine don't bake in that assumption.

/** Entity reference. `"player"` is the player; `"npc_<id>"` is an NPC instance
 *  by def id; `"enemy_A"` / `"ally_A"` are combat-label refs the AIGM already
 *  understands. New code MUST accept all four — old data that hard-codes
 *  `"player"` keeps working. */
export type EntityRef = string;

export interface ConversationDef {
  /** Snake_case slug — used as the filename and as the lookup key. */
  id: string;
  /** Id of the first node entered when the conversation starts. */
  startNode: string;
  /** Default participants when the conversation is opened. Today always
   *  `["player", "<npc-ref>"]`; the simulation runtime substitutes
   *  `["npc_a", "npc_b"]`. `start_conversation` may override at call time. */
  defaultParticipants: EntityRef[];
  /** All nodes in the graph. The loader validates that every `next` field
   *  references a real id and that no node is unreachable from `startNode`. */
  nodes: ConversationNode[];
}

export interface ConversationNode {
  id: string;
  /** Lines the speaker delivers when the node is entered. Multiple entries
   *  rotate with anti-repeat memory (mirrors the `narrate` action). */
  lines: string[];
  /** Optional speaker override — defaults to the NPC whose `conversationId`
   *  opened this graph. For multi-character scenes (or future NPC-vs-NPC),
   *  set this to the entity ref of the actual speaker. */
  speaker?: EntityRef;
  /** Effects fired the instant the node is entered (before the player sees
   *  any choices). Common uses: `set_flag`, `npc_speaks` for atmosphere
   *  lines, `npc_remember` for "the NPC noticed the player came back". */
  onEnter?: TriggerAction[];
  /** Player-facing choices. Empty array + `ends: true` makes a terminal node. */
  choices: ConversationChoice[];
  /** When true, the conversation ends after `onEnter` runs. Choices ignored. */
  ends?: boolean;
}

export interface ConversationChoice {
  /** Display label. May contain a `[Skill DC N]` tag — purely cosmetic;
   *  the actual roll is configured under `check`. */
  label: string;
  /** Optional gate. ALL guards must hold for the choice to be visible. */
  visibleIf?: TriggerGuard[];
  /** Optional gate. ALL guards must hold for the choice to be enabled but
   *  visible — surfaced greyed-out otherwise so the player sees the
   *  branch exists. Use this for "you could try this if your relationship
   *  with them were higher" hints. */
  enabledIf?: TriggerGuard[];
  /** Ability / saving-throw check. When set, the engine rolls d20 + the
   *  matching modifier; `total >= dc` routes to `onPass`, otherwise to
   *  `onFail`. `actor` defaults to the player; future NPC-driven choices
   *  pass an explicit ref. */
  check?: {
    actor?: EntityRef;
    /** Mutually exclusive with `ability` — use the higher-level skill modifier. */
    skill?: string;
    /** Mutually exclusive with `skill` — use the raw ability modifier. */
    ability?: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';
    dc: number;
    advantage?: 'normal' | 'advantage' | 'disadvantage';
  };
  /** When `check` resolves true (or no check is configured), run these
   *  effects and jump to `next` / end the conversation. */
  onPass?: ConversationChoiceOutcome;
  /** When `check` resolves false, run these effects + jump. Allows
   *  "try to persuade and fail loudly" branches. */
  onFail?: ConversationChoiceOutcome;
  /** Effects + next when there's no check at all. Equivalent to onPass for
   *  uncheck'd choices; both forms accepted to keep authoring readable. */
  actions?: TriggerAction[];
  next?: string;
  end?: boolean;
  /** Hands off control to the AIGM with the full conversation transcript +
   *  the speaker's `NpcSave` context. The AIGM may re-anchor the player to
   *  a graph node via `set_conversation_node` or close the conversation. */
  openAigm?: boolean;
}

export interface ConversationChoiceOutcome {
  actions?: TriggerAction[];
  next?: string;
  end?: boolean;
}

/** Runtime conversation state stored on `GameState`. `null` when no
 *  conversation is active. The transcript is the canonical record handed to
 *  the AIGM on free-text handoff, and to the persistent NPC save when the
 *  conversation ends. */
export interface ActiveConversation {
  conversationId: string;
  /** Current node id; null briefly between effect dispatch and the next
   *  node entry while a long-running effect chain resolves. */
  currentNodeId: string;
  /** Entity refs of every participant. Today always includes `"player"`;
   *  future simulation runs may omit it. */
  participants: EntityRef[];
  /** Speaker for the most-recently rendered line. Drives the overlay's
   *  portrait + nameplate. */
  currentSpeaker: EntityRef;
  /** Linear transcript of what each participant has said / chosen so far.
   *  Capped at ~24 entries with oldest evicted to keep AIGM context bounded. */
  exchanges: ConversationExchange[];
  /** Set of node ids the conversation has visited this session — drives
   *  "first-visit only" effects and lets the UI tint repeat choices. */
  visitedNodeIds: string[];
  /** Per-node line-variant rotation memory (mirrors `narrationLastUsed`).
   *  Keyed by node id; value is the last variant index used. */
  lineLastUsed: Record<string, number>;
  /** Choice slots whose ability check the player has already rolled. Each
   *  key is `${nodeId}#${choiceIndex}`. The server rejects a second attempt
   *  on the same slot unless `devFlags.allowRetryChecks` is true; the client
   *  reads this to hide the choice (or surface it with a `[DEV]` tag when
   *  retry is dev-enabled). */
  attemptedCheckKeys: string[];
  /** Indices into the current node's `choices` whose `visibleIf` guards pass —
   *  computed server-side on node entry (after `onEnter` actions run, so a
   *  choice can react to flags its predecessor set). The client renders only
   *  these, using the original index so `onChoice` still maps correctly.
   *  Absent ⇒ every choice is visible (node had no guards / pre-existing save). */
  choiceVisibility?: number[];
  /** Set when the conversation is paused awaiting an ability-check resolution.
   *  The engine writes the outcome and resumes via the choice's onPass/onFail. */
  pendingCheck?: {
    choiceIndex: number;
    actor: EntityRef;
    skill?: string;
    ability?: string;
    dc: number;
    advantage?: 'normal' | 'advantage' | 'disadvantage';
  };
}

export type ConversationExchangeKind = 'line' | 'choice' | 'roll' | 'aigm' | 'event';

export interface ConversationExchange {
  /** Who acted at this step. */
  speaker: EntityRef;
  /** Display name resolved at write time (so the transcript reads cleanly
   *  even after a `revealedName` flip). */
  speakerName: string;
  /** Kind drives how the AIGM context formatter renders the line. */
  kind: ConversationExchangeKind;
  text: string;
  /** ISO timestamp at write — used as a tiebreaker when sorting NPC saves
   *  by recency and as a recency hint for the AIGM. */
  at: string;
}
