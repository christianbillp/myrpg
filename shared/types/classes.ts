/**
 * Class-feature payloads + ClassDef / SubclassDef.
 *
 * Extracted from the original god-file `shared/types.ts` (now a barrel that
 * re-exports every domain module under `shared/types/`).
 */

// Cross-domain imports — keep these explicit so the dependency graph is visible.
import type { LevelUpChoicePrompt } from "./levelUp.js";

//
// Features are class abilities described as data + handler. Each character
// references a set of feature ids via `defaultFeatureIds`; at session start
// the engine initializes any pooled resources from the feature definitions.
// A FeatureRegistry on the server maps `handler` ids to TypeScript functions
// that execute the mechanical effect.

export type FeatureCostKind = 'action' | 'bonus-action' | 'reaction' | 'free' | 'attack-time' | 'passive';

export interface FeatureCost {
  kind: FeatureCostKind;
  /** Free-form trigger description for reactive features (e.g. "when hit by an attack roll"). */
  trigger?: string;
}

/**
 * Resource pool consumed by the feature. `max` is the starting / refilled value;
 * `kind` determines when it refills:
 *   - 'uses-per-long-rest'  : refilled on Long Rest (new encounter)
 *   - 'uses-per-short-rest' : refilled on Short Rest
 *   - 'pool'                : like uses-per-long-rest but the amount can vary (e.g. Lay on Hands)
 *   - 'unlimited'           : no resource (button always usable subject to action economy)
 */
export type FeatureResourceKind = 'uses-per-long-rest' | 'uses-per-short-rest' | 'pool' | 'unlimited';

export interface FeatureResource {
  kind: FeatureResourceKind;
  /** The starting / refill value. Constant for L1 features; future fields can compute from level. */
  max: number;
}

export interface FeatureUI {
  /** Display label on the action button. Omit for passive/attack-time features (no button). */
  buttonLabel?: string;
  /** Button background colour. Defaults to a class-button blue if omitted. */
  buttonColor?: string;
  /** Optional template for the resource chip in the Player Panel: "{name}: {remaining}/{max}". Use `{remaining}` and `{max}` placeholders. */
  resourceLabel?: string;
}

export interface FeatureDef {
  id: string;
  name: string;
  /** Class this feature belongs to (e.g. "fighter"). Display-only — no class registry yet. */
  classId: string;
  /** Minimum class level required for the character to know this feature. */
  minLevel: number;
  description: string;
  cost: FeatureCost;
  resource?: FeatureResource;
  ui?: FeatureUI;
  /**
   * Mechanic-handler key, looked up in the server-side FeatureRegistry. When
   * omitted, the feature is "data-only" — passive, ambient, or applied at
   * character-load (Unarmored Defense, Expertise, etc.).
   */
  handler?: string;
}

// ── Class definitions ────────────────────────────────────────────────────────
//
// SRD 5.2.1 class advancement encoded as data. The engine reads
// `server/data/classes/*.json` at boot and drives the level-up resolver,
// character build defaults, and resource-pool scaling off these. Subclasses
// live in `server/data/subclasses/*.json` and reference their parent class
// via `classId`; the engine walks both progression arrays at each level.

export type AbilityKey = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';

/** A per-level scaling value. `number` covers counts/feet/points; `string`
 *  covers dice expressions like `"1d6"` for Monk Martial Arts or Bard Bardic
 *  Die. The engine parses the dice form lazily — for arithmetic uses you'd
 *  still want numbers. */
export type TrackValue = number | string;

/** Track values that scale from an ability mod (Bardic Inspiration uses) or
 *  proficiency bonus (Druid Wild Companion). Resolved at level-up and on stat
 *  changes — the resolver substitutes the live value. Used when a per-level
 *  array would be wrong because the value depends on the character's stats. */
export type ClassResourceFormula =
  | { kind: 'ability-mod'; ability: AbilityKey; min?: number }
  | { kind: 'proficiency-bonus'; min?: number }
  | { kind: 'class-level'; multiplier?: number; offset?: number };

