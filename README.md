# myrpg
A browser-based 2D single-player RPG based on the D&D 5e SRD 5.2.1, built with Phaser.js and Fastify.

## Getting Started

```bash
npm install
npm run dev        # Vite on :5173 + Fastify on :3000
```

Open `http://localhost:5173` in a browser.

## Project Structure

```
client/    Vite + Phaser.js frontend (TypeScript)
server/    Fastify REST API (TypeScript)
  data/
    characters/   Character definitions (aldric.json, miriel.json)
    character.json  Active save state (created on first save)
```

## Architecture Notes

- The Fastify server exposes `GET /characters` (character roster), `GET /save`, and `POST /save`.
- `BootScene` fetches the character list before the game starts and stores it in the Phaser registry.
- Save state is written to `server/data/character.json` on every encounter transition and read back on startup.
