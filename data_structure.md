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
└── species/            # SRD player species (Dragonborn, Dwarf, Elf, …)
```

---

## characters/

One file per playable character. Defines identity, ability scores, class features, and default loadout. Several fields are **not stored in the JSON** — they are computed at runtime in this order:

1. `applySpecies` — reads `speciesId` + `speciesLineage` from `species/` to derive `speed`
2. `applyFeats` — reads `featIds` from `feats/` to derive `savageAttacker` and `fightingStyleDefense`
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
| `featIds` | string[] | Ordered list of feat `id` values from `feats/`. Processed by `applyFeats` to set `savageAttacker` and `fightingStyleDefense`. |
| `level` | number | Character level. Determines Hit Dice count. |
| `maxHp` | number | Maximum hit points. |
| `str` `dex` `con` `int` `wis` `cha` | number | Ability scores (standard 3–20 range). |
| `proficiencyBonus` | number | Added to attack rolls and proficient skill/save checks. |
| `savingThrowProficiencies` | string[] | Ability names this class is proficient in, e.g. `["str","con"]`. Saving throw totals are computed at runtime. |
| `skills` | object | All 18 SRD skills keyed by camelCase name. Each value is the **pre-computed total modifier** (ability mod ± proficiency). |
| `secondWindMaxUses` | number | Fighter Second Wind charges per encounter. `0` for non-Fighters. |
| `hitDieType` | number | Die size for Hit Dice: `10` (Fighter), `8` (Rogue). |
| `sneakAttackDice` | number | Number of d6 Sneak Attack dice. `0` for non-Rogues. |
| `color` | number | Token colour as a decimal integer (RGB hex, e.g. `5227511` = `#4FB8F7`). |
| `xp` | number | Always `0` — live XP is tracked in the save file. |
| `defaultEquipment` | object | Starting equipped gear: `{ armorId, weaponId, shieldId }`. Each value is an item `id` or `null`. |
| `defaultInventoryIds` | string[] | Starting carried items by item `id`. Repeat the same id to create a stack, e.g. `["javelin","javelin","javelin"]`. |
| `description` | string | Character backstory. Surfaced to the AIDM as persona context. |

**Fields computed at runtime (absent from JSON):**

| Field | Computed by | How |
|---|---|---|
| `speed` | `applySpecies` | Species base speed + lineage speed bonus (e.g. Wood Elf +5) |
| `savageAttacker` | `applyFeats` | `true` if any feat in `featIds` has `effects.savageAttacker` |
| `fightingStyleDefense` | `applyFeats` | `true` if any feat in `featIds` has `effects.armorAcBonus` |
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
  "secondWindMaxUses": 2,
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
| `type` | string | SRD creature type string, e.g. `"Medium Undead, Lawful Evil"`. |
| `maxHp` | number | Maximum hit points. |
| `hpFormula` | string | SRD dice formula for reference, e.g. `"2d8+2"`. Not used in combat — `maxHp` is authoritative. |
| `ac` | number | Armour Class. |
| `str` `dex` `con` `int` `wis` `cha` | number | Ability scores. |
| `proficiencyBonus` | number | Proficiency bonus. |
| `savingThrows` | object | All six saving throw totals keyed by ability abbreviation: `{ str, dex, con, int, wis, cha }`. Store SRD values directly. |
| `initiativeBonus` | number | Added to the initiative roll. Typically equals the DEX modifier. |
| `stealthBonus` | number | Used when the creature attempts to hide. |
| `passivePerception` | number | Used to detect hiding players. |
| `speed` | number | Movement speed in **feet**. |
| `attacks` | Attack[] | One or more attack entries (see below). |
| `xp` | number | XP awarded on kill. |
| `cr` | string | Challenge Rating, e.g. `"1/8"`, `"1/4"`, `"1"`. Classifies encounter difficulty. Not used for automatic reward calculation — gold must be granted by the AIDM via `award_gold`. |
| `color` | number | Token colour as a decimal integer. |
| `vulnerabilities` | string[] | *(optional)* Damage types that deal double damage, e.g. `["bludgeoning"]`. |
| `resistances` | string[] | *(optional)* Damage types that deal half damage. |
| `immunities` | string[] | *(optional)* Damage types that deal no damage. Immunity takes precedence over vulnerability. |
| `conditionImmunities` | string[] | *(optional)* Conditions that cannot be applied to this creature. |

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

