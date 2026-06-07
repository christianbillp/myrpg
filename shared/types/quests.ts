/**
 * Quest model (structured quests — review Option B).
 *
 * A quest is an ordered list of steps, each with a player-facing objective line
 * and an optional completion condition expressed in the **existing trigger-guard
 * vocabulary** (`TriggerGuard[]`). The `QuestSystem` reuses the trigger evaluator
 * to auto-advance steps deterministically — the engine decides mechanics, the
 * AIGM narrates. Steps may also be advanced explicitly by the AIGM.
 *
 * Authoring is dual-mode:
 *   • **Authored** — JSON files under a setting's `quests/` dir (loaded into defs).
 *   • **Runtime** — created by the AIGM at play time (`runtime: true`); the def is
 *     persisted alongside its `QuestState` so it survives reload. Runtime quests
 *     are validated to a safe subset of actions (no spawns / arbitrary rewards).
 *
 * Rewards are **XP-only by design** — tangible loot (gold, items) is never spawned
 * by a quest; it must come from the world (a body, a paymaster in dialogue) so the
 * fiction stays intact. Quests grant XP for completing steps / the whole quest.
 */
import type { TriggerGuard, TriggerAction } from './triggers.js';

/** How long a quest lives. `encounter` is cleared when the encounter ends;
 *  `adventure` persists across chapters of the current adventure; `world`
 *  persists for the character regardless of adventure. */
export type QuestScope = 'encounter' | 'adventure' | 'world';

export type QuestStatus = 'active' | 'completed' | 'failed';

export interface QuestStepDef {
  id: string;
  /** Player-facing objective line shown while this step is current. */
  text: string;
  /** Auto-completes the step when ALL guards hold (evaluated by the QuestSystem
   *  on relevant bus events, reusing the trigger guard evaluator). When omitted,
   *  the step advances only via an explicit AIGM `advance_quest`. */
  completeWhen?: TriggerGuard[];
  /** XP granted when this step completes. No tangible loot — by design. */
  xpReward?: number;
  /** Optional side-goal: evaluated every tick regardless of the current step,
   *  completes (granting XP + firing onComplete) the moment its guards hold, and
   *  never drives the OBJECTIVE line or blocks/finishes the quest. Use for bonus
   *  discoveries whose XP should be a visible goal without forcing player order.
   *  Steps without this flag form the ordered "spine" that drives progression. */
  optional?: boolean;
  /** Effects fired when this step completes (set flags, narrate, …). For runtime
   *  (AIGM-created) quests these are validated to a safe subset. */
  onComplete?: TriggerAction[];
}

export interface QuestDef {
  id: string;
  title: string;
  description: string;
  scope: QuestScope;
  /** Ordered steps. The quest completes when the last step completes. */
  steps: QuestStepDef[];
  /** XP granted when the whole quest completes (in addition to per-step XP). */
  xpReward?: number;
  /** Optional fail condition — when ALL guards hold the quest is marked failed. */
  failWhen?: TriggerGuard[];
  /** Effects fired on quest completion / failure. */
  onComplete?: TriggerAction[];
  onFail?: TriggerAction[];
  /** True when created at runtime by the AIGM rather than loaded from JSON.
   *  Runtime defs are persisted with their `QuestState`. */
  runtime?: boolean;
}

/** Per-character runtime state for one quest the character has taken on. */
export interface QuestState {
  questId: string;
  status: QuestStatus;
  /** Id of the step currently in progress (empty once completed/failed). */
  currentStepId: string;
  completedStepIds: string[];
}
