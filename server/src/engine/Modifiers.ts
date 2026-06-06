/**
 * Modifier aggregator — the single layer that turns a character's feats + class
 * features into a flat list of typed `Modifier`s on `PlayerDef.modifiers`, then
 * answers typed queries about it. Resolvers call the query helpers
 * (`critFloor`, `hasModifierFlag`, `hasAdvantageOn`) instead of branching on
 * specific feat/feature ids, so a new passive that fits an existing modifier
 * type is pure data — drop `modifiers: [...]` on the feat/feature JSON.
 */
import type { PlayerDef, FeatDef, FeatureDef, Modifier } from './types.js';

/** Gather every modifier the character's feats + known class features grant. */
export function collectModifiers(playerDef: PlayerDef, feats: FeatDef[], features: FeatureDef[]): Modifier[] {
  const featById = new Map(feats.map((f) => [f.id, f]));
  const featureById = new Map(features.map((f) => [f.id, f]));
  const out: Modifier[] = [];
  for (const id of playerDef.featIds ?? []) out.push(...(featById.get(id)?.modifiers ?? []));
  for (const id of playerDef.defaultFeatureIds ?? []) out.push(...(featureById.get(id)?.modifiers ?? []));
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
