/**
 * Quest-type recipes. Each module rolls a `GeneratedQuest` of one type: the
 * creatures + map (via `buildQuestEncounter`), the world-flag triggers that
 * signal stage completion, and the `QuestDef` whose steps watch those flags.
 *
 * Adding a type = one module here + an entry in `questGenerator.ts`. The shared
 * helpers below keep every recipe to a few lines.
 */
import type { QuestDef, QuestStepDef } from '../../../shared/types.js';
import type {
  GeneratedQuest, GeneratedQuestEncounter, QuestGenContext, QuestTypeModule, QuestGenReward,
} from './questGenTypes.js';
import { newQuestIds, stageEncounterId } from './questIds.js';
import { questBudgetXp, pickEnemies, rewardForEnemies, monsterXp } from './questDifficulty.js';
import { buildQuestEncounter, eastObjectiveArea, type Biome } from './questEncounterBuilder.js';

// ── Flavours (theme → biome + enemy pool + prose nouns) ──────────────────────
interface Flavour { biome: Biome; pool: string[]; label: string; site: string; }
const FLAVOURS: Record<string, Flavour> = {
  bandit: { biome: 'grassland', pool: ['bandit'], label: 'bandits', site: 'the east road' },
  goblin: { biome: 'forest', pool: ['goblin_minion'], label: 'goblins', site: 'the wardstone wood' },
  undead: { biome: 'grassland', pool: ['skeleton'], label: 'risen dead', site: 'the broken ward' },
};
const FLAVOUR_KEYS = Object.keys(FLAVOURS);
const pickFlavour = (rng: () => number): string => FLAVOUR_KEYS[Math.floor(rng() * FLAVOUR_KEYS.length)];

// ── Shared trigger builders (untyped objects matching EncounterTrigger) ──────
const beginTrigger = { id: 'begin_quest', when: { event: 'encounter_started' }, then: [{ type: 'begin_generated_quest' }], once: true };
const introTrigger = (msg: string) => ({ id: 'intro', when: { event: 'encounter_started' }, then: [{ type: 'send_aigm_message', message: msg }], once: true });
const clearFlagTrigger = (flag: string) => ({ id: 'clear', when: { event: 'npc_killed' }, if: [{ type: 'enemies_alive', op: 'eq', count: 0 }], then: [{ type: 'set_flag', name: flag, value: true }], once: true });
const huntFlagTrigger = (flag: string, eliteDef: string) => ({ id: 'elite_down', when: { event: 'npc_killed' }, if: [{ type: 'npcs_alive', defId: eliteDef, op: 'eq', count: 0 }], then: [{ type: 'set_flag', name: flag, value: true }], once: true });
const reachFlagTrigger = (flag: string) => ({ id: 'reach', when: { event: 'player_moved', in_area: eastObjectiveArea() }, then: [{ type: 'set_flag', name: flag, value: true }], once: true });
const freeCaptiveTrigger = (flag: string, captiveDef: string) => ({ id: 'free', when: { event: 'npc_killed' }, if: [{ type: 'enemies_alive', op: 'eq', count: 0 }], then: [{ type: 'set_disposition_by_def_id', defId: captiveDef, disposition: 'ally' }, { type: 'set_flag', name: flag, value: true }], once: true });

/** Actions that resolve the Bureau contract once the quest's last step completes
 *  — flips `mission_complete` so the hub turn-in flow + payout fire. */
const resolveContract = [
  { type: 'set_flag', name: 'mission_complete', value: true },
  { type: 'set_flag', name: 'mission_pending', value: false },
];

const stageFlag = (questId: string, k: number): string => `${questId}_s${k}`;

/** Assemble a QuestDef whose ordered steps each watch a stage flag. The last
 *  step resolves the contract. */
function buildQuestDef(
  questId: string, title: string,
  steps: Array<{ text: string; flag: string; xp: number; onComplete?: unknown[] }>,
): QuestDef {
  const stepDefs: QuestStepDef[] = steps.map((s, i) => ({
    id: `s${i}`,
    text: s.text,
    completeWhen: [{ type: 'flag_equals', name: s.flag, value: true }],
    xpReward: s.xp,
    ...(s.onComplete ? { onComplete: s.onComplete as QuestStepDef['onComplete'] } : {}),
  }));
  return {
    id: questId,
    title,
    description: `Generated Bureau contract: ${title}.`,
    scope: 'world',            // carries across the stage transitions
    runtime: true,             // engine-generated trusted runtime def
    steps: stepDefs,
    onComplete: resolveContract as QuestDef['onComplete'],
  };
}

