# AIDM Reference

The AI Dungeon Master (AIDM) is a Claude-powered narrative layer that runs alongside the game engine. It receives player messages in natural language, calls tools to enforce game-state changes, and returns 1–3 sentences of in-world narration. The game world — not the AIDM's text — is the source of truth: the AIDM may only narrate outcomes that a tool call has confirmed.

---

## How it works

```
Player message
     │
     ▼
 Build prompt (static system + current CURRENT STATE block)
     │
     ▼
 Claude (claude-sonnet-4-6, max 600 tokens)
     │
     ├─ tool_use ──► applyAIDMTool() ──► GameEngine ──► events + tool result
     │    └─ loop until stop_reason ≠ "tool_use"
     │
     └─ text block ──► narrative reply
```

Every exchange appends a `user`/`assistant` pair to the in-memory history so the model retains context across the encounter. On the first exchange the encounter introduction is seeded as an `assistant` message to establish narrative context.

### CURRENT STATE block

Every user message is prefixed with a `[CURRENT STATE]` block that the engine builds fresh from `GameState`. It includes:

- Map name, phase, and encounter types
- Player tile, HP, gold, inventory, equipped items, active flags
- All combatants (enemies and allies) with HP, tile, disposition, conditions
- Neutral NPCs with tile
- Active quests with progress
- Items on the ground and secrets remaining
- NPC personas
- The 15 most-recent combat log lines

The model uses this block to resolve pronouns ("them", "it") to concrete entity references.

---

## Personas

Two personas are available, selected per request via `dmPersona`.

| Persona | Behaviour |
|---------|-----------|
| `story` (default) | Immersive DM — 1–3 sentence in-world replies, full tool-first discipline, no breaking immersion. |
| `dev` | Development mode — fulfils all requests without restriction, replies with brief mechanical feedback only. |

---

## Entity references

Most tools that target a creature use a common entity reference format.

| Reference | Resolves to |
|-----------|-------------|
| `"player"` | The player character |
| `"enemy_A"` … `"enemy_Z"` | Enemy by combat label (A–Z, assigned at combat start) |
| `"ally_a"` … `"ally_z"` | Ally by combat label (a–z) |
| `"npc_[id]"` | Neutral or ally NPC by their runtime id (visible in CURRENT STATE) |

---

## Tool-first rule

Every game effect the AIDM describes must be enacted by the corresponding tool before narration. If no tool can enact the effect, the AIDM must not narrate it as happening and instead suggests a realistic in-world alternative. Text generated before a tool call is discarded — only the post-tool narrative is returned to the player.

---

## Tools

Tools are grouped below by function. All tools accept a `reason` parameter (string) that is logged server-side for debugging.

### HP and healing

#### `adjust_player_hp`
Adjusts the player's HP by a signed delta. Positive heals, negative damages. Clamped to `[0, maxHp]`. Temporary HP is consumed first when the delta is negative.

| Parameter | Type | Required |
|-----------|------|----------|
| `delta` | integer | yes |
| `reason` | string | yes |

#### `adjust_npc_hp`
Adjusts any combatant's HP. Positive heals, negative damages. When `damage_type` is supplied the engine automatically applies the target's resistance (half damage) or vulnerability (double damage) before clamping.

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `entity` | string | yes | Entity reference — see above |
| `delta` | integer | yes | Negative to damage, positive to heal |
| `damage_type` | string | no | e.g. `"fire"`, `"poison"`, `"piercing"` |
| `reason` | string | yes | |

Passing `"player"` as `entity` delegates to `adjust_player_hp` (including Temporary HP consumption).

#### `award_temp_hp`
Grants the player Temporary Hit Points. Temporary HP deplete before real HP and do not stack — the engine keeps whichever value is higher (existing or new). Temporary HP are lost on a Long Rest.

| Parameter | Type | Required |
|-----------|------|----------|
| `amount` | integer | yes |
| `reason` | string | yes |

---

### D20 tests

All three D20 test types are resolved server-side. The engine rolls, applies the relevant modifier and any condition modifiers, compares against DC, and returns the outcome to the model as a tool result. The model then narrates the in-world consequence — never the dice mechanic.

#### `request_ability_check`
Rolls `d20 + skill modifier` vs DC. Active conditions modify the roll automatically:

- **Disadvantage**: `poisoned`, `frightened`

Skill names match the player's `skills` map keys, e.g. `"perception"`, `"stealth"`, `"athletics"`.

| Parameter | Type | Required |
|-----------|------|----------|
| `skill` | string | yes |
| `dc` | integer | yes |
| `reason` | string | yes |

#### `request_saving_throw`
Rolls `d20 + saving throw modifier` vs DC. Active conditions modify the roll automatically:

- **Auto-fail** (no roll): `paralyzed` or `unconscious` on Str or Dex saves
- **Advantage**: `dodging` on Dex saves
- **Disadvantage**: `restrained` on Dex saves

