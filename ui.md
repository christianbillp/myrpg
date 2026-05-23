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

- **Player Panel** — 300 px wide left sidebar, full canvas height; hidden by default, toggled by clicking the player token
- **Game Map** — tile-based play area between the two panels
- **Target Panel** — 300 px wide right sidebar, full canvas height; visible only when a creature is selected
- **HUD** — 130 px tall bar at the bottom, spanning full canvas width

---

## Player Panel

Defined in `client/src/ui/PlayerPanel.ts`. HTML DOM panel; hidden by default; toggled open/closed by clicking the player token on the Game Map.

| Component          | Description                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| **Name Header**    | Player name (in class colour) and species/class/level line                                               |
| **HP Bar**         | Colour-coded health bar: green > 50 %, orange > 25 %, red ≤ 25 %                                         |
| **HP Text**        | Numeric HP — "current / max"                                                                             |
| **Combat Stats**   | AC, Speed, Proficiency bonus, Initiative bonus                                                           |
| **Ability Scores** | All six scores (STR DEX CON INT WIS CHA) with modifiers                                                  |
| **XP Display**     | Current experience points                                                                                |
| **Quests**         | Section below XP listing quests assigned at encounter start. Each quest shows "· Title  N/M" while in progress and "✓ Title" when complete. "None" when no quests are active for the current encounter type. |
| **Action Buttons** | Context-sensitive combat buttons shown above INVENTORY/SEARCH (see below)                                |
| **INVENTORY**      | Button at the bottom of the panel; always visible when the panel is open. Opens the Inventory Overlay.   |
| **SEARCH**         | Button at the bottom of the panel; visible only during an Exploration encounter with secrets remaining. Rolls Wisdom (Perception) to detect a secret on an adjacent tile. |

### Action Buttons

| Button              | Economy      | Condition                                                                    | Description                                                             |
| ------------------- | ------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Attack**          | Action       | Player's turn, action not yet spent, adjacent to any living enemy            | Make a melee attack; player stays in their turn after attacking         |
| **THROW…**          | Action       | Player's turn, action not yet spent, no adjacent enemy, throwable item in inventory that can reach a living enemy | Open an inline item picker; select an item to throw at the nearest in-range enemy. Proper thrown weapons (javelin, dagger) use weapon stats and mastery; all other items are improvised (1d4 bludgeoning, STR mod, no proficiency bonus). Item is consumed on throw. |
| **Dash**            | Action       | Player's turn, action not yet spent                                          | Double remaining movement for this turn; applies `dashing` condition    |
| **Dodge**           | Action       | Player's turn, action not yet spent                                          | All incoming enemy attacks have Disadvantage until next turn; applies `dodging` condition |
| **Disengage**       | Action       | Player's turn, action not yet spent, at least one living enemy               | Prevent Opportunity Attacks when moving away from enemies this turn; applies `disengaged` condition |
| **Second Wind**     | Bonus Action | Player's turn, bonus action not yet spent, Fighter only, uses remaining, not at full HP | Spend a use to heal 1d10 + level HP                          |
| **Hide**            | Bonus Action | Player's turn, bonus action not yet spent, Rogue only, not already hidden    | Attempt to hide (Cunning Action) for Sneak Attack advantage             |
| **End Turn**        | —            | Player's turn                                                                | Explicitly end the player's turn and pass initiative to the enemies     |
| **Roll Death Save** | —            | Player unconscious                                                           | Roll a d20 death saving throw                                           |
| **Short Rest**      | —            | Exploring, player below max HP, Hit Dice remaining                           | Spend one Hit Die (d10+CON Fighter / d8+CON Rogue) to heal; resets each new encounter |

---

## Game Map

Rendered in `client/src/scenes/GameScene.ts`. Each tile = 5 ft. Occupies the area to the right of the Player Panel.

| Component               | Description                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Player Token**        | Coloured circle representing the player character; shows an HP bar overlaid at the top of the circle when damaged                     |
| **NPC Token**           | Coloured circle representing a non-player creature. All damaged tokens show an HP bar overlaid at the top of the circle. **Neutral** NPCs show their name just above the circle in the token colour; HP bar is blue-grey. **Enemy** NPCs show a red HP bar; letter labels A, B, C… are rendered in the centre of the token during combat and are hidden while exploring. **Ally** NPCs show a green HP bar; letter labels A, B, C… (uppercase, assigned from the same global pool as enemies) are rendered in the centre of the token during combat. |
| **Item Token**          | Small green diamond on a tile; walking onto it picks up the item                                                                      |
| **Movement Highlights** | Blue-tinted tiles showing reachable squares during the player's turn                                                                  |
| **Turn Order Bar**      | Semi-transparent HTML strip pinned to the top of the Game Map (rendered by `HUD.ts`); visible during combat. One chip per combatant (player first, then all non-neutral NPCs in initiative order). The active chip is highlighted green; dead chips are dimmed. All NPC chips show "A · Name" (uppercase label). |

