# AIGM Reference

The AI Game Master (AIGM) is a Claude-powered narrative layer that runs alongside the game engine. It receives player messages in natural language, calls tools to enforce game-state changes, and returns 1–3 sentences of in-world narration. The game world — not the AIGM's text — is the source of truth: the AIGM may only narrate outcomes that a tool call has confirmed.

---

## How it works

```mermaid
sequenceDiagram
    participant P as Player
    participant S as Server
    participant C as Claude

    autonumber

    P->>S: Send GM chat message
    S->>C: Stream request (game state, player message, tools)
    C-->>S: Stream text deltas
    S-->>P: Forward chunks live as aigm_chunk
    C-->>S: Tool calls at end of stream
    Note over S: Apply tools, update game state
    Note over S: Refresh CURRENT STATE, loop back<br/>until Claude finishes without tool calls
    S->>P: Refresh map and finalize reply as aigm_done

```

The exchange is **streamed**: text deltas from Claude flow to the player over the WebSocket as they arrive (`aigm_chunk` messages). When a response turns out to contain a roll-requesting tool, the chunks it emitted are speculative — the server sends `aigm_speculative_discard` and the client rolls back. Non-speculative chunk runs are confirmed with `aigm_checkpoint`. The full streaming protocol is documented under [Streaming protocol](#streaming-protocol).

Every exchange appends a `user`/`assistant` pair to the in-memory history so the model retains context across the encounter. On the first exchange the encounter introduction is seeded as an `assistant` message to establish narrative context.

### Tool-use loop

The conversation with Claude can iterate when the model wants to call tools. Each iteration:

1. Stream Claude's response, forwarding text deltas to the client.
2. If the response carries `tool_use` blocks, dispatch each one through `applyAIGMTool` (updates the engine, builds a `toolResultContent` string).
3. Append the assistant turn + the `tool_result` user turn to the message list.
4. **Rebuild the `[CURRENT STATE]` block** on the original turn user message so the next iteration reasons from fresh state.
5. Mark the most-recent `tool_result` with `cache_control: ephemeral` — the prior turn becomes a new cacheable prefix breakpoint, so long tool chains don't re-pay all preceding tokens.
6. Call Claude again.

The loop is capped at **8 iterations** (`MAX_TOOL_ITERATIONS`). On the final allowed iteration every tool result is overridden with a `TOOL BUDGET EXHAUSTED` signal and a tool-less follow-up call forces the model to write its closing narrative. This bounds the cost of any single message.

### Concurrency

`processAIGMChat` is protected by a **per-session mutex** (`tryAcquireAigmLock` / `releaseAigmLock`). A concurrent request on the same session (double-click, second tab) returns `429` immediately rather than interleaving engine mutations with the in-flight turn.

### Transient-error retry

Each Claude streaming call is wrapped in a single retry with 600 ms backoff on transient status codes (408, 425, 429, 500, 502, 503, 504, 529). Non-transient errors (400 schema mismatches, auth) bubble up immediately and surface to the client as `502`.

### Prompt caching

The system prompt and the tool list are sent as content-block arrays with `cache_control: { type: 'ephemeral' }` markers. Anthropic's prompt cache (5-minute TTL) covers both blocks across turns and within the tool-use loop. Tool descriptions are **fully static** — no dynamic IDs interpolated — so adding or removing JSON definitions doesn't invalidate the cache. Inside the tool-use loop, each iteration's most-recent `tool_result` block also carries `cache_control: ephemeral`, extending the cacheable prefix as the chain grows.

The dynamic CURRENT STATE lives in the user message and is intentionally uncached — it changes every turn. The first message after a deploy or a 5-minute idle pays a cache miss; subsequent turns hit cache.

> **Tool list ordering:** the array order is part of the cacheable prompt prefix. Append new tools at the END only — reordering or inserting in the middle invalidates the cache.

### CURRENT STATE block

Every user message is prefixed with a `[CURRENT STATE]` block that the engine builds fresh from `GameState`. It includes:

- Map name, phase, and encounter types
- Player tile, HP, gold, inventory, equipped items, and explicit action-economy fields: `Action: AVAILABLE`/`USED`, `Bonus: AVAILABLE`/`USED`, `N moves left`, `HIDDEN`. Class-feature resource pools appear as `{feature-id} ×N` chips (e.g. `second-wind ×2`) — one chip per non-empty entry in `PlayerState.resources`. Caster characters additionally show `Slots L1:n[,L2:n…]`, `Concentrating: <spellId>` while a concentration spell is active, and a `Prepared spells: [ids]` line beneath the equipped slots.
- All combatants (enemies and allies) with HP, tile, disposition, conditions, and (while combat is active) a `Reaction: AVAILABLE`/`USED` flag — Reactions refresh at the start of each creature's own turn, so an enemy that has already burned its Reaction (e.g. on an Opportunity Attack) cannot react again until its next turn comes around
- Neutral NPCs with tile, including revealed names if any (see [`reveal_npc_name`](#reveal_npc_name))
- A separate **CORPSES** section listing dead NPCs (searchable but cannot act)
- Active quests with progress
- Items on the ground, with a trailing `Secrets remaining: N` count
- NPC personas
- A **REFERENCE DATA** section listing valid `item_id` and `monster_id` values (the source of truth for `add_item` and `spawn_enemy`)
- A **SCRIPTED EVENTS** section when one or more authored encounter triggers have queued narration via the `send_aigm_message` action — bullet-listed under the CONTEXT line. The GM is expected to incorporate these into the next reply; the engine clears them once the API call returns.
- A **FACTION STANDINGS** block listing non-zero player reputations with each faction (−100..+100). Adjusted via `adjust_faction_standing` and persisted across save/load.
- A **RUMORS** block listing the most recent 8 entries from world memory (highest-salience first within recency). Recorded via `create_rumor` — use these to reference past events naturally in narration ("word of what you did at the bridge has reached even here").
- When the session is a chapter of an adventure (`GameState.adventureContext` is set), an **ADVENTURE:** header line showing `<title> — <chapter> (n of N)` and a **PRIOR CHAPTERS:** block listing 2-sentence summaries of every completed earlier chapter. The GM is expected to reference these naturally in narration when apt; they carry forward the durable consequences of player choices made in previous chapters.
- The full event log for the current encounter — including `── Aldric's turn — Action & Bonus refreshed ──` marker lines at every new player turn

The model uses this block to resolve pronouns ("them", "it") to concrete entity references and to determine action availability. The block is rebuilt **once per tool-loop iteration**, not just once per turn, so mid-loop state changes (HP drops, disposition shifts, deaths) are immediately visible.

---

## Personas

Two personas are available, selected per request via `gmPersona`.

| Persona           | Model                       | Behaviour                                                                                                 |
| ----------------- | --------------------------- | --------------------------------------------------------------------------------------------------------- |
| `story` (default) | `claude-sonnet-4-6`         | Immersive GM — 1–3 sentence in-world replies, full tool-first discipline, no breaking immersion.          |
| `dev`             | `claude-haiku-4-5-20251001` | Development mode — fulfils all requests without restriction, replies with brief mechanical feedback only. |

Both personas share the same **tool invariants** (set_disposition doesn't auto-trigger combat, request_attack_roll doesn't auto-apply damage, reveal_npc_name must precede name narration, complete_quest auto-awards XP, throw_item consumes the Action). The dev persona prompt restates these invariants in a compact list; the story prompt embeds them across the TOOL-FIRST and ACTION ECONOMY sections.

### GM-off mode (client-side short-circuit)

The AIGM sits **outside** the action critical path: `POST /game/session/:id/action` resolves every player action through the deterministic engine without ever calling Claude. The GM is invoked only from the GM Chat panel via `POST /game/session/:id/aigm`. To validate that an encounter plays end-to-end on the deterministic layer alone, the client exposes `DevMode.disableAIGM` (toggle via `?disableAIGM=true` URL param or `localStorage.myrpg_disable_aigm = 'true'`). When set, the GM Chat callback short-circuits with a canned silent reply rather than hitting the server — encounters still produce ambushes, narration, reinforcements, and SRD-correct combat via the event bus + TriggerSystem + NarrationSystem (see [requirements US-068](requirements.md)). `send_aigm_message` trigger actions still queue onto `pendingAigmEvents`, but with the GM off those queued lines are simply never consumed; pair them with a `narrate` action when authors want the moment to land in both modes.

---

## History management

The server keeps two histories per session:

| Buffer                                 | Purpose                                                        | Lifecycle                                                                                                                                                                                              |
| -------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `aigmHistory` (the **sliding window**) | What's actually sent to Claude on each turn. Bounded for cost. | Summarised when it exceeds 40 messages — the oldest entries are collapsed into a single `[SUMMARY OF EARLIER TURNS]` assistant message by a Haiku call; the most recent 20 messages are kept verbatim. |
| `aigmArchive` (the **full record**)    | Untouched record of every user/assistant pair this encounter.  | Grows for the life of the session; consulted only by [`recall_memory`](#recall_memory).                                                                                                                |

Historical `[CURRENT STATE]` blocks are stripped from prior user messages before each API call, so the model always reasons from the freshly injected state — never a stale snapshot.

If summary generation fails (e.g. transient Haiku error) the loop falls back to a trivial placeholder summary so the sliding window still bounds.

---

## Entity references

Most tools that target a creature use a common entity reference format.

| Reference                 | Resolves to                                                                  |
| ------------------------- | ---------------------------------------------------------------------------- |
| `"player"`                | The player character                                                         |
| `"enemy_A"` … `"enemy_Z"` | Enemy by uppercase combat label (A–Z, assigned at combat start)              |
| `"ally_A"` … `"ally_Z"`   | Ally by uppercase combat label — drawn from the **same A–Z pool** as enemies |
| `"npc_[id]"`              | Neutral or ally NPC by their runtime id (visible in CURRENT STATE)           |

---

## Tool-first rule

Every game effect the AIGM describes must be enacted by the corresponding tool before narration. If no tool can enact the effect, the AIGM must not narrate it as happening and instead suggests a realistic in-world alternative.

Text retention: text accompanying a [roll-requesting tool](#d20-tests) (`request_attack_roll`, `request_ability_check`, `request_saving_throw`) is discarded — it is necessarily speculative because the roll outcome is not yet known. Text accompanying any other tool (e.g. `reveal_npc_name`, `set_disposition`, `award_gold`) is kept and shown to the player, because the outcome is determined by the tool's input arguments.

## Addressee rule

When the player's message starts with `[PlayerName says to TargetName]:`, that NPC is the addressee and must respond in the AIGM's reply — voice their reaction, dialogue, or refusal. Pivoting to a different NPC or to the environment in place of the addressee's response is forbidden.

## Narrative-mirror rule

The player only sees the narrative reply — never the tool calls. Every player-visible tool effect must therefore also appear in the narrative, in-fiction:

- `reveal_npc_name` → have the NPC speak their name (e.g. _"'I'm Mira,' she answers softly."_)
- `award_gold` / `adjust_player_hp` / `add_item` / `remove_item` → describe the transaction
- `set_disposition` to `enemy` → describe the hostile shift
- `apply_condition` / `remove_condition` → describe cause and effect
- `move_entity` / `despawn_npc` → describe the movement or departure

A silent tool call is invisible to the player and counts as a bug.

---

## Tools

Tools are grouped below by function. Most tools accept a `reason` parameter (string) that is logged server-side for debugging; the per-tool parameter tables are authoritative for which exact fields each tool requires. The two exceptions that omit `reason` are `reveal_npc_name` and `add_log_entry`.

### HP and healing

#### `adjust_player_hp`

Adjusts the player's HP by a signed delta. Positive heals, negative damages. Clamped to `[0, maxHp]`. Temporary HP is consumed first when the delta is negative.

| Parameter | Type    | Required |
| --------- | ------- | -------- |
| `delta`   | integer | yes      |
| `reason`  | string  | yes      |

#### `adjust_npc_hp`

Adjusts any combatant's HP. Positive heals, negative damages. When `damage_type` is supplied and the target is an NPC, the engine automatically applies the target's resistance (half damage), vulnerability (double damage), or immunity (zero damage) before clamping.

| Parameter     | Type    | Required | Notes                                   |
| ------------- | ------- | -------- | --------------------------------------- |
| `entity`      | string  | yes      | Entity reference — see above            |
| `delta`       | integer | yes      | Negative to damage, positive to heal    |
| `damage_type` | string  | no       | e.g. `"fire"`, `"poison"`, `"piercing"` |
| `reason`      | string  | yes      |                                         |

Passing `"player"` as `entity` delegates to `adjust_player_hp` (including Temporary HP consumption). The player has no resistance/vulnerability/immunity fields, so `damage_type` is accepted but has no mechanical effect on the player path.

#### `award_temp_hp`

Grants the player Temporary Hit Points. Temporary HP deplete before real HP and do not stack — the engine keeps whichever value is higher (existing or new). Temporary HP are lost on a Long Rest.

| Parameter | Type    | Required |
| --------- | ------- | -------- |
| `amount`  | integer | yes      |
| `reason`  | string  | yes      |

---

### D20 tests

All three D20 test types are resolved server-side. The engine rolls, applies the relevant modifier and any condition modifiers, compares against DC, and returns the outcome to the model as a tool result. The model then narrates the in-world consequence — never the dice mechanic.

#### `request_ability_check`

Rolls `d20 + skill modifier` vs DC. Active conditions modify the roll automatically:

- **Disadvantage**: `poisoned`, `frightened`

Skill names match the player's `skills` map keys, e.g. `"perception"`, `"stealth"`, `"athletics"`.

| Parameter | Type    | Required |
| --------- | ------- | -------- |
| `skill`   | string  | yes      |
| `dc`      | integer | yes      |
| `reason`  | string  | yes      |

#### `request_saving_throw`

Rolls `d20 + saving throw modifier` vs DC. Active conditions modify the roll automatically:

- **Auto-fail** (no roll): `paralyzed` or `unconscious` on Str or Dex saves
- **Advantage**: `dodging` on Dex saves
- **Disadvantage**: `restrained` on Dex saves

Ability names: `"str"`, `"dex"`, `"con"`, `"int"`, `"wis"`, `"cha"`.

| Parameter | Type    | Required |
| --------- | ------- | -------- |
| `ability` | string  | yes      |
| `dc`      | integer | yes      |
| `reason`  | string  | yes      |

#### `request_attack_roll`

Rolls an attack for the player or any NPC against a fixed AC. Use this for off-turn attacks (opportunity attacks), attacking objects (doors, barrels), or any attack outside the normal player-action flow.

- **Player**: uses `mainAttack` — stat modifier + proficiency bonus. Returns hit/crit/damage.
- **NPC**: uses the NPC's first attack entry. Returns hit/crit/damage.

The tool logs the roll to the Event Log and returns the outcome string. It does **not** apply damage — call `adjust_npc_hp` separately if the hit should wound a specific creature.

| Parameter   | Type    | Required | Notes                          |
| ----------- | ------- | -------- | ------------------------------ |
| `attacker`  | string  | yes      | `"player"` or entity reference |
| `target_ac` | integer | yes      | AC to roll against             |
| `reason`    | string  | yes      |                                |

**DC difficulty guidelines** (SRD):

| Difficulty | DC  |
| ---------- | --- |
| Very easy  | 5   |
| Easy       | 10  |
| Medium     | 15  |
| Hard       | 20  |
| Very hard  | 25  |

---

### Rewards

#### `award_xp`

Awards experience points to the player.

| Parameter | Type    | Required |
| --------- | ------- | -------- |
| `amount`  | integer | yes      |
| `reason`  | string  | yes      |

#### `award_gold`

Awards gold pieces to the player.

| Parameter | Type    | Required |
| --------- | ------- | -------- |
| `amount`  | integer | yes      |
| `reason`  | string  | yes      |

#### `grant_heroic_inspiration`

Grants the player Heroic Inspiration. The player may expend it to re-roll any one die immediately after rolling. Per SRD, only one instance can be held at a time — granting it when the player already has it has no additional effect.

| Parameter | Type   | Required |
| --------- | ------ | -------- |
| `reason`  | string | yes      |

#### `set_exhaustion_level`

Sets the player's Exhaustion level (0–5). Each level imposes −2 to all D20 Tests (ability checks and saving throws). Level 5 is lethal. Per SRD, a Long Rest removes one level.

| Parameter | Type    | Required |
| --------- | ------- | -------- |
| `level`   | integer | yes      |
| `reason`  | string  | yes      |

---

### Inventory

#### `add_item`

Adds one item to the player's inventory.

| Parameter | Type   | Required |
| --------- | ------ | -------- |
| `item_id` | string | yes      |
| `reason`  | string | yes      |

Valid `item_id` values are injected into the tool description at runtime from the JSON files in `server/data/equipment/`. Adding or removing a file in that directory updates the list the model sees on the next server start — the canonical source is the filesystem, not this document.

#### `remove_item`

Removes one instance of an item from the player's inventory.

| Parameter | Type   | Required |
| --------- | ------ | -------- |
| `item_id` | string | yes      |
| `reason`  | string | yes      |

#### `throw_item`

Throws an item at a target, consuming an action if in `player_turn`. Proper thrown weapons (`javelin`, `dagger`) use their weapon stats and proficiency bonus. All other items are improvised weapons (1d4 bludgeoning, no proficiency bonus). The item is removed from the player's inventory or the map.

| Parameter | Type   | Required | Notes                                                        |
| --------- | ------ | -------- | ------------------------------------------------------------ |
| `item_id` | string | yes      | Inventory item id or map item `defId`                        |
| `target`  | string | no       | Entity reference; omit to auto-target nearest enemy in range |
| `reason`  | string | yes      |                                                              |

Attacking a neutral NPC with `throw_item` turns them hostile.

#### `cast_spell`

Cast a spell from the player's known cantrip list or prepared spell list. Routes through the server's generic spell resolver: attack-roll spells (Fire Bolt, Ray of Frost, Magic Missile) consume the Action and an L1+ slot (if leveled), roll vs target AC, deal damage; save-based AOE spells (Burning Hands, Sleep) ask each creature in the area to save; utility spells (Mage Armor, Detect Magic) apply lasting effects. Cantrips spend no slot; levelled spells spend one slot of `spell.level`. Action economy is enforced server-side — if the player's Action is already spent, action-cost spells are refused.

**Use this tool, NOT `request_attack_roll` + `adjust_npc_hp`, to cast a player spell.** Faking a cast bypasses slot tracking, concentration, and action economy.

| Parameter    | Type    | Required | Notes                                                        |
| ------------ | ------- | -------- | ------------------------------------------------------------ |
| `spell_id`   | string  | yes      | Spell id from the player's prepared/cantrip list shown in CURRENT STATE (e.g. `"fire-bolt"`, `"magic-missile"`). |
| `target_id`  | string  | no       | Entity reference (`"enemy_A"` / `"ally_A"` / `"npc_[id]"`). Omit for self/AOE spells. |
| `slot_level` | integer | no       | Defaults to `spell.level`. Upcasting (higher than base) is supported for levelled spells. |
| `reason`     | string  | yes      |                                                              |

Casting an aggressive spell (one with `attack`, `damage`, or a harmful `save`) at a non-ally NPC during `exploring` turns the target hostile, runs faction aggro, and triggers combat — same behaviour as `throw_item` and direct attacks.

---

### Combat

#### `trigger_combat`

Starts combat when the phase is `exploring` and enemies are present on the map. Rolls initiative and transitions to `player_turn` or `enemy_turn`.

| Parameter | Type   | Required |
| --------- | ------ | -------- |
| `reason`  | string | yes      |

> **Note.** `GameEngine.createSession` auto-calls `triggerCombat()` at session start whenever any NPC spawns with `disposition: 'enemy'` and live HP — so combat encounters (hand-authored with hostile spawns, AI-generated `simple_combat`, or deterministic-compose with `enemyIds`) land the player directly in combat without the GM having to call this tool on its first reply. The GM still needs to call `trigger_combat` when changing an NPC's disposition to `enemy` mid-scene (e.g. after a failed parley); see the **Creature disposition change** rule in the GM constraints.

#### `end_combat`

Ends combat immediately — all enemies flee, surrender, or are removed. Transitions to `exploring`.

| Parameter | Type   | Required |
| --------- | ------ | -------- |
| `reason`  | string | yes      |

#### `spawn_enemy`

Spawns a new enemy near the player. In combat, the enemy is inserted into the turn order.

| Parameter    | Type   | Required |
| ------------ | ------ | -------- |
| `monster_id` | string | yes      |
| `reason`     | string | yes      |

Valid `monster_id` values are injected into the tool description at runtime from the JSON files in `server/data/monsters/`. The canonical source is the filesystem, not this document.

---

### NPCs and positioning

#### `despawn_npc`

Removes an NPC from the map. Does not award XP or gold.

| Parameter | Type   | Required |
| --------- | ------ | -------- | ------------ |
| `entity`  | string | yes      | `"npc_[id]"` |
| `reason`  | string | yes      |

#### `set_disposition`

Changes a creature's disposition, which determines who they attack and how they are rendered.

| Disposition | Behaviour                                                                    |
| ----------- | ---------------------------------------------------------------------------- |
| `"ally"`    | Fights alongside the player; included in turn order                          |
| `"neutral"` | Does not participate in combat                                               |
| `"enemy"`   | Fights the player; setting this also makes all same-faction neutrals hostile |

| Parameter     | Type   | Required |
| ------------- | ------ | -------- | ----------------------------------- |
| `entity`      | string | yes      | Entity reference                    |
| `disposition` | string | yes      | `"ally"`, `"neutral"`, or `"enemy"` |
| `reason`      | string | yes      |

#### `move_entity`

Teleports a creature to an exact tile coordinate. Bypasses movement rules and pathfinding.

| Parameter | Type    | Required |
| --------- | ------- | -------- | ---------------- |
| `entity`  | string  | yes      | Entity reference |
| `tile_x`  | integer | yes      |                  |
| `tile_y`  | integer | yes      |                  |
| `reason`  | string  | yes      |

#### `reveal_npc_name`

Records the name an NPC discloses in conversation, updating `NpcState.revealedName`. The new name replaces the generic NPC label above the map token and appears in CURRENT STATE as `(known as: X)`. Must be called **before** any narration that uses the name — otherwise the game world does not register the disclosure and the token label is unchanged. The tool result reminds the model to speak the name in the same reply so the player actually hears it (per the [narrative-mirror rule](#narrative-mirror-rule)).

| Parameter       | Type   | Required | Notes                                                        |
| --------------- | ------ | -------- | ------------------------------------------------------------ |
| `entity`        | string | yes      | Entity reference from CURRENT STATE, e.g. `"npc_villager_0"` |
| `revealed_name` | string | yes      | The name the NPC gave                                        |

#### `set_npc_passive`

Marks an ally NPC as combat-passive. Passive allies skip their combat turn entirely — they remain in the initiative order but the engine never moves or attacks for them. Use when the player tells an ally to stay back, stand down, or not fight. Reversed by calling again with `passive: false`.

| Parameter | Type    | Required | Notes                                                   |
| --------- | ------- | -------- | ------------------------------------------------------- |
| `entity`  | string  | yes      | Entity reference, e.g. `"ally_A"` or `"npc_commoner_0"` |
| `passive` | boolean | yes      | `true` to mark passive, `false` to reactivate           |
| `reason`  | string  | yes      |                                                         |

---

### Conditions

#### `apply_condition`

Applies a condition to the player or any NPC.

| Parameter   | Type   | Required |
| ----------- | ------ | -------- | -------------------------------- |
| `entity`    | string | yes      | Entity reference                 |
| `condition` | string | yes      | Condition name (see table below) |
| `reason`    | string | yes      |

#### `remove_condition`

Removes a condition from the player or any NPC.

| Parameter   | Type   | Required |
| ----------- | ------ | -------- | ---------------- |
| `entity`    | string | yes      | Entity reference |
| `condition` | string | yes      |                  |
| `reason`    | string | yes      |

**Condition engine effects:**

| Condition       | Engine effect                                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `blinded`       | Attacker has Advantage against this creature; creature's own attacks at Disadvantage                                                                     |
| `charmed`       | No engine enforcement — narrative only                                                                                                                   |
| `dashing`       | Cleared at start of THAT creature's next turn (set by Dash action)                                                                                       |
| `disengaged`    | Movement does not provoke opportunity attacks; cleared at start of THAT creature's next turn                                                             |
| `dodging`       | Advantage on Dex saves; attacks against this creature at Disadvantage; cleared at start of THAT creature's next turn. NPC AI: when the brain picks `hold` and the NPC is not Incapacitated, the engine pushes `dodging` automatically — the NPC takes the SRD Dodge action instead of standing inert. |
| `frightened`    | Disadvantage on ability checks and attack rolls                                                                                                          |
| `grappled`      | Speed 0; own attack rolls at Disadvantage                                                                                                                |
| `incapacitated` | Cannot take actions, bonus actions, or reactions                                                                                                         |
| `invisible`     | Creature's own attacks have Advantage; attackers targeting this creature have Disadvantage                                                               |
| `paralyzed`     | Cannot act; attackers have Advantage; melee attacks are auto-crits; speed 0; auto-fail Str/Dex saves                                                     |
| `poisoned`      | Disadvantage on attack rolls and ability checks                                                                                                          |
| `prone`         | Disadvantage on own attack rolls; attackers at range > 1 tile have Disadvantage; melee attackers within 1 tile have Advantage; costs half speed to stand |
| `restrained`    | Speed 0; own attack rolls at Disadvantage; attackers have Advantage; Disadvantage on Dex saves                                                           |
| `slowed`        | Speed reduced by 10 ft; cleared at start of next turn                                                                                                    |
| `stunned`       | Cannot act; attackers have Advantage; speed 0; auto-fail Str/Dex saves                                                                                   |
| `unconscious`   | Cannot act; attackers have Advantage; melee attacks are auto-crits; speed 0; auto-fail Str/Dex saves; auto-applies prone                                 |
| `vexed`         | Own attack rolls at Disadvantage; cleared at start of next turn (applied by Vex/Sap weapon masteries)                                                    |

---

### Narrative

#### `add_log_entry`

Appends a line to the Event Log without changing any game state. Use this to record notable events that do not correspond to a mechanical outcome.

| Parameter | Type   | Required |
| --------- | ------ | -------- |
| `text`    | string | yes      |

---

### Memory

#### `recall_memory`

Searches the full, unsummarized conversation archive for past content matching a keyword or phrase. Use this when the sliding-window history (see [History management](#history-management)) doesn't contain enough detail — e.g. to look up an NPC's previous statements, a quest hook the player mentioned long ago, or any earlier exchange. The query is a case-insensitive substring match. Returns up to 8 matching message snippets (player and GM lines), newest first, each truncated at 240 characters and tagged with a rough turn index.

| Parameter | Type   | Required |
| --------- | ------ | -------- |
| `query`   | string | yes      |
| `reason`  | string | yes      |

---

### Factions & rumors

#### `adjust_faction_standing`

Adjusts the player's standing with a faction by `delta`. Standings live on `GameState.factionStandings` and are clamped to [−100, +100]. Use when an action durably shifts how a faction views the player — saving a member, betraying them, completing a faction-aligned quest. Surfaced to future turns in CURRENT STATE under FACTION STANDINGS. **Implementation note (Pass 2):** writes are mirrored into the full `factionRelations` matrix's `party` row so the new matrix-driven readers see the same value — no behaviour change for the AIGM.

| Parameter    | Type    | Required | Notes                                                          |
| ------------ | ------- | -------- | -------------------------------------------------------------- |
| `faction_id` | string  | yes      | Stable short id (e.g. `"bridge_bandits"`, `"town_guard"`).     |
| `delta`      | integer | yes      | Positive improves the relationship; negative worsens it.       |
| `reason`     | string  | yes      |                                                                |

#### `adjust_faction_relation`

Shifts the standing between **any two factions** by `delta` (positive → friendlier, negative → more hostile). Clamped to [−100, +100]. Use when an event durably changes how two NPC groups feel about each other — the bandits and the guards reach an understanding, the cultists declare war on the townsfolk, etc. Mirrors to both directions by default; pass `mirror: false` for a one-sided shift (one faction's opinion of the other moves without reciprocation). For player-faction shifts prefer `adjust_faction_standing`.

| Parameter   | Type    | Required | Notes                                                                                                       |
| ----------- | ------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `faction_a` | string  | yes      | First faction id (e.g. `"bandits"`).                                                                        |
| `faction_b` | string  | yes      | Second faction id (e.g. `"town_guard"`).                                                                    |
| `delta`     | integer | yes      | Positive improves the relationship; negative worsens it.                                                    |
| `mirror`    | boolean | no       | Default `true`. `false` for an asymmetric shift (only `a → b` moves, leaving `b → a` alone).               |
| `reason`    | string  | yes      |                                                                                                             |

#### `set_faction_relation`

Hard-set the standing between two factions to an absolute value (clamped to ±100). Use for resets — forging an alliance at +80, declaring blood-feud at −100 — rather than incremental nudges (use `adjust_faction_relation` for those). Mirror + asymmetry behave like `adjust_faction_relation`.

| Parameter   | Type    | Required | Notes                                                                                  |
| ----------- | ------- | -------- | -------------------------------------------------------------------------------------- |
| `faction_a` | string  | yes      | First faction id.                                                                      |
| `faction_b` | string  | yes      | Second faction id.                                                                     |
| `value`     | integer | yes      | Absolute standing in [−100, +100].                                                     |
| `mirror`    | boolean | no       | Default `true`.                                                                        |
| `reason`    | string  | yes      |                                                                                        |

#### `reveal_faction`

Marks a faction as identified by the player — from this point on the Target Panel will render its display name + colour instead of `"???"` for every member. Use when the player learns who a group really is through dialogue, finding a sigil, an obvious uniform, etc. Idempotent: a second call with the same id is a no-op.

| Parameter    | Type   | Required | Notes                                       |
| ------------ | ------ | -------- | ------------------------------------------- |
| `faction_id` | string | yes      | Stable short id (e.g. `"bandits"`).         |
| `reason`     | string | yes      |                                             |

#### `create_rumor`

Records a significant world event into long-term world memory. NPCs across the world conceptually "hear about it." Use when something happens that would plausibly be discussed: a public defeat, a saved village, a betrayal. Idempotent — a second call with the same `id` is a no-op. Surfaced to the GM in CURRENT STATE under the RUMORS block.

| Parameter   | Type    | Required | Notes                                                                                |
| ----------- | ------- | -------- | ------------------------------------------------------------------------------------ |
| `id`        | string  | yes      | Stable short slug (e.g. `"bridge_toll_resolved"`). Used as the dedupe key.            |
| `text`      | string  | yes      | Human-readable summary the GM can reference later.                                    |
| `salience`  | integer | no       | 1–10 importance, default 5. 10 = "everyone is talking about it." Used for ordering.   |
| `reason`    | string  | yes      |                                                                                       |

#### `set_world_flag`

Writes a value to `GameState.worldFlags[name]`. Use when a narrative resolution needs to influence encounter triggers — e.g. the player pays a bridge toll and a `"bridge_toll_paid"` flag should disarm the cross-the-bridge ambush trigger. Triggers read these via `flag_set` / `flag_unset` / `flag_equals` guards. Persisted with the world save. Each encounter's `customContext` documents which flags it expects.

| Parameter | Type                          | Required | Notes                                                                            |
| --------- | ----------------------------- | -------- | -------------------------------------------------------------------------------- |
| `name`    | string                        | yes      | Stable short flag name. Encounter-specific (`"bridge_toll_paid"`, `"vault_unsealed"`, …). |
| `value`   | boolean \| number \| string   | yes      | The value to store. Use `true` for binary flags; numbers / strings for counters or categorical state. |
| `reason`  | string                        | yes      |                                                                                  |

---

### Quests

#### `complete_quest`

Force-completes a quest and immediately awards its XP and GP rewards. The XP/GP grant is **automatic** — do NOT also call `award_xp` for the same outcome. To enforce this, the server tracks quests completed within a turn; a subsequent positive `award_xp` in the same turn is rejected with a clear explanation.

| Parameter  | Type   | Required |
| ---------- | ------ | -------- | ----------------------------- |
| `quest_id` | string | yes      | Quest `id` from CURRENT STATE |
| `reason`   | string | yes      |

---

### Stealth

#### `set_player_hidden`

Sets the player's hidden status. When hidden, the player's next attack has Advantage and reveals their position.

| Parameter | Type    | Required |
| --------- | ------- | -------- |
| `hidden`  | boolean | yes      |
| `reason`  | string  | yes      |

---

## Prohibited actions

The AIGM must reject the following and suggest a realistic in-world alternative instead:

- Using `add_item` or `spawn_enemy` because the player simply requested an item or creature — the thing must already exist in the world.
- Narrating teleportation, instantaneous object creation, or magic the player does not possess.
- Narrating any effect that was not confirmed by a tool result.

---

## Action economy

CURRENT STATE shows action-economy resources as explicit literal fields, not by absence: `Action: AVAILABLE` / `Action: USED`, `Bonus: AVAILABLE` / `Bonus: USED`, and `N moves left`. These fields are authoritative for the current turn — they reset every time a new player turn begins, and the event log shows a turn-boundary line (`── Aldric's turn — Action & Bonus refreshed ──`) at every reset. The AIGM must trust these fields over conversation history.

Resource consumption:

| Activity | Cost |
|----------|------|
| `attack`, `throw_item`, `cast_spell` (action-time spell), `dash`, `dodge`, `disengage`, study, influence, utilize | Action |
| Hide — Level 1 Rogue (no Cunning Action yet) | Action |
| Hide — Level 2+ Rogue (Cunning Action unlocked) | Bonus Action |
| `cast_spell` (bonus-action-time spell), drink potion in combat, class features whose `cost.kind` is `bonus-action` (e.g. Second Wind) | Bonus Action |
| First weapon/shield equip or unequip this turn | Free (one free object interaction per turn) |
| Second weapon/shield equip or unequip this turn | Action (Utilize) |
| Armor equip or unequip during combat | **Blocked** (SRD donning is 1–10 minutes) |
| Movement | Drawn from `movesLeft` (1 tile per 5 ft of speed) |

When the player requests something the current flags forbid, the AIGM must state explicitly which resource is spent and what remains — vague deflection ("press your advantage and wait") is forbidden. Examples:

- `Action: USED` + player asks to attack → _"You've already used your Action this turn. You can still move, use a Bonus Action if available, or end your turn."_
- `Bonus: USED` + player asks for Second Wind → _"You've already spent your Bonus Action this turn. End your turn to reset."_
- `0 moves left` + player asks to move → _"You have no movement left this turn — only your Action or Bonus Action, or End Turn."_

Server-side enforcement remains the final word: tools like `throw_item` reject silently and return a result string telling the AIGM to inform the player.

---

## Tool result strings

Every tool returns a one-line `toolResultContent` string describing what changed. Examples:

- `"Player HP 12 → 7 (-5)."` (HP adjustment)
- `"Bandit HP 14 → 0 — killed."` (NPC kill)
- `"+15 GP. Player now has 30 GP."` (gold award)
- `"Spawned bandit at tile (8, 4) as enemy_C."` (spawn)
- `"Quest \"Slay All\" force-completed — rewards (+25 XP, +15 GP) granted automatically. Do NOT also call award_xp for this outcome."` (quest with double-credit warning)
- `"Player gained 5 Temp HP — now has 5 Temp HP (kept higher per SRD)."` (temp HP)
- `"Heroic Inspiration granted. Player may expend it to re-roll any one die."` (heroic inspiration)
- `"TOOL BUDGET EXHAUSTED. Do not call any more tools this turn. Write the final narrative reply to the player now."` (loop-cap signal)

Tools that fail or are blocked return a string explaining the failure, suitable for relaying to the player in-fiction. Tools that involve a die roll (`request_*_roll`) also populate a `rollResult` string that is rendered inline in the GM overlay as a 🎲 entry.

`adjust_npc_hp` builds its result from before/after state directly (not by slicing the event log), so unrelated log lines that may fire during a kill (quest completion, turn markers) can't pollute the result. `throw_item` slices the log but filters out `Quest complete:`, `Total XP:`, and turn-boundary markers.

---

## Streaming protocol

The AIGM reply is **streamed** to the client over the WebSocket. Text chunks appear in the GM chat panel as they're generated rather than after the full reply completes — important for the story persona, where Claude Sonnet responses can take several seconds.

### Server → client messages

| Message                              | When                                                          | Client effect                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `aigm_start`                         | Beginning of a `processAIGMChat` call                         | Open a fresh assistant bubble; baseline = 0.                                                                                              |
| `aigm_chunk` `{ text }`              | Each text delta from Claude                                   | Append `text` to the current bubble.                                                                                                      |
| `aigm_checkpoint`                    | After a non-speculative response completes                    | Advance the discard baseline to the current bubble length (chunks before this point are now permanent).                                   |
| `aigm_speculative_discard`           | After a response that called a roll-requesting tool completes | Roll the bubble back to the last baseline (the chunks were speculative — Claude will write the real text after the roll result is known). |
| `aigm_done` `{ reply, rollResults }` | End of the turn                                               | Replace the streamed bubble with the canonical `reply`; insert any `rollResults` before it as 🎲 entries.                                 |
| `state_update`                       | Engine state changed via tool calls                           | Map and panels refresh (independent of the chat stream).                                                                                  |

### Speculative-text handling

When the model writes text alongside `request_attack_roll` / `request_ability_check` / `request_saving_throw`, that text is speculation about an unknown roll outcome. The chunks still stream to the client immediately, but the response is flagged speculative on completion — the server emits `aigm_speculative_discard` and the client rolls back. The next iteration's response (post-roll) contains the real narrative and gets a normal `aigm_checkpoint`.

For all other tools (`reveal_npc_name`, `set_disposition`, `award_gold`, …) the outcome is determined by the tool's arguments, so accompanying text is canonical and kept (`aigm_checkpoint`).

---

## Implementation files

### Server

| File | Purpose |
|------|---------|
| `server/src/aigm.ts` | Conversation loop — prompt construction, prompt-cache markers, streaming Claude API call, retry/backoff, history summarization, state refresh, tool dispatch |
| `server/src/engine/AIGMTools.ts` | Tool schema definitions (`buildAIGMTools`), `applyAIGMTool` switch, per-turn guards (`resetTurnGuards` — quest/XP double-credit detection) |
| `server/src/engine/GameEngine.ts` | Engine methods called by `applyAIGMTool` |
| `server/src/engine/ConditionSystem.ts` | Condition constants and predicate functions |
| `server/src/engine/CombatSystem.ts` | Roll functions: `rollSkillCheck`, `rollSavingThrow`, `rollPlayerAttackVsAc`, `rollNpcAttackVsAc`, `rollOneInitiative` |
| `server/src/engine/CombatFlow.ts` | Per-combatant Initiative rolling with Surprise/Invisible modifiers; sort + dispatch via `advanceTurn`; turn transitions; emits the `── Aldric's turn ──` boundary marker |
| `server/src/engine/ActionGuards.ts` | Per-action eligibility gates (`canAttackTarget`, `canHide`, `canShortRest`, `canSpendAction`, `canSpendBonusAction`, `playerAttackReachTiles`, `hasCunningAction`, `canCastSpell`, `castableSpellIds`, `canUseFeature`, `usableFeatureIds`) consulted by both `computeAvailableActions` and the server-side action handlers |
| `server/src/engine/InventoryActions.ts` | Equip/unequip with SRD action-economy gating (armor blocked in combat; weapon/shield uses free object interaction + Utilize) |
| `server/src/engine/SpellSystem.ts` | Generic spell resolver — branches on `SpellDef` shape (`attack` / `auto-hit` / `save` / utility); applies damage through `resistMod`; reactive Shield via `tryReactiveShield`; aggro-on-cast for exploring-phase casts |
| `server/src/engine/ConcentrationSystem.ts` | Concentration tracking — `startConcentration`, `endConcentration`, CON-save-on-damage via `maybeBreakConcentration`; per-spell on-end cleanup (e.g. Sleep clears Incapacitated / Unconscious) |
| `server/src/engine/FeatureRegistry.ts` | Class-feature dispatcher + handler registry. `doUseFeature` validates eligibility and runs the handler registered for `FeatureDef.handler`; one handler per feature (e.g. `'second-wind'`) consumes the resource and applies the effect |
| `server/src/sessions.ts` | Per-session storage: sliding-window history, full archive, AIGM mutex, WebSocket push |
| `server/src/index.ts` | `/game/session/:id/aigm` route — mutex acquire, stream wiring, persistence |

### Client

| File | Purpose |
|------|---------|
| `client/src/net/GameClient.ts` | WebSocket message dispatch — routes `aigm_start` / `aigm_chunk` / `aigm_checkpoint` / `aigm_speculative_discard` / `aigm_done` to handlers |
| `client/src/ui/HUD.ts` | GM chat panel — streaming `aigmStart` / `aigmChunk` / `aigmCheckpoint` / `aigmSpeculativeDiscard` / `aigmDone` methods render text live with baseline-based rollback |
| `client/src/scenes/GameScene.ts` | Wires `GameClient` stream handlers to the HUD methods |

### Shared

| File | Purpose |
|------|---------|
| `shared/types.ts` | `ServerWSMessage` discriminated union — streaming protocol message shapes |
