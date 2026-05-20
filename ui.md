# UI Reference

Canonical names for all UI regions and components. Use these consistently in code (variable names, class names) and in prompts.

## Layout

```
+----------------+----------------------------------+----------------+
|                |                                  |                |
|  Player Panel  |           Game Map               |  Target Panel  |
|                |                                  |                |
|                |                                  |                |
+----------------+----------------------------------+----------------+
|                             HUD                                    |
+--------------------------------------------------------------------+
```

- **Player Panel** — 160 px wide left sidebar, full canvas height
- **Game Map** — tile-based play area between the two panels
- **Target Panel** — 160 px wide right sidebar, full canvas height; visible only when a creature is selected
- **HUD** — 200 px tall bar at the bottom, spanning full canvas width

---

## Player Panel

Defined in `client/src/ui/PlayerPanel.ts`. Always visible. Displays the active player's stats.

| Component          | Description                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| **Name Header**    | Player name (in class colour) and species/class/level line                                               |
| **HP Bar**         | Colour-coded health bar: green > 50 %, orange > 25 %, red ≤ 25 %                                         |
| **HP Text**        | Numeric HP — "current / max"                                                                             |
| **Combat Stats**   | AC, Speed, Proficiency bonus, Initiative bonus                                                           |
| **Ability Scores** | All six scores (STR DEX CON INT WIS CHA) with modifiers                                                  |
| **XP Display**     | Current experience points                                                                                |
| **GP Display**     | Current gold pieces (awarded from kills at 10 × CR)                                                      |
| **Inventory**      | Item count per type (e.g. "Health Potion ×2") or "Empty"                                                 |
| **Use Potion**     | Button below the inventory list; dimmed when no potions held or bonus action already spent; clicking drinks one potion (2d4+2 HP, SRD); costs the Bonus Action in combat, free during exploring |
| **Quests**         | Section below Use Potion listing quests assigned at encounter start. Each quest shows "· Title  N/M" while in progress and "✓ Title" when complete. "None" when no quests are active for the current encounter type. |

---

## Game Map

Rendered in `client/src/scenes/GameScene.ts`. Each tile = 5 ft. Occupies the area to the right of the Player Panel.

| Component               | Description                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Player Token**        | Coloured rectangle representing the player character                                                                                  |
| **Enemy Token**         | Coloured rectangle with a small HP bar; when multiple enemies are present each token shows its letter label (A, B, C…) centred on it  |
| **Item Token**          | Small green diamond on a tile; walking onto it picks up the item                                                                      |
| **Movement Highlights** | Blue-tinted tiles showing reachable squares during the player's turn                                                                  |
| **Turn Order Bar**      | Semi-transparent strip pinned to the top of the Game Map; visible during combat. One chip per combatant (player first, then enemies in spawn order). The active chip is highlighted green; dead chips are dimmed. Enemy chips show the letter label and name. |

---

## Target Panel

Defined in `client/src/ui/TargetPanel.ts`. Visible only when a creature is selected. Positioned on the right side of the Game Map, mirroring the Player Panel's width and layout.

Selection: clicking a creature in the Game Map selects it. The creature is highlighted with a coloured outline (its token colour). Clicking an empty tile or defeating the creature clears the selection and hides the panel.

| Component          | Description                                                      |
| ------------------ | ---------------------------------------------------------------- |
| **Name Header**    | Creature name (in token colour) and type/CR line                 |
| **HP Bar**         | Colour-coded health bar: green > 50 %, orange > 25 %, red ≤ 25 % |
| **HP Text**        | Numeric HP — "current / max"                                     |
| **Combat Stats**   | AC, Speed                                                        |
| **Ability Scores** | All six scores (STR DEX CON INT WIS CHA) with modifiers          |

---

## HUD (Heads-Up Display)

Defined in `client/src/ui/HUD.ts`. Spans the full canvas width below the Game Map.

| Component           | Description                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Enemy Info**      | Top-right — enemy name, HP, and status tags (`[HIDDEN]`, `[VEXED]`)                                           |
| **Phase Text**      | Top-centre — current game phase ("Exploring", "Your turn — N moves", enemy name + "…", death save state); appends "· action used" or "· bonus used" when the respective resource has been spent this turn |
| **Combat Log**      | Scrollable text area showing the history of combat events, newest at the bottom. Scroll with the mouse wheel. |
| **Log Scroll Hint** | Small dim text showing scroll direction and how many newer entries are below                                  |
| **Action Buttons**  | Context-sensitive buttons shown during combat (see below)                                                     |

### Action Buttons

| Button              | Economy      | Condition                                                                    | Description                                                             |
| ------------------- | ------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Attack**          | Action       | Player's turn, action not yet spent, adjacent to any living enemy            | Make a melee attack; player stays in their turn after attacking         |
| **Second Wind**     | Bonus Action | Player's turn, bonus action not yet spent, Fighter only, uses remaining, not at full HP | Spend a use to heal 1d10 + level HP                          |
| **Hide**            | Bonus Action | Player's turn, bonus action not yet spent, Rogue only, not already hidden    | Attempt to hide (Cunning Action) for Sneak Attack advantage             |
| **End Turn**        | —            | Player's turn                                                                | Explicitly end the player's turn and pass initiative to the enemies     |
| **Roll Death Save** | —            | Player unconscious                                                           | Roll a d20 death saving throw                                           |
| **Communicate**     | —            | Exploring, Social Interaction encounter active                               | Initiate dialogue with selected NPC; logs "No target selected." if none |
| **Search**          | —            | Exploring, Exploration encounter active                                      | Roll Wisdom (Perception) to detect a secret on an adjacent tile         |
| **New Encounter**   | —            | Always visible                                                               | Trigger auto-save and return to the Encounter Setup screen              |
