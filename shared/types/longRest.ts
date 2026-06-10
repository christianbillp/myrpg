/**
 * Long Rest preview + choices.
 *
 * Extracted from the original god-file `shared/types.ts` (now a barrel that
 * re-exports every domain module under `shared/types/`).
 */


/**
 * Server-computed summary of what a Long Rest will restore for the active
 * character. Drives the `LongRestOverlay` — the client renders one row per
 * non-zero delta plus a Wizard spell-prep picker when applicable. The SRD
 * grants every standard benefit (full HP / Hit Dice / spell slots / class
 * features, exhaustion -1); the only authored choice surfaced here is the
 * Wizard's prepared-spell list, which the SRD lets the player rebuild each
 * Long Rest.
 */
export interface LongRestPreview {
  /** HP that will be restored (maxHp − currentHp). */
  hpRestored: number;
  /** Hit Dice the rest will restore — SRD 5.2.1 restores ALL spent Hit Dice. */
  hitDiceRestored: number;
  /** Spell-slot delta to restore per slot level. `spellSlotsRestored[i]` is the change to slot level `i+1`. */
  spellSlotsRestored: number[];
  /** Feature resources to refill: `{ id, name, before, max }` per affected pool. */
  featuresRestored: Array<{ id: string; name: string; before: number; max: number }>;
  /** Whether the player has at least one Exhaustion level to remove. */
  exhaustionReduced: boolean;
  /** Living companions that benefit from the rest (HP restored to full and any
   *  rest-clearable conditions removed). One entry per companion with something
   *  to gain — surfaced on the Long Rest screen so the player sees the party
   *  rest, not just themselves. */
  companionsRestored?: Array<{ id: string; name: string; hpRestored: number; conditionsCleared: string[] }>;
  /** Prepared-spell picker state for prepare-casters (Wizard rebuilds from the
   *  spellbook; Cleric and other `from-class-list` casters rebuild from the
   *  whole class list of castable level). Omitted for non-preparing classes. */
  spellPrep?: {
    /** The pool the player may prepare from — the spellbook (Wizard) or the
     *  full class list of castable level (Cleric). Field name kept for the
     *  client's renderer; not literally a spellbook for `from-class-list`. */
    spellbookSpells: Array<{ id: string; name: string; level: number; school: string }>;
    /** Currently prepared ids. The client seeds the picker with these. */
    currentlyPrepared: string[];
    /** Maximum allowed prepared spells (SRD class Features table, or higher when feats grant extras). */
    maxPrepared: number;
    /** Where the pool comes from, so the client can word the help text. */
    source: 'spellbook' | 'class-list';
  };
}

/** Player-supplied answers to the long-rest preview. Prepare-casters pass their chosen prepared-spell list. */
export interface LongRestChoices {
  preparedSpellPicks?: string[];
}
