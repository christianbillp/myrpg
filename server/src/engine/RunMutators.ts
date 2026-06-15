/**
 * Run mutators (Tactical Crucible #29) — the pure math behind the opt-in
 * challenge knobs declared on `EncounterDef.mutators` and carried on
 * `GameState.mutators`. Each knob is read by exactly one resolver:
 *   • `scaledEnemyHp`        — `SessionBuilder`, at enemy spawn ("Tougher Foes").
 *   • `scaledIncomingDamage` — `GameEngine.applyDamageToPlayer` ("Deadly").
 *
 * Centralised here so the modifiers compose in one place and stay trivially
 * testable, rather than as inline arithmetic scattered across the engine.
 */
import type { RunMutators } from './types.js';

/** A multiplier that should actually change the value: present, positive, ≠ 1. */
function activeMult(mult: number | undefined): number | null {
  return mult && mult > 0 && mult !== 1 ? mult : null;
}

/** Enemy max/current HP after the `enemyHpMult` knob (min 1). Unchanged when no
 *  mutator applies. */
export function scaledEnemyHp(baseHp: number, mutators: RunMutators | undefined): number {
  const mult = activeMult(mutators?.enemyHpMult);
  return mult ? Math.max(1, Math.round(baseHp * mult)) : baseHp;
}

/** Incoming player damage after the `incomingDamageMult` knob (min 0). Unchanged
 *  when no mutator applies. */
export function scaledIncomingDamage(damage: number, mutators: RunMutators | undefined): number {
  const mult = activeMult(mutators?.incomingDamageMult);
  return mult ? Math.max(0, Math.round(damage * mult)) : damage;
}
