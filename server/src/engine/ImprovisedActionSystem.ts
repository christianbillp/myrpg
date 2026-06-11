/**
 * ImprovisedActionSystem — first-class resolution for free-text player
 * attempts that no button or dedicated tool covers ("I kick the brazier
 * onto the cultist", "I wedge the door shut with my dagger").
 *
 * The AIGM supplies a skill and a difficulty BAND; the engine owns
 * everything that keeps the adjudication fair: the band → DC mapping (the
 * SRD typical-DC table), the Action cost during combat (same as Study /
 * Magic — paid before the roll, so a failed stunt is still a spent turn),
 * the roll itself (routed through `rollAbilityCheck`, so conditions,
 * exhaustion, Influence attitude, and Guidance all apply), and the uniform
 * Event Log line.
 */
import type { GameContext } from './GameContext.js';
import { canSpendAction } from './ActionGuards.js';
import { Logger } from '../Logger.js';

export const DIFFICULTY_BAND_DC = {
  very_easy: 5,
  easy: 10,
  medium: 15,
  hard: 20,
  very_hard: 25,
  nearly_impossible: 30,
} as const;

export type DifficultyBand = keyof typeof DIFFICULTY_BAND_DC;

/** Rulings surfaced to the AIGM as RECENT RULINGS — enough for band
 *  consistency across retries without bloating the state message. */
const MAX_RECORDED_RULINGS = 10;

export interface ImprovisedActionInput {
  description: string;
  skill: string;
  difficulty: DifficultyBand;
  targetNpcEntity?: string;
}

export type ImprovisedActionResult =
  | { performed: false; refusal: string }
  | {
      performed: true;
      dc: number;
      roll: number;
      total: number;
      success: boolean;
      attitudeNote: string;
      actionSpent: boolean;
    };

type AbilityCheckRoll = (
  skill: string,
  dc: number,
  targetNpcEntity?: string,
) => { roll: number; total: number; success: boolean; attitudeNote: string };

export function resolveImprovisedAction(
  ctx: GameContext,
  input: ImprovisedActionInput,
  rollAbilityCheck: AbilityCheckRoll,
): ImprovisedActionResult {
  const s = ctx.state;
  const dc = DIFFICULTY_BAND_DC[input.difficulty];

  let actionSpent = false;
  if (s.phase === 'player_turn') {
    if (!canSpendAction(ctx)) {
      return {
        performed: false,
        refusal: 'Not performed: the player cannot spend an Action right now (already used this turn, or incapacitated). Refuse in-fiction without naming the resource or the rule; the attempt is open again next turn.',
      };
    }
    s.player.actionUsed = true;
    actionSpent = true;
  }

  const { roll, total, success, attitudeNote } = rollAbilityCheck(input.skill, dc, input.targetNpcEntity);
  ctx.addLog(`Improvised (${input.skill})${attitudeNote ? ` ${attitudeNote}` : ''}: "${input.description}" — d20+mod = ${total} vs DC ${dc} — ${success ? 'Success!' : 'Failure'}`);
  s.improvisedRulings.push({ description: input.description, skill: input.skill, difficulty: input.difficulty, dc, success });
  if (s.improvisedRulings.length > MAX_RECORDED_RULINGS) {
    s.improvisedRulings.splice(0, s.improvisedRulings.length - MAX_RECORDED_RULINGS);
  }
  Logger.log('check.improvised_action', {
    description: input.description,
    skill: input.skill,
    difficulty: input.difficulty,
    dc,
    targetNpcEntity: input.targetNpcEntity ?? null,
    actionSpent,
    roll,
    total,
    success,
  });
  return { performed: true, dc, roll, total, success, attitudeNote, actionSpent };
}
