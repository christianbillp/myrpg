/**
 * In-combat barks — short, flavorful one-liners NPCs call out during a fight,
 * tied to what they're DOING (attacking, fleeing, surrendering) and to impactful
 * MOMENTS (taking damage, being bloodied, dying). Distinct from ambient banter
 * (US-129, NPC-to-NPC exchanges during exploration): barks are single lines
 * fired by combat events, surfaced through the same `npc_speech` bubble + Event
 * Log channel. Pure flavour — no mechanical effect.
 *
 * A *bark pack* is a pool of interchangeable lines for one trigger, optionally
 * scoped to a faction / def / creature-type so a bandit taunts and a skeleton
 * rasps. The engine picks one line per fired trigger, sparsely (per-round
 * cooldown for frequent triggers; impactful one-shots always fire).
 */

/** The combat moment a bark reacts to. */
export type BarkTrigger =
  | 'attack'      // the NPC makes an attack
  | 'damaged'     // the NPC takes a hit (gated — once per round)
  | 'bloodied'    // the NPC drops to half HP (one-shot)
  | 'death'       // the NPC is killed (one-shot)
  | 'flee'        // the NPC breaks and runs (morale)
  | 'surrender';  // the NPC throws down its arms (morale)

/**
 * A pool of lines for one trigger. The optional selectors are AND-combined:
 * every present selector must match the barking NPC; absent selectors don't
 * constrain. A pack with no selectors is a generic fallback.
 */
export interface CombatBarkPack {
  id: string;
  trigger: BarkTrigger;
  /** At least one of these faction ids must be the NPC's faction. */
  factions?: string[];
  /** The NPC's `defId` must be one of these. */
  defIds?: string[];
  /** Substring match against the creature's `MonsterDef.type` (e.g. "humanoid",
   *  "undead") — case-insensitive. */
  types?: string[];
  /** Interchangeable lines; one is picked per fired trigger. */
  lines: string[];
}
