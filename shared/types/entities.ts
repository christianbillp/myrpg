/**
 * PlayerDef / MonsterDef / NPCDef + the action and effect shapes hung off them.
 *
 * Extracted from the original god-file `shared/types.ts` (now a barrel that
 * re-exports every domain module under `shared/types/`).
 */

// Cross-domain imports — keep these explicit so the dependency graph is visible.
import type { ClassDef, SubclassDef } from "./classes.js";
import type { EncounterDef } from "./encounter.js";
import type { Modifier } from "./modifiers.js";
import type { Disposition, PlayerState } from "./gameState.js";
import type { NpcSave } from "./npcSave.js";
import type { SpellcastingAbility } from "./spells.js";

/**
 * SRD creature sizes (`Monsters_Header.md`, `Species_All.md`), ordered smallest
 * to largest. Size gates Grapple/Shove eligibility ("no more than one size
 * larger"), Squeezing, breath weapons, and mounts. Players derive it from their
 * species; monsters parse it from the leading token of their free-text `type`
 * string at load time. Always populated by the load/seed path — typed optional
 * only to tolerate old saves and partial fixtures (mirrors `senses`).
 */
export type CreatureSize = 'tiny' | 'small' | 'medium' | 'large' | 'huge' | 'gargantuan';

export const SIZE_ORDER: readonly CreatureSize[] = [
  'tiny', 'small', 'medium', 'large', 'huge', 'gargantuan',
];

/** Index of a size in `SIZE_ORDER`; the difference between two ranks is the
 *  "how many sizes apart" used by the Grapple/Shove one-size-larger gate. */
export function sizeRank(size: CreatureSize): number {
  return SIZE_ORDER.indexOf(size);
}

/**
 * Parse a `CreatureSize` from a monster stat-block `type` string such as
 * `"Medium or Small Humanoid, Neutral"` or `"Tiny Construct, Unaligned"` — the
 * size is the leading word. For a disjunction ("Medium or Small") the first
 * (larger) listed size wins, deterministically. Falls back to `'medium'` when
 * no size token is recognised.
 */
export function parseCreatureSize(raw: string | null | undefined): CreatureSize {
  const token = (raw ?? '').trim().toLowerCase().split(/[^a-z]+/)[0];
  return (SIZE_ORDER as readonly string[]).includes(token)
    ? (token as CreatureSize)
    : 'medium';
}

/**
 * SRD "Bloodied" (US-109, `Bloodied.md`): a creature is Bloodied while it has
 * **half its Hit Points or fewer remaining**. A creature at 0 HP (dead /
 * dying) is not considered Bloodied. Derived on demand from current HP rather
 * than stored, so it can never drift out of sync.
 */
export function isBloodied(hp: number, maxHp: number): boolean {
  return hp > 0 && hp <= maxHp / 2;
}

/**
 * A secondary damage component riding along with an attack. Used for SRD
 * attacks like the Cultist's *Ritual Sickle* (1d4+1 slashing **+ 1 necrotic**)
 * or Cockatrice's beak (piercing + petrification). Each component rolls its
 * own dice, applies its own damage type through the resistance / vulnerability
 * / immunity lookup, and contributes a distinct log line. On a crit the dice
 * double (matching SRD), the flat bonus does not.
 */
export interface BonusDamage {
  dice: number;
  sides: number;
  bonus: number;
  damageType: string;
}

/**
 * The result of rolling a single bonus-damage rider on an attack — the value
 * resolvers thread through to callers so each rider gets applied with its own
 * per-type resistance lookup and log line.
 */
export interface RolledBonusDamage {
  damage: number;
  damageType: string;
  /** Log-table right-hand side, e.g. `1d4[3]+0`. */
  rollStr: string;
}

/** One resolved extra attack from a Multiattack (US-112) — a separate roll
 *  beyond the primary, applied by the caller after the primary (and after any
 *  Shield reaction the primary triggers). */
export interface ExtraAttack {
  damage: number;
  isHit: boolean;
  isCrit: boolean;
  damageType: string;
  bonusComponents: RolledBonusDamage[];
}

