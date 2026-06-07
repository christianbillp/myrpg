# Data Structure

All game content lives in `server/data/` as plain JSON files. Each subdirectory holds one type of data; adding a new file to a directory is all that is needed to register new content — the server reads every `.json` file in the directory on startup.

```
server/data/
├── backgrounds/        # SRD character backgrounds
├── characters/         # Playable character definitions
├── equipment/          # SRD equipment (weapons, armor, shields, consumables)
├── feats/              # SRD feats
├── maps/               # Hand-crafted encounter maps
├── monsters/           # Enemy and NPC stat blocks (SRD)
├── npcs/               # Named NPCs — identity + persona layered over a monster stat block
├── encounters/         # A flavored combination of a map and one or more NPCs
├── saves/              # Runtime save files (written by the server, not hand-authored)
├── species/            # SRD player species (Dragonborn, Dwarf, Elf, …)
├── spells/             # SRD spells (cantrips + level 1+)
├── features/           # Class features (Second Wind, Rage, Sneak Attack, …)
└── tilesets/           # Shared tile palettes (image + .tsj + AI-facing legend)
```

---

## characters/

One file per playable character. Defines identity, ability scores, class features, and default loadout. Several fields are **not stored in the JSON** — they are computed at runtime in this order:

1. `applySpecies` — reads `speciesId` + `speciesLineage` from `species/` to derive `speed`
2. `applyModifiers` — aggregates the `modifiers` from this character's `featIds` (`feats/`) + `defaultFeatureIds` (`features/`) onto `PlayerDef.modifiers`, then derives the legacy `savageAttacker` / `fightingStyleDefense` booleans from it (see [Modifier aggregator](#modifier-aggregator))
3. `applyEquipment` — reads `defaultEquipment` from `equipment/` to derive effective `ac` and `mainAttack`

### Fields

| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique key. Used as the character save filename (`saves/{id}.json`). |
| `name` | string | Display name. |
| `speciesName` | string | Human-readable species label, e.g. `"Human"`, `"Wood Elf"`. |
| `speciesId` | string | `id` of an entry in `species/`. Used by `applySpecies` to derive `speed` and lineage traits. |
| `speciesLineage` | string \| null | Lineage sub-choice within the species (e.g. `"wood-elf"` within Elf). `null` for species with no lineage option. |
| `className` | string | e.g. `"Fighter"`, `"Rogue"`. |
| `backgroundId` | string | `id` of an entry in `backgrounds/`. |
| `featIds` | string[] | Ordered list of feat `id` values from `feats/`. Each feat's `modifiers` are aggregated by `applyModifiers` onto `PlayerDef.modifiers`. |
| `level` | number | Character level. Determines Hit Dice count. |
| `maxHp` | number | Maximum hit points. |
| `str` `dex` `con` `int` `wis` `cha` | number | Ability scores (standard 3–20 range). |
| `proficiencyBonus` | number | Added to attack rolls and proficient skill/save checks. |
| `savingThrowProficiencies` | string[] | Ability names this class is proficient in, e.g. `["str","con"]`. Saving throw totals are computed at runtime. |
| `skills` | object | All 18 SRD skills keyed by camelCase name. Each value is the **pre-computed total modifier** (ability mod ± proficiency). |
| `defaultFeatureIds` | string[] | *(optional)* Ids of class features this character knows (e.g. `["second-wind"]` for a Fighter). At session start, each listed feature seeds a resource pool in `PlayerState.resources` from its `resource.max`. See [`features/`](#features-1). |
| `hitDieType` | number | Die size for Hit Dice: `10` (Fighter), `8` (Rogue). |
| `sneakAttackDice` | number | Number of d6 Sneak Attack dice. `0` for non-Rogues. |
| `color` | number | Token colour as a decimal integer (RGB hex, e.g. `5227511` = `#4FB8F7`). |
| `xp` | number | Always `0` — live XP is tracked in the save file. |
| `defaultEquipment` | object | Starting equipped gear: `{ armorId, weaponId, shieldId }`. Each value is an item `id` or `null`. |
| `defaultInventoryIds` | string[] | Starting carried items by item `id`. Repeat the same id to create a stack, e.g. `["javelin","javelin","javelin"]`. |
| `defaultGold` | number | *(optional, default `0`)* Starting gold pieces the character spawns with on a fresh encounter (typically the sum of class + background starting GP). Resumed sessions use the saved gold value instead. |
| `spellcastingAbility` | string | *(optional, caster-only)* `"int"` / `"wis"` / `"cha"`. Drives spell save DC (= 8 + PB + ability mod), spell attack bonus (= PB + ability mod), and concentration CON save proficiency. Absent for non-casters. |
| `defaultCantripIds` | string[] | *(optional, caster-only)* Always-known cantrip ids from `spells/`. Cantrips don't consume slots and aren't part of the prepared list. |
| `defaultSpellbookIds` | string[] | *(optional, wizard-style)* Full known spell list. A subset is "prepared" at any moment. |
| `defaultPreparedSpellIds` | string[] | *(optional, caster-only)* Subset of `defaultSpellbookIds` (or fixed-list classes) currently castable. Wizards mutate this on Long Rest. |
| `defaultSpellSlots` | number[] | *(optional, caster-only)* Starting slot pool by level − 1, e.g. `[2]` = 2 × L1 slots, no higher. Refilled on Long Rest. |
| `magicInitiateSpellIds` | string[] | *(optional)* SRD Magic Initiate — the always-prepared level-1 spell(s) the feat grants, tracked separately from the class prepared/spellbook lists. Each is castable once per Long Rest without a slot via a `magic-initiate:<spellId>` entry in `player.resources` (seeded by `SessionBuilder`, refilled in `Resting`), or with a normal slot. The feat's two cantrips fold into `defaultCantripIds`, and a non-caster gains `spellcastingAbility` from it. `canCastSpell` treats these spells as known + slot-or-free-cast; `consumeCastingResources` spends the free cast when no slot is available. Built by `CharacterBuilder.applyMagicInitiate` from the per-feat `CharacterCreationChoices.magicInitiate` picks (the spell list is pinned by a background that fixes it, e.g. Acolyte → cleric, Sage → wizard). |
| `description` | string | Character backstory. Surfaced to the AIGM as persona context. |
| `tokenAsset` | string | *(optional)* Path to the SVG token sprite, e.g. `/tokens/player_fighter_human.svg`. When omitted, the path is derived by convention: `/tokens/player_<className_lower>_<speciesLineage \| speciesId, dashes stripped>.svg`. See [tokens/](#tokens-1). |

**Fields computed at runtime (absent from JSON):**

| Field | Computed by | How |
|---|---|---|
| `speed` | `applySpecies` | Species base speed + lineage speed bonus (e.g. Wood Elf +5) |
| `size` | `applySpecies` | SRD `CreatureSize` from the species (`'medium'` default; choice species pick the larger). Gates size-dependent rules (US-107). |
| `resistances` `vulnerabilities` `immunities` | `applySpecies` | *(US-108)* Damage types the character resists / is vulnerable / immune to, seeded from species `damageResistance` traits (the `"ancestry"` placeholder resolves to the chosen Draconic Ancestry's damage type). Read by `GameEngine.applyDamageToPlayer` via `playerResistMod`, mirroring monster resistance. |
| `originModifiers` | `applySpecies` | *(US-108)* Typed `Modifier`s from species/background traits (e.g. Advantage on saves vs Poisoned, Advantage on INT saves). Concatenated into `modifiers` by `collectModifiers` so `hasAdvantageOn` queries them like feat/feature modifiers. HP bonus + innate spells are deferred to the creation flow (US-122) to avoid double-counting baked `maxHp`/`skills`. |
| `modifiers` | `applyModifiers` | Flat list of typed `Modifier`s aggregated from this character's feats + class features (`crit-range`, `flag`, `advantage`). Queried by resolvers via `Modifiers.ts` helpers. |
| `savageAttacker` | `applyModifiers` | Legacy projection: `true` if `modifiers` contains a `flag: "savage-attacker"` (Savage Attacker feat) |
| `fightingStyleDefense` | `applyModifiers` | Legacy projection: `true` if `modifiers` contains a `flag: "fighting-style-defense"` (Defense feat) |
| `ac` | `applyEquipment` | Armor category formula + DEX + defense style + shield |
| `mainAttack` | `applyEquipment` | Weapon stats + finesse + mastery flags |

### Example — `characters/aldric.json`

```json
{
  "id": "aldric",
  "name": "Aldric Vane",
  "speciesName": "Human",
  "speciesId": "human",
  "speciesLineage": null,
  "className": "Fighter",
  "backgroundId": "soldier",
  "featIds": ["savage-attacker", "defense"],
  "level": 1,
  "maxHp": 12,
  "str": 17, "dex": 14, "con": 14, "int": 8, "wis": 10, "cha": 12,
  "proficiencyBonus": 2,
  "savingThrowProficiencies": ["str", "con"],
  "skills": { "athletics": 5, "perception": 2, ... },
  "defaultFeatureIds": ["second-wind"],
  "hitDieType": 10,
  "sneakAttackDice": 0,
  "color": 5227511,
  "xp": 0,
  "defaultEquipment": { "armorId": "chain_mail", "weaponId": "greatsword", "shieldId": null },
  "defaultInventoryIds": ["flail", "javelin", "javelin", "javelin", "javelin", "javelin", "javelin", "javelin", "javelin"],
  "description": "A former city watchman..."
}
```

---

## monsters/

SRD stat blocks for all creatures — both random enemies and the underlying stats for NPCs. Every `NPCDef` (see `npcs/`) references one of these via `monsterClass`.

### Fields

| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique key. Referenced by `NPCDef.monsterClass`. |
| `name` | string | Display name. |
| `type` | string | SRD creature type string, e.g. `"Medium Undead, Lawful Evil"`. The leading size token is parsed at load into a derived `size: CreatureSize` (US-107) — `"Medium or Small …"` picks the larger; the free-text `type` is retained for display. `size` flows to each spawned `NpcState`. |
| `maxHp` | number | Maximum hit points. |
| `hpFormula` | string | SRD dice formula for reference, e.g. `"2d8+2"`. Not used in combat — `maxHp` is authoritative. |
| `ac` | number | Armour Class. |
| `str` `dex` `con` `int` `wis` `cha` | number | Ability scores. |
| `proficiencyBonus` | number | Proficiency bonus. |
| `savingThrows` | object | All six saving throw totals keyed by ability abbreviation: `{ str, dex, con, int, wis, cha }`. Store SRD values directly. |
| `initiativeBonus` | number | Added to the initiative roll. Typically equals the DEX modifier. |
| `stealthBonus` | number | Used when the creature attempts to hide. |
| `passivePerception` | number | Used to detect hiding players. |
| `senses` | object | *(optional)* SRD special senses (`{ darkvision?: number, blindsight?: number, tremorsense?: number, truesight?: number }`, all in feet). Read by `Vision.canSee` to step ambient darkness → dim within Darkvision range, see through Invisible with Truesight, etc. Absent means "normal sight only." |
| `speed` | number | Movement speed in **feet**. |
| `attacks` | Attack[] | One or more attack entries (see below). |
| `xp` | number | XP awarded on kill. |
| `cr` | string | Challenge Rating, e.g. `"1/8"`, `"1/4"`, `"1"`. Classifies encounter difficulty. Not used for automatic reward calculation — gold must be granted by the AIGM via `award_gold`. |
| `color` | number | Token colour as a decimal integer. |
| `vulnerabilities` | string[] | *(optional)* Damage types that deal double damage, e.g. `["bludgeoning"]`. |
| `resistances` | string[] | *(optional)* Damage types that deal half damage. |
| `immunities` | string[] | *(optional)* Damage types that deal no damage. Immunity takes precedence over vulnerability. |
| `conditionImmunities` | string[] | *(optional)* Conditions that cannot be applied to this creature. |
| `multiattack` | number | *(optional)* SRD Multiattack (US-112): total melee attacks made on the creature's turn (each a separate roll with the same weapon). Absent / ≤ 1 = a single attack. `runEnemyTurn` rolls the extras; `runSingleEnemyTurn` applies them after the primary (and through the Shield reaction). |
| `tokenAsset` | string | *(optional)* Path to the SVG token sprite. When omitted, the path is derived by convention: `/tokens/monster_<id>.svg`. See [tokens/](#tokens-1). |

> **Monsters do not carry a `factionId`.** Monster JSONs are pure stat blocks (HP / AC / attacks / traits). Worldbuilding — faction membership, persona, named identity — lives on `NPCDef` (see [npcs/](#npcs)). When the deterministic encounter flow spawns a raw monster id (no NPC wrapper), `SpawnHelpers.spawnNpc` falls back to using the monster id itself as a faction-of-one. Encounter authors who want a raw monster spawn to participate in inter-faction politics should wrap the spawn in a thin `NPCDef` that declares the faction.

### Attack entry fields

Each entry in `attacks` describes one attack option. The AI selects the most appropriate attack based on range.

| Field | Type | Notes |
|---|---|---|
| `name` | string | Descriptive label, e.g. `"Scimitar"`. |
| `attackType` | string | `"melee"`, `"ranged"`, or `"both"`. |
| `bonus` | number | Total attack roll bonus (to hit). |
| `reach` | number | Melee reach in feet (usually `5`). |
| `damageDice` | number | Number of damage dice. |
| `damageSides` | number | Die size, e.g. `6` for d6. |
| `damageBonus` | number | Flat bonus added to damage. |
| `damageType` | string | e.g. `"slashing"`, `"piercing"`, `"bludgeoning"`. |
| `rangeNormal` | number | *(ranged only)* Normal range in feet. Attacks beyond this have Disadvantage. |
| `rangeLong` | number | *(ranged only)* Maximum range in feet. |

---

## Creature size, Temporary HP, Bloodied & the reroll prompt (US-107/108/109)

Runtime additions shared across creatures, on top of the data-file fields above.

- **Creature size** — `CreatureSize = 'tiny' | 'small' | 'medium' | 'large' | 'huge' | 'gargantuan'` (`shared/types/entities.ts`) with `SIZE_ORDER`, `sizeRank()`, and `parseCreatureSize()`. Lives as an optional `size` on `PlayerDef` (seeded from species), `MonsterDef` (parsed from `type` at load), and `NpcState` (inherited at spawn). Optional only to tolerate old saves/fixtures — always populated by the load/seed path.
- **Temporary HP** — `NpcState.tempHp?: number` mirrors `PlayerState.tempHp`: a buffer drained before real HP. The shared `applyDamageWithTempHp(target, amount)` (`CombatSystem.ts`) is used by every NPC damage chokepoint (`NpcDamage`, the player-spell-vs-NPC path in `SpellSystem`, trap/zone damage in `NpcTurnRunners`). Player + companion temp HP is zeroed at the end of a Long Rest (`Resting.applyLongRest`). Nothing grants NPC temp HP yet — the path is honoured for future sources.
- **Bloodied** — `isBloodied(hp, maxHp)` (`shared/types/entities.ts`) is `hp > 0 && hp <= maxHp / 2` (a creature at 0 HP is not Bloodied). Derived on demand (never stored, so it can't drift); surfaced to the GM `CURRENT STATE` snapshot for the player and every NPC.
- **Heroic Inspiration reroll** — `GameState.pendingReroll: PendingReroll | null` (`shared/types/reaction.ts`) is set when an eligible player d20 (currently the attack roll) is rolled while the player holds Heroic Inspiration. The engine computes the outcome but pauses **before** any consequence, stashing the rolled `ResolvedAttackSnapshot` + `RerollAttackParams` + a human `outcomePreview`. The next action must be `resolveReroll { accept }`: decline applies the seen outcome (inspiration kept), accept spends the inspiration and re-resolves (`CombatActions.doResolveReroll` → `applyAttackOutcome`). Rides the world save like `pendingReaction`. Client surface: `RerollPromptOverlay` via `OverlayManager.syncRerollPrompt`.

---

## factions/

Faction definitions loaded from `server/data/factions/*.json` and surfaced via `GET /factions`. Each faction carries an id, display name + colour, renown rating, and a default-relation table. The relation table drives `GameState.factionRelations` — see "Factions & relations" below for the runtime model.

### Fields

| Field | Type | Notes |
|---|---|---|
| `id` | string | Stable id, referenced from `NpcState.factionId` and `NPCDef.factionId`. `MonsterDef` does NOT carry `factionId` — monsters are pure stat blocks; faction membership lives on the NPC wrapper. |
| `name` | string | Player-facing display name, shown in the Target Panel once discovered. |
| `description` | string \| *omitted* | One-line flavour shown alongside the name. |
| `displayColor` | string | Hex `#rrggbb` for the faction tag chip. |
| `renown` | number | 1..30. The Insight DC to identify a member of this faction is `max(1, renown)`. Ships at 1 across the shipped roster (always passes) — tune up as content warrants. |
| `defaultRelations` | `Record<string, number>` \| *omitted* | Default standings with other factions (−100..+100). Mirrored to both directions at session boot, so a declaration on `bandits` automatically wires up `town_guard.bandits` too. Runtime overrides may break the symmetry. |

### Shipped roster

`party` (the player), `town_guard`, `bandits`, `cultists`, `undead`, `monsters`, `wildlife`, `townsfolk`. Adding a new faction is a JSON drop; no code change required.

### Factions & relations — runtime model

`GameState.factionRelations: Record<string, Record<string, number>>` is the full pair-wise relation matrix. Built at session boot by `buildFactionRelations` (in `server/src/engine/FactionRelations.ts`) in four layers, lowest-precedence first:

1. Each `FactionDef.defaultRelations` (mirrored to both directions — symmetric on cold boot).
2. The adventure save's `seedFactionRelations` (full matrix carry-over from a previous chapter, asymmetric allowed).
3. The adventure save's legacy `seedFactionStandings` (`party` row only, mirrored).
4. The encounter's optional `factionRelations` override block (asymmetric — authors who want symmetry write both directions).

`getRelation(state, a, b)` resolves the effective numeric standing by taking the worse (min) of `factionRelations[a][b]` and `factionRelations[b][a]`, so a one-sided grudge still bites. `getStance` discretises the number with the constants `FACTION_HOSTILE_THRESHOLD` (≤ −30 → hostile) and `FACTION_FRIENDLY_THRESHOLD` (≥ +30 → friendly).

`GameState.factionStandings` (the legacy `party`-row projection) is kept in sync at session boot via `projectFactionStandings` so existing `faction_standing` guards and `adjust_faction_standing` AIGM-tool calls keep working unmodified. Pass 2 will re-project after every mutation.

`GameState.discoveredFactions` is the per-session list of faction ids the player has identified. The Target Panel renders `Faction: ???` until the id appears in this list. Pass 3 wires the Insight-check-on-combat-start path and the AIGM's `reveal_faction` tool.

**Pass 1 scope:** matrix is built and helpers exist; engine readers still consult `NpcState.disposition`. **Pass 2 scope:** the matrix is kept in sync with every existing disposition-writing path — `setRelation` / `adjustRelation` mutators clamp to ±100 and keep the legacy `factionStandings` projection in lockstep with the matrix's `party` row; `aggroFaction`, `set_disposition_by_def_id`, `setDisposition`, and `adjust_faction_standing` all dual-update; the spawn pass auto-fills any matrix cell the encounter override didn't author from each NPC's disposition. New trigger actions (`adjust_faction_relation`, `set_faction_relation`, `reveal_faction`) and matching AIGM tools let content + the GM mutate inter-faction politics directly. Two helpers — `isHostileTo(state, me, other)` and `isFriendlyTo(state, me, other)` — consult the matrix first and fall back to disposition for unannotated content; Pass 3 will switch the NPC AI and combat-start condition over to them. The shipped NPC defs are tagged with explicit `factionId` (bridge_bandit → `bandits`, etc.); raw monster ids continue to default to a faction-of-one of their def id since `MonsterDef` deliberately doesn't carry faction membership (monsters = stats, NPCs = worldbuilding).

**Pass 3a scope (current):** **NPC AI targeting now consults `isHostileTo`** — `runEnemyTurn` accepts a generic `EnemyAttackTarget` (the player projected, or any NPC), and `runSingleEnemyTurn` picks the nearest hostile creature via `pickEnemyAttackTarget` (matrix + disposition fallback). The result carries `attackedTargetId` (`'player'` or NPC id) so damage routes to the right entity: `applyEnemyHitToPlayer` for the player (death-save accrual, Shield reaction, the existing path) and the new `applyEnemyHitToNpc` for NPC-vs-NPC hits (resistance roll, kill log, no player XP — the player wasn't in the fight). The Shield reaction prompt only fires when the target was the player; the player OA hand-off only fires when the enemy moved away from the player. Ally turn target list switches to `isHostileTo` too — allies will engage hostile-faction NPCs even when those NPCs aren't player-disposition `enemy`. **Pass 3a does NOT yet add:** real-time off-camera tick loop (NPCs only fight each other during the active combat phase for now), Insight-check discovery on combat start, Target Panel `FACTION` row.

**Pass 3b scope (current):** Faction identification at combat start. Right after `doStartCombat` publishes `combat_started`, `runFactionIdentificationChecks` walks every unique `factionId` represented by the combatants. For each one not already in `discoveredFactions`: if the id resolves to a `defs.factions` entry, roll d20 + the player's `skills.insight` bonus against `max(1, faction.renown)`. On a pass, push the id into `discoveredFactions` and log `"You recognise them — <name>."` On a fail, the roll detail is intentionally NOT logged (so failed identifications don't leak which factions are present in the fight). Faction ids that don't resolve to a `defs.factions` entry (raw-monster faction-of-one spawns) are skipped — there's nothing identifiable. Renown ships at 1 across the shipped roster, so the check is currently always pass-on-die — the tuning lever is in place for future content with rarer factions.

The Target Panel reads `state.discoveredFactions` + the live `factions` registry every time a creature is selected and on every state tick:
- Faction-of-one (id missing from `defs.factions`): the FACTION row is hidden.
- Faction in `defs.factions` but NOT in `discoveredFactions`: row shows `FACTION  ???` in dim text.
- Faction in `defs.factions` AND discovered: row shows the display name in the faction's `displayColor`. A mid-combat `reveal_faction` AIGM tool call flips the chip in place on the next state tick.

**Pass 3c scope (current):** Real-time off-camera tick. Every active session installs a `setInterval` that fires every 6 000 ms (one SRD round per real-time tick) and routes through `engine.runOffCameraTick()` → `server/src/engine/WorldTick.ts`. The tick:
- **Pauses** when `isWorldTickEligible(sessionId)` reads false — `phase !== 'exploring'`, `pendingReaction !== null`, or the session's `worldPaused` flag is set by the client. The tick simply skips; the interval keeps running so resume is instant.
- **Escalates to combat first.** Before the NPC-vs-NPC pass runs, `runOffCameraTick` checks whether any living NPC considers the party hostile (matrix + legacy disposition via `isHostileTo`). If so, it calls `ctx.doStartCombat(events)` and returns immediately — the initiative-tracked combat path stays the single source of truth for player-engaged fights. This catches the case where an AIGM `adjust_faction_relation` (or a trigger action) flips a faction hostile mid-exploration: the next tick auto-engages without the caller having to also call `trigger_combat`.
- **Iterates** every living NPC in a per-tick deterministic shuffle (`hash(npc.id, Date.now())`) so the same NPC doesn't always get the first swing.
- **Picks** each NPC's nearest non-player hostile via `isHostileTo` + Chebyshev distance.
- **Runs** one full SRD turn via the existing `runEnemyTurn` (move up to speed + one attack) and applies damage through `applyNpcAttackHit` in `server/src/engine/NpcDamage.ts` — the shared helper the combat-phase enemy + ally turns also route through. The off-camera variant passes `awardXp: false` so kills don't credit the player (who wasn't in the fight).
- **Returns** the `entity_move` / `entity_killed` events the session caller broadcasts as a single `state_update` WebSocket frame. No broadcast when the tick produced no events (no event log spam).

**Client pause coordination.** The new `client/src/net/WorldPause.ts` singleton refcounts named "holders" — pause whenever any holder is active, resume when the count returns to zero. The manager auto-installs `focusin` / `focusout` listeners on every `<input>` / `<textarea>` / `contentEditable` element, so typing into the GM chat box (or any other text field) pauses the world without per-component wiring. Overlays explicitly acquire / release by id — `OverlayManager` wires `IntroductionOverlay`, `CharacterSheetOverlay`, and `ChapterCompleteOverlay`. `ReactionPromptOverlay` doesn't need to (the server-side `pendingReaction` check covers it). Setup-scene storylog overlays don't either — they only render in setup, where there's no active session.

Pause / resume is posted to `POST /game/session/:id/world-paused` with `{ paused: boolean }`. The server stores it on `Session.worldPaused`. `installWorldTick(sessionId, engine)` is called by every session-creation path; `deleteSession` clears the interval.

**Pass 4 scope (current):** High-risk readers migrated from `disposition === 'enemy'` to `isHostileTo`. The auto-start-combat checks on session create (`index.ts` — both routes route through a new `anyHostileToParty(state)` helper), `ActionGuards.hasLivingEnemies`, `Director.evaluateDirectorRules` (enemies + allies counts), `EncounterProgress`'s combat-ended encounter completion check, and the AIGM `CURRENT STATE` block's combatant / neutral partition all consult the matrix through `isHostileTo` / `isFriendlyTo` (with the legacy disposition fallback for unannotated content). `NpcState.disposition` stays as the legacy cache — readers don't consult it directly anymore, mutators still keep it in sync with the matrix.

### Faction-mutation triggers (Pass 2)

| Action type | Body | Effect |
|---|---|---|
| `adjust_faction_relation` | `{ a: string; b: string; delta: number; mirror?: boolean }` | Shift the standing between `a` and `b` by `delta` (clamped ±100). Mirrors to both directions by default; `mirror: false` for one-sided shifts. Publishes `faction_changed` when either side touches the player. |
| `set_faction_relation` | `{ a: string; b: string; value: number; mirror?: boolean }` | Hard-set the standing to `value`. Same mirror + event semantics. |
| `reveal_faction` | `{ factionId: string }` | Add `factionId` to `GameState.discoveredFactions`. Idempotent. Pass 3 uses this to flip the Target Panel from `???` to the faction name. |

The matching AIGM tools (`adjust_faction_relation`, `set_faction_relation`, `reveal_faction`) reach through `engine.fireTriggerAction(...)` so they share the same handlers — keeping clamp + event-publishing logic in one place.

---

## npcs/

Named characters with identity and persona layered on top of a monster stat block. NPCs are spawned in social and exploration encounters; they do not carry full stat blocks themselves — those are resolved at runtime from `monsterClass`.

### Fields

| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique key. Used in `premade-encounters` `npcIds` and `allyIds`. |
| `name` | string | Display name shown on the map token. |
| `monsterClass` | string | `id` of a `monsters/` entry. Determines HP, AC, speed, attacks, and other combat stats. |
| `color` | number | Token colour as a decimal integer. |
| `persona` | string | *(optional)* Roleplay instructions for the AIGM. The AIGM speaks as this character when the player addresses them. |
| `tokenAsset` | string | *(optional)* Path to the SVG token sprite, e.g. `/tokens/npc_wandering_sage.svg`. When omitted, the path is derived by convention: `/tokens/npc_<id>.svg`. If neither an explicit field nor a convention-matched file exists, the NPC falls back to its `monsterClass`'s token at render time. See [tokens/](#tokens-1). |
| `factionId` | string | *(optional)* Faction membership for spawns of this NPC. Referenced by `SpawnHelpers.spawnNpc` to set `NpcState.factionId` and inherits the faction's relations with everyone else via `GameState.factionRelations`. When omitted, the spawn uses the NPC's own id as a faction-of-one (legacy behaviour). NPCs are the worldbuilding layer — `MonsterDef` deliberately does NOT carry a `factionId` since stats and faction loyalty are orthogonal concerns. See [factions/](#factions). |
| `attitude` | string | *(optional)* Starting **social** attitude toward the party: `"friendly"`, `"indifferent"`, or `"hostile"` (SRD US-092). Defaults to `"indifferent"` per SRD when omitted. **Distinct from combat disposition** — a hostile-attitude shopkeeper can still be neutral-disposition (won't fight but resists persuasion). Attitude drives Advantage/Disadvantage on Influence-type ability checks (Deception, Intimidation, Performance, Persuasion, Animal Handling). Mutated mid-play via the AIGM `set_attitude` tool. |
| `conversationId` | string | *(optional)* Default conversation graph id this NPC opens when the player initiates dialogue. Resolves against `server/data/settings/<setting>/conversations/`. **Per-encounter override**: an encounter's `conversationOverrides[defId]` wins over the NPC's default — resolved at spawn time and stored on `NpcState.conversationId`, which the client reads when the TALK button is pressed. Lets the same NPC carry different conversations across encounters (Vask defaults to no chat in field encounters but opens `bureau_office_chat` when spawned in the Bureau hub). |
| `persistent` | boolean | *(optional)* When `true`, the engine maintains a per-character `NpcSave` file recording this NPC's relationship, memories, and stateful overrides across sessions, encounters, and adventures. Most NPCs are throwaway and leave this `false` — flip it on for named characters the player is expected to interact with again. Save file path: `<setting>/saves/<characterId>_npcs/<npcId>.json`. |
| `routine` | array | *(optional)* Daily routine — one `RoutineEntry` per day phase the NPC behaves differently in (US-094). Each entry is `{ phase: "morning" \| "noon" \| "evening" \| "night", task: { kind: "walk_to", tileX, tileY } \| { kind: "idle" } }`. The world tick rolls the day phase every `TICKS_PER_DAY_PHASE` ticks (60 by default) and the matching row becomes the NPC's active sim task. NPCs without a routine simply skip the routine path. The routine task pool always includes `IdleTask` plus the awareness tasks `InvestigateTask` / `AlertTask`, so a routine NPC will pause its row to investigate noise or respond to a faction alert and resume the row once alertness decays. |

### Example — `npcs/tavern_keeper.json`

```json
{
  "id": "tavern_keeper",
  "name": "Bram Holdfast",
  "monsterClass": "commoner",
  "color": 13395456,
  "persona": "You are Bram Holdfast, the gruff but fair keeper of The Rusty Flagon...",
  "factionId": "commoners",
  "persistent": true,
  "conversationId": "tavern_keeper_chat",
  "routine": [
    { "phase": "morning", "task": { "kind": "walk_to", "tileX": 2,  "tileY": 1 } },
    { "phase": "noon",    "task": { "kind": "walk_to", "tileX": 11, "tileY": 1 } },
    { "phase": "evening", "task": { "kind": "idle" } },
    { "phase": "night",   "task": { "kind": "walk_to", "tileX": 6,  "tileY": 1 } }
  ]
}
```

### NPC simulation layer — runtime model

The sim layer (US-094) gives every off-camera NPC autonomous behaviour: routines that run by day phase, an awareness ladder that propagates via faction alerts and noise, and an optional companion binding the player can drive directly. The pieces live under `server/src/engine/npcSim/`:

- **`SimRng.forNpcTick(tickId, npcId)`** — deterministic mulberry32 RNG keyed by the current world tick + NPC id. Every NPC decision pulls from this; given the same world state + same tick id, every decision is byte-for-byte reproducible.
- **`NpcAction`** — an atomic per-tick step (e.g. `WalkOneTileAction(dx, dy)`).
- **`NpcTask`** — a multi-tick goal with `priority` (`'critical' | 'normal' | 'idle'`), `score(sim)`, and `nextAction(sim)`. Returns `'done'` when the goal is reached.
- **`NpcTickRunner.run(sim, registry, simState)`** — resumes the active task if any, otherwise scores every task in the registry and picks the highest (priority band breaks ties).
- **`NpcSimState`** (on `NpcState.simState` for ambient/routine NPCs, on `NpcState.companion.simState` for companions) — `{ activeTaskId, lastTickId }`. Survives save/load.

**Day phase + tick cadence.** `GameState.worldTickCount` increments once per real-time off-camera tick (6 s game time = one SRD round). `GameState.dayPhase` cycles `morning → noon → evening → night` every `TICKS_PER_DAY_PHASE = 60` ticks (≈ 6 real minutes per phase, ≈ 24 real minutes per game day). Per-encounter scope today — each encounter starts at `morning`; cross-encounter persistence is part of the WorldState refactor (scaffold in `server/src/engine/npcSim/WorldStateScaffold.ts`).

**Task pools.**
- *Companions* — `IdleTask`, `FollowPlayerTask(followMode)`, `WaitHereTask`. Player overrides via the COMPANION chip on the Player Panel are consumed inline.
- *Routine-bearing NPCs* — `IdleTask`, `InvestigateTask`, `AlertTask`, plus the task derived from the matching `RoutineEntry` for the current day phase.
- *Alerted ambient NPCs* (no companion, no routine, but `alertness !== 'calm'`) — `IdleTask`, `InvestigateTask`, `AlertTask`. Once alertness decays to `calm` they fall off the tick.

**Awareness ladder.** Every NPC carries `alertness: 'calm' | 'suspicious' | 'alert'` (default `calm`) and an `NpcMemory` block (`lastAlertTick`, `lastAlertTile`, `lastAlertSource`, `lastAlertKind: 'combat' | 'noise' | 'sight' | 'faction'`). Two propagation surfaces wake NPCs up:

- `pingFactionAlert(ctx, sourceTile, factionId, …)` — called from `CombatFlow.doStartCombat`. Every same-faction NPC within `FACTION_ALERT_RADIUS = 30` tiles flips to `alert` regardless of line of sight. Logs `ai.faction_alert`.
- `registerAwarenessHooks(ctx)` — subscribes to the existing `noise` bus event from `Sound.ts`. Every audible noise (combat swing `NOISE_COMBAT = 5`, spell verbal component `NOISE_SPELL_VERBAL = 5`, footstep `NOISE_FOOTSTEP = 2`, …) raises NPCs within the source's `intensity` tile radius to `suspicious`. Logs `ai.noise_alert`.

Both surfaces only ever **raise** alertness. `decayAlertness` in `WorldTick` steps the ladder back down (`alert → suspicious` after `ALERT_DECAY_TICKS.alert = 15` ticks, `suspicious → calm` after `ALERT_DECAY_TICKS.suspicious = 25` ticks). On return to `calm` the memory pointer is cleared.

**Movement-only, no threat conversion.** `AlertTask` (priority `critical`, tolerance `0`) and `InvestigateTask` (priority `normal`, tolerance Chebyshev ≤ 1) walk the NPC toward `lastAlertTile`, but neither flips disposition. A neutral disguised-faction member who gets pinged walks to the source tile and stops. Threat conversion remains the faction matrix's job — `WorldTick`'s `anyHostileToParty` check escalates to combat for NPCs whose factions are already hostile to the party, so an alerted bandit just gets there faster.

**Tick eligibility.** The sim only ticks during `s.phase === 'exploring'`. Combat freezes routine + ambient NPCs (they hold their current tile); companion behaviour during combat routes through the existing ally AI in `NpcTurnRunners.ts` and consumes the same `override` the chip writes.

---

## equipment/

All equippable gear and usable consumables. Item `id` values are referenced by character `defaultEquipment`, `defaultInventoryIds`, and save file `inventoryIds`.

Items have four distinct sub-types identified by the `type` field.

---

### type: `"weapon"`

Equipped in the `weapon` slot. `applyEquipment` derives the character's `mainAttack` from this at runtime.

| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique key. |
| `name` | string | Display name. |
| `type` | string | `"weapon"` |
| `statKey` | string | Ability score used for attack and damage rolls: `"str"` or `"dex"`. Finesse weapons check both and use the higher. |
| `damageDice` | number | Number of damage dice. |
| `damageSides` | number | Die size. |
| `damageType` | string | Damage type string, e.g. `"slashing"`. |
| `mastery` | string \| null | SRD weapon mastery property: `"graze"`, `"vex"`, `"sap"`, `"slow"`, or `null`. |
| `finesse` | boolean | If `true`, use the higher of STR/DEX for attack and damage. |
| `twoHanded` | boolean | If `true`, equipping this weapon auto-unequips any held shield. |
| `thrown` | boolean | Whether this weapon can be thrown using its own stats. Improvised throws (non-thrown items) deal 1d4 bludgeoning at 20/60 ft. |
| `throwNormal` | number | Normal thrown range in feet. `0` when `thrown` is `false`. |
| `throwLong` | number | Maximum thrown range in feet. `0` when `thrown` is `false`. |
| `rangeNormal` | number? | *(ranged weapons)* Normal ranged attack range in feet. Absence/0 = melee weapon. Beyond this range imposes Disadvantage. |
| `rangeLong` | number? | *(ranged weapons)* Maximum ranged attack range in feet. Beyond this distance the player cannot fire. |
| `ammunitionType` | string? | *(ranged weapons)* Canonical key for the ammo item id consumed per shot, e.g. `"arrow"`, `"bolt"`, `"bullet"`, `"needle"`. Each attack consumes one matching item from inventory. |
| `loading` | boolean? | *(ranged weapons)* SRD Loading property. When `true`, only one shot per Action/Bonus Action/Reaction regardless of Extra Attack count. (Field is wired but not enforced until Extra Attack ships — no current Level 1 character has it.) |
| `heavy` | boolean? | SRD Heavy property (US-111). When `true`: DEX < 13 imposes Disadvantage on **ranged** attacks; STR < 13 imposes Disadvantage on **melee** attacks. Carried onto `PlayerAttack.heavy` for both. |
| `versatile` | object? | SRD Versatile property (US-111): `{ damageDice, damageSides }` — the larger die used when the weapon is wielded two-handed (no shield equipped). `makePlayerAttack` selects it when `twoHandedGrip` is true. Authored on battleaxe/longsword (1d10) and quarterstaff (1d8). |
| `reach` | boolean? | SRD Reach property (US-111). When `true`, melee reach is 10 ft (2 tiles) — `playerAttackReachTiles` returns 2. Surfaced on `PlayerAttack.reach`. (No reach weapon ships in the roster yet — content.) |
| `cost` | number | Gold piece value. |

A weapon is **ranged** iff `rangeNormal > 0`. Ranged player attacks are dispatched through the same ATTACK button as melee — the engine routes via `mainAttack.rangeNormal` and consumes ammunition from inventory. After every shot, there is a **50% chance per shot** that the arrow/bolt lands on the target's tile as a `mapItem` and can be picked up by walking onto it.

---

### type: `"armor"`

Equipped in the `armor` slot. `applyEquipment` computes effective AC from `category`, `baseAc`, and DEX.

| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique key. |
| `name` | string | Display name. |
| `type` | string | `"armor"` |
| `category` | string | `"light"`, `"medium"`, or `"heavy"`. Controls how DEX applies to AC. |
| `baseAc` | number | Base AC before DEX. |
| `addDex` | boolean | Whether DEX modifier is added. Always `true` for light; `true` for medium (capped); `false` for heavy. |
| `maxDex` | number \| null | Maximum DEX bonus applied. `null` for light (uncapped) and heavy (not applied). `2` for medium. |
| `stealthDisadv` | boolean | If `true`, wearing this armor imposes Disadvantage on Stealth checks. |
| `minStr` | number \| null | Minimum STR required to wear. `null` if there is no requirement. |
| `cost` | number | Gold piece value. |

**AC formula by category:**

| Category | Formula |
|---|---|
| Light | `baseAc + DEX mod` |
| Medium | `baseAc + min(DEX mod, 2)` |
| Heavy | `baseAc` |

A shield adds `+2`, Fighting Style: Defense adds `+1` (if `fightingStyleDefense` is true on the character), and a magic armor's `bonus` adds `+N` (US-124).

---

### Magic-item properties (US-124)

Weapons, armor, and shields share an optional `MagicItemProps` block:

| Field | Type | Notes |
|---|---|---|
| `magic` | boolean | Marks the item as magical (flavour / future identify gating). |
| `rarity` | string | `"common"` / `"uncommon"` / `"rare"` / `"very-rare"` / `"legendary"` / `"artifact"`. |
| `bonus` | number | SRD enhancement bonus (+1/+2/+3). **Weapon:** added to attack & damage via the shared `magicWeaponBonus` path (does NOT stack with the Magic Weapon spell — the higher wins). **Armor / shield:** added to AC in `computeAC`. Per SRD these +N items don't require attunement, so the bonus applies whenever equipped. |
| `requiresAttunement` | boolean | SRD attunement (US-124 Slice 2). When `true`, the item's `bonus` applies only while its id is in `PlayerState.attunedItemIds` (≤ 3 attuned). `effectiveItemBonus(item, attuned)` gates this for `computeAC` / `applyEquipment`. Attune via the `attune` action (`doAttune`, exploration-phase Short-Rest bond); `unattune` ends it. |
| `startsUnidentified` | boolean | SRD identify (US-124 Slice 3). When `true`, the item displays as "Unidentified <category>" (name + mechanical label hidden) until its id is in `PlayerState.identifiedItemIds`. `itemDisplayName` / `isItemIdentified` compute the masked name; the `identify` action (`doIdentify`, exploration-phase) reveals it. Identification is informational — the item functions regardless. |

Shipped examples: `longsword_plus_1`, `leather_armor_plus_1`. *(Attunement, identify, scrolls/wands, and potions-beyond-healing are later Phase 9 slices.)*

---

### type: `"shield"`

Equipped in the `shield` (offhand) slot. Grants a flat AC bonus.

| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique key. |
| `name` | string | Display name. |
| `type` | string | `"shield"` |
| `acBonus` | number | AC bonus granted (typically `2`). |
| `cost` | number | Gold piece value. |

---

### type: `"consumable"`

Used from inventory. Currently only Health Potions are implemented.

| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique key. |
| `name` | string | Display name. |
| `type` | string | `"consumable"` |
| `healDice` | number | *(optional)* Number of healing dice. |
| `healSides` | number | *(optional)* Die size for healing roll. |
| `healBonus` | number | *(optional)* Flat bonus added to healing. |
| `tempHpDice` `tempHpSides` `tempHpBonus` | number | *(optional, US-124)* Temporary HP granted on use — a non-healing potion (e.g. `potion_of_heroism`) omits the heal fields and sets these. Applied per the SRD temp-HP rule (higher of current vs granted; doesn't stack). |

---

### type: `"scroll"`

Single-use spell scroll (US-124). When read, it casts `spellId` and is consumed.

| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique key, e.g. `"scroll_of_magic_missile"`. |
| `name` | string | Display name. |
| `type` | string | `"scroll"` |
| `spellId` | string | Id of the `SpellDef` cast on use. |
| `magic` / `rarity` | — | Optional `MagicItemProps`. |

Casting from a scroll (`doCastSpell` with `scrollItemId`, driven by the `useScroll` action) **bypasses the prepared/known + slot gate**, spends **no spell slot** (the scroll is the resource, consumed on cast), but still costs the spell's action. Targeting reuses the normal resolver (selected-target fallback for attack/auto-hit spells); the Equipment tab renders a **CAST** button per scroll. Shipped: `scroll_of_magic_missile`. Scroll casts always resolve at the spell's **base level** (no upcasting — see below).

**Upcasting (US-116).** A levelled spell may be cast with a slot of its own level or higher; the resolvers scale damage / darts / rays by `slotLevel` (`max(0, slotLevel - spell.level)` extra). `doCastSpell` resolves the effective level before spending anything: cantrips, ritual casts, and scroll casts force `slotLevel = spell.level`; a normal cast clamps the requested level to `[spell.level, 9]` (no downcasting) and **fizzles before consuming any slot or action** if the player holds no slot at that level. `consumeCastingResources` then decrements the slot at the chosen `slotLevel` — **not** the base level (the historical bug). The client's Spells tab opens a slot-level picker when `SpellDef.scaling` is set and a higher slot is owned, threading the choice through the target mode so deferred (target-click / tile / multi-projectile) casts spend the right slot.

**Component free-hand gate (US-116).** Per SRD, a Somatic component needs ≥1 free hand and a Material component needs a free hand to access it (sharable with the Somatic hand) — so `canCastSpell` refuses any spell whose `components.somatic` or `components.material` is set when `freeHandCount(ctx)` is 0. `freeHandCount` derives from `equippedSlots`: a strictly `twoHanded` weapon uses both hands; a one-handed weapon and a shield use one each; a Versatile weapon uses one (the caster grips it one-handed to free the other). Verbal-only spells skip the gate. The client's Spells-tab tooltip mirrors the same count from `equippedItems`.

---

### type: `"ammunition"`

Stackable inventory item consumed automatically per ranged shot. Distinct from `consumable` so the Inventory Overlay can render it in its own section (no USE button — fired implicitly by the ATTACK action when a ranged weapon is equipped). Arrows recovered from the battlefield (the 50% per-shot recovery rule) are placed on the map as `mapItems` referencing this item by `id`.

| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique key, e.g. `"arrow"`. |
| `name` | string | Display name. |
| `type` | string | `"ammunition"` |
| `ammunitionType` | string | Canonical key matched against `WeaponDef.ammunitionType`. A bow with `ammunitionType: "arrow"` consumes inventory items whose id is `"arrow"`. |
| `cost` | number? | Gold piece value. |

---

### type: `"gear"`

Catch-all for non-functional inventory items — class artifacts (a wizard's spellbook), holy symbols, tools, books, lore objects. Rendered in the Inventory Overlay under a `GEAR` badge with no action button (cannot be equipped, used, or consumed). Stackable by `id` like consumables and ammunition.

| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique key, e.g. `"spellbook"`. |
| `name` | string | Display name. |
| `type` | string | `"gear"` |
| `description` | string? | Flavour text — shown only via tooltips/AIGM context, not in the inventory list. |
| `cost` | number? | Gold piece value. |

---

## Modifier aggregator

The data-driven layer that replaces scattered `includes(featId)` / `switch(id)` branches for **passive** mechanics. A feat (`feats/`) or class feature (`features/`) declares a `modifiers: Modifier[]` array; at character load `Modifiers.applyModifiers` flattens every active source's modifiers onto `PlayerDef.modifiers`, and resolvers **query** that list instead of branching on ids.

`FeatDef` and `FeatureDef` both extend a shared **`ModifierSource`** base (`shared/types/modifiers.ts` → `{ id, name, description, modifiers? }`) so the aggregator (`collectModifiers`) treats either uniformly via one `collectFrom` helper. The two are **not** merged into a single type — each keeps its domain-specific fields (feat: `category` / `prerequisites` / `effects`; feature: `classId` / `cost` / `resource` / `handler` / `slotRecovery`); only their common modifier-contributing contract is named.

**`Modifier` types** (`shared/types/modifiers.ts`):

| Type | Shape | Meaning |
|---|---|---|
| `crit-range` | `{ type, min }` | Lowers the natural-d20 crit threshold (Improved Critical `min:19`, Superior Critical `min:18`). Lowest `min` across sources wins. |
| `flag` | `{ type, name }` | A named passive boolean a resolver checks (`savage-attacker`, `fighting-style-defense`, `potent-cantrip`). |
| `advantage` | `{ type, on, key? }` | Advantage on `attack` / `save` / `check` / `initiative`; optional `key` narrows a check/save to an ability/skill (Remarkable Athlete → `initiative` + `check:athletics`). |
| `weapon-bonus` | `{ type, value }` | Flat bonus to weapon attack AND damage (Magic Weapon). Highest value across active buffs wins. |
| `speed-bonus` | `{ type, value }` | Flat movement-speed bonus in feet (Longstrider). |
| `enhanced-ability` | `{ type, ability }` | Advantage on ability checks of one ability score (Enhance Ability). Projected onto `PlayerState.enhancedAbility` by `recomputeBuffs`. |
| `sense` / `size` | `{ type, sense, range }` / `{ type, size }` | Buff-granted temporary special sense (Stonecunning → Tremorsense) / creature size (Large Form). Projected onto `PlayerState.buffSenses` / `buffSize`. |
| `ac-bonus` | `{ type, value }` | Flat AC bonus from a buff (Shield of Faith +2, Haste +2; stacks). Projected onto `PlayerState.acBonus`, added in `computeAC`. |
| `dice-bonus` | `{ type, on, count, sides }` | An extra die added to a category of d20 Test (Bless → `on:'attack'`+`'save'`; Guidance → `'check'`). Projected per-category onto `PlayerState`; rolled by `Dice.rollDiceBonus` at the roll sites. Largest die per category wins. |
| `resistance` | `{ type, damageType }` | Damage resistance for the buff's duration (Protection from Energy). Projected onto `PlayerState.buffResistances`, merged by `GameEngine.playerResistMod`. |
| `damage-reduction` | `{ type, damageType, count, sides }` | Flat typed damage reduction (Resistance cantrip → −1d4 of the chosen type). Projected onto `PlayerState.buffDamageReduction`, applied in `applyDamageToPlayer`. |
| `max-hp` | `{ type, value }` | HP-maximum increase (Aid → +5). Applied by raising the session `PlayerDef.maxHp` directly at cast (every HP read site already consumes it); the recorded `value` is reversed on a Long Rest (`applyLongRest`). |

**Query helpers** (`server/src/engine/Modifiers.ts`): `critFloor(playerDef)`, `hasModifierFlag(playerDef, name)`, `hasAdvantageOn(playerDef, on, key?)`. Consumed by `CombatSystem` (crit floor), `CombatFlow` (initiative advantage), `SpellSystem` (potent-cantrip), and `EquipmentSystem` (the derived `savageAttacker` / `fightingStyleDefense` AC/attack booleans).

**Adding a passive that fits an existing type is pure data** — drop a `modifiers` entry on the feat/feature JSON; no engine change. (New modifier *types* still need a query helper + one consumption point. This is Phase 1 of the broader effort to make spells/feats/classes data-only.)

**Buff store (`server/src/engine/Buffs.ts`).** Buffs are recorded as `ActiveBuff[]` on a creature — `PlayerState.activeBuffs` and, since the store is **creature-agnostic**, `NpcState.activeBuffs`. Each buff carries the `modifiers` it contributes, any `conditions` it applied to its host creature, and an optional `charges` counter (Mirror Image's duplicates). The primitive ops `applyBuffTo(target, buff)` / `removeSpellBuffsFrom(target, spellId)` operate on any creature (`BuffTarget`); `applySelfBuff` / `removeBuffsForSpell` are the player wrappers that also call `recomputeBuffs`. For the **player**, `recomputeBuffs` derives the legacy fields the engine reads (`magicWeaponBonus` from `weapon-bonus`, `speedBonus` from `speed-bonus`, `seeInvisible` from `flag:'see-invisible'`, `expeditiousRetreat` from `flag:'expeditious-retreat'`, `enhancedAbility` from `enhanced-ability`, `mageArmor` from `flag:'mage-armor'`, `mirrorImages` from the mirror-image buff's `charges`, `buffSenses`/`buffSize` from `sense`/`size`, plus the **buff-spell layer** — `acBonus` from `ac-bonus` (Shield of Faith, Haste; stacks), per-category `attackDiceBonus`/`saveDiceBonus`/`checkDiceBonus` from `dice-bonus` (Bless attack+save, Guidance check; largest die wins), `buffSaveAdvantage` from save-scoped `advantage` (Haste DEX, Beacon of Hope WIS), and `buffResistances` from `resistance`) and rebuilds AC/attack via `applyEquipment` (syncing `player.ac`, now with the `buffAcBonus` arg). The d20 buff dice are rolled per-roll by `Dice.rollDiceBonus` at the player's attack (`attackRollMod` in CombatActions + the spell-attack bonus), save, and ability-check sites; `buffResistances` is consumed by `GameEngine.playerResistMod`. `endConcentration` strips the ending spell's buffs from the player **and every NPC**, so a concentration buff cast on another creature (Invisibility on an enemy) cleans up generically. **All self/creature buffs are now data-driven** (Magic Weapon, Longstrider, See Invisibility, Blur, Expeditious Retreat, Enhance Ability, Mage Armor, Mirror Image, Invisibility): Mage Armor re-seeds its buff on resume (`resumeMageArmor`) and is removed when armor is donned; Mirror Image's `charges` decrement in `CombatFlow` per absorbed hit; Invisibility's buff lives on whichever creature is the recipient, with `invisibilityTargetId` kept only as the end-on-attack pointer.

---

## feats/

One file per SRD feat. Feats are loaded at startup, served via `GET /feats`, and cached in the client registry. A feat's mechanical contribution is its **`modifiers`** array (see [Modifier aggregator](#modifier-aggregator)), aggregated onto `PlayerDef.modifiers` by `applyModifiers`. (The older `effects` block is retained but is largely vestigial — most of its keys were never read; new mechanics should use `modifiers`.)

### Fields

| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique key. Matches filename (kebab-case). Referenced by `characters.featIds`. |
| `name` | string | Display name from the SRD. |
| `category` | string | `"origin"`, `"general"`, `"fighting-style"`, or `"epic-boon"`. |
| `prerequisites` | object | `{ minLevel, minAbilityScore, requiresFeature, repeatable, repeatableNote }`. |
| `description` | string | Full rules prose from the SRD. |
| `modifiers` | Modifier[] | *(optional)* Typed passive contributions — `crit-range` / `flag` / `advantage`. The data-driven mechanical layer; see [Modifier aggregator](#modifier-aggregator). |
| `effects` | object | *(legacy)* Named structured properties; mostly unread by the engine — prefer `modifiers`. |

### Effect keys (partial — only engine-consumed keys listed)

| Key | Type | Engine effect |
|---|---|---|
| `savageAttacker` | boolean | Sets `PlayerDef.savageAttacker`; enables re-rolling weapon damage once per attack. |
| `armorAcBonus` | number | Sets `PlayerDef.fightingStyleDefense`; adds `+1 AC` while wearing armor. |
| `initiativeProficiency` | boolean | *(not yet wired)* Add Proficiency Bonus to initiative rolls. |
| `rangedAttackBonus` | number | *(not yet wired)* Bonus to ranged attack rolls. |
| `greatWeaponFighting` | boolean | *(not yet wired)* Treat 1–2 on damage dice as 3 for two-handed/versatile weapons. |

All other `effects` keys are stored for future engine use and have no current mechanical impact.

---

## backgrounds/

One file per SRD background. Backgrounds are loaded at startup, served via `GET /backgrounds`, and cached in the client registry. Currently reference-only — the engine does not yet apply skill proficiencies or starting equipment from the background; those are baked into the character JSON directly.

### Fields

| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique key. Referenced by `characters.backgroundId`. |
| `name` | string | Display name from the SRD. |
| `abilityScores` | string[] | The three ability keys the SRD associates with this background. |
| `feat` | object | `{ id, options }` — the origin feat granted. `options` carries sub-choices (e.g. `{ spellList: "cleric" }` for Magic Initiate). |
| `skillProficiencies` | string[] | Two skill keys (camelCase) granted by this background. |
| `toolProficiency` | string \| object | A specific tool name, or `{ choices, count }` for a choice (e.g. Soldier's gaming set). |
| `equipmentOptions` | object[] | Two equipment options (A and B). Each has `label`, `items` (array of `{ itemId?, name?, count? }`), and `gold`. |

---

## species/

One file per SRD species. Species are loaded at startup, served via `GET /species`, and cached in the client registry. `applySpecies` reads a character's `speciesId` and `speciesLineage` and writes `speed`, `size`, `senses`, `resistances`, and `originModifiers` onto `PlayerDef` (the `"ancestry"` damage-resistance placeholder resolves to the chosen Draconic Ancestry's damage type).

### Fields

| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique key. Referenced by `characters.speciesId`. |
| `name` | string | Display name from the SRD. |
| `creatureType` | string | Always `"humanoid"` for player species. |
| `size` | string \| object | `"medium"`, `"small"`, or `{ choices: ["medium","small"] }` when the player chooses at character creation. |
| `speed` | number | Base walking speed in feet. |
| `traits` | object[] | Array of trait objects, each with `name`, `description`, and `effects`. |

### Trait `effects` keys (partial — only engine-consumed keys listed)

| Key | Engine effect |
|---|---|
| `lineageChoice.options[].level1.speedBonus` | Added to base `speed` by `applySpecies` when the character's `speciesLineage` matches the option id. |
| `cantrip` / `cantrips[]` | Level-0 spell id(s) granted at L1, in three authored shapes: trait top-level (Tiefling Thaumaturgy), nested under a subspecies option's `level1` (Elf lineages), or directly on a subspecies option as `cantrip` / `cantrips` (Gnome Forest = one, Rock = two). `CharacterBuilder` folds all three into `defaultCantripIds`; for a non-caster it also seeds `spellcastingAbility` from `racialSpellAbility`. |
| `level1.cantrip` (on a subspecies option) | A subspecies-granted cantrip (e.g. High Elf Wizard's Cantrip). Folded into `defaultCantripIds` only when that option is the character's `speciesLineage`. |
| `level1.damageResistance[]` (on a subspecies option) | Resistance granted by the *selected* lineage/legacy (Tiefling Abyssal poison / Chthonic necrotic / Infernal fire). `applySpecies` adds it to `PlayerDef.resistances` when the option is the chosen `speciesLineage`. |
| `level1.darkvisionOverride.feet` (on a subspecies option) | Raises darkvision for the chosen lineage (Elf Drow → 120 ft), merged into `PlayerDef.senses`. |
| `damageResistance[]` | Damage types resisted, seeded onto `PlayerDef.resistances` by `applySpecies`. The literal `"ancestry"` resolves to the chosen Draconic Ancestry's `damageType` (Dragonborn) via the matching `ancestryChoice.options[]` entry; it is skipped if no ancestry is chosen. |
| `hpMaxBonus` | `{ atLevel1, perLevel }` (Dwarven Toughness). `CharacterBuilder` adds `atLevel1` to `maxHp` at creation; `applySpecies` projects `perLevel` onto `PlayerDef.hpBonusPerLevel`, which `previewForLevel` adds to each level-up's HP gain. |
| `heroicInspirationOnLongRest` | SRD Human Resourceful. `applyLongRest` sets `player.heroicInspiration` when the species carries it. |
| `savingThrowAdvantage[]` | Each `{ ability }` / `{ condition }` becomes an advantage Modifier on `originModifiers`, queried by `hasAdvantageOn`. |
| `relentlessEndurance.usesPerLongRest` | SRD Orc trait. `SpeciesAbilities.speciesAbilityResources` seeds a `relentless-endurance` pool into `player.resources` at session build (refilled on Long Rest by `applyLongRest`); when player damage would drop the character to 0 HP but not kill them outright, `GameEngine.applyDamageToPlayer` consumes one use and holds them at 1 HP instead. |
| `rerollD20OnesOnTests` | SRD Halfling "Luck". `applySpecies` projects it onto `PlayerDef.halflingLuck`; every player d20 roll site routes its natural die through `Dice.applyHalflingLuck`, which rerolls a natural 1 once (attack rolls, spell attacks, ability checks, saving throws, initiative, death saves, hide, trap save/disarm). |

| `dashAsBonusAction` | SRD Orc "Adrenaline Rush". `SpeciesAbilities.speciesFeatureIds` maps this trait to the `adrenaline-rush` FeatureDef id and appends it to `defaultFeatureIds` (at load + in the character builder), so the activated ability surfaces as a player action button through the normal feature pipeline. The handler takes the Dash action and grants Temp HP equal to the Proficiency Bonus. |
| `tremorsense` (with `usesPerLongRest`) | SRD Dwarf "Stonecunning". Maps (via `speciesFeatureIds`) to the `stonecunning` FeatureDef. The handler applies a self-buff carrying a `sense` modifier; `recomputeBuffs` derives `PlayerState.buffSenses`, which `Vision.playerSenses` overlays on the static species senses. |
| `largeForm.minLevel` | SRD Goliath "Large Form". Maps to the `large-form` FeatureDef, gated to that level in `speciesFeatureIds`. The handler applies a self-buff with `size` (→ `PlayerState.buffSize`, read by the grapple/shove size gate) + `speed-bonus` modifiers. |
| `ancestryChoice.usesPerLongRest` + `options[].effect` | SRD Goliath "Giant Ancestry". `GiantGifts.ts` seeds a shared `giant-gift` pool (= PB) and reads the chosen option's (`speciesLineage`) `effect` data-driven: `bonusDamageOnHit` / `speedReduction` / `conditionOnHit` fire via `applyGiantGiftOnHit` in the attack paths; `damageReduction` (Stone's Endurance) via `applyStoneEndurance` in `applyDamageToPlayer`; `retaliationDamage` (Storm's Thunder) via `applyStormsThunder` in the melee monster-attack path — the two reaction gifts also spend the player's Reaction; `teleport` (Cloud's Jaunt) surfaces the `clouds-jaunt` FeatureDef (`targetsTile`) and teleports via `applyCloudsJaunt`. (Dragonborn's `ancestryChoice` has no `usesPerLongRest`, so it gets no pool.) |

All other trait effects are stored for future engine use and have no current mechanical impact. **Active species abilities** live in `server/src/engine/SpeciesAbilities.ts`: limited-use *passive* abilities (Relentless Endurance) derive their `player.resources` pools (seeded by `SessionBuilder`, refilled by `applyLongRest`); *activated* abilities are surfaced as feature buttons via `speciesFeatureIds` + an authored `features/*.json` def (`classId` set to the granting species), reusing the class-feature resource / guard / dispatch / client-button pipeline unchanged. Activated abilities with a lasting effect (Stonecunning, Large Form) apply a self-buff through the existing buff store, which derives temporary senses (`buffSenses`) and size (`buffSize`) alongside the speed / AC / flag fields it already produced — so a new timed species effect is a `sense` / `size` / `speed-bonus` modifier plus a one-line consumer overlay.

---

## spells/

One file per SRD spell, served via `GET /spells`. Files use kebab-case ids matching the SRD spell name (e.g. `magic-missile.json`, `ray-of-frost.json`). The full SRD 5.2.1 **Wizard and Cleric lists for cantrips + levels 1–3** ship as JSON; **mechanical coverage varies per spell** — damage / save-for-half / attack-roll / single- or area-target / healing / conditions / zones / temp-HP / self-teleport resolve data-driven via `SpellSystem.ts`, while buffs needing an unbuilt primitive (Bless/Bane +1d4, Shield of Faith / Haste AC, Aid max-HP), summon-likes (Spiritual Weapon, Animate Dead), and metagame/utility spells (Counterspell, Dispel Magic, divinations) ship as full metadata + description — castable and AIGM-rulable, with an `Engine:` note in the description stating what isn't yet wired. Other classes' spells ship as required by character JSONs.

Each spell carries SRD metadata (level, school, classes, casting time, range, components, duration) plus optional mechanical fields the engine can consume when spellcasting lands (attack roll vs save, damage dice, area shape). Narrative effects live in `description`.

### Fields

| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique key (kebab-case). |
| `name` | string | Display name. |
| `level` | integer | `0` for cantrip, `1`–`9` for levelled spells. |
| `school` | string | Lowercase school name: `abjuration`, `conjuration`, `divination`, `enchantment`, `evocation`, `illusion`, `necromancy`, `transmutation`. |
| `classes` | string[] | SRD class lists the spell belongs to, lowercase. |
| `castingTime` | string | `"action"`, `"bonus-action"`, `"reaction"`, or a longer string (e.g. `"1 minute"`). |
| `castingTimeTrigger` | string? | *(reactions only)* The trigger condition. |
| `range` | string | Human-readable SRD range string. |
| `rangeFeet` | integer | Numeric range in feet (`0` for self/touch). |
| `components` | object | `{ verbal: boolean, somatic: boolean, material: string \| null }`. |
| `duration` | string | Human-readable SRD duration string. |
| `durationRounds` | integer? | Duration in 6-second rounds (omit for instantaneous). |
| `concentration` | boolean | True if the spell requires Concentration. |
| `ritual` | boolean | True if the spell has the Ritual tag. |
| `attack` | string? | `"ranged-spell"`, `"melee-spell"`, or `"auto-hit"` (Magic Missile). Omit for save-based or no-roll spells. |
| `save` | object? | `{ ability: 'str'\|'dex'\|'con'\|'int'\|'wis'\|'cha', halfOnSuccess: boolean }`. |
| `damage` | object? | `{ dice: int, sides: int, bonus?: int, type: string }`. |
| `area` | object? | `{ shape: 'cone'\|'sphere'\|'cube'\|'line', sizeFeet: int }`. |
| `zone` | object? | *(Fog Cloud, Darkness, Web, Grease, Silent Image, Minor Illusion, Gust of Wind)* Persistent-zone descriptor — the **single source of truth** for which AOE spells leave a lasting `ActiveZone` and how. The engine reads this instead of branching on `spell.id`, so a new zone spell is data-only. Fields: `tintHex?` (map overlay colour), `difficultTerrain?` (Web/Grease), and one of three cast modes — `castCondition` + `castLabel?` tags every creature in the area with no save (Fog Cloud/Darkness → `heavily-obscured`); `castSave { ability, condition, label? }` rolls a save or applies the condition (Web → DEX or `restrained`); `groundPlaceable: true` registers the zone even with no creature present (Grease, the illusions, Gust). `enterSave { ability, condition? }` is the ongoing rider for creatures that later enter / start a turn in the zone (Web re-roll; Grease's prone rider) — the engine stamps the spell save DC onto it at cast time. |
| `darts` | integer? | *(Magic Missile-style)* Number of guaranteed-hit projectiles. |
| `rider` | string? | One-line secondary effect on hit (narrative only — the mechanical condition now lives in `effect.onHit`). |
| `effect` | object? | Condition outcomes keyed by save/attack result. `onFail` (single or array — Hideous Laughter's `["prone","incapacitated"]`) + `onSecondFail` (Sleep's escalation) apply on a failed save; `onSuccess` applies on a *successful* save (Ray of Enfeeblement → `vexed`); `onHit` applies when an attack-roll spell hits with no save — the cantrip riders Ray of Frost (`slowed`), Chill Touch (`no-healing`), Shocking Grasp (`no-reactions`). All are read generically by `SpellSystem`, so a new on-hit/on-save condition is data-only (log flavour falls back to "is &lt;condition&gt;", or add an `ON_HIT_CONDITION_NOTE` entry). |
| `secondaryDamage` | object? | *(Ice Knife)* Independent AOE save fires around the targeted tile after the primary attack roll resolves, regardless of hit/miss. Combined with `save + area`. Shape mirrors `damage`. |
| `push` | object? | *(Thunderwave)* `{ feet: int }`. On a failed save the creature is shoved this many feet directly away from the caster, stopping at impassable terrain, other creatures, or the caster's tile. |
| `hpPool` | object? | *(Color Spray)* `{ dice: int, sides: int }`. Rolled once at cast; living creatures in the AOE are sorted by HP ascending and consume the pool until exhausted. Affected targets receive `effect.onFail` conditions. |
| `chainOnDoubles` | object? | *(Chromatic Orb)* `{ rangeFeet: int }`. When two damage dice match, the spell leaps to the nearest other valid enemy within range and makes a fresh attack roll. |
| `tempHpRoll` | object? | *(False Life)* `{ dice: int, sides: int, bonus?: int }`. Rolls temp HP at cast; applied to `PlayerState.tempHp` using the higher-of-two rule. |
| `heal` | object? | *(Cure Wounds, Healing Word — US-120)* `{ dice: int, sides: int, perLevel?: int }`. `resolveHealSpell` restores HP = roll(dice + perLevel×upcast, sides) + spellcasting-ability mod (`perLevel` defaults to `dice`), clamped to the target's max HP, on the caster or a chosen ally; reviving a downed ally (0 HP) clears Unconscious/Stable. |
| `description` | string | The full SRD spell text — used by the AIGM for ruling and shown to the player. |
| `scaling` | string? | "Cantrip Upgrade" or "Using a Higher-Level Spell Slot" text. |

### Example — `spells/fire-bolt.json`

```json
{
  "id": "fire-bolt",
  "name": "Fire Bolt",
  "level": 0,
  "school": "evocation",
  "classes": ["sorcerer", "wizard"],
  "castingTime": "action",
  "range": "120 feet",
  "rangeFeet": 120,
  "components": { "verbal": true, "somatic": true, "material": null },
  "duration": "instantaneous",
  "concentration": false,
  "ritual": false,
  "attack": "ranged-spell",
  "damage": { "dice": 1, "sides": 10, "type": "fire" },
  "description": "You hurl a mote of fire at a creature or an object within range. Make a ranged spell attack against the target. On a hit, the target takes 1d10 Fire damage...",
  "scaling": "The damage increases by 1d10 when you reach levels 5 (2d10), 11 (3d10), and 17 (4d10)."
}
```

---

## classes/ and subclasses/

`server/data/classes/<id>.json` encodes a full SRD class as data — core traits (hit die, primary ability, saves, skills, weapon/armor proficiencies), spellcasting model, per-level scaling tracks, and a `progression[]` array that lists per-level features and choice prompts. The engine reads these via `shared/classProgression.ts` resolvers; nothing in [Leveling.ts](../server/src/engine/Leveling.ts) or [GameEngine.ts](../server/src/engine/GameEngine.ts) hard-codes per-class behaviour any more. **`equipmentOptions`** (US-122) encode the SRD class starting-equipment choices (Fighter A/B/C, others A/B), mirroring `BackgroundDef.equipmentOptions`: each option equips an `armorId`/`weaponId`/`shieldId` loadout, drops `items` (`{itemId, count}`) into inventory, and grants `gold` (GP); a gold-only option leaves the slots empty. The character builder resolves the chosen class option (`classEquipmentChoice`) **and** background option (`equipmentChoice`) independently — both contribute equipment, inventory items, and GP (summed into the starting CP). All SRD class + background package items ship as real `equipment/*.json` (weapons, Chain Shirt, Holy Symbol, packs, tools, focuses).

**Character creation (US-122).** `CharacterBuilder.buildPlayerDef(choices, defs)` assembles a complete L1 `PlayerDef` from creation choices — final abilities (base assignment + the SRD 5.2.1 *background* +2/+1 or +1/+1/+1 increase), max HP (`class.hitDie` + CON mod + species `hpMaxBonus.atLevel1`), the baked `skills` + `savingThrows` maps (proficiency from class picks + background grants), L1 features (`featuresAt`), caster fields (cantrips / prepared / trimmed slot row, plus a spellbook for `learnModel: 'spellbook'`), the background feat, and the class starting loadout. It finishes by running the same `applySpecies` / `applyModifiers` / `applyEquipment` passes the load path uses, so the returned def is fully derived. Shared validators + ability-score generation live in [`shared/abilityScores.ts`](../shared/abilityScores.ts) (Standard Array, Point Buy 27-budget cost table, background increase rules); the random 4d6-drop-lowest roll is `CharacterBuilder.rollAbilityScoreSet`.

**Languages (US-123).** [`shared/languages.ts`](../shared/languages.ts) holds the SRD 5.2.1 Standard + Rare language tables. `PlayerDef.languages` is the known set; per SRD every character knows **Common + two chosen Standard languages** (species grant none in 5.2.1). `buildPlayerDef` validates the two Standard picks and folds in **feature grants** via `FeatureDef.grantsLanguages` (data-driven — Rogue `thieves-cant` → `["Thieves' Cant"]`), merged Common-first by `mergeLanguages`. Known languages render on the Character Sheet Story tab and in the AIGM CURRENT STATE class line (`Languages: …`).

`server/data/subclasses/<id>.json` mirrors the same shape for the chosen subclass. Each subclass references its parent via `classId`; the level-up resolver walks the subclass's `progression[]` at every level the parent class lists in `subclassLevels`. Subclass entries may also grant always-prepared spells (`grantedSpells`) and always-known cantrips (`grantedCantrips`) — these extend the player's prepared list without counting against the prep cap.

### Class spellcasting models

The `spellcasting.slotTableKind` × `spellcasting.learnModel` pair covers every SRD caster shape:

| Class | `slotTableKind` | `learnModel` | `recovery` |
|---|---|---|---|
| Wizard | `full` | `spellbook` | `long-rest` |
| Cleric / Druid / Bard | `full` | `from-class-list` | `long-rest` |
| Sorcerer | `full` | `known` | `long-rest` |
| Paladin / Ranger | `half` | `from-class-list` | `long-rest` |
| Warlock | `pact-magic` | `known` | `short-rest` |
| Fighter / Rogue / Barbarian / Monk | `none` | `innate` | (n/a) |

Pact Magic gets its own `pactMagic: { slotsByLevel, slotLevelByLevel }` block on the spellcasting object (separate from the 9-column `spellSlotsByLevel`), because the slots refill on Short Rest and all live at the same level. Mystic Arcanum (Warlock L11/13/15/17) is `spellcasting.mysticArcanum: { atLevels, spellLevels }` — one spell per level, used once per Long Rest, never a slot. Runtime state for both lives on `PlayerState.pactMagic` and `PlayerState.mysticArcanum`.

### Class progression entries

Each entry in `progression[]` maps a level to:

- `features?: string[]` — feature ids granted at this level. Must exist in `defs.features`.
- `choices?: LevelUpChoiceTemplate[]` — prompts the LevelUpOverlay surfaces. Each template (`{kind, count?}`) is expanded at runtime by `expandChoices` in [Leveling.ts](../server/src/engine/Leveling.ts) into a fully-populated `LevelUpChoicePrompt` (with `options` derived from the live character). Handlers live in [LevelUpChoiceHandlers.ts](../server/src/engine/LevelUpChoiceHandlers.ts).
- `subclass?: true` — marks a level at which the chosen subclass's own progression entry should fire.

### Scaling tracks

`tracksByLevel` is the single hook for per-level scaling values that aren't resource pools authored as features:

```jsonc
"tracksByLevel": {
  "extra-attacks":          [1,1,1,1,2,2,2,2,2,2,3,3,3,3,3,3,3,3,3,4],
  "sneak-attack-dice":      [1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10],
  "martial-arts-die":       ["1d6","1d6","1d6","1d6","1d8","1d8", ...],
  "second-wind-uses":       [2,2,2,3,3,3,3,3,3,4, ...],
  "unarmored-movement-feet":[0,10,10,10,10,15,15,15,15,20, ...]
}
```

Engine subsystems consume them via `playerDef.tracks[id]` (set on level-up by `syncTracks` in Leveling.ts). Adding a new scaling track for a new class is data-only — no engine code change.

### Subclass JSON shape

```jsonc
{
  "id": "evoker", "classId": "wizard",
  "name": "Evoker", "description": "...",
  "progression": [
    { "level":  3, "features": ["evocation-savant", "potent-cantrip"] },
    { "level":  6, "features": ["sculpt-spells"] }
  ],
  // Optional: subclasses that graft spellcasting onto a non-caster class
  // (Eldritch Knight, Arcane Trickster — not in SRD 5.2.1) supply their own
  // `spellcasting` block, and may reference a different class's spell list
  // via `spellListClassId`.
  "spellcasting": null,
  "spellListClassId": null
}
```

Subclass progression entries may carry `grantedSpells: string[]` (Cleric Domain spells, Paladin Oath spells, Druid Circle spells, Warlock Patron spells) and `grantedCantrips: string[]` — both extend the player's list at the level they're first declared and survive future long rests.

### Level-up choice prompts

`Leveling.expandChoices` (in `server/src/engine/Leveling.ts`) maps each `LevelUpChoiceTemplate` (authored in the class/subclass JSON) to a fully-populated `LevelUpChoicePrompt` by filling in the runtime `options`. The pure handlers live in `server/src/engine/LevelUpChoiceHandlers.ts` and mutate the cloned `PlayerDef`. Currently implemented:

| Template kind | Options derived from | Handler effect |
|---|---|---|
| `scholar-expertise` | The six SRD Scholar skills | Stacks PB on the chosen skill |
| `wizard-spellbook-add` | Wizard L1+ spells the character can cast and doesn't yet know | Appends to `defaultSpellbookIds`; count comes from `spellbookGrowthPerLevel` |
| `subclass-choice` | Subclasses with `classId === classDef.id` | Sets `playerDef.subclassId`; subclass features at the current level land in step 6 of `applyLevelUp` |
| `asi-or-feat` | Feat catalogue minus existing feats; live ability scores | Either `+2 one ability`, `+1/+1 two abilities` (both gated to ≤ 20), or appends a feat id |
| `expertise-pick` | Skills the character is currently proficient in (inferred from pre-baked `skills[k] - mod(ability) >= PB`) | Stacks PB on each chosen skill |
| `fighting-style-pick` | Feats with `category === 'fighting-style'` minus existing | Appends feat id; its `modifiers` are aggregated by `applyModifiers` on next session boot |
| `epic-boon-choice` | Feats with `category === 'epic-boon'` minus existing (the level-19 boon, US-119) | Appends the chosen boon feat id to `featIds` (answer field `epicBoonChoice`) |

Unimplemented but reserved: `cantrip-known`, `cantrip-swap`, `spell-swap`, `metamagic-pick`, `invocation-pick`, `mystic-arcanum-pick`, `magical-secrets-pick` — all surface as no-op prompts so an authored level entry doesn't crash the preview.

### Track-driven engine consumers

`playerDef.tracks` (set by `syncTracks` during level-up and by `syncCharacterTracks` at engine boot) is the single source of truth for per-level scaling values. Current consumers:

| Track id | Read by | Effect |
|---|---|---|
| `extra-attacks` | `CombatActions.attacksPerAction` | Number of weapon attacks per Attack action (1 → 4 across Fighter L1-L20) |
| `sneak-attack-dice` | `CombatSystem.resolvePlayerAttack` (via legacy `playerDef.sneakAttackDice` shim) | d6 count added on a Sneak Attack hit |
| `second-wind-uses`, `action-surge-uses`, `indomitable-uses` | Feature handlers in `FeatureRegistry` | Per-rest pools refilled to the track value on level-up + Long Rest |
| `weapon-mastery-count` | (unconsumed; data only) | Per-character cap on weapons with active Mastery — picker UI not yet authored |

### Subclass-aware feature-id checks

A handful of features short-circuit on `playerDef.defaultFeatureIds.includes(...)` to apply their effect without a dedicated handler:

| Feature id | Engine path | Effect |
|---|---|---|
| `improved-critical` (Champion L3) | `CombatSystem.resolvePlayerAttack` — `critFloor` | Critical hits on natural 19-20 |
| `superior-critical` (Champion L15) | same | Critical hits on natural 18-20 (additive) |
| `potent-cantrip` (Evoker L3) | `SpellSystem.resolveAttackRollSpell` miss path + `SpellSystem.damageAfterSave` | Damaging cantrips deal half on a miss / successful save |
| any feature with a `slotRecovery` descriptor (Wizard Arcane Recovery, Druid Natural Recovery) | `ExplorationActions.doShortRest` | Greedy slot recovery up to ⌈level / `budgetDivisor`⌉ levels, ≤ `maxSlotLevel`, once per Long Rest. Gated on owning the feature, not a class name — see `slotRecovery` field below |

### Routes

`GET /classes` and `GET /subclasses` return the loaded def arrays. Used by character-creation and the LevelUpOverlay's subclass-choice picker.

---

## features/

Class abilities authored as data + handler. Each file describes a single feature; characters list the features they know via `defaultFeatureIds`. At session start the engine initializes one resource pool per feature with `resource.kind !== 'unlimited'` into `PlayerState.resources[featureId]`, and the [`FeatureRegistry`](../server/src/engine/FeatureRegistry.ts) maps `handler` ids to the TypeScript functions that resolve the mechanical effect.

The shape mirrors `spells/`: data describes WHAT and WHEN; code describes HOW. New class abilities are added by dropping a JSON file here and (if non-passive) registering a handler.

### Fields

| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique key (kebab-case). |
| `name` | string | Display name. |
| `classId` | string | Owning class id, lowercase (e.g. `"fighter"`, `"rogue"`). Display-only for now. |
| `minLevel` | integer | Class level required to know this feature. |
| `description` | string | SRD prose for the feature. |
| `cost` | object | `{ kind: 'action' \| 'bonus-action' \| 'reaction' \| 'free' \| 'attack-time' \| 'passive', trigger?: string }`. `attack-time` modifiers (Sneak Attack, Smite) fire inside the attack resolver; `passive` features have no button and no runtime effect dispatcher. |
| `resource` | object? | `{ kind: 'uses-per-long-rest' \| 'uses-per-short-rest' \| 'pool' \| 'unlimited', max: integer }`. Omit when the feature has no resource pool. |
| `ui` | object? | UI hints — `{ buttonLabel?, buttonColor?, resourceLabel? }`. `resourceLabel` is a template using `{remaining}` and `{max}` placeholders, e.g. `"Second Wind: {remaining}/{max}"`. Features without a `buttonLabel` aren't rendered as buttons (passive / attack-time features). |
| `handler` | string? | Key into the server's `FeatureRegistry`. Omit for data-only features (Unarmored Defense applied at character load, Expertise as a skill modifier, etc.). |
| `modifiers` | Modifier[]? | Passive typed contributions (`crit-range` / `flag` / `advantage`) aggregated onto `PlayerDef.modifiers` — e.g. Improved Critical, Remarkable Athlete, Potent Cantrip. See [Modifier aggregator](#modifier-aggregator). |
| `slotRecovery` | object? | `{ budgetDivisor: int, maxSlotLevel: int }`. Short-rest spell-slot recovery (Wizard Arcane Recovery = `{ 2, 5 }`). On a Short Rest, once per Long Rest, recover expended slots whose combined level totals at most ⌈characterLevel / `budgetDivisor`⌉, none above `maxSlotLevel`, lowest-first. `doShortRest` reads this off the owned feature — a new recovery feature (Druid Natural Recovery) is data-only. |

### Example — `features/second-wind.json`

```json
{
  "id": "second-wind",
  "name": "Second Wind",
  "classId": "fighter",
  "minLevel": 1,
  "description": "Bonus Action. Roll 1d10 and regain HP equal to the roll plus your Fighter level. Refilled on a Long Rest; one use returns on a Short Rest.",
  "cost": { "kind": "bonus-action" },
  "resource": { "kind": "uses-per-long-rest", "max": 2 },
  "ui": {
    "buttonLabel": "SECOND WIND",
    "buttonColor": "#1a3a5a",
    "resourceLabel": "Second Wind: {remaining}/{max}"
  },
  "handler": "second-wind"
}
```

### Lifecycle

1. **Load**: server reads `features/*.json` at startup; the array is surfaced to the client via `GET /features`.
2. **Session start**: `SessionBuilder` iterates the player's `defaultFeatureIds`, looks up each feature, and seeds `PlayerState.resources[featureId] = feature.resource.max` (skipping `unlimited` resources).
3. **UI**: `AvailableActions.usableFeatureIds` is computed each tick by `canUseFeature` (knows-the-feature ✕ resource remaining ✕ action-economy ✕ feature-specific gates). The Player Panel iterates the character's known features and renders one button per feature with a `buttonLabel`, plus one resource chip per feature with a `resourceLabel`.
4. **Use**: client sends `{ type: 'useFeature', featureId }`; server dispatches to `doUseFeature` → handler in the registry, which consumes the resource, spends the action/bonus-action, and applies the effect.
5. **Persistence**: `PlayerState.resources` is written to `CharSave.resources` on every action and reloaded on resume. A Long Rest (= new encounter) refills any `uses-per-long-rest` pool by re-running the SessionBuilder seeding.

**Shared resource pools (Channel Divinity, US-120).** The Cleric's three Channel Divinity options — `turn-undead`, `divine-spark`, `preserve-life` — have no own `resource`; they draw from one pool held on the `channel-divinity` feature (`resources['channel-divinity']`, `uses-per-short-rest` max 2). `canUseFeature` special-cases the three to gate on that shared key, and each handler decrements it via `spendChannelDivinity`. Handlers that find no valid target (Turn Undead with no undead in range; Preserve Life with no bloodied creature) return without spending the use or the Action. Divine Spark reads `state.selectedTargetId` to choose heal-ally/self vs radiant-damage-enemy. (The pool max is static at 2 — the per-level `channel-divinity-uses` track scaling to 3/4 is a known gap, shared with the Second Wind static-max limitation.)

---

## Level Advancement

SRD 5.2.1 character advancement. The XP-to-level table + helpers live in [`shared/xpTable.ts`](../shared/xpTable.ts) so the server (eligibility gate, level-up application) and client (preview rendering, button visibility) share a single source of truth.

### Eligibility

`AvailableActions.canLevelUp` flips true when **`state.phase === 'exploring'`** AND `xpForLevel(playerDef.level + 1) <= player.xp` AND `playerDef.level < 20`. Combat-phase advancement is intentionally blocked — the HP / spell-slot mutations would land mid-turn otherwise.

### Server flow

`server/src/engine/Leveling.ts` exposes three entry points, all driven by class JSON data via `shared/classProgression.ts`:

- **`previewForLevel(playerDef, toLevel, features, spells, classes, subclasses)`** — pure preview builder, no XP gate. Returns a `LevelUpPreview` (HP gain, proficiency before/after, spell-slot deltas, new feature list, required choices). Reads `classDef.fixedHpPerLevel`, `cpFeaturesAt`, `spellSlotDelta`, and `subclassFeaturesAt` — no hard-coded level logic remains. When the target class isn't yet authored as data the preview falls back to "no features granted" rather than throwing.
- **`applyLevelUp({ playerDef, choices, ... classes, subclasses, preview })`** — mutates the cloned `playerDef` in place: bumps `level`, `maxHp`, `proficiencyBonus`, `defaultSpellSlots`, appends new feature ids to `defaultFeatureIds`, dispatches choice payloads through `LevelUpChoiceHandlers.applyAllChoices`, syncs `playerDef.tracks` from `classDef.tracksByLevel`, and applies subclass-granted always-prepared spells / cantrips when the level is one of the parent's `subclassLevels`.
- **`applyLevelUpHistory(playerDef, history, ...)`** — session-start replay. Iterates a recorded `LevelUpChoices[]` and applies each one so the engine's per-session clone reflects the character's current level.
- **`syncCharacterTracks(playerDef, classes)`** — projects the class's track values onto `playerDef.tracks` for the character's current level. Called once at engine boot after the level-up replay.

`GameEngine.buildLevelUpPreview()` and `GameEngine.commitLevelUp(choices)` wrap these for HTTP routes. Commit projects the new `maxHp` onto `state.player.hp` (heals the gained HP), tops up the player's runtime spell-slot pool by each delta, and initialises feature resource pools for newly-granted resourced features (e.g. Action Surge → 1/1).

### Routes

| Method | Path | Body / Response |
|---|---|---|
| GET | `/game/session/:id/level-up` | Returns `{ preview: LevelUpPreview \| null }`. `null` means the character isn't eligible — the client treats it as a no-op rather than an error. |
| POST | `/game/session/:id/level-up` | Body `{ choices: LevelUpChoices }`. Server runs `commitLevelUp`, persists the new entry to the character save's `levelUps[]`, pushes a `state_update`, and responds with `{ preview, state, playerDef }`. The client refreshes its cached `playerDef`. |

### Persistence

The character save (`server/data/saves/{id}.json`, shape `CharSave`) carries `levelUps: LevelUpChoices[]` — one entry per level above 1. `GameEngine.createSession` replays these onto a fresh `PlayerDef` clone before `SessionBuilder` runs, so the initial state (`maxHp`, `defaultSpellSlots`, `defaultFeatureIds`) reflects the character's actual level. The route fills `resumeLevelUps` from the server save (source of truth) and only falls back to the request body when no server save exists.

### Tier 1 catalogue (current scope)

| Class → L2 | HP gain (fixed) | New features | Choices required |
|---|---|---|---|
| Wizard | 4 + Con mod | Scholar | Pick 1 of {Arcana, History, Investigation, Medicine, Nature, Religion} for Expertise; pick `min(2, available wizard L1 spells)` new spells for the spellbook |
| Fighter | 6 + Con mod | Action Surge (1 use / Short Rest), Tactical Mind | None |
| Rogue | 5 + Con mod | Cunning Action | None |

L3 → subclass + L4 → ASI / Feat are intentionally out of scope for now; `previewForLevel` throws a clear error if asked for level 3+, surfaced as a `400` from the route.

---

## Long Rest

SRD 5.2.1 Long Rest (Rules Glossary → Long Rest). Eligibility is per-encounter: `EncounterDef.allowsLongRest = true` ⇒ `GameState.allowsLongRest = true` ⇒ `AvailableActions.canLongRest = phase === 'exploring' && allowsLongRest`. The Player Panel surfaces the `☾ LONG REST` button when that flag is true; the flag should be set on safe-haven encounters (taverns, safehouses, established camps), never wilderness or hostile zones.

### Server flow

`server/src/engine/Resting.ts`:

- **`buildLongRestPreview({ playerDef, player, features, spells })`** — pure read-only summary: HP gap to max, hit dice spent, per-slot spell deltas to max, every refillable feature pool with `before` / `max`, exhaustion flag, and (for Wizards) a `wizardSpellPrep` block carrying the spellbook list, current preparation, and the SRD `maxPrepared` cap.
- **`applyLongRest(inputs, choices, preview)`** — mutates `PlayerState` in place: `hp = maxHp`, `hitDiceUsed = 0`, `spellSlots = max[]`, every non-unlimited feature resource set to `max`, `exhaustionLevel -= 1` if non-zero. Wizards replace `preparedSpellIds` with the picked list (validated against the spellbook + cap).

`GameEngine.buildLongRestPreview()` / `commitLongRest(choices)` wrap these for the routes and write a "── Long Rest ──" header to the event log with the deltas.

### Routes

| Method | Path | Body / Response |
|---|---|---|
| GET | `/game/session/:id/long-rest` | Returns `{ preview: LongRestPreview \| null }`. `null` means the encounter doesn't permit Long Rest, or the player isn't in exploration. |
| POST | `/game/session/:id/long-rest` | Body `{ choices: LongRestChoices }`. Server runs `commitLongRest`, persists the rested state to `CharSave` (HP, spell slots, prepared spells, resources), broadcasts a `state_update`, and returns `{ preview, state, playerDef }`. |

### Prepared-spell cap

The per-level prepared-spell counts live on the **class definition** (`spellcasting.preparedSpellsByLevel`, e.g. Wizard L1 = 4, L2 = 5, L5 = 9, …) — the single source of truth shared with the level-up resolver via `preparedSpellsAt(classDef, level)` in `shared/classProgression.ts`. `Resting.ts` reads that table rather than duplicating it; the effective cap is `max(preparedSpellsAt(classDef, level), currentlyPreparedCount)` so feat-granted extras (e.g. Magic Initiate adding a prepared spell at L1) survive rest. The Long Rest prep picker is driven by `classDef.spellcasting.learnModel`, not a class-name check (US-120): `spellbook` (Wizard) offers the spellbook; `from-class-list` (Cleric) offers every class-list spell (`spell.classes` includes the class id) of castable level. `Resting.prepPool` builds the pool once for both the preview and the apply-time validation. The picker payload is `LongRestPreview.spellPrep` (`{ spellbookSpells, currentlyPrepared, maxPrepared, source: 'spellbook' | 'class-list' }`) and the answer is `LongRestChoices.preparedSpellPicks`. Casters with `learnModel: 'known'`/`'innate'` get no rest-time picker (their list is fixed).

### Persistence

`POST /game/session/:id/long-rest` rewrites `CharSave.hp / spellSlots / preparedSpellIds / resources` on disk. The `levelUps` history is untouched — Long Rest doesn't affect character advancement.

---

## tokens/

SVG token sprites rendered on the map and in the turn-order bar. One file per creature; the same artwork is used for the in-game token, the turn-order chip, and the character-card avatar on Encounter Setup / Adventure Setup.

### Filename convention

Resolution is handled by [`client/src/data/tokens.ts`](../client/src/data/tokens.ts), which honours an explicit `tokenAsset` field on the def first and otherwise derives the path from the convention:

| Def kind | Convention path | Example |
|---|---|---|
| `PlayerDef` | `/tokens/player_<className_lower>_<speciesLineage \| speciesId, dashes stripped>.svg` | `aldric` (Fighter / Human) → `/tokens/player_fighter_human.svg`; `miriel` (Rogue / wood-elf) → `/tokens/player_rogue_woodelf.svg` |
| `MonsterDef` | `/tokens/monster_<id>.svg` | `bandit` → `/tokens/monster_bandit.svg` |
| `NPCDef` | `/tokens/npc_<id>.svg`, then falls back to the monsterClass's token if the file isn't present | `tavern_keeper` → `/tokens/npc_tavern_keeper.svg`; `bridge_bandit` (no file) → falls back to `/tokens/monster_bandit.svg` |

When the artist wants to name a file differently from the id (e.g. `wanderer` rendered as `npc_wandering_sage.svg`), the NPC JSON sets `tokenAsset: "/tokens/npc_wandering_sage.svg"` explicitly. Same mechanism works for players and monsters.

### Server endpoints

| Endpoint | Returns | Notes |
|---|---|---|
| `GET /tokens` | `string[]` of filenames in the directory | Used by `BootScene` to filter which convention paths to actually queue — NPCs with no corresponding file silently fall back to the monsterClass token at render time instead of triggering a load-time error. Excludes the `parts/` and `specs/` subdirectories; only top-level `*.svg` files. |
| `GET /tokens/:filename` | The SVG bytes (`Content-Type: image/svg+xml`) | Filename validated against `^[A-Za-z0-9_-]+\.svg$`. Registered AFTER the static `/tokens` and `/tokens/parts` routes so the parametric `:filename` only catches actual SVG filenames. |
| `GET /tokens/parts` | `{ slots: Record<TokenSlot, Record<string, string>>, catalog: PartCatalog }` | Full parts library — every fragment's SVG body, keyed by slot then by part id. Used by `TokenCreatorScene` to compose previews locally without round-tripping per slot change. Fragments still carry `{{COLOR}}` placeholders — the client stamps them at preview time. |
| `GET /token-specs` | `string[]` of spec ids (filenames without `.json`) | Used by `TokenPickerOverlay` to flag which saved SVGs are editable specs (vs. legacy hand-authored tokens that don't have a spec). |
| `GET /token-specs/:id` | The spec JSON (`Content-Type: application/json`) | Returns the editable `TokenSpec` so re-opening the Token Creator restores every slot pick + palette choice. 404 when no spec exists for the id. |
| `POST /token` | `{ tokenAsset: string }` (path to the saved SVG) | Body shape: `TokenSpec`. Composes the SVG from the spec + the in-memory parts library and writes BOTH `data/tokens/<id>.svg` (the flattened SVG referenced via `NPCDef.tokenAsset`) AND `data/tokens/specs/<id>.json` (the editable spec). The returned `tokenAsset` is the path the client drops into the NPC Creator's TOKEN ASSET PATH field. |

### Composed tokens — `TokenSpec`

Editable JSON spec used by the Token Creator to assemble an NPC token from a parts library. Stored at `server/data/tokens/specs/<id>.json` and replayed against the parts library to reproduce the flattened SVG at `server/data/tokens/<id>.svg`.

| Field | Type | Notes |
|---|---|---|
| `id` | string | snake_case slug. Used as both the SVG filename (`<id>.svg`) and the spec filename (`<id>.json`). |
| `slots` | object | Map of `TokenSlot` (`body` / `ears` / `face` / `beard` / `eyes` / `mouth` / `hair` / `accessory`) → part id (matching a key in `tokens/parts/<slot>/`). Missing slots are omitted from composition; the `body` slot is required. |
| `palette` | object | Map of palette key (`body` / `skin` / `hair`) → hex colour string (`"#aabbcc"`). Drives the `{{COLOR}}` placeholders in the fragments — see [Parts library](#parts-library). |

### Parts library — `server/data/tokens/parts/`

One folder per `TokenSlot`. Each folder contains one or more `<part_id>.svg` fragment files.

| Convention | Details |
|---|---|
| **Fragment format** | Each `<part_id>.svg` is an SVG body (not a full document — no `<svg>` wrapper) holding the geometry for that slot only. Fragments are composed in a fixed z-order: `body → ears → face → beard → eyes → mouth → hair → accessory`. |
| **Palette placeholders** | Fragments use `{{COLOR}}` tokens of the form `{{body}}` / `{{skin}}` / `{{hair}}` where a palette colour should be substituted. The composer (`server/src/tokenCompose.ts` server-side, `client/src/ui/tokenComposer.ts` client-side) stamps the matching `TokenSpec.palette[key]` hex value at composition time. |
| **Catalog** | The server walks the directory once at boot and surfaces `{ slots: { <slot>: { <partId>: fragment } }, catalog: { <slot>: [<partId>, …] }` via `GET /tokens/parts`. The Token Creator uses the catalog to render slot thumbnails. |

### Loading

`BootScene.preload` fetches the listing from `GET /tokens`, then for every player / monster / NPC def queues `load.svg(tokenTextureKey(path), …, { width: TILE_SIZE*2, height: TILE_SIZE*2 })` only when the convention path is in the listing. Tokens are rasterised at 2× tile size (100 × 100 px) for retina-friendly resolution and scaled down per render via `setDisplaySize`.

The default fallback colour when an SVG fails to load is `DEFAULT_TOKEN_COLOR` (`0x3388ff`) — exposed from [`client/src/constants.ts`](../client/src/constants.ts) alongside `DEFAULT_TOKEN_COLOR_HEX` (`'#3388ff'`), which is also the unified text colour for NPC nameplates.

---

## tilesets/

Shared tile palettes. Three kinds of files live here:

| File | Purpose |
|---|---|
| `{name}.png` | Tile atlas image. Served by the server at `GET /tilesets/{name}.png`; loaded by `BootScene` as a Phaser spritesheet sliced by the matching `.tsj`'s `tilewidth/tileheight/spacing/margin`. |
| `{name}.tsj` | Tiled external tileset (JSON): the canonical record of the atlas's geometry (image filename, image/tile dimensions, spacing, margin, column count, tile count). Referenced from a map file via `tilesets[].source: "../tilesets/{name}.tsj"`. See the [tilesets section under maps/](#tilesets) for the field list. |
| `{name}_legend.json` | AI-facing tile legend: a per-GID dictionary of what each tile means semantically. Used in two ways: (1) as input to AI map-authoring prompts so an LLM can pick tile ids by intent, and (2) by the server as a passability **fallback** when an encounter's `tileProperties` doesn't declare a given GID. |

### Tile legend file

| Field | Type | Notes |
|---|---|---|
| `notes` | string | Free-form authoring notes for an AI generator. Should explain the Tiled tile-layer shape, name the firstgid convention used by the keys, and call out the multi-layer (ground + object) model. |
| `tiles` | object | Map of GID (as string) → tile entry. **Keys are GIDs**, not tileset-local ids — they assume the tileset is referenced at `firstgid: 1`. If a future map ever loads the tileset at a different firstgid the keys must be offset accordingly. |

Each tile entry:

| Field | Type | Notes |
|---|---|---|
| `name` | string | Short identifier, e.g. `"grass"`, `"chair_right"`. |
| `blocksMovement` | boolean | When true, creatures cannot walk onto the tile (wall, tree, chasm). Engine-authoritative default; encounter `tileProperties` can override. Absent ⇒ does not block (passable). |
| `blocksSight` | boolean | When true, line-of-sight cannot pass through the tile. Independent of movement (a chasm blocks movement but not sight; a glass wall the reverse). Baked into `GameMap.blocksSight` by ORing the ground and object features so either one blocks the cell. Absent ⇒ does not block. |
| `layer` | string | `"ground"` or `"object"`. Tells map authors which tile layer the entry belongs on. Ground tiles are drawn first; object tiles overlay them. |
| `description` | string | Visual / authoring description. Surfaced to AI map generators. |
| `tags` | string[] | Free-form classification tags, e.g. `["wood", "bridge", "floor"]`. |

The server loads every `*_legend.json` file at startup into two structures on `defs`: a per-tileset map `defs.tileLegendsByTileset` (keyed by tileset name — the collision-free source of truth used by `SessionBuilder` for play-time passability/sight/cover) and a flattened `defs.tileLegend` (a single local-id → entry map kept only as a legacy fallback; it is lossy because tilesets reuse the same low local ids). Dropping in `{name}.png`, `{name}.tsj`, and `{name}_legend.json` together is enough to register a tileset for the **Map Editor** and **Tile Creator** with no engine code changes.

**Shipped tilesets and their firstgid offsets.** Maps address tiles by *global* GID = `firstgid + localId − 1`, so every tileset that can appear in one map needs a disjoint firstgid range. These are declared in [`server/src/engine/mapTiles.ts`](../server/src/engine/mapTiles.ts) and [`server/src/engine/maps/shared.ts`](../server/src/engine/maps/shared.ts):

| Tileset | firstgid | Global GID range | Contents |
|---|---|---|---|
| `scribble` | 1 | 1–154 (+ void 65534) | Primary hand-drawn set: floors, walls, decor, furniture. |
| `water` | 200 | 200–215 | Auto-tiling water/shore edges for ponds and coastlines. |
| `cave_and_urban_floors` | 300 | 300–349 | Ground-only: cave floors (dust/gravel/rock, impassable pools, sight-blocking chasms) and urban floors (cobbles/bricks/slabs/plazas). |

**Using a new tileset in the AI map generator** *does* require code: add it to `AI_PALETTE_TILESETS` in `shared.ts` (name + firstgid). The generator then builds its prompt palette and validation sets from a *global-GID* legend ([`globalTileLegend`](../server/src/encounterGenerator.ts) — `firstgid + localId − 1` per tileset, so all tilesets coexist without the local-id collisions of `defs.tileLegend`), and `tilesetsForGids` computes the `tilesets[]` a generated map declares from the GIDs it actually used. `ownerTilesetName` routes a GID to its tileset using the same greatest-firstgid-≤-gid rule as `SessionBuilder.ownerTileset`, and gids a tileset does not own (e.g. scribble's high void sentinel) are excluded from the AI palette so they can never mis-route.

The **Tile Creator** page (see `ui.md`) edits these entries through `PUT /tilesets/:tileset/tiles/:gid` (body = a `TileLegendEntry`). The handler validates the entry, writes it into `<tileset>_legend.json` (preserving the `notes` block and every other tile), and reloads defs. `GET /tilesets/legends` returns one block per tileset (`{ tileset, image, notes, tiles }`) for rendering, and `GET /tilesets` returns the image-slicing metadata (`tilewidth`, `tileheight`, `columns`, `margin`, `spacing`) the Creator uses to crop each frame.

The current scribble legend also reserves **GID 65534 (`void`)** as a sentinel: the renderer paints solid black instead of sampling a frame, and the cell is impassable. Used for chasms / abysses on tilesets that have no flat-black tile of their own (see `shared/tileGid.ts`).

### Deterministic map composition

`server/src/engine/MapComposer.ts` is the rule-based map generator used when the player sets a TERRAIN toggle on `MapEditorScene`. It produces the same Tiled-shaped payload as the AI generator. Two public functions:

| Function | Notes |
|---|---|
| `stampRoom(terrain, opts)` | Support primitive. Lays down a rectangular room with the correct corner/edge rotations from the scribble palette (`stone_wall_top` 0/90/180/270, `stone_wall_corner_tl` 0/90/180/270), an interior of `floorBase` with optional `floorAccent` checker mix, named `doorways` carved out as floor tiles, and a `ruinedBreaks` count of additional random non-corner gaps. Always overwrites whatever was at those cells. |
| `composeMap(opts)` | Top-level composer. Builds a base grid from `terrain` (`grassland \| forest \| dungeon \| tavern \| cave \| urban`) and layers `features: ('campsites' \| 'coastline' \| 'path' \| 'intersection' \| '3-room' \| '5-room' \| 'stairs')[]` plus `structures: StructureSpec[]` on top. `path` is laid first as a meandering trail so later features stamp over it. Seeded via mulberry32 so the same `{ terrain, features, structures, seed }` yields the same map. |
| `StructureSpec` | One configurable outdoor structure: `{ type: 'building' \| 'ruin'; rooms: number }` (rooms clamped 1..5). `stampStructure` lays the rooms in a compact grid (cols = ⌈√rooms⌉) of uniform rooms sharing single walls, links them into a spanning tree via doorways punched in the shared walls plus one external entrance doorway, and renders walls from an 8-neighbour floor mask. A `ruin` cracks its floor and crumbles straight wall segments (gap / cracked-wall / rubble-wall variants). Replaces the old `buildings`/`ruins` feature counters; `buildingsCount` survives only for the urban composer's plaza ring. |

Map-composer routes (all live in `server/src/routes/generate.ts`, mounted by `index.ts` via `registerGenerateRoutes`):
- `POST /generate/map/composed` — composes the map only and writes it to `server/data/maps/gen_<timestamp>_<slug>.json`. Returns the payload for immediate preview.
- `POST /generate/encounter/composed` — composes (or reuses) a map and writes a minimal encounter shell (no Claude call). Body accepts either `{ terrain, features, width?, height?, seed? }` to compose a fresh map, OR `existingMapId` to reuse an already-saved map (the path used after the player presses ACCEPT in the Map Preview Overlay). Additional fields: `encounterTypes` (defaults to `['exploration']`), `description` (player-facing card summary, written to `EncounterDef.description` — falls back to the map's `mapdescription` if omitted), `aigmContext` (long-form GM scene context, written to `EncounterDef.customContext`), `startingZonesData` (flat row-major zone array with the values from `shared/startingZones.ts` — `STARTING_ZONE_PLAYER` (1) / `_ALLY` (2) / `_NEUTRAL` (3) / `_ENEMY` (4) — at least one cell must equal `STARTING_ZONE_PLAYER` for spawn; falls back to first-passable-cell when omitted), `allyIds` (def ids spawned as allies with friendly disposition — written to the encounter's `allyIds`), and `enemyIds` (def ids spawned as hostiles — written to the encounter's new `enemyIds` field, **not** `npcIds`). All creature ids are validated against the monster + NPC rosters and rejected with HTTP 400 if unknown. Returns `{ mapId, encounterId, width, height, terrainData, objectData, name, description }`.
- `POST /generate/encounter/update` — used by `EncounterCreatorScene` to write changes back to an existing encounter. Body shape mirrors `composed` minus map-composition fields, plus a required `encounterId`. The handler reads the encounter file, merges only the editable fields the body supplies (title, intro, **description** (player), **aigmContext** (GM-only, writes to `customContext`), objective, completionFlag, mapId override, startingZonesData, allyIds/enemyIds/neutralIds, triggers), and writes back **preserving every other top-level field** (`environment`, `tileProperties`, `generated`, etc.) by spreading the existing JSON first. Trigger expansion reuses the same per-kind logic as `composed` (perception → `player_ability_check`, log → `show_log`, aigm → `send_aigm_message`, combat → `set_disposition_by_def_id` × N + `trigger_combat`). Returns `{ encounterId, mapId }`. 404s when the encounter doesn't exist; 400s on unknown creature ids or zone-array length mismatch.
- `DELETE /generate/maps/all` — dev-mode cleanup. Unlinks every `gen_*.json` in `server/data/maps/` and `server/data/encounters/`, then re-runs `loadDefs()`. Returns `{ mapsDeleted, encountersDeleted }`. Triggered from the `[DEV] DELETE ALL GEN MAPS` button on Generator Setup Scene. Relies on the **`gen_` namespace invariant** (`isGeneratedId` in `engine/MapPersistence.ts`) — hand-authored map and encounter ids MUST NOT begin with `gen_` or they'd be silently wiped here.

### Agentic AI map builder

The GENERATIVE AI tab of the Map Editor is backed by an **agentic** builder, not the old one-shot "emit a raw tile array" generator (which has been removed). The model directs a toolbox of deterministic operations via tool-use and reads back an ASCII render after every step, so generated maps are always geometrically valid. Modules under `server/src/engine/maps/`:

| Module | Responsibility |
|---|---|
| `MapCanvas.ts` | The shared mutable substrate every op writes to: the `terrain` + `objects` GID grids, the deterministic `mulberry32` RNG + zone-id allocator, the accumulating `anchors` / `zones`, and a `reserved` set structure placers use to avoid overlap. `toComposedMap(name, desc)` renders it to the persisted `ComposedMap` shape, deriving `tilesets[]` from the GIDs actually used (`tilesetsForGids`) — so a cave map auto-declares the cave tileset, a town map the urban tileset. |
| `materials.ts` | The model-facing **material vocabulary** — designer names (`grass`, `cobbles`, `cave_dust`, `chasm`, `tree`, …) resolved to GIDs here, grouped by role (`GROUND_MATERIALS`, `HAZARD_MATERIALS`, `DECOR_MATERIALS`, `FURNITURE_MATERIALS`, `WALL_RING`). The model never sees a GID, so it cannot emit an invalid tile or mix layers. Also exports conservative `groundBlocksMovement` / `objectBlocksMovement` predicates (aligned with the tileset legends) for connectivity checks. |
| `mapOps.ts` | The deterministic op toolbox, each `(canvas, params) → OpResult` (`{ ok, summary }` or `{ ok:false, error }`): `fillTerrain`, `stampRoom`, `placeBuilding`, `carveCorridor`, `layPath`, `placeWaterBody` (edge coast or shored pond), `placeHazard`, `scatterDecor` (clustered biome decoration), `placeCampsite`, `paintRegion`, `defineZone`, `wallAroundFloor` (8-neighbour wall-follow for organic caves). Correctness lives here — walls align/enclose, corridors connect, paths/water auto-tile. Also `validateCanvas` + `passableRegions` (flood-fill connectivity). The wall/path/water/decor logic is ported from the per-terrain composers so op-built maps render identically to composed ones. |
| `canvasRender.ts` | `renderCanvasAscii(canvas)` — renders the canvas as a coordinate-ruled ASCII grid with a legend, sent back to the model after every op as its feedback signal. |
| `mapAgent.ts` | `generateMapAgentic(anthropic, defs, req)` — the loop. Exposes the ops as Anthropic tools (`begin_map` → ops → `finish`), forces tool-use each turn, applies each op to the canvas, returns the op summary + fresh ASCII render as the tool result, and bounds the run (`MAX_TURNS`, `MAX_OPS`). On `finish` it auto-repairs connectivity (`autoRepairConnectivity` carves corridors to join stray passable regions to the largest) and persists via `buildMapJson`. `runAgenticBuild` is the disk-free inner function (unit-tested with a scripted model in `mapAgent.test.ts`). Served behind the unchanged `POST /generate/map`. |

The deterministic `MapComposer` path (DETERMINISTIC tab) is unchanged and guarded by `MapComposer.test.ts`, a seed-stability snapshot test that pins the byte output of every terrain/feature combination.

### Encounter archetypes — random-encounter recipes

The Adjudicator's **★ RANDOMIZE** button (`MapEditorScene.runRandomizeEncounter`) authors a complete encounter without any author inputs by rolling a weighted entry from a data-driven registry. Placement is **anchor-driven** so spawns are suitable for the rolled terrain + story (dungeon parties at the entrance, vault guardians at the deepest room, bandits at the campfire, undead in the seaside ruins). Three modules:

| Module | Responsibility |
|---|---|
| `server/src/engine/MapComposer.ts` — `MapAnchors` | The composer records named regions of interest as it stamps features and returns them on `ComposedMap.anchors`. Fields populated: `rooms[]` + `entrance` + `vault` (dungeons), `campfires[]` (campsites), `buildings[]` (full rectangle footprints), `pathEndpoints` (path's 2 cells, or 3 when intersection / T-junction), `pathIntersection` (crossing cell), `inlandBand[]` (dry-side cells when coastline is on), `entrance` (tavern doorway). Every field is optional — only features that actually placed end up populated. The composer also returns `ComposedMap.zones?: MapZone[]` — author-time named regions persisted alongside the map JSON. Today's emitters: `path` + `intersection` (path placer), `building <n>` / `ruin <n>` (structure placer, one per structure), `tavern` + `bar` + `tables` (tavern composer), `entrance` + `vault` + `room <n>` (dungeon, one per room), `central cavern` + `chamber <n>` (cave), `plaza` (urban), and `Entrance Stairs` (cave/dungeon stairs feature). Zone ids are deterministic per seed via `makeZoneIdAlloc` (`zone_<kind>_<seedHex>_<counter>`). The composer dispatches by terrain into per-terrain modules under [server/src/engine/maps/](server/src/engine/maps/) (`outdoor.ts`, `dungeon.ts`, `tavern.ts`); shared GIDs live in [server/src/engine/mapTiles.ts](server/src/engine/mapTiles.ts) (`TERRAIN_GIDS`, `WALL_GIDS`, `PATH_GIDS`, `FURNITURE_GIDS`, `DECOR_GIDS`, `WATER_GIDS`); public types in [server/src/engine/mapTypes.ts](server/src/engine/mapTypes.ts). |
| `client/src/data/encounterArchetypes.ts` | The registry — exports `ENCOUNTER_ARCHETYPES: EncounterArchetype[]`. Each archetype declares `terrain`, fixed `features` or a `featurePicks` pool, `titles` / `introductions` / `descriptions` / `objectives` string pools, `enemyPool` + `enemyCount` ranges, optional `allyPool` + `allyCount`, plus two ordered `PlacementAnchor` lists: `playerAnchors` and `enemyAnchors`. The randomizer walks each list in order and paints cells around the first anchor present on the rolled map; archetypes always end with an `edge:*` fallback so placement is guaranteed when a feature placer didn't fire. A `weight` field biases the pick. **Adding new content is a single new entry in this array.** |
| `client/src/encounterRandomizer.ts` | Pure functions consumed by the scene: `pickArchetype(archetypes)` (weighted random pick), `rollArchetype(arch)` (rolls feature subset + monster ids + story strings into a `RolledEncounter`), `buildStartingZonesFromAnchors(width, height, anchors, playerAnchors, enemyAnchors)` (resolves each anchor list against the composed map's `MapAnchors` and paints PLAYER (blue) + NEUTRAL (amber) cells — see the "spawn neutral" note below for why hostile-intent monsters land in the NEUTRAL bucket), and `rollTriggersFromAnchors(width, height, anchors, templates, rolledHostileDefIds)` (resolves each `TriggerTemplate.anchor` into a clamped `{x,y,w,h}` region, returning at most two `ComposedTrigger` objects ready to seed the TriggerEditor; combat-kind triggers carry the deduped `rolledHostileDefIds` as `defIds` so they flip every rolled type at fire time). The randomizer paints generous footprints (5×5 cluster around point anchors, entire interior for rect anchors, 3-row band for edge fallbacks); the server's `parseStartingZones` filters to passable cells. |

The `PlacementAnchor` vocabulary: point anchors (`entrance`, `vault`, `campfire`), `far_room` (any dungeon room other than the entrance), `building` (rect anchor — full interior of the first stamped building), `inland` (coastline dry band), `edge:south`/`north`/`west`/`east` (fallback), and `away_from:campfire`/`building`/`entrance` (any open cell ≥ 6 tiles away — used for enemy placement when the player band hugs a feature; not usable for trigger templates since no single rectangle conveys "everywhere far from X"). The retired `ruin` and `path_endpoint` anchors are gone with the legend sweep that removed opaque structure tiles and moved paths to the object layer.

**Trigger templates.** Each archetype optionally declares `triggerTemplates: TriggerTemplate[]`, where each template carries `{ kind, anchor, radius?, dc?, passMessage?, message?, defId? }`. Kinds match the existing four (perception / log / aigm / combat). The randomizer resolves each template's anchor into a region rectangle and silently drops templates whose anchor didn't materialise on the rolled map — so a Forest Ambush whose path failed to lay down still produces a valid encounter, just without the perception trigger that wanted to sit at the path endpoint. The randomizer caps each roll at `MAX_TRIGGERS` (today 2) of the resolved templates — archetypes that declare more are fine (only the first that-many that resolve are seeded). The editor itself has no cap; the user can add more rows by hand. The rolled triggers populate the TriggerEditor via its new `initialTriggers` option.

### Codebase architecture

- **Shared types** ([shared/types/](shared/types/)) — split by domain. `shared/types.ts` is a barrel re-exporting every per-domain module (`reference`, `entities`, `conversation`, `npcSave`, `equipment`, `classes`, `spells`, `encounter`, `triggers`, `narration`, `factions`, `adventures`, `combatLog`, `engineEvents`, `gameState`, `levelUp`, `longRest`, `reaction`, `animation`, `playerActions`, `wsProtocol`, `session`, `save`) so consumer imports (`from '../../shared/types'`) didn't change. Cross-domain references are explicit `import type { … } from './otherDomain.js'` at the head of each file.
- **Server routes** — `/generate/*` lives in [server/src/routes/generate.ts](server/src/routes/generate.ts); the static `/characters`, `/monsters`, …, `/maps`, `/health`, `/encounters`, `/adventures`, `/quests` GETs live in [server/src/routes/defs.ts](server/src/routes/defs.ts), alongside the character mutations `POST /characters` (build + persist a new `PlayerDef`) and `DELETE /characters/:id` (remove a character definition from the active setting's `characters/` dir and reload the defs — only ids present in the live roster are accepted, so the path can't be traversed). Both modules receive the shared [server/src/routes/ctx.ts](server/src/routes/ctx.ts) `AppCtx` (anthropic client + dataDir + live getters for defs and config). The remaining routes are still inlined in [server/src/index.ts](server/src/index.ts) and follow the same `register<X>Routes(server, ctx)` pattern as they get extracted.
- **Map composer** dispatcher + per-terrain modules under [server/src/engine/maps/](server/src/engine/maps/); GIDs in [mapTiles.ts](server/src/engine/mapTiles.ts); types in [mapTypes.ts](server/src/engine/mapTypes.ts).
- **Spell geometry** (AoE tile-set builders — cone / cube / sphere / line / chebyshev / placed sphere + `tilesInArea` / `playerInArea` / `creaturesInArea`) lives in [server/src/engine/SpellGeometry.ts](server/src/engine/SpellGeometry.ts). `SpellSystem.ts` imports from it.
- **Client typed registry** — [client/src/data/defRegistry.ts](client/src/data/defRegistry.ts) wraps the Phaser registry with typed getters (`defs.spells()` etc.). Scenes hold a `private defs = new DefRegistry(this);` field and read through it instead of `registry.get('spells') as SpellDef[]`. BootScene is still the writer.
- **GameScene controllers** — extracted controller pattern under [client/src/scenes/gameScene/](client/src/scenes/gameScene/). Today's controller: `AIGMController` (streaming + speech bubbles).
- **Runtime validation** — Claude tool outputs and world-save JSON are validated through zod schemas at parse time (`GeneratedPayloadSchema`, `GeneratedMapPayloadSchema` in `encounterGenerator.ts`; shape-light schema for world save in `index.ts`'s `loadWorldState`).

**Random encounters spawn neutral, escalate via trigger.** Rolled monsters are routed into the encounter's `npcIds` (neutral disposition) rather than `enemyIds`, so the session-create auto-combat check in `index.ts:854` doesn't fire and the encounter starts in `exploring` phase. Combat starts either when the player attacks one of them (faction aggro flips all same-`factionId` NPCs) or when a `combat`-kind trigger fires. The server-side trigger expansion at `/generate/encounter/composed` accepts a new `defIds: string[]` field on combat triggers alongside the existing single `defId`; both are unioned + de-duped into one `set_disposition_by_def_id` action per id, then `trigger_combat`. `rollTriggersFromAnchors` fills `defIds` with the deduped list of every rolled enemy type so a single combat trigger flips a heterogeneous pool (e.g. Dungeon Sweep's `['skeleton', 'kobold_warrior']`) in one fire. The randomizer's `buildStartingZonesFromAnchors` correspondingly paints `STARTING_ZONE_NEUTRAL` cells at the would-be enemy anchors (not `STARTING_ZONE_ENEMY`) — the painter renders them amber, which matches the new "they're here but not hostile yet" semantic.

**Trigger region visualisation.** The full-column `ZonePainter` viewport on `EncounterCreatorScene` renders trigger regions on top of the map as colour-coded outlined rectangles — perception = teal `0x88ccaa`, log = pale blue `0xc8d8e8`, aigm = amber `0xe2b96f`, combat = red `0xff6644`. The overlay is a single `Phaser.GameObjects.Graphics` that gets cleared and re-drawn on every TriggerEditor edit via the `onChange` callback wired in the scene. Inspection happens inline — pan/zoom in the viewport replaces the old click-to-enlarge `MapPreviewOverlay` flow.

**Map-save deferral.** `runRandomizeEncounter` no longer calls `saveMap` — the rolled map sits in `acceptedMap` with `mapId: null` until either (a) the user clicks SAVE in the COMPOSE MAP preview overlay (`saveCurrentMap`), or (b) the user clicks SAVE ENCOUNTER (`runComposeEncounter` checks `acceptedMap.mapId` and calls `saveMap` itself if missing, then proceeds with `composeEncounter`).

Flow at click time: `pickArchetype` → `rollArchetype` → `composeMap` (returns `anchors`; not saved) → `buildStartingZonesFromAnchors` → `rollTriggersFromAnchors` → **populate scene state** (selectedTerrain, selectedFeatures, detTitle / detIntroduction / detDescription / detObjective / detCompletionFlag, rolledPlayerCells, rolledNeutralCells (was-enemy anchor cells now amber), rolledAllyIds, rolledNeutralIds (rolled monster ids), rolledTriggers) → `rebuildDeterministicRight`. The encounter is **NOT** written at roll time — the user must press SAVE ENCOUNTER (which saves the map if needed, then runs `POST /generate/encounter/composed`). `MonsterPicker.initialAllyIds / initialEnemyIds / initialNeutralIds`, `ZonePainter.initialPlayerCells / initialEnemyCells / initialNeutralCells`, and `TriggerEditor.initialTriggers` are the seeding hooks used by the right-panel rebuild; the `buildLineInput` / `buildTextarea` helpers accept an optional `initialValue` so DOM inputs reflect rolled strings on rebuild.

### Generator-UI components

The Adjudicator tab of `MapEditorScene` is assembled from a handful of self-contained components under `client/src/ui/generate/`. They own their own Phaser objects + DOM inputs and expose narrow APIs the scene consumes:

| Component | Responsibility |
|---|---|
| `MapSelectorOverlay.ts` | Modal opened by the **PICK MAP** button. Renders a scrollable grid of cards — one per saved map (`registry.get("maps")`) — with the map's own multi-tileset routing (water + scribble + dungeon all decode correctly), name, and short description. Selecting a card converts the `SavedMapDef` into a `MapPreviewData` (terrain/object grids flattened, tileset `source` paths reversed back to `../tilesets/<name>.tsj`) and resolves via `onSelect`. The scene treats the result as a fresh `acceptedMap` (`mapId` set, no need to re-save) and rebuilds the right panel. |
| `EncounterPickerOverlay.ts` | Modal opened by the **OPEN ENCOUNTER** button on `EncounterCreatorScene`. Same shape as `MapSelectorOverlay` but lists encounters from `registry.get("encounters")`. Each card renders the encounter's referenced map as a thumbnail (looked up from the maps registry by `encounter.mapId`) plus the encounter's title, id, and a `✦ generated` tag when applicable. Selecting an encounter resolves via `onSelect` with the full `EncounterDef`. |
| `ZonePainter.ts` | Phaser-rendered map viewport + click-and-paint surface for PLAYER (blue) / ALLY (green) / ENEMY (red) / NEUTRAL (amber) cells; `setTriggerRegions(regions)` draws color-coded outlined rectangles on top via a `Phaser.GameObjects.Graphics` layer. Every map-related render object (tile sprites, paint overlay cells, trigger outlines, EXACT-mode placement markers) lives inside a single transformable Phaser container with a geometry mask clipped to the viewport rect, so scroll-wheel zoom (around the cursor, clamped 0.3×–6×) and drag-to-pan apply uniformly. Pan/zoom are wired on `scene.input` (pointerdown/move/up/wheel) — see the file header for the collision warning when a scene composes its own scene-level handlers. The paint-mode toolbar (PLAYER / ALLY / ENEMY / NEUTRAL / CLEAR) is HTML; the active brush renders with the variant's brighter background and, in EXACT mode, includes a progress count (`ENEMY 1/3`). Constructor takes both `thumb*` (the map's natural pixel size at default zoom) and optional `viewport*` (the masked + pannable rect — defaults to the map rect for legacy callers; the Encounter Creator passes a full-column viewport). Other options: `initialPlayerCells / initialAllyCells / initialEnemyCells / initialNeutralCells` Sets seed painted zones, `initialPlacementMode` + `initialPlacements` + `initialEnemyIds / initialAllyIds / initialNeutralIds` seed EXACT-mode placements + the entity rosters that drive progress labels, and `onClickEmpty` (optional) fires on a click-without-drag with no active brush. `destroy()` removes the scene-level input listeners + the mask graphics + the HTML paint buttons. |
| `MonsterPicker.ts` | Fully HTML scrollable list. Body is a `<div style="overflow:auto">` containing one row per monster with `+ ALLY` / `+ NEUTRAL` / `+ ENEMY` HTML `<button>`s. Beneath the list sits an HTML summary box (ALLIES / NEUTRALS / ENEMIES) and a CLEAR MONSTERS button. New required options: `height` (vertical space the picker may consume) + `sceneWidth` (for HTML scaling). `initialAllyIds / initialEnemyIds / initialNeutralIds` seed selections at construction; `setVisible(bool)` toggles every owned DOM node (used by the tab toggle); `destroy()` removes them. |
| `TriggerEditor.ts` | Fully HTML scrollable list. Body is a `<div style="overflow:auto">` containing one row per trigger. Each row's `buildRow` is an orchestrator that delegates to a per-section builder: head row (colour swatch + summary + REMOVE), `buildWhenSelector` (mutually-exclusive buttons — REGION / MAP ZONE / ON START / ON COMPLETE / ON FLAG — mapping to the `player_moved` / `player_moved`+`in_zone` / `encounter_started` / `encounter_completed` / `flag_set` WHEN events; `buildWhenZoneRow` renders the map-zone dropdown for MAP ZONE, sourced from the editor's `mapZones` option), `buildChipRow` (the THEN-action chip strip — PERCEPTION / LOG / AIGM CUE / START COMBAT / AWARD XP / ANNOUNCE / SPEECH / FADE / SET FLAG / SET LONG REST / HIDE NPC / KILL NPC / OPEN CONVERSATION), `buildRegionRow` (xywh number inputs; visible only for REGION), `buildWhenFlagRow` (flag-name matcher input; visible only for ON FLAG), and one builder per kind block (`buildPerceptionBlock`, `buildLogBlock`, …, `buildHideNpcBlock`, `buildKillNpcBlock`, `buildOpenConversationBlock`) — only the active kind's block is visible. All builders mutate the row's `ComposedTrigger` directly and route post-edit updates through a single `onChange` closure that re-summarises + repaints the swatch + fires the parent `onChange`. `ComposedTrigger.whenFlagName` (consumed by the `flag_set` WHEN matcher) and `setFlagName` (consumed by the `set_flag` THEN action) are stored as **separate** fields so an author can listen for one flag and write another in the same trigger. **Multi-action triggers:** below the primary kind block, `renderExtraActions(trig, container, onChange)` paints an "ADDITIONAL ACTIONS" section with a `+ ADD ACTION` button. Each extra is a `ComposedAction` (kind + the same per-kind fields used by `ComposedTrigger`) with its own chip row + per-kind block + REMOVE — every chip the primary supports is also available here. The server's `expandComposedTrigger` walks the primary action then each `extraActions` entry in order and concatenates their TriggerAction outputs into the trigger's `then[]`. The "+ ADD TRIGGER" button is an HTML `<button>` beneath the list; the list scrolls natively so there's no fixed cap. Required options: `height` (vertical space) + `sceneWidth`. `initialTriggers` seeds rows; `setVisible(bool)` toggles every owned DOM node; `destroy()` removes them — **callers MUST destroy** or the rows stay parented to `document.body` after navigation. |
| `htmlButtons.ts` — `createHtmlButton` | Factory for absolutely-positioned HTML `<button>` elements scaled to scene coordinates. Replaces the previous pattern of stacking a Phaser `Rectangle` + `Text` per clickable element (which rendered blurry at non-integer scale factors and was prone to Z-order issues with sibling DOM inputs). Variants: `primary`, `secondary`, `danger`, `warn`, `ghost` — each defines `bg / border / color / hoverBg`. The returned `HtmlButtonHandle` exposes `setLabel`, `setActive` (brighter background to indicate toggled-on), `setDisabled` (greyed + click suppressed), `setOnClick`, `setBounds`, `setVisible`, and `dispose` (removes from DOM + detaches the `scale.resize` listener). |
| `htmlButtons.ts` — `createHtmlText` | Sibling factory for HTML text labels (titles, sub-labels, captions, status / empty-state messages). Replaces `this.add.text(...)` for any non-interactive text so labels stay crisp at non-integer canvas scales. Options: `x / y / w / sceneWidth`, `text`, `fontSize`, `color`, `fontFamily` (default `monospace`), `fontWeight`, `letterSpacing` (auto-scaled with the canvas), and `align` (`left` / `center` / `right`). The returned `HtmlTextHandle` exposes `setText`, `setColor`, `setVisible`, `setBounds`, and `dispose`. The element is `pointer-events: none` so it never blocks clicks on the canvas or sibling buttons. |

### Shared engine helpers

The server engine factors out repeated work into a handful of small support modules consumed by the routes + `SessionBuilder`:

| Module | Responsibility |
|---|---|
| `shared/startingZones.ts` | `STARTING_ZONE_*` constants + `ZONE_LETTER` map. The single source of truth for the 0..4 GID values used by `EncounterDef.startingZones.data`. Imported by the server validation path, the deterministic compose endpoint, the client zone painter, and `SpawnHelpers.parseStartingZones`. |
| `engine/MapPersistence.ts` | `buildMapJson` (pure Tiled-shape constructor) + `writeMapJson` (writes to `server/data/maps/<id>.json`, creates dir) + `isGeneratedId` (checks the `gen_` prefix). The three map-write sites (`/generate/map/composed`, `/generate/encounter/composed`, `encounterGenerator.generateMap`) all delegate to these helpers so the file shape and tileset path live in exactly one place. |
| `engine/SpawnHelpers.ts` | `spawnNpc` (NPC-or-monster-def resolution, four dispositions including `enemy` with auto combat-label), `spawnEnemies` (legacy random-roster, only used when `enemyIds` is empty in a combat encounter), `spawnItems`, `spawnSecrets`, and the top-level `populateNpcs(out, map, defs, input)` that the route + `SessionBuilder` use to declaratively populate a fresh encounter map. |

---

## maps/

Hand-crafted encounter maps stored as **Tiled-compatible JSON** (a stripped-down subset of the format that Tiled's "Save As JSON" export produces). Maps are pure geometry — they carry the tile-GID grid, the tile palette as graphical references, and identifying metadata. They do **not** declare what tiles mean (passable, difficult terrain, trapped, cover, …). That's the encounter's job: each encounter declares, via `tileProperties`, how the GIDs in its referenced map behave for that scenario. This separation means the same map can be reused across encounters with very different mechanics (a peaceful crossing today, a flooded crossing with broken parapets next week — same `bridge.json`).

The server loads each map at startup and stores the raw GID grid(s) — a required ground layer plus an optional object layer drawn on top. The `blocksMovement: boolean[][]` and `blocksSight: boolean[][]` grids are built per-session from `map.gidGrid + map.objectGidGrid + encounter.tileProperties + tileset legend` (see [encounters/](#encounters), [tilesets/](#tilesets-1), and [`SessionBuilder.buildGameMapFromSaved`](../server/src/engine/SessionBuilder.ts)). Movement uses object-overrides-terrain (the object's flag wins when present); sight ORs the two layers (either blocks the cell).

### Fields

| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique key. Referenced by `encounters.mapId`. |
| `name` | string | Display name shown in the UI. |
| `mapdescription` | string | Prose description of the map layout, surfaced to the AIGM for spatial context. |
| `width` | integer | Grid width in tiles (Tiled convention). |
| `height` | integer | Grid height in tiles. |
| `tilesets` | object[] | Tile palette(s). See below. |
| `layers` | object[] | Tile layers. See below. |

### Tilesets

A tileset is a palette of tiles. Each tile has an id local to the tileset; its **GID** (used in layer data) is `firstgid + id`. The first tileset typically has `firstgid: 1` (GID 0 is reserved for "empty").

A tileset entry in `map.tilesets` is one of two shapes — **embedded** (palette defined inline) or **external** (palette stored in a separate `.tsj` file and referenced by path). External is the recommended shape: it lets several maps share one palette without duplication, and it's what Tiled writes by default.

#### External tileset reference (in the map file)

| Field | Type | Notes |
|---|---|---|
| `firstgid` | integer | GID assigned to the tileset's tile 0. Subsequent tiles get sequential GIDs. |
| `source` | string | Path to a `.tsj` file relative to the map file, e.g. `"../tilesets/roguelike.tsj"`. Resolved by the server at load time; the resolved tileset is inlined into the response served to the client under `GameMap.tilesets`. |

#### Embedded tileset (or the contents of an external `.tsj` file)

| Field | Type | Notes |
|---|---|---|
| `firstgid` | integer | *(map file only — not part of the standalone `.tsj`.)* |
| `name` | string | Display name (informational only). |
| `image` | string | *(optional — only present for image-based tilesets.)* Image filename relative to the tileset file, e.g. `"roguelike.png"`. The server serves the file at `GET /tilesets/{filename}` and rewrites this field to an absolute URL (`imageUrl: "/tilesets/{filename}"`) in `GameMap.tilesets[]` so the client can load it as a Phaser spritesheet. |
| `imagewidth` | integer | *(image tilesets only)* Pixel width of the source image. |
| `imageheight` | integer | *(image tilesets only)* Pixel height of the source image. |
| `tilewidth` | integer | *(image tilesets only)* Pixel width of one tile. |
| `tileheight` | integer | *(image tilesets only)* Pixel height of one tile. |
| `spacing` | integer | *(image tilesets only — default `0`)* Pixel gap between tiles in the atlas. |
| `margin` | integer | *(image tilesets only — default `0`)* Pixel border around the entire atlas. |
| `columns` | integer | *(image tilesets only)* Number of tile columns in the atlas. |
| `tilecount` | integer | *(image tilesets only)* Total number of tiles in the atlas. |
| `tiles` | object[] | *(optional)* Per-tile metadata: `{ id: integer }`. May carry Tiled-style fields like `image`, `properties` etc.; the loader ignores all of them. **No semantic fields on tiles.** Whether GID N is passable, difficult, or trapped is declared per-encounter, not here. |

Image-based tilesets render through the Phaser side: `BootScene` queues every unique tileset image as a spritesheet keyed by `tilesetTextureKey(imageUrl)`, and `GameScene.drawMapTiles` draws each tile as `this.add.image(..., key, frame)` where `frame = gid − firstgid`, applying `MAP_TILE_ALPHA = 0.7` so the dark scene background bleeds through to darken the overall map. Multi-layer maps draw the ground layer first then the object layer on top. Maps without an image tileset (e.g. procedurally generated ones) fall back to coloured fills.

### Layers

A map may carry up to two tile layers, drawn bottom-up:

1. **Ground layer** — required. Found by name `"terrain"`, or as the first tile layer if no such name exists. Every cell must reference a valid GID (no `0` gaps).
2. **Object layer** — optional. Found by name `"objects"` (or `"object"`), or as a second tile layer of any name. Drawn on top of the ground layer. A GID of `0` means "no object on this cell" — the ground tile shows through.

A cell's effective passability is `groundPassable AND objectPassable` — i.e. an impassable object (e.g. a tree, a door's wall before the door is placed) blocks even a passable ground tile, while an empty object cell (`0`) doesn't change the ground's verdict.

| Field | Type | Notes |
|---|---|---|
| `type` | string | Must be `"tilelayer"`. (Tiled also supports `"objectgroup"`, `"imagelayer"`; we ignore those for now.) |
| `name` | string | Layer name. The loader looks for `"terrain"` for the ground layer and `"objects"`/`"object"` for the optional object layer; both fall back to position-based detection if not named. |
| `width` | integer | Should match the map `width`. |
| `height` | integer | Should match the map `height`. |
| `data` | integer[] | Flat row-major array of **GIDs**, length = `width × height`. Index `y * width + x` gives the GID at tile `(x, y)`. A GID of `0` means "empty" — only valid in an object layer. |

When hand-authoring a map JSON, format the `data` array with one row of GIDs per source line — that keeps the visual shape of the map readable in code review, while staying byte-compatible with what Tiled exports.

### Minimal example — embedded palette (no image)

```json
{
  "id": "tiny",
  "name": "Tiny Room",
  "mapdescription": "Four walls, one floor tile.",
  "width": 3,
  "height": 3,
  "tilesets": [{
    "firstgid": 1,
    "name": "default",
    "tiles": [
      { "id": 0 },
      { "id": 1 }
    ]
  }],
  "layers": [{
    "type": "tilelayer",
    "name": "terrain",
    "width": 3,
    "height": 3,
    "data": [
      2, 2, 2,
      2, 1, 2,
      2, 2, 2
    ]
  }]
}
```

GID `1` = first palette tile (typically floor in this codebase by convention; consumer encounters decide), GID `2` = second palette tile (typically wall).

### Minimal example — external image tileset

A map referencing a shared Kenney-style tileset (`server/data/tilesets/roguelike.tsj`):

```json
{
  "id": "bridge",
  "name": "Narrow Bridge",
  "mapdescription": "A weathered stone bridge spans a dark gorge.",
  "width": 26,
  "height": 12,
  "tilesets": [{
    "firstgid": 1,
    "source": "../tilesets/roguelike.tsj"
  }],
  "layers": [{
    "type": "tilelayer",
    "name": "terrain",
    "width": 26,
    "height": 12,
    "data": [ /* row-major GIDs */ ]
  }]
}
```

The standalone `roguelike.tsj` file lives in `server/data/tilesets/` next to its PNG:

```json
{
  "name": "roguelike",
  "image": "roguelike.png",
  "imagewidth": 968,
  "imageheight": 526,
  "tilewidth": 16,
  "tileheight": 16,
  "spacing": 1,
  "margin": 0,
  "columns": 57,
  "tilecount": 1767,
  "tiles": []
}
```

The image is served at `GET /tilesets/roguelike.png` (the route whitelists `.png` filenames in `server/data/tilesets/`). The client loads it as a Phaser spritesheet and slices it by `tilewidth/tileheight/spacing/margin` to look up frames by `gid − firstgid`.

---

## encounters/

A flavored combination of a map and one or more NPCs, with optional AIGM instructions to set the scene. The server reads all files in this directory and serves them at `GET /encounters`.

### Fields

| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique key. |
| `title` | string | Short display title shown on the encounter card. |
| `description` | string | Short **player-facing** flavour summary shown on the Single Encounter Setup card and on the AdventureSetupScene chapter strip. Authored via the **DESCRIPTION** field in the Encounter Creator's BASIC INFORMATION tab. Long-form GM-only context lives in `customContext` (below). |
| `encounterTypes` | string[] | One or more of: `"simple_combat"`, `"exploration"`, `"social_interaction"`. Controls which systems activate (enemies, secrets, NPC spawns). |
| `mapId` | string | `id` of a `maps/` entry. |
| `npcIds` | string[] | *(optional)* `id` values from `npcs/` to spawn as **neutral** NPCs. Only spawned when `encounterTypes` includes `social_interaction`. Repeat the same id to spawn multiple of the same type. |
| `allyIds` | string[] | *(optional)* Creature ids to spawn with **ally** disposition near the player. Each id is resolved against `npcs/` first, then `monsters/`, so both named NPC defs and raw monster defs are accepted (e.g. `frightened_traveller` for a scripted character, or `guard` for a generic friendly soldier). Spawned regardless of encounter type. |
| `enemyIds` | string[] | *(optional)* Creature ids to spawn with **enemy** disposition at the enemy starting zone. Resolved like `allyIds` — NPC defs first, then monster defs. Each spawn is assigned a unique combat label (`A`, `B`, …). Spawned regardless of encounter type, so the deterministic compose-encounter flow can place hostiles in an exploration-tagged scene. When `enemyIds` is empty AND `encounterTypes` includes `simple_combat`, the engine falls back to the legacy `spawnEnemies(encounterContext.enemyCount)` random-roster path. |
| `customIntroduction` | string | *(optional)* Replaces the auto-generated introduction shown in the Introduction Overlay at encounter start. |
| `customContext` | string | *(optional)* Long-form **AIGM-only** scene context the GM reads silently — atmosphere, what NPCs know, what to gate behind checks, how the scene should resolve. Replaces the auto-generated AIGM context string. Authored via the **AIGM CONTEXT** field in the Encounter Creator's BASIC INFORMATION tab. On the wire, the editor's save / refine payload carries this slot as `aigmContext` (not `description`) so it never collides with the player-facing `description` field above. |
| `objective` | string | *(optional)* Player-facing one-line goal shown as the OBJECTIVE row at the top of the Player Panel's Quests section. When omitted, a default is derived from `encounterTypes` (combat → "Defeat the hostile creatures"; social → "Speak with the locals and resolve the situation"; exploration → "Search the area for hidden secrets"). |
| `completionFlag` | string | *(optional, but **required for non-combat encounters used as adventure chapters**)* Name of a world flag that, when set via `set_world_flag` (AIGM) or a `set_flag` trigger action, marks the encounter complete. Also seeds `GameState.encounterCompletionFlag` so the `encounter_completed` engine event fires when the flag lands (combat encounters auto-publish that event on enemy defeat regardless). Pair with a `customContext` instruction telling the AIGM to set it at the narrative resolution. |
| `generated` | boolean | *(optional)* `true` for encounters authored by the AI generator (`POST /generate/encounter`, files prefixed `gen_<timestamp>_<slug>`). Surfaces a `✦ GENERATED` badge on the Encounter Setup card. |
| `tileProperties` | object[] | Per-GID semantics for the referenced map's tiles **in this encounter**. See below. Required to make any tile passable. |
| `startingZones` | object | *(optional)* Tiled-style tile layer marking spawn regions for the player, allies, neutral NPCs, and enemies. Same dimensions as the referenced map. See below. Also serves as the fallback when `placementMode` is `"exact"` but a given entity slot has no explicit placement entry. |
| `placementMode` | `"zones"` \| `"exact"` | *(optional, default `"zones"`)* Chooses how spawn tiles are resolved. **`"zones"`** (default, legacy behaviour): each spawn is picked uniformly at random from the matching `startingZones` cells. **`"exact"`**: per-entity tile bindings in `placements[]` take precedence; entities without a binding fall back to the zone-based picker. Persisted only when set to `"exact"` — the field is omitted from JSON when `"zones"` so existing encounters stay diff-clean. Authored in the Encounter Editor's BOTTOM bar (MODE: ZONES / EXACT toggle). |
| `placements` | object[] | *(optional, consumed only when `placementMode: "exact"`)* Per-entity exact-tile bindings. Each entry is a discriminated union: `{ role: "player", x, y }` for the player (singleton), or `{ role: "ally"\|"enemy"\|"neutral", index, x, y }` for indexed slots in the encounter's `allyIds` / `enemyIds` / `npcIds` arrays (`index: 0` binds the first slot). At spawn, `SpawnHelpers.spawnNpc` honors a bound tile when it's in bounds, passable, and not already occupied; otherwise the spawn falls through to the zone-based picker so an accidentally-wall-bound placement doesn't strand the entity. Authored in the Encounter Editor by switching to EXACT mode and clicking tiles with the PLAYER / ALLY / ENEMY / NEUTRAL brush active. |
| `triggers` | object[] | *(optional)* Authored scripted events for this encounter — ambushes, reinforcements, scripted reveals. See [triggers](#triggers). |
| `factionRelations` | `Record<factionId, Record<factionId, number>>` | *(optional)* Per-encounter override for the global faction-relation matrix. Layered over `defs.factions[*].defaultRelations` at session boot — only the pairs declared here are changed. Use to express scene-specific politics (e.g. `{ "town_guard": { "bandits": 80 } }` for an encounter where the guards have been bribed). **Asymmetric**: the engine does NOT mirror the declaration to the reverse direction, and `getRelation` takes the *worse* of the two sides — so one-sided shifts produce one-sided behaviour. Authors who want a symmetric flip declare both directions. See [factions/](#factions). |

### Combat phase on session start

`GameEngine.createSession` inspects the freshly-spawned NPC list and **automatically calls `triggerCombat()`** when any NPC has `disposition === 'enemy'` and live HP. This rolls initiative, builds the turn order, sets the phase to `player_turn` (or an enemy turn) and writes a `⚔ Combat begins` entry to the event log — the player lands directly in combat as soon as they dismiss the Introduction Overlay.

The auto-trigger covers the common cases without authoring boilerplate:
- Deterministic compose-encounters with `enemyIds` set — the player explicitly painted enemy zones + picked hostile creatures, so combat begins immediately.
- AI-generated combat encounters that spawn enemies via `spawnEnemies` — previously the GM had to call `trigger_combat` on its first reply; now the engine handles it.

Encounters that want a delayed reveal (stealth / ambush) should leave the map free of `enemy`-disposition NPCs at session start. The bridge-standoff pattern is the canonical example: NPCs spawn as `neutral` and a trigger flips their disposition via `set_disposition_by_def_id` followed by `trigger_combat` when the player crosses the bridge.

### tileProperties

Each entry maps one of the map's GIDs to the semantic properties that GID should carry during this encounter. The engine honours `blocksMovement`, `blocksSight`, `cover`, and `obscurance`; SessionBuilder bakes them into per-tile arrays on `GameMap` so the Vision module + combat resolver can read them in O(1).

| Field | Type | Notes |
|---|---|---|
| `gid` | integer | GID from the referenced map's terrain layer (= the map's `firstgid + tile.id`). |
| `blocksMovement` | boolean | *(default: `false`)* Whether creatures are blocked from walking onto a tile of this GID. |
| `blocksSight` | boolean | *(default: `false`)* Whether line-of-sight is blocked by a tile of this GID. Independent of movement. |
| `cover` | string | *(optional)* SRD Cover: `"half"` (+2 AC/Dex), `"three-quarters"` (+5 AC/Dex), `"total"` (untargetable, blocks line of sight). Combat-only — sight blocking is handled by `blocksSight`. |
| `obscurance` | string | *(optional)* SRD Obscurance: `"lightly"` (Disadv on Perception sight checks, counts as Hide-eligible terrain only when combined with cover); `"heavily"` (Blinded into the tile; counts as Hide-eligible on its own). Underbrush, smoke, fog. |

**Lookup order for a GID's `blocksMovement` / `blocksSight`:**

1. The encounter's own `tileProperties` entry — explicit override.
2. The tileset's legend file (see [tilesets/](#tilesets-1)) — sensible default for tiles the encounter didn't customise.
3. `false` (does not block) — final fallback when neither source declares a value.

**Blocking + cover + obscurance baking** (`SessionBuilder.buildGameMapFromSaved`):
  - **Movement** uses object-overrides-terrain: the object GID's `blocksMovement` wins when an object is present, else the ground GID's.
  - **Sight** ORs the layers: a cell blocks sight if **either** the ground or the object GID has `blocksSight`. Stored on `GameMap.blocksSight: boolean[][]`; the Vision LOS walker stops the line on the first blocking cell.
  - **Cover/obscurance**: the **worst** declared `cover` and `obscurance` across the two layers win — so a tree (object) on grass (ground) → three-quarters cover and lightly obscured if both are declared that way. Stored on `GameMap.cover` and `GameMap.obscurance`. Cover is now purely a combat (AC) concern; it no longer doubles as the sight blocker.

So encounters only need to list GIDs whose meaning differs from the legend (e.g. an "underground passage" scenario marks GID 287 / chasm as `passable: true, transparent: true`); a GID that matches the legend default can be omitted.

Because semantics live here and not in the map, the same `bridge.json` can be reused across encounters with different tile meanings — a broken-wall scenario could mark GID 2 (normally a wall) as `passable: true`, while a flooded scenario could leave it solid.

### environment

Optional. Encounter-level environmental flags consulted by combat / vision resolvers.

| Field | Type | Notes |
|---|---|---|
| `sunlit` | boolean | *(optional)* True if the encounter is in direct sunlight. Triggers Sunlight Sensitivity (Disadv on attacks) for creatures whose `traits` include `sunlight_sensitivity`. |
| `lightLevel` | string | *(optional, default `"bright"`)* SRD baseline ambient: `"bright"` — normal sight; `"dim"` — every tile is **lightly obscured** by default (Disadv on Perception sight checks); `"dark"` — every tile is **heavily obscured** (Blinded into) by default. Darkvision steps `"dark"` → `"dim"` within the observer's range. Per-tile `obscurance` stacks (worst-of) with this baseline. Used for night, underground, fog-bound scenes. |

### Vision / Sound runtime modules

Two engine modules combine the schemas above into the SRD-faithful vision + audible-noise model:

**`server/src/engine/Vision.ts`** — line-of-sight + senses + perception resolver.
  - `canSee(state, observer, target)` walks Bresenham, accumulates the worst cover + obscurance along the line, applies the observer's senses (Darkvision steps dark→dim within range; Blindsight pierces sight requirements within its range bar Total Cover; Tremorsense pinpoints on a shared surface; Truesight pierces invisibility + concealment). Returns `{ sees, cover, obscurance, via }`.
  - `effectivePerception(basePP, vision)` applies +5 (Truesight / Blindsight / Tremorsense in range), −5 (Lightly Obscured / Darkness without Darkvision).
  - `runPerceptionSweep(ctx, hider)` rolls an opposed Perception against the hider's stored `hideDC` for every potential observer; on success clears `hidden` + `invisible` via `ConditionSystem.clearHide`.

**`server/src/engine/Sound.ts`** — noise model.
  - `emitNoise(ctx, x, y, intensity, sourceId?)` publishes a `noise` EngineEvent **and** queues a client-facing `sound_ring` GameEvent so the player sees an expanding circle on the map.
  - `registerSoundHooks(ctx)` registers a bus subscriber that breaks Hide on the source whenever intensity > whisper, then runs a Perception sweep against every hidden creature inside the audible radius.
  - Intensity tiles: `NOISE_WHISPER = 1`, `NOISE_FOOTSTEP = 2`, `NOISE_STEALTH_MOVE = 0`, `NOISE_SPEECH = 3`, `NOISE_COMBAT = 5`, `NOISE_SPELL_VERBAL = 5`. SpellSystem fires a `NOISE_SPELL_VERBAL` event on every cast whose `components.verbal` is true.

**Hide gate enforcement** ([CombatActions.doHide](../server/src/engine/CombatActions.ts)) requires Heavily Obscured tile OR every observer has ≥ three-quarters cover from the hider OR no observer present. On success, `playerHide` rolls Stealth, requires ≥ DC 15, and stores the total as `player.hideDC`. The same DC is then opposed by every subsequent Perception attempt (passive sweep or active SEARCH).

**Hide → Invisible bundling** ([ConditionSystem.clearHide](../server/src/engine/ConditionSystem.ts)) — SRD: a successful Hide grants the Invisible condition. We push both `'hidden'` and `'invisible'` together when Hide lands; both are cleared as a unit when `hideDC` is set and any of the four break-triggers fires (attack, noise > whisper, spotted, V-component spell cast). Magical invisibility (Greater Invisibility) sets only `'invisible'` without `hideDC`, so it survives those triggers.

**SEARCH action** ([ExplorationActions.doSearch](../server/src/engine/ExplorationActions.ts)) — in addition to the existing secrets sweep, the SEARCH Action now runs `Vision.runPerceptionSweep` against every hidden NPC within 6 tiles (30 ft). Spotted hiders lose their hidden + invisible flags and surface on the map.

### startingZones

When provided, `startingZones` is a Tiled-compatible tile layer with a fixed implicit "spawn zones" tileset — same shape and conventions as a [map tile layer](#maps), but the tileset GID semantics are hardcoded into the engine instead of declared in JSON:

| Field | Type | Notes |
|---|---|---|
| `width` | integer | Should match the map `width`. |
| `height` | integer | Should match the map `height`. |
| `data` | integer[] | Flat row-major array of zone GIDs, length = `width × height`. |

**Zone GIDs:**

| GID | Spawn region |
|---|---|
| `0` | No spawn here (default) |
| `1` | Player starting zone |
| `2` | Ally starting zone |
| `3` | Neutral NPC starting zone |
| `4` | Enemy starting zone |

Only passable map tiles are eligible for spawning regardless of zone GID. If no zone is defined for a role, the server falls back to default placement rules (player in the left third of the map, enemies at least 5 tiles away, etc.). Format the `data` array with one row per source line to keep the spawn-zone shape eyeball-readable in code review.

### triggers

Authored scripted events evaluated server-side via the engine event bus. Each trigger is a `WHEN <event> IF <guards> THEN <effects>` rule. Triggers are the deterministic counterpart to AIGM-driven scenes — once authored, they fire reliably regardless of LLM behaviour. Implementation lives in `server/src/engine/TriggerSystem.ts`; the bus in `server/src/engine/EventBus.ts`.

**Trigger entry:**

| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique within the encounter. Used as the dedupe key in `GameState.firedTriggerIds`. |
| `when` | object | A `WhenClause` — the event that wakes the trigger (see below). |
| `if` | object[] | *(optional)* List of `TriggerGuard` predicates. **All** must hold for the trigger to fire (logical AND). |
| `then` | object[] | Ordered list of `TriggerAction` effects; run sequentially when the trigger fires. |
| `once` | boolean | *(default `true`)* When `true`, the trigger fires at most once per session (persisted via `firedTriggerIds`). When `false`, it re-fires on every match. |

**WHEN clauses** — `event` is the discriminator; remaining fields are per-event filters (omitted = "any"):

| `event` | Filter fields | Published by | Fires when |
|---|---|---|---|
| `player_moved` | `in_area?: {x,y,w,h}`, `tile?: {x,y}`, `in_zone?: {name, cells}` | `ExplorationActions.doMove` | Player steps onto a tile matching the filter. `in_zone` fires when the entered tile is one of the named map zone's `"x,y"` cells — the cell list is resolved from `SavedMapDef.zones` at authoring time (the `TriggerEditor`'s **MAP ZONE** WHEN), so the runtime check is self-contained. |
| `npc_killed` | `defId?` | `GameEngine.killNpc` | An NPC with the matching `defId` reaches 0 HP. |
| `item_picked_up` | `defId?` | `ExplorationActions.checkItemPickup` | The player picks up an item with the matching equipment `defId`. |
| `turn_started` | `combatantId?` (`'player'` or NPC id) | `CombatFlow.enterPlayerTurn` / `NpcTurnRunners.runSingleEnemyTurn` / `runSingleAllyTurn` | A combatant's turn begins. |
| `turn_ended` | `combatantId?` | `CombatFlow.endPlayerTurn` / end of `NpcTurnRunners.runSingleEnemyTurn` / `runSingleAllyTurn` | A combatant's turn ends. |
| `combat_started` | — | `CombatFlow.doStartCombat` | Initiative has been rolled. |
| `combat_ended` | — | `CombatFlow.endCombat` | All enemies down or `end_combat` AIGM tool fired. |
| `encounter_started` | — | `EncounterLifecycle.publishEncounterStarted` (GameEngine constructor) | Fires ONCE at session boot, after every subscriber is registered. Use for intro cinematics (`show_supertitle`, `fade_screen`, opening `show_announcement`). GameEvents emitted by triggers listening on this event are buffered into the engine's startup sink and flushed onto the first WS `state_update`. |
| `encounter_completed` | — | `EncounterLifecycle` (subscribes to `combat_ended` and `flag_set`) | Fires ONCE when the encounter resolves: combat-victory with no living enemies, OR the encounter's `completionFlag` is set. Deduped — a second resolution path won't re-publish. Use for closing announcements, post-victory supertitles. |
| `damage_dealt` | `target?` | `GameEngine.applyDamageToPlayer` + `ThresholdPublisher.publishNpcDamage` | An entity took damage. |
| `hp_threshold_crossed` | `target?`, `ratio?`, `direction?` | `ThresholdPublisher.publishHpThresholdCrossings` | An entity's HP/maxHp ratio crossed 0.75, 0.5, or 0.25 (in either direction). |
| `faction_changed` | `factionId?` | TriggerSystem `adjustFactionStanding` | A faction standing was adjusted (and actually changed). |
| `flag_set` | `name?`, `value?` | `TriggerSystem.fireAction` (via `set_flag`); `GameEngine.setWorldFlag` (via AIGM `set_world_flag` tool) | A world flag was set. Both `name` and `value` are optional filters; an unset `name` matches every flag write, an unset `value` ignores the assigned value. Authored in the TriggerEditor as the `WHEN: ON FLAG` event (with the optional `whenFlagName` input as the matcher). |
| `custom` | `name` | Trigger-authored via `emit_event`; Director-emitted (`director_offer_help`, `director_apply_pressure`) | A previously fired event published this name. |

**IF guards** — short-circuit predicates over world state:

| `type` | Fields | Holds when |
|---|---|---|
| `flag_set` | `name` | `GameState.worldFlags[name]` is defined. |
| `flag_unset` | `name` | `GameState.worldFlags[name]` is `undefined`. |
| `flag_equals` | `name`, `value` | The flag's current value `===` the supplied value. |
| `hp_below` | `ratio` | `player.hp / playerDef.maxHp < ratio`. |
| `enemies_alive` | `op`, `count` | Number of living enemies satisfies the comparison (`lt` / `le` / `eq` / `ge` / `gt`). |
| `allies_alive` | `op`, `count` | Number of living allies satisfies the comparison. |
| `npcs_alive` | `defId`, `op`, `count` | Number of living NPCs with the matching `defId` satisfies the comparison. Filters by template id, not disposition — useful for guarding ambush triggers on "at least one bandit is still alive" or detecting "the boss is dead" regardless of whether they're flagged enemy / neutral / ally. |
| `phase` | `in: CombatMode[]` | The session phase is one of the listed values. |
| `faction_standing` | `factionId`, `op`, `value` | Player's standing with the faction satisfies the comparison (unknown faction → 0). |

**THEN actions:**

| `type` | Fields | Effect |
|---|---|---|
| `spawn_enemy_near_player` | `monsterId`, `minDist?` (default 3), `maxDist?` (default 8) | Spawns an enemy on a free tile at Chebyshev distance `[minDist, maxDist]` from the player. No-ops if no tile is free in range. |
| `spawn_enemy_at` | `monsterId`, `x`, `y` | Spawns at the given tile; falls back to the nearest free tile (within 6 tiles) if the target is occupied / impassable. |
| `show_log` | `message` | Pushes a `header`-styled line into the Event Log. |
| `send_aigm_message` | `message` | Appends to `GameState.pendingAigmEvents`; surfaced to the next AIGM turn under `SCRIPTED EVENTS`, then cleared. No-op when the GM is disabled (`DevMode.disableAIGM`). |
| `narrate` | `narrationId` | Picks a canned variant from `server/data/narration/{narrationId}.json` and pushes it as a header-styled log line. The picker avoids the last-used variant per id (tracked in `narrationLastUsed`). |
| `set_flag` | `name`, `value: number\|string\|boolean` | Writes `GameState.worldFlags[name]` and publishes a `flag_set` event so other triggers can fan out. The `TriggerEditor` surfaces this as the `SET FLAG` action kind; the in-editor input always writes `value: true`, suitable for the common pattern where the flag's mere presence resolves the encounter (pair with `EncounterDef.completionFlag` to end non-combat encounters from a trigger). Authors who need numeric or string values can edit the encounter JSON directly. |
| `pick_random_value` | `name`, `values: (number\|string\|boolean)[]` | Sets `worldFlags[name]` to a uniformly-random element of `values` and publishes `flag_set` (same as `set_flag`). Use to inject variety into conversation branches. Uses `Math.random()` (not the sim's deterministic `SimRng`) so re-rolls are intentionally surprising. No editor surface today; authored in JSON. |
| `set_objective` | `text: string` | Replaces the player-facing `GameState.objective` line. Lets a trigger advance the stated goal mid-scene instead of it being frozen at session start. (If a quest is active, its current step already drives the objective.) |
| `start_quest` | `questId: string` | Starts an authored quest from `defs.quests` (e.g. on `encounter_started`); the `QuestSystem` then auto-advances its steps via their `completeWhen` guards. No-op if the id is unknown or already active. See the demo encounter `demo_quest_camp.json` + quest `demo_clear_the_camp.json`. |
| `generate_mission_contract` | *(none)* | Rolls a fresh procedural mission via `server/src/mission/missionGenerator.ts`, registers it in the in-memory `MissionRegistry`, and sets five world flags the Bureau-office conversation reads to quote the contract terms BEFORE the player accepts: `mission_pending` (the generated id, `mission_gen_<uuid>`), `mission_offer_flavour` (`bandit \| goblin \| skeleton`), `mission_offer_count` (1 or 2), `mission_offer_reward_cp`, `mission_offer_reward_xp`. Also writes `mission_last_flavour` and reads it back next call to avoid rolling the same flavour twice in a row. The transition endpoint serves the registered mission instead of looking up an authored encounter when the id starts with `mission_gen_`. The composed map is materialised to a `SavedMapDef` and registered alongside; tilesets are captured once at server startup. **Persistence:** the registry is serialised into the world save as `inFlightMissions[]` so a player who quits mid-mission finds Vask's contract intact on reload. Authored in `bureau_office_chat.json`. Not surfaced in the editor. |
| `award_mission_reward` | *(none)* | Pays out the mission reward stored in `mission_offer_reward_cp` and `mission_offer_reward_xp`. Adds the cp to `player.balanceCp` with a "Received N cp (Bureau contract pay)" log line; adds xp to `player.xp` with a "+N XP" log line. After payout, drops the matching mission from the `MissionRegistry` so completed contracts don't accumulate. Used by the Bureau turn-in node. |
| `apply_condition_to_player` | `condition` | Adds a condition to the player (idempotent). Future scope: arbitrary target selectors. |
| `emit_event` | `name`, `payload?` | Publishes a `custom` event on the bus, letting one trigger cascade into others. Restricted to `custom` events — engine-canonical events (`npc_killed`, `damage_dealt`, …) cannot be forged from authored JSON. |
| `adjust_faction_standing` | `factionId`, `delta` | Adds `delta` to the player's standing with the faction (clamped to [−100, +100]); publishes `faction_changed`. |
| `record_rumor` | `id`, `text`, `salience?` (default 5) | Records a rumor into `GameState.rumors` (idempotent by `id`); publishes `rumor_propagated`. |
| `set_disposition_by_def_id` | `defId`, `disposition` (`ally\|neutral\|enemy`) | Updates every living NPC matching `defId` to the given disposition. Auto-aggros faction-mates when `enemy`. Pair with `trigger_combat` to turn a peaceful encounter hostile. |
| `set_npc_hidden` | `defId`, `hidden: boolean`, `hideDC?: number`, `revealedBy?: 'perception'\|'trigger'` | Writes the standard `hidden` condition + optional `hideDC` (default `10 + monsterDef.stealthBonus`) on every living NPC matching `defId`. Hidden NPCs are filtered out of client rendering, the Target Panel, and the AIGM combatant/neutral lists. **Reveal mode:** `'perception'` (default) — `Vision.runPassivePerceptionSweep` checks the player's effective passive Perception against `hideDC` on every move and reveals on success. `'trigger'` — the NPC is invisible to passive sweeps; only an explicit `set_npc_hidden { hidden: false }` action surfaces them, and movement walks through their tile silently (with `doMoveTo`'s BFS treating them as passable). On reveal, if the player or another NPC is occupying the revealed NPC's tile, the engine bumps the NPC to the nearest free passable tile so the cell isn't shared. **Editor surface:** the `TriggerEditor`'s `HIDE NPC` kind with DEF ID + HIDDEN toggle + REVEALED BY toggle + HIDE DC inputs. |
| `set_npc_dead` | `defId`, `corpseSearch?: { dc, successText, failureText }`, `dropInventory?: boolean` (default `true`) | Marks every NPC matching `defId` as a corpse: HP → 0, condition tag `dead` (included in `INCAPACITATING_CONDITIONS`), disposition → neutral, hidden/invisible cleared, and `inventoryIds` dropped as map items unless `dropInventory: false`. The optional `corpseSearch` payload turns the body into a one-shot SEARCH target — picked up by `ExplorationActions.doSearch` when adjacent, resolved against the same Perception roll as secrets, the payload cleared and `corpseSearched: true` set after first attempt. The AIGM CURRENT STATE corpses section tags each body `[SEARCHED]` / `[UNSEARCHED — authored loot at Perception DC X]` so the GM never double-rolls a check on a body the engine has already resolved. **Editor surface:** the `TriggerEditor`'s `KILL NPC` kind with DEF ID + DROP INVENTORY toggle + CORPSE SEARCH DC + success/failure text inputs. |
| `start_conversation` | `npcRef` (e.g. `npc_tavern_keeper`, `npc_bandit_1`), `conversationId?` | Opens the named conversation tree on the NPC. When `conversationId` is omitted the engine reads `NPCDef.conversationId` from the NPC's def — useful when an NPC has a default tree. No-op when another conversation is already active. Pair with a region trigger (e.g. `player_moved` into a small zone in front of the NPC) to auto-open dialogue when the player approaches, mirroring the click-to-talk flow without requiring a click. **Editor surface:** the `TriggerEditor`'s `OPEN CONVERSATION` kind with NPC REF + CONVERSATION ID inputs. |
| `trigger_combat` | — | Starts combat when the engine is in the `exploring` phase and at least one enemy is alive. Idempotent. |
| `award_xp` | `amount` | Grants the player XP. Used for trigger-fired story rewards (parley success, scouted clue, riddle solved) where no kill rolled it automatically. No-ops on non-positive amounts. The `TriggerEditor` surfaces this as an "AWARD XP" trigger kind with a single AMOUNT input. |
| `show_supertitle` | `text`, `durationMs?` (default 3000, max 15000) | Pushes a `supertitle` GameEvent — huge centred white serif text held for the duration, wrapping onto two lines for longer titles. Mirrors the AIGM `show_supertitle` tool. No-op when called outside an outer engine call (i.e. no `eventSink`), except during `encounter_started` where the engine routes events into a startup buffer. |
| `show_announcement` | `text`, `durationMs?` (default 3500, max 15000), `mode?` (`'focused'` (default) or `'unfocused'`) | Pushes an `announcement` GameEvent — centred attention-grabbing card — AND appends the text to the Event Log so the message persists after the visual fades. **`focused`** draws an orange-bordered card AND triggers the player-control-loss flow on the client (Player Panel / Target Panel / HUD fade out before the card appears and fade back in after it leaves, world tick paused via `WorldPause`, player movement / actions locked). **`unfocused`** draws a borderless edge-fading card and leaves the UI / world / input alone. Mirrors the AIGM `show_announcement` tool. |
| `npc_speaks` | `entity` (`player` or `npc_<id>` / `enemy_A` / `ally_A`), `text` | Pushes a `npc_speech` GameEvent — short bubble above the entity's token for ~6 s. Mirrors the AIGM `npc_speaks` tool. No-op when the entity ref doesn't resolve. |
| `fade_screen` | `mode` (`'in'`, `'out'`, or `'dim'`), `durationMs?` (default 1200, max 10000) | Pushes a `screen_fade` GameEvent. `out` → opacity 1 (full black); `in` → opacity 0 (clear); `dim` → opacity 0.5 (50% black overlay; world still visible underneath; pointer events still pass through). The overlay is sticky — pair every darkening fade (`out` or `dim`) with a later `in`. Mirrors the AIGM `fade_screen` tool. |
| `set_long_rest` | — | Sets `EncounterDef.allowsLongRest = true` on the live `GameState` and republishes `availableActions`, so the Player Panel's `☾ LONG REST` button appears for the remainder of the encounter. Used to unlock rest mid-encounter once a safe area is reached (e.g. the player crosses into a cleared safehouse / camp). The `TriggerEditor` surfaces this as the `SET LONG REST` action kind with no extra config. Idempotent — re-fires no-op when long rest is already permitted. |

**Load-time validation warnings** (in [TriggerSystem.validateTrigger](../server/src/engine/TriggerSystem.ts)) fire `console.warn` lines for common authoring slips so missing reverse-mapping is caught on session start rather than silently at runtime:

- `flag_set` trigger with no `when.name` filter — the wildcard semantics are almost always an authoring slip (every other flag write in the same encounter would also ping the listener). Add `when.name` to scope it.
- `set_disposition_by_def_id` / `set_npc_hidden` / `set_npc_dead` whose `defId` is not in `state.npcs` — usually a typo, a defId moved between `allyIds` / `enemyIds` / `npcIds`, or a creature that failed to spawn. The action would no-op at runtime.
- `npc_speaks` whose `entity` matches the slot-ref pattern (`enemy_1`, `neutral_2`, `ally_3`) — slot refs never resolve at runtime; use the NPC instance id (`npc_<defId>` for singletons, `npc_<defId>_<n>` for duplicates) instead. The `encounterRefiner` AI flow also rewrites slot refs in `npc_speaks.entity` to instance ids via the shared `spawnInstanceIds` helper.

**Spawn-time naming** (in [shared/spawnInstanceIds.ts](../shared/spawnInstanceIds.ts)) — single source of truth for the per-defId dedup that turns `npcIds: ["bandit", "bandit"]` into runtime instance ids `bandit_1` and `bandit_2`. Exposes `totalSpawnCount(defId, lists)`, `spawnOrdinalForSlot(role, index, lists)`, and `instanceIdForSlot(role, index, lists)`. Consumed by both `SpawnHelpers.populateNpcs` at spawn time and `encounterRefiner.ts` at refine time so the algorithm never drifts between the two readers. Walk order is **ally → enemy → neutral** with a global per-defId counter; a defId appearing once across all three arrays gets the bare defId as its instance id, and multiple instances get `${defId}_${ordinal}` (1-based).

**Editor round-trip preservation.** The `TriggerEditor` only knows how to render a fixed set of action kinds (PERCEPTION / LOG / AIGM CUE / START COMBAT / AWARD XP / ANNOUNCE / SPEECH / FADE / SET FLAG / SET LONG REST / HIDE NPC / KILL NPC / OPEN CONVERSATION); the underlying `EncounterTrigger.then[]` can contain any action type. To keep editor saves from silently dropping hand-authored triggers the UI doesn't model, `/generate/encounter/update` runs each existing trigger through an `isEditorExpressible` check: every action's type must be in the editor-expressible set AND any `player_ability_check` must use the `perception` skill. Triggers that pass are replaced wholesale by the expanded editor output; triggers that fail are preserved verbatim and concatenated in front of the editor's expansion. Authors can edit modern-trigger encounters in the UI without losing actions the chip strip can't author.

**Hook ordering** is load-bearing in a few places:

- `player_moved` is published **before** the combat-start proximity check, so an `enter_area` trigger that spawns enemies near the player kicks off combat on the same tile entry.
- `npc_killed` is published **before** `autoEndCombatIfNoEnemies`, so a kill-triggered reinforcement spawn prevents combat from ending.
- `set_flag` publishes `flag_set` synchronously, so a trigger keyed on a flag the same trigger sets will not re-fire itself (its own `firedTriggerIds` entry is already pending).

**Example — guard-room ambush in `encounters/dungeon_delve.json`:**

```json
"triggers": [
  {
    "id": "guardroom_ambush",
    "when": { "event": "player_moved", "in_area": { "x": 3, "y": 12, "w": 6, "h": 3 } },
    "if": [
      { "type": "flag_unset", "name": "guardroom_cleared" }
    ],
    "then": [
      { "type": "narrate", "narrationId": "skeleton_rises" },
      { "type": "spawn_enemy_near_player", "monsterId": "skeleton", "minDist": 2, "maxDist": 4 },
      { "type": "spawn_enemy_near_player", "monsterId": "skeleton", "minDist": 2, "maxDist": 4 },
      { "type": "set_flag", "name": "guardroom_seen", "value": true },
      { "type": "send_aigm_message", "message": "Two skeletons rise from the rubble of the guard room and lurch toward the party." }
    ],
    "once": true
  }
]
```

---

## narration/

Canned-text variants for narratable engine moments. The `narrate(narrationId)` trigger action picks one per fire, avoiding the previously-used variant when more than one exists — so deterministic scenes feel different across plays without invoking the generative GM. Read by `NarrationSystem.pickNarrationVariant` and tracked in `GameState.narrationLastUsed`.

### Fields

| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique key — matches the `narrationId` referenced from trigger `narrate` actions. |
| `variants` | string[] | One or more candidate strings. Each fire picks an index from those NOT used last time (or the single entry if `variants.length === 1`). |
| `weights` | number[] | *(optional)* Parallel array to `variants` giving per-variant relative weights. When omitted, picks are uniform; when present, picks roulette-wheel sample with the weights, scoped to the eligible (non-last-used) subset. |

---

## adventures/

Authored strings of encounters that share cross-chapter state. Each adventure is one JSON file in `server/data/adventures/` served via `GET /adventures`. The chapter sequence is linear by default; optional `unlockedBy` guards on individual chapters enable soft branching.

### Fields

| Field | Type | Notes |
|---|---|---|
| `id` | string | Stable short slug. |
| `title` | string | Display title (adventure cards, intro overlay, AIGM context). |
| `description` | string | One-paragraph blurb shown on the adventure card. |
| `introduction` | string | Optional opening prose; carried into chapter 1's intro overlay. |
| `chapters` | object[] | Ordered list of `AdventureChapter` (see below). |
| `restEncounterId` | string | *(optional)* Reference to an existing `EncounterDef.id`. When set, the Wrap Up Loose Ends overlay between chapters offers a "Rest Stop" branch — the player is taken to this encounter (typically a tavern / safehouse / camp) with their cross-chapter state intact, then advances to the next chapter when they leave. Omit to disable the rest stop. |

### `AdventureChapter`

| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique within the adventure. Used as the save-file dedupe key. |
| `title` | string | Display title (chapter card, chapter-complete overlay, AIGM context). |
| `encounterId` | string | Reference to an existing `EncounterDef.id`. The chapter reuses that encounter wholesale; only the cross-chapter seed differs. |
| `unlockedBy` | object | *(optional)* `{ flag_set: name }` or `{ flag_equals: { name, value } }` — gates the chapter on a world flag set in an earlier chapter. |
| `completionFlag` | string | *(optional)* When this `worldFlag` is set, the chapter is marked complete (in addition to the default combat-ended detection). **Required for non-combat chapters** — without it, social and exploration chapters have no built-in resolution condition and the player gets stuck. Pair it with an instruction in the encounter's `customContext` that tells the AIGM to call `set_world_flag` with the matching name at the right narrative moment. Combat chapters can omit it and rely on the default combat-ended detection. |

### Save layer — `saves/{characterId}_adventure.json` (`AdventureSave`)

Persists cross-chapter state. Created on `POST /adventure/start`, updated on each `POST /adventure/:characterId/advance`, retrievable via `GET /adventure/:characterId`.

| Field | Type | Notes |
|---|---|---|
| `characterId` | string | The player def id this save belongs to. |
| `adventureId` | string | Which adventure is in progress. |
| `currentChapterIndex` | integer | Index into `AdventureDef.chapters` for the chapter currently in progress (or just completed). |
| `completedChapterIds` | string[] | Ids of chapters that have been completed. |
| `worldFlags` | object | Snapshot of cross-chapter world flags. Seeds `GameState.worldFlags` when each chapter session starts. |
| `quests` / `runtimeQuestDefs` | array | *(optional)* Adventure/world-scope quests (+ any runtime quest defs they reference) carried between chapters. Captured from the finished chapter's state on advance; seeds `GameState.quests` at the next chapter's boot. Encounter-scope quests are dropped at the chapter boundary. |
| `factionStandings` | object | Snapshot of player reputations. Seeds `GameState.factionStandings`. |
| `rumors` | object[] | Snapshot of long-term world memory. Seeds `GameState.rumors`. |
| `priorChapterSummaries` | object[] | `{ chapterId, chapterTitle, summary }[]` — 2-sentence Haiku-generated summaries appended on each chapter advance. Surfaced to the GM in CURRENT STATE under `PRIOR CHAPTERS`. |
| `inRest` | boolean | *(optional)* `true` while the player is playing the adventure's `restEncounterId` between chapters. Set by `POST /adventure/:characterId/rest` when the Rest Stop branch is taken from the Wrap Up overlay; cleared on the next `POST /adventure/:characterId/advance`. While `true`, the rest session reuses the same `AdventureSave` (cross-chapter state, faction standings, rumors) but does NOT advance `currentChapterIndex`. |

### Example — `adventures/the_long_road.json`

```json
{
  "id": "the_long_road",
  "title": "The Long Road",
  "description": "Word reached the capital of strange happenings to the west…",
  "introduction": "You set out west with little more than your gear…",
  "chapters": [
    { "id": "ch1_bridge", "title": "Chapter 1 — The Toll", "encounterId": "bridge_standoff" },
    { "id": "ch2_dungeon", "title": "Chapter 2 — Beneath the Stones", "encounterId": "dungeon_delve" },
    { "id": "ch3_sage", "title": "Chapter 3 — Counsel", "encounterId": "sages_counsel" }
  ]
}
```

---

### Example — `narration/skeleton_rises.json`

```json
{
  "id": "skeleton_rises",
  "variants": [
    "Bones scrape against stone — skeletal figures haul themselves up from the rubble, jaws clattering in unison.",
    "The pile of bones in the corner shifts. Yellowed ribs and skulls knit together, eye-sockets fixing on the party.",
    "A dry rattle echoes off the chamber walls. Two skeletons rise from the debris, blades scraping free of dust.",
    "Old marrow cracks. Two skeletons unfold from beneath the rubble like grim pages opening, hollow-eyed and slow."
  ]
}
```

### Example — `encounters/bridge_standoff.json`

```json
{
  "id": "bridge_standoff",
  "encounterTitle": "Bridge Toll",
  "description": "A pair of bandits blocks a narrow stone bridge...",
  "encounterTypes": ["social_interaction"],
  "mapId": "bridge",
  "npcIds": ["bridge_bandit", "bridge_bandit"],
  "allyIds": ["frightened_traveller"],
  "customIntroduction": "You and a nervous traveller stand at the near end...",
  "customContext": "Two bandits block the bridge. If the player refuses to pay, call set_disposition on both...",
  "startingZones": {
    "width": 26,
    "height": 12,
    "data": [
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 3, 3, 3, 3, 0,
      0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 3, 3, 3, 3, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
    ]
  }
}
```

---

## saves/

Runtime save files written by the server after every player action. These are not hand-authored — they are created automatically when a session starts or a character is first used. They live alongside the data files and are excluded from the repository.

Three save files coexist:

| File | Scope | Lifetime |
|---|---|---|
| `saves/{characterId}.json` | Persistent per-character (HP / XP / gold / inventory / equipped slots / spell slots / class-feature resources / encounter log / storylog). | Carries across encounters and adventures. Deleted via `DELETE /save/:characterId`. |
| `saves/world.json` | Active session — current map, NPC positions, combat state, world flags, faction standings, rumors, narration anti-repeat memory, AIGM history. | One per running session. Deleted on `NEW ENCOUNTER` or when a chapter advances. |
| `saves/{characterId}_adventure.json` | Per-character adventure progress (chapter index, completed chapter ids, cross-chapter `worldFlags` / `factionStandings` / `rumors`, prior-chapter summaries). See the [adventures/](#adventures) section above. | Created on `POST /adventure/start`; survives chapter transitions and reloads; deleted via `DELETE /adventure/:characterId` (also wiped when the player presses DELETE SAVE on either Setup scene). |

### Character save — `saves/{characterId}.json`

Stores the persistent player state that carries across encounters. Written after every action; deleted via `DELETE /save/:characterId`. The read route `GET /save/:characterId` returns `null` when the file is missing (rather than fabricating a default), so the encounter-setup UI can distinguish "no save exists" from "fresh save" and reset the card accordingly.

| Field | Type | Notes |
|---|---|---|
| `playerDefId` | string | The character `id` this save belongs to. |
| `hp` | number | Current hit points. |
| `xp` | number | Total experience points earned. |
| `gold` | number | Gold pieces carried. |
| `inventoryIds` | string[] | Item `id` values currently in inventory. Repeated entries represent stacks. |
| `resources` | object | *(optional)* Per-feature resource pools (e.g. `{ "second-wind": 2 }`). Keyed by feature id. Refilled to `feature.resource.max` on Long Rest (= new encounter) when a fresh session seeds from `defaultFeatureIds`. |
| `equippedSlots` | object | `{ armorId, weaponId, shieldId }` — currently equipped items. |
| `spellSlots` | number[] | *(optional, caster-only)* Current remaining spell slots by level − 1. Carries across encounters; refilled on Long Rest (= new encounter). |
| `preparedSpellIds` | string[] | *(optional, caster-only)* Currently prepared spells. Mutable on Long Rest. |
| `encounterLog` | object[] | *(optional)* Raw record of every completed encounter, newest first. Each entry contains `id`, `timestamp`, `description`, `encounterTitle`, `xpGained`, `goldGained`, `outcome`, and `lines` (ordered log lines of type `combat`, `dm_player`, or `dm_reply`). Written when a session ends via `DELETE /game/session/:id`. |
| `storylog` | object[] | *(optional)* AI-generated narrative entries keyed by `encounterId`. Each entry contains `encounterId` and `narrative` (prose string). Generated on demand by `POST /save/:characterId/storylog` via `server/src/storylog.ts` using Claude Sonnet; only missing entries are generated — existing entries are never overwritten unless `?rewrite=true` is passed. |

### World save — `saves/world.json`

Stores the full encounter state so the player can resume mid-encounter. This file is deleted when the player starts a new encounter. The `GET /world` endpoint also returns `gmHistory` (the AIGM conversation history for the session), which is kept in server session memory and restored to the client on reconnect.

Key runtime fields of note:

| Field | Notes |
|---|---|
| `npcs[].id` | Generated at spawn as `{defId}_{index}` (e.g. `villager_0`). The AIGM entity ref is `npc_{id}` (e.g. `npc_villager_0`). |
| `npcs[].combatLabel` | Single uppercase letter (A, B, C…) assigned when the NPC enters combat or is spawned as an enemy. Empty string for neutral NPCs that have not yet entered combat. Rendered in the centre of the token circle during combat. Shared letter pool across enemies and allies. |
| `npcs[].revealedName` | *(optional)* The name an NPC disclosed in conversation, set by the `reveal_npc_name` AIGM tool. Replaces the generic name displayed above the map token and is shown as `(known as: X)` in the AIGM CURRENT STATE. |
| `npcs[].combatPassive` | *(optional)* When `true`, the ally skips their combat turn (set via the `set_npc_passive` AIGM tool). Used when the player instructs an ally to stand down. Reversed by calling the tool with `passive: false`. |
| `npcs[].inventoryIds` | Items held by each NPC (string `id` values from `equipment/`). Populated when a thrown item hits the creature; each item is moved to `mapItems` at the creature's tile when it dies, making it recoverable. |
| `npcs[].hp` | When `hp` reaches 0 the NPC is treated as a corpse: it remains in the `npcs` array, stays on the map at 40% opacity, and is excluded from combat turns, movement AI, ability check triggers, and all AIGM state sections except CORPSES. `inventoryIds` is cleared and `isActive` is set to `false` on death. The `isDead(npc)` helper (`ConditionSystem.ts`) is the canonical "is this a corpse" check across the engine — true when `hp <= 0` OR when `conditions` includes `dead`. |
| `npcs[].conditions` | Active conditions on the NPC. `dead` is a member of `INCAPACITATING_CONDITIONS` so every condition-aware gate (turn skipping, AOE saving-throw exclusion, perception sweeps) treats corpses uniformly. Set by `set_npc_dead`; also implied whenever `hp <= 0`. |
| `npcs[].hideDC` | *(optional)* SRD Stealth roll total recorded when the creature took the Hide action — opposed by every subsequent Perception attempt (passive sweep or active SEARCH). Also set by `set_npc_hidden` for authored hidden NPCs (defaults to `10 + monsterDef.stealthBonus`). |
| `npcs[].revealedByTrigger` | *(optional)* When true, the passive Perception movement-sweep skips this NPC — only an explicit `set_npc_hidden { hidden: false }` reveal surfaces them. Used for narrative reveals (the dead rising, a wall sliding open). Movement walks through their tile silently; on reveal the engine bumps the NPC to the nearest free tile if the player happens to share their cell. Set via `set_npc_hidden` with `revealedBy: 'trigger'`. |
| `npcs[].corpseSearch` | *(optional)* `{ dc, successText, failureText }`. One-shot payload picked up by `ExplorationActions.doSearch` when the player presses SEARCH adjacent to the corpse; resolves against the same Perception roll as secrets and is cleared after first attempt. Attached at spawn time via the `set_npc_dead` trigger action. |
| `npcs[].corpseSearched` | *(optional)* Set true once the deterministic SEARCH action has resolved this corpse. Read by the AIGM CURRENT STATE corpses section, which tags the body `[SEARCHED]` so the GM doesn't roll a second Perception check on the same body (see the [Searching corpses rule](../AIGM.md#searching-corpses-rule) in `AIGM.md`). |
| `npcs[].initiativeRoll` | *(optional)* The combatant's d20 + initiativeBonus total for the current combat. Set at `doStartCombat` (with Disadvantage if Surprised, Advantage if Invisible). Cleared on `endCombat`. Used as the sort key for `turnOrderIds`. |
| `npcs[].reactionUsed` | Per-creature Reaction tracker. Set `true` when the NPC spends its Reaction (e.g. an Opportunity Attack against the player or another NPC). Reset to `false` at the *start of that NPC's own turn* (in `runSingleEnemyTurn` / `runSingleAllyTurn`) — never on the player's turn. Mirrors `player.reactionUsed` for the player. Surfaced to the AIGM CURRENT STATE as `Reaction: AVAILABLE`/`USED` on each combatant line while combat is active. |
| `player.initiativeRoll` | Same idea for the player: d20 + DEX mod, set at combat start, cleared at combat end. |
| `player.freeObjectInteractionUsed` | SRD "one free object interaction per turn" tracker. Set when the player equips/unequips a weapon or shield during `player_turn`. Reset by `enterPlayerTurn`. Once set, a second swap that turn requires the Utilize action and consumes `actionUsed`. |
| `player.attacksRemaining` | SRD Extra Attack (US-119): follow-up weapon attacks still available in the current Attack action. The first attack of the action (in `applyAttackOutcome`) sets `actionUsed` and reserves `attacksPerAction(playerDef) - 1` here (driven by the class `extra-attacks` track); each follow-up draws it down without spending another Action. `canAttackTarget` / `doAttack` permit a follow-up while it's > 0. Reset to 0 by `enterPlayerTurn`. |
| `turnOrderIds` | Initiative-sorted list of combatant ids: `'player'` plus each NPC `id`. Sort key is `initiativeRoll` (descending), tiebreak by DEX mod / `initiativeBonus`. Iterated by `advanceTurn`; dead combatants are skipped at iteration time (entries are NOT removed when a combatant dies — removing them mid-iteration would shift indices). |
| `activeNpcIndex` | Index into `turnOrderIds` pointing at the combatant currently taking their turn. The HUD turn-order bar reads `turnOrderIds` and highlights the chip whose corresponding combatant has `isActive === true` (NPCs) or whose entry is `'player'` and `phase === 'player_turn'` / `'death_saves'`. |
| `pendingReaction` | *(optional, top-level on `GameState`)* When set, the engine has paused the turn loop on a reaction-eligible trigger and is awaiting a `resolveReaction { accept }` action from the player. Cleared by `doResolveReaction` after applying (or skipping) the deferred effect. Three shapes: `{ kind: 'opportunity_attack', npcId, npcName }`, `{ kind: 'readied_attack', npcId, npcName }` (US-057 Ready — an enemy closed into the player's reach; accept fires the readied melee strike, decline keeps the reservation), and `{ kind: 'shield', attackerId, attackerName, incomingDamage, attackTotal, shieldedAc }`. While set, `advanceTurn` early-returns. |
| `triggers` | *(top-level on `GameState`)* Authored encounter triggers seeded from `EncounterDef.triggers` at session creation. Static across the session — never mutated at runtime. |
| `firedTriggerIds` | *(top-level on `GameState`)* String ids of triggers that have already fired. Consulted by `TriggerSystem.evaluateTriggers` to enforce `once: true` semantics. Persisted in `world.json` so one-shot triggers stay one-shot across save/load. |
| `pendingAigmEvents` | *(top-level on `GameState`)* Scripted-event lines queued by `send_aigm_message` trigger actions. Rendered into the next AIGM CURRENT STATE block under `SCRIPTED EVENTS`, then cleared after the AIGM reply lands. |
| `worldFlags` | *(top-level on `GameState`)* `Record<string, number\|string\|boolean>` written by `set_flag` trigger actions and read by `flag_set` / `flag_unset` / `flag_equals` guards. Persisted with the world save so authored scripts can branch on history across save/load. |
| `quests` / `runtimeQuestDefs` | *(top-level on `GameState`)* Structured quests. `quests: QuestState[]` (status active/completed/failed, `currentStepId`, `completedStepIds`); `runtimeQuestDefs: QuestDef[]` holds the definitions of AIGM-created quests so they survive reload. A **`QuestDef`** (`shared/types/quests.ts`) is an ordered list of `steps`, each with a player-facing `text`, an optional `completeWhen: TriggerGuard[]` (reuses the trigger-guard vocabulary), an optional `xpReward`, an optional `optional: boolean`, and optional `onComplete: TriggerAction[]`; plus quest-level `xpReward` / `failWhen` / `onComplete` / `onFail` and a `scope` (`encounter`/`adventure`/`world`). The non-`optional` steps form the ordered **spine** that drives the objective and quest completion; an **`optional` step** is a bonus side-goal evaluated every tick regardless of the current step — it completes (granting its XP + firing `onComplete`) the moment its guard holds, in any order, and never advances the spine, drives `GameState.objective`, or finishes the quest. Use optional steps to make a bonus discovery's XP a visible goal without forcing player order (e.g. the Reach Circuit's two sanctum finds). The **`QuestSystem`** (`server/src/engine/QuestSystem.ts`, registered in the engine hook list) subscribes to the bus and auto-advances the active spine step via the shared `guardHolds` evaluator (and completes any ready optional steps), granting **XP only** (no gold/items — by design) and firing effects via `fireAction`; the active spine step's text drives `GameState.objective`. Authored quests load from a setting's `quests/*.json` into `defs.quests`; the AIGM starts/advances them with `start_quest` / `advance_quest` / `complete_quest` / `fail_quest`. Persisted with the world save; adventure/world-scope quests also carry across chapters via `AdventureSave.quests` / `runtimeQuestDefs`. |
| `narrationLastUsed` | *(top-level on `GameState`)* Per-`narrationId` last-picked variant index. Used by `NarrationSystem.pickNarrationVariant` to avoid back-to-back repeats. Persisted so reloads don't reset anti-repeat memory mid-encounter. |
| `factionStandings` | *(top-level on `GameState`)* `Record<string, number>` of player reputation with each faction (−100..+100). Written by the `adjust_faction_standing` AIGM tool and trigger action; read by the `faction_standing` guard. Unknown factions default to 0. |
| `rumors` | *(top-level on `GameState`)* `Rumor[]` of significant world events the world "remembers." Each entry has `id` (stable dedupe key), `text`, `salience` (1–10), `recordedAt` (Date.now). Surfaced to the GM in CURRENT STATE under the `RUMORS` block; appended idempotently by the `create_rumor` AIGM tool and `record_rumor` trigger action. |
| `worldFlags['director:*']` | *(reserved key prefix)* The Director (`Director.ts`) tracks per-encounter round counts and "already-fired" flags under reserved keys (`director:round`, `director:assist_fired`, `director:pressure_fired`). Reset at every `combat_started`. Triggers can safely set their own `worldFlags` outside this prefix. |
| `adventureContext` | *(top-level on `GameState`, optional)* When set, the current session is a chapter of an adventure. Carries `{ adventureId, adventureTitle, chapterId, chapterTitle, chapterIndex, totalChapters, priorChapterSummaries, completionFlag? }`. Null for single-encounter sessions. Drives the END CHAPTER overlay and the AIGM CURRENT STATE `ADVENTURE:` / `PRIOR CHAPTERS:` blocks. |
| `encounterComplete` | *(top-level on `GameState`)* `true` once the active encounter has resolved. One-way — set by `EncounterProgress.ts` subscribers, never cleared mid-session. Three flip paths: (a) the `encounter_completed` lifecycle event from `EncounterLifecycle.ts` (combat-ended with no enemies OR `completionFlag` was set), unconditional so single-encounter sessions also surface a completion overlay; (b) `combat_ended` directly when no enemies remain; (c) `flag_set` whose name matches the adventure chapter's `completionFlag` (adventure-only). The client opens the "Wrap Up Loose Ends" overlay (`EncounterCompleteOverlay.ts`) once when this flips true; dismissing the overlay reveals the persistent NEXT CHAPTER / RETURN TO MENU button. Legacy save-shape carry-over: older world saves stored this as `chapterComplete` — `loadWorldSave` reads either spelling. |
| `encounterCompletionFlag` | *(top-level on `GameState`, optional)* The world-flag name that — when set — should publish the `encounter_completed` engine event for **standalone** (non-adventure) encounters. Seeded at session creation from `EncounterDef.completionFlag` (or from `adventureContext.completionFlag` when present). Used by `EncounterLifecycle.ts` to fire the lifecycle event off either a `combat_ended` with no living enemies OR a `flag_set` whose name matches this string. Encounter authors set the flag via `set_world_flag` (AIGM tool) or a `set_flag` trigger action at the narrative resolution. |
| `objective` | *(top-level on `GameState`)* Player-facing one-line objective for the current encounter. Sourced from `EncounterDef.objective` when set, otherwise derived from `encounterTypes` by `encounterService.defaultObjective`. Rendered as the OBJECTIVE row at the top of the Player Panel's Quests section. |
| `traps` | *(top-level on `GameState`)* `TrapState[]` — concealed tile traps for the current encounter (see [Traps & Area-Denial Gear](#traps--area-denial-gear)). Seeded from `EncounterDef.traps` by `SessionBuilder`; mutated at runtime (discovered / disarmed / sprung) by `TrapSystem.ts`. Persisted in `world.json` (loader backfills `[]` for older saves). |
| `aigmHistory` | The **sliding-window** AIGM conversation persisted into `world.json` (serialised from server session memory). Bounded to ~20 verbatim messages plus an optional leading `[SUMMARY OF EARLIER TURNS]` assistant message that collapses anything older. `[CURRENT STATE]` prefixes are stripped from historical user messages before each API call so the model always reasons from the current injected state, not stale snapshots. The `GET /world` response surfaces this under the `gmHistory` field for client-side display. |

### Traps & Area-Denial Gear

Two distinct hazards, both authored as data and resolved by `server/src/engine/TrapSystem.ts`. SRD basis: detect/understand traps — Wisdom (Perception) / Intelligence (Investigation); disarm with Thieves' Tools — DC 15 Dexterity (Sleight of Hand) (`06_Equipment/.../Tools.md`, Rogue L1); caltrops / ball bearings — `06_Equipment/.../Adventuring_Gear.md`.

**1. Concealed traps** (`GameState.traps: TrapState[]`).

| Field | Notes |
|---|---|
| `TrapState` | `{ id, name, tileX, tileY, armed, discovered, detectDC, disarmDC, trigger, triggeredMessage?, tintHex? }`. `armed` is false once disarmed or sprung (an inert trap never fires again). `discovered` flips true on detection; the client only renders discovered traps. |
| `TrapState.trigger` (`TrapTrigger`) | `{ saveAbility, saveDC, damageDice, damageSides, damageBonus, damageType, halfOnSave, condition? }`. On spring: roll `saveAbility` vs `saveDC`; deal `damageDice`d`damageSides`+`damageBonus` (half on save when `halfOnSave`); apply `condition` on a failed save. |
| `EncounterTrapDef` | Authoring shape on `EncounterDef.traps` (and `CreateSessionRequest.traps`): `{ id, name, x, y, hidden?, detectDC, disarmDC?, trigger{ saveAbility?, saveDC, damageDice, damageSides, damageBonus?, damageType, halfOnSave?, condition? }, triggeredMessage?, tintHex? }`. `SessionBuilder` maps each to a `TrapState` — `armed: true`, `discovered: hidden === false`, `disarmDC` defaults to **15**, `saveAbility` to **dex**, `halfOnSave` to **true**. |

Detection / disarm flow: `ExplorationActions.doMove` calls `checkTrapTriggers` (spring on step) then `runPassiveTrapDetection` (auto-spot within ~10 ft when passive Perception ≥ `detectDC`); `doSearch` calls `detectAdjacentTraps` (active Perception roll vs adjacent traps); the `disarmTrap` player action → `doDisarmTrap` rolls Dexterity (Sleight of Hand) vs `disarmDC` with **Advantage when `thieves_tools` is in inventory**, botch (miss by 5+) springs the trap.

**2. Area-denial gear → zones.** A `GearDef.areaDenial` block makes a piece of gear deployable. The `deployGear` player action → `TrapSystem.doDeployGear` consumes one unit and pushes an `ActiveZone` (the **same primitive spells use** — so it renders like a spell effect and appears in tile-info `effects`).

| Field | Notes |
|---|---|
| `GearDef.areaDenial` (`AreaDenialDef`) | `{ zoneName, sizeFeet, rangeFeet, enterSave{ ability, dc }, condition?, enterDamage?{ amount, type }, durationRounds, tintHex? }`. `sizeFeet` is the side of the square area (5 = one tile); `rangeFeet` is placement reach. |
| `ActiveZone.enterDamage` | *(new, optional)* `{ amount, type }` — flat damage applied alongside `condition` on a failed `enterSave`. Caltrops use `{ amount: 1, type: 'piercing' }`; resolved for the player in `tickZoneEnterSaves` (via `applyDamageToPlayer`) and for NPCs in `NpcTurnRunners.applyZoneStepEffects`. |
| `hobbled` condition | *(new, in `ConditionSystem`)* Speed 0 (member of `SPEED_ZERO_CONDITIONS`) **and** turn-scoped (member of `TURN_CONDITIONS`, cleared at the start of the creature's next turn) — models caltrops' "Speed 0 until the start of its next turn." |

Shipped gear: `caltrops` (DC 15 DEX → 1 piercing + `hobbled`), `ball_bearings` (DC 10 DEX → `prone`), plus `crowbar`, `rope`, `hooded_lantern`, and `thieves_tools` (the disarm-advantage item). `AvailableActions` gains `disarmableTrapTiles: {x,y}[]` and `deployableGearIds: string[]`, computed in `GameEngine.computeAvailableActions` and gated by reach + action economy (Disarm and Deploy both cost the Action in combat).

### Session-only AIGM state (in-memory)

These are kept in server session memory only — not persisted to disk — and reset if the server restarts:

| Field | Notes |
|---|---|
| `aigmArchive` | The **full, unsummarized record** of every user/assistant exchange this session. Used exclusively by the `recall_memory` tool for case-insensitive substring lookups. Separate from `aigmHistory` so summarisation doesn't erase searchable content. |
| `aigmBusy` | Boolean mutex flag. While true, the `/aigm` route returns HTTP 429 for concurrent requests on the same session. Released in a `finally` block. |

---

## Cross-references

| Referencing field | Must match |
|---|---|
| `characters.speciesId` | `species/{id}.json` |
| `characters.backgroundId` | `backgrounds/{id}.json` |
| `characters.featIds[]` | `feats/{id}.json` |
| `characters.defaultEquipment.*Id` | `equipment/{id}.json` |
| `characters.defaultInventoryIds[]` | `equipment/{id}.json` |
| `backgrounds.feat.id` | `feats/{id}.json` |
| `npcs.monsterClass` | `monsters/{id}.json` |
| `encounters.mapId` | `maps/{id}.json` |
| `encounters.npcIds[]` | `npcs/{id}.json` |
| `encounters.allyIds[]` | `npcs/{id}.json` or `monsters/{id}.json` |
| `encounters.enemyIds[]` | `npcs/{id}.json` or `monsters/{id}.json` |
| `saves.playerDefId` | `characters/{id}.json` |
| `saves.inventoryIds[]` | `equipment/{id}.json` |
| `saves.equippedSlots.*Id` | `equipment/{id}.json` |
