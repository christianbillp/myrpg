/**
 * EncounterArchetype — the data-driven template the Adjudicator's RANDOMIZE
 * flow rolls against. Each archetype is a self-contained recipe: terrain +
 * feature options, monster pools with count ranges, spawn placement strategy,
 * and pools of title / intro / objective strings the runtime picks from.
 *
 * Adding new content is intentionally trivial: drop a new entry into
 * `ENCOUNTER_ARCHETYPES` (or extend an existing entry's pool arrays).
 * No engine changes are required. The randomizer module
 * (`encounterRandomizer.ts`) consumes these declaratively.
 *
 * Conventions:
 *   • `weight` — bigger = picked more often. Omit to default to 1.
 *   • `features` vs `featurePicks` — `features` is a fixed list (always
 *     applied), `featurePicks` rolls a subset from the given pool. Use one or
 *     the other, not both.
 *   • Each enemy/ally is picked WITH replacement from its pool — repeating
 *     entries weights toward common creature types.
 */

export type Terrain = 'grassland' | 'forest' | 'dungeon' | 'tavern';
export type Feature = 'campsites' | 'coastline' | 'path' | 'intersection' | 'buildings' | '3-room' | '5-room';

/**
 * Anchors the randomizer can target for placement. The list is walked in order;
 * the first anchor present on the composed map wins. Each archetype declares
 * its preference + a fallback so an unusual map roll (e.g. campsites failed to
 * place because of water) still gets reasonable spawns.
 *
 *   • `entrance` / `vault` / `far_room` — dungeon room centers
 *   • `campfire`                        — first campfire center
 *   • `building`                        — interior of first stamped building
 *   • `inland`                          — dry-side band when coastline is on
 *   • `edge:<dir>`                      — fallback: a band along the named edge
 *   • `away_from:<anchor>`              — fallback: any open cell far from the named anchor
 */
export type PlacementAnchor =
  | 'entrance' | 'vault' | 'far_room'
  | 'campfire' | 'building'
  | 'inland'
  | 'edge:south' | 'edge:north' | 'edge:west' | 'edge:east'
  | 'away_from:campfire' | 'away_from:entrance' | 'away_from:building';

/**
 * Trigger template — a single trigger declaration the randomizer resolves into
 * a concrete `ComposedTrigger` at roll time. `anchor` picks a map region; the
 * randomizer paints a square footprint of `radius * 2 + 1` cells around the
 * anchor's center (or uses the rect interior for `building`/`ruin` anchors).
 *
 *   • `perception` — kicks off a Perception check at `dc`. On pass the player
 *     sees `passMessage` in the event log.
 *   • `log`        — pushes `message` into the event log (atmospheric beat).
 *   • `aigm`       — feeds `message` to the AIGM as a private cue.
 *   • `combat`     — flips `defId` (or all unaligned NPCs) to enemy and starts
 *     initiative.
 */
export interface TriggerTemplate {
  kind: 'perception' | 'log' | 'aigm' | 'combat';
  /** Where on the map the trigger region centers. */
  anchor: PlacementAnchor;
  /** Half-extent of the region in cells around the anchor center. Default 2 (= 5×5 region). Ignored for rect anchors. */
  radius?: number;
  /** Perception DC; default 10. */
  dc?: number;
  /** Perception pass-message; required for `perception`. */
  passMessage?: string;
  /** Log / AIGM cue text; required for `log` and `aigm`. */
  message?: string;

  /** Combat defId override; optional for `combat`. */
  defId?: string;
}

export interface EncounterArchetype {
  id: string;
  name: string;
  /** Higher = picked more often. Defaults to 1 when omitted. */
  weight?: number;

  /** Terrain handed to MapComposer. */
  terrain: Terrain;
  /** Fixed feature list always applied. Mutually exclusive with featurePicks. */
  features?: Feature[];
  /** Roll N features from this pool. Mutually exclusive with `features`. */
  featurePicks?: { from: Feature[]; count: [number, number] };

  /** One string is picked per encounter — surfaced as the in-game title. */
  titles: string[];
  /** Optional opening narration shown in the event log. One picked per encounter. */
  introductions?: string[];
  /** Hidden context the AIGM sees silently. One picked per encounter. */
  descriptions: string[];
  /** Player-facing one-line objective. One picked per encounter. */
  objectives: string[];
  /** Optional `set_world_flag` slug that completes the chapter. */
  completionFlag?: string;

  /** Pool to draw enemies from (with replacement). */
  enemyPool: string[];
  /** Inclusive range [min, max] of enemies rolled into the encounter. */
  enemyCount: [number, number];

  /** Optional ally pool (with replacement). */
  allyPool?: string[];
  /** Inclusive range of allies rolled. Omit alongside `allyPool` to skip allies. */
  allyCount?: [number, number];

  /**
   * Anchor preference for the player's starting cells. The randomizer walks
   * the list in order and paints cells around the first anchor that resolves
   * on the rolled map. Always end with an `edge:*` fallback so placement is
   * guaranteed even when a feature placer didn't fire.
   */
  playerAnchors: PlacementAnchor[];
  /** Anchor preference for enemy cells. Same fallback rule applies. */
  enemyAnchors: PlacementAnchor[];
  /**
   * Optional trigger templates the randomizer rolls into concrete encounter
   * triggers. Each template is anchored to a map region (see `PlacementAnchor`)
   * and templates whose anchor doesn't resolve on the rolled map are silently
   * dropped. The randomizer caps each roll at `MAX_TRIGGERS` (today 2) of the
   * resolved templates, so an archetype declaring more is fine — only the
   * first that-many that resolve are seeded into the editor. The editor
   * itself has no cap and the user can add more by hand.
   */
  triggerTemplates?: TriggerTemplate[];
}