Ability names: `"str"`, `"dex"`, `"con"`, `"int"`, `"wis"`, `"cha"`.

| Parameter | Type | Required |
|-----------|------|----------|
| `ability` | string | yes |
| `dc` | integer | yes |
| `reason` | string | yes |

#### `request_attack_roll`
Rolls an attack for the player or any NPC against a fixed AC. Use this for off-turn attacks (opportunity attacks), attacking objects (doors, barrels), or any attack outside the normal player-action flow.

- **Player**: uses `mainAttack` — stat modifier + proficiency bonus. Returns hit/crit/damage.
- **NPC**: uses the NPC's first attack entry. Returns hit/crit/damage.

The tool logs the roll to the Combat Log and returns the outcome string. It does **not** apply damage — call `adjust_npc_hp` separately if the hit should wound a specific creature.

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `attacker` | string | yes | `"player"` or entity reference |
| `target_ac` | integer | yes | AC to roll against |
| `reason` | string | yes | |

**DC difficulty guidelines** (SRD):

| Difficulty | DC |
|------------|-----|
| Very easy  | 5   |
| Easy       | 10  |
| Medium     | 15  |
| Hard       | 20  |
| Very hard  | 25  |

---

### Rewards

#### `award_xp`
Awards experience points to the player.

| Parameter | Type | Required |
|-----------|------|----------|
| `amount` | integer | yes |
| `reason` | string | yes |

#### `award_gold`
Awards gold pieces to the player.

| Parameter | Type | Required |
|-----------|------|----------|
| `amount` | integer | yes |
| `reason` | string | yes |

#### `grant_heroic_inspiration`
Grants the player Heroic Inspiration. The player may expend it to re-roll any one die immediately after rolling. Per SRD, only one instance can be held at a time — granting it when the player already has it has no additional effect.

| Parameter | Type | Required |
|-----------|------|----------|
| `reason` | string | yes |

#### `set_exhaustion_level`
Sets the player's Exhaustion level (0–5). Each level imposes −2 to all D20 Tests (ability checks and saving throws). Level 5 is lethal. Per SRD, a Long Rest removes one level.

| Parameter | Type | Required |
|-----------|------|----------|
| `level` | integer | yes |
| `reason` | string | yes |

---

### Inventory

#### `add_item`
Adds one item to the player's inventory.

| Parameter | Type | Required |
|-----------|------|----------|
| `item_id` | string | yes |
| `reason` | string | yes |

Valid `item_id` values: `health_potion`, `greatsword`, `shortsword`, `flail`, `longsword`, `rapier`, `dagger`, `javelin`, `shortbow`, `chain_mail`, `leather_armor`, `studded_leather`, `scale_mail`, `breastplate`, `splint_armor`, `plate_armor`, `shield`.

#### `remove_item`
Removes one instance of an item from the player's inventory.

| Parameter | Type | Required |
|-----------|------|----------|
| `item_id` | string | yes |
| `reason` | string | yes |

#### `throw_item`
Throws an item at a target, consuming an action if in `player_turn`. Proper thrown weapons (`javelin`, `dagger`) use their weapon stats and proficiency bonus. All other items are improvised weapons (1d4 bludgeoning, no proficiency bonus). The item is removed from the player's inventory or the map.

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `item_id` | string | yes | Inventory item id or map item `defId` |
| `target` | string | no | Entity reference; omit to auto-target nearest enemy in range |
| `reason` | string | yes | |

Attacking a neutral NPC with `throw_item` turns them hostile.

---

### Combat

#### `trigger_combat`
Starts combat when the phase is `exploring` and enemies are present on the map. Rolls initiative and transitions to `player_turn` or `enemy_turn`.

| Parameter | Type | Required |
|-----------|------|----------|
| `reason` | string | yes |

#### `end_combat`
Ends combat immediately — all enemies flee, surrender, or are removed. Transitions to `exploring`.

| Parameter | Type | Required |
|-----------|------|----------|
| `reason` | string | yes |

#### `spawn_enemy`
Spawns a new enemy near the player. In combat, the enemy is inserted into the turn order.

| Parameter | Type | Required |
|-----------|------|----------|
| `monster_id` | string | yes |
| `reason` | string | yes |

Valid `monster_id` values: `goblin_minion`, `bandit`, `commoner`, `skeleton`.

---

### NPCs and positioning

#### `despawn_npc`
Removes an NPC from the map. Does not award XP or gold.

| Parameter | Type | Required |
|-----------|------|----------|
| `entity` | string | yes | `"npc_[id]"` |
| `reason` | string | yes |

#### `set_disposition`
Changes a creature's disposition, which determines who they attack and how they are rendered.

| Disposition | Behaviour |
|-------------|-----------|
| `"ally"` | Fights alongside the player; included in turn order |
| `"neutral"` | Does not participate in combat |
| `"enemy"` | Fights the player; setting this also makes all same-faction neutrals hostile |

