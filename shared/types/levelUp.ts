/**
 * Level-up preview + choices.
 *
 * Extracted from the original god-file `shared/types.ts` (now a barrel that
 * re-exports every domain module under `shared/types/`).
 */

// Cross-domain imports — keep these explicit so the dependency graph is visible.
import type { AbilityKey } from "./classes.js";
import type { PlayerDef } from "./entities.js";

/**
 * Server-computed preview of what a single level-up applies + which choices
 * the player must make. The client fetches one via `GET /game/session/:id/level-up`
 * to render the LevelUpOverlay; on CONFIRM the client POSTs the chosen
 * `LevelUpChoices` back to `POST /game/session/:id/level-up`. The server
 * applies the changes atomically.
 */
export interface LevelUpPreview {
  /** Current level (the level the character is at *before* the level-up). */
  fromLevel: number;
  /** New level the character will reach. Always `fromLevel + 1`. */
  toLevel: number;
  /** Class name (display, taken from `PlayerDef.className`). */
  className: string;
  /** HP delta added to `maxHp` — `fixedHpForClass(className) + conMod`, minimum 1. */
  hpGain: number;
  /** Proficiency bonus before/after. Equal when no change at this level. */
  proficiencyBefore: number;
  proficiencyAfter: number;
  /** Spell-slot deltas, indexed by `spellLevel − 1`. Empty for non-casters or no change. */
  spellSlotDeltas: number[];
  /** Class features the character gains at the new level (id + name + SRD description). */
  newFeatures: Array<{ id: string; name: string; description: string }>;
  /** Player-facing prompts; `LevelUpChoices` must answer every prompt's `kind`. */
  choices: LevelUpChoicePrompt[];
}

/**
 * Discriminated union of every choice prompt the SRD can require at a level
 * boundary. Add new variants here when adding higher-level choice handling
 * (subclass at L3, ASI/Feat at L4, fighting-style upgrade, etc.).
 */
export type LevelUpChoicePrompt =
  | {
      kind: 'scholar-expertise';
      label: string;
      description: string;
      /** Skill ids the player has proficiency in AND that the SRD Scholar feature allows. */
      options: string[];
    }
  | {
      kind: 'wizard-spellbook-add';
      label: string;
      description: string;
      /** Spell ids the player may add. Filtered to wizard spells of a level the
       *  character can cast that aren't already in the spellbook. May be empty
       *  if the player already knows every available option, in which case the
       *  prompt is purely informational and `count` is 0. */
      options: Array<{ id: string; name: string; level: number; school: string }>;
      /** Number of spells the player must add. Typically 2 (Wizard L2+). */
      count: number;
    }
  | {
      kind: 'subclass-choice';
      label: string;
      description: string;
      /** Subclasses authored for the character's class, with their description
       *  surfaced so the picker can preview the playstyle. */
      options: Array<{ id: string; name: string; description: string }>;
    }
  | {
      kind: 'asi-or-feat';
      label: string;
      description: string;
      /** Feats the character is eligible for at this level (filtered server-
       *  side; the picker UI shows id+name+description). */
      featOptions: Array<{ id: string; name: string; description: string }>;
      /** Ability scores the player may increase, with the current value of
       *  each so the picker can grey out anything already at 20. */
      abilityScores: Array<{ key: AbilityKey; current: number }>;
    }
  | {
      kind: 'expertise-pick';
      label: string;
      description: string;
      /** Skill ids the player is currently proficient in (so Expertise can
       *  stack PB on them). Computed server-side from the character's
       *  pre-baked skill totals vs ability mod. */
      options: string[];
      /** How many skills the player must promote to Expertise (Rogue L1 / L6
       *  both grant 2). */
      count: number;
    }
  | {
      kind: 'fighting-style-pick';
      label: string;
      description: string;
      /** Fighting Style feat ids the player may take. Excludes any the
       *  character already has — Fighting Style can be swapped on later
       *  level-up but not duplicated. */
      options: Array<{ id: string; name: string; description: string }>;
    };

/** Player-supplied answers to a `LevelUpPreview`. Each chosen value matches
 *  its prompt's `kind`. Optional because not every level surfaces every
 *  prompt — the engine validates that every prompt the preview surfaces
 *  has a matching answer. */
export interface LevelUpChoices {
  scholarExpertise?: string;
  wizardSpellbookAdd?: string[];
  /** Subclass id picked at L3 (or whenever the parent class fires its
   *  `subclass-choice` template). Stored on `playerDef.subclassId` by the
   *  handler so subclass progression entries fire on subsequent levels. */
  subclassChoice?: string;
  /** Answer to the ASI-or-Feat prompt (every L4 / L8 / L12 / L16, plus
   *  Fighter L6 / L14 and class-19 boons). One of three shapes:
   *  - `{ kind: 'asi-plus-2', ability }` — +2 to a single ability (max 20).
   *  - `{ kind: 'asi-plus-1', abilities: [a, b] }` — +1 to two abilities.
   *  - `{ kind: 'feat', featId }` — take a feat instead of an ASI. */
  asiOrFeat?:
    | { kind: 'asi-plus-2'; ability: AbilityKey }
    | { kind: 'asi-plus-1'; abilities: [AbilityKey, AbilityKey] }
    | { kind: 'feat'; featId: string };
  /** Rogue Expertise picks. The handler stacks PB on each named skill so the
   *  total = ability mod + 2 * PB after this level-up. */
  expertisePick?: string[];
  /** Fighting Style feat id chosen at Fighter L1 or any later level-up that
   *  surfaces the prompt (Champion L7 Additional Fighting Style). */
  fightingStylePick?: string;
}