/** Per-level class spellcasting metadata. The two discriminators
 *  (`slotTableKind`, `learnModel`) cover every shape the SRD ships:
 *
 *  | Class                      | slotTableKind | learnModel        | recovery   |
 *  |----------------------------|---------------|-------------------|------------|
 *  | Wizard                     | full          | spellbook         | long-rest  |
 *  | Cleric / Druid / Bard      | full          | from-class-list   | long-rest  |
 *  | Sorcerer                   | full          | known             | long-rest  |
 *  | Paladin / Ranger           | half          | from-class-list   | long-rest  |
 *  | Warlock                    | pact-magic    | known             | short-rest |
 *  | Fighter / Rogue / Barb /…  | none          | innate            | (n/a)      | */
export interface ClassSpellcasting {
  ability: AbilityKey;
  slotTableKind: 'full' | 'half' | 'pact-magic' | 'none';
  learnModel: 'spellbook' | 'from-class-list' | 'known' | 'innate';
  recovery?: 'long-rest' | 'short-rest';
  /** Cosmetic — what the caster channels through. */
  focus?: string[];
  /** "always-prepared" (Wizard Ritual Adept): ritual tag spells can be cast
   *  from spellbook without preparing. "ritual-only" (Cleric/Druid/Bard):
   *  ritual tag spells are cast normally, just slower. "none": no ritual rule. */
  ritual?: 'always-prepared' | 'ritual-only' | 'none';
  /** 20-element array. Index by `level - 1`. */
  cantripsKnownByLevel?: number[];
  /** 20-element array — number of L1+ spells the caster can hold prepared. */
  preparedSpellsByLevel?: number[];
  /** 20-element array — number of L1+ spells the caster permanently "knows"
   *  (Sorcerer / Warlock). Mutually exclusive with `preparedSpellsByLevel`. */
  spellsKnownByLevel?: number[];
  /** Outer index = level-1; inner = slot-level-1. For half-casters the inner
   *  array is shorter (5 entries). Omitted for `slotTableKind: 'none'` and
   *  `'pact-magic'` (use `pactMagic` block instead). */
  spellSlotsByLevel?: number[][];
  /** Warlock Pact Magic — few same-level slots that refresh on Short Rest. */
  pactMagic?: {
    /** Number of pact slots at each character level. */
    slotsByLevel: number[];
    /** Spell level of every pact slot at each character level. */
    slotLevelByLevel: number[];
  };
  /** Warlock Mystic Arcanum — one L6/7/8/9 spell unlocked at the listed
   *  levels, each used once per Long Rest, not a slot. */
  mysticArcanum?: {
    atLevels: number[];
    spellLevels: number[];
  };
  /** Wizard-only — starting spellbook size at L1. */
  initialSpellbookSize?: number;
  /** Wizard-only — spells added to the spellbook on each level after 1. */
  spellbookGrowthPerLevel?: number;
  /** Most full casters can swap one cantrip on a Long Rest / level-up. */
  cantripSwapPerLevel?: boolean;
  /** Per-level swap allowance for known/prepared lists (Sorcerer = 1, Bard L10
   *  Magical Secrets adds more on specific levels via choices). */
  spellSwapPerLevel?: number;
}

/** Authored choice template stored in class/subclass JSONs. At level-up the
 *  resolver expands each template into a fully-populated `LevelUpChoicePrompt`
 *  (filling in `options` from the live character + game defs). Keeping the
 *  templates separate from the runtime prompt keeps JSONs static and lets the
 *  options list change as content grows (new feats, new spells, etc.). */
