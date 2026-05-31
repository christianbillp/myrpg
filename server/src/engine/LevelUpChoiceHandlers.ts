/**
 * LevelUpChoiceHandlers — one apply function per `LevelUpChoicePrompt.kind`.
 *
 * The Leveling.ts core walks the `preview.choices` list and dispatches each
 * prompt to a handler here. Each handler mutates the `PlayerDef` clone in
 * place using the player's confirmed payload. Adding a new choice kind is:
 *
 *   1. Add the template variant to `LevelUpChoiceTemplate` in shared/types.
 *   2. Add the prompt variant to `LevelUpChoicePrompt` in shared/types.
 *   3. Add the answer field to `LevelUpChoices` in shared/types.
 *   4. Expand the template in `Leveling.expandChoices` (populates `options`).
 *   5. Register a handler here that consumes the answer.
 *   6. Add a render block in the client LevelUpOverlay.
 *
 * Handlers throw a clean Error when the player's answer is missing or
 * invalid, so the engine surfaces it to the client without partial state.
 */
import type {
  AbilityKey, ClassDef, FeatDef, LevelUpChoicePrompt, LevelUpChoices, PlayerDef,
} from '../../../shared/types.js';

export const ABILITY_KEYS: AbilityKey[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
export const MAX_ABILITY_SCORE = 20;

export const SCHOLAR_SKILLS = [
  'arcana', 'history', 'investigation', 'medicine', 'nature', 'religion',
] as const;

export interface ChoiceContext {
  playerDef: PlayerDef;
  classDef: ClassDef | null;
  choices: LevelUpChoices;
  /** Loaded feat catalogue — supplied so the asi-or-feat handler can
   *  validate the chosen feat and apply its stat/effect rider. */
  feats?: FeatDef[];
}

type Handler = (prompt: LevelUpChoicePrompt, ctx: ChoiceContext) => void;

const HANDLERS: Record<LevelUpChoicePrompt['kind'], Handler> = {
  'scholar-expertise': (prompt, ctx) => {
    const skill = ctx.choices.scholarExpertise;
    if (!skill || (prompt.kind === 'scholar-expertise' && !prompt.options.includes(skill))) {
      throw new Error('Scholar Expertise requires a skill from the prompt\'s option list.');
    }
    ctx.playerDef.skills[skill] = (ctx.playerDef.skills[skill] ?? 0) + ctx.playerDef.proficiencyBonus;
  },
  'wizard-spellbook-add': (prompt, ctx) => {
    if (prompt.kind !== 'wizard-spellbook-add') return;
    const additions = ctx.choices.wizardSpellbookAdd ?? [];
    if (prompt.count > 0 && additions.length !== prompt.count) {
      throw new Error(`Wizard spellbook add requires exactly ${prompt.count} spell ids.`);
    }
    const allowed = new Set(prompt.options.map((o) => o.id));
    for (const sid of additions) {
      if (!allowed.has(sid)) throw new Error(`Spell "${sid}" isn't in the wizard-spellbook-add option list.`);
    }
    const book = new Set(ctx.playerDef.defaultSpellbookIds ?? []);
    for (const sid of additions) book.add(sid);
    ctx.playerDef.defaultSpellbookIds = Array.from(book);
  },
  'subclass-choice': (prompt, ctx) => {
    if (prompt.kind !== 'subclass-choice') return;
    const picked = ctx.choices.subclassChoice;
    if (!picked) throw new Error('Subclass choice requires a subclass id.');
    if (!prompt.options.some((o) => o.id === picked)) {
      throw new Error(`Subclass "${picked}" isn't in the subclass-choice option list.`);
    }
    ctx.playerDef.subclassId = picked;
  },
  'asi-or-feat': (prompt, ctx) => {
    if (prompt.kind !== 'asi-or-feat') return;
    const answer = ctx.choices.asiOrFeat;
    if (!answer) throw new Error('ASI-or-Feat prompt requires an answer.');
    if (answer.kind === 'asi-plus-2') {
      if (!ABILITY_KEYS.includes(answer.ability)) throw new Error(`Unknown ability "${answer.ability}".`);
      const cur = ctx.playerDef[answer.ability];
      if (cur + 2 > MAX_ABILITY_SCORE) {
        throw new Error(`Can't raise ${answer.ability.toUpperCase()} above ${MAX_ABILITY_SCORE} (currently ${cur}).`);
      }
      ctx.playerDef[answer.ability] = cur + 2;
    } else if (answer.kind === 'asi-plus-1') {
      const [a, b] = answer.abilities;
      if (a === b) throw new Error('ASI +1/+1 must pick two different abilities.');
      for (const k of [a, b]) {
        if (!ABILITY_KEYS.includes(k)) throw new Error(`Unknown ability "${k}".`);
        const cur = ctx.playerDef[k];
        if (cur + 1 > MAX_ABILITY_SCORE) {
          throw new Error(`Can't raise ${k.toUpperCase()} above ${MAX_ABILITY_SCORE} (currently ${cur}).`);
        }
        ctx.playerDef[k] = cur + 1;
      }
    } else if (answer.kind === 'feat') {
      if (!prompt.featOptions.some((f) => f.id === answer.featId)) {
        throw new Error(`Feat "${answer.featId}" isn't in the asi-or-feat option list.`);
      }
      const feats = new Set(ctx.playerDef.featIds ?? []);
      if (feats.has(answer.featId)) {
        throw new Error(`Feat "${answer.featId}" is already on this character.`);
      }
      feats.add(answer.featId);
      ctx.playerDef.featIds = Array.from(feats);
      // The feat's stat/effect rider is replayed by `applyFeats` at session
      // boot — no need to apply it here.
    }
  },
  'expertise-pick': (prompt, ctx) => {
    if (prompt.kind !== 'expertise-pick') return;
    const picks = ctx.choices.expertisePick ?? [];
    if (picks.length !== prompt.count) {
      throw new Error(`Expertise requires exactly ${prompt.count} skill(s).`);
    }
    const allowed = new Set(prompt.options);
    for (const skill of picks) {
      if (!allowed.has(skill)) throw new Error(`Skill "${skill}" isn't in the expertise-pick option list (not currently proficient).`);
    }
    // Dedupe across the L1/L6 prompts: stack PB at most once per skill per
    // level-up. The player can't double-pick within a single prompt either.
    const seen = new Set<string>();
    for (const skill of picks) {
      if (seen.has(skill)) throw new Error(`Expertise can't be applied to the same skill twice.`);
      seen.add(skill);
      ctx.playerDef.skills[skill] = (ctx.playerDef.skills[skill] ?? 0) + ctx.playerDef.proficiencyBonus;
    }
  },
  'fighting-style-pick': (prompt, ctx) => {
    if (prompt.kind !== 'fighting-style-pick') return;
    const pick = ctx.choices.fightingStylePick;
    if (!pick) throw new Error('Fighting Style requires a feat id.');
    if (!prompt.options.some((f) => f.id === pick)) {
      throw new Error(`Fighting Style "${pick}" isn't in the fighting-style-pick option list.`);
    }
    const feats = new Set(ctx.playerDef.featIds ?? []);
    if (feats.has(pick)) {
      throw new Error(`Fighting Style "${pick}" is already on this character.`);
    }
    feats.add(pick);
    ctx.playerDef.featIds = Array.from(feats);
    // The feat's effect rider lands when `applyFeats` runs on the next
    // session boot (Defense: sets `fightingStyleDefense = true`).
  },
};

/** Dispatch a single prompt to its handler. Unknown kinds (templates the
 *  resolver hasn't surfaced yet) are silently skipped — the level-up still
 *  applies the level/HP/feature bookkeeping. */
export function applyChoicePrompt(prompt: LevelUpChoicePrompt, ctx: ChoiceContext): void {
  const fn = HANDLERS[prompt.kind];
  if (fn) fn(prompt, ctx);
}

/** Apply every prompt in the preview to the player def. The caller passes
 *  the whole preview's choice list (already populated with runtime
 *  `options`) and the player's answers. */
export function applyAllChoices(
  prompts: LevelUpChoicePrompt[],
  ctx: ChoiceContext,
): void {
  for (const p of prompts) applyChoicePrompt(p, ctx);
}
