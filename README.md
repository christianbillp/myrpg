# MyRPG

A browser-based, single-player **D&D 5e SRD 5.2.1** RPG with an **AI Game
Master**, built with Phaser.js + Fastify (TypeScript). Faithful rules on a 2D
tile map; a generative GM for everything the rules leave open.

## Quick start

```bash
npm install
npm run dev        # Vite client on :5173 + Fastify server on :3000
```

Open `http://localhost:5173`. More: [docs/guides/getting-started.md](./docs/guides/getting-started.md).

## 📖 Documentation

Full documentation lives in **[`docs/`](./docs/README.md)**, organised in three
tiers for product managers, developers, and AI agents:

- **Overview** — [docs/overview.md](./docs/overview.md) (what it is & the goal) ·
  [docs/glossary.md](./docs/glossary.md)
- **Product** — [docs/product/capabilities.md](./docs/product/capabilities.md)
  (what it can do) · [docs/product/requirements.md](./docs/product/requirements.md)
- **Design** — [docs/design/architecture.md](./docs/design/architecture.md) ·
  [docs/design/data-model.md](./docs/design/data-model.md) ·
  [docs/design/aigm.md](./docs/design/aigm.md)

Start at the [documentation index](./docs/README.md).

## Layout

```
client/   Vite + Phaser.js frontend (TypeScript)
server/   Fastify REST API + rules engine (TypeScript); all content as JSON under server/data/
shared/   TypeScript types shared by client + server
docs/     Documentation
dnd.srd.5.2.1/   The SRD rulebook (source of truth for rules)
```
