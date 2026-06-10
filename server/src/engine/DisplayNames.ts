/**
 * Display-name helpers — a LEAF module (imports only shared types) so log /
 * UI naming can be used anywhere in the engine without pulling in the combat
 * flow. `combatantDisplayName` lived in `CombatFlow` historically, which made
 * that file the hub of half a dozen import cycles.
 */
import type { NpcState } from './types.js';

/**
 * The display name for turn-bar / combat-log lines: bare name when unique,
 * "Name (Label)" when more than one non-neutral NPC in the encounter shares
 * the base name and this one has a combat label.
 */
export function combatantDisplayName(npc: NpcState, allNpcs: NpcState[]): string {
  const base = npc.revealedName ?? npc.name;
  const duplicates = allNpcs.filter((n) => (n.revealedName ?? n.name) === base && n.disposition !== 'neutral').length;
  if (duplicates > 1 && npc.combatLabel) return `${base} (${npc.combatLabel})`;
  return base;
}
