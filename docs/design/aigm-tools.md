> **Audience:** AI agents, developers · **Status:** current · Companion to [aigm.md](./aigm.md) — the catalog of tools the AIGM can call.

# AIGM — Tool Catalog

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

All D20 tests are resolved server-side. The engine rolls, applies the relevant modifier and any condition modifiers, compares against DC, and returns the outcome to the model as a tool result. The model then narrates the in-world consequence — never the dice mechanic.

#### `request_ability_check`

Rolls `d20 + skill modifier` vs DC, for **informational and social** attempts — perception sweeps, insight reads, recalling lore, searching, and Influence checks. The check itself changes nothing physical and costs no Action. For physical/creative attempts to change the world, use `resolve_improvised_action` instead. Active conditions modify the roll automatically:

- **Disadvantage**: `poisoned`, `frightened`

**Influence checks** (`deception`, `intimidation`, `performance`, `persuasion`, `animalHandling`) accept an optional `target_npc` parameter. When set, the server reads the target NPC's social **attitude** (US-092) and applies SRD modifiers: Friendly → Advantage, Hostile → Disadvantage, Indifferent → normal. The roll log and tool result include an attitude note (e.g. `[Friendly: Adv]`).

Skill names match the player's `skills` map keys, e.g. `"perception"`, `"stealth"`, `"athletics"`.

| Parameter    | Type    | Required | Notes                                                                                          |
| ------------ | ------- | -------- | ---------------------------------------------------------------------------------------------- |
| `skill`      | string  | yes      |                                                                                                |
| `dc`         | integer | yes      |                                                                                                |
| `target_npc` | string  | no       | Entity ref of the NPC the player is influencing. Triggers attitude-based Adv/Disadv (US-092). |
| `reason`     | string  | yes      |                                                                                                |

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

#### `resolve_improvised_action`

First-class resolution for a free-text player attempt to **change the world** that no button or dedicated tool covers — kicking a brazier onto an enemy, wedging a door shut, swinging from a beam. The model picks the skill and a difficulty **band**; the engine owns the fairness: it maps the band to the DC (table below), spends the player's Action during combat exactly like Study/Utilize (paid *before* the roll — a failed stunt is still a spent turn), rolls through the same path as `request_ability_check` (all condition/attitude/buff modifiers apply), and writes a uniform `Improvised (skill): "description" …` line to the Event Log. If the Action is unavailable the tool returns `Not performed` and no state changes — the model refuses in-fiction. After any result the model must enact the outcome with state tools before narrating, on failure too. Spec: [systems/improvised-actions.md](./systems/improvised-actions.md).

| Parameter     | Type   | Required | Notes                                                                                                  |
| ------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------ |
| `description` | string | yes      | Short paraphrase of the attempt; appears verbatim in the Event Log                                      |
| `skill`       | string | yes      | Same skill vocabulary as `request_ability_check`                                                        |
| `difficulty`  | string | yes      | `very_easy` \| `easy` \| `medium` \| `hard` \| `very_hard` \| `nearly_impossible` — engine maps to DC |
| `target_npc`  | string | no       | Entity ref when the attempt directly targets a creature (enables attitude modifiers)                    |
| `reason`      | string | yes      |                                                                                                        |

#### `request_npc_saving_throw`

Rolls a saving throw for an **NPC** against a difficulty band — the SRD-fair way to resolve an effect imposed *on* a creature (blinding sand, a shove, a toppled brazier) instead of applying it by fiat. The engine maps the band to the DC (same ladder as `resolve_improvised_action`) and rolls `d20 + the creature's stat-block save modifier` via `npcSaveMod` (Bane applies). Mirrors the player save path's condition rules: `paralyzed`/`unconscious` auto-fail Str and Dex saves. Typical target-resisted improvised attempt in combat: `resolve_improvised_action` for the player's execution first; on success, this tool for the target's resistance; then `apply_condition` / `adjust_npc_hp` / `move_entity` to enact the result.

