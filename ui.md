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
| **Objective**      | One-line player-facing goal for the encounter, accent-coloured (`#e2b96f`). Sourced from `GameState.objective` (set per encounter in JSON, with a default derived from `encounterTypes` when omitted). Rendered immediately above the Quests list. |
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
| **Player Token**        | SVG token rendered from `PlayerDef.tokenAsset` (or the convention-derived `/tokens/player_<class>_<species|lineage>.svg`). Drawn at TILE_SIZE − 6 px, with an HP bar overlaid at the top of the body when damaged. If the SVG texture fails to load the body falls back to a coloured circle in `DEFAULT_TOKEN_COLOR` (0x3388ff). |
| **NPC Token**           | SVG token rendered from `MonsterDef.tokenAsset` (`/tokens/monster_<id>.svg`) with an optional `NPCDef.tokenAsset` override (`/tokens/npc_<id>.svg`); NPCs without their own SVG fall back to the monster's. All damaged tokens show an HP bar overlaid at the top of the body. **Nameplate** above the token reads in the unified `DEFAULT_TOKEN_COLOR_HEX` accent (`#3388ff`) — visible only when the **LABELS** chip in the GM panel is active (the default is OFF, so the map opens with a clean view; names are still accessible via the Target Panel and tooltip on the turn-order chip). **Neutral** NPCs show the revealed name once `reveal_npc_name` fires (otherwise the generic NPC name); HP bar is blue-grey. **Enemy** NPCs show a red HP bar; their `combatLabel` (A, B, C…) is rendered in the centre of the token during combat and hidden while exploring. **Ally** NPCs show a green HP bar; their `combatLabel` is rendered in the centre during combat. **Dead NPCs (corpses)** remain on the map at 40% opacity with no HP bar and no label; clicking a corpse selects it and opens the Target Panel but dead tokens cannot be attacked or targeted. |
| **Item Token**          | Small green diamond on a tile; walking onto it picks up the item                                                                      |
| **Movement Highlights** | Blue-tinted tiles showing reachable squares during the player's turn                                                                  |
| **Spell Aura Ring**     | White ring around the player while concentrating on a sense-radius spell. Currently rendered for **Detect Magic** as a 6-tile (30 ft) radius circle with a faint white inner fill. Drawn each state update and cleared when concentration ends. |
| **AOE Spell Preview**   | Orange tiles showing the affected area while spell-targeting mode is active for an AOE spell. Follows the cursor for ranged AOEs (e.g. Sleep — chebyshev disc around the hovered tile) or stays anchored on the player tile for self-range spells (e.g. Burning Hands — 15-ft cone treated as a 3-tile chebyshev disc). Cleared when the spell fires or targeting is cancelled. |
| **Turn Order Bar**      | **Transparent**, borderless HTML strip pinned to the top of the Game Map (rendered by `HUD.ts`); visible during combat. One chip per combatant **in true Initiative order** — the player chip may appear anywhere in the row depending on their roll, not always first. The order is taken from `state.turnOrderIds`. Each chip is a square SVG **token tile** (the same artwork as the on-map token) with no border or background; the active combatant's chip is **30% bigger** (47 × 47 px vs 36 × 36 px) and grows downward from the top edge so resting chips stay aligned. Dead chips dim to 30% opacity. NPC chips carry a small bottom-right **combat-label badge** (`A`, `B` …) when applicable; the player chip carries no badge. Hovering a chip surfaces the creature's name via the browser tooltip. The "currently active" highlight is also driven client-side by animation tracking: while an `entity_move` event for an NPC plays, that NPC's chip reads as active even though the server has already advanced past their turn — without this override no NPC would ever appear active because the engine flips `isActive` atomically. |

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
| **Faction**        | One-line `FACTION  <name>` row. **Hidden** when the selected NPC's `factionId` doesn't match any entry in `defs.factions` (raw-monster faction-of-one). **`FACTION  ???`** in dim text when the faction is known to the engine but the player hasn't yet identified it (the combat-start Insight check missed, or no fight has happened with this faction yet). **`FACTION  <DisplayName>`** in the faction's `displayColor` once it's been identified — either by passing the Insight check or by the AIGM calling the `reveal_faction` tool. The row re-renders on every state tick so a mid-encounter reveal flips the chip in place. |

---

## HUD (Heads-Up Display)

