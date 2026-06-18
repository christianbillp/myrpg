# Map generation

The deterministic map system that backs the Map Editor's **DETERMINISTIC** tab,
the **GENERATIVE AI** tab (an agentic builder driving the same ops), and the AI
encounter generator's `regionPlan` mode. Everything is seeded (`mulberry32`) so a
given `{ inputs, seed }` yields a byte-identical map; the seed-stability snapshot
(`MapComposer.test.ts`) guards that invariant.

## Layering

```
MapCanvas              mutable substrate: terrain + object GID grids, RNG,
   │                   zone-id allocator, anchors, zones, reserved set
   ▼
mapOps                 deterministic op toolbox (stampRoom, carveCorridor,
   │                   layPath, placeHazard, scatterDecor, defineZone,
   │                   wallAroundFloor, validateCanvas, passableRegions, …)
   ▼
terrain composers      outdoor.ts · dungeon.ts · cave.ts · urban.ts · regions.ts
   │                   (build a base map for one terrain / many region bands)
   ▼
mapFeatures            FEATURE_REGISTRY of "placeables" stamped consciously onto
   │                   a base; conscious placement; in-place re-roll; roads
   ▼
MapComposer            the dispatcher + entry points (composeMap, …) and the
                       retry wrappers (clean-fit + tactical)
```

Materials (`materials.ts`) are the model-/designer-facing names (`grass`,
`cave_dust`, `cracked_stone`, `tree`, `pool`, …) that resolve to GIDs; the
agentic builder never sees a raw GID. GID constants are themed by purpose in
`mapTiles.ts`. Public types are in `mapTypes.ts`.

## Terrains and layout variants

`composeMap({ terrain, features, structures, seed })` dispatches by terrain
(`grassland | forest | dungeon | cave | urban` — the single source of truth is
`TERRAINS`). Each enclosed terrain now ships **multiple silhouettes**, picked
from the seed (Roadmap v2 · M2), so repeated generation reads as variety rather
than one fixed shape:

| Terrain | Composer | Variants |
|---|---|---|
| grassland / forest | `outdoor.ts` | biome-palette ground + object scatter + features + structures |
| dungeon | `dungeon.ts` | **serial** (single chain), **branch** (spanning tree), **loop** (tree + extra edges → flanking loops). Vault = graph-farthest room. |
| cave | `cave.ts` | **hub_spoke** (central chamber + tunnelled side chambers), **cavern** (cellular-automata organic hollow, largest component kept connected) |
| urban | `urban.ts` | village plaza ringed by buildings |

All dungeon/cave variants are guaranteed connected (spanning tree / largest-CA-
component + connectivity repair).

## Features

`features: Feature[]` layered onto outdoor / big maps:

- `coastline` — water along one edge with shoreline tiles.
- `river` *(M5)* — a winding 2-wide water band across the long axis: a natural
  barrier that splits the map into two banks until a `bridge` spans it.
- `path` / `intersection` — a winding road (single thread, corners not
  T-junctions) along the long axis; `intersection` adds the perpendicular cross.
- `clearing` *(M3)* — ramps decoration toward the edges (an open central glade
  ringed by a dense treeline) via an edge→interior density curve.
- `campsites` — scattered campfires on dry ground.
- `3-room` / `5-room` / `stairs` — dungeon/cave room count + a stairs entrance.

## Placeables (the unified registry)

`FEATURE_REGISTRY` (`mapFeatures.ts`) is one registry of named, deterministic,
re-rollable **placeables** — Phase B unified the old "set-pieces" and
"structures" into this single concept. Each is stamped **consciously**:
`findFeaturePlacement` scores every candidate footprint by overlapped obstacles
(footprint weighted over border) and hard-rejects footprints touching a road or
existing wall, so a placeable never collides; `clearFootprint` tidies trees /
lifts blocking ground on the chosen spot. Each records a `PlacementRecord` (with
an `interiorSeed`) so a single one can be re-rolled in place (`restampPlaceable`)
without recomposing the map.

| id | Notes |
|---|---|
| `building` | Multi-room grid (1–5) of varied-size rooms, shared walls, spanning-tree doorways, one outer entrance, furnished. |
| `ruin` | Like building but cracked floor + crumbled wall segments + rubble. |
| `tavern` | A multi-room establishment: a **taproom** (≥50% larger than any side room, holds the entrance, bar + tables) plus rolled back rooms (kitchen / cellar / snug / parlour / guest). No indoor campfire. `rooms` 1–5; per-room zones + an overall `tavern` zone. |
| `watchtower` | 3×3 tower + crate fence + courtyard zone. |
| `cemetery` | Crypt + fenced graveyard + grave markers. |
| `town_square` | Paved plaza + central fountain. |
| `shrine` *(M3)* | Paved dais, dotted colonnade (a ruined ring), central altar. |
| `farmstead` *(M3)* | Fenced field (one gate) + a farmhouse + crop rows. |
| `mine` *(M3)* | Cracked-stone adit + a stairs shaft + cart cover. |
| `bandit_hideout` *(M3)* | Broken stockade (sally-port gap) + cover + a campfire. |
| `bridge` *(M5)* | A walkable wood-deck that **spans a river** — placed straddling the water (dry banks at both ends) instead of avoiding it, reconnecting the banks. |