| Parameter    | Type   | Required | Notes                                                                                                  |
| ------------ | ------ | -------- | ------------------------------------------------------------------------------------------------------ |
| `entity`     | string | yes      | `"enemy_A"` / `"ally_A"` (by combat label) or `"npc_[id]"`                                              |
| `ability`    | string | yes      | `"str"`, `"dex"`, `"con"`, `"int"`, `"wis"`, `"cha"`                                                   |
| `difficulty` | string | yes      | `very_easy` \| `easy` \| `medium` \| `hard` \| `very_hard` \| `nearly_impossible` — engine maps to DC |
| `reason`     | string | yes      |                                                                                                        |

**DC difficulty guidelines** (SRD):

| Difficulty | DC  |
| ---------- | --- |
| Very easy  | 5   |
| Easy       | 10  |
| Medium     | 15  |
| Hard       | 20  |
| Very hard  | 25  |
| Nearly impossible | 30 |

For `resolve_improvised_action` and `request_npc_saving_throw` the model passes the band name and the engine applies this table; for `request_ability_check`, `request_saving_throw`, and `request_attack_roll` the model passes the DC/AC directly.

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

> **Note.** `GameEngine.createSession` auto-calls `triggerCombat()` at session start whenever any spawned NPC is hostile to the party (`isHostileTo` — matrix-first, legacy `disposition: 'enemy'` fallback), so combat encounters (hand-authored with hostile spawns, AI-generated `simple_combat`, or deterministic-compose with `enemyIds`) land the player directly in combat without the GM having to call this tool on its first reply. The off-camera world tick performs the same check every six seconds in exploration phase — `set_disposition` → `enemy` or `adjust_faction_relation` to a hostile value will auto-engage on the next tick if the GM forgets to call `trigger_combat`, but the GM should still call it explicitly for snappy timing; see the **Creature disposition change** rule in the GM constraints.

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

Changes a creature's **combat** disposition — who they attack in combat and how they are rendered on the map. **Distinct from attitude** (see `set_attitude` below): disposition is the combat axis ("does this creature fight me?"), attitude is the social axis ("how does this creature feel about me?"). The two are orthogonal — change one without the other.

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

#### `set_attitude`

Changes a creature's **social** attitude toward the party (US-092). Drives Advantage/Disadvantage on Influence-type ability checks (Deception, Intimidation, Performance, Persuasion, Animal Handling). **Does not start combat or change disposition** — a hostile-attitude shopkeeper can still be a neutral-disposition NPC who refuses to fight but resists persuasion. Use after a successful Persuasion to shift Indifferent → Friendly, after a botched bribe to shift Indifferent → Hostile, or to track narrative relationship changes that don't yet warrant combat. Charm Person auto-sets attitude to `friendly` while charmed and restores the pre-cast value when the condition ends.

| Attitude        | Effect on Influence checks (US-057) |
| --------------- | ----------------------------------- |
| `"friendly"`    | Advantage on the player's roll      |
| `"indifferent"` | Normal roll (SRD default)           |
| `"hostile"`     | Disadvantage on the player's roll   |

| Parameter   | Type   | Required | Notes                                          |
| ----------- | ------ | -------- | ---------------------------------------------- |
| `entity`    | string | yes      | Entity reference                               |
| `attitude`  | string | yes      | `"friendly"`, `"indifferent"`, or `"hostile"` |
| `reason`    | string | yes      |                                                |

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

#### `npc_speaks`

Renders a short speech bubble above the named entity's token for ~6 seconds and fades out. Use whenever an NPC speaks aloud, shouts, or makes an audible sound the player should be able to source visually — call alongside the narrative quote (the bubble is supplemental, the prose stays the same). Also valid for environmental sounds anchored to a creature (e.g. growls, sobbing). The `entity` field accepts the same refs as the rest of the tool surface (`player`, `enemy_A`, `npc_<id>`).