function offerLine(reward: QuestGenReward): string {
  const gp = (reward.cpDelta / 100).toFixed(0);
  return `${gp} gp and ${reward.xp} XP on completion.`;
}

function baseQuest(
  type: GeneratedQuest['type'], flavourKey: string, title: string,
  questId: string, baseEncounterId: string,
  encounters: GeneratedQuestEncounter[], questDef: QuestDef, reward: QuestGenReward, objective: string, prose: string,
): GeneratedQuest {
  return {
    baseEncounterId, questId, type, title, flavour: flavourKey,
    questDef, encounters, reward,
    offer: { objective, rewardLine: offerLine(reward), prose },
  };
}

// ── Type: BOUNTY — clear the enemies ─────────────────────────────────────────
const bounty: QuestTypeModule = {
  id: 'bounty',
  weight: () => 3,
  generate(ctx) {
    const { questId, baseEncounterId } = newQuestIds();
    const fk = pickFlavour(ctx.rng); const fl = FLAVOURS[fk];
    const enemyIds = pickEnemies(ctx.monsters, fl.pool, questBudgetXp(ctx.playerLevel), ctx.rng, { min: 1, max: 5 });
    const reward = rewardForEnemies(ctx.monsters, enemyIds);
    const flag = stageFlag(questId, 0);
    const objective = `Defeat the ${fl.label} at ${fl.site}.`;
    const enc = buildQuestEncounter({
      ordinal: 0, encounterId: baseEncounterId, title: `Bounty — ${fl.site}`, biome: fl.biome,
      intro: `You reach ${fl.site}. ${enemyIds.length} ${fl.label} stand between you and the contract.`,
      context: `BOUNTY CONTRACT — clear all ${fl.label}. No parley.`,
      objective, enemyIds, triggers: [beginTrigger, introTrigger(`Open on ${fl.label} at ${fl.site}; the fight starts on the player's next move.`), clearFlagTrigger(flag)],
      tilesets: ctx.tilesets, rng: ctx.rng,
    });
    const def = buildQuestDef(questId, `Bounty: ${fl.label}`, [{ text: objective, flag, xp: reward.xp }]);
    return baseQuest('bounty', fk, def.title, questId, baseEncounterId, [enc], def, reward, objective, `${fl.label} have been reported at ${fl.site}. Clear them.`);
  },
};

// ── Type: HUNT — kill the named elite among minions ──────────────────────────
const hunt: QuestTypeModule = {
  id: 'hunt',
  weight: () => 2,
  generate(ctx) {
    const { questId, baseEncounterId } = newQuestIds();
    const eliteDef = 'guard'; // a turncoat leading the crew — distinct def so `npcs_alive` isolates it
    const minionIds = pickEnemies(ctx.monsters, ['bandit'], questBudgetXp(ctx.playerLevel), ctx.rng, { min: 1, max: 3 });
    const enemyIds = [eliteDef, ...minionIds];
    const reward = rewardForEnemies(ctx.monsters, enemyIds);
    const flag = stageFlag(questId, 0);
    const objective = 'Cut down the deserter sergeant leading the crew.';
    const enc = buildQuestEncounter({
      ordinal: 0, encounterId: baseEncounterId, title: 'Hunt — the Deserter', biome: 'grassland',
      intro: 'A turncoat Bureau sergeant has thrown in with road bandits. He stands at their centre, sword drawn.',
      context: 'HUNT CONTRACT — the named target is the deserter (a guard); the bandits are his crew. The contract resolves when the deserter is dead.',
      objective, enemyIds, triggers: [beginTrigger, introTrigger('Open on the deserter sergeant and his bandit crew.'), huntFlagTrigger(flag, eliteDef)],
      tilesets: ctx.tilesets, rng: ctx.rng,
    });
    const def = buildQuestDef(questId, 'Hunt: the Deserter', [{ text: objective, flag, xp: reward.xp }]);
    return baseQuest('hunt', 'bandit', def.title, questId, baseEncounterId, [enc], def, reward, objective, 'A deserter sergeant is leading a bandit crew on the roads. End him.');
  },
};

