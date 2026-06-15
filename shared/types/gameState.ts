/**
 * GameState + dependent sub-shapes.
 *
 * Extracted from the original god-file `shared/types.ts` (now a barrel that
 * re-exports every domain module under `shared/types/`).
 */

// Cross-domain imports — keep these explicit so the dependency graph is visible.
import type { FeatureDef } from "./classes.js";
import type { EquipmentSlots, OngoingEffect, Senses, CreatureSize } from "./entities.js";
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
  /** NPC caster sustaining this buff (US-125, Priest Acolyte's Bless on its
   *  allies) — `dropNpcConcentration` strips every buff it sourced. Absent
   *  for player-cast buffs (the player's `endConcentration` owns those). */
  sourceNpcId?: string;
}

export type CombatMode = 'exploring' | 'player_turn' | 'gmpc_turn' | 'enemy_turn' | 'death_saves' | 'defeat';

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
  /** Ids of enemies that have lost track of this creature while it has the
   *  Invisible condition (Invisibility spell): each failed a Wisdom (Perception)
   *  check against the creature's Dexterity (Stealth) total at cast time and so
   *  cannot make direct attack rolls against it until it is found / the spell
   *  ends. Enemies who succeeded (or have truesight/blindsight) are absent and
   *  attack normally — with the Invisible condition's Disadvantage. Cleared when
   *  Invisibility ends (`endConcentration`). */
  unseenBy?: string[];
  equippedSlotLabels: { armor: string | null; weapon: string | null; shield: string | null; offhand?: string | null };
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
  /** Special senses granted by active self-buffs (Dwarf Stonecunning →
   *  Tremorsense), derived from buff `sense` modifiers by `recomputeBuffs` and
   *  merged over `PlayerDef.senses` by the Vision layer. Absent when no
   *  sense-granting buff is active. */
  buffSenses?: Senses;
  /** Creature size set by an active self-buff (Goliath Large Form → Large),
   *  derived from a buff `size` modifier. Overrides `PlayerDef.size` for the
   *  buff's duration. Absent when no size buff is active. */
  buffSize?: CreatureSize;
  /** Flat AC bonus from active self-buffs (Shield of Faith +2, Haste +2),
   *  derived from `ac-bonus` modifiers by `recomputeBuffs` and added in
   *  `computeAC`. Absent/0 when no AC buff is active. */
  acBonus?: number;
  /** Extra dice added to the player's d20 Tests by active self-buffs (Bless →
   *  attack + save; Guidance → check), derived per category from `dice-bonus`
   *  modifiers. Absent when no such buff is active. */
  attackDiceBonus?: { count: number; sides: number };
  saveDiceBonus?: { count: number; sides: number };
  checkDiceBonus?: { count: number; sides: number };
  /** Extra weapon-damage dice per hit from active self-buffs (Enlarge → +1d4),
   *  derived from `weapon-damage-dice` modifiers (largest count×sides). Baked
   *  onto `PlayerAttack.damageDiceBonus` by `applyEquipment`. Absent when none. */
  weaponDamageDice?: { count: number; sides: number };
  /** Ability keys whose saving throws have Advantage from active self-buffs
   *  (Haste → dex; Beacon of Hope → wis), derived from save-scoped `advantage`
   *  modifiers on buffs. */
  buffSaveAdvantage?: string[];
  /** Damage types resisted by active self-buffs (Protection from Energy),
   *  derived from `resistance` modifiers and merged by the player damage path
   *  alongside species resistances. */
  buffResistances?: string[];
  /** Typed flat dice reduction to incoming damage from an active self-buff
   *  (Resistance cantrip → −1d4 of the chosen type), derived from a
   *  `damage-reduction` modifier and applied in `applyDamageToPlayer`. */
  buffDamageReduction?: { damageType: string; count: number; sides: number };
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
  /** SRD Extra Attack (US-119): follow-up weapon attacks still available in the
   *  current Attack action. The first attack of the action commits the Action
   *  and reserves `attacksPerAction - 1` here; each follow-up draws this down
   *  without spending another Action. Reset to 0 at the start of the turn. */
  attacksRemaining?: number;
  /** US-128 Two-Weapon Fighting: true once the player has made a weapon Attack
   *  this turn — gates the off-hand bonus attack ("when you take the Attack
   *  action and attack with a Light weapon"). Reset at the start of the turn. */
  attackedThisTurn?: boolean;
  /** US-128: the off-hand TWF attack was spent this turn (once per turn —
   *  whether it cost the Bonus Action or rode Nick for free). */
  offhandAttackUsedThisTurn?: boolean;
  /** US-128 Cleave mastery: the once-per-turn cleave hit was spent this turn. */
  cleaveUsedThisTurn?: boolean;
  /** SRD attunement (US-124): ids of magic items the player is currently
   *  attuned to (≤ 3). A `requiresAttunement` item's bonus applies only while
   *  its id is in this list. */
  attunedItemIds?: string[];
  /** SRD identification (US-124): ids of `startsUnidentified` items the player
   *  has identified this session. Until an item's id is here, it displays as
   *  "Unidentified <category>". */
  identifiedItemIds?: string[];
  /** Detect Magic: ids of magical items the player has SENSED as magical
   *  (held or seen on the ground when cast). Surfaces a magic aura in the
   *  inventory + on map items, even while the item is still unidentified.
   *  Distinct from identification — knowing a thing is magical isn't knowing
   *  what it does. */
  magicDetectedItemIds?: string[];
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
  /** Total Strength drained by monster `ability_drain` attacks (SRD Shadow).
   *  The session's cloned playerDef has its `str` reduced by this amount at
   *  engine construction (mirroring the level-up-history replay pattern) and
   *  again at hit time; the player dies if Strength reaches 0. Restored — and
   *  this counter reset — by a Long Rest. Absent means 0. */
  strengthDrained?: number;
  /** Set while a monster `onHit` grapple (US-125, Bugbear Grab) holds the
   *  player: the grappler's NPC id + the SRD escape DC for the player's
   *  Escape action (Athletics/Acrobatics check). Cleared on a successful
   *  escape or when the grappler dies / is incapacitated / disappears. The
   *  `grappled` condition itself lives in `conditions`. */
  grappledBy?: { npcId: string; escapeDc: number };
  /** Active carried light (US-127): a lit torch / lantern (LIGHT action) or
   *  the Light cantrip. Sheds Bright Light within `brightFt` of the player
   *  and lifts Darkness to Dim out to `brightFt + dimFt` —
   *  `Vision.effectiveLightAt` folds it over the baked/ambient light.
   *  `source` is the item id or `'light'` (the spell). Cleared by the LIGHT
   *  action (douse) and by a Long Rest (torches and the spell both run out
   *  on the hour-scale). */
  lightSource?: { brightFt: number; dimFt: number; source: string };
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
  /** True when the player can make the Two-Weapon Fighting off-hand attack
   *  this turn (US-128): a Light weapon in each hand, having already attacked
   *  this turn, and either a Bonus Action free or Nick granting it for free. */
  canOffhandAttack: boolean;
  /** True when a monster grapple holds the player (`PlayerState.grappledBy`)
   *  and they can spend the Action on an Escape attempt — Athletics or
   *  Acrobatics (whichever is better) vs the grapple's escape DC (US-125).
   *  Drives the ESCAPE button. */
  canEscapeGrapple: boolean;
  /** True when the player can light a carried light source (torch/lantern in
   *  inventory) or douse the one burning (US-127). Drives the LIGHT/DOUSE button. */
  canToggleLight: boolean;
  /** True when the player's XP has reached the threshold to advance to the next level (per SRD Character Advancement). The Player Panel surfaces this as a `LEVEL UP` button. */
  canLevelUp: boolean;
  /** True when the current encounter permits Long Rest (`GameState.allowsLongRest`) AND the player is in the exploration phase. */
  canLongRest: boolean;
  /** Tiles holding a discovered, still-armed trap within reach (≤1 tile) that
   *  the player could attempt to Disarm right now. Drives the DISARM button. */
  disarmableTrapTiles: Array<{ x: number; y: number }>;
  /** Tiles carrying an un-studied `study_feature` trigger (regardless of
   *  current distance). Drives the STUDY action's tile picker: the client gates
   *  the action to within 1 tile and prompts the player to move closer
   *  otherwise. Empty ⇒ STUDY falls back to the GM-chat prompt. */
  studyPointTiles: Array<{ x: number; y: number }>;
  /** Tiles carrying an un-fired `magic_feature` trigger (a rite point). Drives
   *  the MAGIC action's tile picker — gated to ≤1 tile, move-closer otherwise.
   *  Empty ⇒ MAGIC falls back to the GM-chat prompt. */
  magicPointTiles: Array<{ x: number; y: number }>;
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

