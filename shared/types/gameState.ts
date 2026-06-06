/**
 * GameState + dependent sub-shapes.
 *
 * Extracted from the original god-file `shared/types.ts` (now a barrel that
 * re-exports every domain module under `shared/types/`).
 */

// Cross-domain imports — keep these explicit so the dependency graph is visible.
import type { FeatureDef } from "./classes.js";
import type { EquipmentSlots, OngoingEffect } from "./entities.js";
import type { GameState } from "./longRest.js";
import type { Modifier } from "./modifiers.js";

/** One active buff spell on a creature (the player or an NPC). Its `modifiers`
 *  are derived into the player's legacy buff fields by `Buffs.recomputeBuffs`;
 *  `conditions` are the conditions it applied to its host creature (stripped
 *  when the buff ends); `charges` is a consumable counter (Mirror Image's
 *  duplicates). `concentration` buffs are removed by `endConcentration` from
 *  whichever creature holds them. */
export interface ActiveBuff {
  spellId: string;
  modifiers?: Modifier[];
  conditions?: string[];
  charges?: number;
  concentration?: boolean;
}

export type CombatMode = 'exploring' | 'player_turn' | 'enemy_turn' | 'death_saves' | 'defeat';

export type Disposition = 'ally' | 'neutral' | 'enemy';

