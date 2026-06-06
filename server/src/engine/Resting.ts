/**
 * Resting — SRD 5.2.1 Long Rest implementation.
 *
 * Per the SRD (Rules Glossary → Long Rest), a Long Rest is "8 hours of
 * extended downtime" and restores:
 *   • All lost Hit Points
 *   • All spent Hit Point Dice
 *   • All spell slots (per each caster's Spellcasting feature)
 *   • Class-feature resources gated on Long Rest (or all rests, e.g. Action
 *     Surge, Second Wind — anything not Cantrip/passive)
 *   • Reduces Exhaustion by 1
 *
 * Wizards additionally rebuild their prepared-spell list during a Long Rest:
 *   "Whenever you finish a Long Rest, you can change your list of prepared
 *    spells, replacing any of the spells there with spells from your
 *    spellbook."  — Wizard.md
 *
 * The picker is the only player-facing choice the SRD surfaces on rest for
 * the three shipped classes. Non-Wizard classes have no Long Rest choices
 * at L1-2 (the scope our level-up system currently supports).
 */
import type {
  PlayerDef, FeatureDef, SpellDef, PlayerState, NpcState, ClassDef,
  LongRestPreview, LongRestChoices,
} from '../../../shared/types.js';
import { preparedSpellsAt } from '../../../shared/classProgression.js';

export interface RestingInputs {
  playerDef: PlayerDef;
  player: PlayerState;
  features: FeatureDef[];
  spells: SpellDef[];
  /** Resolved class definition — the single source of truth for the
   *  prepared-spell cap and the spellbook learn model. Null for an
   *  unrecognised class (no rest-time prep picker). */
  classDef: ClassDef | null;
  /** Live NPCs — companions among them share the rest's benefits. */
  npcs?: NpcState[];
}

/** Negative / temporary conditions a Long Rest ends for a companion. Excludes
 *  persistent or meta states (e.g. `dead`, `hidden`). */
const REST_CLEARABLE_CONDITIONS: ReadonlySet<string> = new Set([
  'poisoned', 'frightened', 'prone', 'blinded', 'deafened', 'stunned',
  'restrained', 'grappled', 'charmed', 'slowed', 'vexed', 'paralyzed',
  'incapacitated', 'dazed', 'exhausted',
]);

/** Living companions in a session's NPC list (the ones a rest benefits). */
function restingCompanions(npcs: NpcState[] | undefined): NpcState[] {
  return (npcs ?? []).filter((n) => n.companion && n.hp > 0);
}

/** Cap = max(class `preparedSpellsByLevel` value, current preparation count)
 *  so feat-granted extras (Magic Initiate, etc.) are not silently stripped on
 *  rest. The per-level table lives on the class definition
 *  (`spellcasting.preparedSpellsByLevel`) — the single source of truth shared
 *  with level-up — rather than being duplicated here. */
function preparedCap(classDef: ClassDef | null, level: number, currentlyPreparedCount: number): number {
  const tableValue = classDef ? preparedSpellsAt(classDef, level) : 0;
  return Math.max(tableValue, currentlyPreparedCount);
}

/**
 * Build the Long Rest preview the client renders. Pure read-only — caller
 * (engine) decides when to call `applyLongRest` to commit.
 */
