/**
 * ClassProgression — pure resolvers over ClassDef / SubclassDef data.
 *
 * Engine code consults this module to ask "what does a level-N <class>
 * have?" without baking any per-class logic into the resolver layer. Each
 * function is total over its inputs: out-of-range levels clamp to the
 * legal 1–20 window so callers don't need to guard.
 *
 * Pure, no side effects, no I/O — safe to use from client and server.
 */
import type {
  ClassDef, ClassProgressionEntry, ClassSpellcasting, LevelUpChoiceTemplate,
  SubclassDef, SubclassProgressionEntry, TrackValue,
} from './types.js';

export const MIN_LEVEL = 1;
export const MAX_LEVEL = 20;

function clampLevel(level: number): number {
  if (level < MIN_LEVEL) return MIN_LEVEL;
  if (level > MAX_LEVEL) return MAX_LEVEL;
  return level;
}

/** Class progression entry at `level`, or null if the class doesn't author
 *  one for that level (no features, no choices). Callers that just want
 *  features should prefer `featuresAt`. */
export function progressionEntryAt(classDef: ClassDef, level: number): ClassProgressionEntry | null {
  const lvl = clampLevel(level);
  return classDef.progression.find((p) => p.level === lvl) ?? null;
}

/** Feature ids the class grants at `level`. Returns `[]` when the entry is
 *  absent or carries no features. */
export function featuresAt(classDef: ClassDef, level: number): string[] {
  return progressionEntryAt(classDef, level)?.features ?? [];
}

/** Choice templates the level-up resolver should surface at `level`. */
export function choicesAt(classDef: ClassDef, level: number): LevelUpChoiceTemplate[] {
  return progressionEntryAt(classDef, level)?.choices ?? [];
}

/** True when reaching `level` should walk the subclass's own progression. */
export function isSubclassLevel(classDef: ClassDef, level: number): boolean {
  return !!progressionEntryAt(classDef, level)?.subclass;
}

/** Spell-slot row at `level`. Returns null for non-casters or pact-magic
 *  casters (callers consult `pactMagicAt` for those). Half-caster rows are
 *  shorter (5 entries) — callers must not assume 9. */
export function spellSlotsAt(classDef: ClassDef, level: number): number[] | null {
  const sc = classDef.spellcasting;
  if (!sc || sc.slotTableKind === 'none' || sc.slotTableKind === 'pact-magic') return null;
  if (!sc.spellSlotsByLevel) return null;
  return sc.spellSlotsByLevel[clampLevel(level) - 1] ?? null;
}

/** Pact-magic state at `level` — `{ slots: N, slotLevel: L }` for Warlocks,
 *  null for everyone else. Caller is expected to track these slots
 *  separately from regular `spellSlots` (different recovery rules). */
export function pactMagicAt(classDef: ClassDef, level: number): { slots: number; slotLevel: number } | null {
  const sc = classDef.spellcasting;
  if (!sc || sc.slotTableKind !== 'pact-magic' || !sc.pactMagic) return null;
  const lvl = clampLevel(level) - 1;
  return {
    slots: sc.pactMagic.slotsByLevel[lvl] ?? 0,
    slotLevel: sc.pactMagic.slotLevelByLevel[lvl] ?? 0,
  };
}

/** Number of cantrips the caster can hold at `level`, or 0 for non-casters. */
export function cantripsKnownAt(classDef: ClassDef, level: number): number {
  return classDef.spellcasting?.cantripsKnownByLevel?.[clampLevel(level) - 1] ?? 0;
}

/** Prepared-spell cap at `level`. Returns 0 for `known` casters (use
 *  `spellsKnownAt`) and for non-casters. */
export function preparedSpellsAt(classDef: ClassDef, level: number): number {
  return classDef.spellcasting?.preparedSpellsByLevel?.[clampLevel(level) - 1] ?? 0;
}

/** Spells-known cap at `level` for Sorcerer/Warlock-style learn models. */
export function spellsKnownAt(classDef: ClassDef, level: number): number {
  return classDef.spellcasting?.spellsKnownByLevel?.[clampLevel(level) - 1] ?? 0;
}

/** Lookup a class-level scaling track value at `level`. Returns null when
 *  the track isn't declared (caller decides whether to fall through to a
 *  default or treat as 0). */
export function trackAt(
  classDef: ClassDef,
  trackId: string,
  level: number,
): TrackValue | null {
  const track = classDef.tracksByLevel?.[trackId];
  if (!track) return null;
  return track[clampLevel(level) - 1] ?? null;
}

/** Convenience for numeric tracks. Returns 0 when the track is missing or
 *  the entry is a dice string (caller asked for a number, gets the zero
 *  default rather than a parse error). */
export function trackNumberAt(classDef: ClassDef, trackId: string, level: number): number {
  const v = trackAt(classDef, trackId, level);
  return typeof v === 'number' ? v : 0;
}

/** Convenience for dice-expression tracks (Martial Arts die, Bardic die).
 *  Returns null when the entry isn't a string. */
export function trackDiceAt(classDef: ClassDef, trackId: string, level: number): string | null {
  const v = trackAt(classDef, trackId, level);
  return typeof v === 'string' ? v : null;
}

// ── Subclass resolvers ─────────────────────────────────────────────────────

export function subclassEntryAt(
  subclassDef: SubclassDef,
  level: number,
): SubclassProgressionEntry | null {
  const lvl = clampLevel(level);
  return subclassDef.progression.find((p) => p.level === lvl) ?? null;
}

/** Subclass features granted at `level`. */
export function subclassFeaturesAt(subclassDef: SubclassDef, level: number): string[] {
  return subclassEntryAt(subclassDef, level)?.features ?? [];
}

/** Spell ids the subclass causes to be always-prepared once `level` is
 *  reached. The engine's prep-cap gate must exclude these (they don't count
 *  toward the player's chosen prepared list). */
export function subclassGrantedSpellsAt(subclassDef: SubclassDef, level: number): string[] {
  return subclassEntryAt(subclassDef, level)?.grantedSpells ?? [];
}

/** Cantrip ids the subclass permanently grants once `level` is reached. */
export function subclassGrantedCantripsAt(subclassDef: SubclassDef, level: number): string[] {
  return subclassEntryAt(subclassDef, level)?.grantedCantrips ?? [];
}

/** Effective spellcasting block for a character — subclass override wins
 *  when present (Eldritch Knight / Arcane Trickster), otherwise falls back
 *  to the parent class. */
export function effectiveSpellcasting(
  classDef: ClassDef,
  subclassDef: SubclassDef | null,
): ClassSpellcasting | null {
  return subclassDef?.spellcasting ?? classDef.spellcasting ?? null;
}

/** All spell slots accumulated by reaching `level` of a class. Returns a
 *  9-slot row even for half-casters (zero-padded) so call sites don't have
 *  to know the slot-table shape. */
export function spellSlotsRow9(classDef: ClassDef, level: number): number[] {
  const row = spellSlotsAt(classDef, level);
  if (!row) return [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const out = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < Math.min(row.length, 9); i++) out[i] = row[i];
  return out;
}

/** Delta between two slot rows. Used by the level-up resolver to find which
 *  slots were gained between `fromLevel` and `toLevel`. */
export function spellSlotDelta(classDef: ClassDef, fromLevel: number, toLevel: number): number[] {
  const a = spellSlotsRow9(classDef, fromLevel);
  const b = spellSlotsRow9(classDef, toLevel);
  return b.map((n, i) => n - a[i]);
}
