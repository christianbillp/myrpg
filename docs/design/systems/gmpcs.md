# GMPCs — GM-controlled player characters (US-130)

> **Audience:** developers, AI agents · **Status:** implemented (seam · shell · turn loop · spawning · persistence · client · AIGM).

A **GMPC** is a full player character — class, spells with slots, class
features, leveling, inventory, fighting styles — that the GM controls and
roleplays instead of the human player. The challenge is that the engine is
deeply singular-player: ~1,900 references to `state.player` / `ctx.playerDef`
across the action registry, SpellSystem, FeatureRegistry, InventoryActions,
Resting, and the turn loop. Rewriting all of them to take an actor id would be
enormous and risky.

## Architecture: the active-actor seam

Instead of parameterizing every handler, GMPCs use **one indirection**: the
PC currently taking its turn is the *active actor*, and the engine binds its
state into the slots every handler already reads.

- **`ctx.playerDef` is a getter** (`GameEngine.buildCtx`) returning
  `this.activeDef` — the human's def by default, a GMPC's while bound.
- **`ctx.state.player` is physically swapped** to the GMPC's `PlayerState`
  for the duration of its turn, then restored.
- **`GameEngine.withActor(actorId, fn)`** performs the swap: stash the human's
  `state.player` + `activeDef` + `activeActorId`, bind the GMPC's, run `fn`,
  restore in a `finally`. A no-op for `'player'`.