// ── World/runtime state (moved from the former longRest.ts grab-bag) ────────
import type { AdventureChapter, AdventureDef } from "./adventures.js";
import type { LogEntry } from "./combatLog.js";
import type { ActiveConversation } from "./conversation.js";
import type { ActiveBanter } from "./banter.js";

/**
 * A GM-controlled player character (US-130). `defId` resolves to a `PlayerDef`
 * (the same character defs the human roster draws from); `state` is its live
 * `PlayerState`, structurally identical to the human's. `persona` is the GM's
 * roleplay brief. `tileX`/`tileY` mirror the state's position for spawn/render
 * convenience.
 */
export interface GmpcActor {
  /** Combatant id — `gmpc_<slug>`. Appears in `turnOrderIds`. */
  id: string;
  /** Character definition id (a `PlayerDef`). */
  defId: string;
  /** Live PC state — HP, spell slots, resources, conditions, position. */
  state: PlayerState;
  /** GM roleplay brief, surfaced to the AIGM so it plays the character in voice. */
  persona?: string;
}
import type { EncounterEnvironment, EncounterTileProperty, MapTilesetInfo, SecretDef } from "./encounter.js";
import type { WorldFlagValue } from "./engineEvents.js";
import type { Rumor } from "./factions.js";
import type { PendingReaction, PendingReroll, PendingCombatStart } from "./reaction.js";
import type { EncounterTrigger } from "./triggers.js";
import type { NpcState, NpcPersona } from "./npcState.js";

