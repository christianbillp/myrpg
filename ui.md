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
| **Companion Chip** | Single-line indicator visible whenever the player has a bound companion (NPC with `companion` set — promoted via the `set_npc_companion` trigger action or AIGM tool). Shows the companion's display name plus their current binding state — **FOLLOW** (auto-walks behind the player at ≥ 2-tile distance, picks up combat as an ally), **WAIT** (idle on current tile), **MOVING…** (en route to a player-picked tile via `move_to`), or a per-turn **ATTACK** override (forces the next combat target). Buttons on the chip cycle the binding and clear overrides. A second "**→ POSITION**" chip sits next to the status chip in exploration mode: pressing it enters tile-pick mode (chip flips to "PICK TILE — ESC TO CANCEL"), and the next tile click on the Game Map sends a `move_to` command sending the companion to that tile. Useful for setting up formations before a fight or unsticking a companion that's pathed into a chokepoint. During combat the chip shows the combat label and re-uses the same `override` slot the ally AI reads in `NpcTurnRunners.ts`; out of combat the chip drives `FollowPlayerTask` / `WaitHereTask` / `WalkToTask` from the NPC sim layer (US-094). When no companion is bound the chip is hidden entirely. |
| **Objective**      | One-line player-facing goal for the encounter, accent-coloured (`#e2b96f`). Sourced from `GameState.objective` (set per encounter in JSON, with a default derived from `encounterTypes` when omitted). Rendered immediately above the Quests list. |
| **Quests**         | Section listing quests assigned at encounter start. Each quest shows "· Title  N/M" while in progress and "✓ Title" when complete. "None" when no quests are active for the current encounter type. |
| **Action Buttons** | Context-sensitive combat buttons shown above CHARACTER/SEARCH (see below). Replaced by a **Spell Targeting Prompt** ("Select target for: SPELL_NAME") while spell-targeting mode is active. For attack-roll spells the prompt waits for a creature click; for AOE spells the affected tiles preview as an orange chebyshev disc that follows the cursor (or stays anchored on the player for self-range spells like Burning Hands), and clicking any tile fires the spell on that area. ESC cancels in either mode. |
| **CHARACTER SHEET**| Small **☰** icon button at the **top of the panel, to the left of the character name**; always visible when the panel is open. Opens the Character Sheet Overlay (tabs: Character / Inventory / Spells). |
| **END TURN**       | **Round floating button at the bottom of the screen** (not in the panel), a fixed gap to the right of the Player Panel — tracks the panel's right edge when it's resized. **Visible only during `player_turn`** (hidden out of combat). **Hover** brightens it with an amber glow; **press** gives an immediate pressed-then-flash cue (the button vanishes the moment the turn ends, so the feedback is instant). Ends the player's turn and passes initiative to the enemies. |
| **LEAVE ENCOUNTER**| Lives in the **DevTools panel** (top of screen) — relabels to LEAVE ADVENTURE inside an authored adventure. Triggers auto-save and returns to the setup screen. *(Only available while DevTools is enabled and the overlay is toggled on.)* |
| **⚙ Panel Setup**  | Small icon square in the **footer below a divider** (its own bottom section); always visible. Opens the **Panel Setup Overlay** (see Overlays). |
| **⚒ Dev Tools toggle** | Dev-only: a small magenta square **absolutely positioned in the footer's bottom-left corner** (it does not shift the centered ⚙ — per the CLAUDE.md dev-button rule), shown only when `DevMode.showDevToolsPanel` is enabled in the main Configuration. Pressing it **toggles the DevTools overlay** (top of screen, starts hidden). |
| **★ LEVEL UP**     | Top-of-action-stack button; visible only during the `exploring` phase when `availableActions.canLevelUp` is true (XP reached the SRD threshold for the next level and the character isn't yet at L20). Opens the [Level Up Overlay](#level-up-overlay). Hidden in combat — the overlay's HP / spell-slot changes would land mid-turn otherwise. |
| **☾ LONG REST**    | Above LEVEL UP (just over MOVE) during the `exploring` phase when `availableActions.canLongRest` is true. The flag is set by the encounter (`EncounterDef.allowsLongRest = true`) — taverns / safehouses / camps qualify; wilderness exploration does not. Opens the [Long Rest Overlay](#long-rest-overlay). |
| **✶ ATTUNE**       | Enabled during the `exploring` phase when `availableActions.attunableItemIds` is non-empty (the player holds a magical item that `requiresAttunement`, isn't attuned to it, and has fewer than 3 attunements). Attunes the first eligible item (SRD: bonds over a Short Rest) so its bonus takes effect; the server enforces the ≤3 cap (US-124). |
| **🔎 IDENTIFY**    | Enabled during the `exploring` phase when `availableActions.unidentifiedItemIds` is non-empty (the player holds a `startsUnidentified` item not yet identified). Identifies the first such item (SRD: a Short Rest examining it / the Identify spell), revealing its true name + properties; until then the Equipment tab shows it as "Unidentified <category>" (US-124). |
| **☄ KNOCK OUT**    | Toggle (highlighted amber when on). While on (`PlayerState.nonLethal`), a **melee** blow that would drop an enemy to 0 HP instead leaves it **Unconscious + Stable** — defeated (XP awarded) but alive, not killed (no loot drop). Ranged kills are unaffected (SRD: melee only). US-052. |

### Action Buttons

Action Buttons are **always shown and greyed out when they can't be used right now** (e.g. GRAPPLE with no adjacent target, LEVEL UP below the XP threshold) rather than appearing and disappearing. They render from a **single unified, fixed-order list that is identical in exploration and combat** — each button keeps its position across modes and is merely enabled or greyed for the current mode + availability (`buildActionButtons`), so nothing shifts when combat starts or ends. The **Panel Setup Overlay** (the **⚙** button centered at the bottom of the footer) is the *only* thing that removes a button: each Action Button carries a stable `data-action-id` (dynamic ones fold into families — `gear`, `summon`, `release`; all class-feature buttons share `feature`), and any id the player marks hidden is filtered out of the stack before layout. Preferences persist globally in `localStorage` (`myrpg_hidden_action_buttons`). Only **ROLL DEATH SAVE** can't be hidden (it's a forced prompt with no alternative). Build-/state-gated buttons still only appear when they apply — **CAST** for casters, **RELEASE** while concentrating, and the entity-driven **DIRECT <summon>** / **SET <gear>** / **DISARM TRAP**. A hidden button still works through its other triggers; it just doesn't render. The condition column below describes when a button is *enabled*.

| Button              | Economy      | Condition                                                                    | Description                                                             |
| ------------------- | ------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **ATTACK**          | Action       | A non-ally target is selected within the equipped weapon's reach (1 tile for melee, `rangeLong/5` tiles for ranged), action not yet spent, and — for ranged weapons — at least one matching ammo item in inventory | Make an attack with the equipped weapon. Auto-routes between melee and ranged from `mainAttack.rangeNormal`. The button is two-line and shows the weapon name in parentheses below — e.g. *ATTACK / (Shortbow)*. Ranged shots consume one ammo per attack; on every shot there is a 50% chance the round lands on the target's tile as a recoverable map item. Beyond the weapon's normal range imposes Disadvantage; beyond long range disables the button. **Extra Attack (US-119):** a character with the `extra-attacks` track > 1 keeps ATTACK enabled after the first swing — each press makes one weapon attack and a Combat Log line announces the remaining attacks; the Action is fully spent only once the reserve (`PlayerState.attacksRemaining`) empties. |
| **THROW…**          | Action       | Player's turn, action not yet spent, throwable item in inventory that can reach a living enemy | Open an inline item picker; select an item to throw at the nearest in-range enemy. Proper thrown weapons (javelin, dagger) use weapon stats and mastery; all other items are improvised (1d4 bludgeoning, STR mod, no proficiency bonus). On a hit the item enters the target's inventory (dropped at their tile on death); on a miss it lands on the map at the target's tile. |
| **↩ CANCEL**        | —            | Throw picker is open                                                         | Close the throw picker without spending any resource                    |
| **DASH**            | Action       | Player's turn, action not yet spent                                          | Double remaining movement for this turn; applies `dashing` condition    |
| **DODGE**           | Action       | Player's turn, action not yet spent                                          | All incoming enemy attacks have Disadvantage until next turn; applies `dodging` condition |
| **DISENGAGE**       | Action       | Player's turn, action not yet spent, at least one living enemy               | Prevent Opportunity Attacks when moving away from enemies this turn; applies `disengaged` condition |
| **GRAPPLE**         | Action       | An adjacent living enemy no more than one size larger, not already grappled, and Action available (`availableActions.grappleableTargetIds` non-empty) | SRD Unarmed Strike Grapple option (US-110): the target makes the better of its STR/DEX save vs DC 8 + player STR mod + PB; on a failure it gains the **Grappled** condition (Speed 0). Targets the selected enemy, else the nearest eligible one. |
| **SHOVE** / **SHOVE PRONE** | Action | An adjacent living enemy no more than one size larger, Action available (`availableActions.shoveableTargetIds` non-empty) | SRD Unarmed Strike Shove option (US-050): same save as Grapple; on a failure **SHOVE** pushes the target 5 ft (1 tile) directly away (stops at walls / occupied tiles / the map edge) and **SHOVE PRONE** knocks it Prone — the two buttons are the player's choice of effect. |
| **HELP**            | Action       | An adjacent living enemy and a living ally to benefit (`availableActions.canHelp`) | SRD Help — Assist an Attack (US-057): distract the selected/adjacent enemy → it gains the single-use `helped` marker granting **Advantage** to the next attack (player or ally) against it before the start of the player's next turn. |
| **READY**           | Action       | Player's turn, Action available, Reaction not yet spent, not already readied, at least one living enemy (`availableActions.canReady`) | SRD Ready (US-057): reserve a melee strike against the first enemy that closes into reach this round. When an enemy ends a move adjacent to the player, the **Reaction Prompt** offers the readied strike; accepting fires it and declining keeps the reservation for a later enemy. Cleared when it fires or at the start of the player's next turn. |
| **STUDY** / **UTILIZE** / **INFLUENCE** | Action | Player's turn, action not yet spent (INFLUENCE also requires a selected non-hostile-disposition NPC) | SRD Study / Utilize / Influence (US-057): prime the GM chat with a leading template (`HUD.primeActionPrompt`) for the AIGM to adjudicate — Intelligence check (Study), object interaction (Utilize), or a Charisma/Wisdom Influence check carrying the US-092 attitude modifier. |
| **TALK**            | Free         | A target creature is currently selected                                       | Opens an inline speech-bubble input (`SpeechInputBubble`) pinned to the player token so the player can type a line addressed to the selected target. Submitting routes through `HUD.sendSayto(text)` — same path as the GM-chat dropup `sayto` mode: the prompt is wrapped as `[<player> says to <target>]: <line>` and shipped to the AIGM; the server detects the wrapper and writes a `<player> → <target>: "<line>"` row into the Event Log on the spot (no waiting for the GM reply). A speech bubble pops above the player (flipping below when it would cover the target token), and a typing indicator appears over the target until the GM's reply lands. Disabled when no target is selected. Available during both `exploring` and `player_turn`. |
| **CAST**            | Free         | Character is a caster (`PlayerDef.spellcastingAbility` set) | Opens the in-panel **quickcast menu** — the spells the player added from the Character Sheet's Spells tab (the ✦ toggle). Mirrors the throw picker: it replaces the action stack with one button per quickcast spell (cast on click; greyed when not castable now), a **✚ MANAGE SPELLS** button (opens the Character Sheet's Spells tab to add more), and **↩ CANCEL**. Clicking a spell enters the normal targeting / upcast / component flow (same path as the sheet's CAST). The quickcast set is per-character in `localStorage` (`myrpg_quickcast_<id>`). Same teal (`#1a3a4a`) as TALK; available during both `exploring` and `player_turn`; hidden for non-casters. |
| **Class Feature Buttons** | Varies (per-feature) | Character's `defaultFeatureIds` includes the feature, `usableFeatureIds` reports it usable | One button per known class feature (Second Wind, Action Surge, the Cleric's **TURN UNDEAD** / **DIVINE SPARK** / **PRESERVE LIFE**, …). Label / colour / resource chip are pulled from the feature's `ui` block in [`features/`](data_structure.md#features-1). The Player Panel iterates `state.features` to render these — there's no per-class hard-coding in the panel. Disabled when the server's `canUseFeature` guard fails (resource exhausted, action economy spent, situational gate not met). The Cleric's three Channel Divinity buttons share one resource chip — *Channel Divinity: {n}/2* — and Divine Spark acts on the currently selected target (heals an ally/self, radiant-damages an enemy). |
| **HIDE**            | Varies       | Not already hidden; either Exploring (free, no resource cost), or Player's turn with the right resource available | Attempt to hide. Available to every character (HIDE is a general SRD action). Cost depends on phase and class level: in `exploring` it's free (no action economy applies — used to set up a Sneak Attack opener against currently-neutral NPCs); during `player_turn` it costs the **Action**, except a Level 2+ Rogue spends a **Bonus Action** via Cunning Action. Stealth roll is opposed by the highest Passive Perception among any non-ally, non-dead, non-incapacitated NPC on the map. Success applies the `hidden` condition; failure clears it. The condition grants Advantage on the next attack (which then triggers Sneak Attack for Rogues) and is cleared automatically after attacking. |
| **SEARCH**          | Action / Free | Not Incapacitated; in combat, Action available | Roll a single Wisdom (Perception) check that resolves three things at once on a successful roll vs each target's DC: (a) any adjacent **Secret** tile (lore / item / coins reward); (b) any adjacent **corpse** with an authored `corpseSearch` payload (one-shot — the engine flips that corpse to `SEARCHED` and the AIGM stops rolling a second check on it); (c) hidden NPCs within 6 tiles (the SRD `Search [Action]` perception sweep — `runPerceptionSweep` per candidate). It **also probes for concealed traps** adjacent to the player (`detectAdjacentTraps`) against the same roll. Free during `exploring` (no action economy); during `player_turn` it costs the full **Action** (no Cunning Action fast-track — Search isn't on the Bonus Action list per SRD). |
| **DISARM TRAP**     | Action       | A discovered, still-armed trap is on a tile within reach (≤1) — `availableActions.disarmableTrapTiles` non-empty; in combat, Action available | Attempt to disarm the adjacent trap: rolls **Dexterity (Sleight of Hand) vs the trap's `disarmDC`** (SRD default 15), with **Advantage when the player carries Thieves' Tools** (`thieves_tools`). On success the trap goes inert; a botch (miss by 5+) springs it. One button renders per disarmable trap tile. |
| **SET <gear>**      | Action       | The player holds area-denial gear (caltrops / ball bearings) and an Action is available — `availableActions.deployableGearIds` non-empty | Deploy the gear: pressing it enters a tile-targeting mode (amber reach disc + a preview of the covered square under the cursor); clicking an in-range tile scatters the gear, consuming one unit and creating a hazard **zone** that renders like a spell effect and resolves an enter-save against any creature that walks in. One button renders per deployable gear id (e.g. *SET CALTROPS*, *SET BALL BEARINGS*). ESC cancels. |
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
| **Active Zone**         | Persistent area-of-effect overlay (Fog Cloud, Web, Grease, and **deployed area-denial gear** — caltrops, ball bearings). Each zone tile is filled with the zone's translucent tint and outlined, with the zone name labelled at its centre (`drawActiveZones`). Deployed gear uses the same primitive so a scattered patch of caltrops reads identically to a spell zone. The zone name also appears in the tile-inspection panel's EFFECTS row. |
| **Trap Marker**         | Hazard outline + glyph drawn on every **discovered** trap tile (`drawTraps`). Armed traps show a bright **⚠** in the trap's tint; disarmed/sprung traps render dim with a **✓**. Concealed (undiscovered) traps are not drawn — the player must spot them first (passive Perception on move, or the SEARCH action). A discovered trap also lists in the tile-inspection EFFECTS row as `⚠ <name> (armed/disarmed)`. |
| **Deploy Gear Preview** | While a **SET <gear>** action's tile-targeting mode is active: an amber chebyshev disc marks valid placement tiles (within the gear's range) and a stronger amber square previews the area the gear will cover under the cursor. Cleared when the gear is placed or the mode is cancelled (ESC / out-of-range click). |
| **Spell Aura Ring**     | White ring around the player while concentrating on a sense-radius spell. Currently rendered for **Detect Magic** as a 6-tile (30 ft) radius circle with a faint white inner fill. Drawn each state update and cleared when concentration ends. |
| **AOE Spell Preview**   | Orange tiles showing the affected area while spell-targeting mode is active for an AOE spell. Follows the cursor for ranged AOEs (e.g. Sleep — chebyshev disc around the hovered tile) or stays anchored on the player tile for self-range spells (e.g. Burning Hands — 15-ft cone treated as a 3-tile chebyshev disc). Cleared when the spell fires or targeting is cancelled. |
| **Spell Range Underlay** | Faint teal tint shown under the AOE preview during spell-targeting mode, covering every tile within the spell's `rangeFeet` from the caster. Gives the player at-a-glance feedback for how far the spell can reach before they commit a click. Hidden for self-anchored spells (range 0). |
| **Summon Range Overlay** | Soft blue chebyshev disc highlighting every tile the summon can reach while a `DIRECT <NAME>` action is active (Mage Hand 30 ft = 6 tiles, Unseen Servant 15 ft = 3 tiles). Cancelled clicks outside the disc abort the command. |
| **Speech Bubbles**       | Lightweight HTML bubble rendered above an entity's token. Dark-blue translucent background, monospace text (same font face and size as the Event Log + GM Chat — 11 px / line-height 1.55), 6-second lifetime with a 600 ms fade-out. Multiple bubbles for the same entity stack vertically with the newest closest to the token. Triggered by the AIGM `npc_speaks` tool, the `npc_speaks` trigger action, or the player's `sayto` flow (HUD GM-mode dropup set to `sayto`, or the Player Panel TALK button). When a bubble is spawned with an `avoidEntityId`, the manager checks every frame whether the above-token placement would overlap that other entity's token box; if so, the bubble (and the rest of that entity's stack) flips **below** the speaker instead. Used so the player-says-to-target bubble never covers the addressed NPC. Auto-disposed when the token despawns. Rendered in document space so they overlay the canvas regardless of zoom. |
| **Typing Indicator**     | Persistent variant of a speech bubble — animated `.` → `..` → `...` cycling every 400 ms — pinned above the target NPC while the AIGM is generating a reply to a player `sayto`. Spawned the moment the player submits, cleared the moment `aigm_done` arrives. Exempt from the standard 6 s lifetime sweep; lives only until the caller's clear function fires (or the scene tears down). Lets the player see at-a-glance that the addressed NPC is "thinking." |
| **Fog of War (VisionMask)** | Dark veil rendered over every tile the player cannot see this frame. Mirrors the server-side `Vision.canSee` Bresenham walker: tiles with **Total Cover** along the LOS path render at `0.78` alpha (cannot be seen through walls); tiles in **Heavy Obscurance** (Dark ambient out of Darkvision range; smoke; thick fog) render at `0.55` alpha; **Light Obscurance** (Dim ambient, underbrush) at `0.18` alpha. Darkvision steps `dark`→`dim` within range so the dark-shadow ring around the player shrinks to the character's Darkvision range. Refreshed every frame from the per-tile `map.cover` + `map.obscurance` arrays + `environment.lightLevel` + `playerDef.senses`. |
| **Sound Rings**          | Brief expanding circle drawn at the source of every `sound_ring` GameEvent. Yellow-gold stroke, fades over 700 ms; radius scales with the event's `intensity` in tiles (whisper=1 → footstep=2 → speech=3 → combat/spell=5). Lets the player register noises happening outside their line of sight — a footstep behind a wall, a spell cast across the fog. |
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
| **Companion**      | One-line `COMPANION  FOLLOW <TIGHT\|LOOSE>` row in green when the selected NPC is bound as the player's companion (`NpcState.companion` set via the `set_npc_companion` trigger action or AIGM tool). A pending player override surfaces as `· HOLDING` / `· ATTACKING` / `· CASTING` / `· MOVING TO (x,y)`. Hidden when the NPC is not the player's companion. Mirrors the COMPANION chip on the Player Panel — the player sees the binding from both sides. |
| **Alertness**      | One-line `ALERTNESS  <state>` row from the NPC sim layer (US-094). **Hidden** when the selected NPC is `calm` (the default — no dead vertical space for ordinary scenes). **`ALERTNESS  SUSPICIOUS`** in orange when the NPC heard a noise within range (combat swing, spell verbal component, footstep) and is heading toward its `lastAlertTile`. **`ALERTNESS  ALERT`** in red when the NPC was faction-pinged by combat start within `FACTION_ALERT_RADIUS = 30` tiles — they commit to the source tile at priority `critical`, dropping their routine instantly. Decays back down the ladder over time (`alert → suspicious` after 15 ticks, `suspicious → calm` after 25). |
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

