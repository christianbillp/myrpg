# Battlefield hazards

> **Audience:** developers, encounter authors, AI agents · **Status:** shipped. Tactical Crucible #32.

Dynamic environmental hazards turn the **terrain into a weapon** — a spreading
fire from a toppled brazier, a ruptured acid vat, a collapsing floor. Each combat
round a hazard **damages** everyone standing in it and, if it `spreads`, **grows**.
The fight stops being a static slug-fest: keep clear of the flames, herd foes
into them, or shove a cultist into the fire.

## Model

A hazard is an **`ActiveZone` with a `hazard` payload** (`shared/types/gameState.ts`)
— so it reuses the existing zone **tint rendering** on the client for free. The
payload:

```ts
hazard: {
  dice; sides; bonus?; damageType;          // per-round damage roll
  saveAbility?; saveDC?; halfOnSave?;        // optional save (DEX for half, …)
  spreads?; maxTiles?;                       // grow a ring/round, capped
}
```

## Tick

`HazardSystem.tickHazardZones` runs once per round (from `enterPlayerTurn`,
alongside the spell-zone tick). For each hazard zone:

1. **Damage** every creature whose tile is in the zone — the player
   (`playerSaveVsDc` for the save, else `applyDamageToPlayer`) and each NPC
   (`npcSaveMod` roll, then `applyDamageToNpc` — so resistance, death, and combat
   barks all flow through the normal path). Friend and foe alike.
2. **Spread** (if `spreads`): add one ring of orthogonally-adjacent **passable**
   tiles (fire doesn't cross walls), capped by `maxTiles`.

## Authoring

- **`spawn_hazard` trigger action** — drop a hazard mid-fight: `{ type:
  'spawn_hazard', x, y, sizeFeet?, dice, sides, bonus?, damageType, saveAbility?,
  saveDC?, halfOnSave?, spreads?, maxTiles?, rounds?, name?, tintHex? }`. Pair
  with a `combat_round` (#31) or `hp_threshold_crossed` trigger ("on round 2 the
  brazier topples"), an objective, or a player action.
- **Interaction** — the hazard is just damaging tiles, so *kicking a foe in* needs
  no special code: resolve the player's shove/improvised action, `move_entity`
  the foe onto a burning tile, and the next round tick burns them. Composes with
  improvised actions (US-121), morale (#34 — the burned break), and roles (#35).

## Files

| File | Role |
|---|---|
| `shared/types/gameState.ts` | `ActiveZone.hazard`. |
| `shared/types/triggers.ts` | `spawn_hazard` action. |
| `server/src/engine/HazardSystem.ts` | `tickHazardZones`, `registerHazardZone`. |
| `server/src/engine/CombatFlow.ts` | per-round tick hook in `enterPlayerTurn`. |
| `server/src/engine/TriggerSystem.ts` | `spawn_hazard` handler. |
| `server/src/engine/HazardSystem.test.ts` | Tests. |
| `server/data/.../encounters/demo_hazards.json` | Demo (round-2 spreading fire). |

## Not yet (v2 ideas)
- **Damage on ENTER** (immediate burn the moment a creature is shoved in, not at
  the next round tick).
- **Authored static hazards** at session start (an `EncounterDef.hazards` list)
  and **terrain-driven** hazards (lava/chasm tiles in the map legend).
- **Non-damaging terrain effects** beyond difficult terrain (slippery ice → prone,
  collapsing floor → fall) and an `AIGM spawn_hazard` tool for improv.
