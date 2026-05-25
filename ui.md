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

Defined in `client/src/ui/PlayerPanel.ts`. HTML DOM panel; **open by default** (200 px wide); toggled open/closed by clicking the player token on the Game Map. The panel is resizable — drag the right edge to any width between 120 px and 480 px; the chosen width is persisted in `localStorage`. Resize is DOM-only: the game map canvas origin is fixed at 200 px from the left edge.

| Component          | Description                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| **Name Header**    | Player name (in class colour) and species/class/level line                                               |
| **HP Bar**         | Colour-coded health bar: green > 50 %, orange > 25 %, red ≤ 25 %                                         |
| **HP Text**        | Numeric HP — "current / max". AC, ability scores, saving throws, XP, gold, and other static stats live in the Character Sheet overlay (Character tab); the Player Panel keeps only at-a-glance combat state. |
| **Spell Slots**    | One-line summary of remaining spell slots per level (e.g. "Slots: L1 2/2"). Visible only when the character knows at least one spell slot tier. |
| **Feature Resource Chips** | One-line summary of class-feature resource pools (e.g. "Second Wind: 2/2"). Visible when the character knows at least one feature with a `resourceLabel` and a non-`unlimited` resource. Each feature's template is rendered with `{remaining}`/`{max}` placeholders. Multiple chips join with " · ". |
| **Concentration Chip** | Single-line indicator visible only while the player is concentrating on a spell. Format: "🌀 Concentrating: <Spell Name>". Cleared when concentration breaks (failed CON save on damage, replaced by a new concentration spell, or incapacitation). |
| **Quests**         | Section listing quests assigned at encounter start. Each quest shows "· Title  N/M" while in progress and "✓ Title" when complete. "None" when no quests are active for the current encounter type. |
| **Action Buttons** | Context-sensitive combat buttons shown above CHARACTER/SEARCH (see below). Replaced by a **Spell Targeting Prompt** ("Select target for: SPELL_NAME") while spell-targeting mode is active. For attack-roll spells the prompt waits for a creature click; for AOE spells the affected tiles preview as an orange chebyshev disc that follows the cursor (or stays anchored on the player for self-range spells like Burning Hands), and clicking any tile fires the spell on that area. ESC cancels in either mode. |
| **CHARACTER**      | Button at the bottom of the panel; always visible when the panel is open. Opens the Character Sheet Overlay (tabs: Character / Inventory / Spells). |
| **SEARCH**         | Button at the bottom of the panel; visible only during an Exploration encounter with secrets remaining. Rolls Wisdom (Perception) to detect a secret on an adjacent tile. |
| **END TURN**       | Button at the bottom of the panel; visible only during `player_turn`. Ends the player's turn and passes initiative to the enemies. |
| **LEAVE ENCOUNTER**| Button at the very bottom of the panel; always visible. Triggers auto-save and returns to the Encounter Setup screen. |

### Action Buttons

