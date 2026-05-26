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
| `rangeNormal` | number? | *(ranged weapons)* Normal ranged attack range in feet. Absence/0 = melee weapon. Beyond this range imposes Disadvantage. |
| `rangeLong` | number? | *(ranged weapons)* Maximum ranged attack range in feet. Beyond this distance the player cannot fire. |
| `ammunitionType` | string? | *(ranged weapons)* Canonical key for the ammo item id consumed per shot, e.g. `"arrow"`, `"bolt"`, `"bullet"`, `"needle"`. Each attack consumes one matching item from inventory. |
| `loading` | boolean? | *(ranged weapons)* SRD Loading property. When `true`, only one shot per Action/Bonus Action/Reaction regardless of Extra Attack count. (Field is wired but not enforced until Extra Attack ships — no current Level 1 character has it.) |
| `heavy` | boolean? | *(ranged weapons)* SRD Heavy property. When `true`, DEX < 13 imposes Disadvantage on ranged attack rolls. |
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
| `description` | string? | Flavour text — shown only via tooltips/AIDM context, not in the inventory list. |
| `cost` | number? | Gold piece value. |

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

## spells/

One file per SRD spell, served via `GET /spells` (TBD — currently consumed only as design data; the engine has no spellcasting system yet). Files use kebab-case ids matching the SRD spell name (e.g. `magic-missile.json`, `ray-of-frost.json`).

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
| `darts` | integer? | *(Magic Missile-style)* Number of guaranteed-hit projectiles. |
| `rider` | string? | One-line secondary effect on hit (e.g. Ray of Frost's slow rider). |
| `effect` | object? | Free-form condition outcome, e.g. `{ onFail: "incapacitated", onSecondFail: "unconscious" }` for Sleep. |
| `description` | string | The full SRD spell text — used by the AIDM for ruling and shown to the player. |
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
| `passable` | boolean | Engine-authoritative default. Encounter `tileProperties` can override; if neither declares a value the engine defaults to impassable. |
| `layer` | string | `"ground"` or `"object"`. Tells map authors which tile layer the entry belongs on. Ground tiles are drawn first; object tiles overlay them. |
| `description` | string | Visual / authoring description. Surfaced to AI map generators. |
| `tags` | string[] | Free-form classification tags, e.g. `["wood", "bridge", "floor"]`. |

The server loads every `*_legend.json` file at startup and merges them into a single GID → entry map under `defs.tileLegend`. New tilesets are added by dropping in `{name}.png`, `{name}.tsj`, and `{name}_legend.json` together — no engine code changes required.

---

## maps/

Hand-crafted encounter maps stored as **Tiled-compatible JSON** (a stripped-down subset of the format that Tiled's "Save As JSON" export produces). Maps are pure geometry — they carry the tile-GID grid, the tile palette as graphical references, and identifying metadata. They do **not** declare what tiles mean (passable, difficult terrain, trapped, cover, …). That's the encounter's job: each encounter declares, via `tileProperties`, how the GIDs in its referenced map behave for that scenario. This separation means the same map can be reused across encounters with very different mechanics (a peaceful crossing today, a flooded crossing with broken parapets next week — same `bridge.json`).

The server loads each map at startup and stores the raw GID grid(s) — a required ground layer plus an optional object layer drawn on top. The combined `passable: boolean[][]` is built per-session from `map.gidGrid + map.objectGidGrid + encounter.tileProperties + tileset legend` (see [encounters/](#encounters), [tilesets/](#tilesets-1), and [`SessionBuilder.buildGameMapFromSaved`](../server/src/engine/SessionBuilder.ts)).

### Fields

| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique key. Referenced by `encounters.mapId`. |
| `name` | string | Display name shown in the UI. |
| `mapdescription` | string | Prose description of the map layout, surfaced to the AIDM for spatial context. |
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
| `tileProperties` | object[] | Per-GID semantics for the referenced map's tiles **in this encounter**. See below. Required to make any tile passable. |
| `startingZones` | object | *(optional)* Tiled-style tile layer marking spawn regions for the player, allies, neutral NPCs, and enemies. Same dimensions as the referenced map. See below. |
| `triggers` | object[] | *(optional)* Authored scripted events for this encounter — ambushes, reinforcements, scripted reveals. See [triggers](#triggers). |

### tileProperties

Each entry maps one of the map's GIDs to the semantic properties that GID should carry during this encounter. The engine's only currently-honoured property is `passable`; future SRD features (difficult terrain US-044, cover US-045, traps) will add more fields without changing the file shape.

| Field | Type | Notes |
|---|---|---|
| `gid` | integer | GID from the referenced map's terrain layer (= the map's `firstgid + tile.id`). |
| `passable` | boolean | *(default: `false`)* Whether creatures can walk onto a tile of this GID. |

**Lookup order for a GID's `passable`:**

1. The encounter's own `tileProperties` entry — explicit override.
2. The tileset's legend file (see [tilesets/](#tilesets-1)) — sensible default for tiles the encounter didn't customise.
3. `false` (impassable) — final fallback when neither source declares a value.

So encounters only need to list GIDs whose meaning differs from the legend (e.g. an "underground passage" scenario marks GID 287 / chasm as `passable: true`); a GID that matches the legend default can be omitted.

Because semantics live here and not in the map, the same `bridge.json` can be reused across encounters with different tile meanings — a broken-wall scenario could mark GID 2 (normally a wall) as `passable: true`, while a flooded scenario could leave it solid.

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

Authored scripted events evaluated server-side at well-defined hook points. Each trigger marries a `condition` (when does this fire?) to a list of `actions` (what happens?). Triggers are the deterministic counterpart to AIDM-driven scenes — once authored, they fire reliably regardless of LLM behaviour.

**Trigger entry:**

| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique within the encounter. Used as the dedupe key in `GameState.firedTriggerIds`. |
| `condition` | object | One of the condition shapes below. |
| `actions` | object[] | Ordered list of action shapes; all actions of a fired trigger run sequentially. |
| `once` | boolean | *(default `true`)* When `true`, the trigger fires at most once per session (persisted across save/load via `firedTriggerIds`). When `false`, it re-fires on every condition match. |

**Conditions:**

| `type` | Fields | Hook | Fires when |
|---|---|---|---|
| `enter_area` | `x, y, w, h` | `doMove` | Player steps onto any tile in the rectangle `[x, x+w) × [y, y+h)`. |
| `enter_tile` | `x, y` | `doMove` | Player steps onto the exact tile. |
| `npc_killed` | `defId` | `killNpc` | Any NPC with the matching `defId` reaches 0 HP. |
| `item_picked_up` | `defId` | `checkItemPickup` | The player picks up an item with the matching equipment `defId`. |

**Actions:**

| `type` | Fields | Effect |
|---|---|---|
| `spawn_enemy_near_player` | `monsterId`, `minDist?` (default 3), `maxDist?` (default 8) | Spawns an enemy on a free tile at Chebyshev distance `[minDist, maxDist]` from the player. No-ops if no tile is free in range. |
| `spawn_enemy_at` | `monsterId`, `x`, `y` | Spawns an enemy at the given tile; falls back to the nearest free tile (within 6 tiles) if the target is occupied / impassable. |
| `show_log` | `message` | Pushes a `header`-styled line into the Combat Log. |
| `send_aidm_message` | `message` | Appends to `GameState.pendingAidmEvents`; surfaced to the next AIDM turn under the `SCRIPTED EVENTS` block in CURRENT STATE, then cleared after the reply. Use this when the engine action needs DM narration to land. |

Hook order matters in a few places worth knowing:

- `player_moved` triggers are evaluated **before** the combat-start proximity check, so an `enter_area` trigger that spawns enemies near the player kicks off combat on the same tile entry.
- `npc_killed` triggers are evaluated **before** `autoEndCombatIfNoEnemies`, so a kill-triggered reinforcement spawn prevents combat from ending.
- `item_picked_up` triggers fire **after** the item is moved into the player's inventory and quest progress is advanced.

**Example — guard-room ambush in `encounters/dungeon_delve.json`:**

```json
"triggers": [
  {
    "id": "guardroom_ambush",
    "condition": { "type": "enter_area", "x": 3, "y": 12, "w": 6, "h": 3 },
    "actions": [
      { "type": "show_log", "message": "⚔ Bones scrape against stone — skeletal figures rise from the rubble!" },
      { "type": "spawn_enemy_near_player", "monsterId": "skeleton", "minDist": 2, "maxDist": 4 },
      { "type": "spawn_enemy_near_player", "monsterId": "skeleton", "minDist": 2, "maxDist": 4 },
      { "type": "send_aidm_message", "message": "Two skeletons rise from the rubble of the guard room and lurch toward the party." }
    ],
    "once": true
  }
]
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

There are two save files per session:

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

Stores the full encounter state so the player can resume mid-encounter. This file is deleted when the player starts a new encounter. The `GET /world` endpoint also returns `dmHistory` (the AIDM conversation history for the session), which is kept in server session memory and restored to the client on reconnect.

Key runtime fields of note:

| Field | Notes |
|---|---|
| `npcs[].id` | Generated at spawn as `{defId}_{index}` (e.g. `villager_0`). The AIDM entity ref is `npc_{id}` (e.g. `npc_villager_0`). |
| `npcs[].combatLabel` | Single uppercase letter (A, B, C…) assigned when the NPC enters combat or is spawned as an enemy. Empty string for neutral NPCs that have not yet entered combat. Rendered in the centre of the token circle during combat. Shared letter pool across enemies and allies. |
| `npcs[].revealedName` | *(optional)* The name an NPC disclosed in conversation, set by the `reveal_npc_name` AIDM tool. Replaces the generic name displayed above the map token and is shown as `(known as: X)` in the AIDM CURRENT STATE. |
| `npcs[].combatPassive` | *(optional)* When `true`, the ally skips their combat turn (set via the `set_npc_passive` AIDM tool). Used when the player instructs an ally to stand down. Reversed by calling the tool with `passive: false`. |
| `npcs[].inventoryIds` | Items held by each NPC (string `id` values from `equipment/`). Populated when a thrown item hits the creature; each item is moved to `mapItems` at the creature's tile when it dies, making it recoverable. |
| `npcs[].hp` | When `hp` reaches 0 the NPC is treated as a corpse: it remains in the `npcs` array, stays on the map at 40% opacity, and is excluded from combat turns, movement AI, ability check triggers, and all AIDM state sections except CORPSES. `inventoryIds` is cleared and `isActive` is set to `false` on death. |
| `npcs[].initiativeRoll` | *(optional)* The combatant's d20 + initiativeBonus total for the current combat. Set at `doStartCombat` (with Disadvantage if Surprised, Advantage if Invisible). Cleared on `endCombat`. Used as the sort key for `turnOrderIds`. |
| `npcs[].reactionUsed` | Per-creature Reaction tracker. Set `true` when the NPC spends its Reaction (e.g. an Opportunity Attack against the player or another NPC). Reset to `false` at the *start of that NPC's own turn* (in `runSingleEnemyTurn` / `runSingleAllyTurn`) — never on the player's turn. Mirrors `player.reactionUsed` for the player. Surfaced to the AIDM CURRENT STATE as `Reaction: AVAILABLE`/`USED` on each combatant line while combat is active. |
| `player.initiativeRoll` | Same idea for the player: d20 + DEX mod, set at combat start, cleared at combat end. |
| `player.freeObjectInteractionUsed` | SRD "one free object interaction per turn" tracker. Set when the player equips/unequips a weapon or shield during `player_turn`. Reset by `enterPlayerTurn`. Once set, a second swap that turn requires the Utilize action and consumes `actionUsed`. |
| `turnOrderIds` | Initiative-sorted list of combatant ids: `'player'` plus each NPC `id`. Sort key is `initiativeRoll` (descending), tiebreak by DEX mod / `initiativeBonus`. Iterated by `advanceTurn`; dead combatants are skipped at iteration time (entries are NOT removed when a combatant dies — removing them mid-iteration would shift indices). |
| `activeNpcIndex` | Index into `turnOrderIds` pointing at the combatant currently taking their turn. The HUD turn-order bar reads `turnOrderIds` and highlights the chip whose corresponding combatant has `isActive === true` (NPCs) or whose entry is `'player'` and `phase === 'player_turn'` / `'death_saves'`. |
| `pendingReaction` | *(optional, top-level on `GameState`)* When set, the engine has paused the turn loop on a reaction-eligible trigger and is awaiting a `resolveReaction { accept }` action from the player. Cleared by `doResolveReaction` after applying (or skipping) the deferred effect. Two shapes: `{ kind: 'opportunity_attack', npcId, npcName }` and `{ kind: 'shield', attackerId, attackerName, incomingDamage, attackTotal, shieldedAc }`. While set, `advanceTurn` early-returns. |
| `triggers` | *(top-level on `GameState`)* Authored encounter triggers seeded from `EncounterDef.triggers` at session creation. Static across the session — never mutated at runtime. |
| `firedTriggerIds` | *(top-level on `GameState`)* String ids of triggers that have already fired. Consulted by `TriggerSystem.evaluateTriggers` to enforce `once: true` semantics. Persisted in `world.json` so one-shot triggers stay one-shot across save/load. |
| `pendingAidmEvents` | *(top-level on `GameState`)* Scripted-event lines queued by `send_aidm_message` trigger actions. Rendered into the next AIDM CURRENT STATE block under `SCRIPTED EVENTS`, then cleared after the AIDM reply lands. |
| `aidmHistory` | The **sliding-window** AIDM conversation persisted into `world.json` (serialised from server session memory). Bounded to ~20 verbatim messages plus an optional leading `[SUMMARY OF EARLIER TURNS]` assistant message that collapses anything older. `[CURRENT STATE]` prefixes are stripped from historical user messages before each API call so the model always reasons from the current injected state, not stale snapshots. The `GET /world` response surfaces this under the `dmHistory` field for client-side display. |

### Session-only AIDM state (in-memory)

These are kept in server session memory only — not persisted to disk — and reset if the server restarts:

| Field | Notes |
|---|---|
| `aidmArchive` | The **full, unsummarized record** of every user/assistant exchange this session. Used exclusively by the `recall_memory` tool for case-insensitive substring lookups. Separate from `aidmHistory` so summarisation doesn't erase searchable content. |
| `aidmBusy` | Boolean mutex flag. While true, the `/aidm` route returns HTTP 429 for concurrent requests on the same session. Released in a `finally` block. |

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