export function buildLongRestPreview(inputs: RestingInputs): LongRestPreview {
  const { playerDef, player, features, spells } = inputs;

  const hpRestored = Math.max(0, playerDef.maxHp - player.hp);
  const hitDiceRestored = player.hitDiceUsed;

  // Spell slot deltas — restore each level to its `defaultSpellSlots[i]` cap.
  const maxSlots = playerDef.defaultSpellSlots ?? [];
  const spellSlotsRestored: number[] = maxSlots.map((max, i) => {
    const cur = player.spellSlots[i] ?? 0;
    return Math.max(0, max - cur);
  });

  // Feature resources — every feature with a non-unlimited resource is fully
  // refilled on Long Rest (both `uses-per-long-rest` and `uses-per-short-rest`
  // pools refresh — long rest is also a short rest's superset).
  const featuresRestored: LongRestPreview['featuresRestored'] = [];
  for (const fid of playerDef.defaultFeatureIds ?? []) {
    const def = features.find((f) => f.id === fid);
    if (!def?.resource || def.resource.kind === 'unlimited') continue;
    const before = player.resources[fid] ?? 0;
    if (before < def.resource.max) {
      featuresRestored.push({ id: fid, name: def.name, before, max: def.resource.max });
    }
  }

  const exhaustionReduced = (player.exhaustionLevel ?? 0) > 0;

  // Companions rest too: full HP + any rest-clearable conditions removed.
  const companionsRestored: NonNullable<LongRestPreview['companionsRestored']> = [];
  for (const npc of restingCompanions(inputs.npcs)) {
    const hpRestored = Math.max(0, npc.maxHp - npc.hp);
    const conditionsCleared = npc.conditions.filter((c) => REST_CLEARABLE_CONDITIONS.has(c));
    if (hpRestored > 0 || conditionsCleared.length > 0) {
      companionsRestored.push({ id: npc.id, name: npc.revealedName ?? npc.name, hpRestored, conditionsCleared });
    }
  }

  // Spellbook prep picker — only for spellbook-learn-model casters (Wizard).
  // The picker shows every spell in the spellbook; the player ticks up to
  // `maxPrepared`. Driven by the class definition's learn model rather than a
  // class-name check, so a new spellbook class needs no engine change.
  let wizardSpellPrep: LongRestPreview['wizardSpellPrep'] | undefined;
  const isSpellbookCaster = inputs.classDef?.spellcasting?.learnModel === 'spellbook';
  if (isSpellbookCaster) {
    const book = playerDef.defaultSpellbookIds ?? [];
    const known = new Set(book);
    const spellbookSpells = spells
      .filter((s) => known.has(s.id))
      .map((s) => ({ id: s.id, name: s.name, level: s.level, school: s.school }));
    const currentlyPrepared = player.preparedSpellIds.filter((id) => known.has(id));
    wizardSpellPrep = {
      spellbookSpells,
      currentlyPrepared,
      maxPrepared: preparedCap(inputs.classDef, playerDef.level, currentlyPrepared.length),
    };
  }

  return {
    hpRestored,
    hitDiceRestored,
    spellSlotsRestored,
    featuresRestored,
    exhaustionReduced,
    companionsRestored,
    wizardSpellPrep,
  };
}

/**
 * Apply a Long Rest. Restores HP / hit dice / spell slots / feature pools /
 * exhaustion; for Wizards, replaces `preparedSpellIds` with the player's
 * picks. Mutates `player` in place and logs a header to `ctx.addLog` (passed
 * by the caller as a `log` function rather than coupled to GameContext).
 *
 * Validates the wizard pick set: every chosen id must be in the spellbook,
 * and the count must not exceed the cap from `buildLongRestPreview`.
 */
export function applyLongRest(
  inputs: RestingInputs,
  choices: LongRestChoices,
  preview: LongRestPreview,
): void {
  const { playerDef, player, features } = inputs;

  player.hp = playerDef.maxHp;
  player.hitDiceUsed = 0;

  const maxSlots = playerDef.defaultSpellSlots ?? [];
  player.spellSlots = maxSlots.map((m) => m);

  // Warlock Pact Magic — also refills on a Long Rest (SRD: "all expended
  // Pact Magic spell slots", same line as Short Rest). When absent
  // (non-Warlock) the field stays undefined.
  if (player.pactMagic) {
    player.pactMagic.remaining = player.pactMagic.max;
  }
  // Warlock Mystic Arcanum — each spell becomes usable again on Long Rest.
  if (player.mysticArcanum) {
    for (const slot of Object.values(player.mysticArcanum)) slot.used = false;
  }
  // SRD Wizard Arcane Recovery — once per Long Rest. Clear the flag so the
  // next Short Rest is eligible.
  player.arcaneRecoveryUsed = false;

  for (const fid of playerDef.defaultFeatureIds ?? []) {
    const def = features.find((f) => f.id === fid);
    if (!def?.resource || def.resource.kind === 'unlimited') continue;
    player.resources[fid] = def.resource.max;
  }

  if (preview.exhaustionReduced) {
    player.exhaustionLevel = Math.max(0, (player.exhaustionLevel ?? 0) - 1);
  }

  // Companions share the Long Rest: HP to full, rest-clearable conditions gone.
  for (const npc of restingCompanions(inputs.npcs)) {
    npc.hp = npc.maxHp;
    npc.conditions = npc.conditions.filter((c) => !REST_CLEARABLE_CONDITIONS.has(c));
  }

  // Spellbook prepared-spell rebuild (Wizard learn model).
  const isSpellbookCaster = inputs.classDef?.spellcasting?.learnModel === 'spellbook';
  if (isSpellbookCaster && preview.wizardSpellPrep) {
    const picks = choices.wizardPreparedSpellIds ?? [];
    const book = new Set(playerDef.defaultSpellbookIds ?? []);
    for (const id of picks) {
      if (!book.has(id)) throw new Error(`Wizard prep includes ${id}, which isn't in the spellbook.`);
    }
    if (picks.length > preview.wizardSpellPrep.maxPrepared) {
      throw new Error(`Wizard prep limit exceeded: picked ${picks.length}, max ${preview.wizardSpellPrep.maxPrepared}.`);
    }
    // Dedupe + preserve order.
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const id of picks) {
      if (!seen.has(id)) { deduped.push(id); seen.add(id); }
    }
    player.preparedSpellIds = deduped;
  }
}