| Parameter | Type   | Required |
| --------- | ------ | -------- |
| `entity`  | string | yes      |
| `text`    | string | yes      |

#### `fade_screen`

Fade the entire game screen (map + every UI panel) to or from black. Three modes:

  - **`"out"`** — opacity → 1 (full black). Blocks input.
  - **`"in"`** — opacity → 0 (fully clear). Restores input.
  - **`"dim"`** — opacity → 0.5 (50% black overlay). The world stays visible underneath and pointer input still passes through — use for atmospheric beats, not full cinematic cuts.

Use for cinematic scene transitions — time-jumps, travel montages, dramatic reveals — and combine with `show_supertitle` / `show_announcement` so the message lands against the black (or the dim) between fades.

The fade is **sticky**: an `"out"` or `"dim"` call leaves the overlay in place until a matching `"in"` call (or the next chapter advance / long rest, which manage their own fades). Events from a single tool-loop iteration play sequentially through the client's event queue, so a typical cinematic transition queues `fade_screen out → show_supertitle → show_announcement → fade_screen in` and the supertitle / announcement all render against the darkened background.

| Parameter     | Type    | Required |
| ------------- | ------- | -------- |
| `mode`        | string  | yes (`"in"`, `"out"`, or `"dim"`) |
| `duration_ms` | integer | no (default 1200, max 10000) |
| `reason`      | string  | yes      |

#### `show_supertitle`

Display a movie-style location title — huge bold white text centred on screen for a few seconds, wrapping onto two lines for longer titles. Use sparingly for significant location or time changes ("THE TANGLED WOOD", "THREE DAYS LATER", chapter-style cards). Pair with `fade_screen` for dramatic reveals.

`duration_ms` controls the hold time; the client adds its own fade-in and fade-out on top. The event blocks the client's event queue for the full duration so subsequent events queue after it cleanly.

| Parameter     | Type    | Required |
| ------------- | ------- | -------- |
| `text`        | string  | yes      |
| `duration_ms` | integer | no (default 3000, max 15000) |
| `reason`      | string  | yes      |

#### `show_announcement`

Display a large centred announcement card. The text is **also** appended to the Event Log so the message persists after the visual fades. Use `add_log_entry` for routine log lines that do not need an attention-grabbing card.

`mode` controls how the announcement integrates with play:

  - **`"focused"`** (default) — orange-bordered card; the Player Panel, Target Panel, and HUD **fade out before** the card appears and **fade back in after** it leaves; player movement / actions are locked; the world tick is paused via `WorldPause`. Use for important beats the player MUST stop and read (quest reveal, major discovery, end-of-encounter close).
  - **`"unfocused"`** — borderless card with a soft radial edge-fade; the UI stays live, the world keeps ticking, the player keeps moving. Use for atmospheric flavour the player can read in stride (weather shift, distant sound, time-of-day cue).

| Parameter     | Type    | Required |
| ------------- | ------- | -------- |
| `text`        | string  | yes      |
| `duration_ms` | integer | no (default 3500, max 15000) |
| `mode`        | string  | no (`"focused"` (default) or `"unfocused"`) |
| `reason`      | string  | yes      |

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

#### `set_individual_relation`

Set how one **individual** regards another to an absolute value (clamped ±100) — the override layer in front of faction relations. Use when a specific creature feels differently from its faction: a bandit loyal to a particular guard (+80) despite the bandits/guards feud, or a soldier who betrays his own captain (−100). Negative makes them fight; positive makes them allies. Reprojects combat disposition immediately.

| Parameter | Type    | Required | Notes                                                                       |
| --------- | ------- | -------- | --------------------------------------------------------------------------- |
| `a`       | string  | yes      | First individual id — an NPC id, or `"player"`.                             |
| `b`       | string  | yes      | Second individual id — an NPC id, or `"player"`.                           |
| `value`   | integer | yes      | Absolute relationship in [−100, +100].                                       |
| `mirror`  | boolean | no       | Default `true` (set both directions). `false` for a one-sided link.         |
| `reason`  | string  | yes      |                                                                             |

