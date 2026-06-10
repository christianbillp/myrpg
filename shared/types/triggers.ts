/**
 * EncounterTrigger + trigger action vocabulary.
 *
 * Extracted from the original god-file `shared/types.ts` (now a barrel that
 * re-exports every domain module under `shared/types/`).
 */

// Cross-domain imports — keep these explicit so the dependency graph is visible.
import type { WorldFlagValue } from "./engineEvents.js";
import type { NPCDef } from "./entities.js";
import type { CombatMode, PlayerState } from "./gameState.js";
import type { GameState } from "./longRest.js";
import type { NpcFactValue, NpcSave } from "./npcSave.js";

//
// Authorable rules of the form: WHEN <event matches> IF <world-state guards>
// THEN <ordered effects>. Triggers belong to an encounter (JSON in
// server/data/encounters/) and are registered as subscribers on session
// start. Each fired trigger's id is appended to GameState.firedTriggerIds
// so once-only semantics survive save/load.

export type WhenClause =
  | { event: 'player_moved'; in_area?: { x: number; y: number; w: number; h: number }; tile?: { x: number; y: number };
      /** Fires when the player steps onto any cell of a named map zone. `cells`
       *  is the zone's `"x,y"` cell list, resolved from the map at authoring
       *  time so the runtime is self-contained; `name` is for display. */
      in_zone?: { name: string; cells: string[] } }
  /** Fires when the player uses the Study action on this feature tile from
   *  within reach (engine-gated, 1-tile). The deliberate-examination
   *  counterpart to a `player_moved` auto-trigger. The tile also surfaces to
   *  the client as a studyable target so STUDY enters a tile picker. */
  | { event: 'study_feature'; tile: { x: number; y: number } }
  /** Fires when the player uses the Magic action on this feature tile from
   *  within reach (≤1) — channelling magic into it (e.g. the binding rite at the
   *  keystone). Surfaces the tile to the client as a magic target so the MAGIC
   *  button enters a tile picker. */
  | { event: 'magic_feature'; tile: { x: number; y: number } }
  | { event: 'npc_killed'; defId?: string }
  /** Fires when the player casts a spell. Optional `spellId` / `school` filters
   *  narrow it (omit to fire on any spell). */
  | { event: 'spell_cast'; spellId?: string; school?: string }
  /** Fires when the player uses the Help action to aid a creature. Optional
   *  `targetId` (instance) / `targetDefId` filters narrow it. */
  | { event: 'help_used'; targetId?: string; targetDefId?: string }
  | { event: 'item_picked_up'; defId?: string }
  | { event: 'turn_started'; combatantId?: 'player' | string }
  | { event: 'turn_ended'; combatantId?: 'player' | string }
  | { event: 'combat_started' }
  | { event: 'combat_ended' }
  /** Fires once at session start, after all engine subscribers register. Use
   *  to attach intro cinematics (supertitle, fade-in, opening announcement). */
  | { event: 'encounter_started' }
  /** Fires once when the encounter resolves — combat-victory OR completionFlag
   *  set. Use for closing announcements, post-victory supertitles, etc. */
  | { event: 'encounter_completed' }
  | { event: 'damage_dealt'; target?: 'player' | string }
  | { event: 'hp_threshold_crossed'; target?: 'player' | string; ratio?: number; direction?: 'below' | 'above' }
  | { event: 'faction_changed'; factionId?: string }
  /** Fires when a world flag is set via `set_flag` (or any other path that
   *  publishes `flag_set`). `name` matches a specific flag; omitting it fires
   *  on every flag write. `value` further filters by the assigned value. */
  | { event: 'flag_set'; name?: string; value?: WorldFlagValue }
  | { event: 'custom'; name: string };

export type ComparisonOp = 'lt' | 'le' | 'eq' | 'ge' | 'gt';