/**
 * Starter archetype set. New entries can be appended without touching any
 * engine code — the randomizer reads this list and the existing
 * `/generate/encounter/composed` endpoint accepts whatever shape comes out.
 */
export const ENCOUNTER_ARCHETYPES: EncounterArchetype[] = [
  {
    id: 'forest_ambush',
    name: 'Forest Ambush',
    weight: 2,
    terrain: 'forest',
    featurePicks: { from: ['campsites'], count: [0, 1] },
    titles: [
      'Forest Ambush', 'Whispering Wood', 'Bandit Picket', 'The Snare in the Trees',
    ],
    introductions: [
      'The forest leans close, and the only sound is your own breath.',
      'Shafts of grey light fall between the trees. Somewhere in the undergrowth, a twig snaps that should not have snapped.',
      'The wind dies. Birds stop. Whatever was watching has decided you are close enough.',
    ],
    descriptions: [
      'A wooded ambush — hostile figures hide in the undergrowth. The AIGM should foreshadow movement among the trees and reward perception.',
    ],
    objectives: [
      'Survive the ambush in the woods',
      'Push through and break the picket line',
      'Hunt down whoever set this trap',
    ],
    completionFlag: 'forest_ambush_resolved',
    enemyPool: ['goblin_minion', 'goblin_minion', 'bandit', 'kobold_warrior'],
    enemyCount: [2, 4],
    // Party enters from the south edge of the clearing; ambushers wait at
    // the far north end.
    playerAnchors: ['edge:south'],
    enemyAnchors:  ['edge:north'],
    triggerTemplates: [
      {
        kind: 'perception',
        anchor: 'edge:north',
        radius: 3,
        dc: 12,
        passMessage: 'You catch movement in the undergrowth — someone is watching the clearing.',
      },
      {
        kind: 'combat',
        anchor: 'edge:north',
        radius: 2,
      },
    ],
  },

  {
    id: 'bandit_camp',
    name: 'Bandit Camp',
    weight: 1,
    terrain: 'forest',
    features: ['campsites'],
    titles: [
      'Bandit Camp', 'Outlaws at Rest', 'The Camp in the Glade',
    ],
    introductions: [
      "Cookfire smoke threads through the trees. Quiet voices. Whoever's there hasn't seen you yet.",
      "Tethered horses huff softly in the dark. A laugh, cut short. The camp is closer than you thought.",
    ],
    descriptions: [
      "A bandit camp glimpsed through the trees. The AIGM should describe low fires, propped weapons, and an unwary watch — surprise is possible.",
    ],
    objectives: [
      'Drive off or defeat the bandits',
      'Investigate the camp without raising the alarm',
    ],
    completionFlag: 'bandit_camp_resolved',
    enemyPool: ['bandit', 'bandit', 'commoner'],
    enemyCount: [2, 3],
    // Bandits gather AT the campfire; the player approaches through the
    // trees from the south.
    playerAnchors: ['away_from:campfire', 'edge:south'],
    enemyAnchors:  ['campfire', 'edge:north'],
    triggerTemplates: [
      {
        kind: 'log',
        anchor: 'away_from:campfire',
        radius: 4,
        message: 'Smoke drifts between the trees ahead — a fire, voices, the chink of mailed gear.',
      },
      // Stepping into the camp brings the bandits to their feet.
      {
        kind: 'combat',
        anchor: 'campfire',
        radius: 3,
      },
    ],
  },

  {
    id: 'sunken_shore',
    name: 'Sunken Shore',
    weight: 1,
    terrain: 'grassland',
    features: ['coastline'],
    titles: [
      'Sunken Shore', 'The Drowned Wall', 'The Tide-line',
    ],
    introductions: [
      'Salt wind pulls at your cloak. The tide has eaten into the grass shore.',
      "The smell of brine and old earth hangs thick. Somewhere along the waterline, wings stir that shouldn't.",
    ],
    descriptions: [
      'A bleak coastline. Stirges hunt low over the surf; risen things stir in the wet earth. The AIGM should lean into the briny, abandoned atmosphere.',
    ],
    objectives: [
      'Clear the shoreline',
      'Find what the tide brought in',
    ],
    completionFlag: 'sunken_shore_resolved',
    enemyPool: ['stirge', 'stirge', 'skeleton'],
    enemyCount: [2, 3],
    // Party arrives from inland (the dry side away from the water); the
    // undead and stirges crouch along the tide-line at the opposite edge.
    playerAnchors: ['inland', 'edge:south'],
    enemyAnchors:  ['away_from:campfire', 'edge:north'],
    triggerTemplates: [
      {
        kind: 'perception',
        anchor: 'inland',
        dc: 14,
        passMessage: 'The brackish puddles along the shore are rippling — something just below the surface stirred when you came near.',
      },
      {
        kind: 'combat',
        anchor: 'edge:north',
      },
    ],
  },
];
