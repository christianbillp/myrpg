> **Audience:** developers, AI agents · **Status:** current · Detailed spec for first-class improvised-action resolution. The user-facing capability is US-121 in [../../product/requirements.md](../../product/requirements.md); the AIGM behaviour contract is in [../aigm.md](../aigm.md) and the tool catalog in [../aigm-tools.md](../aigm-tools.md).

# Improvised-Action Resolution

Any creative thing the player types — kicking a brazier onto an enemy, wedging a door shut, swinging from a beam — gets a fair ability check, a consistent DC, and a real consequence, not just narration. This generalizes the Study / Utilize / Magic / Influence feature-action pattern: the AIGM adjudicates *what* is being attempted, the engine owns everything that keeps the adjudication *fair*.

## Division of labour

| Concern | Owner |
|---|---|
| Plausibility gate, skill choice, difficulty band, narration | AIGM (prompt: IMPROVISED ACTIONS rule in `server/src/aigm.ts`) |
| Band → DC mapping, Action cost, the roll, the Event Log line | Engine (`server/src/engine/ImprovisedActionSystem.ts`) |
| Consequence application (damage, conditions, movement, flags…) | AIGM via the existing state tools, on **both** outcomes |

## The fairness contract

1. **The GM never picks a DC number.** The `resolve_improvised_action` tool takes a difficulty *band*; `DIFFICULTY_BAND_DC` maps it to the SRD typical DC:

   | Band | DC |
   |---|---|
   | `very_easy` | 5 |
   | `easy` | 10 |
   | `medium` | 15 |
   | `hard` | 20 |
   | `very_hard` | 25 |
   | `nearly_impossible` | 30 |

2. **Improvised actions cost the Action in combat.** During `player_turn` the resolver checks `canSpendAction` (`ActionGuards.ts`) and sets `actionUsed` *before* the roll — a failed stunt is still a spent turn, exactly like Study / Magic / Utilize. If the Action is unavailable the tool returns a `Not performed` result and no state changes; the AIGM refuses in-fiction. Outside combat the attempt is free.

3. **The roll routes through `GameEngine.rollAbilityCheck`**, so every active check modifier applies for free: condition Disadvantage (poisoned, frightened), exhaustion penalty, armor Stealth penalty, Influence attitude Advantage/Disadvantage (when `target_npc` is set), Enhance Ability, Guidance/check dice bonuses, Halfling Luck.

4. **The resolution is visible.** The Event Log gets a uniform line — `Improvised (athletics): "kick the brazier" — d20+mod = 17 vs DC 15 — Success!` — and the same roll is returned as a `rollResult` string, which the AIGM Overlay already renders. The structured session log records `check.improvised_action` with the description, band, DC, action spend, and outcome.

5. **Consequences are tool-enacted on both outcomes.** Success applies its effects through the existing state tools (`adjust_npc_hp`, `apply_condition`, `move_entity`, `set_world_flag`, …) per the TOOL-FIRST rule. Failure still moves the fiction — noise, attention, a worse position, a soured attitude — also via tools. A flat "nothing happens" failure is allowed only out of combat for zero-stakes attempts.

6. **Rulings stay consistent — engine-backed.** Every resolution is recorded as an `ImprovisedRuling` (`{ description, skill, difficulty, dc, success }`) on `GameState.improvisedRulings`, capped to the most recent 10 and persisted with the world save. `buildStateMessage` surfaces them as a **RECENT RULINGS** block, and the prompt rule requires the same task to keep its band across attempts; a retry after failure needs changed circumstances or escalates one band.

7. **A targeted creature gets to resist.** When the attempt imposes an effect *on* a creature (blinding sand, a shove, a trip), the prompt's classify step has the GM resolve the player's execution with `resolve_improvised_action` first, then — on success — give the target an SRD-fair save with `request_npc_saving_throw` (same band ladder) before applying the effect. The save rolls d20 + the creature's stat-block save modifier via `npcSaveMod` (Bane applies) and auto-fails Str/Dex saves for paralyzed/unconscious targets, mirroring the player save path.

## Relationship to `request_ability_check`

`request_ability_check` remains the tool for **informational** checks (perception sweeps, insight reads, recalling lore, corpse searching) and **social Influence** attempts — checks that change nothing physical and cost no Action. `resolve_improvised_action` is for declared attempts to **change the world physically**. The tool descriptions cross-reference each other so the AIGM routes correctly.

## Implementation files

| File | Purpose |
|---|---|
| `server/src/engine/ImprovisedActionSystem.ts` | `DIFFICULTY_BAND_DC`, `resolveImprovisedAction` — band → DC, Action spend, roll delegation, ruling record, Event Log line |
| `server/src/engine/GameEngine.ts` | `resolveImprovisedAction` delegation (binds `rollAbilityCheck`); `rollNpcSavingThrow` (stat-block save via `npcSaveMod`, Str/Dex auto-fail conditions) |
| `server/src/engine/AIGMTools.ts` | `resolve_improvised_action` + `request_npc_saving_throw` schemas + handlers (band/ability validation, result strings) |
| `server/src/aigm.ts` | IMPROVISED ACTIONS prompt rule; RECENT RULINGS block in `buildStateMessage` |
| `shared/types/gameState.ts` | `ImprovisedRuling` interface; `GameState.improvisedRulings` |
| `server/src/engine/SessionBuilder.ts` / `server/src/persistence/saves.ts` | Field init at session boot; world-save backfill on load |
| `server/data/settings/the_sundered_reach/encounters/demo_improvised_actions.json` | Demo encounter (props staged for improvisation; bandit escalation for combat testing) |
