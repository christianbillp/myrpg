# Encounter objectives, reinforcements & twists

> **Audience:** developers, encounter authors, AI agents · **Status:** shipped. "Tactical Crucible" ideas #31 (objectives) + #33 (reinforcements) + #39 (mid-fight complications).

Encounters can declare **win and lose conditions beyond "kill everything"** —
protect an escort, hold/survive N rounds, reach an exit, seize/destroy an
object, defeat a specific target — escalate with **reinforcements**, and throw a
**random mid-fight twist** that differs each playthrough. All are authored from
the **trigger system**; the engine provides the primitives below.

## Primitives

- **`completeOnFlagOnly`** (`EncounterDef`) — when true, clearing all enemies
  does NOT complete the encounter; only the `completionFlag` being set does. The
  combat-clear auto-complete is suppressed, so victory is whatever your triggers
  decide. Seeds `GameState.encounterCompleteOnFlagOnly`.
- **`combat_round` event** — published at the top of each combat round (1-based;
  `GameState.combatRound`, bumped when `advanceTurn` wraps to the top of the
  initiative order). Trigger WHEN: `{ event: 'combat_round', round?, atLeast? }`
  — `round` matches one round exactly, `atLeast` fires every round from N on,
  both omitted fires every round. For survive/hold timers and timed waves.
- **`fail_encounter` action** — `{ type: 'fail_encounter', reason? }` ends the
  encounter in **defeat** (sets the `defeat` phase). For objective losses
  distinct from the player dying (the escort died, the timer ran out).
- **`random_action` action** (#39 — mid-fight complications) — `{ type:
  'random_action', choices: TriggerAction[][] }` picks ONE of the `choices`
  action-sets at random and runs it through the normal `fireAction` path. Pair
  with a `combat_round` (or any) WHEN to drop a **Director twist** that turns the
  scene differently each run — reinforcements vs. a spreading fire vs. a fresh
  monster — without authoring three separate encounters. Each choice is a list of
  actions, run in order; an empty `choices` no-ops.

## Authoring recipes

| Objective | How |
|---|---|
| **Defeat a target** (not all enemies) | `completeOnFlagOnly: true` + `when: npc_killed defId: <boss>` → `set_flag <completionFlag>`. |
| **Reach / seize / destroy** | `completeOnFlagOnly: true` + `when: player_moved in_area` / `study_feature` / `item_picked_up` → `set_flag <completionFlag>`. |
| **Survive / hold N rounds** | `completeOnFlagOnly: true` + `when: combat_round atLeast: N, once` → `set_flag <completionFlag>`. |
| **Protect an escort** | ally in `allyIds`; `when: npc_killed defId: <escort>` → `fail_encounter`. |
| **Defeat timer** | `when: combat_round round: N` → `fail_encounter` (lose if not done by round N). |
| **Reinforcements / waves** (#33) | `when: combat_round round: N` (or `npc_killed` / `hp_threshold_crossed`) → `spawn_enemy_at` / `spawn_enemy_near_player`. |
| **Random twist** (#39) | `when: combat_round round: N, once` → `random_action` with each twist as a `choices` entry (a wave, a `spawn_hazard`, a fresh foe). |

These compose with engine **morale** (#34): routed minions flee or surrender
while the objective target is what matters.

> **Timer caveat.** A pure survive-timer with fully killable enemies can end
> early: if the player wipes every enemy mid-round, the top-of-`advanceTurn`
> "no enemies left" check ends combat before the next `combat_round` fires. Keep
> at least one enemy present across the timer (per-round waves), or pair the
> timer with a non-kill goal — the `demo_objectives` recipe (defeat-target +
> protect + a round-3 wave) sidesteps it.

## Files

| File | Role |
|---|---|
| `shared/types/engineEvents.ts` | `combat_round` event. |
| `shared/types/triggers.ts` | `combat_round` WHEN clause; `fail_encounter` + `random_action` actions. |
| `shared/types/encounter.ts` · `gameState.ts` | `completeOnFlagOnly`; `GameState.combatRound`. |
| `server/src/engine/CombatFlow.ts` | Round counter bump + `combat_round` publish in `advanceTurn`; reset in `doStartCombat`. |
| `server/src/engine/TriggerSystem.ts` | `combat_round` matching; `fail_encounter` + `random_action` handlers. |
| `client/src/scenes/EncounterSetupScene.ts` · `GameScene.ts` | Forward `completeOnFlagOnly` through the picker / reload paths. |
| `server/src/engine/ObjectivesPrimitives.test.ts` · `RandomActionTrigger.test.ts` | Tests for the round counter/event, matching, `fail_encounter`, and `random_action`. |
| `server/data/.../encounters/demo_objectives.json` · `demo_reinforcements.json` · `demo_directors_cut.json` | Demos. |

## Not yet (staged)

- **First-class objective UI** — a HUD objective tracker with live progress
  ("Round 3/5", "Scout: alive"). Today the goal shows via the `objective` string
  + Event Log; win/lose resolve through triggers.
- **Structured objective schema** — a declarative `objectives: [...]` block that
  auto-wires the common recipes above instead of hand-authored triggers.
