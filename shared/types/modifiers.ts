/**
 * Modifier — a single typed contribution a feat, class feature (or, later, an
 * active spell-buff) makes to a character's mechanics. The engine aggregates
 * every active source's modifiers onto `PlayerDef.modifiers`, then resolvers
 * QUERY that list (e.g. `critFloor`, `hasModifierFlag`, `hasAdvantageOn`)
 * instead of branching on specific feat/feature ids. Adding a new modifier of
 * an already-consumed type is therefore pure data — no engine change.
 */
export type Modifier =
  /** Lowers the natural-d20 threshold for a Critical Hit (e.g. 19 / 18). The
   *  effective crit floor is the lowest `min` across all sources. */
  | { type: 'crit-range'; min: number }
  /** A named passive flag a resolver checks for (e.g. 'savage-attacker',
   *  'fighting-style-defense', 'potent-cantrip'). */
  | { type: 'flag'; name: string }
  /** Advantage on a category of d20 test. `key` narrows checks/saves to a
   *  specific ability/skill when present (e.g. on:'check', key:'athletics'). */
  | { type: 'advantage'; on: 'attack' | 'save' | 'check' | 'initiative'; key?: string };
