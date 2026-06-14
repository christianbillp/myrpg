/**
 * Armor / weapon / shield / consumable / ammunition / gear shapes.
 *
 * Extracted from the original god-file `shared/types.ts` (now a barrel that
 * re-exports every domain module under `shared/types/`).
 */


export interface ConsumableDef {
  id: string; name: string; type: 'consumable';
  /** Healing rolled on use (`healDice`d`healSides` + `healBonus`). All optional
   *  — a non-healing potion (e.g. a temp-HP draught) may omit them. */
  healDice?: number; healSides?: number; healBonus?: number;
  /** Temporary HP granted on use (US-124 potions beyond healing): rolled as
   *  `tempHpDice`d`tempHpSides` + `tempHpBonus`. Applied per SRD temp-HP rules
   *  (the higher of current vs granted; they don't stack). */
  tempHpDice?: number; tempHpSides?: number; tempHpBonus?: number;
}

export type ArmorCategory = 'light' | 'medium' | 'heavy';

/** SRD magic-item rarity (US-124). */
export type Rarity = 'common' | 'uncommon' | 'rare' | 'very-rare' | 'legendary' | 'artifact';

/**
 * Common magic-item metadata shared by weapons / armor / shields (US-124).
 * `bonus` is the SRD enhancement bonus (+1/+2/+3): added to attack & damage for
 * weapons, to AC for armor / shields. Per SRD, +N weapons & armor do NOT require
 * attunement, so the bonus applies whenever the item is equipped. (Attunement
 * gating for items that need it is a later slice.)
 */
export interface MagicItemProps {
  magic?: boolean;
  rarity?: Rarity;
  bonus?: number;
  /** SRD attunement (US-124 Slice 2): when true, the item's `bonus` (and future
   *  effects) apply only while the player is attuned to it (≤ 3 attuned items,
   *  bonded over a Short Rest). */
  requiresAttunement?: boolean;
  /** SRD identification (US-124 Slice 3): when true, the item is found
   *  unidentified — its name/properties read as "Unidentified <category>" to
   *  the player until identified (Identify spell or a Short Rest examining it).
   *  Identification is informational; the item still functions when used/worn. */
  startsUnidentified?: boolean;
  /** Masked name shown while unidentified, in place of the generic
   *  "Unidentified <category>". Lets a magic item pose as a mundane object
   *  (a Cloak of Protection reading as "Senior White Cape"). */
  unidentifiedName?: string;
  /** Cloak/Ring-of-Protection pattern: while ATTUNED, grants +N to AC and +N to
   *  every saving throw. Independent of the weapon/armor enhancement `bonus`. */
  protectionBonus?: number;
}

export interface ArmorDef extends MagicItemProps {
  id: string; name: string; type: 'armor';
  category: ArmorCategory;
  baseAc: number; addDex: boolean; maxDex: number | null;
  stealthDisadv?: boolean;
  minStr?: number | null;
  /** Shop price in Copper Pieces (SRD coin system — see `shared/currency.ts`). */
  costCp?: number;
}

export interface ShieldDef extends MagicItemProps {
  id: string; name: string; type: 'shield';
  acBonus: number;
  costCp?: number;
}

export type WeaponMastery = 'graze' | 'vex' | 'sap' | 'nick' | 'topple' | 'push' | 'cleave' | 'slow';

export interface WeaponDef extends MagicItemProps {
  id: string; name: string; type: 'weapon';
  statKey: 'str' | 'dex';
  damageDice: number; damageSides: number; damageType: string;
  mastery: WeaponMastery | string | null;
  finesse: boolean; twoHanded: boolean;
  thrown: boolean; throwNormal: number; throwLong: number;
  // Ranged-weapon fields (omit / 0 / false for melee weapons).
  rangeNormal?: number;       // feet — normal ranged range
  rangeLong?: number;         // feet — maximum ranged range
  ammunitionType?: string;    // e.g. "arrow", "bolt", "bullet", "needle"
  loading?: boolean;          // one shot per Action/Bonus/Reaction
  /** SRD Light (US-128) — qualifies the weapon for Two-Weapon Fighting: a
   *  Light weapon in each hand lets the off-hand make a bonus-action attack. */
  light?: boolean;
  heavy?: boolean;            // SRD Heavy — Disadvantage if DEX < 13 (ranged) or STR < 13 (melee) (US-111)
  /** SRD Versatile — the larger damage die used when wielded two-handed (no
   *  shield equipped). Absent for non-versatile weapons. (US-111) */
  versatile?: { damageDice: number; damageSides: number };
  /** SRD Reach — melee reach is 10 ft (2 tiles) instead of 5. (US-111) */
  reach?: boolean;
  costCp?: number;
}

