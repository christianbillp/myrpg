# MyRPG — Requirements

## Overview

A browser-based 2D single-player RPG built with modern web technologies.

## Tech Stack

| Layer            | Technology        | Version                  |
| ---------------- | ----------------- | ------------------------ |
| Game engine      | Phaser.js         | 3.x (latest stable)      |
| Language         | TypeScript        | 5.x (latest stable)      |
| Build tool       | Vite              | 6.x (latest stable)      |
| Backend          | Node.js + Fastify | Node 22 LTS, Fastify 5.x |
| Database         | PostgreSQL        | 17                       |
| Cache / sessions | Redis             | 7                        |

## Functional Requirements and Roadmap

### Core Gameplay

### Done

- **US-002** As a player, I want to choose between Aldric Vane (Human Fighter) and Miriel Duskwhisper (Wood Elf Rogue) before the encounter begins so that I can experience different combat styles. Each character has distinct mechanics: Aldric uses Greatsword with Savage Attacker and Graze mastery plus Second Wind; Miriel uses Shortsword with Sneak Attack (from hiding), Vex mastery, and a Hide action.
- **US-001** As a player, I want to move my character around the world using keyboard input (WASD and arrow keys) so that I can explore the game world. The world is represented as a grid where each tile equals 5 feet, making movement structured and tile-aligned.
- **US-003** As a player, I want to see my character's stats in a persistent sidebar so that I always know my current HP, AC, speed, ability scores, and XP without interrupting play. The Player Panel displays name, species/class/level, a colour-coded HP bar, combat stats (AC, Speed, Proficiency bonus, Initiative), all six ability scores with modifiers, and current XP.
- **US-005** As a player, I want to engage in turn-based combat with enemies so that exploration feels challenging and rewarding. Combat is fully integrated into the grid: movement (30 ft = 6 tiles per turn) and actions happen on the same map, following SRD 5.2.1 rules (initiative, attack rolls, Greatsword with Savage Attacker and Graze mastery, Second Wind, Nimble Escape, death saving throws). It is possible to scroll through the entire combat log.
- **US-016** As a player, I want to click a creature in the game grid to select it so that I can inspect its stats. The selected creature is highlighted with a coloured outline in the grid. A Target Panel appears on the right side of the game grid showing the creature's name, HP bar, AC, speed, and ability scores — mirroring the layout of the Player Panel. Clicking elsewhere or defeating the creature deselects it and hides the panel. When combat starts, the nearest active enemy is automatically selected.
- **US-017** As a developer, I want every monster's stat block to be sourced directly from the D&D 5e SRD 5.2.1 so that combat mechanics are correct and new monsters can be added without guesswork. Each `EnemyDef` records creature type, HP dice formula, and full attack entries with attack type (melee / ranged / both), reach, and range. The combat system selects the correct attack based on type. Initial roster: Goblin Minion and Bandit.

### Now

### Next

- **US-004** As a player, I want to talk to NPCs and read their dialogue so that I can learn about the world and advance the story.
- **US-006** As a player, I want to pick up, manage, and use items in an inventory so that I can equip myself for challenges.
- **US-007** As a player, I want to receive and track quests so that I have clear goals and a sense of progression.
- **US-008** As a player, I want my game state saved and loaded automatically so that I can continue where I left off.

### Player Progression

### Now

### Next

- **US-009** As a player, I want to earn experience points and level up so that my character grows stronger over time.
- **US-010** As a player, I want a skill or attribute system so that I can customise my character's playstyle.
- **US-011** As a player, I want to find and equip gear with stats so that my equipment choices meaningfully affect gameplay.

### World

### Now

### Next

- **US-012** As a player, I want the world built from tilemaps (Tiled format) so that levels are visually rich and easy to author.
- **US-013** As a player, I want to see animated sprites for my character and NPCs so that the world feels alive.
- **US-014** As a player, I want smooth transitions between areas so that moving through the world feels seamless.

## Non-Functional Requirements

- Runs entirely in a modern browser (no plugins)
- Save state persisted server-side via REST API
- Responsive to different screen sizes

## Out of Scope (for now)

- Multiplayer
- 3D rendering
- Mobile-native app