Defined in `client/src/ui/HUD.ts`. HTML DOM bar spanning the full canvas width below the Game Map. Also renders the Turn Order Bar as a second HTML element pinned to the top of the grid area. The HUD height is user-resizable (drag the top edge); the chosen height is persisted in `localStorage`.

### Tab Bar

Two tabs switch the HUD content area:

| Tab              | Description                                              |
| ---------------- | -------------------------------------------------------- |
| **EVENT LOG**    | Shows the two-column scrollable event log                |
| **GAME MASTER** | Shows the inline GM chat panel                            |

### Event Log tab

| Component           | Description                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Event Log**       | Two-column scrollable log: left column shows the narrative (what happened), right column shows the dice detail (rolls, bonuses, totals). Each row is colour-coded by outcome — grey (normal), green (hit), yellow (crit), red (kill), teal (heal), blue (status), bright (header), dim (miss). Newest entries appear at the bottom; scroll with the mouse wheel. Text is selectable and can be copied. The log is **seeded at session creation** with the encounter title, the introduction prose (each line as a `status` entry), and the `Objective:` line, so a player can scroll back to re-read scene context. The deterministic engine writes every mechanical event here (attacks, hits/misses, damage, kills, dashes / dodges / disengages, opportunity attacks, item pickups, concentration changes, spell casts, class-feature uses, trigger-driven narration variants, combat-start/turn-order markers). Combined with the seed, the log is sufficient to play a full encounter without ever opening the GM tab — the GM panel is strictly additive. |

### Game Master tab

| Component           | Description                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Persona Chips**   | **STORY** / **DEV** toggle in the top-left of the panel header. **Story GM** (default): enforces SRD 5.2.1 rules and in-world logic. **Dev GM**: fulfils all requests without restriction; replies with brief mechanical feedback. Persists across tab switches for the duration of the encounter. |
| **LABELS Chip**     | Toggle on the right of the top-of-panel chip row. **Active** (blue border + bright text): NPC nameplates are visible above their tokens. **Inactive** (greyed): nameplates hidden so the map reads cleanly. Defaults to **off** at session start. Newly-spawned NPCs (e.g. mid-combat `spawn_enemy`) honour the current preference. Combat labels (`A` / `B` …) inside tokens are not affected — those are functional, not decorative. |
| **Chat Area**       | Scrollable conversation history. Player messages in amber (`▸` prefix). GM responses in cool white, rendered as markdown, **streamed live** — text appears as the AI generates it rather than after the full reply completes. Roll results on their own line (green success / red failure) prefixed with 🎲. Text is selectable and can be copied. |
| **Status Text**     | "The Game Master considers…" shown while the AI is responding (visible until the first chunk arrives).      |
| **Mode Button**     | Dropup button on the left of the input row. **GM** (default): message goes directly to the GM. **Say to [Name]**: message is prefixed with `[PlayerName says to Target]:` and sent in-character; only available when a living NPC is selected. Updates to show the NPC's revealed name once it is known. |
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

Defined in `client/src/ui/StorylogOverlay.ts`. Standalone HTML overlay (no `BaseOverlay`/`UIScale` dependency); opened from either the Encounter Setup Scene or the Adventure Setup Scene via the STORY LOG button on a character card. The Adventure Setup Scene's DELETE SAVE button next to it clears **both** the character save and the adventure save for that character, so the player can replay the adventure from chapter 1 with default gear.

---

### Generator Setup Scene

`client/src/scenes/GenerateSetupScene.ts` — third top-level setup scene reached via `MainMenuScene → GENERATE ENCOUNTER`. **No character selector** on this screen; after authoring an encounter the player is handed off to Encounter Setup Scene with the new encounter pre-selected (via `init({ presetEncounterId })`) so the character pick happens there. The scene is structured as two tabs.

**Tab bar.** A pair of buttons at the top center of the scene: **DETERMINISTIC** and **GENERATIVE AI**. The active tab is highlighted with the accent colour; clicking switches which content container is visible and which bottom-bar buttons are wired up. The Deterministic tab is selected by default.

#### Deterministic tab

The deterministic tab is gated on an **accepted map**. The left panel always shows the map controls; the right panel changes shape depending on whether a map has been accepted.