## npcs/

Named characters with identity and persona layered on top of a monster stat block. NPCs are spawned in social and exploration encounters; they do not carry full stat blocks themselves — those are resolved at runtime from `monsterClass`.

### Fields

| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique key. Used in `premade-encounters` `npcIds` and `allyIds`. |
| `name` | string | Display name shown on the map token. |
| `monsterClass` | string | `id` of a `monsters/` entry. Determines HP, AC, speed, attacks, and other combat stats. |
| `color` | number | Token colour as a decimal integer. |
| `persona` | string | *(optional)* Roleplay instructions for the AIDM. The AIDM speaks as this character when the player addresses them. |

### Example — `npcs/tavern_keeper.json`

```json
{
  "id": "tavern_keeper",
  "name": "Bram Holdfast",
  "monsterClass": "commoner",
  "color": 13395456,
  "persona": "You are Bram Holdfast, the gruff but fair keeper of The Rusty Flagon..."
}
```

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
| `cost` | number | Gold piece value. |

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

A shield adds `+2`, Fighting Style: Defense adds `+1` (if `fightingStyleDefense` is true on the character).

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
| `healDice` | number | Number of healing dice. |
| `healSides` | number | Die size for healing roll. |
| `healBonus` | number | Flat bonus added to healing. |

---

## feats/

One file per SRD feat. Feats are loaded at startup, served via `GET /feats`, and cached in the client registry. `applyFeats` reads a character's `featIds` list, looks up each feat, and writes mechanical flags onto `PlayerDef`.

### Fields

| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique key. Matches filename (kebab-case). Referenced by `characters.featIds`. |
| `name` | string | Display name from the SRD. |
| `category` | string | `"origin"`, `"general"`, `"fighting-style"`, or `"epic-boon"`. |
| `prerequisites` | object | `{ minLevel, minAbilityScore, requiresFeature, repeatable, repeatableNote }`. |
| `description` | string | Full rules prose from the SRD. |
| `effects` | object | Named, structured mechanical properties (see below). |

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

One file per SRD species. Species are loaded at startup, served via `GET /species`, and cached in the client registry. `applySpecies` reads a character's `speciesId` and `speciesLineage` and writes `speed` onto `PlayerDef`.

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

All other trait effects are stored for future engine use and have no current mechanical impact.

---

## maps/

Hand-crafted encounter maps stored as ASCII grids. The server pre-processes each map into a `passable` boolean grid at startup.

### Fields

| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique key. Referenced by `premade-encounters` `mapId`. |
| `name` | string | Display name shown in the UI. |
| `mapdescription` | string | Prose description of the map layout, surfaced to the AIDM for spatial context. |
| `rows` | string[] | ASCII grid. Each string is one row. All strings must be the same length. |

### Tile legend

| Character | Meaning |
|---|---|
| `#` | Wall — impassable |
| `.` | Floor — passable |

The map `cols` and `rows` dimensions are derived from the grid at load time.

---

## encounters/

A flavored combination of a map and one or more NPCs, with optional AIDM instructions to set the scene. The server reads all files in this directory and serves them at `GET /encounters`.

### Fields

| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique key. |
| `title` | string | Short display title shown on the encounter card. |
| `description` | string | Flavour description shown on the encounter card. |
| `encounterTypes` | string[] | One or more of: `"simple_combat"`, `"exploration"`, `"social_interaction"`. Controls which systems activate (enemies, secrets, NPC spawns). |
| `mapId` | string | `id` of a `maps/` entry. |
| `npcIds` | string[] | *(optional)* `id` values from `npcs/` to spawn as **neutral** NPCs. Repeat the same id to spawn multiple of the same type. |
| `allyIds` | string[] | *(optional)* `id` values from `npcs/` to spawn with **ally** disposition near the player. |
| `customIntroduction` | string | *(optional)* Replaces the auto-generated introduction shown in the Introduction Overlay at encounter start. |
| `customContext` | string | *(optional)* Replaces the auto-generated AIDM context string. Use this to give the AIDM specific instructions about the scenario, the NPCs, and what mechanics to use. |
| `startingZones` | string[] | *(optional)* Spawn zone grid — same dimensions as the map `rows`. See below. |