// Ammunition is its own equipment subtype so it's distinct from health potions
// (consumables) but still represented as inventory items (stackable by id).
export interface AmmunitionDef {
  id: string; name: string; type: 'ammunition';
  ammunitionType: string;  // canonical key matching WeaponDef.ammunitionType
  costCp?: number;
}

// Area-denial gear (caltrops, ball bearings) is *deployed* onto the map as a
// persistent `ActiveZone` — the same primitive spells use — so it renders like
// a spell effect and shows up in tile info. A creature that enters the zone
// rolls `enterSave`; on a failure it suffers `condition` and/or `enterDamage`.
// SRD: caltrops → 5-ft square, DC 15 Dex, 1 Piercing + Speed 0 (hobbled);
// ball bearings → 10-ft square, DC 10 Dex, Prone.
export interface AreaDenialDef {
  /** Zone label rendered on the map (e.g. "Caltrops"). */
  zoneName: string;
  /** Side length of the (square) covered area in feet — 5 = one tile. */
  sizeFeet: number;
  /** How far from the deployer the area can be placed, in feet. */
  rangeFeet: number;
  /** Save rolled the first time a creature enters the area on its turn. */
  enterSave: { ability: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'; dc: number };
  /** Condition applied on a failed save (e.g. 'prone', 'hobbled'). */
  condition?: string;
  /** Flat damage applied on a failed save (caltrops: 1 Piercing). */
  enterDamage?: { amount: number; type: string };
  /** Rounds the area persists before it's spent (SRD recovery is 10 min). */
  durationRounds: number;
  /** Visual tint (CSS hex). Falls back to a default if absent. */
  tintHex?: string;
}

// Gear is a catch-all for non-functional inventory items — class artifacts
// like a wizard's spellbook, holy symbols, tools, books, etc. They appear in
// the inventory as flavour/lore objects with no UI action button. Distinct
// from ammunition (which is auto-consumed) and consumables (which have USE).
// `areaDenial` upgrades a piece of gear into a deployable trap (see above).
export interface GearDef extends MagicItemProps {
  id: string; name: string; type: 'gear';
  description?: string;
  costCp?: number;
  areaDenial?: AreaDenialDef;
  /** Carried light emission when lit via the LIGHT action (US-127): Bright
   *  Light within `brightFt` of the carrier, Darkness lifted to Dim out to
   *  `brightFt + dimFt` (SRD torch 20/20, hooded lantern 30/30). */
  lightSource?: { brightFt: number; dimFt: number };
}

/**
 * Spell scroll (US-124): a single-use item that casts its `spellId` when used,
 * without expending a spell slot, then is consumed. Reuses the normal cast
 * resolver + targeting; casting from a scroll bypasses the prepared/known and
 * slot gates but still costs the spell's action.
 */
export interface ScrollDef extends MagicItemProps {
  id: string; name: string; type: 'scroll';
  /** Id of the `SpellDef` this scroll casts. */
  spellId: string;
  costCp?: number;
}

export type EquipmentDef = ArmorDef | ShieldDef | WeaponDef;
export type ItemDef = ConsumableDef | AmmunitionDef | EquipmentDef | GearDef | ScrollDef;

/** Whether `itemId` (a `startsUnidentified` magic item) has been identified by
 *  the player this session (US-124). Non-unidentified items are always "known". */
export function isItemIdentified(item: ItemDef, identifiedItemIds: string[] | undefined): boolean {
  const props = item as MagicItemProps;
  if (!props.startsUnidentified) return true;
  return (identifiedItemIds ?? []).includes(item.id);
}

/** Display name shown to the player: the true name once identified, else a
 *  masked "Unidentified <category>" (US-124). */
export function itemDisplayName(item: ItemDef, identifiedItemIds: string[] | undefined): string {
  if (isItemIdentified(item, identifiedItemIds)) return item.name;
  // A masked name lets a magic item pose as something mundane while unidentified.
  const masked = (item as MagicItemProps).unidentifiedName;
  if (masked) return masked;
  const cat = item.type === 'scroll' ? 'Scroll'
    : item.type === 'armor' ? 'Armor'
    : item.type === 'shield' ? 'Shield'
    : item.type === 'weapon' ? 'Weapon'
    : 'Item';
  return `Unidentified ${cat}`;
}
