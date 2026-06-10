> **Audience:** product managers, developers · **Status:** current · The user-facing capability list — *what* the product does, grouped by domain. Each entry keeps its `US-xxx` id for traceability and links to the detailed *how* in the design spec.

# Requirements

Each domain states implemented user-facing capabilities as `US-xxx` stories. The
engineering specification for each — resolver shapes, data fields, file
locations — is in the linked design doc.

## SRD 5.2.1 Rule Implementation

*Full specification: [design/systems/srd-rules.md](../design/systems/srd-rules.md).*

- **US-001** As a player, I want to move my character around the world using keyboard input (WASD and arrow keys) so that I can explore the game world.
- **US-005** As a player, I want to engage in turn-based combat with enemies so that exploration feels challenging and rewarding.
- **US-017** As a developer, I want every creature's stat block to be sourced directly from the D&D 5e SRD 5.2.1 so that combat mechanics are correct and new creatures can be added without guesswork.
- **US-024** As a player, I want to fight multiple enemies in a single combat encounter so that battles feel more strategic.
- **US-025** As a player, I want the action economy to follow D&D 5e SRD rules so that combat feels authentic.
- **US-034** As a player, I want to throw inventory items as ranged attacks so that I have a ranged option when no adjacent enemy is present.
- **US-035** As a developer, I want all SRD weapon mastery properties implemented so that weapons behave correctly.
- **US-036** As a player, I want saving throws tracked for all creatures so that the AIGM can call for saves when the story demands it.
- **US-037** As a player, I want my full skill list stored and used in play so that ability checks reflect my character's actual proficiencies and create meaningful risk.
- **US-041** As a player, I want every creature — player, allies, enemies, and NPCs — to make Opportunity Attacks when an opponent moves out of their reach, so that positioning carries meaningful risk for everyone in the encounter.
- **US-042** As a player, I want Dash, Dodge, and Disengage actions so that I have tactical options beyond attacking.
- **US-043** As a developer, I want a formal Advantage/Disadvantage system so that all D20 Test modifiers are consistent and composable.
- **US-046** As a player, I want to take a Short Rest after an encounter so that I can recover HP between fights by spending Hit Dice.
- **US-047** As a developer, I want Passive Perception implemented so that hiding is not an automatic success.
- **US-048** As a player, I want Surprise to apply when combat starts unexpectedly.
- **US-049** As a developer, I want Massive Damage / Instant Death implemented.
- **US-051** As a developer, I want a formal conditions framework so that status effects are consistent, visible, and extensible.
- **US-053** As a developer, I want monster Resistance, Vulnerability, and Immunity modeled so that damage is applied correctly per SRD stat blocks.
- **US-054** As a player, I want NPCs to have a **combat disposition** (ally, neutral, or enemy) so that the same entity can shift sides during a fight without losing its identity.
- **US-055** As a player, I can attack a neutral NPC outside of combat to start a fight, so that I have agency over when and against whom combat begins. An attack or aggressive spell cast in the exploring phase that would start combat first raises a confirmation prompt: declining discards the action (nothing happens, no resources spent); confirming rolls Initiative but does **not** auto-perform the triggering action — the player acts normally on their turn. The off-camera world tick freezes while the prompt is open.
- **US-060** As a developer, I want every combatant to roll Initiative independently so that turn order reflects each creature's roll, not a player-vs-enemy duel.
- **US-061** As a player, I want Hide to follow SRD action economy.
- **US-062** As a developer, I want SRD-faithful equip/unequip enforcement so that gear changes respect time and action economy.
- **US-063** As a player, I want to use a bow with ammunition so that I have a true ranged combat option.
- **US-065** As a player wizard, I want to cast spells from my prepared list and known cantrips so that I have a magical combat option.
- **US-066** As a developer, I want class features to be authored as data + handler so that adding new class abilities scales across SRD classes without touching the Player Panel. (Framework complete; 5 of 12 classes authored so far: Cleric, Fighter, Rogue, Warlock, Wizard.)
- **US-067** As a player, I want to be prompted before spending a Reaction so that I keep tactical control over the resource.
- **US-068** As an encounter author, I want a deterministic living-world layer — an event bus, authorable triggers, and canned narration variants — so that an encounter plays end-to-end without the generative GM in the loop.
- **US-069** As a game designer, I want the deterministic living-world layer to express morale, pacing, and long-term memory so that an encounter feels alive without the generative GM.
- **US-073** As a developer, I want the NPC `hold` behaviour to take the SRD Dodge action instead of standing inert, so a creature without a useful attack still gets a defensive benefit.
- **US-080** As a developer, I want the foundation for a faction-relation system so subsequent passes can let NPCs have complex dispositions toward each other (not just toward the player) — bandits versus guards, predators versus prey, three-way standoffs — without re-plumbing the engine each step.
- **US-091** As a player, I want to earn experience and level my character through L1 → L4 so that combat choices and class identity grow with play.
- **US-120** As a player, I want to play additional SRD classes beyond the original four — the **Cleric** (Life Domain, Channel Divinity, daily preparation) and the **Warlock** L1–4 (**Pact Magic** with short-rest slot recovery and pact-level auto-upcast, **Eldritch Invocations** incl. Agonizing Blast, **Magical Cunning**, and the **Fiend Patron** with Dark One's Blessing) — so that party archetypes beyond martial/divine/arcane basics are playable.
- **US-117a** As an encounter designer, I want stat-block monsters to actually cast their SRD spells — limited-use offensive AoE (with friendly-fire avoidance and origin line-of-sight), bonus-action mobility (Misty Step), concentration self-buffs (Invisibility, Fly), and reaction magic (Protective Magic: Shield + Counterspell with the 5.2.1 slot-preservation rule) — so that caster monsters like the Mage fight with their full kit.
- **US-094** As a developer, I want an NPC simulation layer so that off-camera NPCs follow daily routines, react to noise and combat, and can be bound as the player's companion without the encounter author having to script every step.
- **US-092** As a player, I want every NPC to carry a **social Attitude** (Friendly / Indifferent / Hostile) **parallel to but distinct from combat Disposition** (US-054), so that social interactions and ability checks reflect how a creature feels about me without being conflated with whether they're currently in combat with me.
- **US-095** As a player, I want concealed traps and deployable area-denial gear so that stealth, gadgetry, and clever use of equipment are first-class tactical options.
- **US-045** Cover at attack resolution is implemented for both player and NPC attacks: Half Cover (+2 AC), Three-Quarters Cover (+5 AC), Total Cover (untargetable), determined geometrically with no stacking (most protective degree only) per SRD `Cover.md`.

## Content Generation

*Full specification: [design/systems/content-generation.md](../design/systems/content-generation.md).*

- **US-002** As a player, I want to choose a character from the available roster before the encounter begins so that I can experience different combat styles.
- **US-003** As a player, I want to see my character's stats in a toggleable sidebar so that I can inspect my current HP, AC, speed, ability scores, and XP without interrupting play.
- **US-006** As a player, I want to pick up, manage, and use items in an inventory so that I can equip myself for challenges.
- **US-007** As a player, I want to receive and track quests so that I have clear goals and a sense of progression.
- **US-008** As a player, I want my game state saved and loaded automatically so that I can continue where I left off.
- **US-016** As a player, I want to click a creature in the game map to select it so that I can inspect its stats.
- **US-018** As a player, I want to zoom in and out on the game map using the mouse wheel so that I can get a better view of the battlefield.
- **US-021** As a player, I want to select a Social Interaction encounter so that I can engage with an NPC rather than fight.
- **US-022** As a player, I want to select the Exploration encounter type so that I can discover hidden secrets on the map.
- **US-023** As a player, I want to play on hand-crafted saved maps so that I can experience specific layouts.
- **US-026** As a developer, I want all game content served from the Fastify REST API so that content can be updated centrally without redeploying the client.
- **US-027** As a developer, I want NPCs to be a distinct data type from monsters so that non-combat characters can carry dialogue personas without polluting SRD stat blocks.
- **US-028** As a player, I get an introduction to the encounter when I start it so that I feel more immersed in it.
- **US-029** As a player, I can select from a list of premade encounters so that I can replay encounters I enjoy.
- **US-031** As a player, I can open a conversation with an AI Game Master (AIGM) at any time during an encounter so that I can interact with the world through free-form text.
- **US-032** As a player, I want to find and equip gear with stats so that my equipment choices meaningfully affect gameplay.
- **US-033** As a player, I want to see my save information inside the character selection card so that I know where each character left off.
- **US-038** As a player, I can open my character sheet to see my stats, manage gear, and review prepared spells without leaving the encounter.
- **US-039** As a player, I can choose between multiple AIGM personas so that I can tailor the game to my mood.
- **US-040** As a player, I can get a user interface that automatically fits the available space, so I can play the game on different browser window sizes.
- **US-056** As a developer, I want feats, backgrounds, and species from SRD 5.2.1 chapter 04–05 stored as structured data objects so that character definitions reference them by ID rather than duplicating their mechanical effects.
- **US-059** As a player, I can read a Story Log which gives me an AI-generated prose recap of every encounter I have completed, so that I can build a narrative record of my character's adventures.
- **US-064** As a player, I want the world built from tilemaps so that levels are visually rich and easy to author.
- **US-070** As a player, I want to play **Adventures** — a string of encounters with overarching narrative and choices that carry across chapters — so that what I do in chapter 1 shapes what happens in chapter 3.
- **US-071** As a player, I want to **generate** a one-off encounter from a free-text scene description so that I can play a brand-new scenario without authoring a JSON file.
- **US-072** As a player, I want to iterate on a map design without committing to a full encounter, so I can browse layouts until I see one I like.
- **US-074** As a player, I want creatures rendered with hand-drawn SVG tokens instead of coloured circles so the map and turn-order bar are more visually distinct.
- **US-075** As a player, I want the turn-order bar to show creature artwork so I can identify combatants at a glance, with the active creature visually emphasised.
- **US-076** As an encounter author, I want the deterministic engine's Event Log to be sufficient on its own so a player can finish an encounter without ever opening the GM tab.
- **US-077** As a player, I want the Adjudicator to roll a complete encounter on its own that I can then inspect, edit, and save, so authoring a fresh scenario is a one-click starting point — not a black box.
- **US-078** As an encounter author, I want to start a new encounter from an existing saved map without re-composing one, so I can build several encounters that reuse the same layout.
- **US-079** As an encounter author, I want to open and edit an existing encounter so I can iterate on its title, monsters, starting zones, and triggers without re-authoring from scratch.
- **US-081** As a content author, I want a dedicated **Map Editor** page focused exclusively on producing and saving maps so that the Encounter Creator can pick them up later as content.
- **US-082** As a content author, I want an **NPC Creator** page so that I can build named NPCs on top of an existing monster's stat block instead of hand-editing JSON.
- **US-083** As a content author, I want a **Token Creator** page so that I can assemble NPC token SVGs from a library of mix-and-match parts instead of hand-drawing each one.
- **US-083b** As a content author, I want a **Tile Creator** page so that I can set each tile's attributes through the UI instead of hand-editing the legend JSON. `client/src/scenes/TileCreatorScene.ts` is reached via `MainMenuScene → TILE CREATOR`. The page edits the **global tile legend** (`server/data/tilesets/<tileset>_legend.json`); per-encounter overrides still live in `EncounterDef.tileProperties`. **Layout:** LEFT column has a tileset dropdown, a pixel-cropped preview of the selected frame, and the attribute controls — NAME, LAYER (ground/object), **Blocks movement** + **Blocks sight** checkboxes, COVER (none/half/three-quarters/total), OBSCURANCE (none/lightly/heavily), TAGS (comma-separated), DESCRIPTION (shown to AI map generators). RIGHT column is a scrollable grid of the tiles declared in the chosen tileset's legend (cropped from the tileset PNG, sorted by GID) — only legend tiles are shown, not the raw spritesheet. Clicking a tile loads its attributes into the LEFT controls. Bottom bar: BACK, SAVE TILE. **Server-side save** (`PUT /tilesets/:tileset/tiles/:gid`) validates the entry, writes it into the tileset's legend file (preserving notes + every other tile), and reloads defs so the new movement/sight/cover semantics apply to the next session. This page replaced the old read-only "Configure Tiles" enable/disable overlay, which has been removed along with the `disabledTiles` system.
- **US-084** As an adventure author, I want an **Adventure Creator** page so that I can string saved encounters into an adventure with overarching narrative, AI context, and a rest stop between chapters.
- **US-085** As an encounter author, I want **`set_long_rest`** as a trigger action so that a safe-haven encounter can unlock Long Rest mid-play once the player reaches a safe area.
- **US-086** As a game designer, I want a **hidden-NPC system with two reveal modes** so encounters can author both stealth ambushers and trigger-locked narrative reveals.
- **US-087** As a game designer, I want a **`dead` condition + searchable corpse system** so encounters can author found-bodies-as-clues without engine code changes.
- **US-088** As an encounter author, I want **distinct DESCRIPTION (player-facing) and AIGM CONTEXT (long-form scene grounding) fields** in the Encounter Creator so the two audiences are not collapsed into a single textarea.
- **US-089** As an encounter author, I want **layer-visibility toggles on the embedded map preview** so I can inspect zones, triggers, and monster placements independently without overcrowding the same view.
- **US-093** As a developer (or Claude Code debugging a player report), I want a **structured session log** parallel to the player-facing Event Log so that "X went wrong at minute 12" can be diagnosed from a single NDJSON file without re-running the encounter.
- **US-090** As an encounter author, I want a **single trigger condition to fan out into multiple consequences** so I can express "the dead stir" beats without authoring a parallel trigger per action.
- **US-096** As a map author, I want the **GENERATIVE AI map builder to direct deterministic tools via tool-use** instead of emitting a raw tile array, so generated maps are always valid and far more consistent.
- **US-097** As a map author, I want **deterministic-editor refinements**: a correctly-oriented tavern door, a stairs entrance option for caves/dungeons, and the ability to grow a map's bounds in the EDIT tab.
- **US-098** As a map author, I want a **STRUCTURES section** in the DETERMINISTIC tab (below FEATURES) with **Small Buildings** and **Small Ruins** options.
- **US-099** As a map author, I want to **add and individually configure structures** — choosing each one's **type** (building / ruin) and its **number of connected rooms** — rather than only setting two fixed single-room counters.
- **US-100** As a player, I want the deterministic Tavern / Cave / Town maps to read more distinctly.
- **US-101** As an encounter author, I want the **dungeon and cave to emit author-time zones** like the other composers, so their rooms are addressable for spawn/trigger authoring.
- **US-102** As a map author, I want **3 / 5 Rooms to be a mutually-exclusive choice** on Dungeon and Cave, each shaping the layout.
- **US-103** As a content author, I want **The Moon's Ledger** rebuilt on **bespoke maps from the new map creator** rather than reused generic maps (it previously shared `broken_ward` across two chapters).
- **US-104** As an engine maintainer, I want passive feat/feature mechanics to be **data-driven via a modifier aggregator** instead of scattered `includes(featId)` branches — Phase 1 of making spells/feats/classes content data-only.
- **US-105** As an engine maintainer, I want spell **self-buffs to be data-driven** instead of a `switch(spell.id)` block with per-spell concentration cleanup — Phase 2 (first slice) of the effect-system effort.