## Screen Effects

Defined in `client/src/ui/ScreenEffects.ts`. Document-level HTML layer that sits **above** every other UI panel (z-index 9000+) so it covers the canvas, HUD, Player Panel, Target Panel, and any open overlay. Driven by the GameScene event queue: events arrive through `state_update` (or the long-rest / chapter-advance / encounter-start flows) and play **sequentially** — so a typical cinematic transition queues `fade-out → supertitle → announcement → fade-in` and each element holds the screen for its own duration before the next runs. GameScene parks the overlay at full black before the first `state_update` arrives so the bare HUD never flashes before the encounter-start cinematic.

| Component         | Description                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Fade Overlay**  | Full-screen black div whose opacity tweens between three targets. `mode: "out"` runs → 1 (full black); `mode: "in"` runs → 0 (clear); `mode: "dim"` runs → 0.5 (50% black — atmospheric dim where the world is still visible underneath). The fade is **sticky** — every darkening fade (`out` or `dim`) must be paired with a matching `in`. Blocks pointer input only when at full black; partial / dim overlays leave clicks passing through. Triggered by `fade_screen` (AIGM tool or encounter trigger action), the long-rest commit, and the chapter-advance restart. The engine flows use 1200 ms by default; encounter triggers and the AIGM tool both expose `durationMs`. |
| **Supertitle**    | Movie-style location title — huge bold white serif text filling ~95vw, centred, wrapping onto two lines for longer titles. Fades in over 600 ms, holds for `durationMs` (default 3000 ms), fades out over 600 ms. Triggered by the AIGM `show_supertitle` tool or the `show_supertitle` trigger action. Renders **above** the fade overlay so it reads against the black during a fade-out hold. |
| **Announcement**  | Centred card with parchment-coloured text — large, attention-grabbing. Two style modes: **`focused`** (default) draws an orange-bordered card and is paired with input/UI locking on the scene side — the Player Panel, Target Panel, and HUD fade out *before* the card appears and fade back in *after* it leaves (UI-leaves-first / UI-returns-last principle), world-tick is paused, and player movement / actions are locked. **`unfocused`** uses a borderless radial-fade card and is fire-and-forget — the UI stays live, the world keeps ticking, the player keeps playing. Both modes fade in over 500 ms, hold for `durationMs` (default 3500 ms), fade out over 500 ms; both have their text mirrored into the Event Log server-side. Triggered by the AIGM `show_announcement` tool or the `show_announcement` trigger action. |