---

## Target Panel

Defined in `client/src/ui/TargetPanel.ts`. HTML DOM panel; visible only when a creature is selected. Positioned on the right side of the Game Map, mirroring the Player Panel's width and layout.

Selection: clicking a creature in the Game Map selects it. The creature is highlighted with a coloured outline (its token colour). Clicking an empty tile or defeating the creature clears the selection and hides the panel.

| Component          | Description                                                      |
| ------------------ | ---------------------------------------------------------------- |
| **Name Header**    | Creature name (in token colour) and type/CR line                 |
| **HP Bar**         | Colour-coded health bar: green > 50 %, orange > 25 %, red ≤ 25 % |
| **HP Text**        | Numeric HP — "current / max"                                     |
| **Combat Stats**   | AC, Speed                                                        |
| **Ability Scores** | All six scores (STR DEX CON INT WIS CHA) with modifiers          |
| **Conditions**     | Active conditions in amber (e.g. `[DODGING]`, `[POISONED]`); hidden when none |

---

## HUD (Heads-Up Display)

Defined in `client/src/ui/HUD.ts`. HTML DOM bar spanning the full canvas width below the Game Map. Also renders the Turn Order Bar as a second HTML element pinned to the top of the grid area.

| Component           | Description                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Enemy Info**      | Top-right — enemy name, HP, and status tags (`[HIDDEN]`, `[VEXED]`)                                           |
| **Phase Text**      | Top-centre — current game phase ("Exploring", "Your turn — N moves", enemy name + "…", death save state); appends "· action used" or "· bonus used" when the respective resource has been spent this turn |
| **Combat Log**      | Two-column scrollable log: left column shows the narrative (what happened), right column shows the dice detail (rolls, bonuses, totals). Each row is colour-coded by outcome — grey (normal), green (hit), yellow (crit), red (kill), teal (heal), blue (status), bright (header), dim (miss). Newest entries appear at the bottom; scroll with the mouse wheel. |
| **Log Scroll Hint** | Small dim text showing scroll direction and how many newer entries are below                                  |
| **DUNGEON MASTER**  | Button — open the AIDM chat overlay; conversation history is preserved across open/close cycles               |
| **New Encounter**   | Button — trigger auto-save and return to the Encounter Setup screen                                           |

---

## Overlays

HTML DOM modals that appear on top of the game canvas. All overlays extend `BaseOverlay` (`client/src/ui/BaseOverlay.ts`), which provides a semi-transparent backdrop, a centred panel, and a × close button. Clicking outside the panel or clicking × closes them. `UIScale` (`client/src/ui/UIScale.ts`) positions all HTML panels over the canvas and keeps them in sync with window resize events.

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

Defined in `client/src/ui/AIDMOverlay.ts`. HTML DOM chat overlay powered by Claude Sonnet. DM responses are rendered as markdown using the `marked` library.

| Component            | Description                                                               |
| -------------------- | ------------------------------------------------------------------------- |
| **Title**            | "DUNGEON MASTER" header                                                   |
| **Persona Chips**    | STORY / DEV toggle in the header. **STORY** (default): enforces SRD 5.2.1 rules, narrative immersion. **DEV**: fulfils all requests without restriction for testing purposes. Persists across open/close cycles. |
| **History Area**     | Scrollable chat log. Player messages in amber (`▸ ` prefix). DM responses in cool white. Roll results on their own line in green (success) or red (failure), prefixed with 🎲. |
| **Scroll Bar**       | Thumb on right edge of history area; auto-scrolls to newest message      |
| **Input Box**        | Text input for the player's message (max 300 chars)                      |
| **Send Button**      | Submits the message; also triggered by Enter                             |
| **Status Text**      | "The Dungeon Master considers…" shown while the AI is responding         |

---

### Inventory Overlay

Defined in `client/src/ui/InventoryOverlay.ts`. HTML DOM overlay; opened via the INVENTORY button in the Player Panel.

| Component            | Description                                                               |
| -------------------- | ------------------------------------------------------------------------- |
| **Equipment Slots**  | Three rows: Armor, Weapon, Offhand (shield). Each shows the equipped item name and an UNEQUIP button |
| **Stats Bar**        | AC, current GP, and main attack summary shown at the bottom of the overlay |
| **Carried Items List** | Scrollable list of unequipped inventory items. Identical items are grouped with a ×N count |
| **Equip Button**     | Shown on equippable items; moves the item into the appropriate slot       |
| **Use Button**       | Shown on consumables; dimmed when the Bonus Action has already been spent |
| **Scroll Bar**       | Thumb on right edge; mouse-wheel scrollable when content overflows        |
