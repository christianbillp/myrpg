# Animation Timeline — ordered combat beats

How a resolved action becomes a readable on-screen sequence. The event stream
is the **authoritative ordered timeline** of every visible beat; the final
`GameState` is the correctness/resume source of truth, reached beat-by-beat
rather than snapped.

## Pipeline

1. **Server resolves synchronously.** A player action (or, on End Turn, *all*
   NPC turns via the recursive `advanceTurn`) runs to completion and returns
   **(a) the final `GameState`** and **(b) a flat, ordered `GameEvent[]`**
   (`GameEngine.processAction`; route `POST /game/session/:id/action`).
   Because resolution is synchronous, array order IS the sequence — no
   sequence ids are needed.
2. **Beats are emitted at the resolution site**, never reconstructed from a
   state diff (a diff loses the order). Engine-internal facts publish through
   the `EventBus`; `PresentationHooks` projects them into client beats.
3. **The client plays the timeline** (`GameScene.handleStateUpdate` queues
   every beat; `processNextEvent` drains one at a time behind the `animating`
   gate), **applying the matching state slice at each beat** — the HP bar
   drops at the `damage` beat, the token fades at the `death` beat.
   `applyState` runs once at queue-drain as the idempotent drift-correcting
   safety net, and the event-log reveal is clipped to the animation
   (`hudLogClip`) so text never precedes its visual.

## Beat vocabulary (`shared/types/animation.ts`)

| Beat | Visual |
|---|---|
| `entity_move` | per-tile tween (`MOVE_DURATION`, speed-scaled) |
| `attack` | attacker lunge toward the target |
| `damage` / `heal` | floating number + HP-bar change + hit-flash at the beat |
| `death` | token fade; tile freed |
| `condition_changed` | floating gold `+condition` / grey `−condition` label with a short dwell |
| `turn_started` / `turn_ended` | Turn Order chip highlight driven by the beat (not the final state) + a short breath between combatants |
| `spell_vfx` | data-driven cast visual from `SpellDef.vfx` (projectile / beam / burst / glow), played before its damage/heal beats |
| `npc_speech` | speech bubble + GM-chat line; **holds the queue for a reading dwell** (`speechReadMs`, ~32 ms/char clamped 1.6–4.5 s) so multi-line beats play one bubble at a time |
| `play_sound` / `sound_ring` | fired at their queue position so audio lands on its beat |
| `screen_fade` / `supertitle` / `announcement` | cinematic layer; block with authored `durationMs` |

## Movement model

All *driven* movement animates from `entity_move` (combat steps, `npc_leaves`
departures, `move_npc` walk paths). State-reconcile corrections **glide**
(`Player.glideTo` / `NpcToken.glideTo`: distance-aware, 90 ms/tile capped at
420 ms, used for offsets ≤ 6 tiles) so nothing visibly teleports; longer
jumps (resume, chapter transitions) snap deliberately.

## Combat Speed

`client/src/animationSpeed.ts` — a global 1×/1.5×/2×/3× multiplier
(localStorage `combatSpeed`, set from the Panel Setup Overlay's Configuration
card). `scaleDuration` scales every combat-timeline duration — move tweens,
speech dwells, turn breaths, condition dwells — with a 40 ms floor so tweens
never read as teleports. **Cinematic story beats keep their authored
pacing** — speeding those up would cheapen narrative moments, not combat.

## Principles

- **Emit at the resolution site, in resolution order.** Never rebuild beats
  from a state diff.
- **Blocking is earned.** Only genuinely sequential beats hold the queue
  (moves, attacks, deaths, speech); dwell-style holds (speech, turn breath,
  condition label) release immediately when nothing waits behind them.
- **The snap path stays.** On load or any response without an event stream
  the client snaps to the final state — events are the rendering timeline,
  the state is the truth.

## Remaining polish (tracked in `plans/pending-work.md`)

Reaction-pause refinement (`pendingReaction` splits a turn's beats across two
responses) and the sound/VFX polish tail (per-spell palette tuning,
distance-aware projectile durations, per-style SFX cues, bespoke
teleport/illusion treatments).
