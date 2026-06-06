/**
 * SRD 5.2.1 languages (US-123). Every player character knows Common plus two
 * Standard languages chosen at creation; class features and other grants can
 * add more (Rogue's Thieves' Cant, Druid's Druidic, …). Source: "Creating a
 * Character → Choose Languages".
 */

export const COMMON = "Common";

/** Standard Languages table (widespread). Common is always known and listed
 *  first; the rest are the player's choices. */
export const STANDARD_LANGUAGES: readonly string[] = [
  "Common",
  "Common Sign Language",
  "Draconic",
  "Dwarvish",
  "Elvish",
  "Giant",
  "Gnomish",
  "Goblin",
  "Halfling",
  "Orc",
];

/** Rare Languages table (secret or planar). Granted by specific features, not
 *  chosen freely at creation. Primordial includes the Aquan/Auran/Ignan/Terran
 *  dialects (mutually intelligible). */
export const RARE_LANGUAGES: readonly string[] = [
  "Abyssal",
  "Celestial",
  "Deep Speech",
  "Druidic",
  "Infernal",
  "Primordial",
  "Sylvan",
  "Thieves' Cant",
  "Undercommon",
];

/** Number of Standard languages (beyond Common) a character chooses at creation. */
export const STANDARD_LANGUAGE_CHOICES = 2;

export function isStandardLanguage(name: string): boolean {
  return STANDARD_LANGUAGES.includes(name);
}

export function isKnownLanguage(name: string): boolean {
  return STANDARD_LANGUAGES.includes(name) || RARE_LANGUAGES.includes(name);
}

/** Merge language sources into a unique, Common-first list (case-sensitive on
 *  the canonical names above). */
export function mergeLanguages(...groups: Array<readonly string[] | undefined>): string[] {
  const out: string[] = [COMMON];
  const seen = new Set<string>([COMMON]);
  for (const g of groups) {
    for (const name of g ?? []) {
      if (!seen.has(name)) { out.push(name); seen.add(name); }
    }
  }
  return out;
}