// ── Type: RESCUE — free the captive, clear the captors ───────────────────────
const rescue: QuestTypeModule = {
  id: 'rescue',
  weight: () => 2,
  generate(ctx) {
    const { questId, baseEncounterId } = newQuestIds();
    const fk = pickFlavour(ctx.rng); const fl = FLAVOURS[fk];
    const enemyIds = pickEnemies(ctx.monsters, fl.pool, questBudgetXp(ctx.playerLevel), ctx.rng, { min: 1, max: 4 });
    const captiveDef = 'commoner';
    const reward = rewardForEnemies(ctx.monsters, enemyIds);
    const flag = stageFlag(questId, 0);
    const objective = `Free the captive and clear the ${fl.label}.`;
    const enc = buildQuestEncounter({
      ordinal: 0, encounterId: baseEncounterId, title: `Rescue — ${fl.site}`, biome: fl.biome,
      intro: `A captive is bound at the centre of the ${fl.label}' camp at ${fl.site}.`,
      context: `RESCUE CONTRACT — a bound commoner (neutral) is held by ${fl.label}. Clearing the captors frees the captive (they become an ally). Resolves when the captors are down.`,
      objective, enemyIds, neutralIds: [captiveDef],
      triggers: [beginTrigger, introTrigger(`Open on a captive held by ${fl.label}.`), freeCaptiveTrigger(flag, captiveDef)],
      tilesets: ctx.tilesets, rng: ctx.rng,
    });
    const def = buildQuestDef(questId, `Rescue: ${fl.site}`, [{ text: objective, flag, xp: reward.xp }]);
    return baseQuest('rescue', fk, def.title, questId, baseEncounterId, [enc], def, reward, objective, `${fl.label} are holding a captive at ${fl.site}. Bring them home.`);
  },
};

// ── Type: RETRIEVE — fight to the cache and recover it ───────────────────────
const retrieve: QuestTypeModule = {
  id: 'retrieve',
  weight: () => 2,
  generate(ctx) {
    const { questId, baseEncounterId } = newQuestIds();
    const fk = pickFlavour(ctx.rng); const fl = FLAVOURS[fk];
    const enemyIds = pickEnemies(ctx.monsters, fl.pool, questBudgetXp(ctx.playerLevel), ctx.rng, { min: 1, max: 3 });
    const reward = rewardForEnemies(ctx.monsters, enemyIds);
    const flag = stageFlag(questId, 0);
    const objective = `Recover the cache from ${fl.site}.`;
    const enc = buildQuestEncounter({
      ordinal: 0, encounterId: baseEncounterId, title: `Retrieve — ${fl.site}`, biome: fl.biome,
      intro: `A Bureau cache lies at the far edge of ${fl.site}, watched by ${fl.label}. Reach it.`,
      context: `RETRIEVE CONTRACT — the cache is at the east edge; the contract step completes when the player reaches it (whether they fight through or slip past the ${fl.label}).`,
      objective, enemyIds, triggers: [beginTrigger, introTrigger(`Open on a guarded cache at the far side of ${fl.site}.`), reachFlagTrigger(flag)],
      tilesets: ctx.tilesets, rng: ctx.rng,
    });
    const def = buildQuestDef(questId, `Retrieve: ${fl.site}`, [{ text: objective, flag, xp: reward.xp }]);
    return baseQuest('retrieve', fk, def.title, questId, baseEncounterId, [enc], def, reward, objective, `A Bureau cache went missing at ${fl.site}. Recover it.`);
  },
};