export type DayPhase = 'morning' | 'noon' | 'evening' | 'night';

/** One adjudicated improvised action (US-121) — written by
 *  `ImprovisedActionSystem` per `resolve_improvised_action` call. `difficulty`
 *  is the band name the GM passed (`very_easy` … `nearly_impossible`); `dc`
 *  the engine-mapped value. See docs/design/systems/improvised-actions.md. */
export interface ImprovisedRuling {
  description: string;
  skill: string;
  difficulty: string;
  dc: number;
  success: boolean;
}

/** NPC awareness state.
 *
 *   • `calm`       — default. Follows routine. Default-RAM 0.
 *   • `suspicious` — heard / saw something out of place. Pauses routine to
 *     glance toward last alert tile. Decays back to `calm` over a few
 *     ticks unless re-alerted.
 *   • `alert`      — something hostile is happening. Walks toward last
 *     alert tile aggressively. Becomes combat-ready if a hostile is
 *     visible. Decays to `suspicious` then `calm` unless renewed.
 *
 * Drives the InvestigateTask / AlertTask priority bands so an alerted NPC
 * outranks their routine without code-level special-casing.
 */
export const DAY_PHASE_CYCLE: readonly DayPhase[] = ['morning', 'noon', 'evening', 'night'] as const;

/** How many world ticks fit in one day phase. 60 ticks × 6 sim-seconds per
 *  tick ≈ 6 real minutes per phase ≈ 24 real minutes per day. Tune in one
 *  place; every routine consumer reads from here. */
export const TICKS_PER_DAY_PHASE = 60;

/** One row in an NPC's routine. The first entry whose `phase` matches the
 *  current day phase wins; the rest are evaluated each phase boundary as
 *  the cycle advances. */
export interface MapItemState {
  id: string;
  defId: string;
  tileX: number;
  tileY: number;
}

export interface SecretState {
  tileX: number;
  tileY: number;
  def: SecretDef;
}

export interface GameMap {
  /** Per-tile movement blocking. `blocksMovement[y][x] === true` means the
   *  tile cannot be walked onto (wall, tree, chasm). Baked at session-build
   *  from each tile's `blocksMovement` flag (object-overrides-terrain). */
  blocksMovement: boolean[][];
  /** Per-tile sight blocking. `blocksSight[y][x] === true` means line-of-sight
   *  cannot pass through the tile. Baked from each tile's `blocksSight` flag,
   *  ORing the ground and object features so either one blocks the cell. */
  blocksSight: boolean[][];
  cols: number;
  rows: number;
  /** Per-tile cover (SRD 5.2.1). `null` = no cover. Authored via
   *  `EncounterTileProperty.cover` and baked at session-build time so the
   *  Vision LOS walker and combat resolver can read it in O(1). */
  cover?: (null | 'half' | 'three-quarters' | 'total')[][];
  /** Per-tile obscurance (SRD 5.2.1). `null` = clear; `lightly` imposes
   *  Disadv on Perception (sight); `heavily` Blinds the observer into the
   *  tile and counts as Hide-eligible cover. Baked from
   *  `EncounterTileProperty.obscurance`. Encounter-wide light defaults
   *  (`EncounterEnvironment.lightLevel`) are NOT baked in here — they are
   *  layered on top at read time so darkvision can override them per
   *  observer. */
  obscurance?: (null | 'lightly' | 'heavily')[][];
  /** Per-tile ambient light (US-126, multi-region maps). Baked at session
   *  build from map zones that declare a `lightLevel` (a cave region is
   *  `dark` while the grassland outside stays bright). `null` = no zone
   *  override — `Vision.ambientObscurance` falls back to the encounter-wide
   *  `EncounterEnvironment.lightLevel`. Darkvision applies per observer at
   *  read time exactly as it does for the global level. */
  light?: (null | 'bright' | 'dim' | 'dark')[][];
  /** Ground-layer tile GIDs for rendering. Optional: procedural maps may omit. */
  gidGrid?: number[][];
  /** Object-layer tile GIDs (drawn over the ground layer). 0 = empty cell. */
  objectGidGrid?: number[][];
  /** Tileset metadata for rendering. Optional: procedural maps may omit. */
  tilesets?: MapTilesetInfo[];
}

