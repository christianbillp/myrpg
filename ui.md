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
| **Communicate**      | —            | Exploring, Social Interaction encounter active                               | Initiate dialogue with selected NPC; logs "No target selected." if none |
| **Search**           | —            | Exploring, Exploration encounter active                                      | Roll Wisdom (Perception) to detect a secret on an adjacent tile         |
| **DUNGEON MASTER**   | —            | Always visible                                                               | Open the AIDM chat overlay; conversation history is preserved across open/close cycles |
| **INVENTORY**        | —            | Always visible                                                               | Open the Inventory Overlay to inspect and manage equipment and consumables |
| **New Encounter**    | —            | Always visible                                                               | Trigger auto-save and return to the Encounter Setup screen              |

---

## Overlays

Full-screen panels that appear on top of the game. Clicking the × closes them.

### Introduction Overlay

Appears automatically when the game map loads. Must be dismissed before the player can act.

| Component            | Description                                                               |
| -------------------- | ------------------------------------------------------------------------- |
| **Encounter Chips**  | Colour-coded encounter-type chips (Combat red, Exploration green, Social blue) |
| **Player Summary**   | Player name and class line                                                |
| **Introduction Text**| Narrative paragraph generated server-side for the encounter              |
| **Dismiss Button**   | Closes the overlay and begins play                                        |

---

### AIDM Overlay

Defined in `client/src/ui/AIDMOverlay.ts`. Full-screen chat interface powered by Claude Sonnet.

| Component            | Description                                                               |
| -------------------- | ------------------------------------------------------------------------- |
| **Title**            | "DUNGEON MASTER" header                                                   |
| **Persona Chips**    | STORY / DEV toggle in the header. **STORY** (default): enforces SRD 5.2.1 rules, narrative immersion. **DEV**: fulfils all requests without restriction for testing purposes. Persists across open/close cycles. |
| **History Area**     | Scrollable chat log; player messages prefixed with `>`, DM responses indented |
| **Scroll Bar**       | Thumb on right edge of history area; auto-scrolls to newest message      |
| **Input Box**        | Text input for the player's message (max 300 chars)                      |
| **Send Button**      | Submits the message; also triggered by Enter                             |
| **Status Text**      | "The Dungeon Master considers…" shown while the AI is responding         |

---

### Inventory Overlay

Defined in `client/src/ui/InventoryOverlay.ts`. Opened via the INVENTORY HUD button.

| Component            | Description                                                               |
| -------------------- | ------------------------------------------------------------------------- |
| **Equipment Slots**  | Three rows: Armor, Weapon, Offhand (shield). Each shows the equipped item name and an UNEQUIP button |
| **Stats Bar**        | Live AC and attack bonus summary updated whenever gear changes            |
| **Carried Items List** | Scrollable list of unequipped inventory items. Identical items are grouped with a ×N count |
| **Equip Button**     | Shown on equippable items; moves the item into the appropriate slot       |
| **Use Button**       | Shown on consumables; dimmed when the Bonus Action has already been spent |
| **Scroll Bar**       | Thumb on right edge; mouse-wheel scrollable when content overflows        |
