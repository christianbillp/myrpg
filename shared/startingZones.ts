/**
 * Starting-zone GIDs — the per-cell values used by `EncounterDef.startingZones.data`
 * to mark spawn regions on the map. The values are persisted in JSON files and
 * surfaced to the AI map generator's tool schema, so they MUST remain stable.
 *
 * Encoded as a flat row-major array of values in 0..4, length = width × height.
 * The engine uses this layer to resolve per-disposition spawn positions in
 * `SessionBuilder.parseStartingZones` and is the only place these magic numbers
 * should be hard-coded outside of validation.
 */

export const STARTING_ZONE_NONE     = 0;
export const STARTING_ZONE_PLAYER   = 1;
export const STARTING_ZONE_ALLY     = 2;
export const STARTING_ZONE_NEUTRAL  = 3;
export const STARTING_ZONE_ENEMY    = 4;

export type StartingZoneValue =
  | typeof STARTING_ZONE_NONE
  | typeof STARTING_ZONE_PLAYER
  | typeof STARTING_ZONE_ALLY
  | typeof STARTING_ZONE_NEUTRAL
  | typeof STARTING_ZONE_ENEMY;

/** Maps the numeric zone GID to the single-letter token used by `parseStartingZones`. */
export const ZONE_LETTER: Record<StartingZoneValue, '' | 'P' | 'A' | 'N' | 'E'> = {
  [STARTING_ZONE_NONE]: '',
  [STARTING_ZONE_PLAYER]: 'P',
  [STARTING_ZONE_ALLY]: 'A',
  [STARTING_ZONE_NEUTRAL]: 'N',
  [STARTING_ZONE_ENEMY]: 'E',
};
