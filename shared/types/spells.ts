/**
 * SpellDef + casting metadata.
 *
 * Extracted from the original god-file `shared/types.ts` (now a barrel that
 * re-exports every domain module under `shared/types/`).
 */

// Cross-domain imports — keep these explicit so the dependency graph is visible.
import type { MonsterDef } from "./entities.js";
import type { PlayerState } from "./gameState.js";

export type SpellSchool = 'abjuration' | 'conjuration' | 'divination' | 'enchantment'
                        | 'evocation' | 'illusion' | 'necromancy' | 'transmutation';

export type SpellcastingAbility = 'int' | 'wis' | 'cha';

export interface SpellComponents {
  verbal: boolean;
  somatic: boolean;
  material: string | null;
}

export interface SpellAttackOnly { kind: 'ranged-spell' | 'melee-spell' | 'auto-hit'; }
export interface SpellSave { ability: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'; halfOnSuccess: boolean; }
export interface SpellDamage { dice: number; sides: number; bonus?: number; type: string; }
export interface SpellArea {
  shape: 'cone' | 'sphere' | 'cube' | 'line';
  sizeFeet: number;
  /** For `line` shapes only: perpendicular width in feet (Gust of Wind:
   *  60 ft long × 10 ft wide; Lightning Bolt: 100 × 5). When omitted on a
   *  line, defaults to 5 ft (a single-tile-wide axis). */
  widthFeet?: number;
  /** SRD "each creature of your choice in the area" — when true the client
   *  surfaces a second-step picker after the AOE is placed so the caster
   *  decides which creatures in the area to affect (defaults to every
   *  non-ally). Sleep uses this; Color Spray / Thunderwave / Grease do not. */
  creaturesOfYourChoice?: boolean;
}
/**
 * Persistent-zone descriptor for AOE spells that occupy ground for their
 * duration (Fog Cloud, Darkness, Web, Grease, Silent Image, …). The engine's
 * cast resolver reads this instead of branching on `spell.id`, so a new zone
 * spell is data-only. Three mutually-exclusive cast modes:
 *
 *  - `castCondition`: tag every creature in the area at cast time with a
 *    condition, no save (Fog Cloud / Darkness → `heavily-obscured`).
 *  - `castSave`: each creature rolls a save or takes the condition (Web → DEX
 *    or `restrained`).
 *  - `groundPlaceable`: the zone IS the spell — register it even with no
 *    creature in the area at cast time (Grease, Silent Image, Gust of Wind).
 *
 * `enterSave` is the ongoing rider for creatures that later enter / start a
 * turn in the zone (Web re-roll; Grease's prone rider).
 */
export interface SpellZone {
  /** Map overlay tint (hex) so the player can tell zones apart. */
  tintHex?: string;
  /** Zone tiles count as Difficult Terrain (Web, Grease). */
  difficultTerrain?: boolean;
  /** Cast-time condition applied with no save (Fog Cloud, Darkness). */
  castCondition?: string;
  /** Log-line label for the cast-time condition. Defaults to the condition. */
  castLabel?: string;
  /** Cast-time save — creatures in the area roll or take `condition` (Web). */
  castSave?: { ability: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'; condition: string; label?: string };
  /** Ongoing enter/turn-start save for creatures wading into the zone. */
  enterSave?: { ability: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'; condition?: string };
  /** Register the zone even when no creature is in the area at cast time. */
  groundPlaceable?: boolean;
}
export interface SpellEffect {
  /** Condition(s) applied to the target on a failed save. Accepts either a
   *  single condition name (Sleep's `incapacitated`) or an array
   *  (Hideous Laughter's `["prone", "incapacitated"]`). */
  onFail?: string | string[];
  /** Sleep's escalation: a second failed save replaces `onFail` with this. */
  onSecondFail?: string;
  /** Condition(s) applied to the target on a SUCCESSFUL save (Ray of
   *  Enfeeblement: even on success the target has Disadvantage on its
   *  next attack roll). Same shape as `onFail`. Single-turn expiry uses
   *  the `spell-condition` ongoing-effect ticker. */
  onSuccess?: string | string[];
  /** Condition(s) applied to the target when an attack-roll spell HITS, with
   *  no save (the cantrip "riders": Ray of Frost → `slowed`, Chill Touch →
   *  `no-healing`, Shocking Grasp → `no-reactions`). Same shape as `onFail`;
   *  the log flavour comes from `ON_HIT_CONDITION_NOTE` in `SpellSystem`. */
  onHit?: string | string[];
  /** Iconic narration for a failed save, e.g. Hideous Laughter's "collapses,
   *  helpless with laughter". Falls back to "is &lt;conditions&gt;" when absent. */
  failNote?: string;
}

export interface SpellDef {
  id: string;
  name: string;
  level: number;                   // 0 = cantrip
  school: SpellSchool;
  classes: string[];
  castingTime: string;             // human-readable
  castingTimeTrigger?: string;     // reactions only
  range: string;                   // human-readable
  rangeFeet: number;               // 0 = self/touch
  components: SpellComponents;
  duration: string;
  durationRounds?: number;
  concentration: boolean;
  ritual: boolean;
  attack?: 'ranged-spell' | 'melee-spell' | 'auto-hit';
  save?: SpellSave;
  damage?: SpellDamage;
  area?: SpellArea;
  zone?: SpellZone;                // persistent-zone descriptor (Fog Cloud, Web, Grease, …)
  darts?: number;                  // Magic Missile: guaranteed-hit projectile count
  rider?: string;                  // narrative one-line secondary effect on hit
  effect?: SpellEffect;            // condition outcomes (Sleep)
  /** SRD "your choice" between multiple onFail conditions (Blindness/
   *  Deafness — caster picks Blinded or Deafened at cast time). When set,
   *  the engine prompts the caster for their pick before resolving the
   *  save; the chosen condition lands as `effect.onFail`. */
  onFailChoice?: string[];
  /** Independent AOE rider that fires after the primary attack roll
   *  resolves, regardless of hit or miss. Used by spells that "explode"
   *  around the target (Ice Knife). Combined with `save` + `area` to
   *  resolve creatures within `area.sizeFeet` of the targeted tile. */
  secondaryDamage?: SpellDamage;
  /** SRD push effect applied on a failed save (Thunderwave). The creature
   *  is shoved this many feet directly away from the caster (or, for
   *  spells without a clear origin, from the AOE centre). */
  push?: { feet: number };
  /** Color Spray's HP-pool gating. The caster rolls this pool once at cast
   *  time; targets are sorted by current HP ascending and consume from the
   *  pool until exhausted. Targets whose HP exceeds the remaining total
   *  are skipped. Affected targets receive `effect.onFail` conditions. */
  hpPool?: { dice: number; sides: number };
  /** Chromatic Orb chain: when two damage dice match, the orb leaps to a
   *  second creature within this range. */
  chainOnDoubles?: { rangeFeet: number };
  /** False Life-style temporary HP grant. The roll happens at cast time and
   *  is applied via `awardTempHp` (uses-higher-value semantics). */
  tempHpRoll?: { dice: number; sides: number; bonus?: number };
  /** SRD healing spell (Cure Wounds, Healing Word). The target — the caster or
   *  an ally, including a creature at 0 HP — regains HP equal to the roll plus
   *  the caster's spellcasting ability modifier; upcasting adds `dice` more
   *  dice per slot level above the spell's base level. Healing never exceeds the
   *  target's max HP, and reviving a downed ally clears Unconscious/Stable. */
  heal?: { dice: number; sides: number };
  /** SRD True Strike: the spell makes one attack with the caster's
   *  currently-equipped weapon using their spellcasting ability mod for
   *  both attack and damage rolls. On hit, the damage type defaults to the
   *  weapon's, plus extra Radiant dice at character levels 5 (1d6), 11
   *  (2d6), and 17 (3d6). Mutually exclusive with the standard
   *  attack/damage path. */
  weaponAttack?: boolean;
  /** Damage types the caster may choose from at cast time (Chromatic Orb,
   *  Dragon's Breath, …). When present, the engine ignores `damage.type` and
   *  uses the player's pick from this list instead. */
  damageTypeChoices?: string[];
  /** Spell that conjures a player-owned entity on the map (Mage Hand,
   *  Unseen Servant). The cast targets a tile within `rangeFeet`; the
   *  spawned NPC carries `summonSpellId` so the engine can route the
   *  `commandSummon` action correctly and enforce tether / damage lifecycle. */
  summon?: {
    /** `MonsterDef.id` to instantiate at the targeted tile. */
    monsterId: string;
    /** Per-command movement allowance, in feet. Each command moves the
     *  summon at most this far. */
    moveRangeFeet: number;
    /** Optional max distance the caster may stray from the summon before
     *  the spell ends (Mage Hand's 30 ft tether). Omit for spells without
     *  a tether (Unseen Servant). */
    tetherFeet?: number;
  };
  /** Generic end-of-turn repeat-save (Hold Person, Hideous Laughter). At the
   *  end of each affected creature's turn while the caster is concentrating,
   *  the engine rolls a `repeatSave.ability` save vs the spell's save DC.
   *  On success, the listed conditions are removed from that target — which
   *  effectively ends the spell on it (the creature returns to baseline).
   *  Sleep's bespoke "Incapacitated → Unconscious" transition does not fit
   *  this shape and stays hardcoded. */
  repeatSave?: {
    ability: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';
    /** Conditions removed from the target on a successful save. Typically
     *  matches the `effect.onFail` list. */
    removeOnSuccess: string[];
  };
  /** Delayed self-damage rider (Acid Arrow). On a hit, the engine attaches a
   *  one-shot `delayed-self-damage` ongoing effect to the target that fires
   *  at the END of the target's next turn. Damage type defaults to the
   *  spell's primary `damage.type`. Suppressed on miss. */
  delayedSelfDamage?: {
    dice: number;
    sides: number;
  };
  /** On a miss with a damaging spell, deal half the rolled primary damage
   *  anyway (Acid Arrow's "splashes for half as much of the initial damage
   *  only"). Distinct from Potent Cantrip, which is feature-gated and only
   *  triggers on damaging cantrips. */
  halfDamageOnMiss?: boolean;
  /** SRD self-teleport spell (Misty Step). Caster picks a destination tile
   *  within `rangeFeet`; the engine moves the player there as the spell
   *  resolution. No save, no attack roll. Teleportation does not provoke
   *  Opportunity Attacks per US-041's SRD OA exclusion clause. */
  selfTeleport?: { rangeFeet: number };
  /** SRD multi-roll attack spell (Scorching Ray — 3 rays at 2d6 each).
   *  Each ray is an independent ranged spell attack against a target the
   *  caster picks; engine resolves all rays at the initial target for now
   *  (per-ray re-targeting is a future enhancement). Damage and crit are
   *  rolled independently per ray. Upcasting adds one ray per slot level
   *  above `spell.level` per SRD. */
  attackCount?: number;
  /** SRD spells that ask the caster to choose an ability score at cast
   *  time (Enhance Ability — Bear's Endurance / Bull's Strength / etc.).
   *  The picker surfaces these as the buff variants. The engine reads the
   *  pick and sets `PlayerState.enhancedAbility` so ability checks of
   *  that ability roll with Advantage while concentrating. */
  abilityChoices?: ('str' | 'dex' | 'con' | 'int' | 'wis' | 'cha')[];
  description: string;
  scaling?: string;
}
