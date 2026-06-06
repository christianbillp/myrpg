/**
 * Leveling — SRD 5.2.1 character advancement, driven by class JSON data.
 *
 * Per-level features, spell-slot growth, and choice prompts come from
 * `server/data/classes/<id>.json` via the shared `classProgression`
 * resolver. The previous hard-coded L1 → L2 switch tables have been lifted
 * into data so any level the JSON describes works without code changes.
 *
 * Builds a `LevelUpPreview` the client renders in the LevelUpOverlay, then
 * applies the player-confirmed `LevelUpChoices` to the mutable `PlayerDef`
 * clone the engine carries.
 */
import type {
  PlayerDef, FeatureDef, SpellDef, LevelUpPreview, LevelUpChoices,
  LevelUpChoicePrompt, ClassDef, SubclassDef, FeatDef, AbilityKey,
} from '../../../shared/types.js';
import { proficiencyBonusAtLevel, canLevelUp, fixedHpForClass } from '../../../shared/xpTable.js';
import {
  featuresAt as cpFeaturesAt,
  choicesAt as cpChoicesAt,
  spellSlotDelta,
  preparedSpellsAt,
  isSubclassLevel,
  subclassFeaturesAt,
  subclassGrantedSpellsAt,
  subclassGrantedCantripsAt,
} from '../../../shared/classProgression.js';
import { SCHOLAR_SKILLS as CHOICE_SCHOLAR_SKILLS, applyAllChoices } from './LevelUpChoiceHandlers.js';

// Single source of truth lives in `LevelUpChoiceHandlers.ts` so handler and
// option-list expansion stay in lockstep. Re-aliased locally for the
// existing `wizardL2Choices` call sites — once Phase 4 lands they'll move
// into the handler module too.
const SCHOLAR_SKILLS = CHOICE_SCHOLAR_SKILLS;

export interface PreviewInput {
  playerDef: PlayerDef;
  /** Current XP — used to gate the call (`xp >= xpForLevel(level + 1)`). */
  xp: number;
  features: FeatureDef[];
  spells: SpellDef[];
  classes: ClassDef[];
  subclasses: SubclassDef[];
  feats: FeatDef[];
}

/**
 * Build the preview the LevelUpOverlay renders. Returns `null` when the
 * character can't level up right now (not enough XP, or already at L20).
 */
export function buildLevelUpPreview(input: PreviewInput): LevelUpPreview | null {
  const { playerDef, xp, features, spells, classes, subclasses, feats } = input;
  if (!canLevelUp(playerDef.level, xp)) return null;
  return previewForLevel(playerDef, playerDef.level + 1, features, spells, classes, subclasses, feats);
}

/** Look up a class def by lower-cased name, returning null when the class
 *  isn't authored as data yet (the caller falls back to "no features
 *  granted" semantics so a content gap can't crash level-up). */
function resolveClassDef(className: string, classes: ClassDef[]): ClassDef | null {
  const key = className.toLowerCase();
  return classes.find((c) => c.id.toLowerCase() === key) ?? null;
}

/** Look up the player's chosen subclass def, if any. */
function resolveSubclassDef(playerDef: PlayerDef, subclasses: SubclassDef[]): SubclassDef | null {
  if (!playerDef.subclassId) return null;
  return subclasses.find((s) => s.id === playerDef.subclassId) ?? null;
}

/**
 * Compute the preview for advancing to a specific target level — used both by
 * the live `buildLevelUpPreview` (next level only, gated on XP) and by the
 * session-start replay path (each historical level-up).
 *
 * Reads everything from the class JSON via `classProgression` resolvers. A
 * missing class def (content gap) yields an empty feature list + no choices
 * rather than throwing, so older content stays loadable while new data
 * lands.
 */