### Player-control loss principle

Whenever a visual takes control away from the player (focused announcement, long rest cinematic, chapter advance), the UI panels are the **first** to disappear and the **last** to reappear. Implementation: [PlayerPanel.fadeIn/fadeOut](client/src/ui/PlayerPanel.ts), [TargetPanel.fadeIn/fadeOut](client/src/ui/TargetPanel.ts), and [HUD.fadeIn/fadeOut](client/src/ui/HUD.ts) each expose 220 ms opacity transitions; the scene `await`s them around the central visual.

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

### Quest Log Overlay

Defined in `client/src/ui/QuestLogOverlay.ts` (extends `BaseOverlay`); opened from the **OBJECTIVE line** in the Player Panel (which is clickable and underlines on hover). Read-only quest journal: **active quests** first, each as a card with title, description, and a **step checklist** (`✓` done · `▸` current · `·` upcoming); then **completed / failed** quests dimmed; then a **Journal** section of prior-chapter summaries in adventure mode. The host (`GameScene.openQuestLog`) builds the view-model from `GameState.quests` resolved against the quest defs (authored from the `quests` registry, runtime from `GameState.runtimeQuestDefs`). The OBJECTIVE line itself shows the active quest's current step (driven engine-side by the `QuestSystem`). Quests advance through the engine / AIGM, never from this overlay.

### Panel Setup Overlay

Defined in `client/src/ui/PanelSetupOverlay.ts` (standalone HTML, not `BaseOverlay`); opened from the **⚙** button centered at the bottom of the **Player Panel** footer. It fills the screen **to the right of the Player Panel** — tracking the panel's right edge via a `ResizeObserver`, so it stays correct even after the player drags the panel wider/narrower — leaving the panel itself visible so it updates live as settings change. Every change persists immediately to `localStorage` and fires a callback that re-renders the action stack. **Done** (or Escape) closes. Two sections:

