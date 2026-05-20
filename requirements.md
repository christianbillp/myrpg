# MyRPG — Requirements

## Overview

A browser-based 2D single-player RPG built with modern web technologies.

## Tech Stack

| Layer            | Technology        | Version              | Status  |
| ---------------- | ----------------- | -------------------- | ------- |
| Game engine      | Phaser.js         | 3.88.x               | In use  |
| Language         | TypeScript        | 5.7.x                | In use  |
| Build tool       | Vite              | 6.3.x                | In use  |
| Backend          | Node.js + Fastify | Node 22 LTS, Fastify 5.x | Planned |
| Database         | PostgreSQL        | 17                   | Planned |
| Cache / sessions | Redis             | 7                    | Planned |

## Functional Requirements and Roadmap

### Core Gameplay

### Done

- **US-002** As a player, I want to choose between Aldric Vane (Human Fighter) and Miriel Duskwhisper (Wood Elf Rogue) before the encounter begins so that I can experience different combat styles. Each character has distinct mechanics: Aldric uses Greatsword with Savage Attacker and Graze mastery plus Second Wind; Miriel uses Shortsword with Sneak Attack (from hiding), Vex mastery, and a Hide action.
- **US-001** As a player, I want to move my character around the world using keyboard input (WASD and arrow keys) so that I can explore the game world. The world is represented as a tile-based map where each tile equals 5 feet, making movement structured and tile-aligned.
- **US-003** As a player, I want to see my character's stats in a persistent sidebar so that I always know my current HP, AC, speed, ability scores, and XP without interrupting play. The Player Panel displays name, species/class/level, a colour-coded HP bar, combat stats (AC, Speed, Proficiency bonus, Initiative), all six ability scores with modifiers, and current XP.
- **US-005** As a player, I want to engage in turn-based combat with enemies so that exploration feels challenging and rewarding. Combat is fully integrated into the map: movement (30 ft = 6 tiles per turn) and actions happen on the same map, following SRD 5.2.1 rules (initiative, attack rolls, Greatsword with Savage Attacker and Graze mastery, Second Wind, Nimble Escape, death saving throws). It is possible to scroll through the entire combat log.
- **US-016** As a player, I want to click a creature in the game map to select it so that I can inspect its stats. The selected creature is highlighted with a coloured outline. A Target Panel appears on the right side of the Game Map showing the creature's name, HP bar, AC, speed, and ability scores — mirroring the layout of the Player Panel. Clicking elsewhere or defeating the creature deselects it and hides the panel. When combat starts, the nearest active enemy is automatically selected.
- **US-017** As a developer, I want every monster's stat block to be sourced directly from the D&D 5e SRD 5.2.1 so that combat mechanics are correct and new monsters can be added without guesswork. Each `EnemyDef` records creature type, HP dice formula, and full attack entries with attack type (melee / ranged / both), reach, and range. The combat system selects the correct attack based on type. Initial roster: Goblin Minion and Bandit.
- **US-018** As a player, I want to zoom in and out on the game map using the mouse wheel so that I can get a better view of the battlefield. I also want to pan around the map by left-click dragging, and reset both zoom and pan to the default view with a dedicated button.
- **US-019** As a player, I want to move around on a randomly generated map so that I can experience a variety of challenges. Each encounter generates a new square map with a random side length between 10 and 30 tiles, where 20–40% of tiles are impassable walls. All passable tiles are guaranteed to be reachable from each other (flood-fill validated). Player and enemies spawn on passable tiles separated by at least 5 tiles. Wall tiles are visually distinct. Movement respects walls including the SRD diagonal corner rule (diagonal movement is blocked when both orthogonal neighbours are walls). The enemy AI uses BFS pathfinding to navigate around walls.
- **US-006** As a player, I want to pick up, manage, and use items in an inventory so that I can equip myself for challenges. Up to 3 Health Potions (2d4+2 healing per SRD) spawn as green diamond tokens on the map each encounter; walking onto a token picks it up automatically. The Player Panel shows a live item count and a USE POTION button (dimmed when empty). Gold pieces (GP) are awarded on kill at 10 × CR (rounded down); the current gold total is shown in the Player Panel below XP. Both XP and GP rewards are recorded in the combat log.
- **US-020** As a player, I want to be presented with an encounter setup menu before the game starts so that I can choose my encounter type(s), map type, and character. The Encounter Setup Scene has three columns: Encounter Type (multi-select — "Simple Combat" and/or "Social Interaction" can both be active; clicking a selected card deselects it), Map Type ("Open Map" or "Rooms"), and Character (Aldric or Miriel). A BEGIN ENCOUNTER button activates once at least one encounter type, a map type, and a character are selected. Selecting both encounter types spawns enemies, items, and an NPC on the same map.
- **US-021** As a player, I want to select a Social Interaction encounter so that I can engage with an NPC rather than fight. A Commoner (SRD 5.2.1 stat block) spawns on the map. When the player moves adjacent to the Commoner, a TALK action button appears in the HUD. Clicking it presents a riddle with three answer options. A correct answer congratulates the player and awards +10 GP; a wrong answer shows a failure message. The TALK button disappears once the riddle has been answered.
- **US-022** As a player, I want to select the Exploration encounter type so that I can discover hidden secrets on the map. When active, 4 secrets are placed on the map (invisible to the player). A SEARCH button appears in the HUD during exploration. Using Search performs a Wisdom (Perception) check (d20 + perception bonus vs secret DC 10/12/15). While adjacent to a secret tile, success reveals the reward (gold, a Health Potion, or a lore inscription) and logs it; failure produces a flavour observation. Each secret can only be found once. The SEARCH button is hidden when no secrets remain.
- **US-023** As a player, I want to select a hand-crafted saved map so that I can play on a specific layout. Four maps are available: Arena, Dungeon, Ruins, and Catacombs. In the Encounter Setup screen the Map Type column shows a third card "Saved Map"; clicking it opens a picker overlay. Confirming a selection closes the overlay and marks the card as selected; the chosen map name is displayed on the card. The encounter cannot begin until a map is confirmed.
- **US-024** As a player, I want to fight multiple enemies in a single combat encounter so that battles feel more strategic. Simple Combat spawns 2–4 enemies chosen randomly from available enemy types (Goblin Minion and Bandit). All map enemies join combat the moment one triggers it. Enemies are labeled A, B, C… on the map and in the Turn Order Bar at the top of the Game Map. Enemies act sequentially during the enemy phase; the active chip in the Turn Order Bar is highlighted green and dead chips are dimmed. Combat ends only when all enemies are defeated.
- **US-025** As a player, I want the action economy to follow D&D 5e SRD rules so that combat feels authentic. Each player turn grants one Action and one Bonus Action. Attack consumes the Action; Second Wind (Fighter) and Hide via Cunning Action (Rogue) consume the Bonus Action. Drinking a Health Potion costs the Bonus Action in combat and is free during exploration. The player remains in their turn after spending either resource and must press End Turn to hand initiative to the enemies. The Phase Text appends "· action used" or "· bonus used" when the respective resource is spent; buttons that require a spent resource are dimmed and disabled.
- **US-007** As a player, I want to receive and track quests so that I have clear goals and a sense of progression. Quests are assigned automatically at encounter start based on the active encounter types. Combat encounters assign: First Blood (slay 1 enemy, +10 XP +5 GP), Slay All (slay every enemy spawned, +25 XP +15 GP), and Treasure Hunt (collect 2 Health Potions, +10 XP +5 GP). Exploration encounters assign: Keen Eye (find 2 secrets, +15 XP +10 GP). Social Interaction encounters assign: Make Contact (answer the NPC's riddle, +10 XP +5 GP, awarded on any answer). The Player Panel shows a QUESTS section listing each quest as "· Title  N/M" while in progress and "✓ Title" when complete. Quest rewards are added to XP and GP and logged in the Combat Log on completion.

### Now

### Next

- **US-004** As a player, I want to talk to NPCs and read their dialogue so that I can learn about the world and advance the story.
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
