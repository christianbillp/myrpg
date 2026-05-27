# CLAUDE.md — Collaboration Guide

This file tells Claude Code how to work in this project.

## Project Summary
Browser-based 2D single-player RPG. See `requirements.md` for the full feature list and tech stack.

## Architecture

```
/
├── client/          # Vite + Phaser.js frontend (TypeScript)
│   ├── src/
│   │   ├── scenes/  # Phaser scenes (Boot, Preload, Game, UI, etc.)
│   │   ├── entities/ # Player, NPC, Enemy classes
│   │   ├── systems/  # Combat, inventory, quest logic
│   │   └── assets/   # Sprites, tilemaps, audio
├── server/          # Fastify backend (TypeScript)
│   ├── src/
│   │   ├── routes/   # REST API endpoints
│   │   ├── db/       # PostgreSQL queries / migrations
│   │   └── cache/    # Redis helpers
└── .devcontainer/   # Dev environment (Node 22, Postgres 17, Redis 7)
```

## Dev Commands

```bash
# Install dependencies
npm install

# Start frontend dev server (Vite on port 5173)
npm run dev:client

# Start backend (Fastify on port 3000)
npm run dev:server

# Run both concurrently
npm run dev

# Type-check
npm run typecheck

# Build for production
npm run build
```

## UI Naming Conventions

All UI regions and components have canonical names defined in `ui.md`. Read that file before implementing or discussing any UI feature. Use the names there consistently in code (variable names, class names) and in prompts — e.g. "Player Panel", "Combat Log", "Action Buttons", "Phase Text".

## Conventions

- **TypeScript strict mode** is enabled — no implicit `any`.
- **No comments** unless the *why* is non-obvious (hidden constraints, subtle invariants).
- Phaser scenes go in `client/src/scenes/`, one class per file.
- Database migrations are plain SQL files in `server/src/db/migrations/`.
- Environment variables are read from `.env` (never committed); see `.env.example` for required keys.

## Game Rules

All gameplay mechanics must follow the **D&D 5e SRD 5.2.1** rules, available as markdown in `/workspace/dnd.srd.5.2.1/`. Before implementing any gameplay system (combat, leveling, skills, spells, items, etc.), read the relevant SRD section first. Key sections:

- `01_Playing_The_Game/` — D20 tests, ability checks, combat, damage, healing
- `02_Creating_A_Character/` — ability scores, XP/level table, HP by class
- `03_Character_Classes/` — class features per level
- `04_Character_Origins/` — species traits, backgrounds
- `06_Equipment/` — weapons, armour, gear stats
- `07_Spells/` — spell rules and descriptions
- `08_Rules_Glossary/` — conditions, resting, special senses
- `11_Monsters/` — monster stat blocks and CR

## Code Quality

Refactoring should optimise for **scalability, agility, and maintainability** — the codebase must be easy to extend and easy to shrink. Specifically:

- **Modularity** — encapsulate each concern in its own class or file so features can be added or removed without rippling changes across the codebase.
- **Naming consistency** — variable names, class names, and method names must match the terminology in `ui.md`, `requirements.md`, and other reference documents. A reader should be able to find the code for a named concept by searching for its documented name.
- **Readability for humans and AI agents** — code should be self-explanatory from names and structure alone. Avoid clever abbreviations; prefer the full canonical term.
- **Low coupling** — components communicate through clear interfaces. Avoid reaching into the internals of another class or scene.

## Dev Mode Buttons

Dev buttons are hidden from regular players and must not influence UI layout. When designing or reviewing any panel or overlay:

1. Design the layout as if dev buttons do not exist — it must look complete and balanced without them.
2. Only after the design is settled, place dev buttons into whatever leftover space is available (e.g. an absolutely-positioned corner) without shifting, resizing, or rebalancing any non-dev element.

Dev buttons are gated behind `DevMode.enabled` from `client/src/devMode.ts`. When the button is conditionally rendered, all references to it must guard against `null`.

## Reviewing

A review checks whether the codebase needs refactoring. It considers three things together: the code as written, the reference documentation (`ui.md`, `requirements.md`, and any other docs), and the outstanding requirements. Specifically look for:

- Naming inconsistencies between code and documentation.
- Components or methods that have grown too large or taken on multiple responsibilities.
- Coupling that would make adding or removing a feature unnecessarily hard.
- Anything in the requirements that is partially implemented or implemented in a way that will not scale.

**Do not make any changes during a review.** At the end, present findings as a short list and prompt the user with concrete candidate actions and decisions to choose from.

## Working with Claude

- Keep changes focused — one feature or fix per session where possible.
- "Update documentation" means updating `ui.md`, `requirements.md`, `data_structure.md`, and `AIGM.md`.
- Before creating a commit, ensure `ui.md`, `requirements.md`, `data_structure.md`, and `AIGM.md` are up to date with any changes made.
- Update `requirements.md` as features are completed.
- When adding a new system (combat, inventory, etc.), discuss the design in a few sentences before implementing.
- Prefer editing existing files over creating new ones.
- Do not add error handling for scenarios that cannot happen.
- Never commit changes automatically. Always wait for an explicit instruction to commit, even when documentation is up to date and the work appears complete.
- Commit messages follow Conventional Commits: one line, e.g. `feat: add rooms map generator.` — brief, lowercase after the colon, ending with a full stop.
