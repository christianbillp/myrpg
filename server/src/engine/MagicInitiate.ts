/**
 * SRD Magic Initiate — the feat's level-1 spell is "always prepared" and can be
 * cast once without a spell slot, regaining that free cast on a Long Rest (it
 * can also be cast with a normal slot). The free cast is modelled as a generic
 * `player.resources` pool keyed per spell, seeded at session build, refilled on
 * a Long Rest, and consumed by the cast path when no slot is spent.
 *
 * `PlayerDef.magicInitiateSpellIds` lists the granted spells; the feat's two
 * cantrips fold into `defaultCantripIds` at build time (CharacterBuilder).
 */
import type { PlayerDef } from '../../../shared/types.js';

const PREFIX = 'magic-initiate:';

/** Resource id for a Magic Initiate spell's once-per-Long-Rest free cast. */
export function magicInitiateResourceId(spellId: string): string {
  return `${PREFIX}${spellId}`;
}

/** Whether `spellId` is one of this character's Magic Initiate spells. */
export function isMagicInitiateSpell(playerDef: PlayerDef, spellId: string): boolean {
  return playerDef.magicInitiateSpellIds?.includes(spellId) ?? false;
}

/** The free-cast resource pool (`{ "magic-initiate:<spellId>": 1 }`) for every
 *  Magic Initiate spell the character has. SRD grants one free cast per Long
 *  Rest per instance of the feat. Empty when the character has none. */
export function magicInitiateResources(playerDef: PlayerDef): Record<string, number> {
  const out: Record<string, number> = {};
  for (const spellId of playerDef.magicInitiateSpellIds ?? []) {
    out[magicInitiateResourceId(spellId)] = 1;
  }
  return out;
}
