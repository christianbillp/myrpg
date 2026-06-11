> **Audience:** everyone — the naming contract. · **Status:** current.

# Glossary

Canonical names for the project's concepts. Use these exact terms in code
(variable/class/method names), in docs, and in prompts — a reader should be able
to find the code for a concept by searching for its documented name. UI region
names are defined in full in [design/ui-reference.md](./design/ui-reference.md);
data shapes in [design/data-model.md](./design/data-model.md).

## Product & world

- **AIGM** — *AI Game Master.* The AI layer that narrates, voices NPCs, and
  adjudicates anything the deterministic rules don't cover, acting via a fixed
  tool catalog. Spec: [design/aigm.md](./design/aigm.md).
- **The Sundered Reach** — the default campaign setting/fiction.
- **Encounter** — a single playable scene (combat, social, exploration, or AI
  dialogue) with its map, creatures, and triggers.
- **Adventure** — a string of encounters (chapters) with an overarching arc whose
  choices carry across chapters.
- **Engine** — the deterministic server-side rules system (`server/src/engine/`)
  that resolves everything with defined SRD rules.

## Creatures & social model

- **PlayerDef / PlayerState** — the static character definition vs. the mutable
  per-session player state.
- **MonsterDef** — an SRD stat block (HP, ability scores, attacks, resistances…).
- **NPCDef / NpcState** — a non-player character; references a monster stat block
  while adding identity (name, colour, persona). All creatures share `NpcState`.
- **Disposition** — the *combat* axis of an NPC: `ally | neutral | enemy` (does it
  fight for me, stay out, or attack me?).
- **Attitude** — the orthogonal *social* axis (how an NPC feels about the party:
  Friendly / Indifferent / Hostile). A hostile-attitude shopkeeper can still be
  neutral-disposition.
- **Faction** — `factionId` shared by creatures; turning one hostile aggros the
  rest of its faction.
- **Combat label** — the (A), (B), (C)… tag assigned to combatants for the turn.

## Rules vocabulary

- **Condition** — a status effect (Blinded, Prone, Charmed, …) tracked per
  creature; logic in `ConditionSystem`. Spec: [systems/srd-rules.md](./design/systems/srd-rules.md).
- **Modifier** — a typed passive contribution (feat/feature/buff) aggregated onto
  the character and queried by resolvers. Types listed in
  [data-model.md](./design/data-model.md#modifier-aggregator).
- **Buff** — an active, usually spell-granted effect recorded in the buff store
  and derived into `PlayerState` fields by `recomputeBuffs`.
- **Concentration** — the SRD attention a caster holds on one spell; broken by a
  failed CON save on damage or by Incapacitation.
- **Trigger** — an authored `when / if / then` rule on an encounter that fires
  engine actions (spawn, reveal, set flag, narrate) without GM intervention.
- **Action economy** — the per-turn Action / Bonus Action / Reaction / free object
  interaction budget.
- **Improvised Action** — a free-text player attempt to change the world that no
  button or dedicated tool covers, resolved first-class by
  `ImprovisedActionSystem` via the AIGM's `resolve_improvised_action` tool.
  Spec: [systems/improvised-actions.md](./design/systems/improvised-actions.md).
- **Difficulty Band** — the named difficulty the AIGM passes instead of a DC
  number (`very_easy` … `nearly_impossible`); the engine maps it to the SRD DC
  via `DIFFICULTY_BAND_DC`.
- **Ruling** — one adjudicated Improvised Action (`ImprovisedRuling`: description,
  skill, band, DC, outcome), recorded on `GameState.improvisedRulings` and
  surfaced to the AIGM as the RECENT RULINGS block so repeat attempts keep a
  consistent difficulty.

## UI regions (canonical — see ui-reference.md)

- **Game Map** — the tile battlefield (1 tile = 5 ft).
- **Player Panel** — the player's action surface (Action Buttons, etc.).
- **Action Buttons** — the per-action controls in the Player Panel.
- **Phase Text** — the current-phase indicator.
- **Target Panel** — the selected-creature inspector.
- **HUD** — the heads-up display (incl. the Turn Order Bar and GM tab).
- **Turn Order Bar** — the initiative-ordered combatant chips.
- **Event Log** — the two-column narrative + dice-detail log. (Formerly "Combat Log"; old saves carry a `combatLog` field migrated on load.)

## Dev terms

- **DevMode** — `client/src/devMode.ts`; gates hidden dev-only buttons.
- **Shared types** — `shared/` — the TypeScript contract between client + server.
