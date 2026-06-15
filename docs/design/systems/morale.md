# Combat morale — flee & surrender

> **Audience:** developers, AI agents · **Status:** flee (existing) + surrender (new). First slice of the "Tactical Crucible" encounter-engagement set (idea #34).

Enemies no longer fight to 0 HP regardless of sense. Combat resolves more like a
real fight — fear, flight, and surrender — so victory becomes a *choice* (mercy
vs. execution, capture vs. kill) rather than pure attrition.

## Flee (pre-existing)

`NpcBrain.chooseNpcBehavior` scores `attack` / `hold` / `flee` from survival
(rises as HP drops, spikes < 25%), aggression (CR-scaled), and loyalty (living
same-disposition peers — a lone creature breaks more easily). When `flee` wins,
`runSingleEnemyTurn` moves the creature away via `fleeFromThreat`; reaching a map
edge removes it from the encounter ("escapes off the map edge — gone").

## Surrender (new)

At the **start of `runSingleEnemyTurn`, before** the attack/hold/flee decision,
a creature may **yield**. Checking up front (not only inside the flee branch) is
what prevents a hopeless-but-Dodging loop: a cornered, bloodied bandit usually
scores `hold` (Dodge), not `flee`, so a flee-gated surrender would never fire and
the fight could never resolve. `npcWouldYield(ctx, npc, def)` returns true when:

- **`npcCanYield`** — the creature is a *thinking* type (`Humanoid` or `Giant`).
  Mindless / instinct-driven types (Undead, Construct, Ooze, Beast, …) never
  yield; they fight to destruction. Also false once already `surrendered`.
- it is **bloodied** (`isBloodied`), and
- it is the **last enemy standing** (no other living `enemy`).

So a wounded last foe gives up rather than fight (or Dodge) a hopeless solo
battle to the death — which also resolves the encounter. Strong (un-bloodied)
last foes fight on.

`applyNpcSurrender` then neutralises the creature: `setIndividualRelation(npc,
player, 0)` + `reprojectDisposition` (so the neutral projection *sticks* and
isn't re-flipped to enemy), `combatPassive = true`, and a `surrendered`
condition marker. It logs "throws down their weapon and yields!", finalises the
turn, and `autoEndCombatIfNoEnemies` ends combat if no hostiles remain. The
prisoner is now a neutral non-combatant the GM can have the player spare,
capture, or interrogate — it won't act unless provoked.

The conditions are deliberately conservative (bloodied + last-standing) so
surrenders read as dramatic last-stand moments, not constant mid-fight quitting.

## Files

| File | Role |
|---|---|
| `server/src/engine/NpcBrain.ts` | `chooseNpcBehavior` / `scoreBehaviors` — the flee decision (pre-existing). |
| `server/src/engine/NpcTurnRunners.ts` | `npcCanYield`, `npcWouldYield`, `applyNpcSurrender`; the surrender branch in `runSingleEnemyTurn`. |
| `server/src/engine/MoraleSurrender.test.ts` | Tests for the yield predicate + surrender application. |
| `server/data/settings/the_sundered_reach/encounters/demo_morale.json` | Demo: bandits flee / yield, the skeleton fights to destruction. |

## Staged (rest of "Tactical Crucible")

Morale is slice 1; **reinforcements (#33)** is slice 2 — authorable from the
existing trigger system (`npc_killed` / `hp_threshold_crossed` / `turn_started`
→ `spawn_enemy_at`), demoed in `demo_reinforcements`, no new engine code. The
bundle's remaining ideas still to build: objectives beyond kill-all (#31),
interactive terrain & hazards (#32), distinct enemy roles (#35), Director
complications (#39), wandering threats (#28), run mutators (#29). See
`plans/narrative-feature-ideas.md`.

## Not yet

- **Leader-based morale** — a slain leader collapsing followers' morale.
- **Group rout** — coordinated multi-enemy breaks (today each scores
  independently, which already produces emergent routs as allies fall).
- **Surrender UI** — a dedicated client affordance for handling prisoners (today
  it's GM-narrated via the neutral + `surrendered` state and the Event Log).
