> **Audience:** developers · **Status:** current · Run and develop MyRPG locally.

# Getting Started

## Prerequisites

- Node 22 LTS (the devcontainer provides Node 22, Postgres 17, Redis 7).
- A modern browser.

## Run it

```bash
npm install          # install dependencies (npm workspaces: client + server; shared/ is imported directly)
npm run dev          # Vite client on :5173 + Fastify server on :3000
```

Open `http://localhost:5173`.

## Useful commands

```bash
npm run dev:client   # frontend only (Vite, :5173)
npm run dev:server   # backend only (Fastify, :3000)
npm run typecheck    # type-check every workspace
npm run build        # production build
```

Run tests with `vitest` (e.g. `npx vitest run server/src/engine`). The server's
engine tests read content via paths relative to `server/`, so run them from the
`server/` directory (or the whole suite from the repo root, noting that a couple
of cwd-relative tests pass only from `server/`).

## Hot-reload notes

- **Client** changes hot-reload via Vite.
- **Server data files** (JSON under `server/data/`) are read at runtime; after
  editing one, force a `tsx`-watch reload with `touch server/src/index.ts`.

## Where things live

- Game content (JSON): `server/data/` — see [../design/data-model.md](../design/data-model.md).
- Rules engine: `server/src/engine/` — see [../design/architecture.md](../design/architecture.md).
- Shared contracts: `shared/`.
- UI: `client/src/` — region names in [../design/ui-reference.md](../design/ui-reference.md).

## Conventions

Read [../design/conventions.md](../design/conventions.md) before contributing.
