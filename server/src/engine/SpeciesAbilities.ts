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
