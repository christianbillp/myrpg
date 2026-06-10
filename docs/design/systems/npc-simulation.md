# NPC Simulation — the off-camera living world (US-094)

How NPCs behave when the camera isn't on them: daily routines, noise
awareness, off-camera NPC-vs-NPC resolution, walk-offs, and companions. The
runtime contracts live in `shared/types/npcState.ts`; the resolve loop is
`server/src/engine/WorldTick.ts` with decision logic in `NpcBrain.ts`.

## The world tick

During the `exploring` phase the server runs one **world tick ≈ one SRD round
(6 s of game time)** per real-time interval. Each tick (`runOffCameraTick`):

1. **Escalation check first** — if any living NPC considers the *party*
   hostile (relationship layer via `isHostileTo`), the tick escalates
   straight to turn-based combat (`doStartCombat`) instead of resolving
   anything off-camera. There is exactly one authoritative path for player
   combat: the initiative-tracked one. A faction flip made mid-exploration
   (AIGM tool, trigger) therefore auto-engages on the next tick.
2. **NPC-vs-NPC resolution** — otherwise every living NPC, in random order,
   picks its nearest hostile *non-player* target and runs one full turn
   (move up to speed + one attack) through the same `runEnemyTurn` math the
   combat loop uses. Bar brawls and predator/prey scenes resolve without the
   player.
3. **Departures** — NPCs flagged `leaving` (the `npc_leaves` trigger action)
   step up to 8 tiles toward the nearest map edge and are removed on
   arrival, emitting `entity_move` so the exit is visible.
4. **Companions** (`runCompanionTick`) — follow the player, or execute the
   active `CompanionState.override` command from the COMPANION chip
   (`CompanionCommand`: follow / hold / attack / move-to).

The world tick is pause-gated (`worldPaused` — overlays and cinematics
acquire the pause) and suspended entirely during turn-based combat.

## Alertness & memory

Each NPC carries an `alertness` level — `calm → suspicious → alert` — driven
by stimuli (sound rings from combat, spellcasting, loud actions; sight). The
non-calm levels decay back down after `ALERT_DECAY_TICKS` (alert ≈ 90 sim-
seconds → suspicious → calm). `NpcMemory` records the most recent stimulus
(`lastAlertKind`, `lastAlertTile`): an alerted NPC moves to investigate the
remembered tile, which is why "an NPC walking across the map is probably
heading toward its `lastAlertTile`" (the AIGM CURRENT STATE surfaces this in
the NPC ALERTNESS block so the GM can narrate posture changes).

## Routines

`NPCDef.routine` (a `RoutineEntry[]`) binds an NPC to positions by **day
phase**. The world clock advances `morning → noon → evening → night`
(`DAY_PHASE_CYCLE`, `TICKS_PER_DAY_PHASE = 60` ticks per phase); on a phase
change, routine-bound NPCs path to their entry for the new phase (the tavern
keeper moves behind the bar at noon, to the hearth at night). NPCs without a
routine hold position unless something else (alertness, hostility, leaving,
companionship) moves them.

## Interactions with the rest of the engine

- **Vision** — the passive-perception sweep on player movement is what
  reveals `hidden` NPCs (unless `revealedByTrigger`); hidden NPCs are also
  invisible to NPC AI targeting.
- **Triggers** — `move_npc`, `npc_leaves`, `set_npc_hidden`, and disposition
  flips compose with the sim: authored beats position NPCs, the sim animates
  the consequences.
- **Persistence** — sim state (`alertness`, `memory`, companion state, uses)
  lives on `NpcState` and rides the world save verbatim.

*Determinism note:* sim randomness routes through `SimRng` where
reproducibility matters; `Math.random()` is reserved for intentionally
surprising authored picks (`pick_random_value`).
