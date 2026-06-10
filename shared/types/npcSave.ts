/**
 * Per-NPC save layer — facts, journal entries, conversation history.
 *
 * Extracted from the original god-file `shared/types.ts` (now a barrel that
 * re-exports every domain module under `shared/types/`).
 */

// Cross-domain imports — keep these explicit so the dependency graph is visible.
import type { EntityRef } from "./conversation.js";
import type { NpcState } from "./npcState.js";

//
// Persistent NPCs maintain a per-character save file. Conversations write to
// it explicitly via the new `npc_remember` / `npc_adjust_relationship` /
// `npc_record_journal` actions; the engine also writes implicitly when the
// NPC is involved in canonical events (death, name reveal, faction flip).
// Future `WitnessSystem` will write inter-NPC observation records here too.

/** Fact values stored under `NpcSave.facts`. Booleans for binary memory
 *  ("met_the_player"), numbers for counters ("times_lied_to"), strings for
 *  free-form tags ("favorite_drink:dwarven_ale"), or a structured shape
 *  with an occurrence count + last-at timestamp. */
export type NpcFactValue =
  | boolean
  | number
  | string
  | { count: number; lastAt: string };

export interface NpcFactEntry {
  value: NpcFactValue;
  /** Provenance of the write. Drives future "how confident is the NPC?"
   *  reasoning — author-scripted facts are ground truth, witness facts are
   *  observational, AIGM facts are roleplay-driven. */
  source: 'authored' | 'aigm' | 'witness' | 'system';
  recordedAt: string;
}

export interface NpcJournalEntry {
  text: string;
  /** 1 = trivia, 3 = pivotal. Capacity-limited evictor uses salience first,
   *  age second when the journal is full. */
  salience?: 1 | 2 | 3;
  source: 'authored' | 'aigm' | 'witness' | 'system';
  recordedAt: string;
}

export interface NpcConversationHistoryEntry {
  conversationId: string;
  /** Node where the conversation ended (terminal node id or last-rendered
   *  node when ended via AIGM `end_conversation`). */
  endedAtNodeId: string;
  /** Sequence of choice labels the player picked through the graph —
   *  surfaced to the AIGM so future free-text exchanges can reference
   *  "you said you'd come back for me". */
  chosenPath: string[];
  /** Every check rolled during the conversation. */
  rolledChecks: Array<{ skill: string; dc: number; total: number; passed: boolean }>;
  at: string;
}

export interface NpcSave {
  /** NPC def id this save belongs to. */
  npcId: string;
  /** Character def id this save is scoped to — each player keeps their own
   *  memory tree of every NPC. */
  characterId: string;
  /** Liveness. `dead` saves are retained so other NPCs / future scenes can
   *  reference "the NPC died" without the def needing special handling. */
  status: 'alive' | 'dead' | 'fled';
  /** Provenance of the last update. */
  lastSeen: {
    at: string;
    adventureId?: string;
    chapterId?: string;
    encounterId?: string;
  };
  /** Has the player's character learned this NPC's true name? Drives token
   *  nameplate + Target Panel display, mirrors `NpcState.revealedName`. */
  nameKnownToPlayer: boolean;
  /** Stateful overrides applied when the NPC is re-spawned in a future
   *  encounter. Only fields the design wants to persist live here; HP is
   *  optional (future "wounds persist between chapters" rule), conditions
   *  for long-term ones (cursed, etc.). The engine's spawn path layers
   *  these on top of the def's defaults. */
  stateOverrides: {
    currentHp?: number;
    conditions?: string[];
    addedItemIds?: string[];
    removedItemIds?: string[];
    factionId?: string;
    disposition?: 'ally' | 'neutral' | 'enemy';
  };
  /** Relationship scores keyed by entity ref. `"party"` is the player —
   *  conversation gates and the AIGM both read this. Other keys hold
   *  NPC-to-NPC standings (used by the future simulation runtime; the
   *  conversation system today writes only `"party"`). Bounded ±100. */
  relationship: Record<EntityRef, number>;
  /** Optional trust / respect axes — see plan. Kept optional so existing
   *  saves don't need a migration when the axes are introduced. */
  trust?: Record<EntityRef, number>;
  respect?: Record<EntityRef, number>;
  /** Queryable structured memory. Conversation `visibleIf` predicates and
   *  future AIGM `npc_remember` tool both read/write here. */
  facts: Record<string, NpcFactEntry>;
  /** Free-form narrative log surfaced to the AIGM for future conversations.
   *  Capacity-limited (default 20). */
  journal: NpcJournalEntry[];
  /** Per-conversation completion record. */
  conversationHistory: NpcConversationHistoryEntry[];
  /** Optional personal-arc state — for NPCs with their own storyline. */
  arc?: { phase: string; updatedAt: string };
}