export interface ActiveZone {
  id: string;
  spellId: string;
  /** Display label rendered on the map (e.g. "Fog Cloud", "Web"). */
  name: string;
  shape: 'sphere' | 'cube' | 'cone' | 'line';
  sizeFeet: number;
  /** Anchor tile — center for sphere/cube, origin for cone/line. */
  originX: number;
  originY: number;
  /** For cone/line shapes: the tile the area points toward (lets the client
   *  re-derive orientation without re-running the shape sweep). */
  targetX?: number;
  targetY?: number;
  /** Pre-computed list of tiles the zone covers. The client renders these
   *  directly; the engine reads them for in-zone checks without re-running
   *  `creaturesInArea`. */
  tiles: Array<[number, number]>;
  /** Engine condition applied to creatures in the zone (heavily-obscured,
   *  restrained, …). Absent for purely visual zones (illusions, gust). */
  condition?: string;
  /** Re-tag-on-enter save (Web): when a creature enters the zone on a turn
   *  or starts its turn there, it rolls `ability` vs `dc`; on a failed save
   *  the zone's `condition` is applied. Absent for auto-tag zones (Fog
   *  Cloud — heavily-obscured applies on entry without a save). */
  enterSave?: { ability: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'; dc: number };
  /** Flat damage dealt on a failed `enterSave` (deployed caltrops: 1
   *  Piercing). Applied in addition to `condition`. Absent for non-damaging
   *  zones. */
  enterDamage?: { amount: number; type: string };
  /** True when the zone's tiles are Difficult Terrain (Web, Spike Growth,
   *  Plant Growth, Sleet Storm). Movement consumed by a tile inside the
   *  zone is doubled for the moving creature. */
  difficultTerrain?: boolean;
  /** Ids of NPCs the zone has applied its `condition` to. Used at zone end
   *  to reliably strip the condition even if the creature has since been
   *  pushed / teleported outside the original tile set. */
  affectedNpcIds: string[];
  /** True when the zone has applied its condition to the player. */
  affectedPlayer: boolean;
  /** Rounds left until expiry. Decremented at end of each round; zone is
   *  removed (and `condition` stripped from any creature still inside)
   *  when this reaches 0. */
  roundsRemaining: number;
  /** Caster id — `'player'` or an NPC id. Used by re-cast / Dispel paths. */
  casterId: string;
  /** Visual tint colour (CSS hex). The client falls back to a default if
   *  absent. Lets each spell pick its own atmosphere — fog grey, web white,
   *  darkness near-black. */
  tintHex?: string;
  /** Slot level the zone was cast at — carries upcast scaling to the
   *  recurring per-turn effect (Spirit Guardians: +1d8 radiant per slot
   *  above 3). Absent for zones whose effect doesn't scale. */
  castSlotLevel?: number;
}

/**
 * A first-class trap placed on a tile. Distinct from area-denial gear zones
 * (those are `ActiveZone`s): a trap is a single concealed hazard that must be
 * spotted (Perception vs `detectDC`), disarmed (Dexterity / Sleight of Hand
 * with Thieves' Tools vs `disarmDC`, SRD default 15), or it springs when a
 * creature steps on its tile — rolling `trigger.saveAbility` vs `trigger.saveDC`
 * for damage (half on save when `halfOnSave`) and an optional `condition`.
 *
 * SRD basis: detecting/understanding traps is Intelligence (Investigation) /
 * Wisdom (Perception); disarming a trap with Thieves' Tools is a DC 15
 * Dexterity (Sleight of Hand) check (Tools.md, Rogue L1).
 */
export interface TrapState {
  id: string;
  name: string;
  tileX: number;
  tileY: number;
  /** False once disarmed or sprung — an inert trap never triggers again. */
  armed: boolean;
  /** False while concealed; flips true once detected (passive or Search). */
  discovered: boolean;
  /** Passive/active Perception needed to notice the trap. */
  detectDC: number;
  /** Dexterity (Sleight of Hand) DC to disarm with Thieves' Tools (SRD 15). */
  disarmDC: number;
  trigger: TrapTrigger;
  /** One-line flavour shown when the trap springs. */
  triggeredMessage?: string;
  /** Visual tint (CSS hex) for the map marker; falls back to a default. */
  tintHex?: string;
}

export interface TrapTrigger {
  saveAbility: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';
  saveDC: number;
  damageDice: number;
  damageSides: number;
  damageBonus: number;
  damageType: string;
  /** Half damage on a successful save (SRD trap convention). */
  halfOnSave: boolean;
  /** Condition applied on a failed save (e.g. 'restrained', 'poisoned'). */
  condition?: string;
}

export interface GameState {
  sessionId: string;
  phase: CombatMode;
  map: GameMap;
  player: PlayerState;
  /** GMPCs (US-130) — full player characters the GM controls and roleplays.
   *  Each carries its own `PlayerState` (HP, spell slots, class-feature
   *  resources, conditions) exactly like the human's. On a GMPC's turn the
   *  engine binds its state into the active-actor slot so every existing
   *  player-mechanics path (attacks, leveled spellcasting, features, resting)
   *  operates on it unchanged. Absent / empty in solo play. */
  gmpcs?: GmpcActor[];
  /** Id of the combatant currently taking its turn for player-mechanics
   *  resolution: `'player'` (the human, default) or a `gmpc_<n>` id. The
   *  engine's active-actor binding reads this; never serialized as anything
   *  but `'player'` to the client (GMPC turns resolve server-side). */
  activeActorId?: string;
  /** US-130 — while a GMPC is bound as the active actor, the human player is
   *  swapped out of `state.player` and would otherwise vanish from movement
   *  occupancy checks. This holds the swapped-out player's tile so the GMPC's
   *  pathing still treats it as occupied (a GMPC can't walk onto / stop on the
   *  human). Transient: set only during a bound turn, always cleared after. */
  parkedActorTile?: { x: number; y: number };
  npcs: NpcState[];
  mapItems: MapItemState[];
  secrets: SecretState[];
  eventLog: LogEntry[];
  logScrollOffset: number;
  mapName: string;
  encounterTitle: string;
  /** Id of the authored `EncounterDef` driving this session, when one
   *  exists. Procedurally-generated / ad-hoc sessions leave this
   *  undefined. The client reads it to drive encounter-aware UI such
   *  as the Mission Top Bar (TO MISSION / LEAVE MISSION buttons in the
   *  Bureau-office mission cycle). */
  currentEncounterId?: string;
  /** Player-facing one-line goal for this encounter. */
  objective: string;
  selectedTargetId: string | null;
  activeNpcIndex: number;
  turnOrderIds: string[];
  introduction: string;
  encounterContext: string;
  /** Carried from `EncounterDef.allowsLongRest` (default `false`) — drives `AvailableActions.canLongRest`. */
  allowsLongRest: boolean;
  npcPersonas: NpcPersona[];
  availableActions: AvailableActions;
  /** Set when the engine has paused on a reaction-eligible trigger. The next player action must be `resolveReaction`. Cleared on resolution. */
  pendingReaction: PendingReaction | null;
  /** Set when the engine has paused to offer a Heroic Inspiration reroll
   *  (US-109a). The next player action must be `resolveReroll`. Cleared on
   *  resolution. */
  pendingReroll: PendingReroll | null;
  /** Set when a player action in the exploring phase would start combat — the
   *  engine pauses for confirmation. The next player action must be
   *  `resolveCombatStart`. Cleared on resolution. */
  pendingCombatStart: PendingCombatStart | null;
  /** Active conversation when one is open — `null` otherwise. The client
   *  renders the ConversationOverlay whenever this transitions non-null.
   *  Pauses world tick (`isWorldTickEligible` skips when set). */
  activeConversation: ActiveConversation | null;
  /** True when an `encounter_started` combat trigger fired during session
   *  construction and the engine deferred `advanceTurn` so the player has
   *  a chance to see the intro overlay / announcement before NPC turns
   *  run. Consumed by `GameEngine.runPendingTurnAdvance()` once the client
   *  signals readiness by releasing the world pause. */
  pendingTurnAdvance?: boolean;
  /** Authored encounter triggers active for this session. Sourced from `EncounterDef.triggers` at session creation. */
  triggers: EncounterTrigger[];
  /** Ids of triggers that have already fired. Persisted in `world.json` so `once` semantics survive save/load. */
  firedTriggerIds: string[];
  /** Scripted-event lines queued by `send_aigm_message` actions. Surfaced to the next AIGM turn under the SCRIPTED EVENTS block and cleared once consumed. */
  pendingAigmEvents: string[];
  /** Authored world flags keyed by name. Written by `set_flag` trigger actions, read by `flag_set` / `flag_unset` / `flag_equals` guards. Persisted with the world save. */
  worldFlags: Record<string, WorldFlagValue>;
  /** Active/completed/failed quests for this character (structured quest system).
   *  Persisted with the world save; adventure/world-scope quests also carry across
   *  chapters via `AdventureSave`. The `QuestSystem` advances these off bus events. */
  quests: import('./quests.js').QuestState[];
  /** Defs for quests the AIGM created at runtime (not loaded from JSON). Stored
   *  here so a runtime quest's definition survives reload alongside its state. */
  runtimeQuestDefs: import('./quests.js').QuestDef[];
  /** Last variant index picked per `narrationId`. Used by NarrationSystem to avoid back-to-back repeats. */
  narrationLastUsed: Record<string, number>;
  /** Monotonic counter incremented once per off-camera `WorldTick`. Used as
   *  the `tickId` for the NPC sim engine's seeded RNG — combined with each
   *  NPC's id it produces a deterministic stream that reproduces across
   *  runs (unlike `Date.now()`). Survives save/load so loading a saved
   *  session mid-tick gives the same companion decisions on the next tick
   *  it would have given pre-save. */
  worldTickCount: number;
  /** Coarse-grained time of day for NPC routines. Advances on a fixed tick
   *  cadence (see TICKS_PER_DAY_PHASE) and wraps morning → noon → evening →
   *  night → morning. Per-encounter scope: every encounter starts at
   *  `morning` and the cycle runs while the player explores. Persistence
   *  across encounters is part of the WorldState refactor (step 7). */
  dayPhase: DayPhase;
  /** US-129 ambient banter — in-flight NPC-to-NPC exchanges, one line per
   *  world tick. Transient: present only while a pair is mid-conversation. */
  ambientChats?: ActiveBanter[];
  /** US-129 — per-NPC cooldown (earliest `worldTickCount` they may banter
   *  again), so the same pair doesn't loop and chatter stays sparse. */
  ambientChatCooldowns?: Record<string, number>;
  /** US-129 — the last few ambient lines, surfaced to the AIGM as an
   *  `OVERHEARD` block so it can answer "what were those two saying?".
   *  Capped to the most recent handful. */
  recentAmbientLines?: string[];
  /**
   * Legacy player-relative view of standings. **Kept for backward compatibility**
   * with existing `faction_standing` guards, `adjust_faction_standing` AIGM
   * tool calls, and adventure-save seeding — internally this is just a
   * projection of `factionRelations[PLAYER_FACTION_ID]` and the engine keeps
   * it in sync.
   *
   * New code should read / write via `factionRelations` directly.
   */
  factionStandings: Record<string, number>;
  /**
   * Full pair-wise relation matrix between every faction the session is aware
   * of. `factionRelations[a][b]` is faction `a`'s standing with faction `b`
   * in the range −100..+100. The matrix is **symmetric when first built**
   * (we mirror each declared default), but runtime triggers / AIGM tool calls
   * may break that symmetry. `getRelation(state, a, b)` resolves the
   * effective standing by taking the worse of the two directions, so one
   * faction can read another as hostile without the second reciprocating.
   *
   * Seeded at session creation from `defs.factions[*].defaultRelations` and
   * the optional `EncounterDef.factionRelations` override block.
   */
  factionRelations: Record<string, Record<string, number>>;
  /**
   * Per-**individual** relationship overrides — the layer that sits *in front
   * of* the faction matrix. `relationships[a][b]` is how individual `a` regards
   * individual `b` (−100..+100). Keys are individual ids: an NPC id, or the
   * literal `'player'` (`PLAYER_ID`) for the player character.
   *
   * **Sparse**: only authored / runtime deviations from the faction baseline
   * are stored. An absent pair falls through to `factionRelations` (using each
   * individual's faction), then to 0. This is what lets two members of the same
   * faction be enemies, or members of opposing factions be friends — the
   * individual link overrides the faction default. Asymmetric, like the faction
   * matrix; `relationStance` takes the worse of the two directions.
   *
   * Resolved by `engine/Relationships.ts` (`relation`, `viewStance`,
   * `projectDisposition`). `NpcState.disposition` is a party-relative projection
   * of this layer, kept in sync the way `factionStandings` projects the matrix.
   */
  relationships: Record<string, Record<string, number>>;
  /**
   * Faction ids the player has identified through play (Insight check on
   * combat-start, or the AIGM's `reveal_faction` tool). The Target Panel
   * renders the faction name + colour for ids in this set, `???` otherwise.
   * Persisted with the world save and seeded from adventure saves so identity
   * reveals carry across chapters.
   */
  discoveredFactions: string[];
  /** World memory log of significant events, recorded by AIGM `create_rumor` tool or trigger `record_rumor` action. Surfaced to the GM in CURRENT STATE. */
  rumors: Rumor[];
  /** Adjudicated improvised actions (US-121), newest last, capped to the most
   *  recent 10 by `ImprovisedActionSystem`. Surfaced to the GM as the RECENT
   *  RULINGS block so repeated attempts keep a consistent difficulty band.
   *  Persisted with the world save. */
  improvisedRulings: ImprovisedRuling[];
  /** Set when the current session is a chapter of an adventure. Drives the END CHAPTER button and the chapter-advance flow. Null for single-encounter sessions. */
  adventureContext: AdventureSessionContext | null;
  /** Set true when the active chapter has been resolved (combat-ended or `completionFlag` set). Drives the END CHAPTER button. */
  encounterComplete: boolean;
  /** Optional world-flag name that, when set, marks the encounter complete. Mirrors `EncounterDef.completionFlag` for standalone (non-adventure) encounters so the `encounter_completed` engine event can fire on flag-driven resolutions. */
  encounterCompletionFlag?: string;
  /** When true, clearing all enemies does NOT complete the encounter — only the `completionFlag` being set does. For encounters where combat is a step, not the objective (e.g. kill the captors, THEN free the captives). Mirrors `EncounterDef.completeOnFlagOnly`. */
  encounterCompleteOnFlagOnly?: boolean;
  /** Environmental flags consulted by combat resolvers — sourced from EncounterDef.environment at session creation. */
  environment: EncounterEnvironment;
  /** Persistent area-of-effect zones currently in play (Fog Cloud, Web,
   *  Darkness, Grease, illusions, future Walls + Spirit Guardians + Cloudkill).
   *  Lifetime is driven by `roundsRemaining`, not by concentration — the
   *  visible cloud stays on the map until its duration expires so the player
   *  can plan around it. Rendered on the client as a tile overlay. */
  activeZones: ActiveZone[];
  /** Concealed tile traps placed by the encounter. Detected via Perception,
   *  removed via the Disarm action, or sprung when a creature steps onto the
   *  trap tile. Rendered on the client once `discovered`. */
  traps: TrapState[];
  /** Dev-mode overrides for the active session, copied from the
   *  `CreateSessionRequest` at session boot. Engine consumers consult these
   *  on every state push (see `GameEngine.getState`) to keep resources
   *  "topped up" so the player can test freely without rerunning encounters. */
  devFlags?: DevFlags;
}

/**
 * Dev-mode session overrides. Set via the Configuration scene's
 * "Development Mode" section. Persisted in the browser's localStorage and
 * spliced into every `CreateSessionRequest`. Intended for testing — disabled
 * by default in any normal play session. See `client/src/devMode.ts`.
 */
export interface DevFlags {
  /** Skip the IntroductionOverlay supertitle at encounter start. The intro
   *  text is still pushed to the GM chat so the narrative record is intact.
   *  Client-only — server ignores this field. */
  disableSupertitle?: boolean;
  /** Spell slots are refilled to their max on every server state push, so
   *  casting never decrements the visible slot counter. */
  unlimitedSpellSlots?: boolean;
  /** At session creation the player's `preparedSpellIds` is seeded with
   *  every L1+ spell of their class, their `defaultCantripIds` is widened
   *  to every cantrip of their class (so cantrip-gated knowledge checks
   *  pass), and the spell-slot pool is replaced with **4 slots of every
   *  level represented in the shipped spell roster** (capped at L9) so
   *  the prepared L2 / L3 / … spells are actually castable, not just
   *  visible. Lets the tester invoke any spell without a level-up
   *  rebuild. Combine with `unlimitedSpellSlots` to keep the pool full
   *  between casts. */
  unlockAllSpells?: boolean;
  /** `actionUsed` and `bonusActionUsed` are reset to `false` on every server
   *  state push, so a tester can spam attacks/spells in combat without
   *  ending their turn. */
  unlimitedActions?: boolean;
  /** Show the DELETE SAVE button on the character setup detail panel. Off by
   *  default so non-developers can't accidentally wipe a character's progress.
   *  Client-only — server ignores this field. */
  showDeleteSaveButton?: boolean;
  /** Allow the player to retry a failed (or already-attempted) conversation
   *  ability check. When OFF (default) the server rejects a second attempt
   *  on the same `node#choiceIndex` and the client hides the choice. When
   *  ON the choice remains clickable and the overlay flags it with a
   *  `[DEV]` tag so the player knows the option is only reachable because
   *  the dev override is active. */
  allowRetryChecks?: boolean;
  /** Surfaces a "★ COMPLETE OBJECTIVE" button (inside the DevTools panel
   *  when `showDevToolsPanel` is on, or as a fallback button below the
   *  Player Panel's CHARACTER button when it is not) that fires the
   *  encounter's completion path — sets the `completionFlag` if one is
   *  authored, or ends combat by clearing every enemy — so a tester can
   *  blast through adventures without playing them out. Off by default. */
  completePrimaryObjective?: boolean;
  /** Show the DevTools panel — a small bottom-anchored bar to the right of
   *  the Player Panel that hosts dev-only buttons (Reload Encounter,
   *  Complete Objective, …). Off by default so non-developers never see
   *  the panel. Client-only — server ignores this field. */
  showDevToolsPanel?: boolean;
  /**
   * Clean Mode — when on, the server wipes every player progress
   * artefact under `server/data/settings/<setting>/saves/` at startup:
   *   • the world save (`saves/world.json`)
   *   • every character save (`saves/<characterId>.json`)
   *   • every persistent NPC save tree (`saves/<characterId>_npcs/`)
   *   • every adventure save (`saves/*_adventure.json`)
   * Logged loudly via `Logger.log('server.clean_mode_wipe', { … })`
   * and to stdout. The flag stays ON across restarts — disable it
   * explicitly from the Configuration screen when done.
   *
   * Server-only — the wipe runs in the startup path before any session
   * restoration. Off by default so a normal player can't accidentally
   * scrub their progress.
   */
  cleanModeOnStart?: boolean;
  /**
   * Server-side structured-logging verbosity. Controls how much the
   * `Logger` writes per session — high-volume logging on the request path
   * is a measurable source of in-encounter lag, so this lets a developer
   * dial it down (or off) without a code change.
   *   • `none`    — only `error` events are emitted; everything else is
   *                 dropped before it touches stdout or the NDJSON file.
   *   • `regular` — info / warn / error (debug dropped). The default.
   *   • `maximum` — everything, including `debug` (= legacy MYRPG_LOG_DEBUG=1).
   * Server-only, applied globally on boot and on every Configuration save.
   * Absent means `regular`.
   */
  logLevel?: LogLevel;
}

/** Server logging verbosity — see `DevFlags.logLevel`. */
export type LogLevel = "none" | "regular" | "maximum";

export interface AdventureSessionContext {
  adventureId: string;
  adventureTitle: string;
  chapterId: string;
  chapterTitle: string;
  chapterIndex: number;
  totalChapters: number;
  /** Short summaries of previously completed chapters; surfaced to the AIGM under PRIOR CHAPTERS. Empty for chapter 1. */
  priorChapterSummaries: Array<{ chapterId: string; chapterTitle: string; summary: string }>;
  /** Optional named flag that, when set, marks the chapter complete in addition to the default combat-ended detection. Mirrors `AdventureChapter.completionFlag`. */
  completionFlag?: string;
  /** True when this session is the adventure's rest-stop interlude rather
   *  than an actual chapter. The client uses it to label the HUD and to
   *  route LEAVE ENCOUNTER through `/adventure/.../advance` rather than back
   *  to the setup screen — leaving rest means "I'm done, take me to the
   *  next chapter". */
  isRestSession?: boolean;
  /** Id of the adventure's optional rest-stop encounter. Mirrored from
   *  `AdventureDef.restEncounterId` so the client can decide whether to
   *  surface the "rest first?" prompt between chapters without having to
   *  fetch the full adventure registry. */
  restEncounterId?: string;
  /** Display title of the rest encounter (when `restEncounterId` is set).
   *  Used as the prompt's body so the player knows what they're walking
   *  into ("Drop in at the Sparrow's Nest before the next chapter?"). */
  restEncounterTitle?: string;
}