export type TriggerGuard =
  | { type: 'flag_set'; name: string }
  | { type: 'flag_unset'; name: string }
  | { type: 'flag_equals'; name: string; value: WorldFlagValue }
  | { type: 'hp_below'; ratio: number }
  | { type: 'enemies_alive'; op: ComparisonOp; count: number }
  | { type: 'allies_alive'; op: ComparisonOp; count: number }
  /** True when the number of living NPCs with the matching `defId` satisfies the comparison. Use to gate ambush triggers on "at least one bandit is still alive" or to detect "the boss is dead" regardless of disposition. */
  | { type: 'npcs_alive'; defId: string; op: ComparisonOp; count: number }
  | { type: 'phase'; in: CombatMode[] }
  /** True when the player's standing with `factionId` satisfies the comparison. Unknown factions default to 0. */
  | { type: 'faction_standing'; factionId: string; op: ComparisonOp; value: number }
  /** True when the *individual* relationship `a → b` satisfies the comparison.
   *  `a` / `b` are individual ids — an NPC id or `'player'`. Resolves through
   *  the relationship layer (individual override → faction baseline → 0). */
  | { type: 'individual_relation'; a: string; b: string; op: ComparisonOp; value: number }
  /** True when the player's coin purse (in copper pieces — see
   *  `PlayerState.balanceCp`) satisfies the comparison. Use to gate
   *  conversation choices on whether the player can afford something. */
  | { type: 'balance_cp'; op: ComparisonOp; value: number };

