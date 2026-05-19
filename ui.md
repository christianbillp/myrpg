# UI Reference

Canonical names for all UI regions and components. Use these consistently in code (variable names, class names) and in prompts.

## Layout

```
+----------------+--------------------------------------------------+
|                |                                                  |
|                |                                                  |
|  Player Panel  |                  Game Map                       |
|                |                                                  |
|                |                                                  |
+----------------+--------------------------------------------------+
|                             HUD                                   |
+-------------------------------------------------------------------+
```

- **Player Panel** — 160 px wide left sidebar, full canvas height
- **Game Map** — tile-based play area to the right of the Player Panel
- **HUD** — 200 px tall bar at the bottom, spanning full canvas width

---

## Player Panel

Defined in `client/src/ui/PlayerPanel.ts`. Always visible. Displays the active player's stats.

| Component | Description |
|-----------|-------------|
| **Name Header** | Player name (in class colour) and species/class/level line |
| **HP Bar** | Colour-coded health bar: green > 50 %, orange > 25 %, red ≤ 25 % |
| **HP Text** | Numeric HP — "current / max" |
| **Combat Stats** | AC, Speed, Proficiency bonus, Initiative bonus |
| **Ability Scores** | All six scores (STR DEX CON INT WIS CHA) with modifiers |
| **XP Display** | Current experience points |

---

## Game Map

Rendered in `client/src/scenes/GameScene.ts`. Each tile = 5 ft. Occupies the area to the right of the Player Panel.

| Component | Description |
|-----------|-------------|
| **Player Token** | Coloured rectangle representing the player character |
| **Enemy Token** | Coloured rectangle with a small HP bar shown above it |
| **Movement Highlights** | Blue-tinted tiles showing reachable squares during the player's turn |

---

## Target Panel

Defined in `client/src/ui/TargetPanel.ts`. Visible only when a creature is selected. Positioned on the right side of the Game Map, mirroring the Player Panel's width and layout.

Selection: clicking a creature in the Game Map selects it. The creature is highlighted with a coloured outline (its token colour). Clicking an empty tile or defeating the creature clears the selection and hides the panel.

| Component | Description |
|-----------|-------------|
| **Name Header** | Creature name (in token colour) and type/CR line |
| **HP Bar** | Colour-coded health bar: green > 50 %, orange > 25 %, red ≤ 25 % |
| **HP Text** | Numeric HP — "current / max" |
| **Combat Stats** | AC, Speed |
| **Ability Scores** | All six scores (STR DEX CON INT WIS CHA) with modifiers |

---

## HUD (Heads-Up Display)

Rendered in `client/src/scenes/GameScene.ts`. Spans the full canvas width below the Game Map.

| Component | Description |
|-----------|-------------|
| **Enemy Info** | Top-right — enemy name, HP, and status tags (`[HIDDEN]`, `[VEXED]`) |
| **Phase Text** | Top-centre — current game phase ("Exploring", "Your turn — N moves", enemy name + "…", death save state) |
| **Combat Log** | Scrollable text area showing the history of combat events, newest at the bottom. Scroll with the mouse wheel. |
| **Log Scroll Hint** | Small dim text showing scroll direction and how many newer entries are below |
| **Action Buttons** | Context-sensitive buttons shown during combat (see below) |

### Action Buttons

| Button | Condition | Description |
|--------|-----------|-------------|
| **Attack** | Player's turn, adjacent to enemy | Make a melee attack |
| **Second Wind** | Player's turn, Fighter only, uses remaining, not at full HP | Spend a use to heal 1d10 + level HP |
| **Hide** | Player's turn, Rogue only, not already hidden | Attempt to hide for Sneak Attack advantage |
| **End Turn** | Player's turn | Pass initiative to the enemy |
| **Roll Death Save** | Player unconscious | Roll a d20 death saving throw |