export interface PlayerAttack {
  name: string;
  statKey: 'str' | 'dex';
  damageDice: number;
  damageSides: number;
  damageType: string;
  /** Optional secondary damage riders applied alongside the primary roll. */
  bonusDamage?: BonusDamage[];
  savageAttacker: boolean;
  /** Finesse weapon (Daggers, Rapiers, Scimitars, …). Lets DEX replace STR
   *  for attack and damage rolls (`makePlayerAttack` already picks the
   *  higher mod) — and qualifies the weapon for Sneak Attack. */
  finesse: boolean;
  graze: boolean;
  vex: boolean;
  sap: boolean;
  slow: boolean;
  /** Push mastery — on hit, the attacker can shove the target 10 ft away. */
  push: boolean;
  /** Topple mastery — on hit, target makes a Con save or falls Prone. */
  topple: boolean;
  // Ranged-weapon fields. Absence of rangeNormal means melee (5 ft / 1 tile reach).
  // For ranged weapons, rangeNormal/rangeLong are in feet (1 tile = 5 ft); beyond
  // normal range imposes Disadvantage, beyond long range cannot fire.
  rangeNormal?: number;
  rangeLong?: number;
  ammunitionType?: string;  // e.g. "arrow", "bolt" — consumed from inventory per shot
  loading?: boolean;        // SRD Loading property — one shot per Action/Bonus/Reaction
  heavy?: boolean;          // SRD Heavy property — Disadvantage if DEX < 13 (ranged) or STR < 13 (melee) (US-111)
  reach?: boolean;          // SRD Reach property — melee reach is 10 ft (2 tiles) instead of 5 (US-111)
  /** SRD Magic Weapon spell — flat bonus to attack and damage rolls while
   *  the spell is active. Written by `applyEquipment` when the player's
   *  `PlayerState.magicWeaponBonus > 0`; read by `resolvePlayerAttack`.
   *  Absent when the spell is not active. */
  magicWeaponBonus?: number;
}

export interface EquipmentSlots {
  armorId: string | null;
  weaponId: string | null;
  shieldId: string | null;
}