export type TriggerAction =
  | { type: 'spawn_enemy_near_player'; monsterId: string; minDist?: number; maxDist?: number }
  | { type: 'spawn_enemy_at'; monsterId: string; x: number; y: number }
  | { type: 'show_log'; message: string }
  /** Replace the player-facing OBJECTIVE line (`GameState.objective`) — lets a
   *  trigger advance the stated goal as the scene progresses, instead of the
   *  objective being frozen at session start. */
  | { type: 'set_objective'; text: string }
  /** Start an authored quest (by id, from `defs.quests`) — e.g. on
   *  `encounter_started`. The quest then auto-advances its steps via their
   *  `completeWhen` guards. No-op if the id is unknown or already active. */
  | { type: 'start_quest'; questId: string }
  | { type: 'send_aigm_message'; message: string }
  /** Picks a canned variant from `server/data/narration/{narrationId}.json` and pushes it into the Event Log. The picker avoids repeating the last-used variant per id. */
  | { type: 'narrate'; narrationId: string }
  | { type: 'set_flag'; name: string; value: WorldFlagValue }
  /**
   * Set a world flag to a value picked uniformly at random from `values`.
   * Publishes `flag_set` just like `set_flag`. Use to inject one-of-N
   * variety into conversation flow — e.g. Vask's "Ask for a contract"
   * choice rolls a random mission encounter id from the pool. The
   * specific pick is observable through `flag_equals` guards (or
   * `flag_set` event listeners) so authored content can branch on it.
   *
   * Note: uses `Math.random()`, not the sim-deterministic `SimRng`. The
   * choice is intentionally non-reproducible so the same conversation
   * gives different results on re-roll.
   */
  | { type: 'pick_random_value'; name: string; values: WorldFlagValue[] }
  /**
   * Roll a fresh procedural **quest** (a typed quest + its generated
   * encounter(s) — see `server/src/quest/`), register it server-side, and set
   * the world flags the Bureau-office conversation reads to quote the contract
   * BEFORE the player accepts:
   *
   *   • `mission_pending`         — the stage-0 encounter id (`mission_gen_<uuid>`)
   *   • `mission_offer_type`      — the quest type id (bounty / hunt / rescue / …)
   *   • `mission_offer_objective` — the quest's opening objective line
   *   • `mission_offer_reward_cp` — total cp paid out on completion
   *   • `mission_offer_reward_xp` — total xp awarded on completion
   *
   * The transition endpoint serves the generated encounter + map from the
   * in-memory quest registry when the id starts with `mission_gen_`. Reads
   * `worldFlags.mission_last_type` to avoid re-rolling the same type twice in a
   * row. Authored in `bureau_office_chat.json`; not surfaced in the editor.
   */
  | { type: 'generate_mission_contract' }
  /**
   * Start the generated quest attached to the current encounter — fired by the
   * `encounter_started` trigger of every generated quest stage. Looks the quest
   * up in the registry by the current encounter id, registers its `QuestDef` as
   * a trusted runtime def, and starts it (no-op if already active, e.g. on a
   * later stage of a multi-encounter quest). No payload.
   */
  | { type: 'begin_generated_quest' }
  /**
   * Pay out the procedurally-generated mission reward stored in
   * `worldFlags.mission_offer_reward_cp` and `mission_offer_reward_xp`.
   * Awards the cp through the same `adjust_player_balance_cp` path so
   * the Event Log shows the line item; awards xp through the same path
   * as `award_xp`. No-op when either flag is unset or non-numeric.
   * Used by the Bureau turn-in node so the player gets paid the
   * specific amount Vask quoted when the contract was offered.
   */
  | { type: 'award_mission_reward' }
  /** Applies a 5e condition to the player. Future scope: arbitrary target selectors. */
  | { type: 'apply_condition_to_player'; condition: string }
  /** Re-publishes a custom event on the bus, allowing one trigger to fan out into others. Only `custom` events are allowed — engine-canonical events (`npc_killed`, `damage_dealt`, …) cannot be forged from authored data. */
  | { type: 'emit_event'; name: string; payload?: Record<string, unknown> }
  | { type: 'adjust_faction_standing'; factionId: string; delta: number }
  /**
   * Shift the standing between any two factions by `delta`, clamped to ±100.
   * Mirrors to both directions by default — set `mirror: false` for a
   * one-sided shift (one faction's opinion of the other moves without
   * reciprocation). Generalises `adjust_faction_standing` to the full
   * pair-wise matrix.
   */
  | { type: 'adjust_faction_relation'; a: string; b: string; delta: number; mirror?: boolean }
  /** Set the standing between two factions to an absolute value (clamped to ±100). Mirroring behaves like `adjust_faction_relation`. */
  | { type: 'set_faction_relation'; a: string; b: string; value: number; mirror?: boolean }
  /**
   * Set the *individual* relationship `a → b` to an absolute value (±100). `a` /
   * `b` are individual ids — an NPC id or `'player'`. This is the override layer
   * in front of faction baselines: use it to make same-faction members enemies
   * or opposing-faction members friends. Mirrors by default; `mirror: false`
   * for a one-sided link. Reprojects affected NPCs' disposition.
   */
  | { type: 'set_individual_relation'; a: string; b: string; value: number; mirror?: boolean }
  /** Shift the individual relationship `a → b` by `delta` (clamped ±100), resolving the current effective value first. Mirroring behaves like `set_individual_relation`. */
  | { type: 'adjust_individual_relation'; a: string; b: string; delta: number; mirror?: boolean }
  /** Mark a faction as identified by the player — its name will render in the Target Panel of every member from now on (Pass 3 UI work). Idempotent. */
  | { type: 'reveal_faction'; factionId: string }
  | { type: 'record_rumor'; id: string; text: string; salience?: number }
  /** Promotes (or demotes) every NPC currently in the encounter whose `defId` matches. Faction-mates of a newly hostile NPC are auto-aggroed via the existing `aggroFaction` path. Use together with `trigger_combat` to turn a peaceful scene hostile when the player crosses a threshold. */
  | { type: 'set_disposition_by_def_id'; defId: string; disposition: 'ally' | 'neutral' | 'enemy' }
  /**
   * Hide (or reveal) every NPC currently in the encounter whose `defId`
   * matches. When `hidden: true`, the NPC starts invisible to the player —
   * the client skips rendering the token and the AIGM combatant list omits
   * it.
   *
   * Reveal modes:
   *   • `'perception'` (default) — the NPC stays hidden until the player's
   *     passive Perception meets the NPC's `hideDC` on a movement-time
   *     sweep (line-of-sight respected via the Vision system). `hideDC`
   *     defaults to `10 + monsterDef.stealthBonus`. Use for stealth
   *     creatures and scrub ambushers where skill matters.
   *   • `'trigger'` — the NPC is invisible to passive Perception sweeps
   *     entirely; it is only revealed by an explicit `set_npc_hidden
   *     { hidden: false }` action. Use for narratively-locked reveals
   *     (the dead rise from their niches, the wall slides open) where
   *     no roll should be able to spoil the beat.
   */
  | { type: 'set_npc_hidden'; defId: string; hidden: boolean; hideDC?: number; revealedBy?: 'perception' | 'trigger' }
  /**
   * Make every living NPC whose `defId` matches WALK OFF the map. Each marked
   * NPC steps toward the nearest map edge on every exploration world-tick and
   * is removed from the encounter once it reaches the edge — so a creature that
   * is paid off, talked down, or otherwise dismissed visibly departs instead of
   * blinking out in place. Use for non-lethal "the bandits withdraw into the
   * trees" resolutions. (For an instant death-removal use `set_npc_dead`.)
   */
  | { type: 'npc_leaves'; defId: string }
  /**
   * Relocate every living NPC whose `defId` (or instance id) matches to the
   * given tile — the authored-content twin of the AIGM `move_entity` tool.
   * `mode: 'walk'` (default) emits `entity_move` steps along a BFS path so
   * the client animates a visible approach (a hunter closing in, a guard
   * redeploying); `'teleport'` repositions instantly (off-screen staging).
   * A blocked / occupied destination bumps to the nearest free passable
   * tile; an unreachable walk destination falls back to teleport. Multiple
   * matches fan out around the tile. Not editor-authored (preserved
   * verbatim on round-trip).
   */
  | { type: 'move_npc'; defId: string; x: number; y: number; mode?: 'walk' | 'teleport' }
  /**
   * Mark every living NPC currently in the encounter whose `defId` matches
   * as dead. Sets `hp = 0`, applies the `dead` condition, and (optionally)
   * attaches a `corpseSearch` payload — when set, the player's SEARCH
   * action picks the corpse up as a one-shot Perception target while
   * adjacent. Authors use this for found-bodies-as-clues setups: spawn an
   * NPC at a tile, then mark the def dead on `encounter_started` with a
   * tailored success/failure pair. Idempotent: if the NPC is already dead,
   * only the optional `corpseSearch` payload is applied.
   *
   * `dropInventory` (default `true`) mirrors the normal `killNpc` path —
   * the NPC's `inventoryIds` become map items at their tile. Set to
   * `false` for found bodies whose gear should NOT scatter (Vael's
   * licence-seal stays on his person, surfaced via `corpseSearch`).
   */
  | { type: 'set_npc_dead'; defId: string; corpseSearch?: { dc: number; successText: string; failureText: string; rewardItemId?: string }; dropInventory?: boolean; hiddenUntilSeen?: boolean }
  /**
   * Promote (or demote) every living NPC with matching `defId` to / from
   * COMPANION status — the NPC sim runner ticks them once per off-camera
   * tick, the COMPANION chip appears in the Player Panel, and the player
   * can issue FOLLOW / WAIT / ATTACK commands via that chip.
   *
   * `isCompanion: true` flips the NPC to:
   *   • disposition `'ally'` so combat picks the ally-AI path,
   *   • a fresh `CompanionState { followMode, simState }` so the sim engine
   *     can resume mid-walk if the world saves between ticks.
   * `isCompanion: false` clears `companion` and demotes back to whatever
   * disposition the author wants (`returnDisposition`, default `'neutral'`).
   *
   * Idempotent: re-promoting a companion just resets the `followMode`
   * without resetting the sim state, so an in-flight WAIT / ATTACK
   * override survives a re-fire.
   */
  | { type: 'set_npc_companion'; defId: string; isCompanion: boolean; followMode?: 'tight' | 'loose'; returnDisposition?: 'neutral' | 'ally' | 'enemy' }
  /** Kicks off combat when the engine is in the exploring phase and at least one enemy is alive. Idempotent — no-ops if either precondition fails. */
  | { type: 'trigger_combat' }
  /** Award XP to the player. Use for trigger-fired story rewards (parley success, scouted clue, riddle solved) where no kill rolled the XP automatically. */
  | { type: 'award_xp'; amount: number }
  /** Roll a player ability check server-side (d20 + the player's `skills[<skill>]` bonus) against `dc`. Fires `onPass` actions if the total ≥ DC, otherwise `onFail`. Either branch may be empty — an empty `onFail` is the standard way to write "perception check that silently does nothing on a miss". The roll itself is NOT logged so failed perception/stealth checks don't leak information about hidden content. */
  | { type: 'player_ability_check'; skill: string; dc: number; onPass: TriggerAction[]; onFail: TriggerAction[] }
  /** Centre-screen announcement card; also appended to the Event Log so the message persists. Mirrors the `show_announcement` AIGM tool.
   *  `mode` defaults to `'focused'` (orange-bordered card; hides Player/Target/HUD panels; locks input; pauses world). Use `'unfocused'` for borderless atmospheric announcements that leave the UI and game running. */
  | { type: 'show_announcement'; text: string; durationMs?: number; mode?: 'focused' | 'unfocused' }
  /** Speech bubble above the named entity's token (same renderer the `npc_speaks` AIGM tool drives). `entity` accepts `player` or an NPC entity ref (`enemy_A`, `npc_<id>`). No-op when the entity can't be resolved. */
  | { type: 'npc_speaks'; entity: string; text: string }
  /** Black-out fade overlay. `mode: 'out'` fades to full black; `mode: 'in'` fades back to clear; `mode: 'dim'` fades to a 50% black overlay (atmospheric dim, world still visible). The overlay is sticky — pair every darkening fade ('out' or 'dim') with a matching `in`. Mirrors the `fade_screen` AIGM tool. */
  | { type: 'fade_screen'; mode: 'in' | 'out' | 'dim'; durationMs?: number }
  /** Toggle the encounter's `allowsLongRest` flag at runtime. Maps the
   *  `LONG REST` Player Panel action to either available or hidden — useful
   *  for "you've reached the inn" beats where the room becomes restable
   *  partway through the encounter, or for revoking a rest privilege when
   *  the situation turns hostile. Idempotent. */
  | { type: 'set_long_rest'; allowed: boolean }
  /** Add (positive) or deduct (negative) copper from the player's coin
   *  purse. Mirrors the AIGM `award_coins` tool. When `deltaCp` is negative
   *  and the player can't pay, the action becomes a no-op AND logs a
   *  configurable refusal message — gate on `balance_cp` upstream when the
   *  conversation needs to branch on the affordance. */
  | { type: 'adjust_player_balance_cp'; deltaCp: number; reason?: string }
  // ── Conversation system ────────────────────────────────────────────────
  /** Open a conversation. `npcRef` resolves to a live NPC instance (`npc_<id>`
   *  or a combat-label ref); `conversationId` defaults to that NPC's
   *  `NPCDef.conversationId` when omitted. No-op when another conversation
   *  is already active or the ref doesn't resolve. */
  | { type: 'start_conversation'; npcRef: string; conversationId?: string }
  /** Close the active conversation. No-op when none is open. Flushes the
   *  participating persistent NPCs' saves so the transcript persists. */
  | { type: 'end_conversation' }
  /** Jump the active conversation to a different node. Used by AIGM
   *  `set_conversation_node` tool calls + by author scripting to splice in
   *  an event mid-dialogue. No-op when no conversation is active or the
   *  node id doesn't exist. */
  | { type: 'set_conversation_node'; nodeId: string }
  // ── NPC persistence (writes to NpcSave) ────────────────────────────────
  /** Record a structured fact on the named NPC's save. `ref` accepts
   *  `"self"` (resolves to the speaker of the current conversation node),
   *  `npc_<id>`, or a combat-label ref. `value` defaults to `true`.
   *  No-op when the target NPC isn't persistent. */
  | { type: 'npc_remember'; ref: string; fact: string; value?: NpcFactValue; source?: 'authored' | 'aigm' | 'witness' | 'system' }
  /** Forget a previously-recorded fact. Rare — memory-wipe magic, retcons,
   *  AIGM corrections. */
  | { type: 'npc_forget'; ref: string; fact: string }
  /** Adjust an NPC's relationship axis with `target` by `delta` (clamped
   *  ±100). `target` is an entity ref — `"party"` for the player or
   *  `npc_<id>` for inter-NPC standings. `axis` defaults to `"party"`
   *  (the base relationship) — `"trust"` / `"respect"` reserved for the
   *  three-axis expansion. */
  | { type: 'npc_adjust_relationship'; ref: string; target: string; delta: number; axis?: 'party' | 'trust' | 'respect' }
  /** Append a free-form journal line to the NPC's save. Capacity-limited;
   *  the lowest-salience oldest entry is evicted when full. */
  | { type: 'npc_record_journal'; ref: string; text: string; salience?: 1 | 2 | 3; source?: 'authored' | 'aigm' | 'witness' | 'system' }
  /** Advance the NPC's personal-arc phase. */
  | { type: 'npc_set_arc_phase'; ref: string; phase: string };

export interface EncounterTrigger {
  /** Unique within the encounter; used as the dedupe key in `firedTriggerIds`. */
  id: string;
  /** Event that wakes the trigger. */
  when: WhenClause;
  /** Optional list of world-state guards. ALL must hold for the trigger to fire (logical AND). */
  if?: TriggerGuard[];
  /** Ordered list of effects to apply when the trigger fires. */
  then: TriggerAction[];
  /** When omitted or true, the trigger fires at most once per session. When false, it re-fires on every match. */
  once?: boolean;
}