| Parameter | Type | Required |
|-----------|------|----------|
| `entity` | string | yes | Entity reference |
| `disposition` | string | yes | `"ally"`, `"neutral"`, or `"enemy"` |
| `reason` | string | yes |

#### `move_entity`
Teleports a creature to an exact tile coordinate. Bypasses movement rules and pathfinding.

| Parameter | Type | Required |
|-----------|------|----------|
| `entity` | string | yes | Entity reference |
| `tile_x` | integer | yes | |
| `tile_y` | integer | yes | |
| `reason` | string | yes |

---

### Conditions

#### `apply_condition`
Applies a condition to the player or any NPC.

| Parameter | Type | Required |
|-----------|------|----------|
| `entity` | string | yes | Entity reference |
| `condition` | string | yes | Condition name (see table below) |
| `reason` | string | yes |

#### `remove_condition`
Removes a condition from the player or any NPC.

| Parameter | Type | Required |
|-----------|------|----------|
| `entity` | string | yes | Entity reference |
| `condition` | string | yes | |
| `reason` | string | yes |

**Condition engine effects:**

| Condition | Engine effect |
|-----------|---------------|
| `blinded` | Attacker has Advantage against this creature; creature's own attacks at Disadvantage |
| `charmed` | No engine enforcement — narrative only |
| `dashing` | Cleared at start of next turn (set by Dash action) |
| `disengaged` | Movement does not provoke opportunity attacks; cleared at start of next turn |
| `dodging` | Advantage on Dex saves; enemy attacks against this creature at Disadvantage; cleared at start of next turn |
| `frightened` | Disadvantage on ability checks and attack rolls |
| `grappled` | Speed 0; own attack rolls at Disadvantage |
| `incapacitated` | Cannot take actions, bonus actions, or reactions |
| `invisible` | Creature's own attacks have Advantage; attackers targeting this creature have Disadvantage |
| `paralyzed` | Cannot act; attackers have Advantage; melee attacks are auto-crits; speed 0; auto-fail Str/Dex saves |
| `poisoned` | Disadvantage on attack rolls and ability checks |
| `prone` | Disadvantage on own attack rolls; attackers at range > 1 tile have Disadvantage; melee attackers within 1 tile have Advantage; costs half speed to stand |
| `restrained` | Speed 0; own attack rolls at Disadvantage; attackers have Advantage; Disadvantage on Dex saves |
| `slowed` | Speed reduced by 10 ft; cleared at start of next turn |
| `stunned` | Cannot act; attackers have Advantage; speed 0; auto-fail Str/Dex saves |
| `unconscious` | Cannot act; attackers have Advantage; melee attacks are auto-crits; speed 0; auto-fail Str/Dex saves; auto-applies prone |
| `vexed` | Own attack rolls at Disadvantage; cleared at start of next turn (applied by Vex/Sap weapon masteries) |

---

### Narrative

#### `add_log_entry`
Appends a line to the Combat Log without changing any game state. Use this to record notable events that do not correspond to a mechanical outcome.

| Parameter | Type | Required |
|-----------|------|----------|
| `text` | string | yes |

---

### Quests

#### `complete_quest`
Force-completes a quest and immediately awards its XP and GP rewards.

| Parameter | Type | Required |
|-----------|------|----------|
| `quest_id` | string | yes | Quest `id` from CURRENT STATE |
| `reason` | string | yes |

---

### Stealth

#### `set_player_hidden`
Sets the player's hidden status. When hidden, the player's next attack has Advantage and reveals their position.

| Parameter | Type | Required |
|-----------|------|----------|
| `hidden` | boolean | yes |
| `reason` | string | yes |

---

## Prohibited actions

The AIDM must reject the following and suggest a realistic in-world alternative instead:

- Using `add_item` or `spawn_enemy` because the player simply requested an item or creature — the thing must already exist in the world.
- Narrating teleportation, instantaneous object creation, or magic the player does not possess.
- Narrating any effect that was not confirmed by a tool result.

---

## Action economy

`throw_item` and any other action-consuming tool is enforced server-side during `player_turn`. If the tool result reports that the action was already spent, the AIDM narrates that the player cannot act again this turn and must end their turn or use a bonus action instead.

---

## Implementation files

| File | Purpose |
|------|---------|
| `server/src/aidm.ts` | Conversation loop — prompt construction, Claude API call, tool dispatch |
| `server/src/engine/AIDMTools.ts` | Tool schema definitions (`AIDM_TOOLS`) and `applyAIDMTool` switch |
| `server/src/engine/GameEngine.ts` | Engine methods called by `applyAIDMTool` |
| `server/src/engine/ConditionSystem.ts` | Condition constants and predicate functions |
| `server/src/engine/CombatSystem.ts` | Roll functions: `rollSkillCheck`, `rollSavingThrow` |