export interface PlayerDef {
  id: string;
  name: string;
  speciesName: string;
  speciesId: string;
  speciesLineage: string | null;
  className: string;
  backgroundId: string;
  featIds: string[];
  level: number;
  maxHp: number;
  ac: number;
  str: number; dex: number; con: number; int: number; wis: number; cha: number;
  proficiencyBonus: number;
  skills: Record<string, number>;
  savingThrowProficiencies: string[];
  savingThrows: Record<string, number>;
  /** Ids of class features this character knows (e.g. `["second-wind"]` for Fighter L1). Features grant resource pools, action buttons, and effect handlers — see `features/`. */
  defaultFeatureIds?: string[];
  hitDieType: number;
  sneakAttackDice: number;
  speed: number;
  /** Special senses (SRD): darkvision / blindsight / tremorsense / truesight.
   *  Seeded from species traits when the character is built. Absent means
   *  "normal sight only". Read by `Vision.canSee` and the Hide gate. */
  senses?: Senses;
  /** SRD creature size, seeded from species at session build (US-107).
   *  Defaults to `'medium'` when the species declares none. */
  size?: CreatureSize;
  /** Damage types this character resists / is vulnerable to / is immune to
   *  (US-108). Seeded from species traits (`damageResistance`) at session build
   *  and read by the player damage path (`GameEngine.applyDamageToPlayer`),
   *  mirroring the monster resistance lookup. Immunity > vulnerability >
   *  resistance. Lowercase damage-type strings ("poison", "fire", …). */
  resistances?: string[];
  vulnerabilities?: string[];
  immunities?: string[];
  /** Typed modifiers derived from species/background origin traits (US-108) —
   *  e.g. Advantage on saves vs Poisoned (Dwarf), Advantage on INT saves
   *  (Gnome). Concatenated into the aggregated `modifiers` list by
   *  `collectModifiers`, so resolvers query them via `hasAdvantageOn` exactly
   *  like feat/feature modifiers. Kept separate from `modifiers` so the species
   *  pass and the feat/feature pass (`applyModifiers`) don't clobber each other
   *  regardless of call order. */
  originModifiers?: Modifier[];
  /** SRD Halfling "Luck": a natural 1 on any of this character's D20 Tests is
   *  rerolled once and the new die must be used. Set by `applySpecies` from the
   *  species `rerollD20OnesOnTests` trait; read at every player d20 roll site
   *  via `applyHalflingLuck`. */
  halflingLuck?: boolean;
  color: number;
  xp: number;
  /** Known languages (US-123). Common + the two Standard languages chosen at
   *  creation + any feature grants (Thieves' Cant, Druidic, …). Optional so
   *  characters authored before US-123 load without migration. */
  languages?: string[];
  /** Typed modifiers aggregated from this character's feats + class features at
   *  load (`Modifiers.applyModifiers`). Resolvers query this (crit floor,
   *  passive flags, advantage sources) instead of branching on feat/feature
   *  ids. `savageAttacker` / `fightingStyleDefense` below are legacy projections
   *  derived from it for the equipment math. */
  modifiers?: Modifier[];
  savageAttacker: boolean;
  fightingStyleDefense: boolean;
  defaultEquipment: EquipmentSlots;
  defaultInventoryIds: string[];
  /** Starting coin purse this character spawns with, denominated in Copper
   *  Pieces (SRD: 1 GP = 100 CP, 1 SP = 10 CP). Defaults to 0 when omitted. */
  defaultCp?: number;
  // ── Spellcasting (optional — omit for non-casters) ──────────────────────────
  /** INT / WIS / CHA. Drives spell save DC, attack bonus, and damage-mod adds. */
  spellcastingAbility?: SpellcastingAbility;
  /** Always-known cantrips (level 0 spells). Cantrips are not prepared and do not consume slots. */
  defaultCantripIds?: string[];
  /** Full known list (wizard's spellbook). Subset is "prepared" at any time. */
  defaultSpellbookIds?: string[];
  /** Subset of `defaultSpellbookIds` (or fixed-list classes) currently castable. */
  defaultPreparedSpellIds?: string[];
  /** Starting spell slots, indexed by `spell.level − 1`. e.g. `[2]` = 2 × L1, no higher slots. */
  defaultSpellSlots?: number[];
  mainAttack: PlayerAttack;
  /** One-line tagline shown on the character carousel selector card. */
  shortDescription?: string;
  description?: string;
  /** Path to the SVG used as this character's token sprite. Required — every
   *  character JSON must declare its token explicitly (no naming-convention
   *  fallback). */
  tokenAsset: string;
  /** Per-character scaling track values resolved from `ClassDef.tracksByLevel`
   *  at each level-up. Engine subsystems consult this map instead of
   *  hard-coded class knowledge — e.g. the attack resolver reads
   *  `tracks['extra-attacks']` to decide the loop count, the Rogue resolver
   *  reads `tracks['sneak-attack-dice']`. Per-feature use pools (Second Wind
   *  uses, Action Surge uses, …) land in `tracks['<feature-id>-uses']`. */
  tracks?: Record<string, number | string>;
  /** Subclass id picked at the class's subclass-choice level (typically L3).
   *  References a `SubclassDef.id` in `defs.subclasses`. The level-up
   *  resolver walks the subclass progression in addition to the class's own
   *  every time the character reaches one of the parent's `subclassLevels`. */
  subclassId?: string;
}

export interface MonsterAttack {
  name: string;
  attackType: 'melee' | 'ranged' | 'both';
  bonus: number;
  reach: number;
  rangeNormal?: number;
  rangeLong?: number;
  damageDice: number;
  damageSides: number;
  damageBonus: number;
  damageType: string;
  /** Optional secondary damage riders — see `BonusDamage`. */
  bonusDamage?: BonusDamage[];
  /** Optional on-hit effects applied after damage lands (attach, grapple, etc.). */
  onHit?: AttackOnHitEffect[];
}

/**
 * An effect triggered when this attack lands a hit. The `kind` discriminates:
 *   - `attach` — the attacker latches onto the target. Each time the
 *     attacker's turn begins, the target takes the `dot` damage. While
 *     attached, the attacker skips its normal attack action. The effect ends
 *     when the target (or an adjacent ally) takes the Detach action.
 */
export type AttackOnHitEffect =
  | { kind: 'attach'; dot: PeriodicDamage };

export interface PeriodicDamage {
  dice: number;
  sides: number;
  bonus: number;
  damageType: string;
}

/**
 * A periodic or one-shot damage effect currently active on a creature.
 *
 * `attach` is monster-authored periodic damage (stirge bite drain). The
 * `sourceNpcId` names the NPC that authored it; damage fires at the start
 * of that NPC's turn.
 *
 * `delayed-self-damage` is spell-authored one-shot damage scheduled at the
 * END of the target's NEXT turn (Acid Arrow's lingering 2d4 acid). It
 * fires once and is removed regardless of outcome.
 */