The registry is the single source of truth: `FEATURE_IDS` derives the encounter
tool-schema enum and the client `PlaceableType` / `PlaceableId` unions, so adding
a recipe is one entry.

## Anchors, zones, lighting, tactics

A composed map carries metadata the encounter layer targets:

- **`anchors`** (`MapAnchors`) — `entrance`, `vault`, `rooms[]`, `buildings[]`,
  `campfires[]`, `pathEndpoints`, `inlandBand[]`, … Populated only by the
  features that actually placed.
- **`zones`** (`MapZone[]`) — author-time named tile regions (per room, per
  placeable, per region band, `path`, `bridge`, …), each with a deterministic id
  and an optional `lightLevel` (`bright | dim | dark`) baked into per-tile light
  at session build (a cave band stays dark on an otherwise bright map).
- **`tactical`** (`TacticalMetrics`, Roadmap v2 · M1) — an opt-in fighting-shape
  read computed off the passable grid by `tacticalAnalysis`: `coverRatio`,
  `openness`, `chokepoints[]` (articulation points), `holdZones[]` (defensible
  pockets reached through 1–2 chokepoints), and `loops` (alternate-route
  richness). `isDegenerateLayout` flags a no-cover open blob; the extras
  composers can resample until the layout isn't degenerate (`tactical: true`).

## Multi-region big maps

`composeRegions({ width, height, regions, seed })` (`regions.ts`) lays 2–5 biome
bands along the long axis with noisy boundaries. Open↔open boundaries blend with
a 3-tile **ecotone** (each cell rolls ground + scatter from the neighbour's
palette); enclosed bands (cave/dungeon) carve their interior in that terrain's
style and punch a mouth corridor to the open neighbour, with an **ecotone apron**
(Roadmap v2 · M3) spilling the rock terrain's ground a few tiles into the open
band so the entrance reads as carved in. Connectivity is validated and repaired.

## Roads and routing

- `applyBigMapRoads` lays the `path` / `intersection` features across a big map's
  open bands (excludes cave/dungeon regions), auto-tiled.
- `connectPlaceablesByRoad` (Roadmap v2 · M4) threads a road from a map edge to
  each placed structure's **doorstep** via `routeThread` (BFS over roadable
  cells), avoiding other footprints and merging into the existing network —
  "a path leading to the tavern". Opt-in via `roadToPlaceables` on the extras
  composers.

## Compose entry points (`MapComposer.ts`)

- `composeMap(opts)` — one terrain + features + structures.
- `composeTerrainWithFeature(opts)` — placeables stamped onto a re-rolled-until-
  clean open-terrain base. Options: `placeables`, `feature`, `tactical`,
  `roadToPlaceables`.
- `composeRegionsWithExtras(opts)` — the same for a multi-region big map (roads +
  placeables), each in an open band.
- `composeFeatureMap(opts)` — one placeable centred on a flat field (preview).
- `restampPlaceable(map, i, seed)` — re-roll one placeable's interior in place.

The clean-fit retry re-rolls the base seed until every placeable fits with
nothing overwritten (and, with `tactical`, isn't degenerate).

## Agentic AI builder

The GENERATIVE AI tab (`mapAgent.ts`, behind `POST /generate/map`) gives the
model the `mapOps` toolbox via tool-use and an ASCII render after each op. Roadmap
v2 · M5 adds a **DIAGNOSTICS** line to every observation (`buildDiagnostics`):
connectivity (disconnected-region warning), cover %, and chokepoint count, so the
model fixes a sealed room mid-build. `finish` still auto-repairs connectivity as a
safety net. The deterministic composer path is unaffected.

## Determinism & tests

Every deterministic path is seed-stable. Coverage: `MapComposer.test.ts` (golden
hashes per terrain/feature), `mapFeatures.test.ts` (recipes, placement,
connectivity, tavern, new set-pieces, tactical opt-in), `tactical.test.ts`,
`terrainVariants.test.ts` (dungeon/cave variants), `biomeRichness.test.ts`
(clearing + ecotone), `routing.test.ts`, `riverBridge.test.ts`,
`agentDiagnostics.test.ts`, `regions.test.ts`, `mapOps.test.ts`, `mapAgent.test.ts`.

## Notable limits

Single-terrain map ≥ 12×8; big maps 24–96 × 16–64, 2–5 regions; rooms 1–5;
building rooms 4–7 tiles, tavern rooms 5–8; agent maps ≤ 40×30, ≤ 30 turns / 80
ops. Verticality (elevation / high ground) is out of scope — a separate epic.
