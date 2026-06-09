> **Audience:** developers, AI agents · **Status:** current · The engineering contract for working in this codebase. (`CLAUDE.md` at the repo root holds the agent-facing operating directives and points here for the human-readable rationale.)

# Conventions

## Code style

- **TypeScript strict mode** — no implicit `any`.
- **No comments unless the *why* is non-obvious** — hidden constraints, subtle
  invariants. Don't narrate the *what*; the code says that.
- **Match the surrounding code** — comment density, naming, and idiom.
- Phaser scenes go in `client/src/scenes/`, one class per file.
- Database migrations are plain SQL files in `server/src/db/migrations/`.
- Environment variables come from `.env` (never committed); see `.env.example`.
- **Don't add error handling for scenarios that cannot happen.**

## Naming consistency

Variable, class, and method names must match the terminology in the
[glossary](../glossary.md), [ui-reference.md](./ui-reference.md), and the
requirements. A reader should find the code for a named concept by searching for
its documented name. Avoid clever abbreviations — prefer the full canonical term
(e.g. "Player Panel", "Combat Log", "Phase Text").

## Code quality — easy to extend, easy to shrink

Optimise for **scalability, agility, and maintainability**:

- **Modularity** — encapsulate each concern in its own class/file so features can
  be added or removed without rippling changes. (See the data-driven engine in
  [architecture.md](./architecture.md).)
- **Low coupling** — components communicate through clear interfaces; don't reach
  into another class's or scene's internals.
- **Readability for humans and AI agents** — self-explanatory from names and
  structure alone.

## Game rules

All gameplay must follow the **D&D 5e SRD 5.2.1** rules in `/dnd.srd.5.2.1/`.
Before implementing any gameplay system (combat, leveling, skills, spells,
items), read the relevant SRD section first. When the engine simplifies or
diverges, say so in code/data (e.g. a spell JSON's `Engine:` note) and link the
SRD section. When adding a new system, sketch the design in a few sentences
before implementing.

## Dev Mode buttons

Dev buttons are hidden from regular players and **must not influence UI layout**:

1. Design every panel/overlay as if dev buttons don't exist — it must look
   complete and balanced without them.
2. Only then place dev buttons into leftover space (e.g. an absolutely-positioned
   corner) without shifting, resizing, or rebalancing any non-dev element.

Dev buttons are gated behind `DevMode.enabled` (`client/src/devMode.ts`); when a
button is conditionally rendered, all references must guard against `null`.

## Reviewing

A review checks whether the codebase needs refactoring, considering the code, the
reference docs, and the outstanding requirements together. Look for:

- Naming inconsistencies between code and documentation.
- Components/methods that have grown too large or taken on multiple
  responsibilities.
- Coupling that makes adding or removing a feature unnecessarily hard.
- Requirements that are partially implemented or implemented in a way that won't
  scale.

**Make no changes during a review.** Present findings as a short list with
concrete candidate actions to choose from.

## Documentation upkeep

"Update documentation" means keeping these in sync with any change:

- [product/requirements.md](../product/requirements.md) — update as features are
  completed (status + the user-facing *what*).
- [design/systems/](./systems/) — the detailed *how* for the affected system.
- [design/data-model.md](./data-model.md) — data-shape changes.
- [design/ui-reference.md](./ui-reference.md) — UI region changes.
- [design/aigm.md](./aigm.md) / [aigm-tools.md](./aigm-tools.md) — AIGM behaviour
  or tool changes.

Keep these current **before** creating a commit. Commit messages follow
Conventional Commits (one line, e.g. `feat: add rooms map generator.`). Commit to
`main`; do not create branches. Never commit automatically — wait for an explicit
instruction.
