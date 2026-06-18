# Documentation

The full documentation for **MyRPG** — a browser-based, single-player D&D 5e
SRD 5.2.1 RPG with an AI Game Master. Start with the signpost for your role.

## Start here, by role

| You are a… | Start with | Then |
|---|---|---|
| **Product manager** | [overview.md](./overview.md) → [product/capabilities.md](./product/capabilities.md) | [product/requirements.md](./product/requirements.md) |
| **Developer** (expanding the code) | [overview.md](./overview.md) → [design/architecture.md](./design/architecture.md) | [design/conventions.md](./design/conventions.md), [design/data-model.md](./design/data-model.md), [guides/](./guides/) |
| **AI agent** (working in the repo) | [glossary.md](./glossary.md) → [design/conventions.md](./design/conventions.md) | [design/aigm.md](./design/aigm.md), [design/data-model.md](./design/data-model.md), [design/systems/](./design/systems/) |

## The three tiers

**① Overview** — what this is and what it's for.
- [overview.md](./overview.md) — vision, goal, design pillars, the audience map.
- [glossary.md](./glossary.md) — canonical vocabulary (the naming contract).

**② Product & Requirements** — what the product does and will do.
- [product/capabilities.md](./product/capabilities.md) — what the game can do today, in plain language.
- [product/requirements.md](./product/requirements.md) — the `US-xxx` requirement list (the *what*), grouped by domain, linking to the spec.

**③ Design Specification** — how it works.
- [design/architecture.md](./design/architecture.md) — system shape, tech stack, the data-driven engine.
- [design/conventions.md](./design/conventions.md) — coding standards, naming, modularity, the review checklist.
- [design/data-model.md](./design/data-model.md) — the JSON data reference (every content type).
- [design/ui-reference.md](./design/ui-reference.md) — canonical UI regions + layout.
- [design/aigm.md](./design/aigm.md) — the AI Game Master behaviour contract.
- [design/aigm-tools.md](./design/aigm-tools.md) — the AIGM tool catalog.
- [design/systems/srd-rules.md](./design/systems/srd-rules.md) — detailed spec for the SRD rule systems.
- [design/systems/content-generation.md](./design/systems/content-generation.md) — detailed spec for content generation & the AIGM-driven world.
- [design/systems/npc-simulation.md](./design/systems/npc-simulation.md) — the off-camera living world: world ticks, alertness, routines, companions (US-094).
- [design/systems/ambient-conversations.md](./design/systems/ambient-conversations.md) — idle NPCs talk to each other (banter packs, witness gating) to make scenes feel alive (US-129).
- [design/systems/animation-timeline.md](./design/systems/animation-timeline.md) — the ordered combat-beat timeline the client animates.
- [design/systems/improvised-actions.md](./design/systems/improvised-actions.md) — first-class resolution of free-text creative actions (US-121).
- [design/systems/map-generation.md](./design/systems/map-generation.md) — the deterministic + agentic map system: layering, terrain variants, the placeable registry, tactical metrics, routing, river/bridge.

**Guides** — task recipes.
- [guides/getting-started.md](./guides/getting-started.md) — run it locally.
- [guides/adding-a-spell.md](./guides/adding-a-spell.md), [guides/adding-a-monster.md](./guides/adding-a-monster.md).

## Conventions for these docs

One concern per file (target < ~400 lines). Each doc opens with an **Audience /
Status** line. Requirements link *down* to design; design links *down* to the
data model — a fact is stated once in its deepest tier and linked up. `US-xxx`
ids are stable anchors. Where a system implements an SRD rule, it links the
relevant section in `/dnd.srd.5.2.1/`.
