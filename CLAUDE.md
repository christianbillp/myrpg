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

## Working with Claude

- Keep changes focused — one feature or fix per session where possible.
- Update `requirements.md` as features are completed.
- When adding a new system (combat, inventory, etc.), discuss the design in a few sentences before implementing.
- Prefer editing existing files over creating new ones.
- Do not add error handling for scenarios that cannot happen.
- Do not push to remote or commit unless explicitly asked.