1. **Actions** — a responsive grid of **cards**, one per entry in `ACTION_BUTTON_CATALOG` (`client/src/ui/actionPanelPrefs.ts`), each showing the action's glyph + name, a short **description**, and a **"Visible in panel"** toggle (persists to `myrpg_hidden_action_buttons`). A **Show all actions** button clears all hidden ids. The catalog excludes ROLL DEATH SAVE (never hideable).
2. **Configuration** — panel-wide display settings as cards. Currently one: **Compact View** (`myrpg_panel_compact_view`) — when enabled, the Player Panel renders Action Buttons as small **icon-only squares** (the action's glyph, full label on hover) laid out as a wrapping row instead of full-width labelled buttons; the throw picker stays full-width so item names remain readable.

The overlay reads/writes through the shared `actionPanelPrefs` helpers (`actionIdForLabel`, `glyphForActionId`, `readHiddenActions`, `setActionHidden`, `readCompactView`, `writeCompactView`).

---

### Main Menu Scene

`client/src/scenes/MainMenuScene.ts` — top-level entry point shown after Boot when there is no active world save. Renders the game title, a tagline, and a vertical stack of HTML buttons routing to every top-level scene. Each button is a serif-label tile with a small hint sub-line below.

| Button | Routes to | Hint |
| --- | --- | --- |
| **ADVENTURE** | Adventure Setup Scene | A string of encounters with overarching narrative |
| **SINGLE ENCOUNTER** | Encounter Setup Scene | Play a one-off scenario |
| **MAP CREATOR** | [Map Creator Scene](#map-creator-scene) | Generate and save maps; the Encounter Creator picks them up |
| **ENCOUNTER CREATOR** | [Encounter Creator Scene](#encounter-creator-scene) | Build an encounter manually or with AI assistance — title, monsters, zones, triggers |
| **ADVENTURE CREATOR** | [Adventure Creator Scene](#adventure-creator-scene) | String encounters into an adventure with overarching story, AI context, and a rest stop |
| **NPC CREATOR** | [NPC Creator Scene](#npc-creator-scene) | Author an NPC on top of an existing monster — name, faction, persona, token |
| **TOKEN CREATOR** | [Token Creator Scene](#token-creator-scene) | Mix and match parts (hair, eyes, beard, …) to build an NPC token |
| **TILE CREATOR** | [Tile Creator Scene](#tile-creator-scene) | Edit each tile's attributes — movement, sight, cover, obscurance, tags — per tileset |
| **CONFIGURATION** | Configuration Scene | Choose the active setting; toggle Development Mode flags including the destructive **Clean Mode** (`cleanModeOnStart` — wipes every player progress artefact under each setting's `saves/` directory on every server restart). |

---

### Map Creator Scene

`client/src/scenes/MapEditorScene.ts` — top-level page focused exclusively on producing and saving maps. The Encounter Creator picks up the saved maps later. **No character selector** and no encounter authoring on this scene; every encounter-builder concern moved to the Encounter Creator Scene.

**Layout:** LEFT column (2/3 width) hosts an editable name + description + the [EmbeddedMapPreview](#embedded-map-preview) at the largest size that fits. RIGHT column (1/3 width) is driven by a three-chip tab bar (**DETERMINISTIC** / **GENERATIVE AI** / **EDIT**). BOTTOM bar carries BACK, GENERATE MAP, LOAD MAP, SAVE MAP. All chrome is HTML (`createHtmlButton` / `createHtmlText` + textarea / input) so it stays crisp at any zoom.

#### Deterministic tab

| Component | Description |
| --------- | ----------- |
| **TERRAIN chips** | `GRASSLAND` / `FOREST` / `DUNGEON` / `TAVERN` / `CAVE` / `TOWN` radio chips. Exactly one is active; Grassland is selected by default. Picks which per-terrain composer module under [server/src/engine/maps/](server/src/engine/maps/) runs. |
| **FEATURES chips** | Outside features (`CAMPSITES` / `COASTLINE` / `PATH` / `INTERSECTION`) and inside features (`3 ROOMS` / `5 ROOMS` / `STAIRS`) multi-select. Compatibility is gated per terrain via `TERRAIN_COMPATIBLE_FEATURES`: outdoor terrains take the outside set + STRUCTURES; Dungeon + Cave take **3 / 5 Rooms (a radio pair — pick one, never both)** plus STAIRS (an independent toggle); Tavern takes none. |
| **STRUCTURES section** (below FEATURES) | An **add-and-configure list** ([StructureList.ts](client/src/ui/edit/StructureList.ts)), not fixed chips. **+ ADD STRUCTURE** appends a row; each row has a **BUILDING / RUIN** toggle, a **− n rooms +** stepper (1–5 connected rooms), and a **✕** remove. Each configured structure is auto-placed at COMPOSE as a compact grid of `rooms` rooms (uniform size) sharing walls, linked through **shared-wall doorways** plus one **external entrance doorway**; all doorways are open-doorway tiles rotated to their wall edge. **Ruins** crack their floor (~35%) and crumble straight wall segments — occasionally a gap (~12%), a **cracked wall** (~12%), or a **broken rubble wall** (~12%), all passable/cover. Buildings emit `building <n>` zones; ruins emit `ruin <n>` zones. Applies to grassland / forest (the list greys out with a hint on other terrains). |
| **STAIRS feature** (Dungeon + Cave) | When on, the entrance is a `stairs_up` tile placed inside the entry chamber, covered by an **Entrance Stairs** zone — no opening at the map edge. When off, the cave/dungeon opens at the map edge instead (a passage carved to the southern border). |
| **BUILDINGS counter chip** | Click cycles `BUILDINGS` → `BUILDINGS: 1` → `BUILDINGS: 2` → … → `BUILDINGS: 5` → off. The composer stamps that many varied-size rectangular stone-floor buildings (4–7 × 4–6) with transparent-twin walls on the object layer and a single doorway per building. Footprints never overlap each other, path cells, or water. Each placed building emits a `building <n>` zone covering its full footprint. |
| **PATH + INTERSECTION** | The Path feature paints a dirt path on the object layer over the unchanged biome ground (terrain stays grass / forest). Adding Intersection turns it into two crossing paths. Adding Coastline as well bends the intersection into a T-junction whose spine runs along the dry inland side and stem terminates at the waterline. The composer emits a `path` zone (every painted path cell) and, when intersecting, a 1-tile `intersection` zone at the crossing. |
| **DUNGEON terrain** | Picks 3 or 5 non-overlapping rectangular rooms (4–7 × 4–6) and links them in a **serial chain** (each room connects only to the next, south → north) so there is a single path from the entrance to the deepest room. A south entry corridor (or stairs) opens at the southernmost room. Floor cells AND wall cells carry stone floor on the terrain layer; walls go on the object layer with transparent-twin tiles at the correct rotation per cell. Outside the dungeon both layers stay at gid 0. Emits one zone per room — `entrance`, `room <n>`, and **`final room`** (the chain's last). |
| **TAVERN terrain** | One wood-floored single-room building set in a grass surround. Wall ring on the object layer with a centred south doorway; a bar counter (row of `wooden_plank_transparent` cells) two cells below the north wall, bookended by 3-barrel stacks; 2–4 small tables (single plank cells) with 1–2 chairs each in the lower half. **Each chair is rotated to face its table.** Emits `tavern`, `bar`, and `tables` zones. |
| **CAVE terrain** | A natural cavern built **hub-and-spoke** (distinct from the dungeon's grid): one large central chamber with **2 side chambers (or 4 with 5 ROOMS)** in the border ring, each tunnelled back to the centre. Varied rock floor (cave dust / gravel / rock) carved from void and enclosed with correctly-rotated walls; a pool + sight-blocking chasm sit in opposite corners of the central chamber. Emits a `central cavern` zone + a `chamber <n>` zone per side chamber. Built on the shared `MapCanvas` + op toolbox (`composeCave`). |
| **TOWN terrain** | A **dense village**: varied stone paving (cobbles / bricks / slabs) with a central slab plaza, two **winding through-streets** crossing at the plaza, and up to ~8 small wood-floored buildings packed across the whole map (not just the corners), each fronting the plaza with its door and joined to it by a crooked lane. Emits a `plaza` zone + a `building <n>` zone per building. Built on the shared `MapCanvas` + op toolbox (`composeUrban`). |

#### Generative AI tab

| Component | Description |
| --------- | ----------- |
| **DESCRIBE THE SCENE** textarea | Multi-line prompt textarea. Required (≥ 8 chars) to enable GENERATE MAP. Scene-only — must focus on terrain, architecture, layout, atmosphere; encounter content (NPCs, conflicts) belongs in the Encounter Creator. |
| **Example cards** | Six vertical cards (Flooded Cavern, Market Square, River Crossing, Five-Room Dungeon, Forest Clearing, Tavern Common Room). Clicking a card copies its body into the prompt textarea so the user can edit or extend it. |
| **Agentic builder** | GENERATE MAP runs the **agentic** builder (`POST /generate/map` → `generateMapAgentic`): the model directs a toolbox of deterministic operations (rooms, corridors, paths, water, hazards, decor) and reads back an ASCII render after each step, so geometry is always valid. It is a multi-step server-side build (~20s); the preview shows a "Building map…" overlay meanwhile. The model never handles raw tiles — it works in a material vocabulary that resolves to GIDs server-side. |

#### Edit tab

Loaded after a map exists in the preview. Lets the user replace individual tiles for fine adjustment without re-rolling the map.

| Component | Description |
| --------- | ----------- |
| **Layer chips** | `TERRAIN` / `OBJECT` toggle picking which layer the next paint affects. Auto-switches to match the selected tile's native layer when the legend has one. |
| **Rotation + mirror chips** | `↻ 0° / 90° / 180° / 270°`, `MIRROR H`, `MIRROR V` — applied to the tile at paint time. Stored as Tiled GID flip bits (H = 0x80000000, V = 0x40000000, D = 0x20000000) so the encoded transform survives save → load. |
| **Tile palette** | Scrollable thumbnail grid of every tile in the active tilesets (scribble + water + cave/urban floors), grouped by tileset and ordered by `tileProperties` legend. Painting a tile from a tileset the map doesn't yet declare auto-adds that tileset to the map. Clicking a thumbnail selects it as the active brush; clicking the **ERASER** chip clears the tile under the next paint. |
| **Paint** | Clicking any cell in the embedded preview stamps the selected tile + transform into the chosen layer; the preview refreshes in place. |
| **GROW MAP buttons** | `+N ↑` / `+S ↓` / `+W ←` / `+E →` add a row (north/south) or column (west/east) to the map. New ground cells are filled with the map's most common ground tile (so a grass field grows grass and a dungeon grows void); new object cells are empty. Author-time zones shift to track an inserted top/left edge. Marks the map unsaved; capped at 60 tiles per axis. |

#### Bottom bar

| Component | Description |
| --------- | ----------- |
| **GENERATE MAP** button | Runs deterministic composition (DETERMINISTIC tab) or AI generation (GENERATIVE AI tab); the EDIT tab disables it. |
| **LOAD MAP** button | Opens the [Map Selector Overlay](#map-selector-overlay) — pick a saved map to load it into the preview for editing. |
| **SAVE MAP** button | Persists the current preview to `server/data/maps/`. AI-generated maps still get a `gen_*` id; user-named maps use the typed slug. |
| **BACK** button | Bottom-left. Returns to MainMenuScene. |
| **Status line** | Above the bottom row — surfaces in-flight messages ("Composing map…", "Generating map…") and disabled-button hints. |
| **[DEV] DELETE ALL GEN MAPS** | Bottom-right, gated behind `DevMode.enabled`. Calls `DELETE /generate/maps/all` to unlink every `gen_*.json`, then refreshes `loadDefs()`. Slotted into leftover space so it doesn't shift any non-dev layout. |

---

### Embedded Map Preview

`client/src/ui/EmbeddedMapPreview.ts`. Inline pan + zoom map preview used by Map Creator Scene. Replaces the modal `MapPreviewOverlay` for use cases where the map should be edited in place rather than in a separate overlay.

| Component | Description |
| --------- | ----------- |
| **Viewport** | Fixed rect inside its host scene. Renders the supplied `MapPreviewData` at the largest tile size that fits both dimensions. Mouse-wheel zooms around the cursor (clamped 0.3×–6×); click-and-drag with no paint brush pans. A geometry mask clips the content to the viewport. |
| **Empty state** | When no map is loaded the viewport shows a faint "No map yet — generate or load one" hint. |
| **Busy mask** | Translucent overlay with a configurable busy label ("Generating map…") shown during in-flight calls. |

---

### Map Selector Overlay

`client/src/ui/generate/MapSelectorOverlay.ts`. Modal Phaser overlay opened by the **LOAD MAP** button on Map Creator Scene (and by the map-pick flow on the Encounter Creator Scene). Lists every saved map (`registry.get("maps")`) as a scrollable grid of cards; selecting a card loads it into the calling scene's preview / accepted-map slot.

| Component | Description |
| --------- | ----------- |
| **Backdrop** | Semi-transparent black covering the whole canvas; swallows pointer events. |
| **Header** | "SELECT MAP" accent tag with a `<N> saved maps` subtitle. |
| **Map card grid** | Cards laid out in rows of ~4 (auto-fits to panel width). Each card renders a thumbnail of the map at ~6 px / tile using the map's own multi-tileset routing (water + scribble + dungeon all decoded correctly), then shows the map name and short description below. Wheel-scrolls vertically when the cursor is over the grid. |
| **Card click** | Resolves a `MapPreviewData` (converted from `SavedMapDef`) back to the parent scene, which sets it as the accepted map and rebuilds the right-panel encounter-builder. |
| **CLOSE** button | Bottom-right. Dismisses the overlay without selecting a map. |

---

### Encounter Creator Scene

`client/src/scenes/EncounterCreatorScene.ts` — top-level scene reached via `MainMenuScene → ENCOUNTER CREATOR`. Full-screen editor for an existing encounter (and the home of the AI-assisted authoring path, on a sibling tab). **No character selector** — after saving an encounter the user returns to Main Menu. **Every visible element on the scene is HTML** — buttons via `createHtmlButton`, inputs via `<input>` / `<textarea>`, titles + labels + captions + status line via `createHtmlText` — so all text stays crisp at any zoom level instead of going blurry through Phaser's canvas text rendering. The Phaser canvas hosts only the page backdrop, the divider rules, and the map viewport (tile sprites + paint overlay cells + trigger outlines + placement markers, all inside the ZonePainter's transformable sub-container).

**Layout:** the page is split into LEFT, RIGHT, and BOTTOM regions. The LEFT column is filled by a single pan/zoomable **map viewport** — every other map-related control has moved elsewhere so the viewport is as big as possible. The RIGHT column carries a **three-tab toggle** (BASIC INFO / NPCS AND MONSTERS / TRIGGERS) and the active picker, occupying the full page height. The BOTTOM bar carries the STARTING ZONES paint buttons (PLAYER / ALLY / ENEMY / NEUTRAL / CLEAR) aligned under the map column and the PLACEMENT MODE toggle (ZONES / EXACT) aligned under the right column. BACK and SAVE ENCOUNTER sit beneath that, separated by a horizontal divider.

| Component | Description |
| --------- | ----------- |
| **Outer tab bar** | Two chip-row tabs at the top: **ADJUDICATOR** (default — the deterministic editor described below) and **GENERATIVE AI** (free-text prompt + refine flow). Switching tabs swaps which HTML bucket is visible. |
| **Title row** | Centered "ENCOUNTER CREATOR" header (HTML). Subtitle directly below (HTML, centered) shows the loaded encounter's id + title, or `No encounter loaded — press OPEN ENCOUNTER` when nothing is loaded. |
| **Status line** | HTML text pinned to the bottom of the canvas and **center-aligned** across the full width. Shows the most recent feedback — e.g. `Loaded gen_1748394920_dungeon_sweep.` after OPEN ENCOUNTER, `Saving encounter…` while a save is in flight, `Saved gen_*.` on success, or the disabled-button hint when SAVE ENCOUNTER's preconditions aren't met. |
| **📂 OPEN ENCOUNTER** button | Top-right corner (HTML). Opens the [Encounter Picker Overlay](#encounter-picker-overlay) — a modal grid of cards listing every saved encounter. Selecting a card loads its state into the form. |
| **Map viewport** *(LEFT column, fills the column)* | Pan/zoomable viewport hosted by the shared `ZonePainter`. Tiles render at the largest size that fits both viewport dimensions (no upper cap) and are **centered** inside the viewport rect; scroll-wheel zooms around the cursor (clamped 0.3×–6×) and dragging with no paint brush active pans. A 1-px frame surrounds the viewport; a geometry mask clips content to the frame so panned tiles never spill onto the right column. Player / ally / enemy / neutral painted cells decode from the encounter's `startingZones.data` on load. **Rotated tiles render with the same flip-bit decoding as the in-game map**, so the preview matches what the player sees once the encounter starts. Trigger regions render as colour-coded outlined rectangles only when the active trigger row's WHEN is REGION (otherwise the rectangle is suppressed); in EXACT placement mode, per-entity tile bindings render as labelled markers (`P` for player, `E0` / `A1` / `N2` for indexed enemy/ally/neutral slots). A small footnote beneath the viewport reads `<map name>  ·  scroll to zoom · drag to pan`. There is **no click-to-enlarge** — inspection happens inline. |
| **Layer visibility toolbar** *(BOTTOM bar, above the paint buttons — aligned under the map column)* | Four small HTML chips: ZONES / TRIGGERS / MONSTERS / **MAP ZONES**. Click each chip to toggle that layer's visibility on the embedded preview — useful when zones + triggers + placement markers overcrowd the same view. **MAP ZONES** shows the named regions authored on the loaded map (`SavedMapDef.zones`) as translucent colour-coded cell fills with a centred zone-name label, so the author can see where each zone sits (and reference it from an ENTER MAP ZONE trigger). Active chips render with the brighter "active" background; inactive chips dim. The state is per-`ZonePainter` instance and persists across paint mode changes; newly-painted cells and re-rendered placements honour the current visibility flags. |
| **STARTING ZONES paint buttons** *(BOTTOM bar, left half — aligned under the map column)* | Five HTML buttons: PLAYER / ALLY / ENEMY / NEUTRAL / CLEAR. Click toggles the active brush; the active mode renders with a brighter background. In EXACT mode the brush labels include placement progress (`ENEMY 1/3` after binding one of three rolled enemy slots). |
| **PLACEMENT MODE toggle** *(BOTTOM bar, right half — aligned under the right column)* | Single HTML button labelled `MODE: ZONES` or `MODE: EXACT`. Toggles between zones mode (random spawn in painted cells) and exact mode (per-entity tile bindings written into the encounter's `placements[]`). Switching modes deactivates the active brush. |
| **BASIC INFO / NPCS AND MONSTERS / TRIGGERS tab toggle** *(RIGHT column, top)* | Three HTML buttons spanning the right column. Active tab renders with the brighter "active" colour. |
| **BASIC INFO tab** *(RIGHT column, basic-info tab — default)* | HTML `<input>` + `<textarea>` stack: TITLE input + PREVIEW button (plays the title as a full-screen supertitle so the author can see how it'll appear in-game), INTRODUCTION textarea, DESCRIPTION textarea (the AIGM sees this silently), OBJECTIVE input, COMPLETION FLAG input (snake_case slug), and an **ALLOWS LONG REST** toggle (`EncounterDef.allowsLongRest` — taverns / safehouses / camps tick this; wilderness exploration does not). Loaded from the encounter's `encounterTitle`, `customIntroduction`, `customContext`, `objective`, `completionFlag`, `allowsLongRest` fields. Intro + description textareas grow to fill the remaining panel height. |
| **MonsterPicker** *(RIGHT column, npcs-and-monsters tab)* | Fully HTML scrollable list of every monster **and NPC** def, with `+ ALLY` / `+ NEUTRAL` / `+ ENEMY` HTML buttons per row. Authored NPCs (`NPCDef`) appear above raw monsters and are tagged with their faction badge. Pre-populated from the loaded encounter's `allyIds` / `npcIds` / `enemyIds`. A summary box + CLEAR MONSTERS button sit beneath the list. Roster changes are pushed into the ZonePainter so EXACT-mode progress labels refresh and any placements bound to a now-removed slot are pruned. |
| **TriggerEditor** *(RIGHT column, triggers tab)* | Fully HTML scrollable list of trigger rows. Each row has a WHEN selector (REGION / **MAP ZONE** / ON START / ON COMPLETE / ON FLAG), kind chips (PERCEPTION / LOG / AIGM CUE / START COMBAT / AWARD XP / ANNOUNCE / SPEECH / FADE / SET FLAG / SET LONG REST / HIDE NPC / KILL NPC / OPEN CONVERSATION), region xywh inputs (visible only for REGION WHEN), a **map-zone dropdown** (visible only for MAP ZONE WHEN — lists the loaded map's named zones; selecting one fires the trigger when the player steps onto any of that zone's cells, compiled to `when: { event: 'player_moved', in_zone: { name, cells } }`), a flag-name matcher input (visible only for ON FLAG WHEN), per-kind config inputs, an **ADDITIONAL ACTIONS** section with a `+ ADD ACTION` button, and a REMOVE button — all HTML. The chip strip is the **primary action**; the additional-actions section lets the same WHEN fire any number of further consequences (each with its own chip row + per-kind block + REMOVE) so a single trigger condition can fan out without authoring N parallel triggers. Beneath the list sits the "+ ADD TRIGGER" button. There's no fixed cap on the number of triggers or extra actions — the list scrolls. The new editor kinds map to engine actions: **HIDE NPC** → `set_npc_hidden { defId, hidden, hideDC?, revealedBy? }` (see [data_structure.md](data_structure.md#triggers)); **KILL NPC** → `set_npc_dead { defId, dropInventory?, corpseSearch? }`; **OPEN CONVERSATION** → `start_conversation { npcRef, conversationId? }`. On load, triggers are reverse-mapped from the encounter's `triggers` array — each entry in `then[]` becomes a ComposedAction (the combat template `N × set_disposition_by_def_id + trigger_combat` collapses into a single START COMBAT action), with the first action driving the trigger's primary chip and the rest landing in the additional-actions list. Triggers whose `then[]` contains actions the editor doesn't know (e.g. a non-perception `player_ability_check`) are **preserved verbatim** on the server side — opening + saving in the editor never silently nukes hand-authored modern triggers. |
| **BACK** button | Bottom-left (HTML, `ghost` variant). Returns to Main Menu Scene. |
| **✓ SAVE ENCOUNTER** button | Bottom-right (HTML, `primary` variant). POSTs `/generate/encounter/update` with the current form state, including `placementMode` + `placements`. The handler merges the editable fields into the existing encounter JSON and rewrites it, **preserving every field the editor doesn't expose** (environment flags, tileProperties, generated badge, etc.). After save, the local encounters + maps registries are refreshed so a subsequent OPEN ENCOUNTER sees the latest version. The button stays clickable when its preconditions aren't met and surfaces a status-line hint ("Open an encounter first.", "Paint at least one player-start cell (PAINT: PLAYER).", "Place the player tile (click PLAYER, then click a tile)." in exact mode) instead of going silent. |

---

### Encounter Picker Overlay

`client/src/ui/generate/EncounterPickerOverlay.ts`. Modal Phaser overlay opened by the **OPEN ENCOUNTER** button on Encounter Creator Scene (and by the encounter-pick flow on Adventure Creator Scene). Lists every encounter in the `encounters` registry as a scrollable grid of cards.

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
| **Stats**     | Always                                                                    | Identity header (color swatch + name + species/class/level); five-cell stat strip (HP, AC, Speed, Initiative, Proficiency); six-cell ability score grid with modifiers; saving throws with proficiency dots; resources line (XP, gold, passive perception) and concentration chip when a spell is being concentrated on. |
| **Features**  | Always                                                                    | Walks the character's `ClassDef.progression[]` from L1 up through the current level and lists every feature the character has acquired, with a small `WIZARD L1` / `WIZARD L2` / `WIZARD L3` source caption per row. Each row shows the feature's name and SRD description. When the character has chosen a subclass (`playerDef.subclassId`), a labelled subclass header (name + description) appears underneath followed by every subclass feature unlocked at or below the current level. A *SUBCLASS-GRANTED SPELLS* footer lists always-prepared spells / cantrips from Domain / Oath / Circle / Patron lists (none ship in SRD 5.2.1 today). Features authored only in the class JSON without a feature file render the id as a placeholder name with an explicit "feature granted but its mechanics are not yet implemented" note. |
| **Story**     | Always                                                                    | Origin, species + lineage, and the character's background prose. |
| **Equipment** | Always (default tab)                                                      | Three equipment slot cards (Armor / Weapon / Offhand) with UNEQUIP buttons; scrollable carried-items list rendering categories in order — equippable (EQUIP button), consumables (USE button, dimmed when Bonus Action spent), **spell scrolls (CAST button — reads the scroll: server casts its spell and consumes it, US-124)**, ammunition (AMMO badge), gear (GEAR badge); stats bar at the bottom with AC / GP / main attack summary. Carries forward all rules from the pre-tab inventory panel: armor blocked from equip/unequip during combat (SRD donning time); weapon/shield first swap is free, second costs the Utilize Action. |
| **Spells**    | Caster only (`PlayerDef.spellcastingAbility` set)                         | Three-cell header (Spell Save DC / Spell Attack Bonus / per-level slot pool `L1 N/M`); three sections — Cantrips (always known), Prepared (currently castable), and Spellbook · Unprepared (known but not prepared this rest). Each spell row shows the name, a short mechanical summary (damage dice, save ability+DC, area / range, Concentration / Ritual / Reaction / Bonus Action tags), the level tag (`cantrip` / `L1`), and up to two action buttons: **CAST** (visible when the engine considers the spell castable right now; greyed out with a hover tooltip explaining the gate when the spell is known but currently uncastable — e.g. "Casting time exceeds a combat round (minute). Castable only out of combat."), and **RITUAL CAST** (visible for Ritual-tag spells the character knows during the exploring phase — casts as a ritual, no spell slot consumed). A spell that is both prepared and Ritual shows both buttons. **Upcasting (US-116):** when a spell has an "At Higher Levels" entry (`SpellDef.scaling`) and the player holds a slot above the spell's base level, pressing CAST first opens a **slot-level picker** (`SpellOptionPicker` — "Level 1 (base) / Level 2 / …") listing only the levels the player owns a slot for; the chosen level scales the spell's dice / darts / rays and spends a slot of that level. Ritual casts and cantrips never upcast (no slot is spent), so they skip the picker. **Component gate (US-116):** a spell with a Somatic or Material component greys out CAST (with the tooltip "No free hand — a Somatic or Material component needs one. Unequip a weapon or shield.") when the player has no free hand; a Verbal-only spell stays castable. A two-handed weapon takes both hands; a one-handed weapon and a shield take one each; a Versatile weapon counts as one hand. Each prepared/cantrip row also has a **✦ quickcast toggle** (filled accent when active) that adds/removes the spell from the Player Panel's **quickcast menu** (the CAST button) — a per-character `localStorage` set (`myrpg_quickcast_<id>`), client-only, no server round-trip. |
| **Close (×)** | Top-right corner; closes the overlay (Backdrop click also closes).        |                                                                                                                                                                                                                                                                     |

---

### Level Up Overlay

Defined in `client/src/ui/LevelUpOverlay.ts`. Modal HTML overlay opened by the `★ LEVEL UP` button on the Player Panel. Pauses the off-camera world tick via `WorldPause.acquire('overlay:level-up')` for the duration. The overlay reads a `LevelUpPreview` fetched from `GET /game/session/:id/level-up`; closing (× / backdrop) cancels and no server state changes. CONFIRM POSTs the assembled `LevelUpChoices` to `POST /game/session/:id/level-up`; on success the server returns the updated `PlayerDef` so the client refreshes `PlayerPanel.setPlayerDef` + `OverlayManager.setPlayerDef`. Supports **L1 → L4** for Fighter / Rogue / Wizard with subclass selection at L3 (Champion / Thief / Evoker).

| Component | Description |
| --------- | ----------- |
| **Header** | `LEVEL UP — {Class} {from} → {to}` in accent gold. |
| **Hit Points row** | `+H (max HP)` where H = `fixedHpForClass(className) + Con mod`, minimum 1. SRD "Fixed Hit Points by Class" table (Fighter 6 + Con, Rogue 5 + Con, Wizard 4 + Con). |
| **Proficiency Bonus row** | Shows the before / after value when the new level crosses a PB threshold (L5 / L9 / L13 / L17), or `+N (unchanged)` otherwise. |
| **Spell Slots row** | Only present when the new level grants additional slots (e.g. Wizard L2 → +1 L1 slot). |
| **New Class Features** | One row per feature gained at the target level (name + SRD description). Loaded from `defs.features` keyed by the per-class L2 catalogue in `server/src/engine/Leveling.ts`. |
| **Choices Required** | Renders per `LevelUpChoicePrompt` from the preview. One render block per prompt kind: <ul><li>**`scholar-expertise`** (Wizard L2) — chip group of the six SRD Scholar skills.</li><li>**`wizard-spellbook-add`** (Wizard L2 / L3 / L4) — chip list of L1+ wizard spells the character doesn't yet know, with a `picked / count` counter; empty when the player already knows every wizard spell of a level they can cast.</li><li>**`expertise-pick`** (Rogue L1 / L6) — chip group of skills the player is currently proficient in; multi-select with a `picked / count` counter.</li><li>**`fighting-style-pick`** (Fighter L1, Champion L7) — vertical card list of Fighting Style feats (Defense / Archery / Two-Weapon Fighting / Great Weapon Fighting). Picking one highlights the card.</li><li>**`subclass-choice`** (L3 for every class) — vertical card list of authored subclasses for the class with name + description. Selecting one highlights the card and sets `playerDef.subclassId`; the subclass's L3 features land at commit.</li><li>**`asi-or-feat`** (L4 / L8 / L12 / L16, plus Fighter L6 / L14) — mode toggle row (`+2 ONE ABILITY` / `+1 TWO ABILITIES` / `TAKE A FEAT`) above a detail area that renders the matching picker: ability chips showing `STR 14→16` (greyed out when current+delta > 20), two-ability multi-select capped at 2 with rolling replacement, or a scrolling card list of eligible feats.</li></ul> Fighter / Rogue / Wizard L2 require no choices and the section reads "This level requires no player choices." |
| **CANCEL** button | Bottom-right (`ghost` variant). Same effect as backdrop / × close — no server call, the world tick resumes. |
| **CONFIRM LEVEL UP** button | Bottom-right (`primary` variant). Disabled until every required choice has been answered. Click fires the commit; failures surface in the status line above the button. |

The level-up is persisted to the character save (`server/data/saves/{char}.json`) as an append to `levelUps: LevelUpChoices[]`. On session start (`GameEngine.createSession`) the recorded entries are replayed against a fresh `PlayerDef` clone so the engine's per-session view of the character reflects its current level even after a server restart.

---

### Long Rest Overlay

Defined in `client/src/ui/LongRestOverlay.ts`. Modal HTML overlay opened by the `☾ LONG REST` button on the Player Panel. Pauses the off-camera world tick via `WorldPause.acquire('overlay:long-rest')` for the duration. Reads a `LongRestPreview` from `GET /game/session/:id/long-rest`; closing (× / backdrop / CANCEL) cancels with no server state change. CONFIRM POSTs the assembled `LongRestChoices` to `POST /game/session/:id/long-rest`; the server returns the updated `PlayerDef` so the client refreshes `PlayerPanel.setPlayerDef` + `OverlayManager.setPlayerDef`.

SRD 5.2.1 grants every Long Rest benefit unconditionally for the rester: full HP, all spent Hit Dice, all spell slots, refreshes feature pools, reduces exhaustion by 1. The only authored choice surfaced on the overlay is the Wizard's prepared-spell list — the SRD lets a Wizard rebuild it on each Long Rest. Non-Wizard classes see a "no choices required" overlay with the restored summary only.

| Component | Description |
| --------- | ----------- |
| **Header** | `LONG REST — 8 hours of extended downtime` in accent blue. |
| **Hit Points row** | `+H (restored to maximum)` or `already at maximum`. |
| **Hit Dice row** | `+N restored` (SRD 5.2.1 restores ALL spent Hit Dice, not half). |
| **Spell Slots row** | Per-slot-level delta (`+M L1 · +N L2`) when the caster has unspent slots. |
| **Class Features row** | Per-feature `Name before→max` summary for every refilled pool (Action Surge, Second Wind, …). |
| **Exhaustion row** | `−1 level` or `none to remove`. |
| **Prepare Spells section** *(Wizard only)* | Spellbook spells rendered as toggle chips; clicking a chip adds / removes from the prepared list. A `picked / max` counter sits above the chips. Max comes from the SRD Wizard Features table (`L1 = 4`, `L2 = 5`, …) clamped up to whatever the character already has prepared (so feat-granted extras like Magic Initiate aren't silently stripped on rest). Cantrips are always available and don't count toward the cap — they're not shown in the picker. |
| **CANCEL** button | Bottom-right. Same effect as backdrop / × — no server call. |
| **CONFIRM LONG REST** button | Bottom-right. Always confirmable (the picker has a sensible default); disabled only while the commit is in flight. |

The post-rest state is persisted to `server/data/saves/{char}.json` (`hp`, `spellSlots`, `preparedSpellIds`, `resources`) so the rested character survives a session restart / chapter advance.

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

### Reroll Prompt Overlay

Defined in `client/src/ui/RerollPromptOverlay.ts`. Modal overlay surfaced when the server pauses to offer a **Heroic Inspiration** reroll (US-109a) — currently after a player attack roll while the player holds Heroic Inspiration. Opened and closed by `OverlayManager.syncRerollPrompt(state)`, which mirrors `state.pendingReroll`. While open, the attack's consequences are deferred on the server — the next player action must be a `resolveReroll`.

| Component | Description |
| --------- | ----------- |
| **Title** | `HEROIC INSPIRATION`. |
| **Body**  | The roll label (e.g. "Attack vs Bandit (A)"), the natural d20 rolled, and an outcome preview (`HIT — 7 slashing` / `MISS (14 vs AC 15)`) so the player can decide whether the reroll is worth it. |
| **REROLL** button | Accept. Server spends the Heroic Inspiration, re-resolves the attack with a fresh d20 (honouring the same Advantage/Disadvantage state), and applies the new outcome. |
| **KEEP ROLL** button | Decline. Server applies the outcome the player already saw; the Heroic Inspiration is **not** spent. |
| **Close (×) / Backdrop click** | Treated as "Keep roll" — never spends the player's Heroic Inspiration. |

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

### Mission Top Bar

Defined in `client/src/ui/MissionTopBar.ts`. Persistent floating button positioned at the top-centre of the canvas (12 px below the top edge, centred horizontally) by `UIScale.canvasRect` and re-positioned on every resize. Created in `GameScene.create()` and destroyed alongside the other panels in `shutdown()`. The mode is driven by `refreshMissionTopBar(state)` which runs on every state tick from `applyState`.

| Mode | Visible when | Label | Click behaviour |
| ---- | ------------ | ----- | --------------- |
| `to-mission` | `state.currentEncounterId === 'bureau_office'` AND `state.worldFlags.mission_pending` is a non-empty string | **▶ TO MISSION** in cool blue (`#88aacc`) | POSTs `/game/session/:id/transition` with `{ encounterId: <pending mission id> }`, swaps the session via `gameClient.resumeSession`, restarts the scene against the new session. |
| `leave-mission` | `state.currentEncounterId` starts with `mission_` | **◀ LEAVE MISSION** in warm amber (`#cc8866`) | Same transition flow targeting `bureau_office`. Visible regardless of whether the mission is complete — pressing it before defeating the enemies just walks the player away from an unfinished contract (the `mission_pending` flag stays set so they can come back to it). |
| `hidden` | Anywhere else | — | — |

Drives the Bureau-office mission cycle authored in `the_sundered_reach`: take a contract from Vask → press TO MISSION → defeat the enemies → press LEAVE MISSION → return to Vask for the payout.

---

### Next Chapter Button

Defined in `client/src/ui/NextChapterButton.ts`. Persistent floating button positioned at the top-center of the canvas (12 px below the top edge, centred horizontally) by `UIScale.canvasRect` and re-positioned on every resize. Created by `OverlayManager.syncChapterComplete` after the Wrap Up overlay is dismissed; destroyed when the player clicks it (or when `OverlayManager.reset()` runs at scene transition).

| Component | Description |
| --------- | ----------- |
| **Label** | `Next Chapter →` for non-final chapters; `Finish Adventure` for the final chapter. |
| **Click** | Calls `OverlayCallbacks.onAdvanceChapter` — GameScene closes the WS, calls `POST /adventure/:characterId/advance`, and either restarts the scene with the new chapter session or returns to the Main Menu when the adventure is complete. |

---

### Adventure Creator Scene

`client/src/scenes/AdventureCreatorScene.ts` — top-level scene reached via `MainMenuScene → ADVENTURE CREATOR`. Author-side counterpart to the player-facing Adventure Setup Scene. Lets the user assemble an adventure from existing encounter cards: title, description, AI context, an ordered chapter list, and a single rest encounter the player can return to between chapters.

**Layout:** the page is split into LEFT and RIGHT columns plus a BOTTOM bar. The LEFT column carries the **identity form** (id + title + description + introduction + AI context + REST ENCOUNTER picker + LOAD / SAVE controls). The RIGHT column carries the **ordered chapter list**. The BOTTOM bar carries BACK, LOAD ADVENTURE, SAVE ADVENTURE. All chrome is HTML.

| Component | Description |
| --------- | ----------- |
| **Title row** | Centered "ADVENTURE CREATOR" header (HTML). Subtitle below shows the loaded adventure's id, or `No adventure loaded — press LOAD ADVENTURE` when nothing is loaded. |
| **Identity form** *(LEFT column)* | HTML `<input>` + `<textarea>` stack: ID (snake_case), TITLE, DESCRIPTION (player-facing card text), INTRODUCTION (opening narration for chapter 1), AI CONTEXT (backstory, factions, themes, plot hooks — feeds the AIGM prompt for every encounter played as part of this adventure). |
| **REST ENCOUNTER picker** *(LEFT column)* | Single-encounter selector mirroring the chapter picker. Opens the [Encounter Picker Overlay](#encounter-picker-overlay) for the user to pick a single encounter card the player can return to between chapters. Optional — leave blank to disable the rest stop. Saved as `AdventureDef.restEncounterId`. |
| **Chapter list** *(RIGHT column)* | Scrollable HTML list of chapter rows. Each row shows the chapter id, title, the bound encounter id, and ↑ / ↓ / REMOVE controls. Click any row to edit its title / encounter binding inline. Empty state shows "No chapters yet — press + ADD CHAPTER below." |
| **+ ADD CHAPTER** button | Footer of the chapter list. Opens the Encounter Picker Overlay; the picked encounter is appended as a new chapter row with an auto-generated id. |
| **LOAD ADVENTURE** button | Opens the Adventure Picker Overlay — a modal grid of cards listing every saved adventure. Selecting a card loads its state into the form. |
| **BACK** button | Bottom-left (HTML, `ghost` variant). Returns to Main Menu Scene. |
| **✓ SAVE ADVENTURE** button | Bottom-right (HTML, `primary` variant). Persists the adventure to `server/data/settings/<setting>/adventures/<id>.json` via `POST /adventures/save`. After save, the local adventures registry is refreshed so a subsequent LOAD ADVENTURE sees the latest version. The button stays clickable when its preconditions aren't met and surfaces a status-line hint ("Type an ID first.", "Add at least one chapter.") instead of going silent. |
| **Status line** | HTML text above the bottom row — surfaces in-flight messages ("Saving…") and disabled-button hints. |

---

### Character Carousel

`client/src/ui/setup/CharacterCarousel.ts` — the three-card horizontal character selector at the top of the character column on both the **Encounter Setup Scene** and the **Adventure Setup Scene** (the **Character Detail** panel fills the space below it). The middle card is the selected character; the previous/next cards flank it dimmed, and the ◀ ▶ arrows (or clicking a side card) rotate the selection with wrap-around. A **Create Character** card — a dashed "＋ CREATE CHARACTER" tile — is always appended after the real characters as the last card in the rotation; centring it shows a *(click to create)* hint and clicking it opens the **Character Creator Scene**. With an empty roster the Create card is the only card. While the Create card is focused no character is selected, so the Character Detail panel clears and **BEGIN** is disabled. Beneath the carousel sits a **DELETE CHARACTER** button (hidden while the Create card is focused); it opens a **Confirmation Modal** (`client/src/ui/ConfirmModal.ts`) and, on confirm, permanently deletes the character definition (`DELETE /characters/:id`) and its save before refreshing the roster and rebuilding the scene.

### Character Creator Scene

`client/src/scenes/CharacterCreatorScene.ts` — a multi-step character-creation flow (US-122) reached from the **Create Character** card in the character carousel on the Encounter or Adventure Setup screen. A full-screen DOM panel with a **clickable tab rail** — **Concept · Origin · Abilities · Skills · Spells · Review** (the Spells tab is hidden for non-casters). The tabs are free-navigation: click any tab to jump straight to it (the ‹ PREV / NEXT › buttons remain for convenience but aren't required), and every change takes effect immediately with no apply/confirm step — e.g. switching class clears the now-invalid skill picks, switching species resets its grants, and the final ability scores update live as the origin bonus changes. The **Concept** step is the AI-assist entry: the player types a free-text concept and *ASK THE AI* calls `POST /generate/character`, which honours the active setting's lore and returns a setting-consistent suggestion (species/background/class, name, tagline, backstory, an ability priority, **and thematic build picks** — class skills, languages, and a caster's cantrips/level-1 spells chosen to fit the concept and explained in the rationale). The suggestion pre-fills every later step; the build picks are validated server-side against the chosen class/background, then the client **tops up any remaining required choice** (the species bonus skill, feat skills, or anything the AI left short) with deterministic defaults and leaves equipment at the default A/A — so the build is immediately **CREATE-able straight from Concept** without visiting the Skills/Spells steps. The player can still edit anything on any step. The step also offers a grid of **setting-fitting example concept cards** (`CONCEPT_EXAMPLES`) — clicking one drops its prompt into the concept textarea for editing, mirroring the Generator scene's example-prompt cards. When a species has a **subspecies** — Elf/Gnome lineage, Dragonborn / Goliath ancestry, or Tiefling legacy — a second dropdown appears to select it, and the species feature panel then **explains that subspecies' features** (the lineage cantrips/spells by level, the draconic breath/resistance damage type, the giant-ancestry gift, etc.). The **Origin** step's Species and Background dropdowns each render a **feature panel beneath them** describing what the selection grants — species traits (Darkvision, resistances, …) for the species; skill/tool proficiencies, the granted feat (name + description), the ability options, and the A/B equipment packages for the background. When the species grants an **Origin feat** (Human "Versatile"), an Origin-feat dropdown (with the chosen feat's description) appears under the species panel, and when it grants a **free skill** (Human "Skillful", Elf "Keen Senses") the Skills step shows an extra species-skill picker constrained to the species' allowed choices — both data-driven off the species traits' `originFeat` / `skillProficiency` effects. Origin also carries the SRD languages picker (US-123): every character knows Common and chooses two more from the Standard Languages table (class grants like the Rogue's Thieves' Cant are added automatically); known languages appear on the Character Sheet's Story tab. **Abilities** offers Standard Array, Point Buy (with a live remaining-points counter against the 27-point budget), or Roll (4d6-drop-lowest, rerollable), assigned via per-ability dropdowns or +/− steppers. Standard Array / Roll values are **single-use** — each row keeps a one-each permutation of the pool, and picking a value another ability holds swaps them. The step has an **origin-bonus picker** where the player chooses how the background's SRD ability increase is distributed — **+2/+1** to two of the background's three abilities (two dropdowns, kept distinct) or **+1/+1/+1** to all three — and every ability row shows the **final** score with that bonus broken out (e.g. *STR 15 +2 (Soldier) → 17 (+3)*). **Skills** renders the class, species-bonus (Human "Skillful") and feat-granted (Skilled) skill pickers as the **full skill list** with every skill name capitalised; skills already proficient from another source are shown **greyed and locked** with an *already proficient* note — SRD proficiency doesn't stack (a Proficiency Bonus is never added twice), so a skill granted by one source can't be re-picked by another. The caster **Spells** step enforces its SRD counts; it also renders a **Magic Initiate** picker for any feat that grants the feat (background-granted — Acolyte/Sage pin the spell list — or Human "Versatile"), where the player chooses two cantrips, one always-prepared level-1 spell (castable once per long rest without a slot, or with a slot), and the INT/WIS/CHA ability — so the step appears even for a non-caster who took Magic Initiate. **Review** edits name/tagline/backstory and exposes **AI identity generation** — *GENERATE ALL* or per-field *NAME / TAGLINE / BACKSTORY* buttons call `POST /generate/character/identity`, which produces the requested field(s) from the full build (species/background/class, top abilities, skills, languages) honouring the setting lore; un-requested fields are passed as context and left untouched. Review also lists the **class and background starting-equipment options in full** — every item in each A/B[/C] choice, with the selected loadout highlighted — shows the **combined starting gold** (selected class option + selected background option), and a stat summary (final scores). **✓ CREATE** posts the choices to `POST /characters`; on success the roster is re-fetched into the registry and the scene returns to Encounter Setup, where the new character appears in the carousel. CANCEL / ‹ BACK / NEXT › navigate the steps.

### NPC Creator Scene

`client/src/scenes/NpcCreatorScene.ts` — top-level scene reached via `MainMenuScene → NPC CREATOR`. Author-side page for building NPCDefs.

An NPC is a thin identity wrapper around a monster: the `monsterClass` field picks which monster's stat block (HP / AC / attacks / saves) the NPC inherits at spawn time; the NPC layer adds a display name, optional faction tag, optional persona blurb the AIGM reads when roleplaying the character, and an optional per-NPC token asset.

**Layout:** LEFT column hosts the form inputs (ID, NAME, MONSTER CLASS dropdown, FACTION dropdown, COLOR, TOKEN ASSET, PERSONA textarea). RIGHT column hosts a live preview of the chosen monster's stat block so the author can confirm what the NPC will actually fight with. BOTTOM bar carries BACK, LOAD NPC, SAVE NPC.

| Component | Description |
| --------- | ----------- |
| **ID input** *(LEFT)* | snake_case slug; becomes the JSON filename. |
| **NAME input** *(LEFT)* | Display name shown above the token and in the Target Panel. |
| **MONSTER CLASS dropdown** *(LEFT)* | Picks the `MonsterDef` whose stat block the NPC inherits. Required — the engine's `SpawnHelpers.spawnNpc` resolves stats via this id, not from any embedded NPC fields. |
| **FACTION dropdown** *(LEFT)* | Optional `FactionDef` id. Drives combat-side AI alignment and the Target Panel faction chip. |
| **COLOR input** *(LEFT)* | Hex colour for the token outline (e.g. `#aabbcc`). |
| **TOKEN ASSET input** *(LEFT)* | Path to the NPC's SVG (e.g. `/tokens/npc_<id>.svg`). Optional — when blank the engine falls back to the monster's token. |
| **PERSONA textarea** *(LEFT)* | Free-text blurb the AIGM reads when roleplaying the NPC. "How they speak, what they know, who they fear" — short and specific beats long and generic. |
| **INHERITED STAT BLOCK preview** *(RIGHT)* | Live preview of the chosen monster's stat block — HP, AC, Speed, CR, XP, init bonus, ability scores with modifiers, and the attacks list. Refreshes on every monster-class change so the author always sees an up-to-date preview. |
| **LOAD NPC** button | Opens the NPC Picker Overlay — a modal grid of cards listing every saved NPC. Selecting a card loads its state into the form. |
| **BACK** button | Bottom-left (HTML, `ghost` variant). Returns to Main Menu Scene. |
| **✓ SAVE NPC** button | Bottom-right (HTML, `primary` variant). Persists the NPC to `server/data/settings/<setting>/npcs/<id>.json` via `POST /npcs/save`. After save, the local NPCs registry is refreshed so a subsequent LOAD NPC sees the latest version. |
| **Status line** | HTML text above the bottom row — surfaces in-flight messages ("Saving…") and disabled-button hints. |

---

### Token Creator Scene

`client/src/scenes/TokenCreatorScene.ts` — top-level scene reached via `MainMenuScene → TOKEN CREATOR`. Standalone page for assembling NPC tokens by mixing SVG fragments (body / ears / face / beard / eyes / mouth / hair / accessory) and three palette colours.

The composed SVG is saved through `POST /token`, which writes both the flattened `data/tokens/<id>.svg` (referenced via `NPCDef.tokenAsset`) and the editable `data/tokens/specs/<id>.json` so a re-open restores every slot pick + palette choice. The `tokenAsset` path returned to the client can be dropped straight into the NPC Creator's TOKEN ASSET PATH field.

**Layout:** LEFT column hosts the large live preview (256 × 256), the palette pickers (body / skin / hair), the ID input, and a RANDOMIZE button. RIGHT column hosts a scrollable slot picker — one section per slot showing every option as a small thumbnail; clicking selects. BOTTOM bar carries BACK, LOAD TOKEN, SAVE TOKEN.

| Component | Description |
| --------- | ----------- |
| **Live preview** *(LEFT, top)* | 256 × 256 composed token. Updates on every slot or palette change. |
| **Palette pickers** *(LEFT, mid)* | Three hex inputs + colour swatches: BODY, SKIN, HAIR. Stored as `TokenSpec.palette`. |
| **ID input** *(LEFT, bottom)* | snake_case slug; becomes the SVG filename + the spec filename. |
| **★ RANDOMIZE** button | LEFT, bottom. Rolls a random pick per slot + a random palette. |
| **Slot picker** *(RIGHT, fills the column)* | Scrollable list with one section per slot in z-order (BODY → EARS → FACE → BEARD → EYES → MOUTH → HAIR → ACCESSORY). Each section shows every part as a small thumbnail; clicking selects. Selected thumbnails highlight with the accent border. A "none" thumbnail at the start of each optional slot clears the pick. |
| **LOAD TOKEN** button | Opens the [Token Picker Overlay](#token-picker-overlay) — a modal grid of cards listing every saved token spec. Selecting a card loads its state into the form. |
| **BACK** button | Bottom-left (HTML, `ghost` variant). Returns to Main Menu Scene. |
| **✓ SAVE TOKEN** button | Bottom-right (HTML, `primary` variant). Composes the SVG from the spec + the in-memory parts library and writes BOTH `data/tokens/<id>.svg` (flattened) and `data/tokens/specs/<id>.json` (editable). Returns the token's asset path so the caller can drop it straight into the NPC Creator's TOKEN ASSET PATH field. |
| **Status line** | HTML text above the bottom row — surfaces in-flight messages ("Saving…") and disabled-button hints. |

### Tile Creator Scene

`client/src/scenes/TileCreatorScene.ts` — top-level scene reached via `MainMenuScene → TILE CREATOR`. Standalone page for editing a tileset's per-tile attributes (the global **tile legend**). The author picks a tileset, clicks one of the tiles **declared in that tileset's legend**, and edits its entry.

Each save goes through `PUT /tilesets/:tileset/tiles/:gid`, which writes the entry into `server/data/tilesets/<tileset>_legend.json` (preserving the notes block and every other tile) and reloads defs, so the new semantics take effect on the next session. The legend is global; per-encounter overrides still live in `EncounterDef.tileProperties`.

**Layout:** LEFT column hosts the tileset picker, a preview of the selected tile (cropped from the tileset PNG), and the attribute controls + SAVE. RIGHT column hosts a scrollable grid of the tiles in the chosen tileset's legend (not the raw spritesheet). BOTTOM bar carries BACK and SAVE TILE.

| Component | Description |
| --------- | ----------- |
| **Tileset picker** *(LEFT, top)* | Dropdown of every tileset with a legend file. Switching repaints the frame grid and clears the current selection. |
| **Frame preview** *(LEFT, mid)* | Pixel-cropped preview of the selected frame + a `<tileset> · GID <n>` label. |
| **NAME** input | Short identifier, e.g. `stone_wall`. Required to save. |
| **LAYER** select | `ground` or `object`. |
| **Blocks movement** / **Blocks sight** checkboxes | The two independent blocking flags baked into `GameMap.blocksMovement` / `GameMap.blocksSight`. |
| **COVER** / **OBSCURANCE** selects | SRD cover (none / half / three-quarters / total) and obscurance (none / lightly / heavily). |
| **TAGS** input | Comma-separated free-form tags. |
| **DESCRIPTION** textarea | Shown to AI map generators. |
| **Tile grid** *(RIGHT, fills the column)* | One clickable thumbnail per tile declared in the tileset's legend (cropped from the tileset PNG), grouped under **GROUND** / **OBJECT** layer headers and sorted by GID within each group; clicking loads its attributes into the LEFT controls. The selected tile highlights with the accent border. |
| **BACK** button | Bottom-left (HTML, `ghost` variant). Returns to Main Menu Scene. |
| **✓ SAVE TILE** button | Bottom-right (HTML, `primary` variant). Upserts the legend entry via `PUT /tilesets/:tileset/tiles/:gid`. |
| **Status line** | HTML text above the bottom row — save progress and validation hints. |

### Token Picker Overlay

`client/src/ui/generate/TokenPickerOverlay.ts`. Modal Phaser overlay opened by the **LOAD TOKEN** button on Token Creator Scene. Lists every saved token SVG (`GET /tokens`) as a scrollable grid of cards; cards whose id matches an entry in `GET /token-specs` are flagged as "editable" so the user knows clicking them will re-open the spec rather than just preview a flat SVG.

| Component | Description |
| --------- | ----------- |
| **Backdrop** | Semi-transparent black covering the whole canvas; swallows pointer events. |
| **Header** | "LOAD TOKEN" accent tag with a `<N> saved tokens` subtitle. |
| **Token card grid** | Cards laid out in rows of ~6 (auto-fits to panel width). Each card renders the SVG at ~96 px and shows the id below. Cards with an editable spec are highlighted; legacy SVGs without a spec are dimmed and tagged `flat`. Wheel-scrolls vertically when the cursor is over the grid. |
| **Card click** | Resolves the token id back to the parent scene, which fetches `/token-specs/:id` and loads it into the form (or surfaces a hint when the SVG is flat). |
| **CLOSE** button | Bottom-right. Dismisses the overlay without loading anything. |
