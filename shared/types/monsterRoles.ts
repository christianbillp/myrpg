/**
 * Monster combat roles (Tactical Crucible #35) — the tactical archetype that
 * drives an enemy's positioning and target priority. Grounded in the SRD
 * bestiary's recurring patterns (brutes, skirmishers, artillery, controllers,
 * leaders, support). See `design/systems/enemy-roles.md`.
 *
 * `soldier` is the neutral default (balanced melee, target the nearest — today's
 * behavior). v1 implements behavior for `brute`, `skirmisher`, `artillery`, and
 * `leader`; `controller` and `support` are reserved for v2 and currently behave
 * as `soldier`.
 */
export type MonsterRole =
  | 'soldier'      // balanced; target nearest; advance & fight (default)
  | 'brute'        // charge; focus the most-wounded; never retreat
  | 'skirmisher'   // mobile; hold its weapon's range; hit-and-run
  | 'artillery'    // ranged/caster; target the squishiest backline; keep distance
  | 'controller'   // (v2) grapple/disable a key target, then stick to it
  | 'leader'       // commands & anchors morale; allies hold while it lives
  | 'support';     // (v2) heal/buff allies from the back