Because every player-mechanics path reads whatever object is in `state.player`
and whatever `ctx.playerDef` returns, running a handler inside `withActor`
makes all ~1,900 references operate on the GMPC with **zero handler edits** —
attacks, leveled spellcasting (spending the GMPC's slots), class features
(the GMPC's resource pools), and resting all just work on the bound actor.

The swap is strictly server-side and turn-scoped: `state.player` is always
the human when a `state_update` is serialized to the client, so the wire model
is unchanged. GMPCs live in `GameState.gmpcs` and render via their shells (below).

## The on-map shell

The seam makes a GMPC *act*. To make it **targetable, take a turn-order slot,
and render**, each GMPC also gets an ally `NpcState` "shell" in `state.npcs`
(`gmpcId` set, `id === gmpc_<defId>`, `defId` = the `PlayerDef` id). The shell is
deliberately the same shape as any ally companion, so enemy targeting, damage,
pathing, and client rendering all work through existing ally machinery with **no
targeting-code changes** — the `'player'`-literal special-casing in
`NpcTurnRunners` is sidestepped entirely.

The shell is **not** an autonomous combatant: `advanceTurn` intercepts its id
before the NPC-AI branch, and the world-tick sim skips it (no `companion` /
`routine`). HP / position / conditions are kept in sync between the two
representations (`server/src/engine/Gmpc.ts`):

- **shell is canonical** while enemies act on the map (their damage / forced
  movement lands on `shell.hp` / `shell.tileX`).
- **`PlayerState` is canonical** while the GMPC acts (its turn, bound by `withActor`).
- `pullShellIntoActor` runs before the GMPC's turn and on every `getState()`
  serialisation (so the party UI + AIGM read fresh HP); `pushActorIntoShell`
  runs after the turn and after each `gmpc_act`.

**Human as obstacle.** While a GMPC is bound, `state.player` is the GMPC, so the
human would vanish from movement occupancy (a GMPC could path onto / stop on the
human's tile). `withActor` records the swapped-out player's tile in
`state.parkedActorTile`; `doMove` / `doMoveTo` (and the AI's `approachTile`) treat
it as occupied, cleared when the bind ends.

So enemies read the GMPC's **real AC and abilities** via a synthetic
`MonsterDef` shell stat block (`buildGmpcShellDef`, keyed by the `PlayerDef` id
in `gmpcShellDefs`, returned by `resolveMonsterDef`). The client resolves the
shell's PC token from the character roster by `defId`.

## Turn loop — deterministic combat AI

A GMPC rolls Initiative like any combatant (its shell is in `combatNpcs`, using
the synthetic def's dex-based `initiativeBonus`) and takes a slot in
`turnOrderIds`. When `CombatFlow.advanceTurn` reaches a GMPC id it resolves the
turn **deterministically and instantly** — no LLM — exactly like an NPC turn:
highlight the shell, log the turn header, call `engineRef.runGmpcTurn`, then
continue the loop to the next combatant. A downed GMPC (shell at 0 HP) is
skipped. (Speed was the motivation: routing every GMPC turn through the AIGM
made it a multi-round tool-use loop that lagged play.)

**`GameEngine.runGmpcCombatTurn`** binds the actor (`withActor`), resets its
per-turn economy + movement (`resetActorTurnEconomy`, seeded from the PC's own
speed), and runs **`gmpcTakeCombatTurn`** (`GmpcCombatAI.ts`), which drives the
*same* `PlayerAction` handlers the human uses via an injected `dispatch`:

1. target the **nearest living enemy**;
2. rank usable offensive options by rough expected damage — castable damage
   spells (`castableSpellIds` ∩ single-target damage spells: Magic Missile,
   Fire Bolt, save-spells; AoE/tile-aimed spells are skipped in v1) plus the
   weapon attack;
3. take the best option that's **in range with line of sight**; if none is, move
   toward the foe (`approachTile`) and re-check; otherwise it at least closed
   distance (falling back to **Dodge** when it has no offensive option at all).

So a GMPC spends its own spell slots (Magic Missile first, then Fire Bolt once
slots run dry) and weapon attacks, all through the real resolvers.

**Phase presentation.** The handlers (`doMoveTo`, `doAttack`, `doCastSpell`, …)
gate on `phase === 'player_turn'`. `runGmpcCombatTurn` presents the phase as
`player_turn` for the duration (the bound actor *is* the active turn-taker),
restoring afterward — unless the turn itself transitioned the phase (killing the
last enemy ends combat → `exploring`), in which case the new phase wins. The
manual `gmpcAct` path applies the same swap. Without it the GMPC couldn't move,
attack, or cast on its turn.

**Event retagging.** The handlers run on the swapped `state.player`, so they tag
animation events (`entity_move`, `attack`, `spell_vfx`, …) as `'player'`.
`runGmpcCombatTurn` (and `gmpcAct`) run `retagPlayerEventsToActor` over the
batch, rewriting those `'player'` ids to the GMPC's shell id — otherwise the
client animates the *human's* token. Safe as a batch: throughout the turn the
GMPC *is* `state.player`, so every `'player'` reference is the GMPC (including an
enemy's opportunity-attack against the moving GMPC).

**GM control still available.** The `gmpc_act` / `add_gmpc` AIGM tools remain for
the GM to spawn or manually puppet a GMPC (e.g. a scripted beat) — they route
through `gmpcAct` with the same phase-swap + retag. The *default* combat turn,
though, is the deterministic AI: instant, and it plays the PC's real kit.

## Data model

| Field | Where | Meaning |
|---|---|---|
| `GameState.gmpcs?: GmpcActor[]` | `shared/types/gameState.ts` | The party's GM-run PCs. |
| `GameState.activeActorId?` | same | `'player'` or `gmpc_<defId>` — whose turn it is for mechanics resolution. |
| `GmpcActor` | same | `{ id, defId, state: PlayerState, persona? }` — a full PC: its own HP, spell slots, resources, conditions, position. |
| `NpcState.gmpcId?` | `shared/types/npcState.ts` | Marks an `NpcState` as a GMPC's on-map shell (value = the GMPC id). |
| `CombatMode` `'gmpc_turn'` | `shared/types/gameState.ts` | The GM-driven turn phase. |
| `EncounterDef.gmpcIds?` | `shared/types/encounter.ts` | `PlayerDef` ids spawned as party GMPCs at session start. |

`GameEngine` clones + level-up-replays a `PlayerDef` per GMPC (`buildActorDef`),
exactly the pipeline the human's def goes through, applies its equipment, builds
the shell stat block, and ensures the shell exists — all in `registerGmpc`, run
at boot for each `state.gmpcs` entry and when one is added mid-session.

## Spawning & persistence

- **At session start** — `EncounterDef.gmpcIds` → `SessionBuilder` builds a
  fresh full-kit `PlayerState` per id (`buildGmpcPlayerState`, the non-resume
  mirror of the human seed) seated beside the player; the engine ctor builds
  their defs + shells.
- **Mid-session** — the **`add_gmpc`** AIGM tool → `GameEngine.addGmpc`: builds
  the PC, registers it, and (if a fight is underway) rolls Initiative and slots
  it into the order.
- **Save / load** — GMPCs persist via `GameState.gmpcs` in the world save; their
  shells are **stripped** from the saved `npcs` (`saveWorldState`) and rebuilt
  from the actors on load, so a reload never resurrects a stale duplicate.
  *(Cross-chapter GMPC carry-over and per-GMPC level-up history are not yet
  wired — a GMPC boots at its authored level each chapter.)*

## AIGM intelligence

`buildStateMessage` lists a **PARTY → GMPCs** section: each GMPC's id, class /
level, HP / AC / position, spell slots, prepared spells, class features, action
economy (when it's their turn), and persona — so the GM plays each one
competently and in voice. GMPC shells are excluded from the COMBATANTS list so
the GM references them only by their `gmpc_<defId>` id, never an `ally_X` label.

## GM control surface — `gmpc_act`

The GM drives a GMPC's mechanics through one AIGM tool, **`gmpc_act`**, and
roleplays its words through the existing `npc_speaks`. The tool takes a
`gmpc_id` and a `kind` (`attack` / `offhandAttack` / `castSpell` / `useFeature`
/ `moveTo` / `dodge` / `dash` / `disengage` / `hide` / `endTurn`) plus the
fields that kind needs (target, spell id + slot level, feature id, tile). Its
handler maps the payload to a `PlayerAction` (`gmpcActionFromInput`) and calls
**`GameEngine.gmpcAct(gmpcId, action)`**, which binds the actor with `withActor`
and dispatches through the *same* `dispatchPlayerAction` registry the human uses.
Because of the seam, the action spends the GMPC's own HP / slots / action economy
with zero handler edits. The tool result reports the GMPC's HP change and any
slot spent so the GM can narrate truthfully.

## What's proven (tests)

- `GmpcActorSeam.test.ts` — **Seam**: the real `doCastSpell` through a bound GMPC
  consumes **the GMPC's** spell slots while the human's pool is untouched.
  **Control surface**: a `castSpell` payload mapped by `gmpcActionFromInput` and
  run through the real `dispatchPlayerAction` registry spends the bound GMPC's
  slot and damages the target — exactly as `gmpcAct` drives it. The mapper's
  full vocabulary + rejection of incomplete payloads are unit-tested.
- `GmpcTurnLoop.test.ts` — **Builders**: `buildGmpcPlayerState` seeds a full-kit
  PC; `buildGmpcShellDef` exposes the PC's AC + dex initiative to enemy
  targeting; the shell carries the marker + `PlayerDef` id; shell ⇄ actor sync
  round-trips HP / position / conditions. **Turn loop**: `advanceTurn` enters the
  GM-driven `gmpc_turn` (no NPC AI) on a GMPC slot, refreshes its economy +
  movement, and **skips a downed GMPC** to the next live combatant.

## Demo

`demo_gmpc.json` — Tamsin Reed (Wizard) joins as a GM-controlled party member
against goblins on `the_dead_waystation`: she rolls Initiative, the GM resolves
her turn via `gmpc_act` (spending her own slots) and voices her with
`npc_speaks`, and the goblins target her shell.

## Files

| File | Role |
|---|---|
| `shared/types/gameState.ts` | `GmpcActor`, `GameState.gmpcs` / `activeActorId`, `CombatMode` `'gmpc_turn'`. |
| `shared/types/npcState.ts` | `NpcState.gmpcId` (the shell marker). |
| `shared/types/encounter.ts` · `session.ts` | `gmpcIds` on encounter + session request. |
| `server/src/engine/Gmpc.ts` | Builders (`buildGmpcPlayerState` / `buildGmpcShellDef` / `buildGmpcShell`), shell ⇄ actor sync, `resetActorTurnEconomy`, `retagPlayerEventsToActor`. |
| `server/src/engine/GmpcCombatAI.ts` | The deterministic combat AI (`gmpcTakeCombatTurn`): target + option ranking + approach. |
| `server/src/engine/GameEngine.ts` | `gmpcDefs` / `gmpcShellDefs`, `withActor` (+ sync), `registerGmpc`, `resolveMonsterDef` fallback, `getState` sync, `runGmpcCombatTurn`, `gmpcAct`, `addGmpc`, `getGmpcDef`, `isGmpc`. |
| `server/src/engine/CombatFlow.ts` | The `advanceTurn` GMPC intercept (deterministic turn); GMPC shells skip combat-label assignment. |
| `server/src/engine/SessionBuilder.ts` | Builds `state.gmpcs` from `gmpcIds`, seated near the player. |
| `server/src/engine/AIGMTools.ts` | `gmpc_act` + `add_gmpc` tools/handlers; `gmpcActionFromInput`. |
| `server/src/aigm.ts` | PARTY → GMPCs state-message section; GMPC shells excluded from COMBATANTS. |
| `server/src/persistence/saves.ts` | Strips GMPC shells from the saved `npcs` (rebuilt on load). |
| `client/src/scenes/GameScene.ts` | GMPC token resolution from the roster; `maybeDriveGmpcTurn` auto-drive. |
| `client/src/scenes/gameScene/aigmController.ts` | `driveGmpcTurn` — prompts the GM to resolve a GMPC turn. |
| `server/src/engine/GmpcActorSeam.test.ts` · `GmpcTurnLoop.test.ts` | Tests. |