export function previewForLevel(
  playerDef: PlayerDef,
  toLevel: number,
  features: FeatureDef[],
  spells: SpellDef[],
  classes: ClassDef[],
  subclasses: SubclassDef[],
  feats: FeatDef[],
): LevelUpPreview {
  const fromLevel = toLevel - 1;
  const classDef = resolveClassDef(playerDef.className ?? '', classes);
  const subclassDef = resolveSubclassDef(playerDef, subclasses);
  const conMod = abilityMod(playerDef.con);
  const hpPerLevel = classDef?.fixedHpPerLevel ?? fixedHpForClass(playerDef.className ?? '');
  // SRD species per-level HP bonus (Dwarven Toughness → +1) rides on top of the
  // class HP gain, projected onto `playerDef` by `applySpecies`.
  const hpGain = Math.max(1, hpPerLevel + conMod) + (playerDef.hpBonusPerLevel ?? 0);
  const profBefore = proficiencyBonusAtLevel(fromLevel);
  const profAfter = proficiencyBonusAtLevel(toLevel);

  // Class-granted features at this level.
  const classFeatureIds = classDef ? cpFeaturesAt(classDef, toLevel) : [];
  // Subclass-granted features when this level is one of the parent's
  // subclassLevels. The class progression's `subclass: true` flag drives the
  // walk so subclass JSONs only have to list their own levels.
  const subclassFeatureIds = (classDef && subclassDef && isSubclassLevel(classDef, toLevel))
    ? subclassFeaturesAt(subclassDef, toLevel)
    : [];
  const featureIds = [...classFeatureIds, ...subclassFeatureIds];
  const newFeatures = featureIds
    .map((id) => features.find((f) => f.id === id))
    .filter((f): f is FeatureDef => !!f);
  const spellSlotDeltas = classDef ? spellSlotDelta(classDef, fromLevel, toLevel) : [];
  const choices = classDef ? expandChoices(playerDef, classDef, toLevel, spells, subclasses, feats) : [];

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
  classes: ClassDef[],
  subclasses: SubclassDef[],
  feats: FeatDef[],
): void {
  for (const choices of history) {
    const preview = previewForLevel(playerDef, playerDef.level + 1, features, spells, classes, subclasses, feats);
    applyLevelUp({ playerDef, choices, features, spells, classes, subclasses, feats, preview });
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
  classes: ClassDef[];
  subclasses: SubclassDef[];
  feats: FeatDef[];
  preview: LevelUpPreview;
}): void {
  const { playerDef, choices, preview } = input;

  // 1. Level + maxHp + proficiency bonus.
  playerDef.level = preview.toLevel;
  playerDef.maxHp += preview.hpGain;
  if (preview.proficiencyAfter !== preview.proficiencyBefore) {
    const delta = preview.proficiencyAfter - preview.proficiencyBefore;
    playerDef.proficiencyBonus = preview.proficiencyAfter;
    // US-119 fix: shift the PB delta onto PROFICIENT skills only — a uniform
    // shift wrongly credited the new bonus to skills the character has no
    // proficiency in. Proficiency is inferred from the pre-baked total the same
    // way Expertise selection does it: `total - abilityMod` is the proficiency
    // contribution, baked against the OLD bonus, so `>= profBefore` means
    // proficient and `>= 2×profBefore` means Expertise (doubled PB → doubled
    // delta). Non-proficient skills (`< profBefore`) stay put.
    const profBefore = preview.proficiencyBefore;
    for (const key of Object.keys(playerDef.skills)) {
      const ability = SKILL_ABILITY[key];
      if (!ability) continue;
      const proficientPart = playerDef.skills[key] - abilityMod(playerDef[ability]);
      if (proficientPart >= profBefore * 2) {
        playerDef.skills[key] += delta * 2;
      } else if (proficientPart >= profBefore) {
        playerDef.skills[key] += delta;
      }
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

  // 4. Choice payloads — registry-driven. Each prompt's `kind` maps to a
  // handler in `LevelUpChoiceHandlers.ts`. Unknown kinds (templates the
  // resolver hasn't surfaced yet) are silently skipped here too so the
  // level-up applies cleanly while content fills in.
  const classDef = resolveClassDef(playerDef.className ?? '', input.classes);
  applyAllChoices(preview.choices, { playerDef, classDef, choices, feats: input.feats });

  // 5. Class-track scaling. Every track the class authors gets updated to
  // the current level's value — covers Sneak Attack dice, Second Wind uses,
  // Martial Arts die, Extra Attack count, etc. with no per-class code path.
  if (classDef) {
    syncTracks(playerDef, classDef, preview.toLevel);
    // Backwards-compat: legacy `sneakAttackDice` field on PlayerDef stays in
    // sync with the canonical track value so existing call sites don't
    // break before they migrate.
    const sad = playerDef.tracks?.['sneak-attack-dice'];
    if (typeof sad === 'number') playerDef.sneakAttackDice = sad;
  }

  // 6. Subclass-granted content. The subclass was just selected by step 4's
  // `subclass-choice` handler, so the subclass features for THIS level need
  // to land here — they weren't in `preview.newFeatures` (the preview was
  // computed before the choice was made). Granted spells / cantrips
  // (Domain, Oath, Circle, Patron) follow the same path; they don't count
  // against the prep cap.
  const subclassDef = resolveSubclassDef(playerDef, input.subclasses);
  if (classDef && subclassDef && isSubclassLevel(classDef, preview.toLevel)) {
    const subFeatureIds = subclassFeaturesAt(subclassDef, preview.toLevel);
    if (subFeatureIds.length > 0) {
      const known = new Set(playerDef.defaultFeatureIds ?? []);
      for (const fid of subFeatureIds) known.add(fid);
      playerDef.defaultFeatureIds = Array.from(known);
    }
    const grantedSpells = subclassGrantedSpellsAt(subclassDef, preview.toLevel);
    if (grantedSpells.length > 0) {
      const prep = new Set(playerDef.defaultPreparedSpellIds ?? []);
      for (const sid of grantedSpells) prep.add(sid);
      playerDef.defaultPreparedSpellIds = Array.from(prep);
    }
    const grantedCantrips = subclassGrantedCantripsAt(subclassDef, preview.toLevel);
    if (grantedCantrips.length > 0) {
      const cantrips = new Set(playerDef.defaultCantripIds ?? []);
      for (const cid of grantedCantrips) cantrips.add(cid);
      playerDef.defaultCantripIds = Array.from(cantrips);
    }
  }
}

/** Project every per-level track in the class JSON onto `playerDef.tracks`.
 *  Idempotent — calling repeatedly at the same level yields the same map.
 *  Tracks not declared by the class are left untouched (so a subclass or
 *  feature could write a custom one and survive a level-up). */
function syncTracks(playerDef: PlayerDef, classDef: ClassDef, level: number): void {
  if (!classDef.tracksByLevel) return;
  const tracks = playerDef.tracks ?? {};
  const lvlIdx = Math.max(1, Math.min(20, level)) - 1;
  for (const [trackId, arr] of Object.entries(classDef.tracksByLevel)) {
    const v = arr[lvlIdx];
    if (v !== undefined) tracks[trackId] = v;
  }
  playerDef.tracks = tracks;
}

/** Public entry point — used by SessionBuilder at character build time so a
 *  freshly-loaded character has its track values populated before the
 *  player's first turn. */
export function syncCharacterTracks(playerDef: PlayerDef, classes: ClassDef[]): void {
  const classDef = resolveClassDef(playerDef.className ?? '', classes);
  if (!classDef) return;
  syncTracks(playerDef, classDef, playerDef.level);
  const sad = playerDef.tracks?.['sneak-attack-dice'];
  if (typeof sad === 'number') playerDef.sneakAttackDice = sad;
  // Backfill L1 class features. The level-up replay starts at L1+1=L2 (it
  // only applies features for levels strictly above the character's source
  // level), so a character whose JSON sits at L1 with no `defaultFeatureIds`
  // would never pick up its own L1 features (Wizard's Spellcasting / Ritual
  // Adept / Arcane Recovery, Fighter's Fighting Style / Second Wind, …).
  // Re-add the L1 features here every session boot so they're always
  // present without each character JSON having to enumerate them.
  const l1Features = cpFeaturesAt(classDef, 1);
  if (l1Features.length > 0) {
    const known = new Set(playerDef.defaultFeatureIds ?? []);
    for (const id of l1Features) known.add(id);
    playerDef.defaultFeatureIds = Array.from(known);
  }
}

// ── Choice template expansion ───────────────────────────────────────────────
//
// The class JSON stores choice templates (`{kind, count?}`) — the resolver
// expands each into a fully-populated `LevelUpChoicePrompt` by filling in
// the `options` list against the live character and game defs. Adding a new
// kind = adding a new branch here and a matching apply handler below.

function expandChoices(
  playerDef: PlayerDef,
  classDef: ClassDef,
  toLevel: number,
  spells: SpellDef[],
  subclasses: SubclassDef[],
  feats: FeatDef[],
): LevelUpChoicePrompt[] {
  const templates = cpChoicesAt(classDef, toLevel);
  const out: LevelUpChoicePrompt[] = [];
  for (const t of templates) {
    switch (t.kind) {
      case 'scholar-expertise':
        out.push({
          kind: 'scholar-expertise',
          label: 'Scholar Expertise',
          description: 'Choose one of these skills. Your proficiency bonus counts twice when you make a check with it.',
          options: [...SCHOLAR_SKILLS],
        });
        break;
      case 'wizard-spellbook-add': {
        // Available pool = wizard spells of a level the character can cast
        // (= any non-empty slot row) that aren't already in their spellbook.
        const known = new Set(playerDef.defaultSpellbookIds ?? []);
        const maxCastable = highestCastableSpellLevel(classDef, toLevel);
        const available = spells
          .filter((s) => s.classes?.includes(classDef.id) && s.level >= 1 && s.level <= maxCastable && !known.has(s.id))
          .map((s) => ({ id: s.id, name: s.name, level: s.level, school: s.school }));
        const requested = t.count ?? classDef.spellcasting?.spellbookGrowthPerLevel ?? 2;
        out.push({
          kind: 'wizard-spellbook-add',
          label: 'Add Wizard Spells to Spellbook',
          description: available.length === 0
            ? 'You already know every wizard spell of a level you can cast — nothing to add right now.'
            : `Add ${requested} wizard spell(s) of a level you can cast (≤ L${maxCastable}) to your spellbook.`,
          options: available,
          count: Math.min(requested, available.length),
        });
        break;
      }
      case 'subclass-choice': {
        // Subclasses for the character's class, with descriptions for the
        // picker preview. Empty when content for the class hasn't been
        // authored — the handler will still throw on commit if no id is
        // sent, so authoring a class without subclasses guarantees the
        // level-up can't be completed (good — surfaces the content gap).
        const options = subclasses
          .filter((s) => s.classId.toLowerCase() === classDef.id.toLowerCase())
          .map((s) => ({ id: s.id, name: s.name, description: s.description }));
        out.push({
          kind: 'subclass-choice',
          label: `${classDef.name} Subclass`,
          description: `Choose your ${classDef.name} subclass. You’ll gain its level ${toLevel} features immediately and its higher-level features as you advance.`,
          options,
        });
        break;
      }
      case 'asi-or-feat': {
        // Eligible feats: every loaded feat the character doesn't already
        // have. Future hook: feats with prerequisites can filter further
        // (e.g. a feat that requires STR 13+); for now the picker shows the
        // full feat catalogue minus the character's current featIds.
        const have = new Set(playerDef.featIds ?? []);
        const featOptions = feats
          .filter((f) => !have.has(f.id))
          .map((f) => ({ id: f.id, name: f.name, description: f.description }));
        const abilityScores: Array<{ key: AbilityKey; current: number }> = [
          { key: 'str', current: playerDef.str },
          { key: 'dex', current: playerDef.dex },
          { key: 'con', current: playerDef.con },
          { key: 'int', current: playerDef.int },
          { key: 'wis', current: playerDef.wis },
          { key: 'cha', current: playerDef.cha },
        ];
        out.push({
          kind: 'asi-or-feat',
          label: 'Ability Score Improvement or Feat',
          description: 'Either raise one ability score by 2 (max 20), raise two ability scores by 1 each (max 20), or take a feat instead.',
          featOptions,
          abilityScores,
        });
        break;
      }
      case 'expertise-pick': {
        // SRD Rogue Expertise — pick from skills the player is already
        // proficient in. Proficiency is inferred from the pre-baked
        // skill total: `skills[k] - mod(playerDef[ability]) >= proficiencyBonus`.
        const proficient: string[] = [];
        for (const [k, total] of Object.entries(playerDef.skills)) {
          const ability = SKILL_ABILITY[k];
          if (!ability) continue;
          const abilityMod = Math.floor((playerDef[ability] - 10) / 2);
          if (total - abilityMod >= playerDef.proficiencyBonus) proficient.push(k);
        }
        out.push({
          kind: 'expertise-pick',
          label: 'Expertise',
          description: `Choose ${t.count} skill(s) you're proficient in. Your Proficiency Bonus counts twice when you make a check with each chosen skill.`,
          options: proficient,
          count: t.count,
        });
        break;
      }
      case 'fighting-style-pick': {
        // SRD Fighting Style feat picker — list every feat tagged
        // `category: "fighting-style"` minus any the character already has.
        // Each feat is a separate JSON in `defs.feats`.
        const have = new Set(playerDef.featIds ?? []);
        const options = feats
          .filter((f) => f.category === 'fighting-style' && !have.has(f.id))
          .map((f) => ({ id: f.id, name: f.name, description: f.description }));
        out.push({
          kind: 'fighting-style-pick',
          label: 'Fighting Style',
          description: 'Choose a Fighting Style feat. You can swap it on later level-up but can\'t take the same one twice.',
          options,
        });
        break;
      }
      case 'epic-boon-choice': {
        // SRD Epic Boon (level 19) — list every feat tagged
        // `category: "epic-boon"` minus any the character already has.
        const have = new Set(playerDef.featIds ?? []);
        const options = feats
          .filter((f) => f.category === 'epic-boon' && !have.has(f.id))
          .map((f) => ({ id: f.id, name: f.name, description: f.description }));
        out.push({
          kind: 'epic-boon-choice',
          label: 'Epic Boon',
          description: 'Choose an Epic Boon feat.',
          options,
        });
        break;
      }
      // The remaining template kinds — cantrip-known, cantrip-swap,
      // spell-swap, metamagic-pick, invocation-pick, mystic-arcanum-pick,
      // magical-secrets-pick — don't yet have runtime
      // prompt builders. They surface as no-ops here so an authored level
      // entry that includes them doesn't crash the preview while they're
      // being implemented.
      default:
        break;
    }
  }
  return out;
}

/** Skill id → owning ability. Mirrors the SRD skill table; exported so
 *  other engine modules (rollAbilityCheck, Enhance Ability) can consult
 *  the same map without duplicating it. */
export const SKILL_ABILITY: Record<string, AbilityKey | undefined> = {
  acrobatics: 'dex', animalHandling: 'wis', arcana: 'int', athletics: 'str',
  deception: 'cha', history: 'int', insight: 'wis', intimidation: 'cha',
  investigation: 'int', medicine: 'wis', nature: 'int', perception: 'wis',
  performance: 'cha', persuasion: 'cha', religion: 'int', sleightOfHand: 'dex',
  stealth: 'dex', survival: 'wis',
};

/** Highest non-empty spell slot level the caster has at `level`. Determines
 *  the cap on additions to a spellbook / known list (you can only learn
 *  spells of a level you can actually cast). */
function highestCastableSpellLevel(classDef: ClassDef, level: number): number {
  const row = classDef.spellcasting?.spellSlotsByLevel?.[Math.max(1, Math.min(20, level)) - 1];
  if (!row) return 0;
  for (let i = row.length - 1; i >= 0; i--) {
    if (row[i] > 0) return i + 1;
  }
  return 0;
}

function abilityMod(score: number): number {
  return Math.floor((score - 10) / 2);
}

// `preparedSpellsAt` is re-exported for the AIGM-state surface (cap is
// displayed alongside the prepared list).
export { preparedSpellsAt };
