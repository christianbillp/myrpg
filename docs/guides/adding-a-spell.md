> **Audience:** developers, AI agents · **Status:** current · Recipe for adding a spell.

# Adding a Spell

Spells are **data**. Most are a single JSON drop; only a genuinely novel mechanic
touches the engine. Full data-shape reference:
[../design/data-model.md](../design/data-model.md#spells). Resolver spec:
[../design/systems/srd-rules.md](../design/systems/srd-rules.md) (search "US-065").

## 1. Drop the JSON

Create `server/data/spells/<kebab-id>.json` (id matches the SRD spell name, e.g.
`magic-missile.json`). The generic resolver in `server/src/engine/SpellSystem.ts`
branches on the spell's **shape**, so pick the fields that match the effect:

- **Attack-roll spell** → `attack: "ranged-spell" | "melee-spell"` + `damage`.
- **Auto-hit** (Magic Missile) → `attack: "auto-hit"` + `darts`.
- **Save spell** → `save: { ability, halfOnSuccess }` + `damage` and/or
  `effect: { onFail, onSuccess?, onHit? }` for condition riders.
- **Healing** → `heal: { dice, sides, perLevel? }`.
- **Area** → `area: { shape, sizeFeet }`; persistent areas use `zone`.
- **Self/utility buff** → no attack/save; handled in `resolveUtilitySpell` (often
  via a `Modifier` on a self-buff — see the buff layer in
  [../design/data-model.md](../design/data-model.md#modifier-aggregator)).

Always include the SRD `description`, and an `Engine:` note in it stating what is
mechanical vs. descriptive.

## 2. Make it castable

Add the spell id to a caster's `defaultCantripIds` / `defaultSpellbookIds` /
`defaultPreparedSpellIds` (in the character JSON) as appropriate. Slots come from
`defaultSpellSlots`.

## 3. When you DO need the engine

If the spell needs a mechanic the generic resolver doesn't cover (a new condition
reader, a summon, a caster-anchored aura), add it as a focused module/condition
and wire it where similar spells hook (e.g. `SummonSystem`, a per-turn handler in
`CombatFlow`, a reader in `pickEnemyAttackTarget`). Prefer reusing an existing
`Modifier` type — that keeps the spell mostly data.

## 4. Verify

- `npm run typecheck`.
- Add/extend a test under `server/src/engine/*.test.ts` (the existing
  `Spell*.test.ts` files show the patterns — load the real JSON, drive
  `doCastSpell`, assert the effect).
- `touch server/src/index.ts` to reload the server with the new data file.

## 5. Document

Add the user-facing line to [../product/requirements.md](../product/requirements.md)
(under spellcasting / US-065) and the mechanical detail to the spellcasting
section of [../design/systems/srd-rules.md](../design/systems/srd-rules.md).
