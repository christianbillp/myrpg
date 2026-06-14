# Ambient NPC-to-NPC Conversations (US-129)

> **Audience:** developers, AI agents · **Status:** current.

Idle NPCs talk *to each other* while the player explores — gossip, small talk,
bickering — so a tavern or a guard post feels inhabited rather than frozen
until the player speaks. Pure flavour: no choices, no checks, no mechanical
effect. It rides systems that already exist; almost nothing here is new
machinery.

## Where it runs

The world tick (`WorldTick.runOffCameraTick`) already fires once per ~6 s,
**exploration only** (combat and world-pause freeze it upstream), and is
deterministic via `SimRng.forNpcTick(tickId, npcId)`. Banter is one more pass
inside `runSimNpcTicks`, after each NPC's individual sim decision:

```
runSimNpcTicks → (per-NPC: companion / routine / alerted) → runAmbientConversations(ctx, tickId, events)
```

`runAmbientConversations` (`server/src/engine/npcSim/Banter.ts`) does two things
per tick:

1. **Advance** every in-flight exchange one line, dropping any whose speakers
   are no longer eligible.
2. With a small chance (`START_CHANCE`), **start** one new exchange between two
   eligible NPCs the player can witness.

Determinism: every random choice draws from `SimRng.forNpcTick(tickId, 'banter')`
— never `Math.random`. Same world state + tick id → same banter.

## Banter packs (data)

`server/data/settings/<setting>/banter/*.json`, loaded into `GameDefs.banter`.
A **pack** is a set of short **exchanges** (2–4 lines) with selection filters:

| Field | Meaning |
|---|---|
| `relation` | Required pair relation — `friendly` / `neutral` / `hostile` (resolved via `viewStance`). Friendly → gossip/jokes; neutral → small talk; hostile (but not fighting) → barbed rivalry. |
| `sameFaction?` | Both speakers must share a faction. |
| `faction?` | At least one speaker must belong to this faction id. |
| `dayPhases?` | Restrict to these day phases (`["evening","night"]`). |
| `exchanges[]` | Each is `{ lines: [{ speaker: 'a' | 'b', text }] }`. `a` is the initiator, `b` the partner. Text supports `{a}` / `{b}` name placeholders. |

(A `tags`/biome selector was considered but cut from v1 — encounter tags aren't
threaded onto `GameState`, and shipping a dead selector was worse than omitting
it. `relation` + `faction` + `dayPhases` give ample selection power.)

## Eligibility & witness gating

An NPC may banter when it's **alive, `calm`, not hidden/incapacitated, and not a
companion mid-command**. A pair must be within `CHAT_RADIUS_TILES` (3) with
mutual line of sight (`Vision.canSee`). Crucially, an exchange only **starts**
when the **player witnesses** a speaker — within `EARSHOT_TILES` (8) and visible
— so off-screen NPCs never spam the Event Log with chatter the player can't
perceive. A per-NPC `COOLDOWN_TICKS` (12) gap keeps the same pair from looping.

## Lifecycle & interruption

An in-flight exchange (`GameState.ambientChats`) ends immediately when a speaker
is gone, no longer calm, separated beyond chat radius, or no longer witnessed —
and naturally when the lines run out (both speakers then enter cooldown). Banter
never blocks anything: combat starting freezes the whole tick, which drops the
chat on its own.

## Surfacing

Each line emits through the **same channel directed speech uses** — a
`npc_speech` GameEvent (client speech bubble) plus an Event Log entry — but with
the dimmed **`ambient`** log style (muted lavender) so it reads as background.
The last few lines are kept on `GameState.recentAmbientLines` and surfaced to
the AIGM as an `OVERHEARD` block in `buildStateMessage`, so the GM can answer
"what were those two saying?" and weave it in. (A richer tier — the GM extending
an exchange with `npc_speaks` when the player lingers — is left open; the
authored data path is primary and needs no per-tick LLM call.)

## Files

| File | Role |
|---|---|
| `server/src/engine/npcSim/Banter.ts` | The runner: advance + start, eligibility, witness gating, selection, emission. |
| `shared/types/banter.ts` | `BanterPack`, `BanterExchange`, `BanterLine`, `ActiveBanter`. |
| `server/data/settings/the_sundered_reach/banter/*.json` | Starter packs (bandit grumble/barbed, Bureau shop-talk, villager rumor, generic small talk). |
| `shared/types/gameState.ts` | `ambientChats`, `ambientChatCooldowns`, `recentAmbientLines`. |
| `server/src/aigm.ts` | `OVERHEARD` block in `buildStateMessage`. |
| `client/src/ui/HUD.ts` | `ambient` log style colour. |
| `server/src/engine/npcSim/Banter.test.ts` | Determinism, selection, witness/alert gating, advancement, interruption. |