export type OngoingEffect =
  | { id: string; kind: 'attach'; sourceNpcId: string; dot: PeriodicDamage }
  | {
      id: string;
      kind: 'delayed-self-damage';
      /** Spell id that scheduled this (for the log line). */
      spellId: string;
      damageType: string;
      dice: number;
      sides: number;
      bonus: number;
      /** Number of remaining turn-ends until the damage fires. The effect is
       *  inserted with `turnsRemaining = 1` so the first end-of-turn after
       *  scheduling decrements to 0 and fires. */
      turnsRemaining: number;
    }
  | {
      id: string;
      kind: 'spell-condition';
      /** Spell that imposed `condition` on this creature. */
      spellId: string;
      /** Condition to strip when the timer expires. */
      condition: string;
      /** Turn ends until the condition is stripped — Color Spray uses 1 so
       *  the Blinded condition lifts on the caster's next end-of-turn (i.e.
       *  end of the round the spell was cast in). */
      turnsRemaining: number;
    };

/**
 * Special senses block — SRD 5.2.1 "Vision and Light". Ranges in feet. All
 * fields are optional; absence means "normal sight only". Used by the
 * Vision module to decide whether an observer can see through Darkness /
 * Heavily Obscured tiles / Invisible targets / Total Cover.
 *   - darkvision: see in Dim Light as Bright; in Darkness as Dim (gray).
 *   - blindsight: see within range without sight (pierces Darkness +
 *     Invisible; blocked only by Total Cover).
 *   - tremorsense: pinpoint creatures on the same surface (ground / wall /
 *     liquid) within range; not a form of sight, so does not pierce cover
 *     or perceive airborne creatures.
 *   - truesight: pierces Darkness + Invisible + magical concealment +
 *     transmutation disguises within range.
 */
export interface Senses {
  darkvision?: number;
  blindsight?: number;
  tremorsense?: number;
  truesight?: number;
}

export interface MonsterDef {
  id: string;
  name: string;
  type: string;
  maxHp: number;
  hpFormula?: string;
  ac: number;
  str: number; dex: number; con: number; int: number; wis: number; cha: number;
  proficiencyBonus: number;
  savingThrows?: Record<string, number>;
  initiativeBonus: number;
  stealthBonus: number;
  passivePerception: number;
  /** Special senses (SRD): darkvision / blindsight / tremorsense / truesight.
   *  Absent means "normal sight only". Read by `Vision.canSee`. */
  senses?: Senses;
  /** SRD creature size, parsed from the leading token of `type` at load time
   *  (US-107) via `parseCreatureSize`. The free-text `type` is kept for
   *  display/flavour. */
  size?: CreatureSize;
  speed: number;
  attacks: MonsterAttack[];
  /** SRD Multiattack (US-112): total melee attacks this creature makes on its
   *  turn. Absent / ≤ 1 means a single attack. Each is a separate attack roll
   *  using the same chosen weapon. */
  multiattack?: number;
  xp: number;
  cr: string;
  color: number;
  resistances?: string[];
  vulnerabilities?: string[];
  immunities?: string[];
  conditionImmunities?: string[];
  nimbleEscape?: boolean;
  combatSpawn?: boolean;
  /** Trait identifiers that adjust how this monster's attacks resolve. Each
   *  trait is interpreted by the engine (see CombatSystem.collectAttackModifiers).
   *  Supported today:
   *    - 'pack_tactics' — Advantage on an attack if at least one of the
   *      attacker's allies is within 5 ft of the target and not incapacitated.
   *    - 'sunlight_sensitivity' — Disadvantage on attacks while in direct
   *      sunlight (governed by EncounterDef.environment.sunlit).
   */
  traits?: MonsterTrait[];
  /** Authored defensive reactions the creature may trigger when targeted.
   *  Resolved automatically by the engine — there is no NPC reaction prompt.
   *  See CombatActions.tryNpcDefensiveReaction.
   */
  reactions?: MonsterReaction[];
  /** Path to the SVG used as this monster's token sprite. Required — every
   *  monster JSON must declare its token explicitly (no naming-convention
   *  fallback). */
  tokenAsset: string;
}