### startingZones

When provided, `startingZones` is an ASCII grid the same width and height as the referenced map. Each character assigns a spawn region:

| Character | Spawn region |
|---|---|
| `P` | Player starting zone |
| `A` | Ally starting zone |
| `N` | Neutral NPC starting zone |
| `E` | Enemy starting zone |
| `#` `.` ` ` | Undesignated — no spawning |

Only passable tiles (`.` in the map) are eligible for spawning regardless of the zone label. If no zone is defined for a role, the server falls back to default placement rules (player in the left third of the map, enemies at least 5 tiles away, etc.).

### Example — `encounters/bridge_standoff.json`

```json
{
  "id": "bridge_standoff",
  "title": "Bridge Toll",
  "description": "A pair of bandits blocks a narrow stone bridge...",
  "encounterTypes": ["social_interaction"],
  "mapId": "bridge",
  "npcIds": ["bandit_npc", "bandit_npc"],
  "allyIds": ["commoner"],
  "customIntroduction": "You and a nervous traveller stand at the near end...",
  "customContext": "Two bandits block the bridge. If the player refuses to pay, call set_disposition on both...",
  "startingZones": [
    "##########################",
    "#PPPPPPP##########NNNNNNN#",
    ...
  ]
}
```

---

## saves/

Runtime save files written by the server after every player action. These are not hand-authored — they are created automatically when a session starts or a character is first used. They live alongside the data files and are excluded from the repository.

There are two save files per session:

### Character save — `saves/{characterId}.json`

Stores the persistent player state that carries across encounters.

| Field | Type | Notes |
|---|---|---|
| `playerDefId` | string | The character `id` this save belongs to. |
| `hp` | number | Current hit points. |
| `xp` | number | Total experience points earned. |
| `gold` | number | Gold pieces carried. |
| `inventoryIds` | string[] | Item `id` values currently in inventory. Repeated entries represent stacks. |
| `secondWindUses` | number | Remaining Second Wind charges this encounter. |
| `equippedSlots` | object | `{ armorId, weaponId, shieldId }` — currently equipped items. |
| `encounterLog` | object[] | *(optional)* Raw record of every completed encounter, newest first. Each entry contains `id`, `timestamp`, `description`, `encounterTypes`, `xpGained`, `goldGained`, `outcome`, and `lines` (ordered log lines of type `combat`, `dm_player`, or `dm_reply`). Written when a session ends via `DELETE /game/session/:id`. |
| `storylog` | object[] | *(optional)* AI-generated narrative entries keyed by `encounterId`. Each entry contains `encounterId` and `narrative` (prose string). Generated on demand by `POST /save/:characterId/storylog` via `server/src/storylog.ts` using Claude Sonnet; only missing entries are generated — existing entries are never overwritten unless `?rewrite=true` is passed. |

### World save — `saves/world.json`

Stores the full encounter state so the player can resume mid-encounter. This file is deleted when the player starts a new encounter. The `GET /world` endpoint also returns `dmHistory` (the AIDM conversation history for the session), which is kept in server session memory and restored to the client on reconnect.

Key runtime fields of note:

| Field | Notes |
|---|---|
| `npcs[].inventoryIds` | Items held by each NPC (string `id` values from `equipment/`). Populated when a thrown item hits the creature; each item is moved to `mapItems` at the creature's tile when it dies, making it recoverable. |
| `dmHistory` | AIDM conversation — returned alongside `world.json` by `GET /world`. `[CURRENT STATE]` prefixes are stripped from historical user messages before each API call so the model always reasons from the current injected state, not stale snapshots. |

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
| `encounters.allyIds[]` | `npcs/{id}.json` |
| `saves.playerDefId` | `characters/{id}.json` |
| `saves.inventoryIds[]` | `equipment/{id}.json` |
| `saves.equippedSlots.*Id` | `equipment/{id}.json` |
