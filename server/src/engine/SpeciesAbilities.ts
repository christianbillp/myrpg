import { PlayerDef, SpeciesDef } from './types.js';

/** Resource-pool key for the Orc "Relentless Endurance" trait. Active species
 *  abilities with limited uses share the same `player.resources` pool as
 *  class-feature resources, so they seed at session start and refill on rest
 *  through the existing machinery. */
export const RELENTLESS_ENDURANCE_ID = 'relentless-endurance';

function speciesFor(playerDef: PlayerDef, allSpecies: SpeciesDef[]): SpeciesDef | undefined {
  return allSpecies.find((s) => s.id === playerDef.speciesId);
}

/** True when the character's species grants Relentless Endurance (Orc). */
export function hasRelentlessEndurance(playerDef: PlayerDef, allSpecies: SpeciesDef[]): boolean {
  const species = speciesFor(playerDef, allSpecies);
  return !!species?.traits.some((t) => !!t.effects.relentlessEndurance);
}

/** Per-ability maximum-use pools contributed by the character's species —
 *  seeded into `player.resources` at session build and refilled on a Long Rest,
 *  mirroring the class-feature resource model. */
export function speciesAbilityResources(playerDef: PlayerDef, allSpecies: SpeciesDef[]): Record<string, number> {
  const species = speciesFor(playerDef, allSpecies);
  if (!species) return {};
  const out: Record<string, number> = {};
  for (const trait of species.traits) {
    const re = trait.effects.relentlessEndurance;
    if (re?.usesPerLongRest) out[RELENTLESS_ENDURANCE_ID] = re.usesPerLongRest;
  }
  return out;
}

/** Maps an activated species trait to the FeatureDef id that surfaces it as a
 *  player action button. Keyed by the trait's signature effect so the data file
 *  stays the single source of truth for the ability's cost / resource / UI. */
const TRAIT_FEATURE: ReadonlyArray<{ effect: string; featureId: string; minLevel: number }> = [
  { effect: 'dashAsBonusAction', featureId: 'adrenaline-rush', minLevel: 1 },
];

/** Activated-ability FeatureDef ids the character's species grants at its
 *  current level — appended to `defaultFeatureIds` at load (and by the character
 *  builder) so the existing feature button / guard / dispatch pipeline drives
 *  them with no class-feature special-casing. */
export function speciesFeatureIds(playerDef: PlayerDef, allSpecies: SpeciesDef[]): string[] {
  const species = speciesFor(playerDef, allSpecies);
  if (!species) return [];
  const ids: string[] = [];
  for (const trait of species.traits) {
    for (const map of TRAIT_FEATURE) {
      if (trait.effects[map.effect] && (playerDef.level ?? 1) >= map.minLevel) ids.push(map.featureId);
    }
  }
  return ids;
}