export type LevelUpChoiceTemplate =
  | { kind: 'scholar-expertise' }
  | { kind: 'wizard-spellbook-add'; count?: number }
  | { kind: 'asi-or-feat' }
  | { kind: 'subclass-choice' }
  | { kind: 'cantrip-known'; count?: number }
  | { kind: 'cantrip-swap' }
  | { kind: 'spell-swap'; count?: number }
  | { kind: 'expertise-pick'; count: number }
  | { kind: 'fighting-style-pick' }
  | { kind: 'metamagic-pick'; count: number }
  | { kind: 'invocation-pick'; count: number }
  | { kind: 'mystic-arcanum-pick'; spellLevel: number }
  | { kind: 'magical-secrets-pick'; count: number }
  | { kind: 'epic-boon-choice' };

/** A single entry in `ClassDef.progression` — what happens when the character
 *  reaches the given level. Features list ids that must exist in
 *  `defs.features`. `choices` are templates the resolver expands into runtime
 *  prompts surfaced by the LevelUpOverlay; their kinds map to handlers in
 *  `LevelUpChoiceHandlers.ts`. `subclass: true` marks levels at which the
 *  chosen subclass's own progression entry should fire. */
export interface ClassProgressionEntry {
  level: number;
  features?: string[];
  subclass?: boolean;
  choices?: LevelUpChoiceTemplate[];
}

export interface ClassDef {
  id: string;
  name: string;
  description: string;
  primaryAbility: AbilityKey[];
  /** Hit Point Die (Wizard = 6, Fighter = 10, …). Used for HP rolls; the
   *  engine uses `fixedHpPerLevel` for level-up so this is informational. */
  hitDie: number;
  /** SRD "Fixed Hit Points by Class" — added to CON mod on each level-up. */
  fixedHpPerLevel: number;
  savingThrows: AbilityKey[];
  skillChoices: { count: number; options: string[] };
  weaponProficiencies: string[];
  armorTraining: string[];
  toolProficiencies: string[];
  /** Class levels at which the chosen subclass grants a feature. Mirrors
   *  the subclass's `progression[].level` values so the level-up resolver
   *  knows when to look up subclass content. */
  subclassLevels: number[];
  spellcasting?: ClassSpellcasting;
  /** Per-level scaling values — every count/die/distance that varies with
   *  level lives here. Keys are class-specific track ids (e.g.
   *  `"sneak-attack-dice"`, `"second-wind-uses"`, `"martial-arts-die"`,
   *  `"rage-damage"`, `"unarmored-movement-feet"`). Engine consumers read
   *  via `trackAt(classDef, trackId, level)`. */
  tracksByLevel?: Record<string, TrackValue[]>;
  /** Tracks whose value can't be encoded as a per-level array because they
   *  depend on the live character (Bardic Inspiration uses = max(1, CHA mod)). */
  trackFormulas?: Record<string, ClassResourceFormula>;
  progression: ClassProgressionEntry[];
}

/** A single per-level entry for a subclass. Mirrors `ClassProgressionEntry`
 *  but adds the always-prepared spell lists granted by Domains / Oaths /
 *  Circles / Patrons (which extend the prepared list without counting toward
 *  the prep cap). */
export interface SubclassProgressionEntry {
  level: number;
  features?: string[];
  /** Spells that become always-prepared once this level is reached. */
  grantedSpells?: string[];
  /** Cantrips that become permanently known once this level is reached. */
  grantedCantrips?: string[];
  /** Per-level tracks the subclass overrides or adds (e.g. an Eldritch
   *  Invocation-style scaling). */
  tracksByLevel?: Record<string, TrackValue[]>;
}

export interface SubclassDef {
  id: string;
  classId: string;
  name: string;
  description: string;
  progression: SubclassProgressionEntry[];
  /** Some subclasses graft spellcasting onto an otherwise-non-caster class
   *  (Eldritch Knight, Arcane Trickster). When present this block overrides
   *  the class's own `spellcasting` for affected characters. Not used by any
   *  SRD 5.2.1 subclass we ship today but the engine honours it. */
  spellcasting?: ClassSpellcasting;
  /** When this subclass uses a different class's spell list (Eldritch Knight
   *  → Wizard, Arcane Trickster → Wizard), name the source class. */
  spellListClassId?: string;
}