export interface PlayerState {
  defId: string;
  tileX: number;
  tileY: number;
  hp: number;
  xp: number;
  /** Coin purse balance in Copper Pieces. SRD: 1 PP = 1000 CP, 1 GP = 100
   *  CP, 1 SP = 10 CP. Display via `formatCoins` from `shared/currency.ts`. */
  balanceCp: number;
  inventoryIds: string[];
  equippedSlots: EquipmentSlots;
  /** Per-feature resource pools, keyed by feature id (Second Wind, Rage, Channel Divinity, …). Initialised from `FeatureDef.resource.max` on session start; decremented by feature handlers. */
  resources: Record<string, number>;
  actionUsed: boolean;
  bonusActionUsed: boolean;
  reactionUsed: boolean;
  // SRD "free object interaction" — one per turn, used implicitly when drawing
  // a sword as part of the Attack action OR explicitly when equip/unequip is
  // invoked during player_turn. A second equip/unequip in the same turn
  // requires the Utilize action and consumes actionUsed.
  freeObjectInteractionUsed: boolean;
  // Initiative roll total for the current combat (d20 + DEX mod, with optional
  // Advantage/Disadvantage from surprise/invisibility). Cleared when combat ends.
  initiativeRoll: number;
  movesLeft: number;
  deathSaveSuccesses: number;
  deathSaveFailures: number;
  hitDiceUsed: number;
  tempHp: number;
  heroicInspiration: boolean;
  exhaustionLevel: number;
  conditions: string[];
  /** SRD Hide outcome — the total of the Stealth check that became the
   *  player's `hidden` condition. Every subsequent Perception attempt
   *  (passive sweep on turn boundary / movement, or active Search) opposes
   *  this DC. Cleared together with the `hidden` condition. */
  hideDC?: number;
  equippedSlotLabels: { armor: string | null; weapon: string | null; shield: string | null };
  /** Current effective AC after armor / shield / Mage Armor / Defense fighting style. Synced from `playerDef.ac` after every `applyEquipment` call so the client doesn't have to recompute. */
  ac: number;
  // ── Spellcasting runtime state ───────────────────────────────────────────
  /** Currently remaining spell slots, indexed by `spell.level − 1`. Empty array for non-casters. */
  spellSlots: number[];
  /** Warlock Pact Magic — slots that recover on Short Rest. `level` is the
   *  spell-slot level every pact slot casts at (1 → 5). Absent for
   *  non-Warlocks. Distinct from `spellSlots` because the recovery rule and
   *  upcast semantics differ. */
  pactMagic?: { remaining: number; max: number; level: number };
  /** Warlock Mystic Arcanum — one L6/7/8/9 spell per slot, used once per
   *  Long Rest. Maps spell level → { spellId, used }. Absent for everyone
   *  else. The picker is fired from the LevelUpOverlay (`mystic-arcanum-pick`
   *  prompt) at L11/13/15/17. */
  mysticArcanum?: Record<number, { spellId: string; used: boolean }>;
  /** Currently prepared spell ids (mutable across Long Rests). */
  preparedSpellIds: string[];
  /** Spell currently concentrated on, or null. Cleared by damage CON save, casting another concentration spell, or incapacitation. */
  concentratingOn: string | null;
  /** Active self-buff spells, each recording the typed modifiers it contributes
   *  and any conditions it applied. The engine DERIVES the legacy buff fields
   *  below (`magicWeaponBonus`, `speedBonus`, `seeInvisible`) from this list via
   *  `Buffs.recomputeBuffs`, and `endConcentration` strips a buff's conditions +
   *  removes it generically — replacing the old per-spell `switch(spell.id)`
   *  applications and cleanup branches. */
  activeBuffs?: ActiveBuff[];
  /** Flag set by Mage Armor — `applyEquipment`-equivalent uses base AC 13 + DEX while no armor is worn. */
  mageArmor: boolean;
  /** True while the Shield reaction's +5 AC bonus is active — set when the
   *  reaction resolves with "accept", cleared at the start of the player's
   *  next turn. While set, `computeAC` adds 5 to the rolled AC so the
   *  triggering attack AND any further attack that lands before the
   *  start-of-turn reset both see the bonus per SRD wording. */
  shieldActive: boolean;
  /** Flat movement bonus in feet applied by self-buff spells (Longstrider).
   *  Added to base `playerDef.speed` when computing tile movement at the
   *  start of each player turn. Cleared on long rest. */
  speedBonus: number;
  /** Set true by Expeditious Retreat; while active, the player may take the
   *  Dash action as a bonus action and receives the upfront Dash on the
   *  casting turn. Cleared when concentration on the spell ends. */
  expeditiousRetreat: boolean;
  /** Multiplier on jump distance set by Jump (×3). Defaults to 1. */
  jumpMultiplier: number;
  /** SRD Magic Weapon spell — flat bonus to player attack and damage rolls
   *  while the spell is active. 0 when no magic-weapon spell is up. Set by
   *  the Magic Weapon cast, cleared when the 1-hour duration ends or the
   *  player casts Magic Weapon again. */
  magicWeaponBonus: number;
  /** SRD Knocking Out a Creature (US-052): when true, a melee hit that would
   *  drop an enemy to 0 HP instead leaves it Unconscious + Stable (out of the
   *  fight, not killed). A player-set toggle. */
  nonLethal?: boolean;
  /** SRD Ready action (US-057): the player has readied a melee attack, reserving
   *  their Reaction. When an enemy moves into reach the engine offers the
   *  readied strike (a `readied_attack` pending reaction). Cleared when the
   *  strike fires or at the start of the player's next turn. */
  readiedAttack?: boolean;
  /** SRD attunement (US-124): ids of magic items the player is currently
   *  attuned to (≤ 3). A `requiresAttunement` item's bonus applies only while
   *  its id is in this list. */
  attunedItemIds?: string[];
  /** SRD identification (US-124): ids of `startsUnidentified` items the player
   *  has identified this session. Until an item's id is here, it displays as
   *  "Unidentified <category>". */
  identifiedItemIds?: string[];
  /** SRD See Invisibility — while true, the player sees creatures with the
   *  Invisible condition as if they were visible. Set by the See Invisibility
   *  cast, cleared after 1 hour (handled as a narrative timer for now —
   *  cleared on Long Rest in practice). Consulted by the attack resolver to
   *  skip the invisible-target Disadvantage and by the targeting UI to let
   *  the player click invisible creatures. */
  seeInvisible: boolean;
  /** SRD Invisibility spell — entity id of the creature carrying the
   *  spell's `invisible` condition. `'player'` for self-cast, or an NPC
   *  id when cast on another creature. When the target makes an attack
   *  roll, the engine ends the caster's concentration. Cleared when
   *  concentration drops (the condition is stripped at the same time).
   *  Undefined when no Invisibility is up. */
  invisibilityTargetId?: string;
  /** SRD Mirror Image spell — number of illusory duplicates remaining
   *  (0..3). Each incoming hit rolls one d6 per remaining duplicate; on
   *  any roll ≥ 3 the hit is voided and one duplicate is destroyed. Set
   *  to 3 on cast, decrements per hit absorbed, spell ends at 0. 1-minute
   *  duration is descriptive — there's no timer; the buff persists until
   *  the images are spent, the caster Long-Rests, or the AIGM clears it. */
  mirrorImages?: number;
  /** SRD Enhance Ability spell — the ability score whose checks roll with
   *  Advantage while the spell is active (Concentration). Set on cast,
   *  consulted by `rollAbilityCheck` against `SKILL_ABILITY`, cleared on
   *  concentration end. Undefined when no Enhance Ability is up. */
  enhancedAbility?: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';
  /** SRD Sneak Attack — "Once per turn". Flag flips when the rider fires
   *  and resets at the start of the player's next turn. Reset is also
   *  implicit at combat start (every player turn boundary). */
  sneakAttackUsedThisTurn?: boolean;
  /** SRD Arcane Recovery — once per Long Rest. Set when the wizard uses the
   *  Short Rest recovery; cleared by `applyLongRest`. Wizard-only — absent
   *  on non-wizards. */
  arcaneRecoveryUsed?: boolean;
  /** True when the player has moved at least one tile during their current
   *  turn. Reset at the start of each player turn. Gates SRD Steady Aim
   *  (Rogue L3) which requires the rogue to have NOT moved this turn. */
  movedThisTurn?: boolean;
  /** SRD Steady Aim (Rogue L3) — when set, the player's next attack rolls
   *  with Advantage and the flag clears. Set by the Steady Aim handler,
   *  consumed inside the attack resolvers, cleared at end of turn as a
   *  safety net so a missed-target click doesn't leak the buff. */
  steadyAim?: boolean;
  /** Currently active periodic effects (DoTs, attach bites, …). Each fires at the start of its `sourceNpcId`'s turn — see OngoingEffectsSystem. */
  ongoingEffects: OngoingEffect[];
}

