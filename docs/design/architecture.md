> **Audience:** developers, AI agents · **Status:** current · The system shape and the data-driven engine philosophy. Content shapes live in [data-model.md](./data-model.md); coding standards in [conventions.md](./conventions.md).

# Architecture

## Tech stack

| Layer | Technology | Version | Status |
|---|---|---|---|
| Game engine | Phaser.js | 3.88.x | In use |
| Language | TypeScript (strict) | 5.7.x | In use |
| Build tool | Vite | 6.3.x | In use |
| Backend | Node.js + Fastify | Node 22 LTS, Fastify 5.x | In use |

State is persisted as JSON files server-side.

## Repository shape

```
client/          Vite + Phaser.js frontend (TypeScript)
  src/
    scenes/      Phaser scenes (Boot, Preload, Game, UI, editors, …)
    entities/    Player, NPC, Enemy view classes
    systems/     Client-side combat/inventory/quest presentation
    ui/          Panels & overlays (Player Panel, HUD, Target Panel, …)
    assets/      Sprites, tilemaps, audio
server/          Fastify backend (TypeScript)
  src/
    routes/      REST endpoints (content + save)
    engine/      The deterministic rules engine (see below)
    db/          SQL migrations / queries (Postgres — planned)
    cache/        Redis helpers (planned)
  data/          ALL game content as JSON (characters, monsters, spells, maps, …)
shared/          TypeScript types shared by client + server (the contracts)
dnd.srd.5.2.1/   The SRD rulebook, as markdown — the source of truth for rules
docs/            This documentation
```

The **`shared/` types are the contract** between client and server — `GameState`,
`PlayerDef`/`PlayerState`, `NpcState`, `MonsterDef`, `SpellDef`, `Modifier`, and
the action/event unions. Both sides import them, so a shape change is caught at
compile time on both ends.

## The data-driven engine philosophy

The engine is built so that **content is JSON and the engine is generic**:

- A **monster**, **spell**, **item**, **feat**, **encounter**, or **adventure**
  is a JSON file in `server/data/`. Adding one is a file drop — no engine change.
- The combat/spell/condition resolvers **branch on the *shape* of the data**, not
  on hard-coded ids. A new damage spell that fits the generic resolver is data;
  only a genuinely novel mechanic touches the engine.
- Passive bonuses (feats, class features, spell buffs) flow through a single
  **`Modifier` aggregator** and a **buff store**, so adding a passive that fits an
  existing modifier type is pure data. See [data-model.md](./data-model.md#modifier-aggregator).

This is the property the [conventions](./conventions.md) call "easy to extend and
easy to shrink."

## Runtime flow

1. **Boot.** The client fetches the content it needs (character roster, defs)
   from the Fastify REST API and stores them in the Phaser registry.
2. **Setup.** The player picks a character and an **encounter** or **adventure**.
3. **Play.** The client sends **player actions** to the server; the engine
   resolves them against `GameState` and returns the new state + an **event**
   stream (the Event Log). Turn order, attacks, conditions, triggers, and NPC AI
   all run server-side and deterministically.
4. **The AIGM** layer sits on top: free-form player text goes to the AI Game
   Master, which narrates and adjudicates by calling a fixed catalog of **tools**
   (apply damage, set disposition, request an ability check, …) that mutate the
   same `GameState`. See [aigm.md](./aigm.md) and [aigm-tools.md](./aigm-tools.md).
5. **Persistence.** Save state is written server-side on every encounter
   transition and read back on startup — world / character / adventure save
   files and their load migrations live in `server/src/persistence/saves.ts`
   (dependency-injected at boot via `initSavesPersistence`). The server
   enforces one live session per character and gates
   `/adventure/:characterId/advance` on `encounterComplete`.

## The rules engine (`server/src/engine/`)

The engine is a set of focused modules that operate on `GameState`. Notable ones:

- **Combat** — `CombatSystem` (attack/damage resolution, masteries), `CombatFlow`
  (turn order, death saves, end-of-turn hooks), `CombatActions` (player actions).
- **Enemy/ally AI** — `EnemyAI`, `NpcTurnRunners` (target selection, movement).
- **Spells** — `SpellSystem` (cast entry + attack/save/heal resolvers) layered
  over `SpellPrimitives` (caster math, damage application), `SpellZones`
  (placed-area spells), and `SpellUtilityResolvers` (the buff/cure/dispel
  dispatcher); NPC-side casting in `NpcSpellcasting` + `NpcConcentration`;
  per-system modules like `SpiritGuardiansSystem`, `SummonSystem`,
  `ConcentrationSystem`.
- **Conditions & buffs** — `ConditionSystem`, `Buffs` (the modifier-derived buff
  layer), `EquipmentSystem` (AC/attack derivation).
- **World** — `TriggerSystem`, factions, `Vision`, `WorldTick`, resting.
- **The bus** — an `EventBus` carries `EngineEvent`s that decouple producers
  (damage, movement) from subscribers (sound, hide-clearing, thresholds);
  `PresentationHooks` projects them into the ordered `GameEvent` beat stream
  the client animates (see
  [systems/animation-timeline.md](./systems/animation-timeline.md)).

Each concern is one module so features can be added or removed without rippling
changes. The detailed per-rule specification is in
[systems/srd-rules.md](./systems/srd-rules.md),
[systems/content-generation.md](./systems/content-generation.md), and
[systems/animation-timeline.md](./systems/animation-timeline.md).

## Dev commands

See [../guides/getting-started.md](../guides/getting-started.md).