| Button              | Economy      | Condition                                                                    | Description                                                             |
| ------------------- | ------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **ATTACK**          | Action       | A non-ally target is selected within the equipped weapon's reach (1 tile for melee, `rangeLong/5` tiles for ranged), action not yet spent, and — for ranged weapons — at least one matching ammo item in inventory | Make an attack with the equipped weapon. Auto-routes between melee and ranged from `mainAttack.rangeNormal`. The button is two-line and shows the weapon name in parentheses below — e.g. *ATTACK / (Shortbow)*. Ranged shots consume one ammo per attack; on every shot there is a 50% chance the round lands on the target's tile as a recoverable map item. Beyond the weapon's normal range imposes Disadvantage; beyond long range disables the button. |
| **THROW…**          | Action       | Player's turn, action not yet spent, throwable item in inventory that can reach a living enemy | Open an inline item picker; select an item to throw at the nearest in-range enemy. Proper thrown weapons (javelin, dagger) use weapon stats and mastery; all other items are improvised (1d4 bludgeoning, STR mod, no proficiency bonus). On a hit the item enters the target's inventory (dropped at their tile on death); on a miss it lands on the map at the target's tile. |
| **↩ CANCEL**        | —            | Throw picker is open                                                         | Close the throw picker without spending any resource                    |
| **DASH**            | Action       | Player's turn, action not yet spent                                          | Double remaining movement for this turn; applies `dashing` condition    |
| **DODGE**           | Action       | Player's turn, action not yet spent                                          | All incoming enemy attacks have Disadvantage until next turn; applies `dodging` condition |
| **DISENGAGE**       | Action       | Player's turn, action not yet spent, at least one living enemy               | Prevent Opportunity Attacks when moving away from enemies this turn; applies `disengaged` condition |
| **Class Feature Buttons** | Varies (per-feature) | Character's `defaultFeatureIds` includes the feature, `usableFeatureIds` reports it usable | One button per known class feature (Second Wind, future Rage, Channel Divinity, …). Label / colour / resource chip are pulled from the feature's `ui` block in [`features/`](data_structure.md#features-1). The Player Panel iterates `state.features` to render these — there's no per-class hard-coding in the panel. Disabled when the server's `canUseFeature` guard fails (resource exhausted, action economy spent, situational gate not met). |
| **HIDE**            | Varies       | Rogue only, not already hidden; either Exploring (free, no resource cost), or Player's turn with the right resource available | Attempt to hide. Cost depends on phase and class level: in `exploring` it's free (no action economy applies — used to set up a Sneak Attack opener against currently-neutral NPCs); during `player_turn` a Level 1 Rogue spends the **Action**, a Level 2+ Rogue spends a **Bonus Action** via Cunning Action. Stealth roll is opposed by the highest Passive Perception among any non-ally, non-dead, non-incapacitated NPC on the map. Success applies the `hidden` condition; failure clears it. The condition grants Advantage on the next attack (which then triggers Sneak Attack for Rogues) and is cleared automatically after attacking. |
| **MOVE**            | —            | Exploring, or player's turn with moves remaining                              | Toggle move-mode: yellow tile overlay shows reachable squares; clicking a tile path-walks the player along the cheapest route. In combat, the reach is capped by remaining movement; in exploration, the entire reachable map is highlighted. Press ESC or the MOVE button again to exit. |
| **ROLL DEATH SAVE** | —            | Player unconscious                                                           | Roll a d20 death saving throw                                           |
| **SHORT REST**      | —            | Exploring, player below max HP, Hit Dice remaining                           | Spend one Hit Die (d10+CON Fighter / d8+CON Rogue) to heal; resets each new encounter |

---

## Game Map

Rendered in `client/src/scenes/GameScene.ts`. Each tile = 5 ft. Occupies the area to the right of the Player Panel.

Hand-crafted maps draw their tiles from the image tileset declared in the map JSON: each cell is rendered as `this.add.image(...)` using the spritesheet frame at `gid − firstgid`. Hand-crafted maps with two layers (`terrain` + `objects`) draw the ground layer first, then the object layer on top — passable object cells (chairs, bushes, doors) show the ground tile through where the object is transparent. Map sprites render at `MAP_TILE_ALPHA = 0.7` opacity so the dark Phaser scene background bleeds through, darkening the overall map without obscuring detail. Maps without an image tileset (the procedural Arena/Dungeon/etc. generators) fall back to a flat coloured fill — light grey for passable tiles, dark slate for impassable.

| Component               | Description                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Player Token**        | Coloured circle representing the player character; shows an HP bar overlaid at the top of the circle when damaged                     |
| **NPC Token**           | Coloured circle representing a non-player creature. All damaged tokens show an HP bar overlaid at the top of the circle. **Neutral** NPCs show their name just above the circle in the token colour (the revealed name once `reveal_npc_name` fires, otherwise the generic NPC name); HP bar is blue-grey. **Enemy** NPCs show a red HP bar; their `combatLabel` (A, B, C…) is rendered in the centre of the token during combat and hidden while exploring. **Ally** NPCs show a green HP bar; their `combatLabel` is rendered in the centre during combat; once their name is revealed it replaces the generic name above the token. **Dead NPCs (corpses)** remain on the map at 40% opacity with no HP bar and no label; clicking a corpse selects it and opens the Target Panel (showing the corpse's stats) but dead tokens cannot be attacked or targeted for any game effect. |
| **Item Token**          | Small green diamond on a tile; walking onto it picks up the item                                                                      |
| **Movement Highlights** | Blue-tinted tiles showing reachable squares during the player's turn                                                                  |
| **Spell Aura Ring**     | White ring around the player while concentrating on a sense-radius spell. Currently rendered for **Detect Magic** as a 6-tile (30 ft) radius circle with a faint white inner fill. Drawn each state update and cleared when concentration ends. |
| **AOE Spell Preview**   | Orange tiles showing the affected area while spell-targeting mode is active for an AOE spell. Follows the cursor for ranged AOEs (e.g. Sleep — chebyshev disc around the hovered tile) or stays anchored on the player tile for self-range spells (e.g. Burning Hands — 15-ft cone treated as a 3-tile chebyshev disc). Cleared when the spell fires or targeting is cancelled. |
| **Turn Order Bar**      | Semi-transparent HTML strip pinned to the top of the Game Map (rendered by `HUD.ts`); visible during combat. One chip per combatant **in true Initiative order** — the player chip may appear anywhere in the row depending on their roll, not always first. The order is taken from `state.turnOrderIds` (sorted by descending `initiativeRoll`, tiebroken by DEX mod / `initiativeBonus`). The active chip is highlighted green; dead chips are dimmed to 30% opacity. All NPC chips show "Name (A)" — monster name followed by `combatLabel` in parentheses — matching the combat-log turn header convention ("Name (A)'s turn"). The player chip shows the player name without a label. |

---

## Target Panel

Defined in `client/src/ui/TargetPanel.ts`. HTML DOM panel; visible only when a creature is selected. Positioned on the right side of the Game Map (200 px wide by default). The panel is resizable — drag the left edge to any width between 120 px and 480 px; the chosen width is persisted in `localStorage`. Resize is DOM-only: the game map canvas right boundary is fixed.

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

Defined in `client/src/ui/HUD.ts`. HTML DOM bar spanning the full canvas width below the Game Map. Also renders the Turn Order Bar as a second HTML element pinned to the top of the grid area. The HUD height is user-resizable (drag the top edge); the chosen height is persisted in `localStorage`.

### Tab Bar

Two tabs switch the HUD content area:

| Tab              | Description                                              |
| ---------------- | -------------------------------------------------------- |
| **COMBAT LOG**   | Shows the two-column scrollable combat log               |
| **DUNGEON MASTER** | Shows the inline DM chat panel                         |

### Combat Log tab

| Component           | Description                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Combat Log**      | Two-column scrollable log: left column shows the narrative (what happened), right column shows the dice detail (rolls, bonuses, totals). Each row is colour-coded by outcome — grey (normal), green (hit), yellow (crit), red (kill), teal (heal), blue (status), bright (header), dim (miss). Newest entries appear at the bottom; scroll with the mouse wheel. Text is selectable and can be copied. |

### Dungeon Master tab

| Component           | Description                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Persona Chips**   | **STORY** / **DEV** toggle. **Story DM** (default): enforces SRD 5.2.1 rules and in-world logic. **Dev DM**: fulfils all requests without restriction; replies with brief mechanical feedback. Persists across tab switches for the duration of the encounter. |
| **Chat Area**       | Scrollable conversation history. Player messages in amber (`▸` prefix). DM responses in cool white, rendered as markdown, **streamed live** — text appears as the AI generates it rather than after the full reply completes. Roll results on their own line (green success / red failure) prefixed with 🎲. Text is selectable and can be copied. |
| **Status Text**     | "The Dungeon Master considers…" shown while the AI is responding (visible until the first chunk arrives).      |
| **Mode Button**     | Dropup button on the left of the input row. **DM** (default): message goes directly to the DM. **Say to [Name]**: message is prefixed with `[PlayerName says to Target]:` and sent in-character; only available when a living NPC is selected. Updates to show the NPC's revealed name once it is known. |
| **Input Box**       | Text input (max 300 chars). Submits on Enter. WASD movement is disabled while the input is focused.          |
| **Send Button**     | Submits the message.                                                                                          |

---

## Overlays

HTML DOM modals that appear on top of the game canvas. Most overlays extend `BaseOverlay` (`client/src/ui/BaseOverlay.ts`), which provides a semi-transparent backdrop, a centred panel, and a × close button; `UIScale` positions them over the canvas and keeps them in sync with window resize events. **Exception:** `StorylogOverlay` is a standalone overlay that does not extend `BaseOverlay` and has no `UIScale` dependency, because it is opened from the Encounter Setup Scene where no `UIScale` instance exists.

### Introduction Overlay

Appears automatically when the game map loads for the first time. Suppressed when the player reconnects to an existing session (browser reload). Dismissed by clicking × or the backdrop.

| Component            | Description                                                               |
| -------------------- | ------------------------------------------------------------------------- |
| **Encounter Title**  | Name of the encounter (e.g. "The Goblin Cave") in accent colour          |
| **Player Summary**   | Player name and class line                                                |
| **Introduction Text**| Narrative paragraph generated server-side for the encounter              |

---


### Story Log Overlay

Defined in `client/src/ui/StorylogOverlay.ts`. Standalone HTML overlay (no `BaseOverlay`/`UIScale` dependency); opened from the Encounter Setup Scene via the STORY LOG button on a character card.

| Component            | Description                                                               |
| -------------------- | ------------------------------------------------------------------------- |
| **Title**            | "STORY LOG" label and character name                                      |
| **Entry List**       | Scrollable list of encounters in chronological order (oldest first). Each entry shows the date and encounter type in a dim header row, followed by the AI-generated prose narrative. Dialogue within narratives is rendered in italics. Entries not yet generated show "Not yet written." in dim italic text. |
| **GENERATE N ENTRIES** | Footer button; active when one or more encounters lack a narrative. Label shows the count of missing entries. Disabled (greyed, no-op on click) when all encounters are covered. |
| **[DEV] REWRITE ALL** | Absolutely-positioned in the bottom-right corner of the panel (not in the footer row). Very dim styling; visible only in dev mode. Regenerates every entry from scratch regardless of existing content. Not intended for regular play. |

---

### Character Sheet Overlay

Defined in `client/src/ui/CharacterSheetOverlay.ts`. HTML DOM overlay; opened via the CHARACTER button in the Player Panel. 580 × 480 px panel with a tab bar at the top and content area below. State updates trigger a live rebuild (server `state_update` → `OverlayManager.refreshCharacterSheetIfOpen`) so equip / cast / damage feedback is reflected without reopening.

| Tab           | Visibility                                                                | Contents                                                                                                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Character** | Always                                                                    | Identity header (color swatch + name + species/class/level); five-cell stat strip (HP, AC, Speed, Initiative, Proficiency); six-cell ability score grid with modifiers; saving throws with proficiency dots; resources line (XP, gold, passive perception) and concentration chip when a spell is being concentrated on. |
| **Inventory** | Always (default tab)                                                      | Three equipment slot cards (Armor / Weapon / Offhand) with UNEQUIP buttons; scrollable carried-items list rendering four categories in order — equippable (EQUIP button), consumables (USE button, dimmed when Bonus Action spent), ammunition (AMMO badge), gear (GEAR badge); stats bar at the bottom with AC / GP / main attack summary. Carries forward all rules from the pre-tab inventory panel: armor blocked from equip/unequip during combat (SRD donning time); weapon/shield first swap is free, second costs the Utilize Action. |
| **Spells**    | Caster only (`PlayerDef.spellcastingAbility` set)                         | Three-cell header (Spell Save DC / Spell Attack Bonus / per-level slot pool `L1 N/M`); three sections — Cantrips (always known), Prepared (currently castable), and Spellbook · Unprepared (known but not prepared this rest). Each spell row shows the name, a short mechanical summary (damage dice, save ability+DC, area / range, Concentration / Ritual tags), the level tag (`cantrip` / `L1`), and up to two action buttons: **CAST** (visible when the engine considers the spell castable right now — closes the sheet and, for spells that need a creature target, enters spell-targeting mode in the Player Panel; for self / AOE spells, fires immediately), and **RITUAL CAST** (visible for Ritual-tag spells the character knows during the exploring phase — casts as a ritual, no spell slot consumed). A spell that is both prepared and Ritual shows both buttons. |
| **Close (×)** | Top-right corner; closes the overlay (Backdrop click also closes).        |                                                                                                                                                                                                                                                                     |

---

### Reaction Prompt Overlay

Defined in `client/src/ui/ReactionPromptOverlay.ts`. Modal overlay surfaced when the server pauses on a reaction-eligible trigger (currently Opportunity Attack and Shield). Opened and closed by `OverlayManager.syncReactionPrompt(state)`, which mirrors `state.pendingReaction`. While the overlay is open, the engine's turn loop is paused on the server — the next player action must be a `resolveReaction`.

| Component | Description |
| --------- | ----------- |
| **Title** | `OPPORTUNITY ATTACK` or `REACTIVE SHIELD`. |
| **Body**  | Context — for OA: which creature is moving out of reach. For Shield: the attacker's roll total, the damage that would land, and the AC the player would have with Shield up. |
| **TAKE REACTION** button | Accept the prompt. Server fires the deferred effect (OA melee swing / Shield consumes a 1st-level slot + reaction and negates the hit) and resumes the turn loop. |
| **TAKE NO REACTION** button | Decline. Server skips the deferred effect (Shield: incoming damage is applied normally; OA: enemy escapes unscathed) and resumes the turn loop. |
| **Close (×) / Backdrop click** | Treated as "Take no reaction" — never spends the player's reaction or spell slot. |
