# Run mutators

> **Audience:** developers, encounter authors, AI agents · **Status:** shipped (enemy-HP · incoming-damage). Tactical Crucible #29.

**Opt-in challenge knobs** that re-tune an entire encounter without touching its
content — the same roster plays differently under "Tougher Foes" or "Deadly".
Stackable, so a run can be self-set to any difficulty. Declared on
`EncounterDef.mutators`, carried on `GameState.mutators`, and read by exactly one
resolver each so they compose cleanly.

## Knobs (`RunMutators`)

| Knob | Effect | Applied in |
|---|---|---|
| `enemyHpMult` | every **enemy** spawns at this fraction of its HP (`1.5` = +50% — "Tougher Foes") | `SessionBuilder`, right after `populateNpcs` |
| `incomingDamageMult` | all damage the **player takes** is scaled (`1.5` = "Deadly") | top of `GameEngine.applyDamageToPlayer` |

Omitted / `1` / `0` (or negative) means "no change". Both run through
`RunMutators.scaledEnemyHp` / `scaledIncomingDamage` — the pure math lives there
so the knobs are trivially testable and centralised rather than scattered as
inline arithmetic.

`enemyHpMult` rides on top of whatever the stat block + placement produced (and
stacks above any future per-spawn scaling); `incomingDamageMult` is applied
**before** resistance / temp-HP / the concentration save, so the harsher number
flows through the entire normal damage pipeline (logs, thresholds, death saves).

## Authoring

```json
"mutators": { "enemyHpMult": 1.25, "incomingDamageMult": 1.25 }
```

Mutators persist on the world save (`GameState` round-trips them), so a resumed
run keeps its difficulty. They are **encounter-scoped** today — set per encounter
JSON; there is no campaign-wide / player-chosen toggle yet.

## Files

| File | Role |
|---|---|
| `shared/types/encounter.ts` | `RunMutators`; `EncounterDef.mutators`. |
| `shared/types/gameState.ts` · `session.ts` | `GameState.mutators`; `CreateSessionRequest.mutators`. |
| `server/src/engine/RunMutators.ts` | `scaledEnemyHp`, `scaledIncomingDamage` (pure). |
| `server/src/engine/SessionBuilder.ts` | seeds `GameState.mutators`; applies `enemyHpMult` at spawn. |
| `server/src/engine/GameEngine.ts` | applies `incomingDamageMult` in `applyDamageToPlayer`. |
| `server/src/index.ts` | threads `encDef.mutators` into the session request. |
| `server/src/engine/RunMutators.test.ts` | Tests. |
| `server/data/.../encounters/demo_directors_cut.json` | Demo (a mutated run). |

## Not yet (staged)

- **More knobs** — scarce light/resources, a relentless "hunted" pursuer, ironman
  no-reload. The type is built to extend: add a field + one resolver hook.
- **Player-chosen mutators** — a run-setup screen that stacks toggles, instead of
  per-encounter JSON only. Needs a campaign-level settings layer.