| Component | Description |
| --------- | ----------- |
| **MAP CONTROLS** (left) | Header label over the left panel. |
| **TERRAIN chips** | `GRASSLAND` / `FOREST` radio chips. Exactly one must be selected for the COMPOSE MAP button to enable; Grassland is selected by default. |
| **FEATURES chips** | `RUINS` / `BUILDINGS` / `CAMPSITES` / `PATH` multi-select chips. Features layer additional content on top of the chosen terrain in `MapComposer.composeMap`. The `PATH` feature lays a meandering dirt path across the map before other features stamp over it. |
| **ENCOUNTER SETTINGS** (right) | Header label over the right panel. **Empty state** (no map accepted): the panel only renders the label `No map available` plus a hint reading "Compose a map on the left, then press ACCEPT in the preview." No other controls appear. **Filled state** (map accepted): the panel renders the thumbnail, zone painter, encounter-type chips, monster picker, and description textarea described below. |
| **Thumbnail + zone painter** *(filled state)* | Small map preview pinned to the top-right of the right panel. Renders the accepted map at up to ~12 px per tile using the actual scribble spritesheet (tile size auto-shrinks to fit the panel). Cells are interactive: when `PAINT: PLAYER` is active, clicking a cell toggles it as a player-start zone (blue 50%-alpha overlay); when `PAINT: ENEMY` is active, clicking toggles an enemy-start zone (red 50%-alpha overlay). Click-and-drag paints / unpaints continuously. A cell can be either player or enemy, not both — repainting in the opposite mode swaps the assignment. **Trigger regions** authored in the TriggerEditor (right column) are drawn on top of the thumbnail as colour-coded outlined rectangles — perception = teal, log = pale blue, AIDM cue = amber, combat = red — so the author sees exactly which tiles fire each trigger. The outlines refresh on every TriggerEditor edit (kind, region x/y/w/h) via an `onChange` callback. **When no paint mode is active**, clicking any cell instead opens the [Map Preview Overlay](#map-preview-overlay) in view-only mode with the painted zones AND trigger regions drawn on top — useful for inspecting a busy map at higher zoom. A small caption below the thumbnail reads `Map Name · click to enlarge`. |
| **PAINT: PLAYER / PAINT: ENEMY / CLEAR ZONES** *(filled state)* | Mode toggles below the thumbnail caption. PAINT: PLAYER and PAINT: ENEMY are mutually exclusive radios that activate the painter; click again to deactivate. CLEAR ZONES wipes all painted cells. While both modes are off, clicking the thumbnail opens the enlarged view-only preview instead of painting. |
| **Encounter type chips** *(filled state)* | COMBAT / SOCIAL / EXPLORATION toggles (multi-select), positioned to the left of the thumbnail. At least one is required for non-combat `completionFlag` generation; defaults route to `exploration`. |
| **DESCRIPTION textarea** *(filled state)* | Multi-line input under the encounter-type chips. Width auto-fits the space remaining beside the thumbnail. Optional. Its value is written to the new encounter's `customContext` so the in-game GM has scene context to work with. |
| **MONSTERS picker** *(filled state)* | Full-width scrollable list below the thumbnail / description columns (positioned below whichever ends lower). Lists every entry in the `monsters` registry. Each row shows the monster name, type, and max HP plus two side buttons: `+ ALLY` (adds the monster to the encounter's `allyIds`, spawned with friendly disposition near the player zone) and `+ ENEMY` (adds to the encounter's `enemyIds`, spawned at painted enemy zones with hostile disposition and an auto-assigned combat label). Both fields accept raw monster ids — the engine's `spawnNpc` falls back to the monster roster when an id isn't found in the NPC roster, so authoring a named NPC wrapper is not required. The same monster can be added multiple times — the picker tracks counts. A summary line beneath the picker shows `ALLIES: …` and `ENEMIES: …` with counts; a `CLEAR MONSTERS` button at the right of the summary wipes both selections. The list scrolls with the mouse wheel when the cursor is over it (the wheel listener is bounded by pointer position — no hit-target rectangle is layered over the row buttons, so `+ ALLY` / `+ ENEMY` remain clickable). |
| **★ RANDOMIZE** button | Bottom row (leftmost action). Rolls a weighted pick from `client/src/data/encounterArchetypes.ts`, composes the map **in memory only**, then **populates** every Adjudicator-tab field so the user can inspect or edit before committing — terrain + features chips flip to the rolled values, the title / introduction / description / objective / completion-flag inputs are filled in, the zone painter is pre-painted with PLAYER (blue) + NEUTRAL (amber) cells anchored to story-relevant features (dungeon entrance, campfire, ruin), the monsters picker is pre-loaded with rolled `+ ALLY` / `+ NEUTRAL` selections, and the trigger editor is pre-loaded with 2-3 rolled triggers anchored to the same map features (perception checks at the path, AIDM cues at the vault, combat starts inside the bandit camp / ruined nave / dungeon vault, etc.). **Rolled hostile-intent monsters spawn neutral, not enemy** — encounters start in exploration phase. Combat starts when the player attacks one (faction aggro wakes the rest) or when a `combat`-kind trigger fires (flipping every rolled type to enemy in one action). Neither the map nor the encounter is persisted — the user must press SAVE ENCOUNTER (which saves both) to commit. The status line confirms which archetype was rolled. |
| **PICK MAP** button | Bottom row. Opens the [Map Selector Overlay](#map-selector-overlay) — a grid of every saved map. Clicking a card sets it as the accepted map (bypassing COMPOSE MAP), clears any pending rolled state, and rebuilds the right panel. |
| **COMPOSE MAP** button | Bottom row. Composes the map deterministically via `POST /generate/map/composed`, then opens the Map Preview Overlay with REGENERATE / **SAVE** / CLOSE buttons. Iterating without saving does not modify the right panel. |
| **SAVE ENCOUNTER** button | Bottom row (rightmost). Persists the encounter from the current form state (title / intro / description / objective / completion-flag + painted starting zones + monster picker selections + triggers). When the preconditions aren't met it stays clickable but greyed; clicking surfaces a hint in the status line ("Compose or pick a map first.", "Paint at least one player-start cell on the thumbnail (PAINT: PLAYER).") instead of going silent. Once enabled (a map has been composed or picked + ≥1 player cell painted), this is the **single commit step**: if the map hasn't been persisted yet (e.g. a RANDOMIZE roll), the button calls `saveMap` itself before posting `POST /generate/encounter/composed` with `existingMapId` (the just-saved map), the painted starting zones, the description, the ally / enemy / neutral id lists, and the painted triggers. On success, navigates to Encounter Setup Scene with the new encounter pre-selected. The RANDOMIZE button populates the same fields this button reads, so a randomized scenario can be reviewed and tweaked before being saved. |

All disabled buttons across both tabs follow the same "stay clickable, surface a hint" pattern (e.g. on the Generative AI tab, clicking a disabled GENERATE button while the prompt is empty surfaces "Type a scene description (at least 8 characters), or click an example card on the right.").

#### Generative AI tab

| Component | Description |
| --------- | ----------- |
| **DESCRIBE THE SCENE** (left) | Header label over the left panel. |
| **Prompt textarea** | Multi-line HTML textarea sized to the left panel. The player describes the scene in 2-3 sentences. Required (≥ 8 chars) to enable either bottom button. |
| **Encounter type chips** | COMBAT / SOCIAL / EXPLORATION toggles below the textarea. Optional; leave all off to let the AI pick. |
| **EXAMPLE PROMPTS** (right) | Header label over the right panel. |
| **Example cards** | Six vertical cards (Moonlit Graveyard, Goblin Warren, Riverside Ambush, Abandoned Watchtower, Crossroads Market, Wolf Den). Each card shows a title and a one-paragraph body. Clicking a card **copies the body into the prompt textarea** so the player can edit or extend it. Cards do not auto-submit. |
| **GENERATE MAP ONLY** button | Bottom row (left). Asks Claude for just a map via `POST /generate/map`, then opens the Map Preview Overlay for iteration. |
| **GENERATE ENCOUNTER** button | Bottom row (right). Asks Claude for a full scenario via `POST /generate/encounter`, then navigates to Encounter Setup Scene with the new encounter pre-selected. While the call is in flight, the status line below reads "The Game Master is building your encounter…". On error the status line shows the rejection message and the button re-enables. |

#### Shared

| Component | Description |
| --------- | ----------- |
| **BACK** button | Bottom-left. Returns to MainMenuScene. |
| **Status line** | DOM div above the bottom button row showing in-flight messages ("Composing map…", "Generating encounter…") and any error returned by the server. |
| **[DEV] DELETE ALL GEN MAPS** | Corner button at the bottom-right, gated behind `DevMode.enabled`. Calls `DELETE /generate/maps/all` to unlink every `gen_*.json` from `server/data/maps/` and `server/data/encounters/`, then refreshes `loadDefs()`. Slotted into leftover space so it doesn't shift any non-dev layout. |

Generated encounters are saved to `server/data/encounters/gen_<timestamp>_<slug>.json` and `server/data/maps/gen_<timestamp>_<slug>.json`. On the Encounter Setup Scene, generated encounter cards display a `✦ GENERATED` badge in their top-right corner so they're visually distinct from hand-authored ones.

---

### Map Preview Overlay

`client/src/ui/MapPreviewOverlay.ts`. In-scene Phaser overlay (not a `BaseOverlay` HTML modal — it needs to render the tileset spritesheet) opened from the COMPOSE MAP and GENERATE MAP ONLY buttons on Generator Setup Scene, **and** by clicking the accepted-map thumbnail on the deterministic tab. Renders the freshly generated tile grid using the actual preloaded `scribble.png` spritesheet at 14 px per tile.

The overlay supports three button-row modes depending on which callbacks the caller supplied:
- **Editor** (`onRegenerate` + `onAccept`) — REGENERATE / ACCEPT / CLOSE spread across the bottom (used by COMPOSE MAP).
- **Iteration** (`onRegenerate` only) — REGENERATE / CLOSE (used by GENERATE MAP ONLY on the AI tab).
- **View-only** (neither) — a single centred CLOSE button (used by the click-to-enlarge from the thumbnail).

When the caller passes a `zones` option (`{ playerCells: Set<string>; enemyCells: Set<string>; neutralCells?: Set<string>; triggerRegions?: Array<{ kind, region }> }`), the overlay draws blue (player) / red (enemy) / amber (neutral) 50%-alpha overlays on top of the matching grid cells. `triggerRegions` are drawn as colour-coded outlined rectangles on top of the zone overlays — perception = teal, log = pale blue, AIDM cue = amber, combat = red — so the author can see which tiles fire each trigger at full zoom. All overlays live inside `gridContainer` so they zoom and pan with the map.

| Component | Description |
| --------- | ----------- |
| **Backdrop** | Semi-transparent black covering the whole canvas, swallows pointer events so the underlying scene can't be interacted with while the preview is open. |
| **Title** | A small accent-coloured "MAP PREVIEW" tag above the authored map name. |
| **Description** | Authored 1-2 sentence flavour line from the model. |
| **Tile grid (zoom + pan + optional zones)** | The generated map rendered at 14 px / tile using the actual tileset textures, clipped to a 1020 × 440 viewport via a geometry mask. **Mouse wheel** zooms around the cursor (clamped to 0.5×–4×); **click-and-drag** inside the viewport pans the grid. Zoom + pan reset to defaults whenever the grid is replaced by a regeneration. Both terrain and object layers are drawn (object tiles overlay terrain). When the caller passed a `zones` option, player-start cells render with a blue 50%-alpha overlay and enemy-start cells with a red one — these are children of `gridContainer` so they transform with zoom + pan. Falls back to plain grey squares if the texture isn't loaded for some reason. |
| **Saved-as footnote** | `Saved as gen_<id>` line beneath the grid — reminds the player the map persists on disk regardless of whether they keep iterating. |
| **↻ REGENERATE** button | Re-runs the same compose / generate call. The preview shows a "Regenerating…" mask while the call is in flight, then swaps the rendered grid in place and resets zoom + pan. |
| **✓ ACCEPT** button | *(shown only when an `onAccept` callback is supplied — currently from the deterministic COMPOSE MAP flow)* Commits the currently-shown map as the accepted map on `GenerateSetupScene`, closes the overlay, and unlocks the right-panel encounter-builder (thumbnail + zone painter + monster picker + description). Re-opening the preview and accepting a different map replaces the previous acceptance and resets all painted zones + monster selections. |
| **CLOSE** button | Dismisses the overlay. The current map file stays on disk and is available to future custom encounters. |

---

### Map Selector Overlay

`client/src/ui/generate/MapSelectorOverlay.ts`. Modal Phaser overlay opened by the **PICK MAP** button on Generator Setup Scene's Deterministic tab. Lists every saved map (`registry.get("maps")`) as a scrollable grid of cards; selecting a card sets it as the accepted map on the scene, bypassing the COMPOSE MAP iteration loop.

| Component | Description |
| --------- | ----------- |
| **Backdrop** | Semi-transparent black covering the whole canvas; swallows pointer events. |
| **Header** | "SELECT MAP" accent tag with a `<N> saved maps` subtitle. |
| **Map card grid** | Cards laid out in rows of ~4 (auto-fits to panel width). Each card renders a thumbnail of the map at ~6 px / tile using the map's own multi-tileset routing (water + scribble + dungeon all decoded correctly), then shows the map name and short description below. Wheel-scrolls vertically when the cursor is over the grid. |
| **Card click** | Resolves a `MapPreviewData` (converted from `SavedMapDef`) back to the parent scene, which sets it as the accepted map and rebuilds the right-panel encounter-builder. |
| **CLOSE** button | Bottom-right. Dismisses the overlay without selecting a map. |

---

### Encounter Editor Scene

`client/src/scenes/EncounterEditorScene.ts` — top-level scene reached via `MainMenuScene → ENCOUNTER EDITOR`. Full-screen editor for an existing encounter. **No character selector** and no "generate" path; the user opens an encounter, edits its fields, and writes the changes back. **Every visible element on the scene is HTML** — buttons via `createHtmlButton`, inputs via `<input>` / `<textarea>`, titles + labels + captions + status line via `createHtmlText` — so all text stays crisp at any zoom level instead of going blurry through Phaser's canvas text rendering. The only Phaser-rendered things are the canvas backdrop, the divider rule, and the map thumbnail itself (which uses spritesheet textures).

**Layout:** the page is split into two columns. The LEFT column carries the map thumbnail + zone painter + paint-mode toggle and the story-field stack (title / introduction / description / objective + completion flag). The RIGHT column carries only the MONSTERS / TRIGGERS tab toggle and the active picker, **occupying the full page height** — so long monster rosters and multiple triggers both have room to breathe without scrolling clipped lists.

| Component | Description |
| --------- | ----------- |
| **Title row** | Centered "ENCOUNTER EDITOR" header (HTML). Subtitle directly below (HTML, centered) shows the loaded encounter's id + title, or `No encounter loaded — press OPEN ENCOUNTER` when nothing is loaded. |
| **Status line** | HTML text pinned to the bottom of the canvas and **center-aligned** across the full width. Shows the most recent feedback — e.g. `Loaded gen_1748394920_dungeon_sweep.` after OPEN ENCOUNTER, `Saving encounter…` while a save is in flight, `Saved gen_*.` on success, or the disabled-button hint when SAVE ENCOUNTER's preconditions aren't met. |
| **📂 OPEN ENCOUNTER** button | Top-right corner (HTML). Opens the [Encounter Picker Overlay](#encounter-picker-overlay) — a modal grid of cards listing every saved encounter. Selecting a card loads its state into the form. |
| **Thumbnail + zone painter** *(LEFT column, top)* | Same `ZonePainter` the Generator Setup Scene uses. Player / enemy / neutral cells are decoded from the encounter's `startingZones.data` array on load. Painted triggers render as colour-coded outlined rectangles on top. Clicking with no paint mode opens the Map Preview Overlay at full size. |
| **PAINT mode buttons** *(LEFT column)* | PLAYER / ENEMY / NEUTRAL / CLEAR — HTML buttons; the active mode renders with a brighter "active" background. |
| **TITLE / INTRODUCTION / DESCRIPTION / OBJECTIVE / COMPLETION FLAG inputs** *(LEFT column, below paint buttons)* | HTML `<input>` + `<textarea>` stack. Loaded from the encounter's `encounterTitle`, `customIntroduction`, `customContext`, `objective`, `completionFlag` fields. Textarea heights expand to fill the remaining LEFT-column vertical space. |
| **MONSTERS / TRIGGERS tab toggle** *(RIGHT column, top)* | Two HTML buttons spanning the right column. Active tab renders with the brighter "active" colour. |
| **MonsterPicker** *(RIGHT column, monsters tab)* | Fully HTML scrollable list of every monster def, with `+ ALLY` / `+ NEUTRAL` / `+ ENEMY` HTML buttons per row. Pre-populated from the loaded encounter's `allyIds` / `npcIds` / `enemyIds`. A summary box + CLEAR MONSTERS button sit beneath the list. The list uses native `overflow:auto` scrolling so any number of monsters can be added. |
| **TriggerEditor** *(RIGHT column, triggers tab)* | Fully HTML scrollable list of trigger rows. Each row has kind chips (PERCEPTION / LOG / AIDM CUE / START COMBAT), region xywh inputs, per-kind config inputs, and a REMOVE button — all HTML. Beneath the list sits the "+ ADD TRIGGER" button. There's no fixed cap on the number of triggers — the list scrolls. On load, triggers are reverse-mapped from the encounter's `triggers` array (perception / log / aigm / combat patterns); triggers that can't be represented as a single ComposedTrigger are skipped, and the status line surfaces the skipped count. |
| **BACK** button | Bottom-left (HTML, `ghost` variant). Returns to Main Menu Scene. |
| **✓ SAVE ENCOUNTER** button | Bottom-right (HTML, `primary` variant). POSTs `/generate/encounter/update` with the current form state. The handler merges the editable fields into the existing encounter JSON and rewrites it, **preserving every field the editor doesn't expose** (environment flags, tileProperties, generated badge, etc.). After save, the local encounters + maps registries are refreshed so a subsequent OPEN ENCOUNTER sees the latest version. The button stays clickable when its preconditions aren't met and surfaces a status-line hint ("Open an encounter first.", "Paint at least one player-start cell (PAINT: PLAYER).") instead of going silent. |

---

### Encounter Picker Overlay

`client/src/ui/generate/EncounterPickerOverlay.ts`. Modal Phaser overlay opened by the **OPEN ENCOUNTER** button on Encounter Editor Scene. Lists every encounter in the `encounters` registry as a scrollable grid of cards.

| Component | Description |
| --------- | ----------- |
| **Backdrop** | Semi-transparent black covering the whole canvas; swallows pointer events. |
| **Header** | "OPEN ENCOUNTER" accent tag with a `<N> saved encounters` subtitle. |
| **Encounter card grid** | Each card renders a thumbnail of the encounter's referenced map (looked up from the maps registry by `encounter.mapId`) at ~6 px / tile using the map's own multi-tileset routing, then shows the encounter title (accent colour), id + `✦ generated` tag (dim), and the encounter description below. Wheel-scrolls vertically when the cursor is over the grid. If the referenced map can't be found in the registry, the card surfaces "(missing map: …)" in red instead of a thumbnail. |
| **Card click** | Resolves the full `EncounterDef` back to the parent scene, which loads it into the editor form. |
| **CLOSE** button | Bottom-right. Dismisses the overlay without loading anything. |

---

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

---

### Wrap Up Loose Ends Overlay

Defined in `client/src/ui/ChapterCompleteOverlay.ts`. Opens once when `GameState.chapterComplete` flips true inside an adventure (combat-ended with no enemies remaining, or the chapter's `completionFlag` is set). The chapter is **resolved at this point** — the player can stay on the map indefinitely to search corpses, talk to NPCs through the GM tab, equip recovered gear, and so on. The modal carries the **encounter's title** (e.g. "Bridge Toll", "Dungeon Delve") so the player immediately recognises which chapter they're wrapping up.

| Component | Description |
| --------- | ----------- |
| **Tag**   | Small accent-coloured `WRAP UP LOOSE ENDS` line above the title. |
| **Title** | The encounter title from `GameState.encounterTitle`. |
| **Subtitle** | `Chapter N of M` from `GameState.adventureContext`. |
| **Body**  | Short explanatory note that the chapter is resolved and the player can keep exploring or advance now. |
| **CONTINUE EXPLORING** button | Dismisses the overlay; reveals the persistent Next Chapter Button at the top of the screen. The × button and backdrop click are equivalent. |
| **NEXT CHAPTER** / **FINISH ADVENTURE** button | Advances the adventure immediately, skipping the in-encounter wrap-up. Label flips to FINISH ADVENTURE on the final chapter. |

### Next Chapter Button

Defined in `client/src/ui/NextChapterButton.ts`. Persistent floating button positioned at the top-center of the canvas (12 px below the top edge, centred horizontally) by `UIScale.canvasRect` and re-positioned on every resize. Created by `OverlayManager.syncChapterComplete` after the Wrap Up overlay is dismissed; destroyed when the player clicks it (or when `OverlayManager.reset()` runs at scene transition).

| Component | Description |
| --------- | ----------- |
| **Label** | `Next Chapter →` for non-final chapters; `Finish Adventure` for the final chapter. |
| **Click** | Calls `OverlayCallbacks.onAdvanceChapter` — GameScene closes the WS, calls `POST /adventure/:characterId/advance`, and either restarts the scene with the new chapter session or returns to the Main Menu when the adventure is complete. |
