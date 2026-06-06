/**
 * Modifier aggregator — the single layer that turns a character's feats + class
 * features into a flat list of typed `Modifier`s on `PlayerDef.modifiers`, then
 * answers typed queries about it. Resolvers call the query helpers
 * (`critFloor`, `hasModifierFlag`, `hasAdvantageOn`) instead of branching on
 * specific feat/feature ids, so a new passive that fits an existing modifier
 * type is pure data — drop `modifiers: [...]` on the feat/feature JSON.
 */
import type { PlayerDef, FeatDef, FeatureDef, Modifier, ModifierSource } from './types.js';

/** Push the modifiers of every source named by `ids` onto `out`. Feats and
 *  class features are both `ModifierSource`s, so this is identical for either. */
function collectFrom(out: Modifier[], sources: ModifierSource[], ids: string[] | undefined): void {
  if (!ids?.length) return;
  const byId = new Map(sources.map((s) => [s.id, s]));
  for (const id of ids) out.push(...(byId.get(id)?.modifiers ?? []));
}

/** Gather every modifier the character's feats + known class features grant. */
export function collectModifiers(playerDef: PlayerDef, feats: FeatDef[], features: FeatureDef[]): Modifier[] {
  const out: Modifier[] = [];
  collectFrom(out, feats, playerDef.featIds);
  collectFrom(out, features, playerDef.defaultFeatureIds);
  // US-108: species/background origin modifiers (e.g. save advantages) are
  // seeded onto `originModifiers` by `applySpecies` and merged here so they
  // sit alongside feat/feature modifiers regardless of pass ordering.
  if (playerDef.originModifiers) out.push(...playerDef.originModifiers);
  return out;
}

/**
 * Compute and store the character's aggregated modifiers, then derive the two
 * legacy projected booleans the equipment math still reads — so AC / attack
 * results are unchanged, now sourced from the unified modifier list. Replaces
 * the old `applyFeats`.
 */
export function applyModifiers(playerDef: PlayerDef, feats: FeatDef[], features: FeatureDef[]): void {
  playerDef.modifiers = collectModifiers(playerDef, feats, features);
  playerDef.savageAttacker = hasModifierFlag(playerDef, 'savage-attacker');
  playerDef.fightingStyleDefense = hasModifierFlag(playerDef, 'fighting-style-defense');
}

const modifiersOf = (playerDef: PlayerDef): Modifier[] => playerDef.modifiers ?? [];

/** Lowest natural-d20 roll that scores a Critical Hit (20 by default). */
export function critFloor(playerDef: PlayerDef): number {
  let floor = 20;
  for (const m of modifiersOf(playerDef)) if (m.type === 'crit-range' && m.min < floor) floor = m.min;
  return floor;
}

/** Whether any active source contributes the named passive flag. */
export function hasModifierFlag(playerDef: PlayerDef, name: string): boolean {
  return modifiersOf(playerDef).some((m) => m.type === 'flag' && m.name === name);
}

/** Whether any source grants Advantage on the given d20-test category (with an
 *  optional ability/skill key for checks/saves). */
export function hasAdvantageOn(playerDef: PlayerDef, on: 'attack' | 'save' | 'check' | 'initiative', key?: string): boolean {
  return modifiersOf(playerDef).some((m) => m.type === 'advantage' && m.on === on && (key === undefined || m.key === key));
}