export interface AvailableActions {
  canAttack: boolean;
  throwableItemIds: string[];
  canHide: boolean;
  /** True when the player can take the SEARCH action right now — always available
   *  during exploration (no action economy); during combat, gated on the player
   *  having an Action to spend (Search costs the full Action per SRD). */
  canSearch: boolean;
  /** Class-feature ids the player can use *right now* (action economy + remaining resource + class-level gating). */
  usableFeatureIds: string[];
  canDash: boolean;
  canDodge: boolean;
  canDisengage: boolean;
  canShortRest: boolean;
  /** Subset of `preparedSpellIds` + known cantrips that the player can cast *right now* given action economy and slot pool. Empty when the player isn't a caster or no spell is castable. */
  castableSpellIds: string[];
  /** True when the player has at least one attached creature they could
   *  Detach as an action (consumes the action and removes the attach effects
   *  from that source). */
  canDetach: boolean;
  /** True when the player's XP has reached the threshold to advance to the next level (per SRD Character Advancement). The Player Panel surfaces this as a `LEVEL UP` button. */
  canLevelUp: boolean;
  /** True when the current encounter permits Long Rest (`GameState.allowsLongRest`) AND the player is in the exploration phase. */
  canLongRest: boolean;
  /** Tiles holding a discovered, still-armed trap within reach (≤1 tile) that
   *  the player could attempt to Disarm right now. Drives the DISARM button. */
  disarmableTrapTiles: Array<{ x: number; y: number }>;
  /** Inventory ids of area-denial gear (caltrops, ball bearings) the player
   *  could Deploy right now. Drives the SET TRAP / DEPLOY button. */
  deployableGearIds: string[];
  /** Enemy NPC ids the player could Grapple right now — adjacent, alive, not
   *  already grappled, and no more than one size larger (US-110). Drives the
   *  GRAPPLE button. */
  grappleableTargetIds: string[];
  /** Enemy NPC ids the player could Shove right now — adjacent, alive, and no
   *  more than one size larger (US-050). Drives the SHOVE button. */
  shoveableTargetIds: string[];
  /** Magic-item ids (equipped or carried) the player could attune to right now
   *  — magical, `requiresAttunement`, not yet attuned, fewer than 3 attuned,
   *  and exploring (US-124). Drives the ATTUNE button. */
  attunableItemIds: string[];
  /** Item ids (equipped or carried) the player could identify right now —
   *  `startsUnidentified`, not yet identified, and exploring (US-124). Drives
   *  the IDENTIFY button. */
  unidentifiedItemIds: string[];
  /** True when the player can take the Help (Assist an Attack) action now —
   *  an Action is free, an enemy is adjacent, and a living ally can benefit
   *  (US-057). Drives the HELP button. */
  canHelp: boolean;
  /** True when the player can Ready an attack now — in combat, an Action and
   *  the Reaction are free, not already readied, and a living enemy exists
   *  (US-057). Drives the READY button. */
  canReady: boolean;
}