// ── Type: INVESTIGATE — reach a site and study it (light/no combat) ──────────
const investigate: QuestTypeModule = {
  id: 'investigate',
  weight: () => 1,
  generate(ctx) {
    const { questId, baseEncounterId } = newQuestIds();
    const fk = pickFlavour(ctx.rng); const fl = FLAVOURS[fk];
    // Sparse presence — at most one lurker, scaled down.
    const enemyIds = ctx.rng() < 0.5 ? [] : pickEnemies(ctx.monsters, fl.pool, 1, ctx.rng, { min: 1, max: 1 });
    const reward = { cpDelta: 600, xp: 40 + enemyIds.reduce((n, id) => n + monsterXp(ctx.monsters, id), 0) };
    const flag = stageFlag(questId, 0);
    const objective = `Scout ${fl.site} and report what you find.`;
    const enc = buildQuestEncounter({
      ordinal: 0, encounterId: baseEncounterId, title: `Investigate — ${fl.site}`, biome: fl.biome,
      intro: `The Bureau wants eyes on ${fl.site}. Make your way to the far marker and read the ground.`,
      context: `INVESTIGATE CONTRACT — reach the far (east) marker at ${fl.site}; the step completes on arrival. Combat is optional.`,
      objective, enemyIds, triggers: [beginTrigger, introTrigger(`Open on a quiet approach to ${fl.site}.`), reachFlagTrigger(flag)],
      tilesets: ctx.tilesets, rng: ctx.rng,
    });
    const def = buildQuestDef(questId, `Investigate: ${fl.site}`, [{ text: objective, flag, xp: reward.xp }]);
    return baseQuest('investigate', fk, def.title, questId, baseEncounterId, [enc], def, reward, objective, `The Bureau needs ${fl.site} scouted. Go look.`);
  },
};

// ── Type: TWO_STAGE_STRIKE — scout, then assault (two encounters) ────────────
const twoStageStrike: QuestTypeModule = {
  id: 'two_stage_strike',
  weight: (ctx) => (ctx.playerLevel >= 2 ? 1 : 0), // gate the longer quest behind level 2
  generate(ctx) {
    const { questId, baseEncounterId } = newQuestIds();
    const fk = pickFlavour(ctx.rng); const fl = FLAVOURS[fk];
    const assaultEnemies = pickEnemies(ctx.monsters, fl.pool, questBudgetXp(ctx.playerLevel), ctx.rng, { min: 2, max: 5 });
    const reward = rewardForEnemies(ctx.monsters, assaultEnemies);
    const flag0 = stageFlag(questId, 0);
    const flag1 = stageFlag(questId, 1);
    const stage1Id = stageEncounterId(baseEncounterId, 1);
    const scout = buildQuestEncounter({
      ordinal: 0, encounterId: baseEncounterId, title: `Strike — Recon at ${fl.site}`, biome: fl.biome,
      intro: `First, get eyes on the ${fl.label} camp at ${fl.site}. Reach the overlook at the far edge.`,
      context: `TWO-STAGE STRIKE (recon) — reach the east overlook; on arrival the assault opens.`,
      objective: `Scout the ${fl.label} camp at ${fl.site}.`,
      enemyIds: ctx.rng() < 0.5 ? [] : pickEnemies(ctx.monsters, fl.pool, 1, ctx.rng, { min: 1, max: 1 }),
      triggers: [beginTrigger, introTrigger(`Open on a careful approach to the ${fl.label} camp.`), reachFlagTrigger(flag0)],
      tilesets: ctx.tilesets, rng: ctx.rng,
    });
    const assault = buildQuestEncounter({
      ordinal: 1, encounterId: stage1Id, title: `Strike — Assault at ${fl.site}`, biome: fl.biome,
      intro: `The overlook gave you the count. Now take the ${fl.label} camp.`,
      context: `TWO-STAGE STRIKE (assault) — clear all ${fl.label}.`,
      objective: `Take the ${fl.label} camp.`,
      enemyIds: assaultEnemies, triggers: [beginTrigger, introTrigger(`Open on the assault — ${fl.label} alerted and ready.`), clearFlagTrigger(flag1)],
      tilesets: ctx.tilesets, rng: ctx.rng,
    });
    const def = buildQuestDef(questId, `Strike: ${fl.site}`, [
      { text: `Scout the ${fl.label} camp at ${fl.site}.`, flag: flag0, xp: Math.round(reward.xp * 0.3), onComplete: [{ type: 'set_flag', name: 'mission_pending', value: stage1Id }] },
      { text: `Take the ${fl.label} camp.`, flag: flag1, xp: Math.round(reward.xp * 0.7) },
    ]);
    return baseQuest('two_stage_strike', fk, def.title, questId, baseEncounterId, [scout, assault], def, reward, `Scout the ${fl.label} camp at ${fl.site}.`, `A ${fl.label} camp at ${fl.site} needs scouting, then breaking.`);
  },
};

export const QUEST_TYPE_MODULES: QuestTypeModule[] = [bounty, hunt, rescue, retrieve, investigate, twoStageStrike];
