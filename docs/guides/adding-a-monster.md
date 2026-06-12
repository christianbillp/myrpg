> **Audience:** developers, AI agents · **Status:** current · Recipe for adding a monster.

# Adding a Monster

Monsters are **data** — a JSON drop, no engine change. Full shape:
[../design/data-model.md](../design/data-model.md#monsters).

## 1. Drop the JSON

Create `server/data/monsters/<kebab-id>.json` with the SRD stat block. Source
every value from the SRD 5.2.1 stat block (`/dnd.srd.5.2.1/11_Monsters/`):

- Identity: `id`, `name`, `type`, `tokenAsset`.
- Defences: `maxHp`, `ac`, optional `resistances` / `vulnerabilities` /
  `immunities` / `conditionImmunities` (enforced — spells, shoves, on-hit
  riders, and AIGM `apply_condition` all respect the list).
- Stats: the six ability scores, `proficiencyBonus`, `savingThrows`,
  `initiativeBonus`, `passivePerception`, `stealthBonus`, `speed`.
- Offence: `attacks[]` (name, bonus, reach/range, damage dice + type, optional
  `bonusDamage` riders and `onHit` effects — `attach` / `save` /
  `ability_drain`), optional `multiattack`, trait flags (`traits:
  ["pack_tactics" | "sunlight_sensitivity" | "undead_fortitude"]`,
  `nimbleEscape`).
- `xp`, `cr`, `color`.

The combat engine selects the correct attack by range (US-124): melee when the
creature can close to adjacency this turn, the ranged option otherwise — with
SRD long-shot/point-blank Disadvantage and Cover applied. Resistance/immunity
are read from the lists — any combination works without code. See the worked
SRD examples: `zombie.json` (Undead Fortitude), `ghoul.json` (paralyzing
on-hit save + necrotic rider), `shadow.json` (Strength drain),
`skeleton.json` (melee + shortbow by range), `bandit_captain.json`
(Multiattack + Parry reaction).

## 2. Token

Reference a token SVG in `tokenAsset` (e.g. `/tokens/monster_<id>.svg`) and add
the file under `server/data/tokens/`. See
[../design/data-model.md](../design/data-model.md#tokens).

## 3. Use it

Monsters are content — drop them into an encounter's monster list (or the random
pool). NPCs that need identity/dialogue on top of a stat block are a separate
type (`NPCDef`) that references the monster — see
[../design/data-model.md](../design/data-model.md#npcs).

## 4. Verify

`npm run typecheck`, then `touch server/src/index.ts` to reload. Counts and
identities of monsters are content, not requirements.