export type MonsterTrait = 'pack_tactics' | 'sunlight_sensitivity';

/**
 * A defensive reaction the engine may trigger on behalf of an NPC. The
 * `kind` discriminates the effect:
 *   - `parry` — when hit by a melee attack roll while not incapacitated, the
 *     NPC adds `acBonus` to its AC against that attack (possibly turning the
 *     hit into a miss). One reaction per round per SRD.
 */
export type MonsterReaction =
  | { kind: 'parry'; acBonus: number };

/**
 * Token Creator spec — the editable JSON record that backs every author-built
 * token. The scene composes a flat SVG at save time and writes both files
 * to disk: the SVG goes to `data/tokens/<id>.svg` (so any `tokenAsset` field
 * pointing there resolves through the existing static-file route) and the
 * spec goes to `data/tokens/specs/<id>.json` so the user can re-open the
 * Token Creator and tweak instead of starting over.
 */
export interface TokenSpec {
  /** Filename stem — produces `token_<id>.svg` + `token_<id>.json` on disk. */
  id: string;
  slots: {
    body?:       string;
    ears?:       string;
    face?:       string;
    beard?:      string;
    eyes?:       string;
    mouth?:      string;
    hair?:       string;
    accessory?: string;
  };
  /** Palette colours stamped into the part fragments at compose time. */
  palette: {
    /** Coin background fill — typically matches the NPC's `color` field. */
    body?: string;
    /** Face + ears fill. */
    skin?: string;
    /** Hair + beard fill. */
    hair?: string;
  };
}

/**
 * SRD social attitude (US-092). Parallel to but distinct from combat
 * `Disposition`: attitude is "how does this NPC feel about the party"
 * (affects Influence checks), disposition is "is this NPC fighting me"
 * (affects target selection). See SRD `Attitude.md` + the three attitude
 * glossary entries. `'indifferent'` is the SRD default for unannotated
 * monsters.
 */
export type Attitude = 'friendly' | 'indifferent' | 'hostile';

/** Skills that count as Influence checks per SRD `Influence_[Action].md`. */
export const INFLUENCE_SKILLS: readonly string[] = [
  'deception', 'intimidation', 'performance', 'persuasion', 'animalHandling',
];

export interface NPCDef {
  id: string;
  name: string;
  monsterClass: string;
  color: number;
  persona?: string;
  /** Optional per-NPC SVG override. When unset, the NPC falls back to the
   *  token of its `monsterClass`. */
  tokenAsset?: string;
  /**
   * Starting social attitude toward the party (US-092). Defaults to
   * `'indifferent'` per SRD when omitted. Independent of `disposition` —
   * a hostile-attitude shopkeeper can still be a neutral-disposition NPC
   * who refuses to fight but resists persuasion.
   */
  attitude?: Attitude;
  /**
   * Default faction membership for this NPC. Same role as `MonsterDef.factionId`
   * — overrides the monster-class default and falls back to the NPC's own id
   * when omitted (legacy NPCs preserve current implicit faction behaviour).
   */
  factionId?: string;
  /**
   * Default conversation graph id this NPC opens when the player initiates
   * dialogue. Resolves against `server/data/settings/<setting>/conversations/`.
   * Encounter authors can override per-encounter via
   * `EncounterDef.conversationOverrides` (see EncounterDef).
   */
  conversationId?: string;
  /**
   * Optional daily routine — one entry per day phase the NPC behaves
   * differently in. The world tick consults this whenever the day phase
   * advances; the matching entry's `task` becomes the NPC's active sim
   * task. See `RoutineEntry` in `shared/types/longRest.ts`.
   *
   * Seeded onto every spawned instance at session-create time by
   * `SessionBuilder` (no per-instance customisation today; future
   * `set_npc_routine` triggers will be able to mutate at runtime). NPCs
   * without a routine simply skip the routine path.
   */
  routine?: import('./longRest.js').RoutineEntry[];
  /**
   * When true, the engine maintains a per-character `NpcSave` file recording
   * this NPC's relationship, memories, and stateful overrides across sessions,
   * encounters, and adventures. Most NPCs are throwaway and leave this false
   * — flip it on for named characters the player is expected to interact with
   * again. Save file path: `<setting>/saves/<characterId>_npcs/<npcId>.json`.
   * See `NpcSave` for the schema.
   */
  persistent?: boolean;
}
