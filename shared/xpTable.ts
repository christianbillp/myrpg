/**
 * SRD 5.2.1 Character Advancement table — XP required to reach each
 * level and the proficiency bonus at that level. Source: Creating a
 * Character → Level Advancement.
 *
 * Indexed by character level (1..20). `XP_FOR_LEVEL[L]` is the XP total
 * required to *reach* level `L`. A character at level 1 has 0 XP; they
 * advance to level 2 once their XP total is ≥ 300.
 */
export const XP_FOR_LEVEL: readonly number[] = [
  0,        // L1
  300,      // L2
  900,      // L3
  2_700,    // L4
  6_500,    // L5
  14_000,   // L6
  23_000,   // L7
  34_000,   // L8
  48_000,   // L9
  64_000,   // L10
  85_000,   // L11
  100_000,  // L12
  120_000,  // L13
  140_000,  // L14
  165_000,  // L15
  195_000,  // L16
  225_000,  // L17
  265_000,  // L18
  305_000,  // L19
  355_000,  // L20
];

/** Proficiency Bonus at each character level (SRD Character Advancement). */
export const PROFICIENCY_BONUS: readonly number[] = [
  2, 2, 2, 2,  // L1–4
  3, 3, 3, 3,  // L5–8
  4, 4, 4, 4,  // L9–12
  5, 5, 5, 5,  // L13–16
  6, 6, 6, 6,  // L17–20
];

export const MAX_CHARACTER_LEVEL = 20;

/** XP threshold required to reach the given level. Returns Infinity past L20. */
export function xpForLevel(level: number): number {
  if (level < 1) return 0;
  if (level > MAX_CHARACTER_LEVEL) return Infinity;
  return XP_FOR_LEVEL[level - 1];
}

/** Proficiency bonus at the given level. Clamped to L1..L20. */
export function proficiencyBonusAtLevel(level: number): number {
  const idx = Math.max(1, Math.min(MAX_CHARACTER_LEVEL, level)) - 1;
  return PROFICIENCY_BONUS[idx];
}

/** True when the given XP total has reached the threshold to advance from `level` to `level+1`. */
export function canLevelUp(level: number, xp: number): boolean {
  if (level >= MAX_CHARACTER_LEVEL) return false;
  return xp >= xpForLevel(level + 1);
}

/**
 * Fixed Hit Points per level by class (SRD "Fixed Hit Points by Class"
 * table). Each value is added to the player's Constitution modifier on
 * level-up; the SRD allows rolling instead but the fixed value is the
 * canonical "average + 1" choice that most players take.
 *
 * Keyed by lower-cased class name.
 */
export const FIXED_HP_PER_LEVEL: Record<string, number> = {
  barbarian: 7,
  fighter:   6,
  paladin:   6,
  ranger:    6,
  bard:      5,
  cleric:    5,
  druid:     5,
  monk:      5,
  rogue:     5,
  warlock:   5,
  sorcerer:  4,
  wizard:    4,
};

/** Fixed HP gain (before Con mod) for the given class name. Returns 5 (the
 *  median bucket) when the class isn't recognised. */
export function fixedHpForClass(className: string): number {
  return FIXED_HP_PER_LEVEL[className.toLowerCase()] ?? 5;
}
