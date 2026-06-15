# In-combat barks

> **Audience:** developers, content authors, AI agents · **Status:** shipped.

Short, flavorful one-liners NPCs call out **during a fight** — tied to what they
*do* (attack, flee, surrender) and to impactful *moments* (taking damage, being
bloodied, dying). The combat cousin of ambient banter (US-129): same
`npc_speech` speech-bubble + Event Log channel, but fired by combat events
instead of the world tick, and single lines rather than NPC-to-NPC exchanges.
Pure flavour — no mechanical effect.

## Data — bark packs

`server/data/settings/<setting>/barks/*.json` → `GameDefs.combatBarks`. Each
`CombatBarkPack` is a pool of interchangeable lines for one `trigger`, optionally
scoped by selectors (AND-combined; absent = unconstrained):

```json
{ "id": "bandit_attack", "trigger": "attack", "factions": ["bandits"],
  "lines": ["This'll cost you!", "Hold still, will you?"] }
```

- **`trigger`**: `attack` · `damaged` · `bloodied` · `death` · `flee` · `surrender`.
- **selectors**: `factions` (NPC's `factionId`), `defIds` (NPC's `defId`),
  `types` (substring of `MonsterDef.type`, e.g. `"undead"`). A pack with no
  selectors is a generic fallback.

Shipped packs: `bandits.json` (taunts → pleas for mercy), `undead.json`
(wordless rattles, scoped by `types: ["undead"]` so they fight to destruction
silently). Add a pack = drop a JSON file (then reload data).

## Engine — `emitCombatBark`

`CombatBarks.ts` `emitCombatBark(ctx, npc, trigger, { force? })` is the single
entry point. It selects matching packs, picks one line, surfaces it via
`ctx.eventSink` (a `npc_speech` bubble) + a dimmed Event Log line. Sparseness:

- **Frequent triggers** (`attack`, `damaged`) fire on a 50% chance and at most
  **once per round per NPC** (`NpcState.lastBarkRound`, keyed off
  `GameState.combatRound`).
- **Impactful one-shots** (`bloodied`, `death`, `flee`, `surrender`) pass
  `force` and always fire. The dead stay silent except their own death line; a
  surrendered NPC only barks `surrender`.

## Hooks

| Trigger | Site |
|---|---|
| `damaged` / `bloodied` / `death` | `ThresholdPublisher.publishNpcDamage` — the central NPC-damage path (covers player attacks, NPC-vs-NPC, spells, traps, zones). |
| `attack` | `NpcTurnRunners.runSingleEnemyTurn` after `result.attacked`. |
| `flee` / `surrender` | the morale branch in `NpcTurnRunners` (`applyNpcSurrender` + the flee path). |

Because the damage hook is the central publisher, barks fire for **any**
combatant from **any** damage source with no per-site wiring.

## Files

| File | Role |
|---|---|
| `shared/types/combatBarks.ts` | `CombatBarkPack`, `BarkTrigger`. |
| `server/src/engine/CombatBarks.ts` | `emitCombatBark` + pack selection. |
| `server/src/engine/ThresholdPublisher.ts` · `NpcTurnRunners.ts` | The hooks. |
| `shared/types/npcState.ts` | `NpcState.lastBarkRound` (cooldown). |
| `server/src/index.ts` · `engine/types.ts` | `barks/` loader + `GameDefs.combatBarks`. |
| `server/data/settings/the_sundered_reach/barks/*.json` | Authored packs. |
| `server/src/engine/CombatBarks.test.ts` | Tests. |

Demos `demo_morale` / `demo_objectives` (bandits + skeleton) surface barks live.

## Not yet
- More triggers (`kill` taunts, `crit`, `cast`, `miss`), per-NPC persona lines,
  and player-character barks. The trigger enum + selectors extend cleanly.
