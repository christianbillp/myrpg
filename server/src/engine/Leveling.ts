/**
 * Leveling — SRD 5.2.1 character advancement.
 *
 * Scope (current): L1 → L2 for the three shipped classes (Wizard, Fighter,
 * Rogue). Builds a `LevelUpPreview` the client renders in the LevelUpOverlay,
 * and applies a player-supplied `LevelUpChoices` to the mutable `PlayerDef`
 * clone the engine carries.
 *
 * L3+ advancement (subclass at L3, ASI/Feat at L4, Tier 2+ features) is not
 * yet supported — `buildPreview` rejects with a clear message so the UI can
 * surface "not yet supported" without silently breaking content.
 */
import type {
  PlayerDef, FeatureDef, SpellDef, LevelUpPreview, LevelUpChoices,
  LevelUpChoicePrompt,
} from '../../../shared/types.js';
import { fixedHpForClass, proficiencyBonusAtLevel, canLevelUp } from '../../../shared/xpTable.js';

const SCHOLAR_SKILLS = ['arcana', 'history', 'investigation', 'medicine', 'nature', 'religion'] as const;

export interface PreviewInput {
  playerDef: PlayerDef;
  /** Current XP — used to gate the call (`xp >= xpForLevel(level + 1)`). */
  xp: number;
  features: FeatureDef[];
  spells: SpellDef[];
}

/**
 * Build the preview the LevelUpOverlay renders. Returns `null` when the
 * character can't level up right now (not enough XP, or already at L20).
 * Throws when the L1+ class is recognised but the target level isn't yet
 * supported by `Leveling.ts`.
 */
export function buildLevelUpPreview(input: PreviewInput): LevelUpPreview | null {
  const { playerDef, xp, features, spells } = input;
  if (!canLevelUp(playerDef.level, xp)) return null;
  return previewForLevel(playerDef, playerDef.level + 1, features, spells);
}

/**
 * Compute the preview for advancing to a specific target level — used both by
 * the live `buildLevelUpPreview` (next level only, gated on XP) and by the
 * session-start replay path (each historical level-up). Throws when the
 * target level isn't yet supported by the Tier 1 scope.
 */
export function previewForLevel(
  playerDef: PlayerDef,
  toLevel: number,
  features: FeatureDef[],
  spells: SpellDef[],
): LevelUpPreview {
  if (toLevel !== 2) {
    throw new Error(`Level-up to ${toLevel} is not yet supported. Tier 1 currently covers L1 -> L2 only.`);
  }
  const fromLevel = toLevel - 1;
  const className = (playerDef.className ?? '').toLowerCase();
  const conMod = abilityMod(playerDef.con);
  const hpGain = Math.max(1, fixedHpForClass(className) + conMod);
  const profBefore = proficiencyBonusAtLevel(fromLevel);
  const profAfter = proficiencyBonusAtLevel(toLevel);

  const newFeatures = newFeaturesForLevel(className, toLevel, features);
  const spellSlotDeltas = spellSlotDeltasForLevel(className, toLevel);
  const choices = choicesForLevel(playerDef, toLevel, spells);

  return {
    fromLevel, toLevel,
    className: playerDef.className,
    hpGain,
    proficiencyBefore: profBefore,
    proficiencyAfter: profAfter,
    spellSlotDeltas,
    newFeatures: newFeatures.map((f) => ({ id: f.id, name: f.name, description: f.description })),
    choices,
  };
}

/**
 * Replay a sequence of level-ups onto a (already-cloned) `playerDef`. Used at
 * session start so the engine's per-session `playerDef` reflects the
 * character's actual current level + recorded choices.
 */
export function applyLevelUpHistory(
  playerDef: PlayerDef,
  history: LevelUpChoices[],
  features: FeatureDef[],
  spells: SpellDef[],
): void {
  for (const choices of history) {
    const preview = previewForLevel(playerDef, playerDef.level + 1, features, spells);
    applyLevelUp({ playerDef, choices, features, spells, preview });
  }
}

/**
 * Apply the level-up to the (already-cloned) `playerDef` in place. The caller
 * (GameEngine) is responsible for then projecting the new `maxHp` onto
 * `state.player.maxHp` and refreshing the on-disk character save.
 *
 * Returns the same preview that was applied so the caller can log it.
 */