#### `adjust_individual_relation`

Shift how individual `a` regards individual `b` by `delta`, resolving the current effective value (individual override → faction baseline) first. Use for incremental personal shifts; use `set_individual_relation` for hard resets.

| Parameter | Type    | Required | Notes                                              |
| --------- | ------- | -------- | -------------------------------------------------- |
| `a`       | string  | yes      | First individual id — an NPC id, or `"player"`.    |
| `b`       | string  | yes      | Second individual id — an NPC id, or `"player"`.   |
| `delta`   | integer | yes      | Signed shift, result clamped to [−100, +100].      |
| `mirror`  | boolean | no       | Default `true`.                                    |
| `reason`  | string  | yes      |                                                    |

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

### Quests & objectives

Quests are **structured** — an ordered list of steps, each with a player-facing objective line. The player's OBJECTIVE line and the Quest Log show the active quest's current step. Active quests appear in CURRENT STATE under **ACTIVE QUESTS** with their `id`, current step id/text, and the full step list — use those ids with the tools below. Authored quests (`quest_id`) may auto-advance via their own conditions; calling these tools is still safe. Authored quests may also carry **optional bonus steps** (marked optional in their def) that the engine completes on its own, in any order, when their conditions hold — do **not** `advance_quest` toward those; just narrate the discovery when it lands. **Quests grant XP only** — never promise gold or items through a quest; hand tangible rewards over in the world/dialogue (a paymaster, a body, a chest) so the fiction stays intact.

#### `set_objective`

Replace the player-facing OBJECTIVE line. Use for one-off direction or when there is no active quest. If a quest is active, its current step drives the objective — prefer `advance_quest` for quest progress.

| Parameter | Type   | Required |
| --------- | ------ | -------- |
| `text`    | string | yes      |
| `reason`  | string | yes      |

#### `start_quest`

Start a quest and show it in the Quest Log. Either reference an authored quest by `quest_id`, **or** create one on the fly with `title`, `description`, and ordered `steps`. You drive a runtime quest: call `advance_quest` as steps are accomplished, then `complete_quest` / `fail_quest`.

| Parameter     | Type     | Required | Notes                                                                 |
| ------------- | -------- | -------- | --------------------------------------------------------------------- |
| `quest_id`    | string   | no       | Authored quest id. Omit to create a runtime quest.                    |
| `title`       | string   | no\*     | Runtime quest title (\*required when no `quest_id`).                  |
| `description` | string   | no       | One or two sentences.                                                 |
| `steps`       | string[] | no\*     | Ordered short objective lines (\*required when no `quest_id`).        |
| `xp`          | integer  | no       | XP granted on completion. **XP only — no gold/items.**                |
| `scope`       | string   | no       | `"world"` (default), `"adventure"`, or `"encounter"`.                 |
| `reason`      | string   | yes      |                                                                       |

#### `advance_quest`

Mark the current step of an active quest done and move to the next — or finish the quest if it was the last step. Optionally jump straight to a specific `step_id`.

| Parameter  | Type   | Required | Notes                                |
| ---------- | ------ | -------- | ------------------------------------ |
| `quest_id` | string | yes      | From ACTIVE QUESTS in CURRENT STATE. |
| `step_id`  | string | no       | Jump straight to this step.          |
| `reason`   | string | yes      |                                      |

#### `complete_quest`

Finish an active quest immediately on a narrative resolution. Grants the quest's completion XP (XP only).

| Parameter  | Type   | Required |
| ---------- | ------ | -------- |
| `quest_id` | string | yes      |
| `reason`   | string | yes      |

#### `fail_quest`

Mark an active quest failed — the player blew it, betrayed the giver, or a deadline passed. No XP.

| Parameter  | Type   | Required |
| ---------- | ------ | -------- |
| `quest_id` | string | yes      |
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