export function applyLevelUp(input: {
  playerDef: PlayerDef;
  choices: LevelUpChoices;
  features: FeatureDef[];
  spells: SpellDef[];
  preview: LevelUpPreview;
}): void {
  const { playerDef, choices, preview } = input;

  // 1. Level + maxHp + proficiency bonus.
  playerDef.level = preview.toLevel;
  playerDef.maxHp += preview.hpGain;
  if (preview.proficiencyAfter !== preview.proficiencyBefore) {
    const delta = preview.proficiencyAfter - preview.proficiencyBefore;
    playerDef.proficiencyBonus = preview.proficiencyAfter;
    // Add the pb delta to every proficient skill / save. Pre-baked totals
    // (e.g. skills.arcana = ability + pb) are the source of truth; we shift
    // them in lockstep rather than rebuilding from scratch.
    for (const key of Object.keys(playerDef.skills)) {
      // Without per-skill proficiency flags we can't tell which skills are
      // proficient; the existing PlayerDef shape pre-bakes the bonus on every
      // skill at character-build time. Shift them uniformly to preserve relative
      // ordering — proficient skills move by `delta`, others stay the same.
      // For now we apply the delta uniformly; revisit when adding per-skill
      // proficiency tracking.
      playerDef.skills[key] += delta;
    }
    for (const key of Object.keys(playerDef.savingThrows)) {
      if (playerDef.savingThrowProficiencies.includes(key)) {
        playerDef.savingThrows[key] += delta;
      }
    }
  }

  // 2. Spell slots.
  if (preview.spellSlotDeltas.length > 0) {
    const slots = playerDef.defaultSpellSlots ?? [];
    for (let i = 0; i < preview.spellSlotDeltas.length; i++) {
      slots[i] = (slots[i] ?? 0) + preview.spellSlotDeltas[i];
    }
    playerDef.defaultSpellSlots = slots;
  }

  // 3. New features.
  const known = new Set(playerDef.defaultFeatureIds ?? []);
  for (const f of preview.newFeatures) known.add(f.id);
  playerDef.defaultFeatureIds = Array.from(known);

  // 4. Class-specific choice payloads.
  const className = (playerDef.className ?? '').toLowerCase();
  if (className === 'wizard' && preview.toLevel === 2) {
    // Scholar expertise — add pb again to the chosen skill (Expertise stacks
    // on the already-proficient value).
    const skill = choices.scholarExpertise;
    if (!skill || !(SCHOLAR_SKILLS as readonly string[]).includes(skill)) {
      throw new Error('Wizard L2 requires a scholarExpertise skill from the Scholar list.');
    }
    playerDef.skills[skill] = (playerDef.skills[skill] ?? 0) + playerDef.proficiencyBonus;

    // Wizard spellbook additions. The choice may be empty when the player
    // already knows every available wizard spell at L1; the preview's
    // wizard-spellbook-add prompt carries `count: 0` in that case.
    const additions = choices.wizardSpellbookAdd ?? [];
    const book = new Set(playerDef.defaultSpellbookIds ?? []);
    for (const sid of additions) book.add(sid);
    playerDef.defaultSpellbookIds = Array.from(book);
  }
}

// ── Internal: per-class level catalogue ─────────────────────────────────────

function newFeaturesForLevel(className: string, level: number, features: FeatureDef[]): FeatureDef[] {
  const wanted = featuresGrantedAt(className, level);
  return wanted
    .map((id) => features.find((f) => f.id === id))
    .filter((f): f is FeatureDef => !!f);
}

function featuresGrantedAt(className: string, level: number): string[] {
  if (level !== 2) return [];
  switch (className) {
    case 'wizard':  return ['scholar'];
    case 'fighter': return ['action-surge', 'tactical-mind'];
    case 'rogue':   return ['cunning-action'];
    default:        return [];
  }
}

function spellSlotDeltasForLevel(className: string, level: number): number[] {
  if (level !== 2) return [];
  // SRD Wizard Features table: L1 -> 2 L1 slots, L2 -> 3 L1 slots.
  if (className === 'wizard') return [+1];
  return [];
}

function choicesForLevel(playerDef: PlayerDef, level: number, spells: SpellDef[]): LevelUpChoicePrompt[] {
  if (level !== 2) return [];
  const className = (playerDef.className ?? '').toLowerCase();
  if (className === 'wizard') return wizardL2Choices(playerDef, spells);
  return [];
}

function wizardL2Choices(playerDef: PlayerDef, spells: SpellDef[]): LevelUpChoicePrompt[] {
  const out: LevelUpChoicePrompt[] = [
    {
      kind: 'scholar-expertise',
      label: 'Scholar Expertise',
      description: 'Choose one of these skills. Your proficiency bonus counts twice when you make a check with it.',
      options: [...SCHOLAR_SKILLS],
    },
  ];

  // Wizard L2 grants L1 spell slots only, so the spellbook additions must be
  // L1 spells the character doesn't already know. May be empty (player
  // already learned every shipped L1 wizard spell).
  const known = new Set(playerDef.defaultSpellbookIds ?? []);
  const available = spells
    .filter((s) => s.classes?.includes('wizard') && s.level === 1 && !known.has(s.id))
    .map((s) => ({ id: s.id, name: s.name, level: s.level, school: s.school }));
  out.push({
    kind: 'wizard-spellbook-add',
    label: 'Add Wizard Spells to Spellbook',
    description: available.length === 0
      ? 'You already know every wizard spell of a level you can cast — nothing to add right now.'
      : 'Add two wizard spells of a level you can cast (level 1) to your spellbook.',
    options: available,
    count: Math.min(2, available.length),
  });

  return out;
}

function abilityMod(score: number): number {
  return Math.floor((score - 10) / 2);
}
